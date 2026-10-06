/**
 * `npm run demo:open`: opens the running demo in your browser, signed in. The demo's daemon only takes
 * its own one-time links, which `supercharge open` makes from the demo folder's config (so the installed
 * `supercharge open` would sign you in to your real dashboard instead).
 */
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const port = Number(process.env.DEMO_PORT ?? 4391);
const dir = join(tmpdir(), port === 4391 ? 'supercharge-demo' : `supercharge-demo-${port}`);
const cli = join(import.meta.dirname, '..', 'packages/cli/dist/supercharge.mjs');
const r = spawnSync(process.execPath, [cli, 'open', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: {
    ...process.env,
    HOME: dir,
    XDG_CONFIG_HOME: join(dir, '.config'),
    XDG_DATA_HOME: join(dir, '.local/share'),
    XDG_STATE_HOME: join(dir, '.local/state'),
  },
});
if (r.status) process.stderr.write(`\nIs the demo running? Start it with: npm run demo -- --live\n`);
process.exit(r.status ?? 1);
