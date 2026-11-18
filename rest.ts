// GitHub REST v3 surface for the forge. No dependencies beyond node stdlib and the shared store.
// Every reply under /api/v3 is JSON, carries a request id (http.ts), and is deterministic:
// all timestamps are the store's EPOCH and every id/sha is derived from a seeded counter.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson, sendRaw, readJson, authorized, queryOf } from './http.ts';
import {
  state,
  findRepo,
  jsonRepo,
  nextSha,
  shaOf,
  EPOCH,
  type Repo,
  type Content,
} from './store.ts';

const API = '/api/v3';
const JSON_TYPE = 'application/json; charset=utf-8';

// ----------------------------------------------------------------------------- local types

interface CommitMeta {
  sha: string;
  message: string;
  author: { name: string; email: string };
  date: string;
}

interface PrMeta {
  baseTree: Map<string, Content>;
  headTree: Map<string, Content>;
  files: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }>;
}

interface RestExtras {
  branchTrees: Map<string, Map<string, Content>>;
  branchCommits: Map<string, string[]>;
  treesBySha: Map<string, Map<string, Content>>;
  commitMeta: Map<string, CommitMeta>;
  prMeta: Map<number, PrMeta>;
  comments: Map<number, Array<{ id: number; body: string; user: { login: string }; created_at: string }>>;
}

/** REST-only bookkeeping, attached lazily to each repo object. */
function extras(repo: Repo): RestExtras {
  const held = (repo as unknown as { __rest?: RestExtras }).__rest;
  if (held !== undefined) return held;
  const fresh: RestExtras = {
    branchTrees: new Map<string, Map<string, Content>>(),
    branchCommits: new Map<string, string[]>(),
    treesBySha: new Map<string, Map<string, Content>>(),
    commitMeta: new Map<string, CommitMeta>(),
    prMeta: new Map<number, PrMeta>(),
    comments: new Map<number, Array<{ id: number; body: string; user: { login: string }; created_at: string }>>(),
  };
  fresh.branchTrees.set(repo.default_branch, repo.contents);
  (repo as unknown as { __rest?: RestExtras }).__rest = fresh;
  return fresh;
}

function cloneTree(tree: Map<string, Content>): Map<string, Content> {
  const out = new Map<string, Content>();
  for (const [key, value] of tree) out.set(key, { ...value });
  return out;
}

function treeOf(repo: Repo, ref?: string): Map<string, Content> {
  const ex = extras(repo);
  if (ref === undefined || ref === '') return ex.branchTrees.get(repo.default_branch) ?? repo.contents;
  const byBranch = ex.branchTrees.get(ref);
  if (byBranch !== undefined) return byBranch;
  const bySha = ex.treesBySha.get(ref);
  if (bySha !== undefined) return bySha;
  // A raw sha with no recorded tree (e.g. a seeded commit): fall back to the default tree.
  return repo.contents;
}

function tipOf(repo: Repo, branch: string): string {
  return repo.branches.get(branch) ?? '';
}

function commit(repo: Repo, branch: string, tree: Map<string, Content>, message: string): CommitMeta {
  const ex = extras(repo);
  const meta: CommitMeta = {
    sha: nextSha(`commit:${repo.full_name}:${branch}:${message}`),
    message,
    author: { name: state.viewer, email: `${state.viewer}@example.invalid` },
    date: EPOCH,
  };
  ex.commitMeta.set(meta.sha, meta);
  ex.treesBySha.set(meta.sha, cloneTree(tree));
  const list = ex.branchCommits.get(branch) ?? [];
  list.push(meta.sha);
  ex.branchCommits.set(branch, list);
  repo.branches.set(branch, meta.sha);
  repo.refs.set(branch, meta.sha);
  if (branch === repo.default_branch) repo.commits.push({ ...meta });
  return meta;
}

function commitsOf(repo: Repo, branch: string): CommitMeta[] {
  const ex = extras(repo);
  const shas = ex.branchCommits.get(branch);
  if (shas !== undefined) {
    const out: CommitMeta[] = [];
    for (const sha of shas) {
      const meta = ex.commitMeta.get(sha);
      if (meta !== undefined) out.push(meta);
    }
    return out;
  }
  return branch === repo.default_branch ? (repo.commits as unknown as CommitMeta[]) : [];
}

function changedPaths(base: Map<string, Content>, other: Map<string, Content>): Set<string> {
  const out = new Set<string>();
  for (const [path, value] of other) {
    const before = base.get(path);
    if (before === undefined || before.sha !== value.sha) out.add(path);
  }
  for (const path of base.keys()) if (!other.has(path)) out.add(path);
  return out;
}

// ----------------------------------------------------------------------------- responses

function ok(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  sendJson(res, status, body, headers);
}

function message(res: ServerResponse, status: number, text: string): void {
  sendJson(res, status, { message: text });
}

function unauthorized(res: ServerResponse): void {
  message(res, 401, 'Requires authentication');
}

function notFound(res: ServerResponse, what = 'Not Found'): void {
  message(res, 404, what);
}

/** Malformed JSON bodies are always 400 with a JSON {message} body. */
function badBody(res: ServerResponse, err: unknown): void {
  message(res, 400, `Invalid JSON body: ${err instanceof Error ? err.message : String(err)}`);
}

// ----------------------------------------------------------------------------- serialisers

function fileJson(path: string, content: Content): Record<string, unknown> {
  return {
    type: 'file',
    name: path.slice(path.lastIndexOf('/') + 1),
    path,
    sha: content.sha,
    encoding: 'base64',
    content: content.content,
    size: content.size,
    url: `${API}/repos/${path}`,
  };
}

function directoryJson(repo: Repo, dir: string, ref?: string): Array<Record<string, unknown>> {
  const tree = treeOf(repo, ref);
  const prefix = `${dir}/`;
  const entries = new Map<string, Record<string, unknown>>();
  for (const [path, content] of tree) {
    if (!path.startsWith(prefix)) continue;
    const tail = path.slice(prefix.length);
    if (tail === '') continue;
    const slash = tail.indexOf('/');
    if (slash === -1) {
      entries.set(tail, {
        type: 'file',
        name: tail,
        path,
        sha: content.sha,
        size: content.size,
      });
    } else {
      const name = tail.slice(0, slash);
      const childPath = `${prefix}${name}`;
      if (!entries.has(`${name}/`)) {
        entries.set(`${name}/`, {
          type: 'dir',
          name,
          path: childPath,
          sha: shaOf(`${repo.full_name}:${childPath}`),
        });
      }
    }
  }
  return [...entries.values()];
}

function issueJson(issue: any): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels,
    user: issue.user,
    comments: issue.comments,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    html_url: `https://github.com/${issue.repoFullName ?? 'repo'}/issues/${issue.number}`,
  };
}

function pullJson(pull: any): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    merged: pull.merged,
    merge_commit_sha: pull.merge_commit_sha,
    merged_at: pull.merged_at,
    head: pull.head,
    base: pull.base,
    user: pull.user,
    created_at: pull.created_at,
    updated_at: pull.updated_at,
  };
}

function branchJson(repo: Repo): Array<Record<string, unknown>> {
  return [...repo.branches.entries()].map(([name, sha]) => ({
    name,
    commit: { sha, url: `${API}/repos/${repo.full_name}/commits/${sha}` },
  }));
}

function commitJson(repo: Repo, meta: CommitMeta): Record<string, unknown> {
  return {
    sha: meta.sha,
    commit: {
      message: meta.message,
      author: { name: meta.author.name, email: meta.author.email, date: meta.date },
      committer: { name: meta.author.name, email: meta.author.email, date: meta.date },
    },
    author: { login: meta.author.name },
    url: `${API}/repos/${repo.full_name}/commits/${meta.sha}`,
  };
}

// ----------------------------------------------------------------------------- request helpers

function hostOf(req: IncomingMessage): string {
  const raw = req.headers.host;
  if (typeof raw === 'string' && raw !== '') return raw;
  return 'localhost';
}

function segmentsOf(path: string): string[] {
  const rest = path === API || path === `${API}/` ? '' : path.slice(API.length);
  return rest.split('/').filter((part) => part !== '').map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
}

/** Only the token's own login is visible; a foreign owner is 404, never 403. */
function ownedRepo(owner: string, name: string): Repo | undefined {
  if (owner !== state.viewer) return undefined;
  return findRepo(owner, name);
}

function intParam(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') out.push(item);
    else if (item !== null && typeof item === 'object' && typeof (item as any).name === 'string') out.push((item as any).name);
  }
  return out;
}

async function bodyOf(req: IncomingMessage, res: ServerResponse): Promise<Record<string, any> | null> {
  try {
    const body = await readJson(req);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      message(res, 400, 'The JSON body must be an object');
      return null;
    }
    return body as Record<string, any>;
  } catch (err) {
    badBody(res, err);
    return null;
  }
}

// ----------------------------------------------------------------------------- route handlers

async function handleUser(
  req: IncomingMessage,
  res: ServerResponse,
  seg: string[],
  method: string,
): Promise<boolean> {
  const query = queryOf(req);
  if (seg.length === 1 && method === 'GET') {
    ok(res, 200, { login: state.viewer, id: 1000, type: 'User', name: state.viewer });
    return true;
  }
  if (seg.length === 2 && seg[1] === 'repos') {
    if (method === 'GET') {
      const perPage = intParam(query.get('per_page'), 30, 1, 100);
      const page = intParam(query.get('page'), 1, 1, 1_000_000);
      const all = state.repos.filter((repo) => repo.owner.login === state.viewer);
      const start = (page - 1) * perPage;
      const slice = all.slice(start, start + perPage).map((repo) => jsonRepo(repo));
      const headers: Record<string, string> = {};
      if (start + perPage < all.length) {
        const origin = `http://${hostOf(req)}`;
        const base = `${origin}${API}/user/repos?per_page=${perPage}`;
        const lastPage = Math.max(1, Math.ceil(all.length / perPage));
        headers.link = `<${base}&page=${page + 1}>; rel="next", <${base}&page=${lastPage}>; rel="last"`;
      }
      ok(res, 200, slice, headers);
      return true;
    }
    if (method === 'POST') {
      const body = await bodyOf(req, res);
      if (body === null) return true;
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (name === '') {
        message(res, 422, 'A repository name is required');
        return true;
      }
      if (findRepo(state.viewer, name) !== undefined) {
        message(res, 422, 'Repository already exists');
        return true;
      }
      const id = Math.max(10_000, ...state.repos.map((repo) => repo.id)) + 1;
      const fullName = `${state.viewer}/${name}`;
      const contents = new Map<string, Content>();
      const branches = new Map<string, string>([[ 'main', shaOf(`${fullName}:main:init`) ]]);
      const repo: Repo = {
        id,
        databaseId: id,
        name,
        full_name: fullName,
        owner: { login: state.viewer, id: 1000, type: 'User' },
        description: typeof body.description === 'string' ? body.description : '',
        private: body.private === true,
        default_branch: 'main',
        created_at: EPOCH,
        updated_at: EPOCH,
        branches,
        contents,
        commits: [],
        labels: [],
        issues: [],
        pulls: [],
        refs: new Map(branches),
        objects: new Map(),
      };
      state.repos.push(repo);
      extras(repo);
      ok(res, 201, jsonRepo(repo));
      return true;
    }
  }
  return false;
}

async function handleContents(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  rest: string[],
  method: string,
): Promise<boolean> {
  const filePath = rest.slice(1).join('/');
  if (filePath === '') return false;
  const query = queryOf(req);
  const ref = query.get('ref') ?? undefined;
  const tree = treeOf(repo, ref);

  if (method === 'GET') {
    const direct = tree.get(filePath);
    if (direct !== undefined) {
      ok(res, 200, fileJson(filePath, direct));
      return true;
    }
    const dir = directoryJson(repo, filePath, ref);
    if (dir.length > 0) {
      ok(res, 200, dir);
      return true;
    }
    notFound(res, 'Not Found');
    return true;
  }

  if (method === 'PUT') {
    const body = await bodyOf(req, res);
    if (body === null) return true;
    if (typeof body.content !== 'string') {
      message(res, 422, 'content must be a base64 string');
      return true;
    }
    const targetBranch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.default_branch;
    const targetTree = treeOf(repo, targetBranch);
    const current = targetTree.get(filePath);
    if (typeof body.sha === 'string' && body.sha !== '') {
      if (current === undefined || current.sha !== body.sha) {
        message(res, 409, 'sha does not match the current file');
        return true;
      }
    } else if (current !== undefined) {
      message(res, 409, 'sha is required to update an existing file');
      return true;
    }
    const decoded = Buffer.from(body.content.replace(/[\r\n\t ]+/g, ''), 'base64');
    const contentSha = nextSha(`content:${repo.full_name}:${targetBranch}:${filePath}:${body.content}`);
    const content: Content = {
      path: filePath,
      sha: contentSha,
      content: decoded.toString('base64'),
      encoding: 'base64',
      size: decoded.length,
    };
    targetTree.set(filePath, content);
    if (targetBranch === repo.default_branch) repo.contents = targetTree;
    const meta = commit(repo, targetBranch, targetTree, typeof body.message === 'string' ? body.message : `Update ${filePath}`);
    ok(res, current === undefined ? 201 : 200, {
      content: {
        name: filePath.slice(filePath.lastIndexOf('/') + 1),
        path: filePath,
        sha: content.sha,
        encoding: 'base64',
        size: content.size,
      },
      commit: { sha: meta.sha },
    });
    return true;
  }

  if (method === 'DELETE') {
    const body = await bodyOf(req, res);
    if (body === null) return true;
    const targetBranch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.default_branch;
    const targetTree = treeOf(repo, targetBranch);
    const current = targetTree.get(filePath);
    if (current === undefined) {
      notFound(res, 'Not Found');
      return true;
    }
    if (typeof body.sha === 'string' && body.sha !== '' && body.sha !== current.sha) {
      message(res, 409, 'sha does not match the current file');
      return true;
    }
    targetTree.delete(filePath);
    if (targetBranch === repo.default_branch) repo.contents = targetTree;
    const meta = commit(repo, targetBranch, targetTree, typeof body.message === 'string' ? body.message : `Delete ${filePath}`);
    ok(res, 200, { commit: { sha: meta.sha } });
    return true;
  }

  return false;
}

async function handleIssues(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  rest: string[],
  method: string,
): Promise<boolean> {
  const query = queryOf(req);
  const ex = extras(repo);

  // Collection: GET list, POST create.
  if (rest.length === 1) {
    if (method === 'POST') {
      const body = await bodyOf(req, res);
      if (body === null) return true;
      const wanted = stringArray(body.labels);
      const known = new Set(repo.labels.map((label) => label.name));
      for (const name of wanted) {
        if (!known.has(name)) {
          message(res, 422, `Label ${JSON.stringify(name)} does not exist`);
          return true;
        }
      }
      const number = state.counters.issue++;
      const issue = {
        id: number,
        number,
        title: typeof body.title === 'string' ? body.title : '',
        body: typeof body.body === 'string' ? body.body : '',
        state: 'open',
        labels: wanted.map((name) => ({ name })),
        user: { login: state.viewer, id: 1000, type: 'User' },
        created_at: EPOCH,
        updated_at: EPOCH,
        comments: 0,
        repoFullName: repo.full_name,
      };
      repo.issues.push(issue);
      ex.comments.set(number, []);
      ok(res, 201, issueJson(issue));
      return true;
    }
    if (method === 'GET') {
      const stateFilter = query.get('state') ?? 'all';
      let list = repo.issues.slice();
      if (stateFilter === 'open' || stateFilter === 'closed') {
        list = list.filter((issue) => issue.state === stateFilter);
      }
      const direction = (query.get('direction') ?? 'desc').toLowerCase();
      const sort = (query.get('sort') ?? 'created').toLowerCase();
      if (sort === 'created' || sort === 'updated' || direction === 'asc' || direction === 'desc') {
        list.sort((a, b) => {
          const av = sort === 'updated' ? a.updated_at : a.number;
          const bv = sort === 'updated' ? b.updated_at : b.number;
          if (av < bv) return direction === 'asc' ? -1 : 1;
          if (av > bv) return direction === 'asc' ? 1 : -1;
          return 0;
        });
      }
      const perPage = intParam(query.get('per_page'), 100, 1, 100);
      const page = intParam(query.get('page'), 1, 1, 1_000_000);
      list = list.slice((page - 1) * perPage, page * perPage);
      ok(res, 200, list.map((issue) => issueJson(issue)));
      return true;
    }
    return false;
  }

  const number = Number.parseInt(rest[1] ?? '', 10);
  const issue = repo.issues.find((entry) => entry.number === number);
  if (issue === undefined) {
    notFound(res, 'Issue Not Found');
    return true;
  }

  // Comments collection.
  if (rest.length === 3 && rest[2] === 'comments') {
    if (method === 'GET') {
      ok(res, 200, ex.comments.get(number) ?? []);
      return true;
    }
    if (method === 'POST') {
      const body = await bodyOf(req, res);
      if (body === null) return true;
      const comment = {
        id: state.counters.comment++,
        body: typeof body.body === 'string' ? body.body : '',
        user: { login: state.viewer },
        created_at: EPOCH,
      };
      const list = ex.comments.get(number) ?? [];
      list.push(comment);
      ex.comments.set(number, list);
      issue.comments = list.length;
      issue.updated_at = EPOCH;
      ok(res, 201, comment);
      return true;
    }
    return false;
  }

  // A single issue.
  if (rest.length === 2) {
    if (method === 'GET') {
      ok(res, 200, issueJson(issue));
      return true;
    }
    if (method === 'PATCH') {
      const body = await bodyOf(req, res);
      if (body === null) return true;
      if (body.title !== undefined && typeof body.title === 'string') issue.title = body.title;
      if (body.body !== undefined && typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (Array.isArray(body.labels)) {
        const wanted = stringArray(body.labels);
        const known = new Set(repo.labels.map((label) => label.name));
        for (const name of wanted) {
          if (!known.has(name)) {
            message(res, 422, `Label ${JSON.stringify(name)} does not exist`);
            return true;
          }
        }
        issue.labels = wanted.map((name) => ({ name }));
      }
      issue.updated_at = EPOCH;
      ok(res, 200, issueJson(issue));
      return true;
    }
  }
  return false;
}

async function handlePulls(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  rest: string[],
  method: string,
): Promise<boolean> {
  const query = queryOf(req);
  const ex = extras(repo);

  if (rest.length === 1) {
    if (method === 'POST') {
      const body = await bodyOf(req, res);
      if (body === null) return true;
      const head = typeof body.head === 'string' ? body.head : '';
      const base = typeof body.base === 'string' && body.base !== '' ? body.base : repo.default_branch;
      const headSha = tipOf(repo, head);
      const baseSha = tipOf(repo, base);
      if (headSha === '' || baseSha === '') {
        message(res, 422, 'The head or base branch does not exist');
        return true;
      }
      const headTree = cloneTree(treeOf(repo, head));
      const baseTree = cloneTree(treeOf(repo, base));
      const paths = changedPaths(baseTree, headTree);
      const files: PrMeta['files'] = [];
      for (const path of [...paths].sort()) {
        const before = baseTree.get(path);
        const after = headTree.get(path);
        const status = before === undefined ? 'added' : after === undefined ? 'removed' : 'modified';
        const additions = after === undefined ? 0 : 1;
        const deletions = before === undefined ? 0 : 1;
        files.push({ filename: path, status, additions, deletions, changes: additions + deletions });
      }
      const number = state.counters.pull++;
      const pull = {
        id: number,
        number,
        title: typeof body.title === 'string' ? body.title : '',
        body: typeof body.body === 'string' ? body.body : '',
        state: 'open',
        merged: false,
        merge_commit_sha: null as string | null,
        merged_at: null as string | null,
        head: { ref: head, sha: headSha },
        base: { ref: base, sha: baseSha },
        user: { login: state.viewer, id: 1000, type: 'User' },
        created_at: EPOCH,
        updated_at: EPOCH,
      };
      repo.pulls.push(pull);
      ex.prMeta.set(number, { baseTree, headTree, files });
      ok(res, 201, pullJson(pull));
      return true;
    }
    if (method === 'GET') {
      const stateFilter = query.get('state') ?? 'open';
      let list = repo.pulls.slice();
      if (stateFilter === 'open' || stateFilter === 'closed') {
        list = list.filter((pull) => pull.state === stateFilter);
      }
      const perPage = intParam(query.get('per_page'), 100, 1, 100);
      const page = intParam(query.get('page'), 1, 1, 1_000_000);
      list = list.slice((page - 1) * perPage, page * perPage);
      ok(res, 200, list.map((pull) => pullJson(pull)));
      return true;
    }
    return false;
  }

  const number = Number.parseInt(rest[1] ?? '', 10);
  const pull = repo.pulls.find((entry) => entry.number === number);
  if (pull === undefined) {
    notFound(res, 'Pull Request Not Found');
    return true;
  }
  const meta = ex.prMeta.get(number);

  if (rest.length === 2 && method === 'GET') {
    ok(res, 200, pullJson(pull));
    return true;
  }

  if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
    ok(res, 200, meta === undefined ? [] : meta.files);
    return true;
  }

  if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
    if (pull.state !== 'open' || meta === undefined) {
      message(res, 405, 'Pull Request is not mergeable');
      return true;
    }
    const target = pull.base.ref;
    const currentTip = tipOf(repo, target);
    const defaultTree = treeOf(repo, target);
    const defaultChanges = changedPaths(meta.baseTree, defaultTree);
    const headChanges = changedPaths(meta.baseTree, meta.headTree);
    let conflict = false;
    for (const path of headChanges) {
      if (defaultChanges.has(path) && defaultTree.get(path)?.sha !== meta.headTree.get(path)?.sha) {
        conflict = true;
        break;
      }
    }
    if (conflict || (currentTip !== '' && currentTip !== pull.base.sha && defaultChanges.size > 0 && headChanges.size > 0)) {
      message(res, 405, 'Pull Request has conflicts');
      return true;
    }
    // Squash: apply the head's changes onto the current target tree.
    for (const path of headChanges) {
      const value = meta.headTree.get(path);
      if (value === undefined) defaultTree.delete(path);
      else defaultTree.set(path, { ...value });
    }
    if (target === repo.default_branch) repo.contents = defaultTree;
    const mergeMeta = commit(repo, target, defaultTree, `Squash and merge pull request #${number}: ${pull.title}`);
    pull.state = 'closed';
    pull.merged = true;
    pull.merge_commit_sha = mergeMeta.sha;
    pull.merged_at = EPOCH;
    pull.updated_at = EPOCH;
    ok(res, 200, { sha: mergeMeta.sha, merged: true, message: 'Squashed and merged' });
    return true;
  }

  return false;
}

async function handleRepo(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  rest: string[],
  method: string,
): Promise<boolean> {
  if (rest.length === 0) {
    if (method === 'GET') {
      ok(res, 200, jsonRepo(repo));
      return true;
    }
    if (method === 'PATCH') {
      const body = await bodyOf(req, res);
      if (body === null) return true;
      if (typeof body.description === 'string') repo.description = body.description;
      if (body.private !== undefined) repo.private = body.private === true;
      repo.updated_at = EPOCH;
      ok(res, 200, jsonRepo(repo));
      return true;
    }
    if (method === 'DELETE') {
      const index = state.repos.indexOf(repo);
      if (index >= 0) state.repos.splice(index, 1);
      sendRaw(res, 204, '', JSON_TYPE);
      return true;
    }
    return false;
  }

  const head = rest[0];
  if (head === 'contents') {
    return handleContents(req, res, repo, rest, method);
  }

  if (head === 'branches' && rest.length === 1 && method === 'GET') {
    ok(res, 200, branchJson(repo));
    return true;
  }

  if (head === 'commits' && rest.length === 1 && method === 'GET') {
    const ref = queryOf(req).get('sha') ?? undefined;
    const branch = ref !== undefined && (extras(repo).branchTrees.has(ref) || tipOf(repo, ref) !== '') ? ref : repo.default_branch;
    ok(res, 200, commitsOf(repo, branch).map((meta) => commitJson(repo, meta)));
    return true;
  }

  if (head === 'git' && rest[1] === 'refs' && rest.length === 2 && method === 'POST') {
    const body = await bodyOf(req, res);
    if (body === null) return true;
    const ref = typeof body.ref === 'string' ? body.ref : '';
    const sha = typeof body.sha === 'string' ? body.sha : '';
    const name = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    if (name === '' || sha === '') {
      message(res, 422, 'ref and sha are required');
      return true;
    }
    const ex = extras(repo);
    const source = [...ex.branchTrees.entries()].find(([, value]) => value === repo.contents);
    const baseTree = ex.treesBySha.get(sha);
    ex.branchTrees.set(name, cloneTree(baseTree ?? repo.contents));
    ex.branchCommits.set(name, [...(ex.branchCommits.get(source?.[0] ?? repo.default_branch) ?? [])]);
    repo.branches.set(name, sha);
    repo.refs.set(name, sha);
    ok(res, 201, { ref: `refs/heads/${name}`, object: { sha, type: 'commit' } });
    return true;
  }

  if (head === 'labels') {
    if (rest.length === 1) {
      if (method === 'GET') {
        ok(res, 200, repo.labels);
        return true;
      }
      if (method === 'POST') {
        const body = await bodyOf(req, res);
        if (body === null) return true;
        const label = {
          id: state.counters.label++,
          name: typeof body.name === 'string' ? body.name : '',
          color: typeof body.color === 'string' ? body.color : 'ededed',
          description: typeof body.description === 'string' ? body.description : '',
        };
        repo.labels.push(label);
        ok(res, 201, { id: label.id, name: label.name, color: label.color, description: label.description });
        return true;
      }
    }
  }

  if (head === 'issues') {
    return handleIssues(req, res, repo, rest, method);
  }

  if (head === 'pulls') {
    return handlePulls(req, res, repo, rest, method);
  }

  return false;
}

// ----------------------------------------------------------------------------- entry point

export async function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
): Promise<boolean> {
  if (path !== API && !path.startsWith(`${API}/`)) return false;

  if (!authorized(req)) {
    unauthorized(res);
    return true;
  }

  const seg = segmentsOf(path);

  if (seg.length === 0) {
    if (method === 'GET') {
      const origin = `http://${hostOf(req)}`;
      ok(res, 200, {
        message: 'GitHub API root',
        current_user_url: `${origin}${API}/user`,
        repository_url: `${origin}${API}/repos/{owner}/{repo}`,
        authorization_url: `${origin}${API}/authorizations`,
      }, { 'x-oauth-scopes': state.githubScope });
      return true;
    }
    notFound(res);
    return true;
  }

  if (seg[0] === 'meta' && seg.length === 1 && method === 'GET') {
    ok(res, 200, { installed_version: 'github-core-clone-01', sha: shaOf('meta') });
    return true;
  }

  if (seg[0] === 'user') {
    const handled = await handleUser(req, res, seg, method);
    if (handled) return true;
    notFound(res);
    return true;
  }

  if (seg[0] === 'repos' && seg.length >= 3) {
    const repo = ownedRepo(seg[1] ?? '', seg[2] ?? '');
    if (repo === undefined) {
      notFound(res, 'Not Found');
      return true;
    }
    const handled = await handleRepo(req, res, repo, seg.slice(3), method);
    if (handled) return true;
    notFound(res);
    return true;
  }

  notFound(res);
  return true;
}
