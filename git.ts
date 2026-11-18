// Standalone git smart-HTTP server (upload-pack protocol v2 + v0, receive-pack v0).
// Dependency-free: node:crypto, node:zlib and the shared in-memory store only.
// Deterministic: nothing here reads the wall clock or stores anything derived from it.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { readBody, sendRaw } from './http.ts';
import { findRepo, type GitObject, type Repo } from './store.ts';

type ObjType = 'blob' | 'tree' | 'commit' | 'tag';
type ObjMap = Map<string, GitObject>;

const ZERO = '0'.repeat(40);
const HEX40 = /^[0-9a-f]{40}$/;
const PKT_PAYLOAD_MAX = 65516; // git LARGE_PACKET_MAX (65520) minus the 4-byte header
const CODE_TYPE: Record<number, ObjType | undefined> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

// ---------------------------------------------------------------- pkt-line

function pkt(payload: string | Uint8Array): Buffer {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload as string, 'utf8');
  const len = data.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}
const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

interface PktItem {
  readonly kind: 'data' | 'flush' | 'delim' | 'response-end';
  readonly payload: Buffer;
}

/** Parse pkt-lines from the front of `buf`; stop at the first flush. `rest` is the raw tail (a pack). */
function parsePackets(buf: Buffer): { items: PktItem[]; rest: Buffer } {
  const items: PktItem[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const head = buf.toString('ascii', off, off + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const len = Number.parseInt(head, 16);
    if (len === 0) {
      items.push({ kind: 'flush', payload: Buffer.alloc(0) });
      off += 4;
      break;
    }
    if (len === 1) {
      items.push({ kind: 'delim', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len === 2) {
      items.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len < 4 || off + len > buf.length) break;
    items.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { items, rest: buf.subarray(off) };
}

function dataLines(items: readonly PktItem[]): string[] {
  const out: string[] = [];
  for (const it of items) {
    if (it.kind !== 'data') continue;
    const text = it.payload.toString('utf8').replace(/\n$/, '');
    if (text) out.push(text);
  }
  return out;
}

// ---------------------------------------------------------------- object model

function hashObject(type: ObjType, data: Uint8Array): string {
  return createHash('sha1').update(`${type} ${data.length}\u0000`).update(data).digest('hex');
}

function headerEnd(data: Buffer): number {
  const blank = data.indexOf('\n\n');
  return blank < 0 ? data.length : blank;
}

function commitTree(data: Buffer): string {
  for (const line of data.toString('utf8', 0, headerEnd(data)).split('\n')) {
    if (line.startsWith('tree ')) return line.slice(5).trim();
  }
  return '';
}

function commitParents(data: Buffer): string[] {
  const parents: string[] = [];
  for (const line of data.toString('utf8', 0, headerEnd(data)).split('\n')) {
    if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return parents;
}

function tagTarget(data: Buffer): { oid: string; type: ObjType } {
  let oid = '';
  let type: ObjType = 'commit';
  for (const line of data.toString('utf8', 0, headerEnd(data)).split('\n')) {
    if (line.startsWith('object ')) oid = line.slice(7).trim();
    else if (line.startsWith('type ')) {
      const t = line.slice(5).trim();
      if (t === 'commit' || t === 'tree' || t === 'blob' || t === 'tag') type = t;
    }
  }
  return { oid, type };
}

interface TreeEntry {
  readonly mode: string;
  readonly oid: string;
}

function treeEntries(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    const mode = data.toString('ascii', off, space);
    const oid = data.toString('hex', nul + 1, nul + 21);
    out.push({ mode, oid });
    off = nul + 21;
  }
  return out;
}

function isAncestor(oldOid: string, newOid: string, objects: ObjMap): boolean {
  const stack: string[] = [newOid];
  const seen = new Set<string>();
  while (stack.length) {
    const oid = stack.pop()!;
    if (oid === oldOid) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'commit') for (const p of commitParents(obj.data)) stack.push(p);
    else if (obj.type === 'tag') stack.push(tagTarget(obj.data).oid);
  }
  return false;
}

/** Every object reachable from `roots` (tags followed, trees walked), with optional commit depth. */
function reachableWithDepth(
  roots: Iterable<string>,
  objects: ObjMap,
  opts: { depth?: number; shallow?: ReadonlySet<string> } = {},
): Map<string, number> {
  const out = new Map<string, number>();
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const root of roots) {
    if (HEX40.test(root) && root !== ZERO) queue.push({ oid: root, depth: 0 });
  }
  while (queue.length) {
    const { oid, depth } = queue.shift()!;
    if (out.has(oid)) continue;
    const obj = objects.get(oid);
    if (!obj) continue;
    out.set(oid, depth);
    if (obj.type === 'commit') {
      const tree = commitTree(obj.data);
      if (HEX40.test(tree)) queue.push({ oid: tree, depth: -1 });
      const boundary = opts.shallow?.has(oid) === true;
      const canParent = opts.depth == null || depth + 1 < opts.depth;
      if (!boundary && canParent) {
        for (const p of commitParents(obj.data)) queue.push({ oid: p, depth: depth + 1 });
      }
    } else if (obj.type === 'tag') {
      const target = tagTarget(obj.data).oid;
      if (HEX40.test(target)) queue.push({ oid: target, depth });
    } else if (obj.type === 'tree') {
      for (const entry of treeEntries(obj.data)) {
        if (entry.mode !== '160000' && HEX40.test(entry.oid)) queue.push({ oid: entry.oid, depth: -1 });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- pack read / write

function writeVarintSize(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let rest = size;
  let first = (code << 4) | (rest & 0x0f);
  rest = Math.floor(rest / 16);
  while (rest > 0) {
    bytes.push(first | 0x80);
    first = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

function buildPack(objects: readonly GitObject[]): Buffer {
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const obj of objects) {
    parts.push(writeVarintSize(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarint(buf: Buffer, at: number): { size: number; next: number; first: number } {
  let byte = buf[at];
  let size = byte & 0x0f;
  let shift = 4;
  let off = at + 1;
  while (byte & 0x80) {
    byte = buf[off++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack size varint too long');
  }
  return { size, next: off, first: buf[at] };
}

function readOfs(buf: Buffer, at: number): { base: number; next: number } {
  let byte = buf[at];
  let off = at + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buf[off++];
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { base: value, next: off };
}

function inflateAt(buf: Buffer, at: number): { data: Buffer; next: number } {
  const result = inflateSync(buf.subarray(at), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  const used = result.engine.bytesWritten;
  if (!used || used <= 0) throw new Error('zlib stream consumed no bytes');
  return { data: result.buffer, next: at + used };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[off++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset += delta[off++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          copySize += delta[off++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length || written + copySize > targetSize) throw new Error('delta copy out of range');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (off + literal > delta.length || written + literal > targetSize) throw new Error('delta insert out of range');
      delta.copy(out, written, off, off + literal);
      off += literal;
      written += literal;
    } else {
      throw new Error('invalid delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

interface RawEntry {
  readonly start: number;
  readonly typeCode: number;
  readonly size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
  type?: ObjType;
  resolved?: Buffer;
  oid?: string;
}

/** Unpack a received packfile, resolving OFS/REF deltas, and merge every object into `store`. */
function readPackInto(pack: Buffer, store: ObjMap): ObjMap {
  if (pack.length < 32 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('unsupported pack version');
  const count = pack.readUInt32BE(8);
  const trailer = pack.length - 20;
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let off = 12;
  for (let index = 0; index < count; index += 1) {
    const start = off;
    const v = readVarint(pack, off);
    off = v.next;
    const typeCode = (v.first >> 4) & 0x07;
    const entry: RawEntry = { start, typeCode, size: v.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const o = readOfs(pack, off);
      off = o.next;
      entry.baseOffset = start - o.base;
    } else if (typeCode === 7) {
      if (off + 20 > trailer) throw new Error('ref-delta base truncated');
      entry.baseOid = pack.toString('hex', off, off + 20);
      off += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error('unknown pack entry type');
    }
    const inf = inflateAt(pack.subarray(0, trailer), off);
    if (inf.data.length !== v.size) throw new Error('pack entry size mismatch');
    entry.data = inf.data;
    off = inf.next;
    raw.push(entry);
    byOffset.set(start, entry);
  }
  if (off !== trailer) throw new Error('stray bytes before pack trailer');

  const byOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): { type: ObjType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.type && entry.oid) return { type: entry.type, data: entry.resolved, oid: entry.oid };
    if (resolving.has(entry.start)) throw new Error('delta cycle');
    resolving.add(entry.start);
    let type: ObjType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const base = byOffset.get(entry.baseOffset!);
      if (!base) throw new Error('ofs-delta base missing');
      const resolvedBase = resolve(base);
      type = resolvedBase.type;
      data = applyDelta(resolvedBase.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const base = byOid.get(wanted);
      if (base) {
        const resolvedBase = resolve(base);
        type = resolvedBase.type;
        data = applyDelta(resolvedBase.data, entry.data);
      } else {
        const external = store.get(wanted);
        if (!external) throw new Error('ref-delta base missing');
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode]!;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.type = type;
    entry.oid = oid;
    byOid.set(oid, entry);
    resolving.delete(entry.start);
    return { type, data, oid };
  };

  const added: ObjMap = new Map();
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!store.has(resolved.oid)) store.set(resolved.oid, { type: resolved.type, data: resolved.data });
    if (!added.has(resolved.oid)) added.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return added;
}

// ---------------------------------------------------------------- refs helpers

function validRef(o: string): boolean {
  return HEX40.test(o) && o !== ZERO;
}

/** Refs advertised by a repo, filtered to those backed by a real object. */
function repoRefs(repo: Repo): Map<string, string> {
  const refs = new Map<string, string>();
  for (const [name, oid] of repo.refs) {
    if (typeof oid === 'string' && validRef(oid) && repo.objects.has(oid)) refs.set(name, oid);
  }
  return refs;
}

function headTarget(repo: Repo, refs: ReadonlyMap<string, string>): string {
  const target = `refs/heads/${repo.default_branch || 'main'}`;
  if (refs.has(target)) return target;
  for (const name of refs.keys()) if (name.startsWith('refs/heads/')) return name;
  return target;
}

// ---------------------------------------------------------------- capability sets

const UPLOAD_CAPS_V2: readonly string[] = ['version 2', 'ls-refs', 'fetch=shallow', 'object-format=sha1', 'agent=makefun-git/1.0'];
const UPLOAD_CAPS_V0 = ['side-band-64k', 'ofs-delta', 'shallow', 'no-progress', 'agent=makefun-git/1.0', 'symref=HEAD:refs/heads/main'];
const RECEIVE_CAPS_V0 = ['report-status', 'side-band-64k', 'delete-refs', 'ofs-delta', 'agent=makefun-git/1.0'];

function parseCapString(text: string): Map<string, string> {
  const caps = new Map<string, string>();
  for (const token of text.split(' ')) {
    if (!token) continue;
    const eq = token.indexOf('=');
    caps.set(eq < 0 ? token : token.slice(0, eq), eq < 0 ? '' : token.slice(eq + 1));
  }
  return caps;
}

// ---------------------------------------------------------------- advertisements

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const refs = repoRefs(repo);
  const caps = (service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS_V0).join(' ');
  const parts: Buffer[] = [pkt(`# service=${service}\n`), FLUSH];
  const head = headTarget(repo, refs);
  const names = [...refs.keys()].sort();
  // HEAD first, carrying the capabilities and the symref line.
  if (refs.has(head)) {
    parts.push(pkt(`${refs.get(head)} HEAD\u0000symref=HEAD:${head} ${caps}\n`));
  } else if (names.length > 0) {
    const first = names[0]!;
    parts.push(pkt(`${refs.get(first)} ${first}\u0000${caps}\n`));
    if (first !== head) { /* no HEAD symref when the branch is unborn */ }
  } else {
    parts.push(pkt(`${ZERO} capabilities^{}\u0000${caps}\n`));
  }
  for (const name of names) {
    parts.push(pkt(`${refs.get(name)} ${name}\n`));
    const oid = refs.get(name)!;
    const obj = repo.objects.get(oid);
    if (name.startsWith('refs/tags/') && obj?.type === 'tag') {
      const target = tagTarget(obj.data).oid;
      if (validRef(target)) parts.push(pkt(`${target} ${name}^{}\n`));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  const parts: Buffer[] = [pkt('# service=git-upload-pack\n'), FLUSH];
  for (const line of UPLOAD_CAPS_V2) parts.push(pkt(`${line}\n`));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- ls-refs (v2)

function lsRefs(repo: Repo, lines: readonly string[]): Buffer {
  const refs = repoRefs(repo);
  const prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  for (const line of lines) {
    if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length).trim());
    else if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const out: Buffer[] = [];
  const head = headTarget(repo, refs);
  if (refs.has(head) && keep('HEAD') && symrefs) {
    out.push(pkt(`${refs.get(head)} HEAD symref-target:${head}\n`));
  }
  for (const name of [...refs.keys()].sort()) {
    if (!keep(name)) continue;
    const oid = refs.get(name)!;
    let line = `${oid} ${name}`;
    if (peel && name.startsWith('refs/tags/')) {
      const obj = repo.objects.get(oid);
      if (obj?.type === 'tag') {
        const target = tagTarget(obj.data).oid;
        if (validRef(target)) line += ` peeled:${target}`;
      }
    }
    out.push(pkt(`${line}\n`));
  }
  out.push(FLUSH);
  return Buffer.concat(out);
}

// ---------------------------------------------------------------- fetch / upload-pack

interface PackPlan {
  readonly objects: GitObject[];
  readonly shallow: string[];
  readonly unshallow: string[];
  readonly ack: string | null;
}

function planPack(repo: Repo, wants: readonly string[], haves: readonly string[], depth: number | undefined, shallow: readonly string[]): PackPlan {
  const objects = repo.objects;
  const shallowSet = new Set(shallow.filter((oid) => HEX40.test(oid)));
  const haveDepth = reachableWithDepth(haves, objects, { shallow: shallowSet });
  const wantDepth = reachableWithDepth(wants, objects, { depth });

  let newBoundary: string[] = [];
  if (depth != null && depth > 0) {
    // The deepest included commits that still have parents form the new shallow boundary.
    for (const [oid, d] of wantDepth) {
      if (d !== depth - 1) continue;
      const obj = objects.get(oid);
      if (obj?.type === 'commit' && commitParents(obj.data).length > 0) newBoundary.push(oid);
    }
  }
  const unshallow = shallow.filter((oid) => !newBoundary.includes(oid));
  const payload: GitObject[] = [];
  for (const oid of wantDepth.keys()) {
    if (haveDepth.has(oid)) continue;
    const obj = objects.get(oid)!;
    payload.push({ type: obj.type, data: obj.data });
  }
  let ack: string | null = null;
  for (const have of haves) if (wantDepth.has(have)) { ack = have; break; }
  return { objects: payload, shallow: newBoundary, unshallow, ack };
}

function sidebandChunks(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const max = PKT_PAYLOAD_MAX - 1;
  for (let off = 0; off < pack.length; off += max) {
    const chunk = pack.subarray(off, off + max);
    out.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return out;
}

function fetchResponseV2(plan: PackPlan, pack: Buffer): Buffer {
  const parts: Buffer[] = [pkt('acknowledgments\n')];
  if (plan.ack) parts.push(pkt(`ACK ${plan.ack}\n`));
  else parts.push(pkt('NAK\n'));
  parts.push(FLUSH);
  if (plan.shallow.length || plan.unshallow.length) {
    parts.push(pkt('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
    parts.push(FLUSH);
  }
  parts.push(pkt('packfile\n'));
  for (const chunk of sidebandChunks(pack)) parts.push(chunk);
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function fetchResponseV0(plan: PackPlan, pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  if (plan.ack) parts.push(pkt(`ACK ${plan.ack}\n`));
  else parts.push(pkt('NAK\n'));
  for (const oid of plan.shallow) parts.push(pkt(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
  for (const chunk of sidebandChunks(pack)) parts.push(chunk);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

interface RefReport {
  readonly ref: string;
  readonly ok: boolean;
  readonly reason: string;
}

function processPush(repo: Repo, commands: readonly PushCommand[], pack: Buffer | null, caps: ReadonlyMap<string, string>): Buffer {
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (pack && pack.length) {
    try {
      readPackInto(pack, repo.objects);
    } catch (err) {
      unpackOk = false;
      unpackDetail = `unpack error: ${err instanceof Error ? err.message : 'invalid pack'}`;
    }
  }

  const reports: RefReport[] = [];
  if (!unpackOk) {
    for (const cmd of commands) reports.push({ ref: cmd.ref, ok: false, reason: 'unpack failed' });
  } else {
    // This server always advertises delete-refs, so a matching delete is always permitted
    // (git clients do not repeat server capabilities in the push command list).
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      if (cmd.newOid === ZERO) {
        // Delete: the ref must exist and match the advertised oid.
        if (!current || current !== cmd.oldOid) {
          reports.push({ ref: cmd.ref, ok: false, reason: 'fetch-first' });
        } else {
          repo.refs.delete(cmd.ref);
          repo.branches.delete(cmd.ref);
          reports.push({ ref: cmd.ref, ok: true, reason: '' });
        }
        continue;
      }
      // Create or update: the new tip must be an object we now hold.
      if (!repo.objects.has(cmd.newOid)) {
        reports.push({ ref: cmd.ref, ok: false, reason: 'missing new object' });
        continue;
      }
      if (!current || current === ZERO) {
        if (cmd.oldOid !== ZERO && cmd.oldOid !== current) {
          reports.push({ ref: cmd.ref, ok: false, reason: 'fetch-first' });
          continue;
        }
        repo.refs.set(cmd.ref, cmd.newOid);
        if (cmd.ref.startsWith('refs/heads/')) repo.branches.set(cmd.ref.slice('refs/heads/'.length), cmd.newOid);
        reports.push({ ref: cmd.ref, ok: true, reason: '' });
        continue;
      }
      if (current !== cmd.oldOid) {
        reports.push({ ref: cmd.ref, ok: false, reason: 'fetch-first' });
        continue;
      }
      if (isAncestor(current, cmd.newOid, repo.objects)) {
        repo.refs.set(cmd.ref, cmd.newOid);
        if (cmd.ref.startsWith('refs/heads/')) repo.branches.set(cmd.ref.slice('refs/heads/'.length), cmd.newOid);
        repo.updated_at = repo.updated_at; // no wall clock: keep state deterministic
        reports.push({ ref: cmd.ref, ok: true, reason: '' });
      } else {
        reports.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      }
    }
  }

  const inner: Buffer[] = [pkt(`unpack ${unpackDetail}\n`)];
  for (const report of reports) {
    inner.push(pkt(report.ok ? `ok ${report.ref}\n` : `ng ${report.ref} ${report.reason}\n`));
  }
  inner.push(FLUSH);
  const body = Buffer.concat(inner);
  if (caps.has('side-band-64k')) {
    return Buffer.concat(sidebandChunks(body));
  }
  return body;
}

// ---------------------------------------------------------------- request routing

function wantsV2(req: IncomingMessage): boolean {
  const header = req.headers['git-protocol'];
  const text = Array.isArray(header) ? header.join(',') : (header ?? '');
  return /(^|[,\s])version=2([,\s]|$)/.test(text);
}

function parsePushCommands(items: readonly PktItem[]): { commands: PushCommand[]; caps: Map<string, string> } {
  const commands: PushCommand[] = [];
  const caps = new Map<string, string>();
  for (let index = 0; index < items.length; index += 1) {
    if (items[index]!.kind !== 'data') continue;
    const raw = items[index]!.payload.toString('utf8').replace(/\n$/, '');
    const nul = raw.indexOf('\u0000');
    const body = nul < 0 ? raw : raw.slice(0, nul);
    if (nul >= 0 && index === items.findIndex((it) => it.kind === 'data')) {
      for (const [k, v] of parseCapString(raw.slice(nul + 1))) caps.set(k, v);
    }
    const parts = body.split(' ');
    if (parts.length < 3) continue;
    const [oldOid, newOid, ...refParts] = parts;
    const ref = refParts.join(' ').trim();
    if (!HEX40.test(oldOid!) || !HEX40.test(newOid!) || !ref.startsWith('refs/')) continue;
    commands.push({ oldOid: oldOid!, newOid: newOid!, ref });
  }
  return { commands, caps };
}

/** Handle one git smart-HTTP request. Returns true when this request belonged to the git surface. */
export async function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
): Promise<boolean> {
  const match = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (!match) return false;
  const owner = decodeURIComponent(match[1]!);
  const name = decodeURIComponent(match[2]!);
  const endpoint = match[3]!;
  const repo = findRepo(owner, name);

  if (endpoint === 'info/refs') {
    if (method !== 'GET') {
      sendRaw(res, 405, 'Method Not Allowed\n', 'text/plain');
      return true;
    }
    if (!repo) {
      sendRaw(res, 404, 'Repository not found\n', 'text/plain');
      return true;
    }
    const service = new URL(req.url ?? '/', 'http://entry').searchParams.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendRaw(res, 404, 'Unknown service\n', 'text/plain');
      return true;
    }
    const v2 = service === 'git-upload-pack' && wantsV2(req);
    const body = v2 ? v2Advertisement() : v0Advertisement(repo, service);
    sendRaw(res, 200, body, `application/x-${service}-advertisement`, { 'cache-control': 'no-cache' });
    return true;
  }

  const service = endpoint as 'git-upload-pack' | 'git-receive-pack';
  if (method !== 'POST') {
    sendRaw(res, 405, 'Method Not Allowed\n', 'text/plain');
    return true;
  }
  if (!repo) {
    sendRaw(res, 404, 'Repository not found\n', 'text/plain');
    return true;
  }

  let body: Buffer;
  try {
    body = await readBody(req);
  } catch {
    sendRaw(res, 200, pkt('NAK\n'), `application/x-${service}-result`);
    return true;
  }

  const { items, rest } = parsePackets(body);
  const hasData = items.some((it) => it.kind === 'data');

  try {
    if (service === 'git-receive-pack') {
      if (!hasData) {
        sendRaw(res, 200, Buffer.concat([pkt('unpack ok\n'), FLUSH]), 'application/x-git-receive-pack-result');
        return true;
      }
      const { commands, caps } = parsePushCommands(items);
      const result = processPush(repo, commands, rest.length ? rest : null, caps);
      sendRaw(res, 200, result, 'application/x-git-receive-pack-result');
      return true;
    }

    // upload-pack POST: v2 (ls-refs / fetch) or v0 fetch.
    const lines = dataLines(items);
    const command = lines.find((line) => line.startsWith('command=')) ?? '';
    if (!hasData) {
      // A malformed request (no pkt-line at all): answer harmlessly and stay up.
      sendRaw(res, 200, pkt('NAK\n'), 'application/x-git-upload-pack-result');
      return true;
    }
    if (wantsV2(req) && command === 'command=ls-refs') {
      sendRaw(res, 200, lsRefs(repo, lines), 'application/x-git-upload-pack-result');
      return true;
    }
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    let depth: number | undefined;
    for (const line of lines) {
      if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]!);
      else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) {
        const n = Number(line.slice(7).trim());
        if (Number.isFinite(n) && n > 0) depth = n;
      }
    }
    if (!wants.length) {
      sendRaw(res, 200, pkt('NAK\n'), 'application/x-git-upload-pack-result');
      return true;
    }
    const plan = planPack(repo, wants, haves, depth, shallow);
    const pack = buildPack(plan.objects);
    const result = wantsV2(req) ? fetchResponseV2(plan, pack) : fetchResponseV0(plan, pack);
    sendRaw(res, 200, result, 'application/x-git-upload-pack-result');
    return true;
  } catch (err) {
    // A bad pack or malformed command must never take the server down.
    const text = err instanceof Error ? err.message : 'error';
    const result = pkt(`ERR ${text}\n`);
    sendRaw(res, 200, result, `application/x-${service}-result`);
    return true;
  }
}
