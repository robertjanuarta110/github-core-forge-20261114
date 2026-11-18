// Model Context Protocol endpoint for the forge: Streamable HTTP over JSON-RPC 2.0.
// Speaks both the 2026-07-28 revision (server/discover, _meta protocolVersion) and the legacy
// initialize / notifications/initialized handshake with a Mcp-Session-Id.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { authorized, readBody, sendJson } from './http.ts';
import { state, findRepo, jsonRepo } from './store.ts';
import type { Repo } from './store.ts';
import {
  makeNewRepo, createIssueRecord, createPullRecord, mergePullRecord, storeComment,
} from './graphql.ts';

const SERVER_NAME = 'github-core-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = Object.freeze([
  '2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05',
]);

let sessionCounter = 0;

type Args = Record<string, any>;

const TOOLS = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The account that will own the repository.' },
        name: { type: 'string', description: 'The name of the new repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by its owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The account that owns the repository.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Open a new issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The account that owns the repository.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The account that owns the repository.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The account that owns the repository.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        body: { type: 'string', description: 'The body of the pull request.' },
        head: { type: 'string', description: 'The branch holding the changes.' },
        base: { type: 'string', description: 'The branch to merge into.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by its number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The account that owns the repository.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The number of the pull request to merge.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

const TOOLS_BY_NAME = new Map<string, any>(TOOLS.map((t) => [t.name, t]));

function okResult(obj: unknown): any {
  return {
    content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj) }],
    structuredContent: obj,
  };
}

function errorResult(message: string): any {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function repoOrNull(owner: unknown, repo: unknown): Repo | undefined {
  return findRepo(String(owner ?? ''), String(repo ?? ''));
}

function issueJson(repo: Repo, issue: any): any {
  return {
    id: issue.id, number: issue.number, title: issue.title, body: issue.body ?? '',
    state: issue.state, html_url: `https://github.com/${repo.full_name}/issues/${issue.number}`,
    repository_url: `https://api.github.com/repos/${repo.full_name}`,
    user: issue.user, labels: issue.labels ?? [], comments: issue.comments ?? 0,
    created_at: issue.created_at, updated_at: issue.updated_at,
  };
}

function pullJson(repo: Repo, pull: any): any {
  return {
    id: pull.id, number: pull.number, title: pull.title, body: pull.body ?? '',
    state: pull.state, merged: pull.merged === true,
    head: pull.head, base: pull.base,
    html_url: `https://github.com/${repo.full_name}/pull/${pull.number}`,
    user: pull.user, created_at: pull.created_at, updated_at: pull.updated_at,
  };
}

function callTool(name: string, args: Args): any {
  const tool = TOOLS_BY_NAME.get(name);
  if (tool === undefined) return { rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
  const required = Array.isArray(tool.inputSchema.required) ? tool.inputSchema.required : [];
  const missing = required.filter((key: string) => args[key] === undefined || args[key] === null);
  if (missing.length > 0) {
    return { result: errorResult(`Missing required argument(s): ${missing.join(', ')}`) };
  }

  switch (name) {
    case 'create_repo': {
      const owner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : state.viewer;
      const title = String(args.name ?? '');
      if (title === '') return { result: errorResult('A repository name is required.') };
      const repo = makeNewRepo(owner, title, String(args.description ?? ''), args.private === true);
      state.repos.push(repo);
      return { result: okResult(jsonRepo(repo)) };
    }
    case 'get_repo': {
      const repo = repoOrNull(args.owner, args.repo);
      if (repo === undefined) return { result: errorResult(`Repository not found: ${String(args.owner)}/${String(args.repo)}`) };
      return { result: okResult(jsonRepo(repo)) };
    }
    case 'create_issue': {
      const repo = repoOrNull(args.owner, args.repo);
      if (repo === undefined) return { result: errorResult(`Repository not found: ${String(args.owner)}/${String(args.repo)}`) };
      const issue = createIssueRecord(repo, String(args.title ?? ''), String(args.body ?? ''));
      return { result: okResult(issueJson(repo, issue)) };
    }
    case 'list_issues': {
      const repo = repoOrNull(args.owner, args.repo);
      if (repo === undefined) return { result: errorResult(`Repository not found: ${String(args.owner)}/${String(args.repo)}`) };
      const wanted = typeof args.state === 'string' ? args.state.toLowerCase() : 'all';
      let issues = repo.issues.slice();
      if (wanted === 'open' || wanted === 'closed') {
        issues = issues.filter((i: any) => String(i.state).toLowerCase() === wanted);
      }
      return { result: okResult(issues.map((i: any) => issueJson(repo, i))) };
    }
    case 'create_pull_request': {
      const repo = repoOrNull(args.owner, args.repo);
      if (repo === undefined) return { result: errorResult(`Repository not found: ${String(args.owner)}/${String(args.repo)}`) };
      const pull = createPullRecord(repo, String(args.head ?? ''), String(args.base ?? ''), String(args.title ?? ''), String(args.body ?? ''));
      return { result: okResult(pullJson(repo, pull)) };
    }
    case 'merge_pull_request': {
      const repo = repoOrNull(args.owner, args.repo);
      if (repo === undefined) return { result: errorResult(`Repository not found: ${String(args.owner)}/${String(args.repo)}`) };
      const number = Number(args.pull_number);
      const pull = mergePullRecord(repo, number);
      if (pull === undefined) return { result: errorResult(`Pull request not found: #${String(args.pull_number)}`) };
      return { result: okResult({ number: pull.number, merged: true, state: 'closed', html_url: pull.html_url ?? `https://github.com/${repo.full_name}/pull/${pull.number}` }) };
    }
    default:
      return { rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
  }
}

function discoverResult(): any {
  const identity = { name: SERVER_NAME, version: SERVER_VERSION };
  return {
    resultType: 'discover',
    supportedVersions: [...SUPPORTED_VERSIONS],
    capabilities: { tools: { listChanged: false }, logging: {} },
    instructions: 'A GitHub-compatible forge exposing repository, issue and pull request tools.',
    serverInfo: identity,
    _meta: { 'io.modelcontextprotocol/serverInfo': identity },
  };
}

/** Handle one JSON-RPC object. Returns null for a notification (no response body). */
function handleOne(rpc: any): { body?: any; session?: string; noContent?: boolean } {
  if (rpc === null || typeof rpc !== 'object' || Array.isArray(rpc)) {
    return { body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const id = Object.prototype.hasOwnProperty.call(rpc, 'id') ? rpc.id : undefined;
  const method = String(rpc.method ?? '');
  const params = rpc.params !== null && typeof rpc.params === 'object' ? rpc.params : {};
  const isNotification = id === undefined;

  let payload: { result?: unknown; rpcError?: any } | null = null;
  let session: string | undefined;

  switch (method) {
    case 'server/discover':
      payload = { result: discoverResult() };
      break;
    case 'initialize': {
      const revision = typeof params.protocolVersion === 'string' && params.protocolVersion !== ''
        ? params.protocolVersion
        : '2026-07-28';
      payload = {
        result: {
          protocolVersion: revision,
          capabilities: { tools: { listChanged: false }, logging: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: 'A GitHub-compatible forge exposing repository, issue and pull request tools.',
        },
      };
      sessionCounter += 1;
      session = `mcp-session-${sessionCounter}`;
      break;
    }
    case 'notifications/initialized':
    case 'initialized':
      if (!isNotification) payload = { result: {} };
      break;
    case 'ping':
      payload = { result: {} };
      break;
    case 'tools/list':
      payload = { result: { tools: TOOLS } };
      break;
    case 'tools/call': {
      const name = String(params.name ?? '');
      const args = params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
        ? params.arguments
        : {};
      payload = callTool(name, args);
      break;
    }
    default:
      payload = { rpcError: { code: -32601, message: `Method not found: ${method}` } };
      break;
  }

  if (isNotification && payload?.rpcError === undefined) return { noContent: true };
  const body = payload === null
    ? { jsonrpc: '2.0', id: id ?? null, result: {} }
    : payload.rpcError !== undefined
      ? { jsonrpc: '2.0', id: id ?? null, error: payload.rpcError }
      : { jsonrpc: '2.0', id: id ?? null, result: payload.result ?? {} };
  return { body, session };
}

export async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
): Promise<boolean> {
  if (path !== '/mcp') return false;
  if (method === 'DELETE') {
    res.writeHead(204);
    res.end();
    return true;
  }
  if (method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return true;
  }
  if (!authorized(req)) {
    sendJson(res, 401, { message: 'Unauthorized' });
    return true;
  }

  let parsed: unknown;
  try {
    const raw = await readBody(req);
    if (raw.length === 0) throw new Error('empty body');
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }

  if (Array.isArray(parsed)) {
    const answers = parsed.map((entry) => handleOne(entry));
    const bodies = answers.map((a) => a.body ?? { jsonrpc: '2.0', id: null, result: {} });
    const headers: Record<string, string> = {};
    for (const a of answers) if (a.session !== undefined) headers['mcp-session-id'] = a.session;
    sendJson(res, 200, bodies, headers);
    return true;
  }

  const answer = handleOne(parsed);
  if (answer.noContent) {
    res.writeHead(202);
    res.end();
    return true;
  }
  const headers: Record<string, string> = {};
  if (answer.session !== undefined) headers['mcp-session-id'] = answer.session;
  sendJson(res, 200, answer.body, headers);
  return true;
}
