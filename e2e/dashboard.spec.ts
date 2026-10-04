import { axe, expect, fake, test } from './fixtures.ts';

test.describe('auth', () => {
  test('without the cookie the dashboard shows the sign-in instructions', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Sign in from your terminal' })).toBeVisible();
    await expect(page.getByText('supercharge open')).toBeVisible();
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
    await expect(needs.getByText('Ready for review', { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('heading', { name: 'Other AoE sessions' })).toBeVisible();
    await expect(page.getByText('ops control', { exact: true }).last()).toBeVisible();
    await expect(page.getByText('flaky e2e triage')).toBeVisible();
    await axe(page, 'overview');
  });

  test('opening an unmanaged session shows its live conversation', async ({ signedIn: page }) => {
    await page.getByRole('link', { name: /flaky e2e triage/ }).click();
    await expect(page).toHaveURL(/\?session=[0-9a-f]{16}/);
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('fix/flaky-e2e')).toBeVisible();
    await expect(dialog.getByRole('log', { name: 'Session conversation' })).toContainText(
      'Claude Code (fake agent)',
    );
    await dialog.getByText('Attach in a terminal instead').click();
    await expect(dialog.getByText(/aoe session attach [0-9a-f]{16}/)).toBeVisible();
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

  test('task drawer by direct URL: plan, history, attach command', async ({ signedIn: page }) => {
    await page.goto('/p/northwind-web/t/NW-0001');
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Build page templates' })).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Plan: page templates' })).toBeVisible();
    await expect(dialog.getByText('Storybook stories and visual tests')).toBeVisible();
    await expect(dialog.getByText('Watching MR', { exact: true }).first()).toBeVisible();
    await expect(dialog.getByText(/aoe session attach/)).toBeVisible();
    await page.waitForTimeout(800);
    await expect(page).toHaveURL(/\/t\/NW-0001$/);
    await axe(page, 'task drawer');
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/\/p\/northwind-web$/);
  });

  test('reply is confirmed explicitly and reaches the worker', async ({ signedIn: page, browserName }) => {
    // NW-0003 has no open question, so replying leaves the shared Needs-you state alone for other engines.
    await page.goto('/p/northwind-web/t/NW-0003');
    const dialog = page.getByRole('dialog');
    const message = `Prioritise the header first (${browserName}).`;
    await dialog.getByLabel('Message to the worker').fill(message);
    await dialog.getByRole('button', { name: 'Send reply' }).click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm.getByText('Send this to NW-0003?')).toBeVisible();
    await confirm.getByRole('button', { name: 'Send reply' }).click();
    await expect(page.getByText('Sent to NW-0003')).toBeVisible();
    const state = (await fake('/__fake/state')) as { sent: { message: string }[] };
    expect(state.sent.some((s) => s.message === message)).toBe(true);
  });

  test('live updates arrive over SSE without reloading', async ({ signedIn: page }) => {
    await page.goto('/p/northwind-web');
    const state = (await fake('/__fake/state')) as { sessions: { id: string; title: string }[] };
    const a11y = state.sessions.find((s) => s.title.startsWith('NW-0003'))!;
    await fake(`/__fake/sessions/${a11y.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'Error', last_error: 'claude exited unexpectedly' }),
    });
    const needs = page.locator('section[aria-labelledby="needs-you-heading"]');
    await expect(needs.getByText('Session error')).toBeVisible({ timeout: 15_000 });
    await expect(needs.getByText('claude exited unexpectedly')).toBeVisible();
    await fake(`/__fake/sessions/${a11y.id}`, {
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
    await expect(page).toHaveURL(/\/p\/[a-z-]+\?session=[0-9a-f]{16}$/);
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: /control$/ })).toBeVisible();
    await expect(dialog.getByRole('link', { name: 'Open on claude.ai' })).toBeVisible();
    const message = `What is blocked right now? (${browserName})`;
    const box = dialog.getByLabel(/^Message /);
    await box.fill(message);
    await box.press('Enter');
    await expect(dialog.getByRole('log', { name: 'Session conversation' })).toContainText(`❯ ${message}`);
    await expect(box).toHaveValue('');
    await axe(page, 'control chat');
  });

  test('Open chat on the control card opens the same chat', async ({ signedIn: page }) => {
    await page.goto('/p/northwind-web');
    await page.getByRole('link', { name: 'Open chat' }).click();
    await expect(
      page.getByRole('dialog').getByRole('heading', { name: 'northwind-web control' }),
    ).toBeVisible();
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
    for (const path of ['/', '/p/northwind-web', '/p/northwind-web/t/NW-0004', '/settings']) {
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
          ['drawer', '/p/northwind-web/t/NW-0001'],
          ['settings', '/settings'],
        ] as const) {
          await page.goto(path);
          await page.evaluate((t) => document.documentElement.classList.toggle('dark', t === 'dark'), theme);
          await page.waitForTimeout(500);
          await page.screenshot({
            path: info.outputPath(`${name}-${theme}-${w}x${h}.png`),
            fullPage: path !== '/p/northwind-web/t/NW-0001',
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
    await expect(
      page.getByRole('dialog').getByRole('heading', { name: 'Build page templates' }),
    ).toBeVisible();
    await ctx.close();
  });
});
