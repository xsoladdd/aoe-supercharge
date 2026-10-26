import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ASK_MENU, PERMISSION_MENU, PLAN_MENU } from '../../fake-aoe/src/server.ts';
import {
  computeNeedsYou,
  parseTerminalMenu,
  prettyModel,
  splitAttachments,
  withAttachments,
  contextWindow,
  promptDetail,
  promptKind,
  type SessionView,
} from '../src/shared/index.ts';

const pane = (...parts: string[]) => [' ▐▛███▜▌   Claude Code', '', ...parts].join('\n');

describe('parseTerminalMenu: menus at the bottom of a Claude Code pane', () => {
  it('reads the plan approval: question, numbered options, hints, footer ignored', () => {
    const menu = parseTerminalMenu(pane(' Some plan text above.', '', PLAN_MENU, '', ''))!;
    expect(menu.question).toBe(
      'Claude has written up a plan and is ready to execute. Would you like to proceed?',
    );
    expect(menu.options).toEqual([
      { n: 1, label: 'Yes, and use auto mode', hint: null, feedback: false },
      { n: 2, label: 'Yes, manually approve edits', hint: null, feedback: false },
      {
        n: 3,
        label: 'Tell Claude what to change',
        hint: 'shift+tab to approve with this feedback',
        feedback: true,
      },
    ]);
    expect(menu.key).toMatch(/^[0-9a-f]{8}$/);
  });

  it('reads a permission prompt and marks its "tell Claude" option as feedback', () => {
    const menu = parseTerminalMenu(pane(PERMISSION_MENU))!;
    expect(menu.question).toBe('Do you want to proceed?');
    expect(menu.options.map((o) => [o.n, o.feedback])).toEqual([
      [1, false],
      [2, false],
      [3, true],
    ]);
  });

  it('reads AskUserQuestion: two-space hints, checkboxes, and the option under the rule', () => {
    const menu = parseTerminalMenu(pane(' Earlier output.', '', ASK_MENU))!;
    expect(menu.question).toBe('Which browsers should the QA pass cover?');
    expect(menu.options.map((o) => [o.n, o.label])).toEqual([
      [1, 'Chrome'],
      [2, 'Safari'],
      [3, 'Firefox'],
      [4, 'Type something'],
      [5, 'Chat about this'],
    ]);
    expect(menu.options[1]!.hint).toBe('Including Safari on iOS 26.');
    expect(menu.tabs).toEqual(['Browsers', 'Devices']);
    expect(menu.multi).toBe(true);
    // Claude Code may not have written the call yet; the screen alone says it is AskUserQuestion.
    expect(promptKind(null, menu)).toBe('question');
  });

  it('handles boxed menus (older layouts) by stripping the borders', () => {
    const boxed = [
      '╭──────────────────────────────╮',
      '│ Do you want to make this edit?│',
      '│ ❯ 1. Yes                      │',
      '│   2. No                       │',
      '╰──────────────────────────────╯',
    ].join('\n');
    const menu = parseTerminalMenu(boxed)!;
    expect(menu.question).toBe('Do you want to make this edit?');
    expect(menu.options.map((o) => o.label)).toEqual(['Yes', 'No']);
  });

  it('ignores numbered lists without the ❯ cursor, single options, gaps, and menus scrolled away', () => {
    expect(parseTerminalMenu(pane(' Steps:', ' 1. Lower TTLs', ' 2. Cut over', '', '❯ '))).toBeNull();
    expect(parseTerminalMenu(pane(' ❯ 1. Only one'))).toBeNull();
    expect(parseTerminalMenu(pane(' ❯ 1. Yes', '   3. Skipped two'))).toBeNull();
    const scrolled = pane(PLAN_MENU, ...Array.from({ length: 12 }, (_, i) => `output line ${i}`));
    expect(parseTerminalMenu(scrolled)).toBeNull();
    expect(parseTerminalMenu('')).toBeNull();
  });

  it('gives the same menu the same key, and a different menu another', () => {
    const a = parseTerminalMenu(pane(PLAN_MENU))!.key;
    expect(parseTerminalMenu(pane('other scrollback', PLAN_MENU))!.key).toBe(a);
    expect(parseTerminalMenu(pane(PERMISSION_MENU))!.key).not.toBe(a);
  });

  it('classifies by the tool Claude is waiting on', () => {
    const menu = parseTerminalMenu(pane(PLAN_MENU))!;
    expect(promptKind('ExitPlanMode', menu)).toBe('plan');
    expect(promptKind('AskUserQuestion', menu)).toBe('question');
    expect(promptKind('Bash', menu)).toBe('permission');
    expect(promptKind(null, menu)).toBe('plan'); // the plan wording alone
    expect(promptKind(null, parseTerminalMenu(pane(PERMISSION_MENU))!)).toBe('menu');
  });
});

describe('parseTerminalMenu: real Claude Code 2.1.308 screens (fixtures/claude-code)', () => {
  const screen = (name: string) =>
    readFileSync(join(import.meta.dirname, '../../../fixtures/claude-code/2.1.308', `${name}.txt`), 'utf8');
  const PROCEED = 'Do you want to proceed?';

  // Since 2.1.29x the command sits between dashed lines, and "No" no longer asks for feedback (Tab amends).
  it.each([
    ['bash-permission', PROCEED, 4],
    ['multibash-permission', PROCEED, 3],
    ['read-permission', PROCEED, 3],
    ['mcp-permission', PROCEED, 3],
    ['stack-permission', PROCEED, 4],
    ['agents-permission', PROCEED, 4], // stacked: "1 of 2" on the title line
  ])('%s: the question under the dashed command block, and every option', (name, question, count) => {
    const menu = parseTerminalMenu(screen(name))!;
    expect(menu.question).toBe(question);
    expect(menu.options.map((o) => o.n)).toEqual(Array.from({ length: count }, (_, i) => i + 1));
    expect(menu.options.at(-1)).toMatchObject({ label: 'No', feedback: false });
  });

  it('fetch, plan approval and AskUserQuestion keep their feedback options', () => {
    const fetch = parseTerminalMenu(screen('fetch-permission'))!;
    expect(fetch.question).toBe('Do you want to allow Claude to fetch this content?');
    expect(fetch.options.map((o) => o.feedback)).toEqual([false, false, true]);
    const plan = parseTerminalMenu(screen('plan-approval'))!;
    expect(plan.question).toBe(
      'Claude has written up a plan and is ready to execute. Would you like to proceed?',
    );
    expect(plan.options.map((o) => [o.label, o.feedback])).toEqual([
      ['Yes, and use auto mode', false],
      ['Yes, manually approve edits', false],
      ['Tell Claude what to change', true],
    ]);
    const ask = parseTerminalMenu(screen('ask-question'))!;
    expect(ask.question).toBe('Which database should we use?');
    expect(ask.options.map((o) => [o.label, o.hint])).toEqual([
      ['Postgres', 'Relational, what we run today'],
      ['SQLite', 'One file, no server'],
      ['Type something.', null],
      ['Chat about this', null],
    ]);
  });

  it('is not fooled by / and @ suggestion lists or a prompt held back while typing', () => {
    for (const name of ['slash-suggestions', 'at-suggestions', 'held-while-typing'])
      expect(parseTerminalMenu(screen(name))).toBeNull();
  });
});

describe('Needs you: waiting workers say what they are waiting on', () => {
  const base: SessionView = {
    id: 's1',
    title: 'NW-0001 Build page templates',
    status: 'waiting',
    rawStatus: 'Waiting',
    statusSince: '2026-10-05T11:00:00Z',
    parentId: null,
    branch: null,
    projectPath: null,
    group: null,
    tool: 'claude',
    unread: false,
    lastError: null,
    createdAt: null,
    lastAccessedAt: null,
    prompt: null,
    pinned: false,
    archived: false,
    locked: false,
  };
  const run = (prompt: SessionView['prompt']) =>
    computeNeedsYou({
      tasks: [],
      sessions: [{ ...base, prompt }],
      projects: [],
      aoeReachable: true,
      now: new Date('2026-10-05T12:00:00Z'),
      waitingDebounceSeconds: 0,
    })[0]!;
  const menu = parseTerminalMenu(pane(PLAN_MENU))!;
  const prompt = (kind: 'plan' | 'permission', tool: { name: string; summary: string } | null = null) => ({
    ...menu,
    kind,
    tool,
    answerable: true,
  });

  it('plan approval, permission, or a plain wait', () => {
    expect(run(prompt('plan'))).toMatchObject({
      kind: 'plan_approval',
      detail: 'Plan ready for your approval',
    });
    expect(run(prompt('permission', { name: 'Bash', summary: 'npm test' }))).toMatchObject({
      kind: 'permission',
      detail: 'Wants to use Bash: npm test',
    });
    expect(run(null)).toMatchObject({ kind: 'approval', detail: 'Approval or input waiting in AoE' });
    expect(promptDetail(null)).toBe('Approval or input waiting in AoE');
  });
});

describe('prettyModel', () => {
  it('names Claude models the way people say them', () => {
    expect(prettyModel('claude-opus-5-5')).toBe('Opus 5.5');
    expect(prettyModel('claude-opus-5')).toBe('Opus 5');
    expect(prettyModel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(prettyModel('claude-sonnet-5-5[1m]')).toBe('Sonnet 5.5 (1M)');
    expect(prettyModel('custom-model')).toBe('custom-model');
  });
});

describe('attachments ride in the message as paths', () => {
  it('round-trips text and files, and maps uploads to dashboard URLs', () => {
    const msg = withAttachments('Look at the header', [
      '/home/me/.local/state/supercharge/uploads/abc123/20261005T031500-1a2b-screenshot.png',
      '/tmp/notes.txt',
    ]);
    expect(msg).toBe(
      'Look at the header\n\nAttached: `/home/me/.local/state/supercharge/uploads/abc123/20261005T031500-1a2b-screenshot.png`\nAttached: `/tmp/notes.txt`',
    );
    const { text, files } = splitAttachments(msg);
    expect(text).toBe('Look at the header');
    expect(files).toEqual([
      {
        path: '/home/me/.local/state/supercharge/uploads/abc123/20261005T031500-1a2b-screenshot.png',
        name: 'screenshot.png',
        url: '/api/uploads/abc123/20261005T031500-1a2b-screenshot.png',
        image: true,
      },
      { path: '/tmp/notes.txt', name: 'notes.txt', url: null, image: false },
    ]);
    expect(withAttachments('', ['/a.png'])).toBe('Attached: `/a.png`');
  });

  it('reads folders and paths with spaces, and the bare paths older messages have', () => {
    const { text, files } = splitAttachments(
      withAttachments('Look', ['/Users/me/My Files/report.zip', '/Users/me/src']) +
        '\nAttached: /tmp/old.png',
    );
    expect(text).toBe('Look');
    expect(files.map((f) => [f.path, f.name, f.image])).toEqual([
      ['/Users/me/My Files/report.zip', 'report.zip', false],
      ['/Users/me/src', 'src', false],
      ['/tmp/old.png', 'old.png', true],
    ]);
  });

  it('knows the context window', () => {
    expect(contextWindow('claude-opus-5')).toBe(200_000);
    expect(contextWindow('claude-sonnet-5-5[1m]')).toBe(1_000_000);
    expect(contextWindow(null)).toBe(200_000);
  });
});
