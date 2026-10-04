import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E_PORT } from '../playwright.config.ts';
import { startDemo } from './harness.ts';

const ROOT = join(import.meta.dirname, '..');
export const STATE_FILE = join(ROOT, '.e2e-tmp', 'state.json');

export default async function globalSetup() {
  if (!process.env.E2E_SKIP_BUILD || !existsSync(join(ROOT, 'packages/cli/dist/ui/index.html'))) {
    execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
  }
  const dir = join(ROOT, '.e2e-tmp', 'world');
  const demo = await startDemo({ dir, port: E2E_PORT, aoePort: E2E_PORT + 1 });
  mkdirSync(join(ROOT, '.e2e-tmp'), { recursive: true });
  writeFileSync(
    STATE_FILE,
    JSON.stringify({ env: demo.env, port: demo.port, aoeUrl: demo.fake.url, home: dir }),
  );
  return async () => {
    await demo.stop();
  };
}
