// In-memory forge state, seeded deterministically from the kit's public scenario.
import { buildScenario } from './scenario.ts';

const scenario = buildScenario();
const EPOCH = '2025-01-01T00:00:00.000Z';

export interface Content {
  path: string;
  sha: string;
  content: string;
  encoding: 'base64';
  size: number;
}

export interface GitObject {
  type: 'blob' | 'tree' | 'commit' | 'tag';
  data: Buffer;
}

export interface Repo {
  id: number;
  databaseId: number;
  name: string;
  full_name: string;
  owner: { login: string; id: number; type: 'User' | 'Organization' };
  description: string;
  private: boolean;
  default_branch: string;
  created_at: string;
  updated_at: string;
  branches: Map<string, string>;
  contents: Map<string, Content>;
  commits: Array<{ sha: string; message: string; author: { name: string; email: string }; date: string }>;
  labels: Array<{ id: number; name: string; color: string; description: string }>;
  issues: any[];
  pulls: any[];
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
}

function shaOf(text: string): string {
  // Deterministic 40-hex pseudo-sha; stable across runs and processes.
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  let out = '';
  let x = h;
  for (let i = 0; i < 10; i += 1) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    out += x.toString(16).padStart(8, '0');
  }
  return out.slice(0, 40);
}

function makeRepo(id: number, owner: string, name: string, description: string): Repo {
  const full_name = `${owner}/${name}`;
  const contents = new Map<string, Content>();
  const blobs = (scenario as any).blobs as Array<{ path: string; content: string; base64: string }>;
  for (let i = 0; i < Math.min(6, blobs.length); i += 1) {
    const b = blobs[(i + id) % blobs.length]!;
    contents.set(b.path, { path: b.path, sha: shaOf(full_name + b.path), content: b.base64, encoding: 'base64', size: Buffer.from(b.base64, 'base64').length });
  }
  const branches = new Map<string, string>();
  const names = (scenario as any).branches as string[];
  for (let i = 0; i < Math.min(6, names.length); i += 1) branches.set(names[i]!, shaOf(full_name + names[i]));
  const commits = ((scenario as any).commits as any[]).slice(0, 4).map((c, i) => ({
    sha: shaOf(full_name + c.message + i),
    message: c.message,
    author: { name: c.author.name, email: c.author.email },
    date: c.iso,
  }));
  return {
    id, databaseId: id, name, full_name,
    owner: { login: owner, id: owner === scenario.viewer.login ? 1000 : 1002, type: 'User' },
    description, private: false, default_branch: 'main', created_at: EPOCH, updated_at: EPOCH,
    branches, contents, commits, labels: [], issues: [], pulls: [],
    refs: new Map(branches), objects: new Map(),
  };
}

export const state = {
  viewer: scenario.viewer.login as string,
  stranger: scenario.stranger.login as string,
  org: scenario.org as string,
  token: process.env.MAKEFUN_SHOP_TOKEN ?? '',
  repos: [] as Repo[],
  counters: { repo: 5000, issue: 1, pull: 1, label: 1, comment: 1 },
  githubScope: 'repo, read:org',
};

// Seed the three sets the conformance suite knows about.
for (const r of scenario.repos) state.repos.push(makeRepo(r.id, r.owner, r.name, r.description));
for (const r of scenario.orgRepos) state.repos.push(makeRepo(r.id, scenario.org, r.name, r.description));
for (const r of scenario.strangerRepos) state.repos.push(makeRepo(r.id, scenario.stranger.login, r.name, r.description));

// Seed labels and a few issues/pulls on the first viewer repos.
for (const name of scenario.labels) {
  state.repos[0]!.labels.push({ id: state.counters.label++, name, color: 'ededed', description: `${name} label` });
}
const seedIssues = scenario.issues.slice(0, 8);
const seedPulls = scenario.pulls.slice(0, 4);
for (let i = 0; i < seedIssues.length; i += 1) {
  const issue = seedIssues[i]!;
  const repo = state.repos[i % Math.min(6, state.repos.length)]!;
  repo.issues.push({
    id: state.counters.issue, number: state.counters.issue,
    title: issue.title, body: issue.body, state: 'open',
    labels: (issue.labels ?? []).map((n: string) => ({ name: n })),
    user: { login: state.viewer }, created_at: EPOCH, updated_at: EPOCH, comments: 0,
  });
  state.counters.issue += 1;
}
for (let i = 0; i < seedPulls.length; i += 1) {
  const p = seedPulls[i]!;
  const repo = state.repos[i % Math.min(6, state.repos.length)]!;
  repo.pulls.push({
    id: state.counters.pull, number: state.counters.pull,
    title: p.title, body: p.body, state: 'open', merged: false,
    head: { ref: p.head, sha: shaOf(p.head) }, base: { ref: p.base, sha: shaOf(p.base) },
    user: { login: state.viewer }, created_at: EPOCH, updated_at: EPOCH,
  });
  state.counters.pull += 1;
}

export function findRepo(owner: string, name: string): Repo | undefined {
  return state.repos.find((r) => r.owner.login === owner && r.name === name);
}

export function jsonRepo(r: Repo): any {
  return {
    id: r.id, node_id: `R_${r.id}`, name: r.name, full_name: r.full_name,
    owner: { login: r.owner.login, id: r.owner.id, type: r.owner.type },
    private: r.private, description: r.description, html_url: `https://github.com/${r.full_name}`,
    clone_url: `https://github.com/${r.full_name}.git`,
    default_branch: r.default_branch, created_at: r.created_at, updated_at: r.updated_at,
    open_issues_count: r.issues.filter((i) => i.state === 'open').length,
  };
}

export function nextSha(label: string): string {
  return shaOf(label + state.counters.repo++);
}

export { shaOf, EPOCH };
