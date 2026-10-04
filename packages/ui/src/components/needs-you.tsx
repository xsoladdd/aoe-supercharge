import {
  ChatCircleDotsIcon,
  ClipboardTextIcon,
  CheckCircleIcon,
  GitPullRequestIcon,
  HandPalmIcon,
  QuestionIcon,
  ShieldCheckIcon,
  SmileyIcon,
  WarningOctagonIcon,
  type Icon,
} from '@phosphor-icons/react';
import { relativeTime, type NeedsYouItem, type NeedsYouKind } from '@aoe-supercharge/core/shared';
import { Link } from 'wouter';
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
  session_error: { icon: WarningOctagonIcon, label: 'Session error', color: 'text-st-red' },
  session_missing: { icon: WarningOctagonIcon, label: 'Session missing', color: 'text-st-red' },
  mr_ready: { icon: CheckCircleIcon, label: 'Ready for review', color: 'text-st-green' },
  mr_closed: { icon: GitPullRequestIcon, label: 'MR closed', color: 'text-st-red' },
};

export function hrefFor(item: NeedsYouItem): string {
  // Task items open the task page, whose first tab shows its question or menu with the answer.
  if (item.project && item.taskId) return `/p/${item.project}/t/${item.taskId}`;
  if (item.sessionId && (item.kind === 'control_waiting' || item.kind === 'control_replied'))
    return chatHref(item.sessionId);
  if (item.project) return `/p/${item.project}`;
  if (item.sessionId) return chatHref(item.sessionId);
  return '/';
}

export function NeedsYouStrip({ items }: { items: NeedsYouItem[] }) {
  const now = useNow();
  return (
    <section aria-labelledby="needs-you-heading" className="px-5 pt-4 pb-1 lg:px-7">
      <div className="mb-2.5 flex items-center gap-2">
        <h2 id="needs-you-heading" className="text-[0.9375rem] font-semibold">
          Needs you
        </h2>
        {items.length > 0 ? (
          <span className="tabular grid h-6 min-w-6 place-items-center rounded-full bg-gradient-primary px-2 text-[0.8125rem] font-semibold text-on-gradient">
            {items.length}
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
              <li key={item.id} className="w-[19rem] shrink-0 snap-start">
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
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
