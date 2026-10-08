import { timeDifference } from '../packages/core/src/shared/office-ambience.ts';
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
    for (const zone of ['door', 'desk', 'review', 'pantry', 'away']) {
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

  test('an MR ready for review waits in the review lounge with a green folder and its MR badge', async ({
    signedIn: page,
  }) => {
    await page.goto('/office?view=list');
    const lounge = page.locator('[data-zone-section="review"]');
    await expect(lounge.getByRole('heading', { name: 'Review lounge' })).toBeVisible();
    // NW-0004's MR is ready: it waits here, not at your door, and still shows in Needs you.
    const row = lounge.locator('li[data-task="NW-0004"]');
    await expect(row).toHaveAttribute('data-zone', 'review', { timeout: 20_000 });
    await expect(row.getByText('MR ready for review')).toBeVisible();
    await expect(
      page.getByRole('list', { name: 'Queue at your door' }).locator('li[data-task="NW-0004"]'),
    ).toHaveCount(0);
    const badge = row.getByRole('link', { name: /^MR !38: pipeline passed, 0 open review threads/ });
    await expect(badge).toHaveAttribute(
      'href',
      'https://gitlab.example.com/northwind/web/-/merge_requests/38',
    );
    await expect(badge).toHaveAttribute('target', '_blank');
    await expect(badge).toHaveAttribute('rel', /noopener/);
    // AA-0003 has no MR (apollo-api merges branches directly): its branch is ready to merge.
    const branchRow = lounge.locator('li[data-task="AA-0003"]');
    await expect(branchRow).toHaveAttribute('data-zone', 'review', { timeout: 20_000 });
    await expect(branchRow.getByText('Branch ready to merge')).toBeVisible();
    await expect(branchRow.locator('[data-branch-badge^="sc/aa-0003-"]')).toBeVisible();
    await axe(page, 'office list with the review lounge');
    // The floor's header counts the lounge, and its chip flies there.
    await page.goto('/office');
    const floor = page.locator('[data-office-floor]');
    await expect(floor).toHaveAttribute('data-renderer', /^(webgl|webgpu|canvas)$/);
    await expect(page.getByText(/\d+ in review/)).toBeVisible();
    await page
      .getByRole('navigation', { name: 'Go to' })
      .getByRole('button', { name: 'Review lounge' })
      .click();
    await expect(floor).toHaveAttribute('data-camera-focus', 'review');
  });

  test('the header has clocks for home and away; the weather is off until turned on; the light follows the work', async ({
    signedIn: page,
  }) => {
    const setOffice = (patch: Record<string, unknown>) =>
      page.evaluate(async (office) => {
        const { token } = (await (await fetch('/api/csrf')).json()) as { token: string };
        const res = await fetch('/api/config', {
          method: 'PUT',
          headers: { 'content-type': 'application/json', 'x-csrf-token': token },
          body: JSON.stringify({ patch: { office } }),
        });
        return res.status;
      }, patch);
    await page.goto('/office');
    const clocks = page.locator('[data-office-floor] [data-office-clocks]');
    await expect(clocks.locator('[data-clock="home"]')).toContainText(/Stockholm\s*\d\d:\d\d/);
    await expect(clocks.locator('[data-clock="away"]')).toContainText(/Manila\s*\d\d:\d\d/);
    // The difference comes from the time zones, so it is right either side of a DST change.
    const diff = timeDifference('Europe/Stockholm', 'Asia/Manila', new Date());
    await expect(clocks).toHaveAttribute('data-difference', String(diff.minutes));
    await expect(clocks.locator('[data-time-difference]')).toHaveText(diff.label);
    // Off by default: no weather, and the windows follow the office's own light.
    await expect(clocks.locator('[data-weather]')).toHaveCount(0);
    const floor = page.locator('[data-office-floor]');
    await expect(floor).toHaveAttribute('data-windows', 'activity');
    // Workers are working in the demo: the lights are up.
    await expect(floor).toHaveAttribute('data-light', 'day');

    try {
      // Turned on, the daemon fetches it (here from the fake, standing in for Open-Meteo).
      expect(await setOffice({ weather: { enabled: true }, windows: 'weather' })).toBe(200);
      const weather = clocks.locator('[data-weather="rain"]');
      await expect(weather).toContainText('5°C', { timeout: 15_000 });
      await expect(weather).toHaveAttribute('title', /Rain, 4\.5°C in Stockholm/);
      await expect(floor).toHaveAttribute('data-windows', 'rain');
      await axe(page, 'office: clocks and weather');
      // The list view has the clocks too.
      await page.goto('/office?view=list');
      await expect(page.locator('[data-office-clocks] [data-weather="rain"]')).toBeVisible();
      // Another place's clock: the difference follows.
      expect(await setOffice({ clocks: { away: 'Asia/Kolkata' } })).toBe(200);
      const kolkata = timeDifference('Europe/Stockholm', 'Asia/Kolkata', new Date());
      await expect(page.locator('[data-office-clocks] [data-time-difference]')).toHaveText(kolkata.label);
      expect(await setOffice({ clocks: { away: 'Not/AZone' } })).toBe(422);
    } finally {
      await setOffice({ weather: { enabled: false }, windows: 'activity', clocks: { away: 'Asia/Manila' } });
    }
    await expect(page.locator('[data-office-clocks] [data-weather]')).toHaveCount(0, { timeout: 15_000 });
  });

  test('every worker shows what its conversation cost, as an estimate; a runaway is flagged', async ({
    signedIn: page,
  }) => {
    const setTokenLimit = (n: number) =>
      page.evaluate(async (limit) => {
        const { token } = (await (await fetch('/api/csrf')).json()) as { token: string };
        const res = await fetch('/api/config', {
          method: 'PUT',
          headers: { 'content-type': 'application/json', 'x-csrf-token': token },
          body: JSON.stringify({ patch: { office: { runaway: { sessionTokens: limit } } } }),
        });
        return res.status;
      }, n);
    // NW-0003's worker has a conversation: tokens from its transcript, priced as an estimate.
    await page.goto('/office?view=list');
    const row = page.locator('li[data-task="NW-0003"]');
    await expect(row.locator('[data-cost]')).toContainText(/≈ \$\d+\.\d\d · \d+k? tokens/, {
      timeout: 30_000,
    });
    await page.goto('/office');
    await expect(page.locator('[data-office-floor]')).toHaveAttribute(
      'data-renderer',
      /^(webgl|webgpu|canvas)$/,
    );
    const header = page.locator('[data-office-cost]');
    await expect(header).toContainText(/Today ≈ \$\d+\.\d\d · now ≈ \$\d+\.\d\d \(estimate\)/);
    await expect(header).toHaveAttribute('title', /Estimate/);
    try {
      // A limit everyone is over: they are all flagged, with a toast and a count in the header.
      expect(await setTokenLimit(1)).toBe(200);
      const attention = page.locator('[data-attention]');
      await expect(attention).toBeVisible({ timeout: 30_000 });
      await expect(attention).toContainText(/\d+ needs? attention/);
      await expect(page.getByText(/may be a runaway/).first()).toBeVisible();
      // A control chat is never flagged, however far over the limit it is.
      await expect(page.getByText(/control chat may be a runaway/)).toHaveCount(0);
      await page.goto('/office?view=list');
      await expect(row.locator('[data-runaway="tokens"]')).toContainText('Over the token limit');
      await expect(page.locator('li[data-role="lead"] [data-runaway]')).toHaveCount(0);
      await axe(page, 'office list with a runaway');
    } finally {
      expect(await setTokenLimit(50_000_000)).toBe(200);
    }
    await expect(row.locator('[data-runaway]')).toHaveCount(0, { timeout: 30_000 });
  });

  test('history mode replays the office: scrub, play, filter, and Back to Live', async ({
    signedIn: page,
  }) => {
    await page.goto('/office');
    const floor = page.locator('[data-office-floor]');
    await page.locator('[data-history-button]').click();
    await expect(floor).toHaveAttribute('data-history', 'ready');
    const bar = page.getByRole('region', { name: 'Office history' });
    await expect(bar.getByRole('button', { name: 'Back to Live' })).toBeVisible();
    // The past is for looking at: no spend, no Call next.
    await expect(page.locator('[data-office-cost]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Call next/ })).toHaveCount(0);

    // Four and a quarter hours ago (the made-up history): Percival waits on a pipeline in the lounge,
    // Isolde works at a desk.
    const scrubber = bar.getByRole('slider', { name: 'Time' });
    // The made-up history is written when the suite starts (its first frame 7 hours before that); time
    // it from then, so a later engine scrubs to the same moments.
    const since = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    const seeded = (await (await page.request.get(`/api/office/history?from=${since}`)).json()) as {
      records: { type: string; ts: string; key?: string }[];
    };
    const firstFrame = Math.min(
      ...seeded.records.filter((r) => r.type === 'frame').map((r) => Date.parse(r.ts)),
    );
    const seededAt = firstFrame + 7 * 60 * 60 * 1000;
    const scrubTo = async (hoursAgo: number) => {
      const min = Number(await scrubber.getAttribute('min'));
      const t = seededAt - hoursAgo * 60 * 60 * 1000;
      await scrubber.fill(String(min + Math.round((t - min) / 1000) * 1000));
    };
    await scrubTo(4.25);
    const roster = page.locator('#office-roster');
    const percival = roster.locator('li[data-task="NW-0090"]');
    await expect(percival).toHaveAttribute('data-zone', 'review');
    await expect(roster.locator('[data-mr-badge="31"]')).toBeVisible();
    await expect(roster.locator('li[data-task="AA-0090"]')).toHaveAttribute('data-zone', 'desk');
    await expect(roster.locator('li[data-task="NW-0091"]')).toHaveCount(0);
    await axe(page, 'office history');

    // Narrowed to one project, then to one agent.
    await bar.getByRole('combobox', { name: 'Project' }).selectOption('apollo-api');
    await expect(percival).toHaveCount(0);
    await expect(roster.locator('li[data-task="AA-0090"]')).toHaveCount(1);
    await bar.getByRole('combobox', { name: 'Agent' }).selectOption({ label: 'Isolde (apollo-api)' });
    await expect(roster.locator('li[data-role="worker"]')).toHaveCount(1);
    await bar.getByRole('combobox', { name: 'Project' }).selectOption('');

    // Later: Isolde's pipeline failed, Percival has gone home.
    await scrubTo(1.4);
    await expect(roster.locator('li[data-task="AA-0090"]')).toHaveAttribute('data-zone', 'review');
    await expect(roster.locator('li[data-task="AA-0090"]')).toContainText('Pipeline failed');
    await bar.getByRole('combobox', { name: 'Agent' }).selectOption('');
    await expect(roster.locator('li[data-task="AA-0090"]')).toHaveCount(1);
    await expect(percival).toHaveCount(0);

    // Play runs the clock on; pause stops it.
    await scrubTo(6);
    const time = bar.locator('[data-history-time]');
    const before = await time.textContent();
    await bar.getByRole('button', { name: '60×' }).click();
    await bar.getByRole('button', { name: 'Play' }).click();
    await expect(time).not.toHaveText(before ?? '', { timeout: 5_000 });
    await bar.getByRole('button', { name: 'Pause' }).click();
    await expect(bar.getByRole('button', { name: 'Play' })).toHaveAttribute('aria-pressed', 'false');

    // Back to Live: today's office again.
    await bar.getByRole('button', { name: 'Back to Live' }).click();
    await expect(floor).not.toHaveAttribute('data-history', /./);
    await expect(page.locator('[data-office-cost]')).toBeVisible();
    await expect(roster.locator('li[data-task="NW-0090"]')).toHaveCount(0);
  });

  test('"Since I was away" sums up what happened', async ({ signedIn: page }) => {
    await page.goto('/office');
    await page.locator('[data-away-button]').click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('combobox', { name: 'Since' }).selectOption({ label: '8 hours ago' });
    await expect(dialog.locator('[data-away-headline]')).toContainText(/\d+ agents? finished/);
    await expect(dialog.locator('[data-away-headline]')).toContainText(/\d+ MRs? raised/);
    await expect(dialog.locator('[data-away-headline]')).toContainText(/≈ \$\d+\.\d\d spent/);
    const events = dialog.getByRole('list', { name: 'What happened' });
    await expect(events.locator('[data-away-event="finished"]', { hasText: 'Percival' })).toBeVisible();
    await expect(events.locator('[data-away-event="mr_raised"]', { hasText: 'Raised !31' })).toBeVisible();
    await expect(
      events.locator('[data-away-event="failed"]', { hasText: 'Pipeline failed on !11' }),
    ).toContainText('Isolde');
    await expect(events.locator('[data-away-event="needed_you"]', { hasText: 'Tristan' })).toBeVisible();
    await axe(page, 'since I was away');
    // An hour back, the morning's work is not in it.
    await dialog.getByRole('combobox', { name: 'Since' }).selectOption({ label: 'An hour ago' });
    await expect(dialog.locator('[data-away-headline]')).toBeVisible();
    await expect(events.locator('[data-away-event="finished"]', { hasText: 'Percival' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
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

  test('a session with no task whose branch has an MR waits in the review lounge with its badge', async ({
    signedIn: page,
    browserName,
  }) => {
    const control = await sessionId('northwind-web control');
    const iid = 51 + ['chromium', 'firefox', 'webkit'].indexOf(browserName);
    const { id } = (await fake('/__fake/sessions', {
      method: 'POST',
      body: JSON.stringify({
        title: `hero copy ${browserName}`,
        project_path: `/tmp/northwind-hero-${browserName}`,
        branch: `fix/hero-copy-${browserName}`,
        parent_session_id: control,
        status: 'Idle',
      }),
    })) as { id: string };
    try {
      await page.goto('/office?view=list');
      const lounge = page.locator('[data-zone-section="review"]');
      const row = lounge.locator(`li[data-session="${id}"]`);
      // Found on the MR watcher's next round (every 10 s here), then past the pantry dwell.
      await expect(row).toHaveAttribute('data-zone', 'review', { timeout: 45_000 });
      await expect(row.getByText('MR ready for review')).toBeVisible();
      const badge = row.getByRole('link', {
        name: new RegExp(`^MR !${iid}: pipeline passed, 0 open review threads`),
      });
      await expect(badge).toHaveAttribute(
        'href',
        `https://gitlab.example.com/northwind/web/-/merge_requests/${iid}`,
      );
      // Back to work: back at a desk.
      await setStatus(id, 'Running');
      await expect(page.locator(`li[data-session="${id}"]`)).toHaveAttribute('data-zone', 'desk', {
        timeout: 15_000,
      });
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

  test('a watch notice and the reply to it leave the NEEDS YOU list alone; your reply clears it', async ({
    signedIn: page,
    browserName,
  }) => {
    const mk = (body: Record<string, unknown>) =>
      fake('/__fake/sessions', { method: 'POST', body: JSON.stringify(body) }) as Promise<{ id: string }>;
    const control = await mk({
      title: `notice boss ${browserName}`,
      project_path: `/tmp/notice-boss-${browserName}`,
      status: 'Idle',
    });
    const worker = await mk({
      title: `notice-worker-${browserName}`,
      project_path: `/tmp/notice-boss-${browserName}-w`,
      parent_session_id: control.id,
      status: 'Running',
    });
    const send = (message: string) =>
      fake('/__fake/send', { method: 'POST', body: JSON.stringify({ id: control.id, message }) });
    const item = `Deploy (${browserName}): staging or prod? Blocked until you say.`;
    try {
      await fake(`/__fake/sessions/${control.id}/reply`, {
        method: 'POST',
        body: JSON.stringify({
          text: ['🔴 NEEDS YOU', `1. ${item}`, '', '🟡 WORKING', '- worker: on it'].join('\n'),
        }),
      });
      await page.goto('/');
      const needs = page.locator('section[aria-labelledby="needs-you-heading"]');
      await expect(needs.getByText(item)).toBeVisible({ timeout: 15_000 });
      // A notice arrives; Claude answers it without restating the list.
      await send(`[WATCH] worker="notice-worker-${browserName}" status=idle kind=done log=/tmp/w.txt`);
      await page.goto(`/chat/${control.id}`);
      const chat = page.getByRole('log', { name: /^Conversation with/ });
      await expect(
        chat.getByRole('note', { name: `Watch notice: notice-worker-${browserName}, done` }),
      ).toBeVisible({
        timeout: 15_000,
      });
      await expect(chat.getByText('I’ll take it from here')).toBeVisible({ timeout: 15_000 });
      await page.goto('/');
      await page.waitForTimeout(3_000);
      await expect(needs.getByText(item)).toBeVisible();
      // You answer; Claude's reply has nothing under NEEDS YOU.
      await send('Staging first.');
      await expect(needs.getByText(item)).toHaveCount(0, { timeout: 15_000 });
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

  test('a worker idle in the pantry is asked to go home: Keep, Archive with a confirmation, Restore, and coming back', async ({
    signedIn: page,
  }) => {
    const mark = (key: string, action: string) =>
      page.evaluate(
        async ([k, a]) => {
          const { token } = (await (await fetch('/api/csrf')).json()) as { token: string };
          const res = await fetch('/api/office/marks', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-csrf-token': token },
            body: JSON.stringify({ key: k, action: a }),
          });
          return { status: res.status, body: (await res.json()) as Record<string, unknown> };
        },
        [key, action] as const,
      );
    const id = await sessionId('NW-0003');
    const key = 'northwind-web/NW-0003';
    await setStatus(id, 'Idle');
    try {
      // Half an hour on: the dashboard's clock runs ahead, so the 30-minute prompt is due now.
      await page.clock.setFixedTime(new Date(Date.now() + 31 * 60_000));
      await page.goto('/office?view=list');
      const row = page.locator('li[data-task="NW-0003"]');
      await expect(row).toHaveAttribute('data-zone', 'pantry', { timeout: 20_000 });
      const prompt = page.locator(`[data-go-home="${key}"]`);
      await expect(prompt).toContainText(/Idle \d+m\. Go home\?/);
      await axe(page, 'office: go home prompt');

      // Keep: not asked again for this idle stretch.
      await prompt.getByRole('button', { name: 'Keep' }).click();
      await expect(prompt).toHaveCount(0);
      // A new idle stretch asks again.
      await setStatus(id, 'Running');
      await expect(row).toHaveAttribute('data-zone', 'desk', { timeout: 15_000 });
      await setStatus(id, 'Idle');
      await expect(prompt).toBeVisible({ timeout: 15_000 });

      // Snooze is written for half an hour.
      const snoozed = await mark(key, 'snooze');
      expect(snoozed.status).toBe(200);
      const until = Date.parse((snoozed.body.mark as { snoozedUntil: string }).snoozedUntil);
      expect(until - Date.now()).toBeGreaterThan(29 * 60_000);
      expect((await mark(key, 'keep')).status).toBe(200);
      await setStatus(id, 'Running');
      await expect(row).toHaveAttribute('data-zone', 'desk', { timeout: 15_000 });
      await setStatus(id, 'Idle');
      await expect(prompt).toBeVisible({ timeout: 15_000 });

      // Archive asks first, and says what it leaves alone.
      await prompt.getByRole('button', { name: 'Archive' }).click();
      const dialog = page.getByRole('alertdialog');
      await expect(dialog).toContainText('This only changes the office');
      await axe(page, 'office: archive confirmation');
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(row).toHaveAttribute('data-zone', 'pantry');
      await prompt.getByRole('button', { name: 'Archive' }).click();
      await dialog.getByRole('button', { name: 'Send home' }).click();
      await expect(row).toHaveAttribute('data-zone', 'archived');
      await expect(page.locator('[data-zone-section="archived"] li[data-task="NW-0003"]')).toContainText(
        'Sent home',
      );
      // Office-only: the AoE session is still there, not archived.
      const state = (await fake('/__fake/state')) as {
        sessions: { id: string; archived_at?: string | null }[];
      };
      expect(state.sessions.find((s) => s.id === id)?.archived_at ?? null).toBeNull();

      // Restore brings it back, and counts as Keep.
      await page.getByRole('button', { name: /^Restore .* to the office$/ }).click();
      await expect(row).toHaveAttribute('data-zone', 'pantry');
      await expect(prompt).toHaveCount(0);
      await expect(page.locator('[data-zone-section="archived"]')).toHaveCount(0);

      // Sent home again, it comes back by itself when its session starts working.
      expect((await mark(key, 'archive')).status).toBe(200);
      await expect(row).toHaveAttribute('data-zone', 'archived');
      await setStatus(id, 'Running');
      await expect(row).toHaveAttribute('data-zone', 'desk', { timeout: 15_000 });
      await expect
        .poll(async () => {
          const snap = (await (await page.request.get('/api/snapshot')).json()) as {
            office: { marks: Record<string, { archivedAt: string | null }> };
          };
          return snap.office.marks[key]?.archivedAt ?? null;
        })
        .toBeNull();

      // Only workers go home, and only known ones.
      expect((await mark('northwind-web/lead', 'archive')).status).toBe(400);
      expect((await mark('northwind-web/NW-9999', 'archive')).status).toBe(404);
      expect((await mark(key, 'delete')).status).toBe(400);
    } finally {
      await mark(key, 'restore').catch(() => null);
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

    test('every project has a room of its own, with a chip that flies to it', async ({ signedIn: page }) => {
      await page.goto('/office');
      await drawn(page);
      const snap = (await (await page.request.get('/api/snapshot')).json()) as {
        projects: { name: string }[];
      };
      const names = snap.projects.map((p) => p.name);
      expect(names.length).toBeGreaterThan(1);
      await expect(floor(page)).toHaveAttribute('data-rooms', names.join(','));
      const chips = page.getByRole('navigation', { name: 'Go to' });
      for (const name of names) {
        await chips.getByRole('button', { name, exact: true }).click();
        await expect(floor(page)).toHaveAttribute('data-camera-focus', name);
        await expect(chips.getByRole('button', { name, exact: true })).toHaveAttribute(
          'aria-pressed',
          'true',
        );
      }
      await chips.getByRole('button', { name: 'Whole office' }).click();
      await expect(floor(page)).toHaveAttribute('data-camera-focus', 'office');
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

    test('a worker waits at your door for what its lead passed on; the lead takes the call at its desk', async ({
      signedIn: page,
      browserName,
    }) => {
      const control = await sessionId('northwind-web control');
      const title = `phone call ${browserName}`;
      const { id } = (await fake('/__fake/sessions', {
        method: 'POST',
        body: JSON.stringify({
          title,
          project_path: `/tmp/northwind-call-${browserName}`,
          parent_session_id: control,
          status: 'Running',
        }),
      })) as { id: string };
      // Typed into the control chat as if by you; the fake Claude answers 0.9 s later.
      const say = async (message: string) => {
        await fake('/__fake/send', { method: 'POST', body: JSON.stringify({ id: control, message }) });
        await page.waitForTimeout(1_500);
      };
      const item = `${title} wants to run npm publish. Blocked until you say.`;
      const lead = page.locator('li[data-role="lead"][data-project="northwind-web"]');
      const needs = page.locator('section[aria-labelledby="needs-you-heading"]');
      try {
        await fake(`/__fake/sessions/${id}/permission`, { method: 'POST', body: '{}' });
        // You ask for status; the control chat lists the worker's permission prompt under NEEDS YOU.
        await say('status?');
        await fake(`/__fake/sessions/${control}/reply`, {
          method: 'POST',
          body: JSON.stringify({
            text: ['🔴 NEEDS YOU', `1. ${item}`, '', '🟡 WORKING', '- the rest: on it'].join('\n'),
          }),
        });

        // Needs you: the worker's own item, and the control chat's passed on, pointing at the worker.
        await page.goto('/');
        const passed = needs.locator('li', { hasText: item });
        await expect(passed.getByText('Passed on')).toBeVisible({ timeout: 15_000 });
        await expect(passed.getByRole('link')).toHaveAttribute('href', `/chat/${id}`);

        // The office: the worker in line, its lead on the phone at its desk, not in line behind it.
        await page.goto('/office');
        await drawn(page);
        await expect(page.locator(`li[data-session="${id}"]`)).toHaveAttribute('data-zone', 'door', {
          timeout: 15_000,
        });
        await expect(lead).toHaveAttribute('data-zone', 'desk');
        await expect(lead).toHaveAttribute('data-relayed', '1');
        await expect(lead.getByText(/^Calling for /)).toBeVisible();
        // Picking the lead lists the call, with a way to the worker in line.
        await page.locator('[data-worker="northwind-web/lead"]').click();
        const card = page.locator('[data-worker-card="northwind-web/lead"]');
        await expect(card.getByText(item)).toBeVisible();
        await axe(page, 'office lead on the phone');
        await card.getByRole('button', { name: /^Show .+ at your door$/ }).click();
        await expect(page.locator(`[data-worker-card="northwind-web/s/${id}"]`)).toBeVisible();

        // You answer the worker itself: it gets back to work, and the lead puts the phone down with no
        // new reply from the control chat.
        await setStatus(id, 'Running');
        await expect(lead).not.toHaveAttribute('data-relayed', { timeout: 15_000 });
        await expect(lead).toHaveAttribute('data-zone', 'desk');
        await expect(lead.getByText(/^Calling for /)).toHaveCount(0);
        await page.goto('/');
        await expect(needs.getByText(item)).toHaveCount(0);
      } finally {
        // A reply with nothing under NEEDS YOU clears the list before the worker goes.
        await say('Thanks, all good.');
        await fake(`/__fake/sessions/${id}`, { method: 'DELETE' });
      }
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

    test('a worker who raised an MR takes the folder to its lead, then goes on', async ({
      signedIn: page,
    }) => {
      // NW-0001 has an MR open: from its desk, going idle is finishing.
      const id = await sessionId('NW-0001');
      await page.goto('/office');
      await drawn(page);
      const row = page.locator('li[data-task="NW-0001"]');
      try {
        await setStatus(id, 'Running');
        await expect(row).toHaveAttribute('data-zone', 'desk', { timeout: 15_000 });
        await expect(floor(page)).toHaveAttribute('data-walking', '0', { timeout: 15_000 });
        await floor(page).evaluate((el) => {
          const seen: string[] = [];
          (window as unknown as { __errands: string[] }).__errands = seen;
          new MutationObserver(() => seen.push((el as HTMLElement).dataset.errands ?? '')).observe(el, {
            attributes: true,
            attributeFilter: ['data-errands'],
          });
        });
        await setStatus(id, 'Idle');
        // It finishes up at its desk for 15 seconds, then sets off with the folder.
        await expect(floor(page)).toHaveAttribute('data-errands', /northwind-web\/NW-0001/, {
          timeout: 30_000,
        });
        await expect(floor(page)).toHaveAttribute('data-errands', '', { timeout: 15_000 });
        await expect(row).not.toHaveAttribute('data-zone', 'desk');
        const seen = await page.evaluate(() => (window as unknown as { __errands: string[] }).__errands);
        expect(seen.at(-1)).toBe('');
      } finally {
        await setStatus(id, 'Waiting');
      }
      await expect(row).toHaveAttribute('data-zone', 'door', { timeout: 15_000 });
    });

    test('newcomers come in through the entrance one at a time', async ({ signedIn: page, browserName }) => {
      await page.goto('/office');
      await drawn(page);
      const snap = (await (await page.request.get('/api/snapshot')).json()) as {
        projects: { name: string; controlSessionId: string }[];
      };
      const control = snap.projects.find((p) => p.name === 'northwind-web')!.controlSessionId;
      await floor(page).evaluate((el) => {
        const seen: string[] = [];
        (window as unknown as { __arriving: string[] }).__arriving = seen;
        new MutationObserver(() => seen.push((el as HTMLElement).dataset.arriving ?? '')).observe(el, {
          attributes: true,
          attributeFilter: ['data-arriving'],
        });
      });
      const ids: string[] = [];
      try {
        for (const n of [1, 2, 3])
          ids.push(
            (
              (await fake('/__fake/sessions', {
                method: 'POST',
                body: JSON.stringify({
                  title: `crowd ${n} ${browserName}`,
                  project_path: `/tmp/crowd-${browserName}-${n}`,
                  parent_session_id: control,
                  status: 'Running',
                }),
              })) as { id: string }
            ).id,
          );
        for (const id of ids)
          await expect(page.locator(`li[data-session="${id}"]`)).toHaveAttribute('data-zone', 'desk', {
            timeout: 15_000,
          });
        await expect(floor(page)).toHaveAttribute('data-arriving', '0', { timeout: 15_000 });
        await expect(floor(page)).toHaveAttribute('data-walking', '0', { timeout: 15_000 });
        // Two of the three waited outside for their turn.
        const seen = await page.evaluate(() => (window as unknown as { __arriving: string[] }).__arriving);
        expect(Math.max(...seen.map(Number))).toBeGreaterThanOrEqual(1);
      } finally {
        for (const id of ids) await fake(`/__fake/sessions/${id}`, { method: 'DELETE' });
      }
    });

    test('Office animations off in Settings: everyone jumps', async ({ signedIn: page }) => {
      await page.goto('/settings');
      const toggle = page.getByRole('switch', { name: 'Office animations' });
      await expect(toggle).toBeChecked();
      await toggle.click();
      await expect(toggle).not.toBeChecked();
      try {
        await page.goto('/office');
        await drawn(page);
        await expect(floor(page)).toHaveAttribute('data-motion', 'jump');
      } finally {
        await page.goto('/settings');
        await page.getByRole('switch', { name: 'Office animations' }).click();
        await expect(page.getByRole('switch', { name: 'Office animations' })).toBeChecked();
      }
      await page.goto('/office');
      await drawn(page);
      await expect(floor(page)).toHaveAttribute('data-motion', 'walk');
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
