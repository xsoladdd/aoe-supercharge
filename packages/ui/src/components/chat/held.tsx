import {
  ArrowClockwiseIcon,
  CircleNotchIcon,
  ClockIcon,
  FileIcon,
  PencilSimpleIcon,
  WarningCircleIcon,
  XIcon,
} from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  heldReason,
  splitAttachments,
  type HeldMessage,
  type SendResult,
  type SessionView,
} from '@aoe-supercharge/core/shared';
import { Button } from '@/components/ui/button';
import { ApiError, sendJson } from '@/lib/api';
import { cn } from '@/lib/utils';

const heldUrl = (m: HeldMessage, action = '') =>
  `/api/sessions/${encodeURIComponent(m.sessionId)}/held/${encodeURIComponent(m.id)}${action}`;

/**
 * Messages the daemon holds for this session until Claude is done, at the end of the conversation. Each
 * says why it waits, and can be taken back into the box to edit, or cancelled. One typed in turns into
 * the usual "Sent" bubble (`onDelivered`) until the transcript shows it.
 */
export function HeldBubbles({
  session,
  held,
  onEdit,
  onDelivered,
}: {
  session: SessionView;
  held: HeldMessage[];
  onEdit: (m: HeldMessage) => void;
  onDelivered: (m: HeldMessage) => void;
}) {
  const seen = useRef(new Map<string, HeldMessage>());
  useEffect(() => {
    const now = new Map(held.map((m) => [m.id, m]));
    for (const [id, m] of seen.current) if (!now.has(id) && m.state === 'sending') onDelivered(m);
    seen.current = now;
  }, [held, onDelivered]);

  if (!held.length) return null;
  return (
    <ol aria-label="Held messages" className="flex flex-col gap-4">
      {held.map((m, i) => (
        <li key={m.id}>
          <HeldBubble m={m} reason={heldReason(m, i, session)} onEdit={onEdit} />
        </li>
      ))}
    </ol>
  );
}

function HeldBubble({
  m,
  reason,
  onEdit,
}: {
  m: HeldMessage;
  reason: string;
  onEdit: (m: HeldMessage) => void;
}) {
  const { text: body, files } = useMemo(() => splitAttachments(m.message), [m.message]);
  const [busy, setBusy] = useState(false);
  const sending = m.state === 'sending';
  const failed = m.state === 'failed';

  const take = async (): Promise<HeldMessage | null> => {
    setBusy(true);
    try {
      return (await sendJson<{ held: HeldMessage }>('DELETE', heldUrl(m))).held;
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not change that message.');
      return null;
    } finally {
      setBusy(false);
    }
  };
  const edit = async () => {
    const taken = await take();
    if (taken) onEdit(taken);
  };
  const cancel = async () => {
    const taken = await take();
    if (!taken) return;
    toast('Message cancelled', {
      action: {
        label: 'Undo',
        onClick: () =>
          void sendJson<SendResult>('POST', `/api/sessions/${encodeURIComponent(taken.sessionId)}/send`, {
            message: taken.message,
            mode: 'hold',
          }).catch((e: unknown) =>
            toast.error(e instanceof ApiError ? e.message : 'Could not bring it back.'),
          ),
      },
    });
  };
  const retry = async () => {
    setBusy(true);
    try {
      await sendJson('POST', heldUrl(m, '/retry'));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1.5" data-held={m.state}>
      {files.length > 0 && (
        <ul className="flex max-w-[85%] flex-wrap justify-end gap-2">
          {files.map((f) =>
            f.image && f.url ? (
              <li key={f.path}>
                <img
                  src={f.url}
                  alt={f.name}
                  loading="lazy"
                  className="max-h-40 max-w-full rounded-xl border border-dashed border-border-strong object-contain opacity-80"
                />
              </li>
            ) : (
              <li
                key={f.path}
                className="flex items-center gap-2 rounded-lg border border-dashed border-border-strong px-3 py-1.5 text-sm"
              >
                <FileIcon className="size-4 text-muted-foreground" aria-hidden />
                <span translate="no" className="max-w-56 truncate">
                  {f.name}
                </span>
              </li>
            ),
          )}
        </ul>
      )}
      {body && (
        <div
          className={cn(
            'max-w-[85%] rounded-2xl rounded-br-md border border-dashed px-4 py-2.5 text-[0.9375rem] leading-relaxed break-words whitespace-pre-wrap',
            failed ? 'border-attn-error/40 bg-attn-error/8' : 'border-border-strong bg-raised/50',
          )}
        >
          {body}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1 pr-1 text-[0.8125rem]">
        <span
          className={cn(
            'inline-flex items-center gap-1.5',
            failed ? 'text-attn-error' : 'text-muted-foreground',
          )}
          role={failed ? 'alert' : 'status'}
        >
          {sending ? (
            <CircleNotchIcon className="size-3.5 animate-spin" aria-hidden />
          ) : failed ? (
            <WarningCircleIcon weight="fill" className="size-3.5 shrink-0" aria-hidden />
          ) : (
            <ClockIcon className="size-3.5" aria-hidden />
          )}
          {reason}
        </span>
        {failed && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2"
            disabled={busy}
            onClick={retry}
          >
            <ArrowClockwiseIcon className="size-3.5" aria-hidden />
            Retry
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2"
          disabled={busy || sending}
          onClick={edit}
          aria-label="Edit this held message"
        >
          <PencilSimpleIcon className="size-3.5" aria-hidden />
          Edit
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2"
          disabled={busy || sending}
          onClick={cancel}
          aria-label="Cancel this held message"
        >
          <XIcon className="size-3.5" aria-hidden />
          Cancel
        </Button>
      </div>
    </div>
  );
}
