import { CheckIcon, CopyIcon, PlayIcon } from '@phosphor-icons/react';
import { runnableCommand } from '@aoe-supercharge/core/shared';
import { memo, useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import { copyText } from '@/components/copy';
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
 * shell block also offers Run.
 */
export function CodeBlock({
  language,
  code,
  children,
  onRun,
}: {
  language: string | null;
  code: string;
  children?: ReactNode;
  onRun?: (command: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const command = onRun ? runnableCommand(language, code) : null;
  return (
    <div className="group/code my-3 overflow-hidden rounded-lg border border-border bg-background">
      <div className="flex items-center gap-1 border-b border-border px-3 py-1.5">
        <span translate="no" className="mr-auto font-mono text-[0.8125rem] text-muted-foreground">
          {language ?? 'text'}
        </span>
        {command !== null && (
          <button
            type="button"
            onClick={() => onRun!(command)}
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
  );
}

/** Claude's markdown: GFM, sanitised (no raw HTML), highlighted code blocks; `onRun` adds Run to shell blocks. */
export const ChatMarkdown = memo(function ChatMarkdown({
  text,
  className,
  onRun,
}: {
  text: string;
  className?: string;
  onRun?: (command: string) => void;
}) {
  return (
    <div className={cn('chat-md text-[0.9375rem] leading-7 break-words', className)}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        // Highlight after sanitising, so token classes survive.
        rehypePlugins={[rehypeSanitize, [rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={{
          pre: ({ children }) => {
            const code = Array.isArray(children) ? children[0] : children;
            const props = (code as { props?: { className?: string; children?: ReactNode } })?.props ?? {};
            const language = /language-([\w+#-]+)/.exec(props.className ?? '')?.[1] ?? null;
            return (
              <CodeBlock language={language} code={textOf(props.children).replace(/\n$/, '')} onRun={onRun}>
                {props.children}
              </CodeBlock>
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
        }}
      >
        {text}
      </Markdown>
    </div>
  );
});
