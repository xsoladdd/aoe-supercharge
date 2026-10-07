import {
  CheckCircleIcon,
  CopyIcon,
  EyeIcon,
  FileTextIcon,
  HourglassMediumIcon,
  QuestionIcon,
  ShieldCheckIcon,
  WarningOctagonIcon,
  type Icon,
} from '@phosphor-icons/react';
import type { SessionView, WatchKind, WatchNotice } from '@aoe-supercharge/core/shared';
import { toast } from 'sonner';
import { Link } from 'wouter';
import { copyText } from '@/components/copy';
import { chatHref } from '@/lib/nav';
import { cn } from '@/lib/utils';

export const WATCH_KIND: Record<WatchKind, { icon: Icon; label: string; color: string }> = {
  question: { icon: QuestionIcon, label: 'Question', color: 'text-st-red' },
  done: { icon: CheckCircleIcon, label: 'Done', color: 'text-st-green' },
  permission: { icon: ShieldCheckIcon, label: 'Permission prompt', color: 'text-st-yellow' },
  error: { icon: WarningOctagonIcon, label: 'Error', color: 'text-st-red' },
  stalled: { icon: HourglassMediumIcon, label: 'Stalled', color: 'text-st-orange' },
};

export function watchKind(kind: string): { icon: Icon; label: string; color: string } {
  return (
    WATCH_KIND[kind as WatchKind] ?? {
      icon: EyeIcon,
      label: kind.replace(/[_-]+/g, ' '),
      color: 'text-st-blue',
    }
  );
}

/**
 * Where a notice's worker is: its task page, or its session's chat. A notice from control-watch.sh
 * names only the AoE title, so it is found by that.
 */
export function noticeHref(n: WatchNotice, sessions: SessionView[]): string | null {
  if (n.project && n.task) return `/p/${n.project}/t/${n.task}`;
  if (n.session) return chatHref(n.session);
  const byTitle = sessions.filter((s) => s.title === n.worker);
  const s = byTitle.find((x) => !x.archived) ?? byTitle[0];
  return s ? chatHref(s.id) : null;
}

/** A capture Supercharge's watch saved, which the daemon serves; null for another watcher's file. */
export function captureHref(log: string | null): string | null {
  const name = log ? /[\\/]supercharge[\\/]watch[\\/]logs[\\/]([A-Za-z0-9._-]+\.txt)$/.exec(log)?.[1] : null;
  return name ? `/api/watch/logs/${encodeURIComponent(name)}` : null;
}

export function clockTime(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * A `[WATCH]` line in a control chat: a watcher typed it in about a worker, you didn't. One compact
 * row with what happened, when, and links to the worker and to what its pane showed.
 */
export function NoticeRow({
  notice: n,
  at,
  sessions,
}: {
  notice: WatchNotice;
  at: string;
  sessions: SessionView[];
}) {
  const kind = watchKind(n.kind);
  const KindIcon = kind.icon;
  const who = n.name && n.name !== n.worker ? n.name : n.worker;
  const label = n.task ? `${who} (${n.task})` : who;
  const href = noticeHref(n, sessions);
  const capture = captureHref(n.log);
  const when = n.at ?? at;
  const status = n.stage ? n.stage.replace(/_/g, ' ') : n.status;
  return (
    <div
      role="note"
      aria-label={`Watch notice: ${label}, ${kind.label.toLowerCase()}`}
      data-watch-kind={n.kind}
      className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg border border-dashed border-border bg-card/40 px-3 py-1.5 text-[0.8125rem] text-muted-foreground"
    >
      <KindIcon weight="fill" aria-hidden className={cn('size-4 shrink-0', kind.color)} />
      <span className="text-[0.6875rem] font-semibold tracking-wide uppercase">Watch</span>
      <span translate="no" className="min-w-0 truncate font-medium text-foreground" title={n.worker}>
        {label}
      </span>
      <span className={cn('font-medium', kind.color)}>{kind.label}</span>
      {status && <span>· {status}</span>}
      {n.detail && (
        <span className="min-w-0 basis-full truncate sm:flex-1 sm:basis-0" title={n.detail}>
          {n.detail}
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-3">
        <time dateTime={when} title={new Date(when).toLocaleString()} className="tabular-nums">
          {clockTime(when)}
        </time>
        {href && (
          <Link href={href} className="font-medium text-foreground underline-offset-2 hover:underline">
            Open
          </Link>
        )}
        {capture ? (
          <a
            href={capture}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-medium text-foreground underline-offset-2 hover:underline"
          >
            <FileTextIcon aria-hidden className="size-3.5" />
            Log
          </a>
        ) : (
          n.log && (
            <button
              type="button"
              title={n.log}
              aria-label={`Copy the log path: ${n.log}`}
              onClick={() =>
                void copyText(n.log!).then((ok) =>
                  ok ? toast.success('Log path copied') : toast.error('Could not copy'),
                )
              }
              className="inline-flex items-center gap-1 font-medium text-foreground underline-offset-2 hover:underline"
            >
              <CopyIcon aria-hidden className="size-3.5" />
              Log path
            </button>
          )
        )}
      </span>
    </div>
  );
}
