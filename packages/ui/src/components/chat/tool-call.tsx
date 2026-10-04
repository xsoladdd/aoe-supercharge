import {
  CaretRightIcon,
  CheckCircleIcon,
  CircleNotchIcon,
  FileTextIcon,
  GlobeIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  RobotIcon,
  TerminalIcon,
  WrenchIcon,
  XCircleIcon,
  type Icon,
} from '@phosphor-icons/react';
import type { ChatBlock } from '@aoe-supercharge/core/shared';
import { CodeBlock } from '@/components/chat/markdown';
import { cn } from '@/lib/utils';

type Tool = Extract<ChatBlock, { kind: 'tool' }>;

const ICON: Record<string, Icon> = {
  Bash: TerminalIcon,
  Read: FileTextIcon,
  Write: PencilSimpleIcon,
  Edit: PencilSimpleIcon,
  MultiEdit: PencilSimpleIcon,
  NotebookEdit: PencilSimpleIcon,
  Grep: MagnifyingGlassIcon,
  Glob: MagnifyingGlassIcon,
  WebFetch: GlobeIcon,
  WebSearch: GlobeIcon,
  Task: RobotIcon,
  Agent: RobotIcon,
};

function inputCode(tool: Tool): { language: string; code: string } {
  if (tool.name === 'Bash') {
    try {
      const cmd = (JSON.parse(tool.input) as { command?: string }).command;
      if (cmd) return { language: 'bash', code: cmd };
    } catch {
      // fall through to JSON
    }
  }
  return { language: 'json', code: tool.input };
}

/** Paths inside the session's own folder read better relative to it. */
export function shortPath(text: string, cwd: string | null): string {
  return cwd ? text.split(`${cwd.replace(/\/$/, '')}/`).join('') : text;
}

/** A tool call as one quiet row; expand for its input and output (like Claude's own UI). */
export function ToolCall({
  tool,
  running,
  cwd = null,
}: {
  tool: Tool;
  running: boolean;
  cwd?: string | null;
}) {
  const I = ICON[tool.name] ?? WrenchIcon;
  const pending = tool.result === null;
  const input = inputCode(tool);
  return (
    <details className="group/tool rounded-lg border border-border bg-card/60 open:bg-card">
      <summary className="flex cursor-pointer list-none items-center gap-2.5 rounded-lg px-3 py-2 text-sm select-none hover:bg-raised/70 [&::-webkit-details-marker]:hidden">
        <CaretRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open/tool:rotate-90" />
        <I className="size-4 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-medium">{tool.name}</span>
        <span
          translate="no"
          title={tool.summary}
          className="min-w-0 flex-1 truncate font-mono text-[13px] text-muted-foreground"
        >
          {shortPath(tool.summary, cwd)}
        </span>
        {pending ? (
          running ? (
            <CircleNotchIcon
              className="size-4 shrink-0 animate-spin text-st-blue"
              aria-hidden={false}
              role="img"
              aria-label="Running"
            />
          ) : (
            <span className="shrink-0 text-[13px] text-muted-foreground">No result</span>
          )
        ) : tool.isError ? (
          <XCircleIcon
            weight="fill"
            className="size-4 shrink-0 text-st-red"
            aria-hidden={false}
            role="img"
            aria-label="Failed"
          />
        ) : (
          <CheckCircleIcon
            weight="fill"
            className="size-4 shrink-0 text-st-green"
            aria-hidden={false}
            role="img"
            aria-label="Done"
          />
        )}
      </summary>
      <div className="space-y-2 border-t border-border px-3 pt-1 pb-3">
        <CodeBlock language={input.language} code={input.code} />
        {tool.result !== null && (
          <div>
            <div className={cn('mb-1 text-[13px]', tool.isError ? 'text-st-red' : 'text-muted-foreground')}>
              {tool.isError ? 'Error' : 'Output'}
            </div>
            <pre
              translate="no"
              className="max-h-80 overflow-auto rounded-md border border-border bg-background p-3 font-mono text-[13px] leading-relaxed whitespace-pre-wrap"
            >
              {tool.result || '(empty)'}
            </pre>
          </div>
        )}
      </div>
    </details>
  );
}
