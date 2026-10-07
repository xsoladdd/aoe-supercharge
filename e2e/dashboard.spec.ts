import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PERMISSION_MENU } from '../packages/fake-aoe/src/server.ts';
import type { Locator, Page } from '@playwright/test';
import { axe, expect, fake, test, world } from './fixtures.ts';

/** The fake AoE id of the session whose title starts with `prefix`. */
async function sessionId(prefix: string): Promise<string> {
  const state = (await fake('/__fake/state')) as { sessions: { id: string; title: string }[] };
  return state.sessions.find((s) => s.title.startsWith(prefix))!.id;
}

/** Everything in the dialog (and the dialog itself) sits inside its box: nothing spills out or scrolls sideways. */
async function expectContained(page: Page, dialog: Locator) {
  const box = (await dialog.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  const parts = dialog.locator('pre, ul, [data-slot="alert-dialog-footer"], button');
  const count = await parts.count();
  expect(count).toBeGreaterThan(2);
  for (let i = 0; i < count; i++) {
    const part = (await parts.nth(i).boundingBox())!;
    expect(part.x, `part ${i} left`).toBeGreaterThanOrEqual(box.x - 0.5);
    expect(part.x + part.width, `part ${i} right`).toBeLessThanOrEqual(box.x + box.width + 0.5);
  }
  const overflow = await dialog.evaluate(
    (el) =>
      [el, ...el.querySelectorAll('pre, ul, [data-slot="alert-dialog-footer"]')].filter(
        (e) => e.scrollWidth > e.clientWidth,
      ).length,
  );
  expect(overflow).toBe(0);
}

test.describe('auth', () => {
  test('without the cookie the dashboard shows the sign-in instructions', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Sign in from your terminal' })).toBeVisible();
    // The test daemon is a demo, so it names the demo's own sign-in command.
    await expect(page.getByText('npm run demo:open')).toBeVisible();
  });

  test('a used sign-in link is rejected', async ({ page, request }) => {
    const { signIn } = await import('./fixtures.ts');
    await signIn(page);
    // The nonce was consumed by signIn; replaying any nonce fails.
    const res = await request.get('/auth/callback?nonce=deadbeef', { maxRedirects: 0 });
    expect(res.status()).toBe(401);
  });
});

test.describe('overview', () => {
  test('lists projects, Needs you and unmanaged AoE sessions', async ({ signedIn: page }) => {
    await expect(page.getByRole('link', { name: /northwind-web/ }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: /apollo-api/ }).first()).toBeVisible();
    const needs = page.locator('section[aria-labelledby="needs-you-heading"]');
    await expect(needs.getByText('Question', { exact: true })).toBeVisible();
    await expect(needs.getByText('Waiting in AoE', { exact: true })).toBeVisible();
    await expect(needs.getByText('Control chat replied', { exact: true }).first()).toBeVisible();
    // Two: NW-0004's MR, and AA-0003's branch, ready to merge without an MR.
    await expect(needs.getByText('Ready for review', { exact: true })).toHaveCount(2, { timeout: 20_000 });
    await expect(needs.getByText(/Branch ready to merge: sc\/aa-0003-/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Other AoE sessions' })).toBeVisible();
    await expect(page.getByText('ops control', { exact: true }).last()).toBeVisible();
    await expect(page.getByText('flaky e2e triage')).toBeVisible();
    await axe(page, 'overview');
  });

  test('"Control chat replied" can be dismissed until the control chat replies again', async ({
    signedIn: page,
  }) => {
    const needs = page.locator('section[aria-labelledby="needs-you-heading"]');
    const replied = needs.locator('li', { hasText: 'northwind-web control chat' }).filter({
      hasText: 'Control chat replied',
    });
    await expect(replied).toHaveCount(1);
    // Only that kind can be dismissed.
    await expect(needs.locator('[data-dismiss^="control_replied:"]')).toHaveCount(
      await needs.locator('li', { hasText: 'Control chat replied' }).count(),
    );
    await replied.getByRole('button', { name: /^Dismiss: northwind-web control chat/ }).click();
    await expect(replied).toHaveCount(0);
    // It stays dismissed after a reload: the daemon keeps it.
    await page.reload();
    await expect(needs.getByText('Question', { exact: true })).toBeVisible();
    await expect(replied).toHaveCount(0);
    // Only "Control chat replied" can be dismissed.
    const res = await page.evaluate(async () => {
      const { token } = (await (await fetch('/api/csrf')).json()) as { token: string };
      const items = (await (await fetch('/api/snapshot')).json()).needsYou as { id: string; kind: string }[];
      const other = items.find((i) => i.kind !== 'control_replied')!;
      const r = await fetch('/api/needs-you/dismiss', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': token },
        body: JSON.stringify({ id: other.id }),
      });
      return r.status;
    });
    expect(res).toBe(400);
    // A newer reply brings it back.
    const control = await sessionId('northwind-web control');
    await fake(`/__fake/sessions/${control}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'Running' }),
    });
    await page.waitForTimeout(2_500);
    await fake(`/__fake/sessions/${control}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'Idle', unread: true }),
    });
    await expect(replied).toHaveCount(1, { timeout: 15_000 });
  });

  test('opening an unmanaged session opens its chat, with the terminal one click away', async ({
    signedIn: page,
  }) => {
    await page.getByRole('link', { name: /flaky e2e triage/ }).click();
    await expect(page).toHaveURL(/\/chat\/[0-9a-f]{16}$/);
    await expect(page.getByRole('heading', { level: 1, name: 'flaky e2e triage' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Start the conversation' })).toBeVisible();
    await page.getByRole('link', { name: 'Terminal' }).click();
    await expect(page).toHaveURL(/\?view=terminal$/);
    await expect(page.getByRole('log', { name: 'Session conversation' })).toContainText(
      'Claude Code (fake agent)',
    );
    await page.getByText('Attach in a terminal instead').click();
    await expect(page.getByText(/aoe session attach [0-9a-f]{16}/)).toBeVisible();
  });

  test('the sidebar shows your 5-hour and weekly usage and how many workers may run', async ({
    signedIn: page,
  }) => {
    const usage = page.getByRole('region', { name: 'Claude usage' });
    await expect(usage.getByRole('meter', { name: '5-hour usage' })).toHaveAttribute('aria-valuenow', '38');
    await expect(usage.getByRole('meter', { name: 'Week usage' })).toHaveAttribute('aria-valuenow', '22');
    await expect(usage).toContainText(/\d+ of 4 workers active/);
    await expect(usage).toContainText(/5-hour resets \d{1,2}:\d{2}/);
  });

  test('Start fresh clears a conversation with /clear after saying what is kept', async ({
    signedIn: page,
  }) => {
    await page.goto(`/chat/${await sessionId('flaky e2e triage')}`);
    await page.getByRole('button', { name: 'More session actions' }).click();
    await page.getByRole('menuitem', { name: 'Start fresh (/clear)…' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Start a fresh conversation?' });
    await expect(dialog).toContainText('types /clear into this session');
    await expect(dialog).toContainText('not part of a Supercharge project');
    await axe(page, 'start-fresh');
    await dialog.getByRole('button', { name: 'Clear conversation' }).click();
    await expect(page.getByText('Started a fresh conversation')).toBeVisible();
    const state = (await fake('/__fake/state')) as { sent: { message: string }[] };
    expect(state.sent.some((s) => s.message === '/clear')).toBe(true);
  });

  test('typing / suggests commands and skills; Tab completes', async ({ signedIn: page }) => {
    await page.goto(`/chat/${await sessionId('flaky e2e triage')}`);
    const box = page.getByLabel(/^Message /);
    await box.fill('/comp');
    const list = page.getByRole('listbox', { name: 'Commands and skills' });
    await expect(list.getByRole('option', { name: /^\/compact/ })).toBeVisible();
    await expect(box).toHaveAttribute('aria-activedescendant', 'slash-opt-0');
    await axe(page, 'slash menu');
    await box.press('Tab');
    await expect(box).toHaveValue('/compact ');
    await expect(list).toHaveCount(0);
    await box.fill('/zzzz-nothing');
    await expect(list).toHaveCount(0);
    await box.fill('');
  });

  test('old ?session= links still land on the chat', async ({ signedIn: page }) => {
    const id = await sessionId('flaky e2e triage');
    await page.goto(`/?session=${id}`);
    await expect(page).toHaveURL(new RegExp(`/chat/${id}$`));
  });
});

test.describe('project', () => {
  test('control box rollup and worker list', async ({ signedIn: page }) => {
    await page.goto('/p/northwind-web');
    const control = page.locator('section[aria-labelledby="control-heading"]');
    await expect(control.getByText('Remote Control on')).toBeVisible();
    await expect(control.getByText(/1 of 6 tasks done/)).toBeVisible();
    await expect(control.getByText("Is the client's copy deck from Friday final")).toBeVisible();
    const workers = page.getByRole('list', { name: 'Workers' });
    await expect(workers.getByRole('link', { name: /NW-0002/ })).toBeVisible();
    await expect(workers.getByText('Blocked', { exact: true })).toBeVisible();
    await expect(workers.getByText('Pipeline running', { exact: true })).toBeVisible();
    await expect(workers.getByText('2 open threads')).toBeVisible();
    await axe(page, 'project');
  });

  test('done tasks are hidden until toggled', async ({ signedIn: page }) => {
    await page.goto('/p/northwind-web');
    const workers = page.getByRole('list', { name: 'Workers' });
    await expect(workers.getByText('DNS cutover runbook')).toHaveCount(0);
    await page.getByRole('switch', { name: 'Show done tasks' }).click();
    await expect(workers.getByText('DNS cutover runbook')).toBeVisible();
  });

  test('task page: overview by default, then plan and chat tabs', async ({ signedIn: page }) => {
    await page.goto('/p/northwind-web');
    await page
      .getByRole('list', { name: 'Workers' })
      .getByRole('link', { name: /NW-0001/ })
      .click();
    await expect(page).toHaveURL(/\/p\/northwind-web\/t\/NW-0001$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Build page templates' })).toBeVisible();
    const tabs = page.getByRole('navigation', { name: 'Task' });
    await expect(tabs.getByRole('link', { name: /Overview/ })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByText('Header, listing and detail templates')).toBeVisible();
    await expect(page.getByText('Watching MR', { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/aoe session attach/)).toBeVisible();
    const details = page.getByRole('complementary', { name: 'Task details' });
    await expect(details.getByText('Started on')).toBeVisible();
    // Started without --model in plan mode: it plans with Opus and builds with Sonnet.
    await expect(details.getByText('Opus to plan, then Sonnet once the plan is approved')).toBeVisible();
    await axe(page, 'task overview');
    await tabs.getByRole('link', { name: 'Plan' }).click();
    await expect(page).toHaveURL(/\/t\/NW-0001\/plan$/);
    await expect(page.getByRole('heading', { name: 'Plan: page templates' })).toBeVisible();
    await expect(page.getByText('Storybook stories and visual tests')).toBeVisible();
    await tabs.getByRole('link', { name: 'Chat' }).click();
    await expect(page).toHaveURL(/\/t\/NW-0001\/chat$/);
    await expect(page.getByLabel(/^Message /)).toBeVisible();
  });

  test('the sidebar shows a waiting worker’s icon whole', async ({ signedIn: page }) => {
    await page.goto('/p/northwind-web');
    const row = page.locator('[data-sidebar="menu-sub-button"]', { hasText: 'Build page templates' });
    const icon = row.locator('[aria-label="Waiting on you"] svg');
    const [r, i] = [await row.boundingBox(), await icon.boundingBox()];
    expect(i!.width).toBeGreaterThanOrEqual(15);
    expect(i!.x + i!.width).toBeLessThanOrEqual(r!.x + r!.width);
  });

  test('a plan waiting for approval shows with the plan and its options', async ({ signedIn: page }) => {
    const needs = page.locator('section[aria-labelledby="needs-you-heading"]');
    await needs.getByRole('link', { name: /Plan to approve/ }).click();
    await expect(page).toHaveURL(/\/p\/apollo-api\/t\/AA-0002$/);
    const card = page.locator('section', {
      has: page.getByRole('heading', { name: 'Plan ready for your approval' }),
    });
    await expect(card.getByRole('heading', { name: 'Upgrade to Node 24' })).toBeVisible();
    const options = card.getByRole('radiogroup');
    await expect(options.getByText('Yes, manually approve edits')).toBeVisible();
    await expect(options.getByText('Tell Claude what to change')).toBeVisible();
    await options.getByText('Tell Claude what to change').click();
    await expect(card.getByLabel(/What should Claude do instead/)).toBeVisible();
    await axe(page, 'plan approval');
    // The chat shows the same card in place of the message box.
    await page.getByRole('navigation', { name: 'Task' }).getByRole('link', { name: 'Chat' }).click();
    await expect(page.getByRole('heading', { name: 'Plan ready for your approval' })).toBeVisible();
    await expect(page.getByLabel(/^Message /)).toHaveCount(0);
  });

  test('sessions the control chat started through AoE are listed with its project', async ({
    signedIn: page,
    browserName,
  }) => {
    const control = await sessionId('northwind-web control');
    const title = `test-nw-${browserName}`;
    const { id } = (await fake('/__fake/sessions', {
      method: 'POST',
      body: JSON.stringify({
        title,
        project_path: '/tmp/northwind-web-worktrees/test',
        parent_session_id: control,
        status: 'Running',
      }),
    })) as { id: string };
    try {
      await page.goto('/p/northwind-web');
      const sidebar = page.locator('[data-sidebar="sidebar"]');
      await expect(sidebar.getByRole('link', { name: new RegExp(title) })).toBeVisible({ timeout: 15_000 });
      const spawned = page.locator('section[aria-labelledby="spawned-heading"]');
      await expect(spawned.getByRole('link', { name: new RegExp(title) })).toBeVisible();
      await spawned.getByRole('link', { name: new RegExp(title) }).click();
      await expect(page).toHaveURL(new RegExp(`/chat/${id}`));
      // Not among the sessions Supercharge doesn't know.
      await page.goto('/');
      await expect(page.locator('#standalone').getByText(title)).toHaveCount(0);
    } finally {
      await fake(`/__fake/sessions/${id}`, { method: 'DELETE' });
    }
  });

  test('a permission prompt is answered from the chat by its number', async ({ signedIn: page }) => {
    const id = await sessionId('AA-0001');
    await fake(`/__fake/sessions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'Waiting', menu: PERMISSION_MENU }),
    });
    try {
      await page.goto('/p/apollo-api/t/AA-0001/chat');
      const card = page.locator('section', {
        has: page.getByRole('heading', { name: 'Claude needs permission' }),
      });
      await expect(card.getByText('npm run load-test -- --rate 200')).toBeVisible({ timeout: 15_000 });
      await card.getByRole('radiogroup').getByText('Yes', { exact: true }).click();
      await card.getByRole('button', { name: 'Send answer' }).click();
      await expect(page.getByText('Answer sent')).toBeVisible();
      const state = (await fake('/__fake/state')) as { sent: { id: string; message: string }[] };
      expect(state.sent.filter((m) => m.id === id).at(-1)?.message).toBe('1');
      await expect(card).toHaveCount(0, { timeout: 15_000 });
      await expect(page.getByLabel(/^Message /)).toBeVisible();
    } finally {
      await fake(`/__fake/sessions/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'Running', menu: null }),
      });
    }
  });

  test('a control chat asks you its workers’ questions, inline', async ({ signedIn: page }) => {
    await page.goto(`/chat/${await sessionId('northwind-web control')}`);
    const asks = page.locator('section[aria-labelledby="worker-asks"]');
    await expect(
      asks.getByRole('heading', { name: /worker is asking you|workers are asking you/ }),
    ).toBeVisible();
    await expect(asks.getByText("Is the client's copy deck from Friday final")).toBeVisible();
    // The worker asks by its name; the card links its task by title.
    await expect(asks.getByRole('heading', { name: /^[A-Z][a-z]+ asks$/ })).toBeVisible();
    await expect(asks.getByRole('link', { name: 'Content entry for launch pages' })).toBeVisible();
    await expect(asks.getByRole('radiogroup').getByText("Use Friday's deck")).toBeVisible();
    await expect(asks.getByRole('radiogroup').getByText('Write my own answer')).toBeVisible();
    await axe(page, 'control chat with worker questions');
  });

  test('Claude’s own multiple-choice question is answered from the control chat', async ({
    signedIn: page,
  }) => {
    const id = await sessionId('NW-0005');
    await fake(`/__fake/sessions/${id}/ask`, {
      method: 'POST',
      body: JSON.stringify({
        questions: [
          {
            question: 'Which browsers should the QA pass cover?',
            header: 'Browsers',
            multiSelect: true,
            options: [
              { label: 'Chrome', description: 'Latest stable on macOS and Windows' },
              { label: 'Safari', description: 'Including Safari on iOS 26' },
              { label: 'Firefox', description: 'Latest stable only' },
            ],
          },
          {
            question: 'Run the pass before or after content entry?',
            header: 'Timing',
            options: [{ label: 'Before' }, { label: 'After' }],
          },
        ],
      }),
    });
    try {
      await page.goto(`/chat/${await sessionId('northwind-web control')}`);
      const asks = page.locator('section[aria-labelledby="worker-asks"]');
      const card = asks.locator('section', {
        has: page.getByRole('heading', { name: 'Claude is asking you' }),
      });
      await expect(card.getByText('Which browsers should the QA pass cover?', { exact: true })).toBeVisible({
        timeout: 15_000,
      });
      await expect(card.getByRole('link', { name: /NW-0005/ })).toBeVisible();
      await axe(page, 'multiple-choice question');
      // One question at a time: Previous and Next step through them, and only the last one sends.
      await expect(card.getByText('Question 1 of 2')).toBeVisible();
      await expect(card.getByRole('button', { name: 'Previous' })).toBeDisabled();
      await expect(card.getByRole('button', { name: 'Send answers' })).toHaveCount(0);
      await card.getByRole('button', { name: 'Next' }).click();
      await expect(card.getByText('Question 2 of 2')).toBeVisible();
      await expect(
        card.getByText('Run the pass before or after content entry?', { exact: true }),
      ).toBeVisible();
      await expect(card.getByText('Which browsers should the QA pass cover?', { exact: true })).toHaveCount(
        0,
      );
      // Sending with the first one unanswered goes back to it.
      await card.getByRole('button', { name: 'Send answers' }).click();
      await expect(card.getByRole('alert')).toContainText('Answer every question');
      await expect(card.getByText('Question 1 of 2')).toBeVisible();
      await card.getByRole('checkbox', { name: /^Chrome/ }).check();
      await card.getByRole('checkbox', { name: /^Safari/ }).check();
      await card.getByRole('button', { name: 'Next' }).click();
      await card.getByRole('radio', { name: 'After', exact: true }).check();
      // The answers survive going back and forth.
      await card.getByRole('button', { name: 'Previous' }).click();
      await expect(card.getByRole('checkbox', { name: /^Safari/ })).toBeChecked();
      await card.getByRole('button', { name: /^Timing/ }).click();
      await expect(card.getByRole('radio', { name: 'After', exact: true })).toBeChecked();
      await card.getByRole('button', { name: 'Send answers' }).click();
      await expect(page.getByText('Answers sent')).toBeVisible();
      const state = (await fake('/__fake/state')) as {
        keys: { id: string; hex: string }[];
        sent: { id: string; message: string }[];
      };
      expect(state.keys.filter((k) => k.id === id).at(-1)?.hex).toBe('1b');
      const sent = state.sent.filter((m) => m.id === id).at(-1)?.message ?? '';
      expect(sent).toContain('Answer: Chrome; Safari');
      expect(sent).toContain('Answer: After');
      await expect(card).toHaveCount(0, { timeout: 15_000 });
    } finally {
      await fake(`/__fake/sessions/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'Running', menu: null }),
      });
    }
  });

  test('reply is confirmed explicitly and reaches the worker', async ({ signedIn: page, browserName }) => {
    // NW-0005 has no open question, so replying leaves the shared Needs-you state alone for other engines.
    // (NW-0003 stays untouched: its seeded chat is asserted below.)
    await page.goto('/p/northwind-web/t/NW-0005');
    const message = `Prioritise the header first (${browserName}).`;
    await page.getByLabel('Message to the worker').fill(message);
    await page.getByRole('button', { name: 'Send reply' }).click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm.getByText(/^Send this to [A-Z][a-z]+ \(NW-0005\)\?$/)).toBeVisible();
    await confirm.getByRole('button', { name: 'Send reply' }).click();
    await expect(page.getByText(/^Sent to [A-Z][a-z]+$/)).toBeVisible();
    const state = (await fake('/__fake/state')) as { sent: { message: string }[] };
    expect(state.sent.some((s) => s.message === message)).toBe(true);
  });

  test('live updates arrive over SSE without reloading', async ({ signedIn: page }) => {
    await page.goto('/p/northwind-web');
    const state = (await fake('/__fake/state')) as { sessions: { id: string; title: string }[] };
    const qa = state.sessions.find((s) => s.title.startsWith('NW-0005'))!;
    await fake(`/__fake/sessions/${qa.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'Error', last_error: 'claude exited unexpectedly' }),
    });
    const needs = page.locator('section[aria-labelledby="needs-you-heading"]');
    await expect(needs.getByText('Session error')).toBeVisible({ timeout: 15_000 });
    await expect(needs.getByText('claude exited unexpectedly')).toBeVisible();
    await fake(`/__fake/sessions/${qa.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'Running', last_error: null }),
    });
    await expect(needs.getByText('Session error')).toHaveCount(0, { timeout: 15_000 });
  });

  test('Control chat in the sidebar opens a chat you can type into', async ({
    signedIn: page,
    browserName,
  }) => {
    await page.goto('/p/apollo-api');
    await page
      .getByRole('link', { name: /Control chat/ })
      .first()
      .click();
    await expect(page).toHaveURL(/\/chat\/[0-9a-f]{16}$/);
    await expect(page.getByRole('heading', { level: 1, name: 'apollo-api control' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'breadcrumb' })).toContainText(
      'apollo-apiControl chat',
    );
    await expect(page.getByRole('link', { name: 'Open on claude.ai' })).toBeVisible();
    const message = `What is blocked right now? (${browserName})`;
    const box = page.getByLabel(/^Message /);
    await box.fill(message);
    await box.press('Enter');
    const log = page.getByRole('log', { name: /^Conversation with/ });
    await expect(log.getByText(message, { exact: true }).first()).toBeVisible();
    await expect(box).toHaveValue('');
    // The fake agent answers through the transcript, rendered as markdown (a blockquote of the prompt).
    await expect(log.locator('blockquote', { hasText: message })).toBeVisible({ timeout: 15_000 });
    // A message of several lines arrives as a paste, which Claude Code records wrapped: shown once, as typed.
    const second = `second line ${browserName}`;
    await box.fill(`Two lines (${browserName})\n${second}`);
    await box.press('Enter');
    await expect(log.locator('blockquote', { hasText: `Two lines (${browserName})` })).toBeVisible({
      timeout: 15_000,
    });
    await expect(log.getByText(second)).toHaveCount(1);
    await expect(log.getByText('pasted_content')).toHaveCount(0);
    await axe(page, 'control chat');
  });

  test('the chat renders markdown, tables, code and folded tool calls', async ({ signedIn: page }) => {
    await page.goto('/p/northwind-web');
    await page.getByRole('link', { name: 'Open chat' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Northwind launch plan' })).toBeVisible();
    const log = page.getByRole('log', { name: /^Conversation with/ });
    await expect(log.getByRole('heading', { name: 'Launch plan' })).toBeVisible();
    await expect(log.getByRole('cell', { name: 'DNS cutover runbook' })).toBeVisible();
    await expect(log.locator('code.hljs .hljs-string').first()).toBeVisible();
    await expect(log.getByRole('button', { name: 'Copy' }).first()).toBeVisible();
    await expect(log.locator('strong', { hasText: 'NW-0002' })).toBeVisible();
    // Six task calls in a row fold into one row; opening it shows each call.
    await log.getByText('6 tool calls').click();
    await expect(log.getByTitle('supercharge task new "DNS cutover runbook"')).toBeVisible();
    await axe(page, 'chat');
  });

  test("a shell block in Claude's reply runs in the session once you confirm it", async ({
    signedIn: page,
  }) => {
    const id = await sessionId('northwind-web control');
    const lastSent = async () =>
      ((await fake('/__fake/state')) as { sent: { id: string; message: string }[] }).sent
        .filter((m) => m.id === id)
        .at(-1)?.message;
    await page.goto(`/chat/${id}`);
    const log = page.getByRole('log', { name: /^Conversation with/ });
    // Only the bash block offers Run; the TypeScript one does not.
    const run = log.getByRole('button', { name: 'Run', exact: true });
    await expect(run).toHaveCount(1);
    await run.click();
    const dialog = page.getByRole('alertdialog', { name: 'Run this command?' });
    await expect(dialog).toContainText('supercharge task new "Build page templates"');
    await expect(dialog).toContainText("through Claude Code's shell mode");
    await axe(page, 'run command');
    await expectContained(page, dialog);
    const before = await lastSent();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect(await lastSent()).toBe(before);
    await run.click();
    await dialog.getByRole('button', { name: 'Run in chat' }).click();
    await expect
      .poll(lastSent)
      .toBe(
        '!supercharge task new "Build page templates" \\\n  --brief "Header, listing and detail templates. Match the Figma frames."',
      );
    // What it printed shows on your side of the chat, and Claude's reply follows.
    await expect(log.getByLabel('Output').last()).toContainText('ran: supercharge task new', {
      timeout: 15_000,
    });
    await expect(log.getByText('That ran cleanly.').last()).toBeVisible({ timeout: 15_000 });
  });

  test("Run in terminal runs a command in the control chat's own shell, in the side panel", async ({
    signedIn: page,
    browserName,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const id = await sessionId('northwind-web control');
    const ran = async () =>
      ((await fake('/__fake/state')) as { shellRan: { id: string; command: string }[] }).shellRan
        .filter((m) => m.id === id)
        .map((m) => m.command);
    await page.goto(`/chat/${id}`);
    const log = page.getByRole('log', { name: /^Conversation with/ });
    // The inline `! command` Claude wrote has a Run button too.
    await log.getByRole('button', { name: 'Run aoe session list-trash' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Run this command?' });
    await expect(dialog).toContainText('aoe session list-trash');
    await axe(page, 'run in terminal');
    await expectContained(page, dialog);
    await page.setViewportSize({ width: 390, height: 844 });
    await expectContained(page, dialog);
    await page.setViewportSize({ width: 1440, height: 900 });
    await dialog.getByRole('button', { name: 'Run in terminal' }).click();
    await expect(page.getByRole('tab', { name: 'Shell' })).toHaveAttribute('aria-selected', 'true');
    const screen = page.locator('.xterm-rows');
    await expect(screen).toContainText('ran: aoe session list-trash', { timeout: 15_000 });
    expect(await ran()).toContain('aoe session list-trash');
    // It is a terminal: what you type goes to the shell.
    await page.locator('.xterm').click();
    await page.keyboard.type(`echo from ${browserName}`);
    await page.keyboard.press('Enter');
    await expect(screen).toContainText(`ran: echo from ${browserName}`);
    await expect.poll(ran).toContain(`echo from ${browserName}`);
  });

  test('a control chat off Opus says so, and switches back after saying what it does', async ({
    signedIn: page,
  }) => {
    const id = await sessionId('apollo-api control');
    const patch = (body: unknown) =>
      fake(`/__fake/sessions/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
    await patch({ status: 'Idle' });
    await fake('/__fake/send', { method: 'POST', body: JSON.stringify({ id, message: '/model sonnet' }) });
    try {
      await page.goto(`/chat/${id}`);
      const notice = page.getByText(/The control chat is on Sonnet 5\./);
      await expect(notice).toBeVisible();
      const open = page.getByRole('button', { name: 'Switch to Opus' });
      await expect(open).toBeEnabled();
      await axe(page, 'control model notice');
      await open.click();
      const dialog = page.getByRole('alertdialog', { name: 'Switch the control chat to Opus?' });
      await expect(dialog).toContainText('keeps this chat on Opus when AoE restarts it');
      await dialog.getByRole('button', { name: 'Switch to Opus' }).click();
      await expect
        .poll(
          async () =>
            ((await fake('/__fake/state')) as { sent: { id: string; message: string }[] }).sent
              .filter((m) => m.id === id)
              .at(-1)?.message,
        )
        .toBe('/model opus');
      await expect(notice).toBeHidden({ timeout: 15_000 });
    } finally {
      await patch({ status: 'Running' });
    }
  });

  test('a working worker shows progress, failures and a running call', async ({ signedIn: page }) => {
    // A worker's /chat/<id> link lands on its task page's Chat tab.
    await page.goto(`/chat/${await sessionId('NW-0003')}`);
    await expect(page).toHaveURL(/\/p\/northwind-web\/t\/NW-0003\/chat$/);
    await expect(page.getByRole('heading', { level: 1, name: /Accessibility audit/ })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Claude is working' })).toBeVisible();
    const log = page.getByRole('log', { name: /^Conversation with/ });
    await expect(log.getByRole('img', { name: 'Failed' })).toBeVisible();
    await expect(log.getByRole('img', { name: 'Running' })).toBeVisible();
    // Paths inside the worktree read relative to it.
    await expect(log.getByText('src/components/Header.tsx', { exact: true }).first()).toBeVisible();
  });

  test('the chat bar shows the model and effort, and switches them after saying what it does', async ({
    signedIn: page,
    browserName,
  }) => {
    const id = await sessionId('northwind-web control');
    await page.goto(`/chat/${id}`);
    const trigger = page.getByRole('button', { name: /^Model and effort: Opus 5\.5/ });
    await expect(trigger).toBeVisible();
    // A model change is also saved as the Claude Code default, and the dialog says so; cancel sends nothing.
    await trigger.click();
    await page.getByRole('menuitem', { name: 'Sonnet', exact: true }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('saves it as your default for new Claude Code sessions');
    const before = ((await fake('/__fake/state')) as { sent: unknown[] }).sent.length;
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect(((await fake('/__fake/state')) as { sent: unknown[] }).sent.length).toBe(before);
    // An effort change goes through and shows once Claude Code confirms it.
    const effort = ({ chromium: 'Low', firefox: 'Medium', webkit: 'Max' } as Record<string, string>)[
      browserName
    ]!;
    await trigger.click();
    await page.getByRole('menuitem', { name: effort }).click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: /^Switch/ })
      .click();
    await expect
      .poll(async () => {
        const state = (await fake('/__fake/state')) as { sent: { id: string; message: string }[] };
        return state.sent.filter((m) => m.id === id).at(-1)?.message;
      })
      .toBe(`/effort ${effort.toLowerCase()}`);
    await expect(
      page.getByRole('button', { name: `Model and effort: Opus 5.5, ${effort.toLowerCase()}` }),
    ).toBeVisible({
      timeout: 15_000,
    });
  });

  test('an image is marked up before it is sent, and shows in the chat', async ({
    signedIn: page,
    browserName,
  }) => {
    const id = await sessionId('apollo-api control');
    await page.goto(`/chat/${id}`);
    const png = await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 320;
      c.height = 200;
      const x = c.getContext('2d')!;
      x.fillStyle = '#e5e7eb';
      x.fillRect(0, 0, 320, 200);
      x.fillStyle = '#111827';
      x.fillRect(40, 40, 120, 60);
      return c.toDataURL('image/png').split(',')[1]!;
    });
    await page
      .locator('input[type="file"]')
      .setInputFiles({ name: 'shot.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    const dialog = page.getByRole('dialog', { name: 'Mark up the image' });
    const canvas = dialog.getByLabel('Image to mark up');
    await expect(canvas).toBeVisible();
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.7, { steps: 6 });
    await page.mouse.up();
    await expect(dialog.getByRole('button', { name: 'Undo' })).toBeEnabled();
    const message = `The dark box is in the wrong place (${browserName})`;
    const field = dialog.getByLabel('Message with the image');
    await field.fill(message);
    await field.press('Enter');
    await expect(dialog).toHaveCount(0, { timeout: 15_000 });
    await expect
      .poll(async () => {
        const state = (await fake('/__fake/state')) as { sent: { id: string; message: string }[] };
        return state.sent.filter((m) => m.id === id).at(-1)?.message ?? '';
      })
      .toMatch(
        new RegExp(
          `^${message.replace(/[()]/g, '\\$&')}\\n\\nAttached: /\\S+/uploads/${id}/\\S+-screenshot\\.png$`,
        ),
      );
    const log = page.getByRole('log', { name: /^Conversation with/ });
    await expect(log.getByRole('img', { name: 'screenshot.png' }).first()).toBeVisible({ timeout: 15_000 });
    // The context meter reads the latest reply's token usage.
    await expect(page.getByTitle(/tokens in context$/)).toBeVisible();
  });

  test('the control chat panel: comment on a plan, then send the comments in one go', async ({
    signedIn: page,
    browserName,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/chat/${await sessionId('northwind-web control')}`);
    const panel = page.getByRole('complementary', { name: 'Project panel' });
    await expect(panel.getByRole('heading', { name: /Needs you|All clear/ })).toBeVisible();
    await panel.getByRole('tab', { name: 'Plans' }).click();
    const card = panel.locator('details', { hasText: 'NW-0005' });
    await card.locator('summary').click();
    await card.getByText('Browser matrix').click({ clickCount: 3 });
    await card.getByRole('button', { name: 'Comment' }).click();
    const comment = `Add Edge too (${browserName})`;
    await card.getByPlaceholder('What should change here?').fill(comment);
    await card.getByRole('button', { name: 'Save comment' }).click();
    await expect(card.getByText(comment)).toBeVisible();
    await panel.getByRole('tab', { name: 'Comments' }).click();
    await expect(panel.getByText(comment)).toBeVisible();
    await panel.getByRole('button', { name: /^Send 1 to NW-0005$/ }).click();
    await expect
      .poll(async () => {
        const id = await sessionId('NW-0005');
        const state = (await fake('/__fake/state')) as { sent: { id: string; message: string }[] };
        return state.sent.filter((m) => m.id === id).at(-1)?.message ?? '';
      })
      .toContain(`1. On "Browser matrix"\n   ${comment}`);
    await axe(page, 'control chat panel');
  });

  test('answering in the control chat never scrolls the page away (the blank screen)', async ({
    signedIn: page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/chat/${await sessionId('northwind-web control')}`);
    const brief = page
      .getByRole('complementary', { name: 'Project panel' })
      .locator('section[aria-labelledby="brief-heading"]');
    await brief
      .getByRole('link', { name: /NW-0002/ })
      .first()
      .click();
    await page.locator('#ask-NW-0002').getByRole('radiogroup').locator('label').first().click();
    const offsets = await page.evaluate(() =>
      [...document.querySelectorAll('[data-slot=sidebar-inset], main#main')].map((el) => el.scrollTop),
    );
    expect(offsets).toEqual([0, 0]);
    await expect(page.getByLabel(/^Message /)).toBeInViewport();
  });

  test('the control chat panel keeps notes and nudges when something new needs you', async ({
    signedIn: page,
    browserName,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/chat/${await sessionId('northwind-web control')}`);
    const panel = page.getByRole('complementary', { name: 'Project panel' });
    // Notes is the first tab and the one a control chat opens on.
    await expect(panel.getByRole('tab').first()).toHaveText('Notes');
    await expect(panel.getByRole('tab', { name: 'Notes' })).toHaveAttribute('aria-selected', 'true');
    // The panel hides from inside, and the labelled Panel button in the header brings it back.
    await panel.getByRole('button', { name: 'Hide the panel' }).click();
    await expect(panel).toHaveCount(0);
    await page.getByRole('button', { name: 'Panel', exact: true }).click();
    await expect(panel).toBeVisible();
    // Start fresh sits next to the context meter, not only in the ⋯ menu.
    await page.getByRole('button', { name: /start fresh/i }).click();
    await expect(page.getByRole('alertdialog', { name: 'Start a fresh conversation?' })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
    const notes = panel.getByLabel('Notes for northwind-web');
    const text = `Compare NW-0001 with the Figma frames (${browserName})`;
    await notes.fill(text);
    await expect(panel.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
    await page.reload();
    await page
      .getByRole('complementary', { name: 'Project panel' })
      .getByRole('tab', { name: 'Notes' })
      .click();
    await expect(page.getByLabel('Notes for northwind-web')).toHaveValue(text);
    // A worker starts waiting: the status strip pulses and lists it.
    const id = await sessionId('NW-0004');
    await fake(`/__fake/sessions/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'Waiting' }) });
    try {
      const brief = page
        .getByRole('complementary', { name: 'Project panel' })
        .locator('section[aria-labelledby="brief-heading"]');
      await expect(brief).toHaveClass(/nudge/, { timeout: 15_000 });
      await expect(brief.getByText(/NW-0004/).first()).toBeVisible();
      await expect(page).toHaveTitle(/^\(\d+\) Supercharge$/);
    } finally {
      await fake(`/__fake/sessions/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'Idle' }) });
    }
  });

  test('an AoE parent with children is adopted as a new project, without messaging anyone', async ({
    signedIn: page,
    browserName,
  }) => {
    const { home } = world();
    const repo = join(home, 'code', `hq-${browserName}`);
    mkdirSync(repo, { recursive: true });
    const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    git(
      '-c',
      'user.email=e2e@example.invalid',
      '-c',
      'user.name=e2e',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'init',
    );
    const mk = (body: Record<string, unknown>) =>
      fake('/__fake/sessions', { method: 'POST', body: JSON.stringify(body) }) as Promise<{ id: string }>;
    const parent = await mk({
      title: `hq ${browserName}`,
      project_path: join(home, `hq-${browserName}`),
      status: 'Idle',
    });
    for (const t of ['idea-35-theme', 'idea-38-claim'])
      await mk({
        title: `${t}-${browserName}`,
        project_path: join(home, 'code', `hq-${browserName}-worktrees`, t),
        main_repo_path: repo,
        branch: `feature/${t}`,
        base_branch: 'main',
        parent_session_id: parent.id,
        status: 'Idle',
      });
    const sentBefore = ((await fake('/__fake/state')) as { sent: unknown[] }).sent.length;
    await page.goto('/');
    const group = page.locator(`[id="group-${parent.id}"]`);
    await expect(group).toBeVisible({ timeout: 15_000 });
    await group.getByRole('button', { name: 'Adopt as project' }).click();
    const dialog = page.getByRole('dialog', { name: 'Adopt as a project' });
    await expect(dialog.getByText(`idea-35-theme-${browserName}`)).toBeVisible();
    await expect(dialog.getByLabel('Name')).toHaveValue(`hq-${browserName}`);
    await axe(page, 'adopt dialog');
    await dialog.getByRole('button', { name: /^Adopt 2 sessions$/ }).click();
    await expect(page).toHaveURL(new RegExp(`/p/hq-${browserName}$`));
    await expect(
      page.getByRole('list', { name: 'Workers' }).getByText(`idea-35-theme-${browserName}`),
    ).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.locator('section[aria-labelledby="control-heading"]').getByText(parent.id),
    ).toBeVisible();
    expect(((await fake('/__fake/state')) as { sent: unknown[] }).sent.length).toBe(sentBefore);
  });

  test('a project is deleted from its settings, behind the ⋯ menu and a typed name', async ({
    signedIn: page,
    browserName,
  }) => {
    // The project the adoption test just created for this engine.
    const name = `hq-${browserName}`;
    await page.goto(`/p/${name}`);
    await page.getByRole('button', { name: 'More project actions' }).click();
    await page.getByRole('menuitem', { name: 'Project settings' }).click();
    await expect(page).toHaveURL(new RegExp(`/p/${name}/settings$`));
    await page.getByRole('button', { name: 'Delete project' }).click();
    const dialog = page.getByRole('dialog', { name: `Delete ${name}?` });
    const go = dialog.getByRole('button', { name: 'Delete project' });
    await expect(go).toBeDisabled();
    await dialog.getByLabel(/Type .* to confirm/).fill(name);
    await expect(go).toBeEnabled();
    await go.click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('link', { name: new RegExp(`^${name}`) })).toHaveCount(0);
    // Its sessions were kept: they are back under Other AoE sessions.
    await expect(page.locator('main#main').getByText(`hq ${browserName}`, { exact: true })).toBeVisible({
      timeout: 15_000,
    });
  });

  test('the sidebar + opens Add a project: adopt from AoE, or the init command for a repository', async ({
    signedIn: page,
  }) => {
    await page.getByRole('button', { name: 'Add a project' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add a project' });
    await expect(dialog.getByText('ops control')).toBeVisible();
    await dialog.getByLabel('Path to the repository').fill('~/Dev/new-thing');
    await expect(dialog.getByText('cd ~/Dev/new-thing && supercharge init')).toBeVisible();
    await dialog
      .getByRole('listitem')
      .filter({ hasText: 'ops control' })
      .getByRole('button', { name: 'Adopt' })
      .click();
    await expect(page.getByRole('dialog', { name: 'Adopt as a project' })).toBeVisible();
  });

  test('new task dialog builds the CLI command (dashboard never spawns agents)', async ({
    signedIn: page,
  }) => {
    await page.goto('/p/apollo-api');
    await page.getByRole('button', { name: 'New task' }).click();
    await page.getByLabel('Title').fill('Add request tracing');
    await expect(
      page.getByRole('dialog').getByText('supercharge task new "Add request tracing" --project apollo-api'),
    ).toBeVisible();
  });
});

test.describe('right-click', () => {
  test('Ctrl/⌘ and Shift select sidebar rows; right-click acts on the selection; Escape clears it', async ({
    signedIn: page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 860 });
    await page.goto('/p/northwind-web');
    const rows = page
      .locator('[data-sidebar="menu-item"]', { has: page.getByRole('link', { name: 'northwind-web' }) })
      .locator('[data-sidebar="menu-sub-item"]')
      .filter({ hasNotText: 'Control chat' });
    await rows.nth(0).click({ modifiers: ['ControlOrMeta'] });
    await rows.nth(2).click({ modifiers: ['Shift'] });
    await expect(page).toHaveURL(/\/p\/northwind-web$/);
    await expect(page.locator('[data-sidebar="menu-sub-item"][data-selected]')).toHaveCount(3);
    await expect(page.getByRole('status').filter({ hasText: '3 selected' })).toBeVisible();
    await rows.nth(1).click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'Session actions' });
    await expect(menu.getByText('3 sessions')).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Archive' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Open', exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(page.locator('[data-sidebar="menu-sub-item"][data-selected]')).toHaveCount(3);
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-sidebar="menu-sub-item"][data-selected]')).toHaveCount(0);
    // A right-click on a row outside the selection acts on that row alone.
    await rows.nth(0).click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Open', exact: true })).toBeVisible();
    await axe(page, 'session menu');
    await page.keyboard.press('Escape');
  });

  test('lock, archive, unarchive and delete sessions from the menu, one or several at once', async ({
    signedIn: page,
    browserName,
  }) => {
    const names = [`rc ${browserName} one`, `rc ${browserName} two`];
    for (const title of names)
      await fake('/__fake/sessions', {
        method: 'POST',
        body: JSON.stringify({ title, project_path: `/tmp/${title.replace(/ /g, '-')}`, status: 'Idle' }),
      });
    await page.goto('/');
    const row = (name: string) => page.locator('li', { hasText: name });
    await expect(row(names[0]!)).toBeVisible({ timeout: 15_000 });
    const menu = page.getByRole('menu', { name: 'Session actions' });

    // Lock: archive and delete are refused until it is unlocked.
    await row(names[0]!).click({ button: 'right' });
    await menu.getByRole('menuitem', { name: 'Lock' }).click();
    await expect(row(names[0]!).getByRole('img', { name: 'Locked' })).toBeVisible({ timeout: 15_000 });
    await row(names[0]!).click({ button: 'right' });
    await expect(menu.getByRole('menuitem', { name: /Archive/ })).toHaveAttribute('data-disabled', '');
    await expect(menu.getByRole('menuitem', { name: /Delete/ })).toHaveAttribute('data-disabled', '');
    await menu.getByRole('menuitem', { name: 'Unlock' }).click();
    await expect(row(names[0]!).getByRole('img', { name: 'Locked' })).toHaveCount(0, { timeout: 15_000 });
    // Let the closing menu finish leaving, so the next one is the only menu on the page.
    await expect(menu).toHaveCount(0);

    // Both at once: archive, and they move to the Archived list.
    await row(names[0]!).click({ modifiers: ['ControlOrMeta'] });
    await row(names[1]!).click({ modifiers: ['ControlOrMeta'] });
    await row(names[1]!).click({ button: 'right' });
    await expect(menu.getByText('2 sessions')).toBeVisible();
    await menu.getByRole('menuitem', { name: 'Archive' }).click();
    await expect(page.getByText('Archived 2 sessions')).toBeVisible();
    const archived = page.locator('details', { hasText: 'Archived' });
    await expect(archived).toContainText(names[0]!, { timeout: 15_000 });
    await archived.locator('summary').click();

    // An archived chat says so, and unarchives in place.
    await archived.getByRole('link', { name: new RegExp(names[1]!) }).click();
    await expect(page.getByText('This session is archived')).toBeVisible();
    await page.getByRole('button', { name: 'Unarchive' }).click();
    await expect(page.getByText('Unarchived')).toBeVisible();
    await expect(page.getByLabel(/^Message /)).toBeVisible({ timeout: 15_000 });

    // Delete: to AoE's trash, after saying so.
    await page.goto('/');
    await archived.locator('summary').click();
    await row(names[0]!).click({ button: 'right' });
    await menu.getByRole('menuitem', { name: 'Delete…' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('AoE’s trash');
    await dialog.getByRole('button', { name: 'Move to trash' }).click();
    await expect(page.getByText('Deleted', { exact: true })).toBeVisible();
    await expect(row(names[0]!)).toHaveCount(0, { timeout: 15_000 });
    const state = (await fake('/__fake/state')) as {
      sessions: { title: string; trashed_at?: string | null }[];
    };
    expect(state.sessions.find((s) => s.title === names[0])?.trashed_at).toBeTruthy();
  });

  test("the browser's own menu stays away except on text, fields and selections", async ({
    signedIn: page,
  }) => {
    await page.goto('/settings');
    await expect(page.locator('main h1')).toBeVisible();
    await expect(page.locator('main input').first()).toBeVisible();
    const prevented = (selector: string) =>
      page.evaluate((sel) => {
        const el = document.querySelector(sel)!;
        const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
        el.dispatchEvent(e);
        return e.defaultPrevented;
      }, selector);
    expect(await prevented('main h1')).toBe(true);
    expect(await prevented('main input')).toBe(false);
  });
});

test.describe('settings', () => {
  test('validates, saves, and keeps comments in config.toml', async ({ signedIn: page }) => {
    await page.goto('/settings');
    const port = page.getByLabel('Port', { exact: true });
    await port.fill('80');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(
      page.getByText(/Number must be greater than or equal to 1024|Too small|>=1024/i),
    ).toBeVisible();
    await port.fill('47391');
    const mr = page.getByLabel('Merge requests (s)');
    await mr.fill(String(Number(await mr.inputValue()) + 1));
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Settings saved')).toBeVisible();
    await axe(page, 'settings');
  });

  test('restart is behind a confirmation', async ({ signedIn: page }) => {
    await page.goto('/settings');
    const host = page.getByLabel('Hostname');
    await host.fill('supercharge.localhost');
    // Changing a restart-required key shows the bar; use the logging level (hot) and then aoe.autoStart (restart).
    await page.getByRole('switch', { name: 'Start aoe serve when needed' }).click();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Restart required')).toBeVisible();
    await page.getByRole('button', { name: 'Restart daemon' }).click();
    await expect(page.getByRole('alertdialog').getByText('Restart the Supercharge daemon?')).toBeVisible();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();
    // Put it back so later tests see the original value.
    await page.getByRole('switch', { name: 'Start aoe serve when needed' }).click();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Settings saved').last()).toBeVisible();
  });
});

test.describe('design gate (SPEC §14.4)', () => {
  test('theme toggle switches and persists; light theme passes axe', async ({ signedIn: page }) => {
    await page.goto('/p/northwind-web');
    if (!(await page.locator('html').getAttribute('class'))?.includes('dark'))
      await page.getByRole('button', { name: /Dark mode/ }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await page.getByRole('button', { name: /Light mode/ }).click();
    await expect(page.locator('html')).not.toHaveClass(/dark/);
    await page.waitForTimeout(500); // let colour transitions settle before measuring contrast
    await axe(page, 'project (light)');
    await page.reload();
    await expect(page.locator('html')).not.toHaveClass(/dark/);
    await page.getByRole('button', { name: /Dark mode/ }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);
  });

  test('no em or en dashes in visible UI text', async ({ signedIn: page }) => {
    const chat = `/chat/${await sessionId('northwind-web control')}`;
    for (const path of [
      '/',
      '/p/northwind-web',
      '/p/northwind-web/t/NW-0004',
      '/settings',
      '/office',
      '/office?view=list',
      chat,
    ]) {
      await page.goto(path);
      await page.waitForTimeout(400);
      const text = await page.locator('body').innerText();
      expect(text, path).not.toMatch(/[–—]/);
    }
  });

  test('screenshots for review: dark and light, desktop and portrait', async ({
    signedIn: page,
    browserName,
  }, info) => {
    test.skip(browserName !== 'chromium', 'one engine is enough for the review set');
    const chat = `/chat/${await sessionId('northwind-web control')}`;
    for (const [w, h] of [
      [1440, 900],
      [1080, 1920],
    ] as const) {
      await page.setViewportSize({ width: w, height: h });
      for (const theme of ['dark', 'light'] as const) {
        await page.evaluate((t) => {
          document.documentElement.classList.toggle('dark', t === 'dark');
          document.documentElement.style.colorScheme = t;
        }, theme);
        for (const [name, path] of [
          ['overview', '/'],
          ['project', '/p/northwind-web'],
          ['task', '/p/northwind-web/t/NW-0001'],
          ['plan-approval', '/p/apollo-api/t/AA-0002'],
          ['settings', '/settings'],
          ['office', '/office'],
          ['office-list', '/office?view=list'],
          ['chat', chat],
        ] as const) {
          await page.goto(path);
          await page.evaluate((t) => document.documentElement.classList.toggle('dark', t === 'dark'), theme);
          await page.waitForTimeout(500);
          await page.screenshot({
            path: info.outputPath(`${name}-${theme}-${w}x${h}.png`),
            fullPage: path !== chat,
          });
        }
      }
    }
  });

  test('reduced motion still renders everything', async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    const { signIn } = await import('./fixtures.ts');
    await signIn(page);
    await page.goto('/p/northwind-web/t/NW-0001');
    await expect(page.getByRole('heading', { level: 1, name: 'Build page templates' })).toBeVisible();
    await page.goto('/office');
    await expect(page.getByRole('list', { name: 'Queue at your door' })).toBeVisible();
    await expect(page.locator('[data-office-floor]')).toHaveAttribute('data-motion', 'jump');
    await ctx.close();
  });
});
