import { describe, expect, it } from 'vitest';
import { asksFromChat, controlAsks } from '../src/shared/control-asks.ts';
import { parseWatchLine, type ChatMessage } from '../src/shared/index.ts';

describe('controlAsks: what a control chat says needs you', () => {
  it('reads the numbered items under 🔴 NEEDS YOU and stops at the next section', () => {
    const reply = [
      'All three workers are moving.',
      '',
      '🔴 **NEEDS YOU**',
      '',
      '1. **Logins:** each tester stops and asks you for a login before signing in.',
      '2. **480:** who should I put down as owner?',
      '3. **Disk:** run this whenever you are ready:',
      '   ```bash',
      '   aoe session empty-trash',
      '   ```',
      '',
      '🟡 **WORKING**',
      '- test-web: checking the header',
    ].join('\n');
    expect(controlAsks(reply)).toEqual([
      { text: 'Logins: each tester stops and asks you for a login before signing in.', blocker: false },
      { text: '480: who should I put down as owner?', blocker: false },
      { text: 'Disk: run this whenever you are ready: aoe session empty-trash', blocker: false },
    ]);
  });

  it('takes plain lines too, and marks the ones that block work', () => {
    const reply = [
      '🔴 NEEDS YOU',
      '[auth #1] Magic links or SMS codes for login? This blocks the auth worker.',
      '[auth #2] OK to add a riders table migration? Not blocking.',
      '',
      '✅ DONE',
      'push-fix: token refresh fixed',
    ].join('\n');
    expect(controlAsks(reply)).toEqual([
      { text: '[auth #1] Magic links or SMS codes for login? This blocks the auth worker.', blocker: true },
      { text: '[auth #2] OK to add a riders table migration? Not blocking.', blocker: false },
    ]);
  });

  it('finds the heading as a markdown heading, in any case, and with a subtitle', () => {
    expect(controlAsks('## Needs you\n- Blocker: approve the plan for the API worker')).toEqual([
      { text: 'Blocker: approve the plan for the API worker', blocker: true },
    ]);
    expect(
      controlAsks(
        '**🔴 NEEDS YOU: questions from the testers**\n1. **[web]** May the tester edit the quote?',
      ),
    ).toEqual([{ text: '[web] May the tester edit the quote?', blocker: false }]);
    for (const heading of ['**🔴 Still waiting on you**', '🔴 Waiting for your answers', '### Your call'])
      expect(controlAsks(`${heading}\n1. Who owns the brand?`)).toEqual([
        { text: 'Who owns the brand?', blocker: false },
      ]);
    // Words that only mention it are not the heading.
    expect(controlAsks('The tester is waiting on you to log in.\n1. Who owns the brand?')).toEqual([]);
  });

  it('has nothing when there is no NEEDS YOU section, or it says none', () => {
    expect(controlAsks('🟡 WORKING\n- api: building, no blockers')).toEqual([]);
    expect(controlAsks('🔴 NEEDS YOU\nNothing right now.\n\n🟡 WORKING\n- api')).toEqual([]);
    expect(controlAsks('Nothing here needs you yet, the workers are busy.')).toEqual([]);
  });
});

describe('asksFromChat: a notice never counts as your reply', () => {
  const msg = (
    id: string,
    role: ChatMessage['role'],
    text: string,
    extra: Partial<ChatMessage> = {},
  ): ChatMessage => ({
    id,
    role,
    at: `2026-10-08T09:${id.padStart(2, '0')}:00.000Z`,
    blocks:
      role === 'notice' ? [{ kind: 'notice', notice: parseWatchLine(text)! }] : [{ kind: 'text', text }],
    ...extra,
  });
  const NEEDS = (...items: string[]) =>
    ['🔴 NEEDS YOU', ...items.map((t, i) => `${i + 1}. ${t}`), '🟡 WORKING', '- x'].join('\n');
  const WATCH = '[WATCH] worker="fix-1989-ci" status=idle kind=done log=/tmp/x.txt';

  it("sets the list from Claude's last reply to each of your messages", () => {
    const chat = [
      msg('1', 'user', 'status?'),
      msg('2', 'assistant', 'Looking…'),
      msg('3', 'assistant', NEEDS('Pick a db')),
    ];
    expect(asksFromChat(chat)).toEqual({ at: chat[2]!.at, items: [{ text: 'Pick a db', blocker: false }] });
    expect(
      asksFromChat([...chat, msg('4', 'user', 'Postgres'), msg('5', 'assistant', 'Done, passed it on.')]),
    ).toBeNull();
  });

  it('keeps the list when Claude answers a notice without restating it', () => {
    const chat = [
      msg('1', 'user', 'status?'),
      msg('2', 'assistant', NEEDS('Pick a db')),
      msg('3', 'notice', WATCH),
      msg('4', 'assistant', 'fix-1989-ci finished; nothing for you.'),
    ];
    expect(asksFromChat(chat)).toEqual({ at: chat[1]!.at, items: [{ text: 'Pick a db', blocker: false }] });
  });

  it('adds what a notice brings to the list, and keeps when it started', () => {
    const chat = [
      msg('1', 'user', 'status?'),
      msg('2', 'assistant', NEEDS('Pick a db')),
      msg('3', 'notice', WATCH),
      msg('4', 'assistant', NEEDS('fix-1989-ci asks: deploy now? Blocked until you say', 'Pick a db')),
    ];
    expect(asksFromChat(chat)).toEqual({
      at: chat[1]!.at,
      items: [
        { text: 'Pick a db', blocker: false },
        { text: 'fix-1989-ci asks: deploy now? Blocked until you say', blocker: true },
      ],
    });
  });

  it('changes nothing while a reply is still to come', () => {
    const chat = [
      msg('1', 'user', 'status?'),
      msg('2', 'assistant', NEEDS('Pick a db')),
      msg('3', 'user', 'Postgres'),
    ];
    expect(asksFromChat(chat)?.items).toHaveLength(1);
  });

  it('treats a notice taken in mid-turn as part of the reply to your message', () => {
    const chat = [
      msg('1', 'user', 'status?'),
      msg('2', 'assistant', NEEDS('Pick a db')),
      msg('3', 'user', 'Postgres, and merge AS-1'),
      msg('4', 'assistant', 'Passing it on…'),
      msg('5', 'notice', WATCH, { queued: true }),
      msg('6', 'assistant', 'Done. Nothing needs you.'),
    ];
    expect(asksFromChat(chat)).toBeNull();
  });
});
