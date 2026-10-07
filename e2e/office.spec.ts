import { axe, expect, fake, test } from './fixtures.ts';

/** The fake AoE id of the session whose title starts with `prefix`. */
async function sessionId(prefix: string): Promise<string> {
  const state = (await fake('/__fake/state')) as { sessions: { id: string; title: string }[] };
  return state.sessions.find((s) => s.title.startsWith(prefix))!.id;
}

const setStatus = async (id: string, status: string) =>
  fake(`/__fake/sessions/${id}`, { method: 'PATCH', body: JSON.stringify({ status, menu: null }) });

test.describe('office', () => {
  test('every open worker stands in exactly one place; at the door, blockers first, then oldest first', async ({
    signedIn: page,
  }) => {
    await page.goto('/office');
    await expect(page.getByRole('heading', { level: 1, name: 'Office' })).toBeVisible();
    await expect(page.locator('[data-sidebar="menu-button"]', { hasText: 'Office' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    // The office queues what needs you at your door, so the strip stays away.
    await expect(page.getByRole('heading', { name: 'Needs you' })).toHaveCount(0);

    const snap = (await (await page.request.get('/api/snapshot')).json()) as {
      tasks: { id: string; project: string; stage: string }[];
    };
    const open = snap.tasks.filter((t) => t.stage !== 'done');
    // Task workers; others may come and go with the control-started sessions of other engines' tests.
    const rows = page.locator('li[data-role="worker"][data-task]');
    await expect(rows).toHaveCount(open.length);
    for (const t of open)
      await expect(page.locator(`li[data-task="${t.id}"][data-project="${t.project}"]`)).toHaveCount(1);
    // Done workers have gone home.
    for (const t of snap.tasks.filter((x) => x.stage === 'done'))
      await expect(page.locator(`li[data-task="${t.id}"]`)).toHaveCount(0);

    // Each row sits in the section for its zone.
    for (const zone of ['door', 'desk', 'pantry', 'away']) {
      const section = page.locator(`[data-zone-section="${zone}"]`);
      const inside = section.locator('li[data-zone]');
      for (const z of await inside.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.zone)))
        expect(z).toBe(zone);
    }

    const queue = page.getByRole('list', { name: 'Queue at your door' });
    await expect(queue).toBeVisible();
    const line = await queue.locator(':scope > li').evaluateAll((els) =>
      els.map((e) => ({
        since: (e as HTMLElement).dataset.since ?? '',
        blocks: (e as HTMLElement).dataset.blocks === 'true',
      })),
    );
    expect(line.length).toBeGreaterThan(0);
    // Whoever blocks work stands in front; each part of the line is oldest first.
    const blockers = line.filter((r) => r.blocks);
    expect(line.slice(0, blockers.length).every((r) => r.blocks)).toBe(true);
    for (const part of [blockers, line.filter((r) => !r.blocks)]) {
      const since = part.map((r) => r.since);
      expect([...since].sort()).toEqual(since);
    }
    // The worker asking a question is in the queue with its reason, never colour alone.
    const rowena = queue.locator('li[data-task="NW-0002"]');
    if (await rowena.count()) await expect(rowena.getByText(/Question|Waiting in AoE/)).toBeVisible();

    await axe(page, 'office');
    await page.evaluate(() => document.documentElement.classList.remove('dark'));
    await page.waitForTimeout(400);
    await axe(page, 'office (light)');
    await page.evaluate(() => document.documentElement.classList.add('dark'));
  });

  test('the daemon keeps an office history of who went where', async ({ signedIn: page }) => {
    const from = new Date(Date.now() - 6 * 60 * 60_000).toISOString();
    await expect
      .poll(async () => {
        const res = await page.request.get(`/api/office/history?from=${from}`);
        const h = (await res.json()) as { records: { type: string; key?: string }[] };
        return h.records.filter((r) => r.type === 'move').length;
      })
      .toBeGreaterThan(0);
    const one = (await (
      await page.request.get(`/api/office/history?from=${from}&project=northwind-web`)
    ).json()) as { start: { chars: { project: string }[] }; records: { type: string; project?: string }[] };
    expect(one.records.every((r) => r.type === 'frame' || r.project === 'northwind-web')).toBe(true);
    expect(one.start.chars.every((c) => c.project === 'northwind-web')).toBe(true);
  });

  test('a worker walks to your door when it starts waiting, and back to its desk', async ({
    signedIn: page,
  }) => {
    const id = await sessionId('NW-0003');
    await setStatus(id, 'Running');
    await page.goto('/office');
    const row = page.locator('li[data-task="NW-0003"]');
    await expect(row).toHaveAttribute('data-zone', 'desk', { timeout: 15_000 });
    await expect(page.locator('[data-team="northwind-web"] li[data-task="NW-0003"]')).toContainText('Desk');
    try {
      await setStatus(id, 'Waiting');
      await expect(row).toHaveAttribute('data-zone', 'door', { timeout: 15_000 });
      await expect(row).toContainText('Waiting in AoE');
      await expect(page.getByRole('status').filter({ hasText: /is waiting at your door/ })).toBeAttached();
      await setStatus(id, 'Running');
      await expect(row).toHaveAttribute('data-zone', 'desk', { timeout: 15_000 });
    } finally {
      await setStatus(id, 'Running');
    }
  });

  test('a session the control chat started through AoE works at a desk in its team', async ({
    signedIn: page,
    browserName,
  }) => {
    const control = await sessionId('northwind-web control');
    const title = `aoe-tester ${browserName}`;
    const { id } = (await fake('/__fake/sessions', {
      method: 'POST',
      body: JSON.stringify({
        title,
        project_path: `/tmp/northwind-tester-${browserName}`,
        parent_session_id: control,
        status: 'Running',
      }),
    })) as { id: string };
    try {
      await page.goto('/office?view=list');
      const row = page.locator(`li[data-session="${id}"]`);
      await expect(row).toHaveAttribute('data-zone', 'desk', { timeout: 15_000 });
      await expect(row).toHaveAttribute('data-project', 'northwind-web');
      await expect(row.getByText(title)).toBeVisible();
      // Named like a task's worker the first time the daemon sees it, and kept with the project.
      let name = '';
      await expect
        .poll(async () => {
          const snap = (await (await page.request.get('/api/snapshot')).json()) as {
            projects: { name: string; crew?: Record<string, string> }[];
          };
          return (name = snap.projects.find((p) => p.name === 'northwind-web')?.crew?.[id] ?? '');
        })
        .toMatch(/^[A-Z][a-z]+( [IVX]+)?$/);
      await expect(row.getByText(name, { exact: true })).toBeVisible();
      await page.goto(`/chat/${id}`);
      await expect(page.getByRole('navigation', { name: 'breadcrumb' })).toContainText(name);
      await page.goto('/office?view=list');
      await setStatus(id, 'Stopped');
      await expect(row).toHaveAttribute('data-zone', 'away', { timeout: 15_000 });
    } finally {
      await fake(`/__fake/sessions/${id}`, { method: 'DELETE' });
    }
  });

  test("a control chat's NEEDS YOU list waits on you until a reply has none", async ({
    signedIn: page,
    browserName,
  }) => {
    const mk = (body: Record<string, unknown>) =>
      fake('/__fake/sessions', { method: 'POST', body: JSON.stringify(body) }) as Promise<{ id: string }>;
    // A control chat of its own (it has a worker), so other engines' lines are left alone.
    const control = await mk({
      title: `boss ${browserName}`,
      project_path: `/tmp/boss-${browserName}`,
      status: 'Idle',
    });
    const worker = await mk({
      title: `boss-worker ${browserName}`,
      project_path: `/tmp/boss-${browserName}-w`,
      parent_session_id: control.id,
      status: 'Running',
    });
    const reply = (text: string) =>
      fake(`/__fake/sessions/${control.id}/reply`, { method: 'POST', body: JSON.stringify({ text }) });
    try {
      await reply(
        [
          'Both testers are running.',
          '',
          '🔴 **NEEDS YOU**',
          `1. **Owner (${browserName}):** who sets the brand on the catalogue?`,
          `2. **Quote (${browserName}):** may the tester edit it? Blocked until you say.`,
          '',
          '🟡 **WORKING**',
          '- tester: checking the header',
        ].join('\n'),
      );
      await page.goto('/');
      const needs = page.locator('section[aria-labelledby="needs-you-heading"]');
      const blocker = needs.locator('li', { hasText: `Quote (${browserName})` });
      await expect(blocker.getByText('Blocked on you')).toBeVisible({ timeout: 15_000 });
      await expect(
        needs.locator('li', { hasText: `Owner (${browserName})` }).getByText('Control chat needs you'),
      ).toBeVisible();
      await reply('All done, nothing needs you.');
      await expect(needs.getByText(`Quote (${browserName})`)).toHaveCount(0, { timeout: 15_000 });
    } finally {
      for (const id of [worker.id, control.id]) await fake(`/__fake/sessions/${id}`, { method: 'DELETE' });
    }
  });

  test('an idle worker finishes up at its desk, then takes a break in the pantry', async ({
    signedIn: page,
  }) => {
    const id = await sessionId('NW-0003');
    await setStatus(id, 'Running');
    await page.goto('/office');
    const row = page.locator('li[data-task="NW-0003"]');
    await expect(row).toHaveAttribute('data-zone', 'desk', { timeout: 15_000 });
    try {
      await setStatus(id, 'Idle');
      await page.waitForTimeout(4_000);
      // Still finishing up: the pantry waits for 15 seconds of idle.
      await expect(row).toHaveAttribute('data-zone', 'desk');
      await expect(row).toHaveAttribute('data-zone', 'pantry', { timeout: 25_000 });
      await expect(page.locator('[data-zone-section="pantry"] li[data-task="NW-0003"]')).toContainText(
        'Idle',
      );
    } finally {
      await setStatus(id, 'Running');
    }
  });

  test('Show in office from the right-click menu highlights that worker', async ({ signedIn: page }) => {
    await page.goto('/p/northwind-web');
    await page
      .getByRole('list', { name: 'Workers' })
      .getByRole('link', { name: /NW-0003/ })
      .click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Show in office' }).click();
    await expect(page).toHaveURL(/\/office\?worker=NW-0003&project=northwind-web$/);
    // On the floor the row picks the worker; in the list it opens the task. Either way it is the one.
    const row = page.locator('li[data-task="NW-0003"] [data-worker]');
    await expect(row).toHaveAttribute('aria-current', 'true');
    await expect(row).toBeFocused();
    await expect(page.locator('[data-office-floor]')).toHaveAttribute(
      'data-selected',
      'northwind-web/NW-0003',
    );
    await page.goto('/office?view=list&worker=NW-0003&project=northwind-web');
    const link = page.locator('li[data-task="NW-0003"] a');
    await expect(link).toHaveAttribute('aria-current', 'true');
    await expect(link).toBeFocused();
  });

  test('your name goes on the office door', async ({ signedIn: page }) => {
    await page.goto('/settings');
    const name = page.getByRole('textbox', { name: 'Your name' });
    await expect(page.getByText('On your door in the office: Your office.')).toBeVisible();
    await name.fill('Ericson');
    await name.press('Enter');
    await expect(page.getByText('Door sign updated').last()).toBeVisible();
    try {
      await page.goto('/office');
      await expect(page.getByRole('heading', { name: 'Ericson’s office' })).toBeVisible();
    } finally {
      await page.goto('/settings');
      await page.getByRole('textbox', { name: 'Your name' }).fill('');
      await page.getByRole('textbox', { name: 'Your name' }).press('Enter');
      await expect(page.getByText('Door sign updated').last()).toBeVisible();
    }
    await page.goto('/office');
    await expect(page.getByRole('heading', { name: 'Your office' })).toBeVisible();
  });

  test.describe('the floor', () => {
    const floor = (page: import('@playwright/test').Page) => page.locator('[data-office-floor]');
    const drawn = async (page: import('@playwright/test').Page) => {
      await expect(floor(page)).toHaveAttribute('data-renderer', /^(webgl|webgpu|canvas)$/);
      await expect(page.getByRole('application', { name: /Office floor/ })).toBeVisible();
    };

    test('draws the office; the chips fly the camera; nothing is drawn while nobody moves', async ({
      signedIn: page,
    }) => {
      await page.goto('/office');
      await drawn(page);
      await expect(floor(page)).toHaveAttribute('data-camera-focus', 'office');
      const chips = page.getByRole('navigation', { name: 'Go to' });
      await chips.getByRole('button', { name: 'Pantry' }).click();
      await expect(floor(page)).toHaveAttribute('data-camera-focus', 'pantry');
      await expect(chips.getByRole('button', { name: 'Pantry' })).toHaveAttribute('aria-pressed', 'true');
      await chips.getByRole('button', { name: 'northwind-web' }).click();
      await expect(floor(page)).toHaveAttribute('data-camera-focus', 'northwind-web');
      await chips.getByRole('button', { name: 'Your office' }).click();
      await expect(floor(page)).toHaveAttribute('data-camera-focus', 'door');

      // Dragging hands the camera to you.
      const box = (await page.getByRole('application').boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height - 40);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 - 120, box.y + box.height - 80, { steps: 6 });
      await page.mouse.up();
      await expect(floor(page)).toHaveAttribute('data-camera-focus', 'free');

      // Keyboard: 0 shows the whole office again.
      await page.getByRole('application').focus();
      await page.keyboard.press('0');
      await expect(floor(page)).toHaveAttribute('data-camera-focus', 'office');

      // Render on demand: once the camera settles and nobody walks, no frames are drawn at all.
      // (A worker from an earlier test may still be walking back, so wait for a quiet second.)
      const app = page.getByRole('application');
      await expect
        .poll(
          async () => {
            const before = await app.getAttribute('data-frames');
            await page.waitForTimeout(1000);
            return (await app.getAttribute('data-frames')) === before;
          },
          { timeout: 15_000 },
        )
        .toBe(true);
      await axe(page, 'office floor');
    });

    test('the office opens in a window of its own; what you open there opens in the dashboard', async ({
      signedIn: page,
    }) => {
      await page.goto('/office');
      await drawn(page);
      const [win] = await Promise.all([
        page.context().waitForEvent('page'),
        page.getByRole('button', { name: 'New window' }).click(),
      ]);
      await expect(win).toHaveURL(/\/office\/window$/);
      await drawn(win);
      await expect(win).toHaveTitle('Office · Supercharge');
      // Just the office: no sidebar or header, and no way to open yet another window.
      await expect(win.locator('[data-sidebar="sidebar"]')).toHaveCount(0);
      await expect(win.getByRole('button', { name: 'New window' })).toHaveCount(0);
      await axe(win, 'office window');
      await win.locator('[data-worker="northwind-web/NW-0003"]').click();
      await win
        .locator('[data-worker-card="northwind-web/NW-0003"]')
        .getByRole('link', { name: 'Open task' })
        .click();
      await expect(page).toHaveURL(/\/p\/northwind-web\/t\/NW-0003$/);
      await expect(win).toHaveURL(/\/office\/window$/);
      await win.close();
    });

    test('picking a team lead lets you message its control chat', async ({ signedIn: page, browserName }) => {
      const control = await sessionId('northwind-web control');
      await page.goto('/office');
      await drawn(page);
      await page.locator('[data-worker="northwind-web/lead"]').click();
      const card = page.locator('[data-worker-card="northwind-web/lead"]');
      const box = card.getByRole('textbox', { name: 'Message the control chat' });
      await expect(box).toBeFocused();
      await axe(page, 'office lead card');
      // Nothing to send yet.
      await card.getByRole('button', { name: 'Send' }).click();
      await expect(card.getByRole('alert')).toHaveText('Write a message first.');
      const message = `Pick up the footer copy next (${browserName})`;
      await box.fill(message);
      await box.press('Enter');
      await expect(box).toHaveValue('');
      await expect
        .poll(async () => {
          const state = (await fake('/__fake/state')) as { sent: { id: string; message: string }[] };
          return state.sent.filter((m) => m.id === control).at(-1)?.message;
        })
        .toBe(message);
    });

    test('picking a worker in the list opens its card and flies to it', async ({ signedIn: page }) => {
      await page.goto('/office');
      await drawn(page);
      await page.locator('[data-worker="northwind-web/NW-0003"]').click();
      const card = page.locator('[data-worker-card="northwind-web/NW-0003"]');
      await expect(card).toBeVisible();
      await expect(card.getByRole('link', { name: 'Open task' })).toHaveAttribute(
        'href',
        '/p/northwind-web/t/NW-0003',
      );
      await expect(floor(page)).toHaveAttribute('data-camera-focus', 'northwind-web/NW-0003');
      await expect(floor(page)).toHaveAttribute('data-selected', 'northwind-web/NW-0003');
      await card.getByRole('button', { name: 'Follow' }).click();
      await expect(card.getByRole('button', { name: 'Follow' })).toHaveAttribute('aria-pressed', 'true');
      await axe(page, 'office worker card');
      await page.keyboard.press('Escape');
      await expect(card).toHaveCount(0);
      await expect(floor(page)).toHaveAttribute('data-selected', '');
    });

    test('a worker walks across the floor when its status changes', async ({ signedIn: page }) => {
      const id = await sessionId('NW-0003');
      await setStatus(id, 'Running');
      await page.goto('/office');
      await drawn(page);
      const row = page.locator('li[data-task="NW-0003"]');
      await expect(row).toHaveAttribute('data-zone', 'desk', { timeout: 15_000 });
      await expect(floor(page)).toHaveAttribute('data-motion', 'walk');
      await expect(floor(page)).toHaveAttribute('data-walking', '0');
      // Record every walking count the floor reports, so a short walk is not missed between polls.
      await floor(page).evaluate((el) => {
        const seen: string[] = [];
        (window as unknown as { __walking: string[] }).__walking = seen;
        new MutationObserver(() => seen.push((el as HTMLElement).dataset.walking ?? '')).observe(el, {
          attributes: true,
          attributeFilter: ['data-walking'],
        });
      });
      try {
        await setStatus(id, 'Waiting');
        await expect(row).toHaveAttribute('data-zone', 'door', { timeout: 15_000 });
        await expect(floor(page)).toHaveAttribute('data-walking', '0', { timeout: 15_000 });
        const seen = await page.evaluate(() => (window as unknown as { __walking: string[] }).__walking);
        expect(seen.some((n) => Number(n) > 0)).toBe(true);
      } finally {
        await setStatus(id, 'Running');
      }
      await expect(row).toHaveAttribute('data-zone', 'desk', { timeout: 15_000 });
    });

    test('Call next brings the first in line in; closing the card sends them back', async ({
      signedIn: page,
    }) => {
      await page.goto('/office');
      await drawn(page);
      const first = page.getByRole('list', { name: 'Queue at your door' }).locator(':scope > li').first();
      const key = await first.locator('[data-worker]').getAttribute('data-worker');
      await page.getByRole('button', { name: /^Call next/ }).click();
      await expect(floor(page)).toHaveAttribute('data-called', key!);
      await expect(floor(page)).toHaveAttribute('data-camera-focus', 'door');
      const card = page.locator(`[data-worker-card="${key}"]`);
      await expect(card).toBeVisible();
      await expect(card.getByText('In your office')).toBeVisible();
      await card.getByRole('button', { name: 'Close' }).click();
      await expect(floor(page)).toHaveAttribute('data-called', '');
      await expect(floor(page)).toHaveAttribute('data-walking', '0', { timeout: 10_000 });
    });

    test('with reduced motion, workers jump instead of walking', async ({ browser }) => {
      const ctx = await browser.newContext({
        reducedMotion: 'reduce',
        viewport: { width: 1440, height: 900 },
      });
      const page = await ctx.newPage();
      const { signIn } = await import('./fixtures.ts');
      await signIn(page);
      const id = await sessionId('NW-0003');
      await setStatus(id, 'Running');
      await page.goto('/office');
      await drawn(page);
      await expect(floor(page)).toHaveAttribute('data-motion', 'jump');
      const row = page.locator('li[data-task="NW-0003"]');
      await expect(row).toHaveAttribute('data-zone', 'desk', { timeout: 15_000 });
      await floor(page).evaluate((el) => {
        const seen: string[] = [];
        (window as unknown as { __walking: string[] }).__walking = seen;
        new MutationObserver(() => seen.push((el as HTMLElement).dataset.walking ?? '')).observe(el, {
          attributes: true,
          attributeFilter: ['data-walking'],
        });
      });
      try {
        await setStatus(id, 'Waiting');
        await expect(row).toHaveAttribute('data-zone', 'door', { timeout: 15_000 });
        await page.waitForTimeout(500);
        const seen = await page.evaluate(() => (window as unknown as { __walking: string[] }).__walking);
        expect(seen.filter((n) => n !== '0')).toEqual([]);
      } finally {
        await setStatus(id, 'Running');
        await ctx.close();
      }
    });

    test('without a canvas, the list stands in', async ({ signedIn: page }) => {
      await page.addInitScript(() => {
        HTMLCanvasElement.prototype.getContext = () => null;
      });
      await page.goto('/office');
      await expect(floor(page)).toHaveAttribute('data-renderer', 'fallback');
      await expect(page.getByRole('note')).toContainText('The office floor could not start here.');
      await expect(page.getByRole('application')).toBeHidden();
      // The rows go back to being links to each task.
      await expect(page.locator('li[data-task="NW-0003"] a')).toHaveAttribute(
        'href',
        '/p/northwind-web/t/NW-0003',
      );
      await axe(page, 'office fallback');
    });
  });
});
