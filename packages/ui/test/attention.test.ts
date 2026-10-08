import { readFileSync } from 'node:fs';
import type { Element, Root } from 'hast';
import rehypeSanitize from 'rehype-sanitize';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { describe, expect, it } from 'vitest';
import { rehypeAttention } from '../src/components/chat/attention.ts';

/** Markdown as the chat renders it (sanitised), then the attention step. */
function render(md: string): Root {
  const p = unified().use(remarkParse).use(remarkRehype).use(rehypeSanitize).use(rehypeAttention);
  return p.runSync(p.parse(md)) as Root;
}
const sections = (tree: Root) =>
  tree.children.filter((n): n is Element => n.type === 'element' && !!n.properties.dataAttention);
const text = (n: Element | Root): string =>
  n.children.map((c) => (c.type === 'text' ? c.value : c.type === 'element' ? text(c) : '')).join('');

describe('rehypeAttention: report sections in a reply', () => {
  const report = [
    'All three workers are moving.',
    '',
    '🔴 **NEEDS YOU**',
    '',
    '1. Aldric (AS-0018): wants to push to main. Blocked.',
    '2. Gisela (AS-0022): a question, not blocked on it.',
    '',
    '🟡 WORKING',
    '',
    '- Oliver (AS-0023): implementing.',
    '',
    '✅ DONE',
    '',
    '- Roger (AS-0021): PR raised.',
    '',
    '---',
    '',
    'Anything else?',
  ].join('\n');

  it('wraps each section with the blocks under it, up to the next section or a rule', () => {
    const tree = render(report);
    const s = sections(tree);
    expect(s.map((x) => x.properties.dataAttention)).toEqual(['needs', 'working', 'done']);
    expect(text(s[0]!)).toContain('Aldric');
    expect(text(s[0]!)).not.toContain('Oliver');
    expect(text(s[2]!)).toContain('Roger');
    expect(text(s[2]!)).not.toContain('Anything else?');
    // Text before and after stays outside.
    expect(text(tree)).toMatch(/^All three workers/);
  });

  it('marks "Blocked" in an item that blocks, not in one that says it is not blocking', () => {
    const needs = sections(render(report))[0]!;
    const marked: string[] = [];
    const walk = (n: Element) => {
      if (n.properties.dataAttentionBlocked !== undefined) marked.push(text(n));
      for (const c of n.children) if (c.type === 'element') walk(c);
    };
    walk(needs);
    expect(marked).toEqual(['Blocked']);
  });

  it('ends a section at the reply going on after its list, but keeps a command under an item', () => {
    const tree = render(
      ['✅ DONE', '', '- Roger: PR raised.', '', '```bash', 'gh pr view 6', '```', '', 'Anything else?'].join(
        '\n',
      ),
    );
    const done = sections(tree)[0]!;
    expect(text(done)).toContain('gh pr view 6');
    expect(text(done)).not.toContain('Anything else?');
    expect(text(tree)).toContain('Anything else?');
  });

  it('leaves an ordinary reply alone', () => {
    const tree = render('Done.\n\nI updated the README and pushed.');
    expect(sections(tree)).toEqual([]);
  });
});

/** sRGB hex → relative luminance (WCAG 2). */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
}
const contrast = (a: string, b: string) => {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1! + 0.05) / (l2! + 0.05);
};
/** `color-mix(in srgb, top p%, bottom)`. */
function mix(top: string, p: number, bottom: string): string {
  const c = (h: string, i: number) => parseInt(h.slice(i, i + 2), 16);
  return `#${[1, 3, 5]
    .map((i) =>
      Math.round(c(top, i) * p + c(bottom, i) * (1 - p))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

describe('attention colours: readable in light and dark', () => {
  const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
  const block = (selector: string) => {
    const body = new RegExp(`\\n${selector.replace('.', '\\.')} \\{([\\s\\S]*?)\\n\\}`).exec(css)![1]!;
    return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6});/gi)].map((m) => [m[1], m[2]]));
  };
  // The attention tokens point at status colours; read which.
  const tokens = Object.fromEntries(
    [...css.matchAll(/--attn-(\w+):\s*var\(--(st-\w+)\);/g)].map((m) => [m[1]!, m[2]!]),
  );

  for (const [theme, selector] of [
    ['light', ':root'],
    ['dark', '.dark'],
  ] as const) {
    const t = block(selector);
    const surfaces = ['background', 'surface', 'card'].map((k) => t[k]!);
    it(`${theme}: text in each attention colour, and body text, on its shade`, () => {
      expect(Object.keys(tokens).sort()).toEqual(['done', 'error', 'needs', 'warn', 'working']);
      for (const [kind, st] of Object.entries(tokens)) {
        const colour = t[st]!;
        for (const base of surfaces) {
          // A report section (7%, its Blocked mark too), a notice row or callout (6%, 8%).
          for (const p of [0.06, 0.07, 0.08]) {
            const shade = mix(colour, p, base);
            expect(
              contrast(colour, shade),
              `${theme} ${kind} on ${p * 100}% over ${base}`,
            ).toBeGreaterThanOrEqual(4.5);
            expect(
              contrast(t['muted-foreground']!, shade),
              `${theme} muted text on ${kind}`,
            ).toBeGreaterThanOrEqual(4.5);
            expect(contrast(t.foreground!, shade)).toBeGreaterThanOrEqual(4.5);
          }
        }
      }
      // A permission notice: its yellow label on the needs shade.
      for (const base of surfaces)
        expect(contrast(t['st-yellow']!, mix(t['st-red']!, 0.06, base))).toBeGreaterThanOrEqual(4.5);
    });
  }
});
