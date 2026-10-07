/**
 * What a control chat's latest reply says needs you: the items under its "NEEDS YOU" heading, the
 * report format control chats use (🔴 NEEDS YOU, ✅ DONE, 🟡 WORKING). The office lines its lead up at
 * your door while there are any, and the ones that block work go to the front.
 */
import type { ChatMessage } from './chat.ts';

export interface ControlAsk {
  text: string;
  /** Work is stopped until you answer (the item says it blocks). */
  blocker: boolean;
}

const MAX_ASKS = 8;
const MAX_TEXT = 300;

/** Markdown emphasis, heading marks and a leading status emoji, gone; what is left is the words. */
function bare(line: string): string {
  return line
    .replace(/^\s*(?:#{1,6}\s+|>\s*)?/, '')
    .replace(/[*_]{1,3}/g, '')
    .replace(/^[\s\p{Extended_Pictographic}️‍]+/u, '')
    .trim();
}

/**
 * The heading, in the words control chats use for it, maybe with a subtitle: "NEEDS YOU", "Needs you:
 * questions from the testers", "Still waiting on you", "Blocked on you", "Your call".
 */
const NEEDS_YOU =
  /^(?:still\s+)?(?:needs? (?:you|your \w+)|waiting (?:on|for) (?:you|your \w+)|blocked on you|for you|your (?:turn|calls?|decisions?|input|answers?))\b\s*(?:[:—–(-].{0,80})?$/i;
/** Another section starts: a heading, a rule, or a short line led by a status emoji or in capitals. */
function sectionStart(line: string): boolean {
  const t = line.trim();
  if (/^#{1,6}\s/.test(t) || /^(?:-{3,}|\*{3,}|_{3,})$/.test(t)) return true;
  if (
    /^(?:\*\*)?\s*[\p{Extended_Pictographic}]/u.test(t) &&
    bare(t).length <= 40 &&
    !/^[-*+]\s|^\d+[.)]\s/.test(t)
  )
    return true;
  const words = bare(t).replace(/:$/, '');
  return words.length >= 3 && words.length <= 40 && words === words.toUpperCase() && /[A-Z]{3}/.test(words);
}

const LIST_ITEM = /^\s*(?:[-*+•]|\d+[.)])\s+/;
const NOTHING = /^(?:none|nothing|n\/a|all clear)\b/i;
const BLOCKS = /\bblock(?:s|er|ers|ed|ing)?\b/i;
const NOT_BLOCKING = /\b(?:no|not|non|un)[- ]?block|\bno(?:thing)? (?:is )?blocking\b/i;

/** The NEEDS YOU items of a reply, in order; empty when it has none. */
export function controlAsks(reply: string): ControlAsk[] {
  const lines = reply.replace(/\r/g, '').split('\n');
  const start = lines.findIndex((l) => NEEDS_YOU.test(bare(l)));
  if (start < 0) return [];
  const items: string[] = [];
  let inFence = false;
  for (const line of lines.slice(start + 1)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      // A command to run belongs to the item above it.
      if (items.length && line.trim()) items[items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    if (!line.trim()) continue;
    if (sectionStart(line)) break;
    if (LIST_ITEM.test(line) && !/^\s{2,}/.test(line)) items.push(line.replace(LIST_ITEM, ''));
    else if (/^\s{2,}/.test(line) && items.length) items[items.length - 1] += ` ${line.trim()}`;
    else items.push(line);
  }
  return items
    .map((i) =>
      i
        .replace(/[*_]{2,3}/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((i) => i && !NOTHING.test(i))
    .slice(0, MAX_ASKS)
    .map((text) => ({
      text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text,
      blocker: BLOCKS.test(text) && !NOT_BLOCKING.test(text),
    }));
}

/** A control chat's NEEDS YOU list, and since when it has had something on it. */
export interface ControlAskList {
  at: string;
  items: ControlAsk[];
}

const replyText = (m: ChatMessage) => m.blocks.map((b) => (b.kind === 'text' ? b.text : '')).join('\n');

/**
 * What a control chat's NEEDS YOU list is after a conversation. Its last reply to each of your
 * messages sets the list. A reply to a watch notice only adds to it: you answered nothing, so what
 * was waiting on you still is. The list keeps the time it first had something on it.
 */
export function asksFromChat(messages: ChatMessage[]): ControlAskList | null {
  let list: ControlAskList | null = null;
  let fromNotice = false;
  let reply: ChatMessage | null = null;
  const settle = () => {
    if (!reply) return;
    const items = controlAsks(replyText(reply));
    const at = list?.items.length ? list.at : reply.at;
    if (!fromNotice) list = items.length ? { at, items } : null;
    else if (items.length) {
      const known = new Set(list?.items.map((i) => i.text));
      list = {
        at,
        items: [...(list?.items ?? []), ...items.filter((i) => !known.has(i.text))].slice(0, MAX_ASKS),
      };
    }
  };
  for (const m of messages) {
    if (m.role === 'assistant') {
      reply = m;
      continue;
    }
    // Taken in mid-turn: the reply under way answers it too. Something you typed makes it yours.
    if (m.queued) {
      if (m.role === 'user') fromNotice = false;
      continue;
    }
    settle();
    reply = null;
    fromNotice = m.role === 'notice';
  }
  settle();
  return list;
}
