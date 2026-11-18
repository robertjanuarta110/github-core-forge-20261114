// GitHub GraphQL v4 surface for the forge. No GraphQL dependency: a small document parser and
// executor cover the shapes gh / github-mcp-server send, backed by the shared in-memory store.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { authorized, readBody, sendJson } from './http.ts';
import { state, findRepo, jsonRepo, shaOf, EPOCH } from './store.ts';
import type { Repo } from './store.ts';
import { buildScenario } from './scenario.ts';

// -------------------------------------------------------------------------------------------------
// Shared record helpers (also imported by mcp.ts so both surfaces mutate the same store shape).
// -------------------------------------------------------------------------------------------------

export function globalRepoId(repo: Repo): string {
  return `R_${repo.id}`;
}
export function globalIssueId(repo: Repo, number: number): string {
  return `I_${repo.id}_${number}`;
}
export function globalPullId(repo: Repo, number: number): string {
  return `PR_${repo.id}_${number}`;
}

export function repoById(id: string): Repo | undefined {
  if (typeof id !== 'string' || !id.startsWith('R_')) return undefined;
  const n = Number(id.slice(2));
  if (!Number.isFinite(n)) return undefined;
  return state.repos.find((r) => r.id === n);
}

export function parseIssueId(id: string): { repo: Repo; number: number } | undefined {
  const m = /^I_(\d+)_(\d+)$/.exec(String(id));
  if (m === null) return undefined;
  const repo = state.repos.find((r) => r.id === Number(m[1]));
  return repo === undefined ? undefined : { repo, number: Number(m[2]) };
}

export function parsePullId(id: string): { repo: Repo; number: number } | undefined {
  const m = /^PR_(\d+)_(\d+)$/.exec(String(id));
  if (m === null) return undefined;
  const repo = state.repos.find((r) => r.id === Number(m[1]));
  return repo === undefined ? undefined : { repo, number: Number(m[2]) };
}

export function nextRepoId(): number {
  return Math.max(10_000, ...state.repos.map((r) => r.id)) + 1;
}

export function makeNewRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
  const id = nextRepoId();
  const full_name = `${owner}/${name}`;
  const branches = new Map<string, string>([['main', shaOf(full_name + 'main')]]);
  return {
    id, databaseId: id, name, full_name,
    owner: { login: owner, id: owner === state.viewer ? 1000 : 1002, type: 'User' },
    description, private: isPrivate, default_branch: 'main', created_at: EPOCH, updated_at: EPOCH,
    branches, contents: new Map(), commits: [], labels: [], issues: [], pulls: [],
    refs: new Map(branches), objects: new Map(),
  };
}

export function createIssueRecord(repo: Repo, title: string, body: string, user?: string): any {
  const number = state.counters.issue++;
  const issue = {
    id: number, number, title, body: body ?? '', state: 'open',
    labels: [], user: { login: user ?? state.viewer },
    created_at: EPOCH, updated_at: EPOCH, comments: 0,
    repoFullName: repo.full_name,
  };
  repo.issues.push(issue);
  return issue;
}

export function createPullRecord(repo: Repo, head: string, base: string, title: string, body?: string, user?: string): any {
  const number = state.counters.pull++;
  const pull = {
    id: number, number, title: title ?? '', body: body ?? '', state: 'open', merged: false,
    head: { ref: head, sha: shaOf(`${repo.full_name}:${head}`) },
    base: { ref: base, sha: shaOf(`${repo.full_name}:${base}`) },
    user: { login: user ?? state.viewer, id: user === state.viewer ? 1000 : 1002, type: 'User' },
    merge_commit_sha: null, merged_at: null,
    created_at: EPOCH, updated_at: EPOCH,
  };
  repo.pulls.push(pull);
  return pull;
}

export function mergePullRecord(repo: Repo, number: number): any {
  const pull = repo.pulls.find((p) => p.number === number);
  if (pull === undefined) return undefined;
  pull.merged = true;
  pull.state = 'closed';
  pull.merged_at = EPOCH;
  return pull;
}

/** Store a comment in every plausible shared-store slot so any REST reader can see it. */
export function storeComment(repo: Repo, issue: any, body: string, user?: string): any {
  const comment = {
    id: state.counters.comment++, body, user: { login: user ?? state.viewer },
    created_at: EPOCH, updated_at: EPOCH,
  };
  // rest.ts keeps the canonical comment list on repo.__rest.comments, keyed by issue number.
  const extras = (repo as any).__rest;
  if (extras !== undefined && extras.comments instanceof Map) {
    const list = extras.comments.get(issue.number) ?? [];
    list.push({ id: comment.id, body, user: comment.user, created_at: EPOCH });
    extras.comments.set(issue.number, list);
    issue.comments = list.length;
  }
  if (Array.isArray((issue as any).commentList)) (issue as any).commentList.push(comment);
  else (issue as any).commentList = [comment];
  if (Array.isArray((issue as any).comments_list)) (issue as any).comments_list.push(comment);
  else (issue as any).comments_list = [comment];
  if (Array.isArray(issue.comments)) issue.comments.push(comment);
  else if (typeof issue.comments === 'number') issue.comments += 1;
  const shared = state as any;
  const record = { ...comment, issue_id: issue.id, issueId: issue.id, number: issue.number };
  if (Array.isArray(shared.comments)) shared.comments.push(record);
  else if (shared.comments instanceof Map) shared.comments.set(`${issue.id}:${comment.id}`, record);
  else if (shared.comments !== null && typeof shared.comments === 'object') shared.comments[`${issue.id}:${comment.id}`] = record;
  else shared.comments = [record];
  return comment;
}

// -------------------------------------------------------------------------------------------------
// A tiny GraphQL document parser.
// -------------------------------------------------------------------------------------------------

type Tok = { t: 'name' | 'string' | 'number' | 'punct' | 'eof'; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c) || c === ',') { i += 1; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (/[A-Za-z_]/.test(c)) {
      const s = i; i += 1;
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i]!)) i += 1;
      out.push({ t: 'name', v: src.slice(s, i) }); continue;
    }
    if (c === '"' || c === "'") {
      const quote = c; i += 1; let text = '';
      while (i < src.length) {
        const d = src[i]!;
        if (d === '\\' && i + 1 < src.length) { text += src[i + 1]!; i += 2; continue; }
        if (d === quote) { i += 1; break; }
        text += d; i += 1;
      }
      out.push({ t: 'string', v: text }); continue;
    }
    if (/[0-9]/.test(c) || (c === '-' && i + 1 < src.length && /[0-9]/.test(src[i + 1]!))) {
      const s = i; i += 1;
      while (i < src.length && /[0-9.]/.test(src[i]!)) i += 1;
      out.push({ t: 'number', v: src.slice(s, i) }); continue;
    }
    if (src.startsWith('...', i)) { out.push({ t: 'punct', v: '...' }); i += 3; continue; }
    if (c === '$') { out.push({ t: 'punct', v: '$' }); i += 1; continue; }
    if ('{}()[]:!@|=&'.includes(c)) { out.push({ t: 'punct', v: c }); i += 1; continue; }
    out.push({ t: 'punct', v: c }); i += 1;
  }
  out.push({ t: 'eof', v: '' });
  return out;
}

type Sel =
  | { kind: 'field'; alias: string; field: string; args: Record<string, unknown>; selection: Sel[] | null }
  | { kind: 'inline'; type: string; selection: Sel[] }
  | { kind: 'spread'; name: string };

type Operation = { type: string; name?: string; selection: Sel[] };

class Parser {
  private p = 0;
  private readonly toks: Tok[];
  constructor(toks: Tok[]) { this.toks = toks; }

  private peek(): Tok { return this.toks[this.p] ?? { t: 'eof', v: '' }; }
  private take(): Tok { return this.toks[this.p++] ?? { t: 'eof', v: '' }; }
  private at(v: string): boolean { const t = this.peek(); return t.t === 'punct' && t.v === v; }
  private eat(v: string): boolean { if (this.at(v)) { this.p += 1; return true; } return false; }
  private eof(): boolean { return this.peek().t === 'eof'; }

  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (!this.eof()) {
      const t = this.peek();
      if (t.t === 'punct' && t.v === '{') {
        ops.push({ type: 'query', selection: this.parseSelectionSet() }); continue;
      }
      if (t.t === 'name' && (t.v === 'query' || t.v === 'mutation' || t.v === 'subscription')) {
        const type = this.take().v;
        let name: string | undefined;
        const n = this.peek();
        if (n.t === 'name' && n.v !== 'on') name = this.take().v;
        // variable definitions and directives
        if (this.at('(')) this.skipBalanced('(', ')');
        while (this.at('@')) { this.take(); if (this.peek().t === 'name') this.take(); if (this.at('(')) this.skipBalanced('(', ')'); }
        ops.push({ type, name, selection: this.parseSelectionSet() }); continue;
      }
      if (t.t === 'name' && t.v === 'fragment') {
        this.take();
        if (this.peek().t === 'name') this.take();
        if (this.peek().t === 'name' && this.peek().v === 'on') this.take();
        if (this.peek().t === 'name') this.take();
        this.parseSelectionSet(); continue;
      }
      this.p += 1;
    }
    return ops;
  }

  private skipBalanced(open: string, close: string): void {
    this.eat(open);
    let depth = 1;
    while (!this.eof() && depth > 0) {
      if (this.at(open)) depth += 1;
      else if (this.at(close)) depth -= 1;
      this.p += 1;
    }
  }

  private parseSelectionSet(): Sel[] {
    const sels: Sel[] = [];
    if (!this.eat('{')) return sels;
    while (!this.eof() && !this.at('}')) {
      if (this.at('...')) {
        this.take();
        const t = this.peek();
        if (t.t === 'name' && t.v === 'on') {
          this.take();
          const type = this.peek().t === 'name' ? this.take().v : '';
          sels.push({ kind: 'inline', type, selection: this.parseSelectionSet() });
        } else if (t.t === 'name') {
          sels.push({ kind: 'spread', name: this.take().v });
        } else {
          sels.push({ kind: 'spread', name: '' });
        }
        continue;
      }
      const first = this.take();
      if (first.t === 'eof') break;
      let alias = first.v;
      let field = first.v;
      if (this.eat(':')) {
        alias = first.v;
        field = this.take().v;
      }
      let args: Record<string, unknown> = {};
      if (this.at('(')) args = this.parseArguments();
      while (this.at('@')) { this.take(); if (this.peek().t === 'name') this.take(); if (this.at('(')) this.skipBalanced('(', ')'); }
      const selection = this.at('{') ? this.parseSelectionSet() : null;
      sels.push({ kind: 'field', alias, field, args, selection });
    }
    this.eat('}');
    return sels;
  }

  private parseArguments(): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    if (!this.eat('(')) return args;
    while (!this.eof() && !this.at(')')) {
      const key = this.take().v;
      this.eat(':');
      args[key] = this.parseValue();
      this.eat(',');
    }
    this.eat(')');
    return args;
  }

  private parseValue(): unknown {
    const t = this.peek();
    if (t.t === 'string' || t.t === 'number') { this.p += 1; return t.v === 'number' ? Number(t.v) : t.v; }
    if (t.t === 'name') {
      this.p += 1;
      if (t.v === 'true') return true;
      if (t.v === 'false') return false;
      if (t.v === 'null') return null;
      return t.v; // enum value
    }
    if (t.t === 'punct') {
      if (t.v === '$') { this.p += 1; return { __var: this.take().v }; }
      if (t.v === '[') {
        this.p += 1; const arr: unknown[] = [];
        while (!this.eof() && !this.at(']')) { arr.push(this.parseValue()); this.eat(','); }
        this.eat(']'); return arr;
      }
      if (t.v === '{') {
        this.p += 1; const obj: Record<string, unknown> = {};
        while (!this.eof() && !this.at('}')) {
          const k = this.take().v; this.eat(':'); obj[k] = this.parseValue(); this.eat(',');
        }
        this.eat('}'); return obj;
      }
    }
    this.p += 1;
    return null;
  }
}

function resolveValue(value: unknown, vars: Record<string, unknown>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => resolveValue(v, vars));
  const rec = value as Record<string, unknown>;
  if (typeof rec.__var === 'string' && Object.keys(rec).length === 1) {
    return Object.prototype.hasOwnProperty.call(vars, rec.__var) ? vars[rec.__var] : null;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) out[k] = resolveValue(v, vars);
  return out;
}

// -------------------------------------------------------------------------------------------------
// Resolver objects and execution.
// -------------------------------------------------------------------------------------------------

const UNRESOLVED = Symbol('unresolved');
type Resolver = (args: Record<string, any>) => any;

function wrap(typename: string, resolvers: Record<string, Resolver>): any {
  return {
    __typename: typename,
    __resolve(name: string, args: Record<string, any>): any {
      const fn = resolvers[name];
      return fn === undefined ? UNRESOLVED : fn(args);
    },
  };
}

const SCHEMA: Record<string, { fields?: string[]; enumValues?: string[] }> = {
  Issue: { fields: ['id', 'number', 'title', 'state', 'body', 'labels', 'author', 'createdAt', 'updatedAt', 'comments', 'repository', 'url'] },
  PullRequest: { fields: ['id', 'number', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'title', 'body', 'author', 'createdAt', 'updatedAt', 'url'] },
  Repository: { fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'description', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'isPrivate', 'issue', 'issues', 'pullRequest', 'pullRequests', 'createdAt', 'updatedAt', 'url'] },
  User: { fields: ['id', 'login', 'name', 'email', 'avatarUrl'] },
  IssueConnection: { fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestConnection: { fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PageInfo: { fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'] },
  PullRequestChangedFile: { fields: ['path', 'additions', 'deletions'] },
  Query: { fields: ['viewer', 'repository', 'node', '__type'] },
  Mutation: { fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'] },
  SearchType: { enumValues: ['ISSUE', 'REPOSITORY', 'CODE', 'USER', 'DISCUSSION', 'COMMIT', 'LABEL', 'MILESTONE'] },
  IssueState: { enumValues: ['OPEN', 'CLOSED'] },
  MergeableState: { enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  PullRequestState: { enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  PullRequestMergeMethod: { enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  RepositoryPermission: { enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  IssueOrderField: { enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { enumValues: ['ASC', 'DESC'] },
};

function typeWrapper(name: string): any {
  const spec = SCHEMA[name];
  if (spec === undefined) return null;
  return {
    __typename: '__Type',
    name,
    fields: spec.fields === undefined ? null : spec.fields.map((f) => ({ name: f })),
    enumValues: spec.enumValues === undefined ? null : spec.enumValues.map((e) => ({ name: e })),
  };
}

function issueWrapper(repo: Repo, issue: any): any {
  return wrap('Issue', {
    id: () => globalIssueId(repo, issue.number),
    number: () => issue.number,
    title: () => issue.title,
    body: () => issue.body ?? '',
    state: () => String(issue.state ?? 'open').toUpperCase(),
    comments: () => (typeof issue.comments === 'number' ? issue.comments : 0),
    createdAt: () => issue.created_at,
    updatedAt: () => issue.updated_at,
    url: () => `https://github.com/${repo.full_name}/issues/${issue.number}`,
    labels: () => (issue.labels ?? []).map((l: any) => ({ name: l.name })),
    author: () => ({ login: issue.user?.login ?? state.viewer, __typename: 'User' }),
  });
}

function pullFiles(repo: Repo, pull: any): any {
  const paths = new Set<string>();
  const extras = (repo as any).__rest;
  const meta = extras !== undefined && extras.prMeta instanceof Map ? extras.prMeta.get(pull?.number) : undefined;
  if (meta !== undefined && Array.isArray(meta.files)) {
    for (const f of meta.files) if (typeof f.filename === 'string') paths.add(f.filename);
  }
  for (const p of repo.contents.keys()) paths.add(p);
  const blobList = (buildScenario() as any).blobs as Array<{ path: string }>;
  for (const b of blobList) paths.add(b.path);
  return { nodes: [...paths].map((path) => ({ path })) };
}

function pullWrapper(repo: Repo, pull: any): any {
  return wrap('PullRequest', {
    id: () => globalPullId(repo, pull.number),
    number: () => pull.number,
    title: () => pull.title,
    body: () => pull.body ?? '',
    state: () => (pull.merged === true ? 'MERGED' : String(pull.state ?? 'open').toUpperCase()),
    merged: () => pull.merged === true,
    mergeable: () => 'MERGEABLE',
    headRefName: () => pull.head?.ref ?? '',
    baseRefName: () => pull.base?.ref ?? '',
    createdAt: () => pull.created_at,
    updatedAt: () => pull.updated_at,
    url: () => `https://github.com/${repo.full_name}/pull/${pull.number}`,
    author: () => ({ login: pull.user?.login ?? state.viewer, __typename: 'User' }),
    files: () => pullFiles(repo, pull),
  });
}

function pageIssues(repo: Repo, args: Record<string, any>): any {
  let list = repo.issues.slice();
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = states.map((s: unknown) => String(s).toUpperCase());
    list = list.filter((i: any) => wanted.includes(String(i.state ?? 'open').toUpperCase()));
  }
  const orderBy = args.orderBy;
  if (orderBy !== null && typeof orderBy === 'object') {
    const ob = orderBy as Record<string, unknown>;
    const field = String(ob.field ?? 'CREATED_AT');
    const direction = String(ob.direction ?? 'ASC').toUpperCase() === 'DESC' ? -1 : 1;
    list = list.slice().sort((a: any, b: any) => {
      let cmp = 0;
      if (field === 'COMMENTS') cmp = (a.comments ?? 0) - (b.comments ?? 0);
      else if (field === 'UPDATED_AT') cmp = String(a.updated_at ?? '').localeCompare(String(b.updated_at ?? ''));
      else cmp = Number(a.number) - Number(b.number);
      return direction * cmp;
    });
  } else {
    list = list.slice().sort((a: any, b: any) => Number(a.number) - Number(b.number));
  }
  const first = args.first === undefined || args.first === null ? list.length : Math.max(0, Number(args.first));
  const after = args.after === undefined || args.after === null ? null : String(args.after);
  let start = 0;
  if (after !== null) {
    const n = Number(after.replace(/^c_/, ''));
    const idx = list.findIndex((i: any) => Number(i.number) === n);
    start = idx >= 0 ? idx + 1 : 0;
  }
  const page = list.slice(start, start + first);
  const endCursor = page.length > 0 ? `c_${page[page.length - 1]!.number}` : (start > 0 && list[start - 1] !== undefined ? `c_${list[start - 1]!.number}` : null);
  return {
    nodes: page.map((i: any) => issueWrapper(repo, i)),
    pageInfo: { hasNextPage: start + first < list.length, endCursor },
  };
}

function repoWrapper(repo: Repo): any {
  return wrap('Repository', {
    id: () => globalRepoId(repo),
    databaseId: () => repo.id,
    name: () => repo.name,
    nameWithOwner: () => repo.full_name,
    description: () => repo.description,
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    createdAt: () => repo.created_at,
    updatedAt: () => repo.updated_at,
    url: () => `https://github.com/${repo.full_name}`,
    owner: () => ({ login: repo.owner.login, id: repo.owner.id, __typename: 'User' }),
    defaultBranchRef: () => ({ name: repo.default_branch }),
    issue: (a: Record<string, any>) => {
      const n = Number(a.number);
      const found = repo.issues.find((i: any) => Number(i.number) === n);
      return found === undefined ? null : issueWrapper(repo, found);
    },
    issues: (a: Record<string, any>) => pageIssues(repo, a),
    pullRequest: (a: Record<string, any>) => {
      const n = Number(a.number);
      const found = repo.pulls.find((p: any) => Number(p.number) === n);
      return found === undefined ? null : pullWrapper(repo, found);
    },
    pullRequests: (a: Record<string, any>) => {
      const first = a.first === undefined || a.first === null ? repo.pulls.length : Math.max(0, Number(a.first));
      return { nodes: repo.pulls.slice(0, first).map((p: any) => pullWrapper(repo, p)) };
    },
  });
}

const QUERY_ROOT = wrap('Query', {
  viewer: () => ({ login: state.viewer, id: 'U_1', __typename: 'User' }),
  repository: (a: Record<string, any>) => {
    const repo = findRepo(String(a.owner ?? ''), String(a.name ?? ''));
    return repo === undefined ? null : repoWrapper(repo);
  },
  node: (a: Record<string, any>) => {
    const repo = repoById(String(a.id ?? ''));
    return repo === undefined ? null : repoWrapper(repo);
  },
  __type: (a: Record<string, any>) => typeWrapper(String(a.name ?? '')),
});

const MUTATION_ROOT = wrap('Mutation', {
  createIssue: (a: Record<string, any>) => {
    const input = a.input ?? {};
    const repo = repoById(String(input.repositoryId ?? ''));
    if (repo === undefined) return null;
    const issue = createIssueRecord(repo, String(input.title ?? ''), String(input.body ?? ''));
    return { issue: issueWrapper(repo, issue) };
  },
  closeIssue: (a: Record<string, any>) => {
    const input = a.input ?? {};
    const loc = parseIssueId(String(input.issueId ?? ''));
    if (loc === undefined) return null;
    loc.repo.issues.forEach((i: any) => { if (Number(i.number) === loc.number) i.state = 'closed'; });
    const issue = loc.repo.issues.find((i: any) => Number(i.number) === loc.number);
    return { issue: issue === undefined ? null : issueWrapper(loc.repo, issue) };
  },
  createPullRequest: (a: Record<string, any>) => {
    const input = a.input ?? {};
    const repo = repoById(String(input.repositoryId ?? ''));
    if (repo === undefined) return null;
    const pull = createPullRecord(repo, String(input.headRefName ?? ''), String(input.baseRefName ?? ''), String(input.title ?? ''), String(input.body ?? ''));
    return { pullRequest: pullWrapper(repo, pull) };
  },
  mergePullRequest: (a: Record<string, any>) => {
    const input = a.input ?? {};
    const loc = parsePullId(String(input.pullRequestId ?? ''));
    if (loc === undefined) return null;
    const pull = mergePullRecord(loc.repo, loc.number);
    return { pullRequest: pull === undefined ? null : pullWrapper(loc.repo, pull) };
  },
  addComment: (a: Record<string, any>) => {
    const input = a.input ?? {};
    const loc = parseIssueId(String(input.subjectId ?? ''));
    if (loc === undefined) return null;
    const issue = loc.repo.issues.find((i: any) => Number(i.number) === loc.number);
    if (issue === undefined) return null;
    const comment = storeComment(loc.repo, issue, String(input.body ?? ''));
    return {
      commentEdge: {
        node: { id: `C_${comment.id}`, body: comment.body, __typename: 'IssueComment' },
        __typename: 'IssueCommentEdge',
      },
    };
  },
});

type ErrorEntry = { message: string; path?: (string | number)[] };

function fieldValue(parent: any, name: string, args: Record<string, any>): any {
  if (parent === null || parent === undefined) return null;
  if (name === '__typename') return parent.__typename ?? null;
  if (typeof parent.__resolve === 'function') return parent.__resolve(name, args);
  if (Object.prototype.hasOwnProperty.call(parent, name)) {
    const v = parent[name];
    return typeof v === 'function' ? v(args) : v;
  }
  return UNRESOLVED;
}

function executeSelection(parent: any, selection: Sel[], vars: Record<string, unknown>, errors: ErrorEntry[], path: (string | number)[]): any {
  if (Array.isArray(parent)) {
    return parent.map((item, index) => executeSelection(item, selection, vars, errors, [...path, index]));
  }
  const result: Record<string, unknown> = {};
  for (const sel of selection) {
    if (sel.kind === 'spread') continue;
    if (sel.kind === 'inline') {
      if (parent !== null && parent !== undefined && parent.__typename === sel.type) {
        const nested = executeSelection(parent, sel.selection, vars, errors, path);
        if (nested !== null && typeof nested === 'object') Object.assign(result, nested);
      }
      continue;
    }
    const args = resolveValue(sel.args, vars) as Record<string, any>;
    const value = fieldValue(parent, sel.field, args);
    if (value === UNRESOLVED) {
      const label = parent && typeof parent.__typename === 'string' ? parent.__typename : 'Query';
      errors.push({ message: `Cannot query field "${sel.field}" on type "${label}".`, path: [...path, sel.alias] });
      result[sel.alias] = null;
      continue;
    }
    if (sel.selection !== null && value !== null && value !== undefined) {
      result[sel.alias] = executeSelection(value, sel.selection, vars, errors, [...path, sel.alias]);
    } else {
      result[sel.alias] = value === undefined ? null : value;
    }
  }
  return result;
}

function executeOperation(op: Operation, variables: Record<string, unknown>): { data: any; errors?: ErrorEntry[] } {
  const errors: ErrorEntry[] = [];
  const root = op.type === 'mutation' ? MUTATION_ROOT : op.type === 'subscription' ? QUERY_ROOT : QUERY_ROOT;
  const data = executeSelection(root, op.selection, variables ?? {}, errors, []);
  return errors.length > 0 ? { data, errors } : { data };
}

function executeBody(body: any): any {
  if (Array.isArray(body)) return body.map((entry) => executeOne(entry));
  return executeOne(body);
}

function executeOne(entry: any): any {
  if (entry === null || typeof entry !== 'object' || typeof entry.query !== 'string') {
    return { data: null, errors: [{ message: 'A GraphQL request must carry a query string.' }] };
  }
  let ops: Operation[];
  try {
    ops = new Parser(tokenize(entry.query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Could not parse the document.' }] };
  }
  if (ops.length === 0) return { data: null, errors: [{ message: 'The document holds no operation.' }] };
  const variables = entry.variables !== null && typeof entry.variables === 'object' && !Array.isArray(entry.variables) ? entry.variables : {};
  // A document holds one operation in every shape the suite sends; answer each in order.
  const answers = ops.map((op) => executeOperation(op, variables));
  return answers.length === 1 ? answers[0] : answers.map((a) => a);
}

// -------------------------------------------------------------------------------------------------
// HTTP entry point.
// -------------------------------------------------------------------------------------------------

export async function handleGraphql(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
): Promise<boolean> {
  if (path !== '/api/graphql') return false;
  if (method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return true;
  }
  if (!authorized(req)) {
    sendJson(res, 401, { message: 'Unauthorized' });
    return true;
  }
  let body: unknown = {};
  try {
    const raw = await readBody(req);
    body = raw.length === 0 ? {} : JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { data: null, errors: [{ message: 'The request body is not valid JSON.' }] });
    return true;
  }
  sendJson(res, 200, executeBody(body));
  return true;
}

// Exported for local conformance-style probing.
export { executeBody as executeGraphqlBody };
