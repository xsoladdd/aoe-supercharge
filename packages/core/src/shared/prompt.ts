/**
 * Menus Claude Code shows in its terminal while it waits on you (plan approval, permission prompts,
 * AskUserQuestion), read from the pane text AoE gives us. Claude Code 2.1.x draws them as:
 *
 *   ────────────────────────────────────────
 *    Claude has written up a plan and is ready to execute. Would you like to
 *    proceed?
 *
 *    ❯ 1. Yes, and use auto mode
 *      2. Yes, manually approve edits
 *      3. Tell Claude what to change
 *         shift+tab to approve with this feedback
 *
 *    ctrl+g to edit in VS Code · ~/.claude/plans/plan.md
 *
 * Answering relies on behaviour read from Claude Code 2.1.236's Select component: a digit confirms
 * that option at once; on a text-input option with no text it only focuses the row, and the Enter
 * AoE sends after it then cancels the menu (Escape). See SPEC §20.
 */

import { fnv1a } from './hash.ts';

export type PromptKind = 'plan' | 'permission' | 'question' | 'menu';

export interface PromptOption {
  n: number;
  label: string;
  hint: string | null;
  /** Picking it means telling Claude something: the UI asks for text and sends it after the menu closes. */
  feedback: boolean;
}

export interface SessionPrompt {
  /** Stable for one menu; an answer is only delivered while the same menu is still on screen. */
  key: string;
  kind: PromptKind;
  question: string;
  options: PromptOption[];
  /** The tool call it is about (from the transcript), e.g. `Bash` and its command. */
  tool: { name: string; summary: string } | null;
  /** The dashboard can answer it (plan and permission by number, AskUserQuestion by Escape + message). */
  answerable: boolean;
  /** AskUserQuestion only: the headers in its tab bar (every question it asked), and checkboxes. */
  tabs?: string[];
  multi?: boolean;
}

const OPTION = /^(?:❯|›|>)?\s*(\d{1,2})\.\s+(\S.*?)\s*$/;
const CURSOR = /^(?:❯|›|>)\s*\d/;
const RULE = /^[╭╰┌└]?[─━╌═\-_]{8,}[╮╯┐┘]?$/;
const FEEDBACK = /tell claude|what to change|type something/i;
/** Hint lines under an option are indented (two spaces in AskUserQuestion, more in other menus). */
const HINT = /^\s{2,}\S/;
/** Multi-select rows start with a checkbox. */
const CHECKBOX = /^\[[ x✔✓]\]\s+/;

/** Strip box borders and trailing space; keep the leading indent (hint lines are indented). */
function clean(line: string): string {
  return line
    .replace(/^\s*[│┃|]\s?/, ' ')
    .replace(/\s*[│┃|]\s*$/, '')
    .replace(/\s+$/, '');
}

/** FNV-1a, enough to tell two menus apart. */
function hash(text: string): string {
  return fnv1a(text).toString(16).padStart(8, '0');
}

export interface ParsedMenu {
  key: string;
  question: string;
  options: PromptOption[];
  /** AskUserQuestion's tab bar ("←  ☐ Core shapes  ☐ Odd shapes  ✔ Submit  →"), minus Submit. */
  tabs: string[];
  /** Options drawn with checkboxes. */
  multi: boolean;
}

const TAB_MARK = /[☐☒✔✓]/;

function parseTabs(line: string): string[] {
  if (!TAB_MARK.test(line) || !/[←→]/.test(line)) return [];
  return line
    .replace(/[←→]/g, '')
    .split(/[☐☒✔✓]/)
    .map((t) => t.trim())
    .filter((t) => t && t !== 'Submit');
}

/**
 * The menu at the bottom of a pane, or null. Only a block of options numbered 1..n with the ❯ cursor
 * on one of them counts, and nothing but footer text may follow it, so scrollback that merely looks
 * like a list is ignored.
 */
export function parseTerminalMenu(content: string): ParsedMenu | null {
  const lines = content.split('\n').map(clean);
  let end = lines.length - 1;
  while (end >= 0 && !lines[end]!.trim()) end--;
  if (end < 0) return null;

  // Find the last option line, allowing a short footer (hints like "Esc to cancel") after it.
  let last = -1;
  for (let i = end; i >= Math.max(0, end - 8); i--) {
    if (OPTION.test(lines[i]!.trim())) {
      last = i;
      break;
    }
  }
  if (last < 0) return null;

  // The last option's own hint lines sit below it.
  while (last + 1 <= end && HINT.test(lines[last + 1]!) && !OPTION.test(lines[last + 1]!.trim())) last++;
  // Walk up through the options and the indented hint lines under them. AskUserQuestion puts its
  // "Chat about this" option under a rule, so a rule with options above it stays inside the block.
  let first = last;
  let cursor = false;
  for (let i = last; i >= 0; i--) {
    const raw = lines[i]!;
    const t = raw.trim();
    if (OPTION.test(t)) {
      if (CURSOR.test(t)) cursor = true;
      first = i;
    } else if (RULE.test(t) && i === first - 1 && !!lines[i - 1]?.trim()) {
      continue;
    } else if (!t || !HINT.test(raw)) break;
  }
  // Then down again, attaching each hint line to the option above it.
  const options: PromptOption[] = [];
  let multi = false;
  for (let i = first; i <= last; i++) {
    const t = lines[i]!.trim();
    const m = OPTION.exec(t);
    if (m) {
      if (CHECKBOX.test(m[2]!)) multi = true;
      const label = m[2]!.replace(CHECKBOX, '');
      options.push({ n: Number(m[1]), label, hint: null, feedback: FEEDBACK.test(label) });
    } else if (t && !RULE.test(t) && options.length) {
      const o = options.at(-1)!;
      o.hint = o.hint ? `${o.hint} ${t}` : t;
    }
  }
  if (!cursor || options.length < 2 || options.some((o, i) => o.n !== i + 1)) return null;

  // The question: the paragraph right above the options, stopping at a rule or a second blank line.
  const q: string[] = [];
  let i = first - 1;
  while (i >= 0 && !lines[i]!.trim()) i--;
  for (; i >= 0; i--) {
    const t = lines[i]!.trim();
    if (!t || RULE.test(t)) break;
    q.unshift(t);
  }
  const question = q.join(' ').replace(/\s+/g, ' ').trim();
  // AskUserQuestion draws its tab bar a few lines above the question.
  let tabs: string[] = [];
  for (let j = i; j >= Math.max(0, i - 3) && !tabs.length; j--) tabs = parseTabs(lines[j] ?? '');
  return {
    key: hash(`${question}\n${options.map((o) => `${o.n}.${o.label}`).join('\n')}`),
    question,
    options,
    tabs,
    multi,
  };
}

/** What kind of menu it is, from the tool call Claude is waiting on (if the transcript has one). */
export function promptKind(pendingTool: string | null, menu: ParsedMenu): PromptKind {
  if (pendingTool === 'ExitPlanMode') return 'plan';
  if (pendingTool === 'AskUserQuestion') return 'question';
  if (pendingTool) return 'permission';
  // Claude Code does not always write the AskUserQuestion call before it is answered; its screen shows it.
  if (menu.tabs.length || menu.multi || menu.options.some((o) => o.label === 'Chat about this'))
    return 'question';
  if (/plan/i.test(menu.question) && /proceed/i.test(menu.question)) return 'plan';
  return 'menu';
}
