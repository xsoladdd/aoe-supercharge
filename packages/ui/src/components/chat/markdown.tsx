import { CheckIcon, CopyIcon, PlayIcon } from '@phosphor-icons/react';
import { inlineCommand, runnableCommand } from '@aoe-supercharge/core/shared';
import type { Element, ElementContent, Root } from 'hast';
import { memo, useMemo, useState, type ComponentProps, type ReactNode } from 'react';
import Markdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import { rehypeAttention } from '@/components/chat/attention';
import { copyText } from '@/components/copy';
import { TerminalsAt } from '@/components/chat/run-terminals';
import { cn } from '@/lib/utils';

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && typeof node === 'object' && 'props' in node)
    return textOf((node as { props: { children?: ReactNode } }).props.children);
  return '';
}

/**
 * Fenced code: language label, copy button, horizontal scroll, highlight.js tokens. With `onRun`, a
 * shell block also offers Run, and the terminals a Run opened for it (`anchor`) show right under it.
 */
export function CodeBlock({
  language,
  code,
  children,
  onRun,
  anchor,
}: {
  language: string | null;
  code: string;
  children?: ReactNode;
  onRun?: (command: string, anchor?: string) => void;
  /** Where this block sits in the chat, for the terminals a Run opens under it. */
  anchor?: string;
}) {
  const [copied, setCopied] = useState(false);
  const command = onRun ? runnableCommand(language, code) : null;
  return (
    <>
      <div className="group/code my-3 overflow-hidden rounded-lg border border-border bg-background">
        <div className="flex items-center gap-1 border-b border-border px-3 py-1.5">
          <span translate="no" className="mr-auto font-mono text-[0.8125rem] text-muted-foreground">
            {language ?? 'text'}
          </span>
          {command !== null && (
            <button
              type="button"
              onClick={() => onRun!(command, anchor)}
              className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[0.8125rem] font-medium text-foreground transition-colors hover:bg-raised"
            >
              <PlayIcon weight="fill" className="size-3.5 text-st-green" />
              Run
            </button>
          )}
          <button
            type="button"
            onClick={async () => {
              if (await copyText(code)) {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }
            }}
            className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[0.8125rem] text-muted-foreground transition-colors hover:bg-raised hover:text-foreground"
          >
            {copied ? <CheckIcon className="size-3.5 text-st-green" /> : <CopyIcon className="size-3.5" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <pre translate="no" className="overflow-x-auto p-3.5 font-mono text-[0.8125rem] leading-relaxed">
          <code className="hljs">{children ?? code}</code>
        </pre>
      </div>
      {command !== null && anchor && <TerminalsAt anchor={anchor} />}
    </>
  );
}

/** Elements a terminal for an inline command shows under (or at the end of, for list items and cells). */
const HOSTS = new Set(['p', 'li', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

function hastText(node: ElementContent): string {
  if (node.type === 'text') return node.value;
  return node.type === 'element' ? node.children.map(hastText).join('') : '';
}

/**
 * Mark each inline command (`! aoe remove x`) and the paragraph, list item, cell or heading around it
 * with that element's place in the markdown, so a terminal its Run opens shows under it.
 */
function rehypeRunAnchors() {
  return (tree: Root) => {
    const walk = (node: Root | Element, host: Element | null) => {
      for (const child of node.children) {
        if (child.type !== 'element' || child.tagName === 'pre') continue;
        const at = host?.position?.start.offset;
        if (child.tagName === 'code' && host && at !== undefined && inlineCommand(hastText(child))) {
          host.properties.dataRunAnchor = String(at);
          child.properties.dataRunAnchor = String(at);
        }
        walk(child, HOSTS.has(child.tagName) ? child : host);
      }
    };
    walk(tree, null);
  };
}

type Node = { node?: Element };
const hostAnchor = (node: Element | undefined, anchorKey: string | undefined) => {
  const at = node?.properties.dataRunAnchor;
  return anchorKey && typeof at === 'string' ? `${anchorKey}:${at}` : null;
};

/**
 * Claude's markdown: GFM, sanitised (no raw HTML), highlighted code blocks. `onRun` adds Run to shell
 * blocks, and to inline commands written for Claude Code's shell mode (`! aoe remove x`); with
 * `anchorKey` (this text's place in the chat), the terminals those Runs open show under them.
 */
export const ChatMarkdown = memo(function ChatMarkdown({
  text,
  className,
  onRun,
  anchorKey,
}: {
  text: string;
  className?: string;
  onRun?: (command: string, anchor?: string) => void;
  anchorKey?: string;
}) {
  const components = useMemo<Components>(() => {
    const base: Components = {
      pre: ({ node, children }) => {
        const code = Array.isArray(children) ? children[0] : children;
        const props = (code as { props?: { className?: string; children?: ReactNode } })?.props ?? {};
        const language = /language-([\w+#-]+)/.exec(props.className ?? '')?.[1] ?? null;
        const offset = node?.position?.start.offset;
        return (
          <CodeBlock
            language={language}
            code={textOf(props.children).replace(/\n$/, '')}
            onRun={onRun}
            anchor={anchorKey && offset !== undefined ? `${anchorKey}:${offset}` : undefined}
          >
            {props.children}
          </CodeBlock>
        );
      },
      // Inline code only: fenced code goes through `pre` above, which renders its own children.
      code: ({ node, className, children }) => {
        const command = onRun && !className ? inlineCommand(textOf(children)) : null;
        if (!command) return <code className={className}>{children}</code>;
        const anchor = hostAnchor(node, anchorKey) ?? undefined;
        return (
          <span>
            <code>{children}</code>
            <button
              type="button"
              onClick={() => onRun!(command, anchor)}
              aria-label={`Run ${command}`}
              title="Run this command"
              className="ml-0.5 inline-grid size-6 cursor-pointer place-items-center rounded-md align-middle text-st-green transition-colors hover:bg-raised"
            >
              <PlayIcon weight="fill" className="size-3.5" />
            </button>
          </span>
        );
      },
      a: ({ href, children }) => (
        <a href={href} target="_blank" rel="noreferrer">
          {children}
        </a>
      ),
      table: ({ children }) => (
        <div className="my-3 overflow-x-auto">
          <table>{children}</table>
        </div>
      ),
    };
    if (!onRun || !anchorKey) return base;
    // Terminals for inline commands: under a paragraph or heading, at the end of a list item or cell.
    const after =
      <T extends 'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'>(Tag: T) =>
      ({ node, ...props }: ComponentProps<T> & Node) => {
        const anchor = hostAnchor(node, anchorKey);
        const El = Tag as 'p';
        return (
          <>
            <El {...(props as ComponentProps<'p'>)} />
            {anchor && <TerminalsAt anchor={anchor} />}
          </>
        );
      };
    const inside =
      <T extends 'li' | 'td' | 'th'>(Tag: T) =>
      ({ node, children, ...props }: ComponentProps<T> & Node) => {
        const anchor = hostAnchor(node, anchorKey);
        const El = Tag as 'li';
        return (
          <El {...(props as ComponentProps<'li'>)}>
            {children}
            {anchor && <TerminalsAt anchor={anchor} />}
          </El>
        );
      };
    return {
      ...base,
      p: after('p'),
      h1: after('h1'),
      h2: after('h2'),
      h3: after('h3'),
      h4: after('h4'),
      h5: after('h5'),
      h6: after('h6'),
      li: inside('li'),
      td: inside('td'),
      th: inside('th'),
    };
  }, [onRun, anchorKey]);
  return (
    <div className={cn('chat-md text-[0.9375rem] leading-7 break-words', className)}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        // Highlight and colour report sections after sanitising, so their classes and attributes survive.
        rehypePlugins={[
          rehypeSanitize,
          [rehypeHighlight, { detect: false, ignoreMissing: true }],
          rehypeRunAnchors,
          rehypeAttention,
        ]}
        components={components}
      >
        {text}
      </Markdown>
    </div>
  );
});
