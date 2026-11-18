import { createApp } from './app.ts';

const origin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (origin === '') {
  process.stderr.write('MAKEFUN_ENV_URL is missing; no env to register with\n');
  process.exit(1);
}

const nap = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

async function tellPort(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const answer = await fetch(`${origin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(30_000),
      });
      if (answer.ok || answer.status === 409) return;
    } catch {
      // The env may still be booting; try again.
    }
    await nap(Math.min(2000, 250 * 2 ** Math.min(attempt, 8)));
  }
}

async function waitUntilFinished(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const answer = await fetch(`${origin}/done`, { signal: AbortSignal.timeout(30_000) });
      if (answer.ok) {
        const body = (await answer.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Not finished yet.
    }
    await nap(Math.min(2000, 250 * 2 ** Math.min(attempt, 8)));
  }
}

async function boot(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server did not bind a TCP port');
  await tellPort(address.port);
  await waitUntilFinished();
  server.close();
}

try {
  await boot();
  process.exit(0);
} catch (error) {
  process.stderr.write(`[entry] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
