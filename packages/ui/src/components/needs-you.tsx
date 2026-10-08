import {
  ChatCircleDotsIcon,
  ClipboardTextIcon,
  CheckCircleIcon,
  GitPullRequestIcon,
  HandPalmIcon,
  PhoneCallIcon,
  QuestionIcon,
  ShieldCheckIcon,
  SmileyIcon,
  WarningOctagonIcon,
  XIcon,
  type Icon,
} from '@phosphor-icons/react';
import { isRelayed, relativeTime, type NeedsYouItem, type NeedsYouKind } from '@aoe-supercharge/core/shared';
import { useState } from 'react';
import { toast } from 'sonner';
import { Link } from 'wouter';
import { ApiError, sendJson } from '@/lib/api';
import { chatHref } from '@/lib/nav';
import { useNow } from '@/lib/theme';
import { cn } from '@/lib/utils';

export const KIND: Record<NeedsYouKind, { icon: Icon; label: string; color: string }> = {
  question: { icon: QuestionIcon, label: 'Question', color: 'text-st-red' },
  approval: { icon: HandPalmIcon, label: 'Waiting in AoE', color: 'text-st-yellow' },
  plan_approval: { icon: ClipboardTextIcon, label: 'Plan to approve', color: 'text-st-yellow' },
  permission: { icon: ShieldCheckIcon, label: 'Permission needed', color: 'text-st-yellow' },
  control_waiting: { icon: HandPalmIcon, label: 'Control chat waiting', color: 'text-st-yellow' },
  control_replied: { icon: ChatCircleDotsIcon, label: 'Control chat replied', color: 'text-st-violet' },
  control_blocker: { icon: HandPalmIcon, label: 'Blocked on you', color: 'text-st-red' },
  control_needs: { icon: ClipboardTextIcon, label: 'Control chat needs you', color: 'text-st-yellow' },
  control_relayed: { icon: PhoneCallIcon, label: 'Passed on', color: 'text-st-cyan' },
  session_error: { icon: WarningOctagonIcon, label: 'Session error', color: 'text-st-red' },
  session_missing: { icon: WarningOctagonIcon, label: 'Session missing', color: 'text-st-red' },
  mr_ready: { icon: CheckCircleIcon, label: 'Ready for review', color: 'text-st-green' },
  mr_closed: { icon: GitPullRequestIcon, label: 'MR closed', color: 'text-st-red' },
};

export function hrefFor(item: NeedsYouItem): string {
  // Task items open the task page, whose first tab shows its question or menu with the answer.
  if (item.project && item.taskId) return `/p/${item.project}/t/${item.taskId}`;
  // Passed on by a control chat: the worker it is about, who has the answer cards.
  if (item.relay)
    return item.project && item.relay.taskId
      ? `/p/${item.project}/t/${item.relay.taskId}`
      : chatHref(item.relay.sessionId);
  if (item.sessionId && item.kind.startsWith('control_')) return chatHref(item.sessionId);
  if (item.project) return `/p/${item.project}`;
  if (item.sessionId) return chatHref(item.sessionId);
  return '/';
}

/**
 * Dismiss a "Control chat replied" item until the control chat replies again (SPEC §10.2). The only
 * kind you can dismiss: everything else clears when what it is about is done.
 */
export function DismissReply({ item, className }: { item: NeedsYouItem; className?: string }) {
  const [busy, setBusy] = useState(false);
  if (item.kind !== 'control_replied') return null;
  return (
    <button
      type="button"
      disabled={busy}
      data-dismiss={item.id}
      aria-label={`Dismiss: ${item.title} replied`}
      title="Dismiss until it replies again"
      onClick={async () => {
        setBusy(true);
        try {
          await sendJson('POST', '/api/needs-you/dismiss', { id: item.id });
        } catch (e) {
          toast.error('That did not work', { description: e instanceof ApiError ? e.message : undefined });
          setBusy(false);
        }
      }}
      className={cn(
        'grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-raised hover:text-foreground disabled:opacity-50',
        className,
      )}
    >
      <XIcon weight="bold" className="size-4" aria-hidden />
    </button>
  );
}

export function NeedsYouStrip({ items }: { items: NeedsYouItem[] }) {
  const now = useNow();
  // What a control chat passes on is shown, but counted once: as its worker's own item.
  const count = items.filter((i) => !isRelayed(i)).length;
  return (
    <section aria-labelledby="needs-you-heading" className="px-5 pt-4 pb-1 lg:px-7">
      <div className="mb-2.5 flex items-center gap-2">
        <h2 id="needs-you-heading" className="text-[0.9375rem] font-semibold">
          Needs you
        </h2>
        {count > 0 ? (
          <span className="tabular grid h-6 min-w-6 place-items-center rounded-full bg-gradient-primary px-2 text-[0.8125rem] font-semibold text-on-gradient">
            {count}
          </span>
        ) : null}
      </div>
      {items.length === 0 ? (
        <div className="flex items-center gap-2 rounded-lg border border-dashed border-border-strong px-4 py-3 text-[0.9375rem] text-muted-foreground">
          <SmileyIcon className="size-5" aria-hidden />
          Nothing needs you.
        </div>
      ) : (
        <ul className="-mx-1 flex snap-x gap-3 overflow-x-auto px-1 pb-2">
          {items.map((item) => {
            const k = KIND[item.kind];
            return (
              <li key={item.id} className="relative w-[19rem] shrink-0 snap-start">
                <Link
                  href={hrefFor(item)}
                  className="group flex h-full w-full flex-col gap-1.5 rounded-lg border border-border bg-card p-3.5 text-left transition-colors hover:border-border-strong hover:bg-raised"
                >
                  <span className="flex items-center justify-between gap-2">
                    <span
                      className={cn(
                        'tint inline-flex h-6 items-center gap-1.5 rounded-full px-2 text-[0.8125rem] font-medium',
                        k.color,
                      )}
                    >
                      <k.icon weight="fill" className="size-3.5" aria-hidden />
                      {k.label}
                    </span>
                    <span
                      className="tabular text-[0.8125rem] text-muted-foreground"
                      title={new Date(item.since).toLocaleString()}
                    >
                      {relativeTime(item.since, now)}
                    </span>
                  </span>
                  <span className="min-w-0 truncate text-[0.9375rem] font-medium">{item.title}</span>
                  <span className="line-clamp-2 text-sm break-words text-muted-foreground">
                    {item.detail}
                  </span>
                </Link>
                <DismissReply item={item} className="absolute right-2 bottom-2" />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
