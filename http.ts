// Shared HTTP helpers for the forge. No dependencies beyond node stdlib.
import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

export function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

export function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': 'req-0000000000000000000000000000001',
    'x-ratelimit-limit': '5000',
    'x-ratelimit-remaining': '4999',
    'x-ratelimit-reset': '1735689600',
    ...headers,
  });
  res.end(text);
}

export function sendRaw(res: ServerResponse, status: number, body: Buffer | string, contentType: string, headers: Record<string, string> = {}): void {
  const buf = typeof body === 'string' ? Buffer.from(body) : body;
  res.writeHead(status, { 'content-type': contentType, 'content-length': buf.length, ...headers });
  res.end(buf);
}

export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer | string) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJson(req: IncomingMessage): Promise<any> {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  return JSON.parse(raw.toString('utf8'));
}

export function authorized(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ') || header.slice(7).trim() === '') return false;
  if (expected === undefined || expected === '') return true;
  return header.slice(7).trim() === expected;
}
