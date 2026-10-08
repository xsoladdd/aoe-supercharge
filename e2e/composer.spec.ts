import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { axe, expect, fake, test, world } from './fixtures.ts';

/** A fresh AoE session of its own, so these tests change nothing the others look at. */
async function newSession(title: string, status: 'Running' | 'Idle'): Promise<string> {
  const s = (await fake('/__fake/sessions', {
    method: 'POST',
    body: JSON.stringify({ title, project_path: join(world().home, 'code', 'composer'), status }),
  })) as { id: string };
  return s.id;
}
const removeSession = (id: string) => fake(`/__fake/sessions/${id}`, { method: 'DELETE' });
const setStatus = (id: string, status: string) =>
  fake(`/__fake/sessions/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
const sentTo = async (id: string) =>
  ((await fake('/__fake/state')) as { sent: { id: string; message: string }[] }).sent
    .filter((m) => m.id === id)
    .map((m) => m.message);

async function openChat(page: Page, id: string, title: string) {
  await page.goto(`/chat/${id}`);
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible({ timeout: 15_000 });
}

test.describe('chat composer', () => {
  test('while Claude works, Send holds the message: it survives a reload, can be edited or cancelled, and goes once Claude is done', async ({
    signedIn: page,
    browserName,
  }) => {
    const title = `held ${browserName}`;
    const id = await newSession(title, 'Running');
    try {
      await openChat(page, id, title);
      const box = page.getByLabel(/^Message /);
      const message = `Use the staging database (${browserName})`;
      await box.fill(message);
      await expect(page.getByRole('button', { name: 'Send when Claude is done' })).toBeVisible();
      await box.press('Enter');
      const held = page.getByRole('list', { name: 'Held messages' });
      await expect(held.getByText(message)).toBeVisible();
      await expect(held.getByText('Held. Sends when Claude is done')).toBeVisible();
      await expect(box).toHaveValue('');
      expect(await sentTo(id)).not.toContain(message);
      await axe(page, 'held message');

      await page.reload();
      await expect(held.getByText(message)).toBeVisible({ timeout: 15_000 });

      // Cancel, and Undo brings it back.
      await held.getByRole('button', { name: 'Cancel this held message' }).click();
      await expect(held).toHaveCount(0);
      await page.getByRole('button', { name: 'Undo' }).click();
      await expect(held.getByText(message)).toBeVisible();

      // Edit takes it back into the box; sent again, it is held again.
      await held.getByRole('button', { name: 'Edit this held message' }).click();
      await expect(box).toHaveValue(message);
      await expect(held).toHaveCount(0);
      await box.fill(`${message}, not production`);
      await box.press('Enter');
      await expect(held.getByText(`${message}, not production`)).toBeVisible();

      await setStatus(id, 'Idle');
      await expect.poll(() => sentTo(id), { timeout: 20_000 }).toContain(`${message}, not production`);
      await expect(held).toHaveCount(0, { timeout: 15_000 });
      expect((await sentTo(id)).filter((m) => m.startsWith(message))).toHaveLength(1);
    } finally {
      await removeSession(id);
    }
  });

  test('the menu beside Send sends now, or stops Claude first', async ({ signedIn: page, browserName }) => {
    const title = `menu ${browserName}`;
    const id = await newSession(title, 'Running');
    try {
      await openChat(page, id, title);
      const box = page.getByLabel(/^Message /);
      await box.fill(`Also check the footer (${browserName})`);
      await page.getByRole('button', { name: 'More ways to send' }).click();
      await axe(page, 'send menu');
      await page.getByRole('menuitem', { name: /Send now/ }).click();
      await expect.poll(() => sentTo(id)).toContain(`Also check the footer (${browserName})`);
      await expect(box).toHaveValue('');
      // Gone, not just closing: a click on the caret while the menu still fades out leaves it shut.
      await expect(page.getByRole('menu')).toHaveCount(0);

      const keysBefore = ((await fake('/__fake/state')) as { keys: unknown[] }).keys.length;
      await box.fill(`Stop: wrong file (${browserName})`);
      await page.getByRole('button', { name: 'More ways to send' }).click();
      await page.getByRole('menuitem', { name: /Interrupt and send/ }).click();
      await expect.poll(() => sentTo(id), { timeout: 15_000 }).toContain(`Stop: wrong file (${browserName})`);
      const keys = ((await fake('/__fake/state')) as { keys: { id: string; hex: string }[] }).keys.slice(
        keysBefore,
      );
      expect(keys.filter((k) => k.id === id).map((k) => k.hex)).toEqual(['1b']);
      // With Claude idle there is nothing to hold, so no menu.
      await expect(page.getByRole('button', { name: 'More ways to send' })).toHaveCount(0, {
        timeout: 15_000,
      });
    } finally {
      await removeSession(id);
    }
  });

  test('a draft, text and attachment, outlives switching chats and a reload, and goes once sent', async ({
    signedIn: page,
    browserName,
  }) => {
    const a = await newSession(`draft a ${browserName}`, 'Idle');
    const b = await newSession(`draft b ${browserName}`, 'Idle');
    try {
      await openChat(page, a, `draft a ${browserName}`);
      const box = page.getByLabel(/^Message /);
      await box.fill(`Half a thought (${browserName})`);
      await page
        .locator('input[type="file"]')
        .setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('some notes') });
      const chips = page.getByRole('list', { name: 'Attachments' });
      await expect(chips.getByText('notes.txt', { exact: true })).toBeVisible();
      await expect(chips.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 15_000 });

      // Another chat, in the app: its box is its own.
      await page.evaluate((to) => {
        history.pushState(null, '', to);
        dispatchEvent(new PopStateEvent('popstate'));
      }, `/chat/${b}`);
      await expect(page.getByRole('heading', { level: 1, name: `draft b ${browserName}` })).toBeVisible();
      await expect(box).toHaveValue('');
      await page.goBack();
      await expect(page.getByRole('heading', { level: 1, name: `draft a ${browserName}` })).toBeVisible();
      await expect(box).toHaveValue(`Half a thought (${browserName})`);
      await expect(chips.getByText('notes.txt', { exact: true })).toBeVisible();

      await page.reload();
      await expect(box).toHaveValue(`Half a thought (${browserName})`, { timeout: 15_000 });
      await expect(chips.getByText('notes.txt', { exact: true })).toBeVisible();

      await box.press('Enter');
      await expect
        .poll(async () => (await sentTo(a)).at(-1) ?? '', { timeout: 15_000 })
        .toMatch(
          new RegExp(
            `^Half a thought \\(${browserName}\\)\\n\\nAttached: /\\S+/uploads/${a}/\\S+-notes\\.txt$`,
          ),
        );
      await expect(box).toHaveValue('');
      await expect(chips).toHaveCount(0);
      await page.reload();
      await expect(page.getByRole('heading', { level: 1, name: `draft a ${browserName}` })).toBeVisible();
      await expect(box).toHaveValue('');
    } finally {
      await removeSession(a);
      await removeSession(b);
    }
  });

  test("the context ring opens the figures behind it, Claude Code's own once its status line reports", async ({
    signedIn: page,
    browserName,
  }) => {
    const title = `context ${browserName}`;
    const id = await newSession(title, 'Idle');
    try {
      await openChat(page, id, title);
      const box = page.getByLabel(/^Message /);
      await box.fill('How full is the context?');
      await box.press('Enter');
      const meter = page.getByRole('button', { name: /^Context: \d+% of the window used/ });
      await expect(meter).toBeVisible({ timeout: 15_000 });
      await meter.click();
      const details = page.getByRole('dialog', { name: 'Context details' });
      await expect(details.getByText('Estimated from the transcript.')).toBeVisible();
      await expect(details.getByText('Last request')).toBeVisible();
      await expect(details.getByText("Claude Code's own setting", { exact: false })).toBeVisible();
      await axe(page, 'context popover');
      await page.keyboard.press('Escape');
      await expect(details).toHaveCount(0);

      // Claude Code's status line reports the real window for this conversation.
      const claudeId = ((await fake(`/__fake/agent/${id}`)) as { agent_session_id: string }).agent_session_id;
      const env = world().env;
      const dir = join(env.XDG_STATE_HOME ?? join(env.HOME!, '.local/state'), 'supercharge', 'context');
      mkdirSync(dir, { recursive: true });
      const model = await page.evaluate(
        async (sid) => ((await (await fetch(`/api/sessions/${sid}/chat`)).json()) as { model: string }).model,
        id,
      );
      writeFileSync(
        join(dir, `${claudeId}.json`),
        JSON.stringify({
          sessionId: claudeId,
          at: new Date().toISOString(),
          model: { id: `${model}[1m]`, name: 'Opus 5.5 (1M)' },
          window: 1_000_000,
          used: 412_000,
          percent: 41,
          current: { input: 12, cacheWrite: 2_000, cacheRead: 409_988, output: 800 },
        }),
      );
      await expect(page.getByRole('button', { name: /^Context: 41% of the window used/ })).toBeVisible({
        timeout: 15_000,
      });
      await page.getByRole('button', { name: /^Context: 41%/ }).click();
      await expect(details).toContainText('412k of 1M tokens');
      await expect(details).toContainText(/From Claude Code/);
      await expect(details).toContainText('Opus 5.5 (1M)');
      await expect(details).toContainText('409,988');
    } finally {
      await removeSession(id);
    }
  });

  test('what needs you stands out: report sections, watch notices and errors take a shade of their colour', async ({
    signedIn: page,
    browserName,
  }) => {
    const title = `report ${browserName}`;
    const id = await newSession(title, 'Idle');
    try {
      await openChat(page, id, title);
      await fake(`/__fake/sessions/${id}/reply`, {
        method: 'POST',
        body: JSON.stringify({
          text: [
            'Here is where things stand.',
            '',
            '🔴 NEEDS YOU',
            '',
            '1. Aldric (AS-0018): wants to push to main. Blocked.',
            '',
            '🟡 WORKING',
            '',
            '- Gisela (AS-0022): implementing.',
            '',
            '✅ DONE',
            '',
            '- Oliver (AS-0023): PR raised.',
          ].join('\n'),
        }),
      });
      const log = page.getByRole('log', { name: /^Conversation with/ });
      const needs = log.locator('[data-attention="needs"]');
      await expect(needs).toContainText('Aldric', { timeout: 15_000 });
      await expect(needs.locator('[data-attention-blocked]')).toHaveText('Blocked');
      await expect(log.locator('[data-attention="working"]')).toContainText('Gisela');
      await expect(log.locator('[data-attention="done"]')).toContainText('Oliver');
      const tinted = await needs.evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(tinted).not.toBe('rgba(0, 0, 0, 0)');
      await axe(page, 'attention colours, dark');
      await page.evaluate(() => {
        document.documentElement.classList.remove('dark');
        document.documentElement.style.colorScheme = 'light';
      });
      await axe(page, 'attention colours, light');
    } finally {
      await removeSession(id);
    }
  });
});
