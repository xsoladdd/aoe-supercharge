import type { Page } from '@playwright/test';
import { axe, expect, fake, test } from './fixtures.ts';

/**
 * The worker watch (control chats hear about their workers) and how `[WATCH]` lines show in a chat.
 * The world has the watch off; these turn it on for apollo-api alone and put back what they change.
 */

interface FakeState {
  sessions: { id: string; title: string; status: string }[];
  sent: { id: string; message: string }[];
}
const state = () => fake('/__fake/state') as Promise<FakeState>;
const sessionId = async (prefix: string) =>
  (await state()).sessions.find((s) => s.title.startsWith(prefix))!.id;
const patch = (id: string, body: Record<string, unknown>) =>
  fake(`/__fake/sessions/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
/** The `[WATCH]` lines typed into a session so far. */
const watchLines = async (id: string) =>
  (await state()).sent
    .filter((s) => s.id === id)
    .flatMap((s) => s.message.split('\n'))
    .filter((l) => l.startsWith('[WATCH]'));
/** The kinds told about one session, in order, from the `from`th line on (earlier runs share sessions). */
const kinds = async (control: string, session: string, from = 0) =>
  (await watchLines(control))
    .slice(from)
    .filter((l) => l.includes(` session=${session} `))
    .map((l) => /kind=(\w+)/.exec(l)![1]);

async function setWatch(page: Page, on: boolean) {
  await page.goto('/settings#s-watch');
  const toggle = page.getByRole('switch', { name: 'apollo-api' });
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-checked')) !== String(on)) await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', String(on));
}

test.describe('worker watch', () => {
  test('a legacy [WATCH] line shows as a notice, not as something you typed', async ({ signedIn: page }) => {
    const control = await sessionId('apollo-api control');
    const worker = (await state()).sessions.find((s) => s.title.startsWith('AA-0001'))!;
    const line = `[WATCH] worker="${worker.title}" status=idle kind=question log=/Users/me/.control-watch/logs/aa.txt`;
    await fake('/__fake/send', { method: 'POST', body: JSON.stringify({ id: control, message: line }) });
    await page.goto(`/chat/${control}`);
    const chat = page.getByRole('log', { name: /^Conversation with/ });
    const note = chat.getByRole('note', { name: `Watch notice: ${worker.title}, question` }).last();
    await expect(note).toBeVisible({ timeout: 15_000 });
    await expect(note.getByRole('link', { name: 'Open' })).toHaveAttribute('href', `/chat/${worker.id}`);
    await expect(note.getByRole('button', { name: /Copy the log path/ })).toBeVisible();
    // Not a message from you: no bubble carries the raw line.
    await expect(chat.locator('.rounded-br-md', { hasText: 'kind=question' })).toHaveCount(0);
    await axe(page, 'control chat with a watch notice');
  });

  test('tells the control chat once per event, and stops when turned off', async ({
    signedIn: page,
    browserName,
  }) => {
    test.setTimeout(180_000);
    const control = await sessionId('apollo-api control');
    const task = await sessionId('AA-0001');
    // Plain workers the control chat started (`aoe add -P`): no task.
    const mk = (name: string, body: Record<string, unknown>) =>
      fake('/__fake/sessions', {
        method: 'POST',
        body: JSON.stringify({
          title: `${name}-${browserName}`,
          project_path: `/tmp/${name}-${browserName}`,
          parent_session_id: control,
          ...body,
        }),
      }) as Promise<{ id: string }>;
    const crew = await mk('watch-crew', { status: 'Running' });
    let idler: { id: string } | null = null;
    let before = 0;
    const once = async (session: string, expected: string[]) =>
      expect.poll(() => kinds(control, session, before), { timeout: 20_000 }).toEqual(expected);
    try {
      await patch(control, { status: 'Idle' });
      await setWatch(page, true);
      // The first look takes what is already waiting (a plan to approve, a branch to merge) as told.
      await page.goto(`/chat/${control}`);
      const panel = page.getByRole('complementary', { name: 'Project panel' });
      await panel.getByRole('tab', { name: 'Watch' }).click();
      await expect(panel.getByText(/Watching [1-9]\d* workers?/)).toBeVisible({ timeout: 15_000 });
      before = (await watchLines(control)).length;

      // A task's worker errors.
      await patch(task, { status: 'Error', last_error: 'claude exited unexpectedly' });
      await once(task, ['error']);
      await patch(task, { status: 'Running', last_error: null });

      // A plain worker: error, permission prompt, QUESTION:, DONE:.
      await patch(crew.id, { status: 'Error', last_error: 'tmux died' });
      await once(crew.id, ['error']);
      await patch(crew.id, { status: 'Running', last_error: null });
      await fake(`/__fake/sessions/${crew.id}/permission`, {
        method: 'POST',
        body: JSON.stringify({ command: 'npm publish' }),
      });
      await once(crew.id, ['error', 'permission']);
      await patch(crew.id, { status: 'Running', menu: null });
      const reply = (text: string) =>
        fake(`/__fake/sessions/${crew.id}/reply`, { method: 'POST', body: JSON.stringify({ text }) });
      await reply('I looked at the deploy.\n\nQUESTION: staging or prod first?');
      await once(crew.id, ['error', 'permission', 'question']);
      await reply('DONE: deployed to staging, smoke tests pass.');
      await once(crew.id, ['error', 'permission', 'question', 'done']);
      // One idle for 20 minutes with nothing to report has stalled.
      idler = await mk('watch-idle', {
        status: 'Idle',
        idle_entered_at: new Date(Date.now() - 20 * 60_000).toISOString(),
      });
      await once(idler.id, ['stalled']);
      // Still once each a few polls later.
      await page.waitForTimeout(4_000);
      expect(await kinds(control, crew.id, before)).toEqual(['error', 'permission', 'question', 'done']);
      expect(await kinds(control, idler.id, before)).toEqual(['stalled']);
      expect((await watchLines(control)).length).toBe(before + 6);

      // In the chat: compact notices, with links to the worker and to what its pane showed.
      const chat = page.getByRole('log', { name: /^Conversation with/ });
      const err = chat.getByRole('note', { name: /^Watch notice: .*\(AA-0001\), error$/ }).last();
      await expect(err).toBeVisible({ timeout: 15_000 });
      await expect(err.getByRole('link', { name: 'Open' })).toHaveAttribute(
        'href',
        '/p/apollo-api/t/AA-0001',
      );
      const log = await err.getByRole('link', { name: 'Log' }).getAttribute('href');
      const res = await page.request.get(log!);
      expect(res.status()).toBe(200);
      expect(await res.text()).toContain('Claude Code (fake agent)');
      await expect(chat.getByRole('note', { name: /stalled$/ }).last()).toContainText('Idle for 20 min');

      // The Watch tab lists them, newest first, all sent.
      const list = panel.getByRole('list', { name: 'Watch log' });
      await expect(list.getByRole('listitem').first()).toContainText('Stalled');
      await expect(list.getByRole('listitem').first()).toContainText('Sent');
      await expect(list.getByText('Waiting for the control chat')).toHaveCount(0);
      await axe(page, 'control chat with the Watch tab');

      // Off: nothing more.
      await setWatch(page, false);
      await patch(crew.id, { status: 'Error', last_error: 'again' });
      await page.waitForTimeout(4_000);
      expect(await kinds(control, crew.id, before)).toHaveLength(4);
    } finally {
      await setWatch(page, false).catch(() => {});
      for (const s of [crew, idler]) if (s) await fake(`/__fake/sessions/${s.id}`, { method: 'DELETE' });
      await patch(task, { status: 'Running', last_error: null });
      await patch(control, { status: 'Running' });
    }
  });
});
