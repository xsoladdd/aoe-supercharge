/**
 * `npm run demo`: a self-contained Supercharge with a fake AoE and realistic projects, so the full
 * dashboard can be explored without touching your real AoE. Nothing outside the temp dir is changed.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDemo } from '../e2e/harness.ts';

const port = Number(process.env.DEMO_PORT ?? 4391);
const demo = await startDemo({ dir: join(tmpdir(), 'supercharge-demo'), port, aoePort: port + 1 });
process.stdout.write(`\nSupercharge demo running on ${demo.baseUrl}\n`);
process.stdout.write(`Sign in (one-time link, valid 60s):\n  ${await demo.signInUrl()}\n`);
process.stdout.write(
  `New link any time: HOME=${demo.dir} XDG_CONFIG_HOME=${demo.dir}/.config node packages/cli/dist/supercharge.mjs open --print\n\n`,
);
const stop = async () => {
  await demo.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
