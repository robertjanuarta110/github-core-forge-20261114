import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { pathOf, sendJson } from './http.ts';
import { handleGit } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const path = pathOf(req);
      const method = req.method ?? 'GET';
      try {
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }
        if (await handleGit(req, res, path, method)) return;
        if (await handleGraphql(req, res, path, method)) return;
        if (await handleMcp(req, res, path, method)) return;
        if (await handleRest(req, res, path, method)) return;
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        if (!res.headersSent) sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal error' });
        else res.end();
      }
    })();
  });
}
