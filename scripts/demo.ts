/**
 * `npm run demo`: a self-contained Supercharge with a fake AoE and realistic projects, so the full
 * dashboard can be explored without touching your real AoE. Nothing outside the temp dir is changed.
 * `--live` keeps the workers busy (see demo-life.ts), so statuses change while you watch.
 */
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDemo } from '../e2e/harness.ts';
import { startLife } from './demo-life.ts';

const port = Number(process.env.DEMO_PORT ?? 4391);

/** Whether nothing listens on 127.0.0.1:port yet. */
const free = (p: number) =>
  new Promise<boolean>((resolve) => {
    const probe = createServer()
      .once('error', () => resolve(false))
      .once('listening', () => probe.close(() => resolve(true)))
      .listen(p, '127.0.0.1');
  });
// Checked before anything else: starting wipes the demo folder, which would pull a running demo's data away.
for (const p of [port, port + 1]) {
  if (await free(p)) continue;
  process.stderr.write(
    `\nPort ${p} is in use, most likely by a demo that is already running: open http://supercharge.localhost:${port}\n` +
      `Stop that one first, or start another on other ports: DEMO_PORT=${port + 10} npm run demo -- --live\n\n`,
  );
  process.exit(1);
}
// One folder per port, so a second demo never wipes the first one's.
const dir = join(tmpdir(), port === 4391 ? 'supercharge-demo' : `supercharge-demo-${port}`);
const demo = await startDemo({ dir, port, aoePort: port + 1 });
process.stdout.write(`\nSupercharge demo running on ${demo.baseUrl}\n`);
process.stdout.write(`Sign in (one-time link, valid 60s):\n  ${await demo.signInUrl()}\n`);
process.stdout.write(
  'Open it signed in any time (from this folder, in another terminal): npm run demo:open\n\n',
);
const stopLife = process.argv.includes('--live') ? startLife(demo) : () => {};
const stop = async () => {
  stopLife();
  await demo.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
