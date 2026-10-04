import { CheckIcon, CopyIcon } from '@phosphor-icons/react';
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

/** Fenced code: language label, copy button, horizontal scroll, highlight.js tokens. */
export function CodeBlock({
  language,
  code,
  children,
}: {
  language: string | null;
  code: string;
  children?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="group/code my-3 overflow-hidden rounded-lg border border-border bg-background">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <span translate="no" className="font-mono text-[13px] text-muted-foreground">
          {language ?? 'text'}
        </span>
        <button
          type="button"
          onClick={async () => {
            if (await copyText(code)) {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }
          }}
          className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[13px] text-muted-foreground transition-colors hover:bg-raised hover:text-foreground"
        >
          {copied ? <CheckIcon className="size-3.5 text-st-green" /> : <CopyIcon className="size-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre translate="no" className="overflow-x-auto p-3.5 font-mono text-[13px] leading-relaxed">
        <code className="hljs">{children ?? code}</code>
      </pre>
    </div>
  );
}

/** Claude's markdown: GFM, sanitised (no raw HTML), highlighted code blocks. */
export const ChatMarkdown = memo(function ChatMarkdown({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  return (
    <div className={cn('chat-md text-[15px] leading-7 break-words', className)}>
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
              <CodeBlock language={language} code={textOf(props.children).replace(/\n$/, '')}>
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
