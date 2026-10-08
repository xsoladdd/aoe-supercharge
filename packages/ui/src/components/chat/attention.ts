import type { Element, ElementContent, Root, RootContent, Text } from 'hast';
import { attentionKind, isBlocker, isSectionStart, type AttentionKind } from '@aoe-supercharge/core/shared';

const HEADING = /^h[1-6]$/;

function textOf(node: RootContent | ElementContent): string {
  if (node.type === 'text') return node.value;
  if (node.type === 'element') return node.children.map(textOf).join('');
  return '';
}

/** The first line of a block's text, as it was written. */
const firstLine = (node: Element) => textOf(node).split('\n')[0] ?? '';

/** The section a top-level block starts: a NEEDS YOU, WORKING or DONE heading line, or null. */
function sectionKind(node: RootContent): AttentionKind | null {
  if (node.type !== 'element' || !(node.tagName === 'p' || HEADING.test(node.tagName))) return null;
  return attentionKind(firstLine(node));
}

/** Whether a top-level block ends a section: another heading, a rule, or a line like one. */
function endsSection(node: RootContent): boolean {
  if (node.type !== 'element') return false;
  if (node.tagName === 'hr' || HEADING.test(node.tagName)) return true;
  return node.tagName === 'p' && isSectionStart(firstLine(node));
}

/** Wraps the first "Blocked" in an item that says work is stopped, so it stands out. */
function markBlocked(node: Element): boolean {
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i]!;
    if (child.type === 'element') {
      if (child.tagName !== 'code' && child.tagName !== 'pre' && markBlocked(child)) return true;
      continue;
    }
    if (child.type !== 'text') continue;
    const m = /\bBlocked\b/i.exec(child.value);
    if (!m) continue;
    const before: Text = { type: 'text', value: child.value.slice(0, m.index) };
    const word: Element = {
      type: 'element',
      tagName: 'strong',
      properties: { dataAttentionBlocked: '' },
      children: [{ type: 'text', value: m[0] }],
    };
    const after: Text = { type: 'text', value: child.value.slice(m.index + m[0].length) };
    node.children.splice(i, 1, ...[before, word, after].filter((n) => n.type !== 'text' || n.value));
    return true;
  }
  return false;
}

function markBlockedItems(node: Element) {
  for (const child of node.children) {
    if (child.type !== 'element') continue;
    if (child.tagName === 'li') {
      if (isBlocker(textOf(child))) markBlocked(child);
    } else if (child.tagName === 'ul' || child.tagName === 'ol') markBlockedItems(child);
  }
}

/**
 * Rehype step: a report's 🔴 NEEDS YOU, 🟡 WORKING and ✅ DONE sections, each heading with the blocks
 * after it up to the next section, go in a `<div data-attention="needs|working|done">` the chat colours.
 * Inside NEEDS YOU, an item's "Blocked" is marked too. Runs after sanitising: it adds only these.
 */
export function groupAttention(tree: Root) {
  const out: RootContent[] = [];
  let group: Element | null = null;
  for (const node of tree.children) {
    const kind = sectionKind(node);
    if (kind) {
      group = { type: 'element', tagName: 'div', properties: { dataAttention: kind }, children: [] };
      out.push(group);
    } else if (group && endsSection(node)) group = null;
    if (group) group.children.push(node as ElementContent);
    else out.push(node);
  }
  for (const node of out)
    if (node.type === 'element' && node.properties.dataAttention === 'needs') markBlockedItems(node);
  tree.children = out;
}

export const rehypeAttention = () => groupAttention;
