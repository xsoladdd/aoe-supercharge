import { axe, expect, fake, test } from './fixtures.ts';

/** The fake AoE id of the session whose title starts with `prefix`. */
async function sessionId(prefix: string): Promise<string> {
  const state = (await fake('/__fake/state')) as { sessions: { id: string; title: string }[] };
  return state.sessions.find((s) => s.title.startsWith(prefix))!.id;
}

const setStatus = async (id: string, status: string) =>
  fake(`/__fake/sessions/${id}`, { method: 'PATCH', body: JSON.stringify({ status, menu: null }) });

test.describe('office', () => {
  test('every open worker stands in exactly one place; the door queue is oldest first', async ({
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
    const rows = page.locator('li[data-role="worker"]');
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
    const since = await queue
      .locator(':scope > li')
      .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.since ?? ''));
    expect(since.length).toBeGreaterThan(0);
    expect([...since].sort()).toEqual(since);
    // The worker asking a question is in the queue with its reason, never colour alone.
    const rowena = queue.locator('li[data-task="NW-0002"]');
    if (await rowena.count()) await expect(rowena.getByText(/Question|Waiting in AoE/)).toBeVisible();

    await axe(page, 'office');
    await page.evaluate(() => document.documentElement.classList.remove('dark'));
    await page.waitForTimeout(400);
    await axe(page, 'office (light)');
    await page.evaluate(() => document.documentElement.classList.add('dark'));
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
