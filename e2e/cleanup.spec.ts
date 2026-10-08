import { axe, expect, fake, test } from './fixtures.ts';

/**
 * Clean up finished workers (the safety checks themselves are in packages/cli/test/cleanup.test.ts, with real
 * git: the world here has no reachable origin), a chat that is read while it is open, and the locked
 * control-chat model picker.
 */

async function sessionId(prefix: string): Promise<string> {
  const state = (await fake('/__fake/state')) as { sessions: { id: string; title: string }[] };
  return state.sessions.find((s) => s.title.startsWith(prefix))!.id;
}

test.describe('clean up', () => {
  test('a done task offers Clean up; it says why when the work is not safe, and the button stays off', async ({
    signedIn: page,
  }) => {
    await page.route('**/api/tasks/northwind-web/*/cleanup', (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({
            json: {
              taskId: 'NW-0006',
              branch: 'sc/nw-0006-dns',
              ok: false,
              reason:
                '2 commits on sc/nw-0006-dns are not on origin/main, and no merged pull request covers them.',
              hint: 'Merge the work (or open a pull request) first. Nothing was removed.',
              detail: ['3dd4c8e c.txt', 'e1c8f45 b.txt'],
            },
          })
        : route.abort(),
    );
    await page.goto('/p/northwind-web?done=1');
    await page
      .getByRole('link', { name: /DNS cutover runbook/ })
      .first()
      .click();
    await expect(page.getByRole('heading', { level: 1, name: 'DNS cutover runbook' })).toBeVisible();
    await page.getByRole('button', { name: 'Clean up', exact: true }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog.getByText(/2 commits on sc\/nw-0006-dns are not on origin\/main/)).toBeVisible();
    await expect(dialog.getByText('3dd4c8e c.txt')).toBeVisible();
    await expect(dialog.getByText(/Merge the work/)).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Clean up' })).toBeDisabled();
    await axe(page, 'clean up refused');
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toHaveCount(0);
  });

  test('when it is safe, Clean up says how the work landed, removes the worker and goes back to the project', async ({
    signedIn: page,
  }) => {
    let posted: unknown = null;
    await page.route('**/api/tasks/northwind-web/*/cleanup', async (route) => {
      const req = route.request();
      if (req.method() === 'GET')
        return route.fulfill({
          json: { taskId: 'NW-0006', branch: 'sc/nw-0006-dns', ok: true, landedBy: 'merged_pr' },
        });
      posted = req.postDataJSON();
      return route.fulfill({
        json: { taskId: 'NW-0006', branch: 'sc/nw-0006-dns', ok: true, landedBy: 'merged_pr', removed: true },
      });
    });
    await page.goto('/p/northwind-web?done=1');
    await page
      .getByRole('link', { name: /DNS cutover runbook/ })
      .first()
      .click();
    await page.getByRole('button', { name: 'Clean up', exact: true }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog.getByText(/pull request is merged/)).toBeVisible();
    await axe(page, 'clean up allowed');
    await dialog.getByRole('button', { name: 'Clean up' }).click();
    await expect(page.getByText(/cleaned up/).first()).toBeVisible();
    await expect(page).toHaveURL(/\/p\/northwind-web$/);
    expect(posted).toEqual({ confirm: true });
  });

  test('the right-click menu has Clean up on a done task only, and the project page has Clean up all done', async ({
    signedIn: page,
  }) => {
    await page.route('**/api/tasks/northwind-web/*/cleanup', (route) =>
      route.fulfill({
        json: { taskId: 'NW-0006', branch: 'b', ok: false, reason: 'Could not fetch origin/main.' },
      }),
    );
    await page.goto('/p/northwind-web?done=1');
    await page
      .getByRole('link', { name: /DNS cutover runbook/ })
      .first()
      .click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'Session actions' });
    await menu.getByRole('menuitem', { name: /Clean up/ }).click();
    await expect(page.getByRole('alertdialog').getByText('Could not fetch origin/main.')).toBeVisible();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Close' }).click();

    // A task that is not done has no Clean up.
    await page
      .getByRole('link', { name: /Build page templates/ })
      .first()
      .click({ button: 'right' });
    await expect(menu.getByRole('menuitem', { name: 'Delete…' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /Clean up/ })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await page.route('**/api/projects/northwind-web/cleanup-done', (route) =>
      route.fulfill({
        json: {
          results: [
            { taskId: 'NW-0006', branch: 'a', ok: true, removed: true, landedBy: 'ancestor' },
            {
              taskId: 'NW-0007',
              branch: 'b',
              ok: false,
              removed: false,
              reason: 'The worktree has uncommitted changes (1 file).',
              hint: 'Commit and push them, or discard them, then clean up again.',
              detail: ['a.txt'],
            },
          ],
        },
      }),
    );
    await page.getByRole('button', { name: 'Clean up all done' }).click();
    const dialog = page.getByRole('alertdialog');
    await dialog.getByRole('button', { name: 'Clean up' }).click();
    await expect(dialog.getByText('NW-0007')).toBeVisible();
    await expect(dialog.getByText(/uncommitted changes \(1 file\)/)).toBeVisible();
    await expect(dialog.getByText('NW-0006')).toHaveCount(0);
  });
});

test.describe('control chat', () => {
  // The world is shared: other specs expect the control chat to have replied and not to be dismissed or
  // read, so each test leaves it as it found it (a new status brings a new reply back).
  test.afterEach(async () => {
    const control = await sessionId('northwind-web control');
    await fake(`/__fake/sessions/${control}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'Running' }),
    });
    await new Promise((r) => setTimeout(r, 2_500));
    await fake(`/__fake/sessions/${control}`, {
      method: 'PATCH',
      body: JSON.stringify({ unread: true, status: 'Idle' }),
    });
  });

  test('is marked read while its chat is open, so "Control chat replied" leaves Needs you', async ({
    signedIn: page,
  }) => {
    const control = await sessionId('northwind-web control');
    const needs = page.locator('section[aria-labelledby="needs-you-heading"]');
    const replied = needs.locator('li', { hasText: 'northwind-web control chat' }).filter({
      hasText: 'Control chat replied',
    });
    try {
      await fake(`/__fake/sessions/${control}`, {
        method: 'PATCH',
        body: JSON.stringify({ unread: true, status: 'Idle' }),
      });
      await page.reload();
      await expect(replied).toHaveCount(1, { timeout: 15_000 });

      await page.goto(`/chat/${control}`);
      await expect
        .poll(
          async () =>
            ((await fake('/__fake/state')) as { sessions: { id: string; unread: boolean }[] }).sessions.find(
              (s) => s.id === control,
            )?.unread,
          { timeout: 15_000 },
        )
        .toBe(false);
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Needs you' })).toBeVisible();
      await expect(replied).toHaveCount(0);

      // A reply that arrives while you are looking at the chat is read too.
      await page.goto(`/chat/${control}`);
      await fake(`/__fake/sessions/${control}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'Running' }),
      });
      await page.waitForTimeout(2_500);
      await fake(`/__fake/sessions/${control}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'Idle', unread: true }),
      });
      await expect
        .poll(
          async () =>
            ((await fake('/__fake/state')) as { sessions: { id: string; unread: boolean }[] }).sessions.find(
              (s) => s.id === control,
            )?.unread,
          { timeout: 15_000 },
        )
        .toBe(false);
    } finally {
      // The world is shared: other specs expect the control chat to have replied.
      await fake(`/__fake/sessions/${control}`, {
        method: 'PATCH',
        body: JSON.stringify({ unread: true, status: 'Idle' }),
      });
    }
  });

  test('the panel can dismiss "Control chat replied" itself', async ({ signedIn: page }) => {
    const control = await sessionId('northwind-web control');
    // Keep the chat from marking itself read, to see the item in the panel.
    await page.route('**/api/sessions/*/read', (route) => route.fulfill({ json: { ok: true } }));
    try {
      await fake(`/__fake/sessions/${control}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'Running' }),
      });
      await page.waitForTimeout(2_500);
      await fake(`/__fake/sessions/${control}`, {
        method: 'PATCH',
        body: JSON.stringify({ unread: true, status: 'Idle' }),
      });
      await page.goto(`/chat/${control}`);
      const brief = page.locator('section[aria-labelledby="brief-heading"]');
      const item = brief.locator('li', { hasText: 'Control chat replied' });
      await expect(item).toHaveCount(1, { timeout: 15_000 });
      await item.getByRole('button', { name: /^Dismiss:/ }).click();
      await expect(item).toHaveCount(0);
    } finally {
      await fake(`/__fake/sessions/${control}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'Running' }),
      });
      await new Promise((r) => setTimeout(r, 2_500));
      await fake(`/__fake/sessions/${control}`, {
        method: 'PATCH',
        body: JSON.stringify({ unread: true, status: 'Idle' }),
      });
    }
  });

  test('its model picker is shown but locked; a worker chat keeps the menu', async ({ signedIn: page }) => {
    const control = await sessionId('northwind-web control');
    await page.goto(`/chat/${control}`);
    const locked = page.getByLabel(/^Model and effort, locked/);
    await expect(locked).toBeVisible();
    await expect(locked).toHaveAttribute('title', /Control chats are locked/);
    await locked.click();
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Model and effort:/ })).toHaveCount(0);
    await axe(page, 'locked model picker');

    await page.goto('/p/northwind-web');
    await page
      .getByRole('link', { name: /Build page templates/ })
      .first()
      .click();
    await page.getByRole('link', { name: 'Chat', exact: true }).click();
    await expect(page.getByRole('button', { name: /^Model and effort:/ })).toBeVisible();
    await expect(page.getByLabel(/^Model and effort, locked/)).toHaveCount(0);
  });
});
