import { describe, expect, it } from 'vitest';
import { PERMISSION_MENU, PLAN_MENU } from '../../fake-aoe/src/server.ts';
import {
  computeNeedsYou,
  parseTerminalMenu,
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
