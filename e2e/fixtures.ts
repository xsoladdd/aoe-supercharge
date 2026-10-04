import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test as base, type Page } from '@playwright/test';

const ROOT = join(import.meta.dirname, '..');
const CLI = join(ROOT, 'packages/cli/dist/supercharge.mjs');

export interface World {
  env: NodeJS.ProcessEnv;
  port: number;
  aoeUrl: string;
  home: string;
}

export function world(): World {
  return JSON.parse(readFileSync(join(ROOT, '.e2e-tmp', 'state.json'), 'utf8')) as World;
}

/** Sign in exactly like a user: `supercharge open --print` gives a one-time nonce URL. */
export async function signIn(page: Page): Promise<void> {
  const w = world();
  const url = execFileSync(process.execPath, [CLI, 'open', '--print'], {
    env: w.env,
    cwd: w.home,
    encoding: 'utf8',
  }).trim();
  await page.goto(new URL(url).pathname + new URL(url).search);
  await expect(page.getByRole('heading', { name: 'Needs you' })).toBeVisible();
}

export async function fake(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${world().aoeUrl}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json' },
  });
  return res.json();
}

export async function axe(page: Page, label: string) {
  await page.waitForTimeout(300);
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    serious.map(
      (v) =>
        `${v.id}: ${v.help} (${v.nodes.length}) ${v.nodes
          .slice(0, 3)
          .map((n) => n.target.join(' '))
          .join(' | ')} :: ${v.nodes[0]?.failureSummary?.replace(/\s+/g, ' ') ?? ''}`,
    ),
    `axe on ${label}`,
  ).toEqual([]);
}

export const test = base.extend<{ signedIn: Page }>({
  signedIn: async ({ page }, use) => {
    await signIn(page);
    await use(page);
  },
});

export { expect };
