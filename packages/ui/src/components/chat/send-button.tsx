import {
  ArrowUpIcon,
  CaretUpIcon,
  CircleNotchIcon,
  ClockIcon,
  HandIcon,
  LightningIcon,
} from '@phosphor-icons/react';
import type { SendMode } from '@aoe-supercharge/core/shared';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

/**
 * The composer's send button. While Claude works, Send types the message in now and Claude Code reads it
 * during the turn; the caret beside it holds it until Claude is done, or stops Claude (Esc) and sends.
 * With a menu open or messages waiting already (Claude not working) Send queues the message, and the
 * caret sends now. A message that can't go in now is queued, never lost.
 */
export function SendButton({
  sending,
  empty,
  wouldHold,
  working,
  onSend,
}: {
  sending: boolean;
  /** Nothing to send yet: the button fades (it still explains why on click). */
  empty: boolean;
  /** Send would hold the message rather than type it now. */
  wouldHold: boolean;
  /** Claude is in a turn: Send types it in now; Interrupt is in the caret. */
  working: boolean;
  onSend: (mode: SendMode) => void;
}) {
  const label = sending
    ? 'Sending'
    : working
      ? 'Send now'
      : wouldHold
        ? 'Send when Claude is done'
        : 'Send message';
  return (
    <span className="flex shrink-0 items-center gap-0.5">
      {wouldHold && (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger
            type="button"
            disabled={sending}
            aria-label="More ways to send"
            className="grid size-8 cursor-pointer place-items-center rounded-full text-muted-foreground transition hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
          >
            <CaretUpIcon weight="bold" className="size-3.5" aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top" className="w-72">
            {working ? (
              <>
                <DropdownMenuItem
                  disabled={empty}
                  onSelect={() => onSend('hold')}
                  className="items-start py-1.5"
                >
                  <ClockIcon className="mt-0.5" aria-hidden />
                  <span className="flex flex-col">
                    <span className="font-medium">Send when Claude is done</span>
                    <span className="text-xs text-muted-foreground">Queued here until the turn ends.</span>
                  </span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={empty}
                  onSelect={() => onSend('interrupt')}
                  className="items-start py-1.5"
                >
                  <HandIcon className="mt-0.5" aria-hidden />
                  <span className="flex flex-col">
                    <span className="font-medium">Interrupt and send</span>
                    <span className="text-xs text-muted-foreground">Stops Claude (Esc), then sends.</span>
                  </span>
                </DropdownMenuItem>
              </>
            ) : (
              <DropdownMenuItem
                disabled={empty}
                onSelect={() => onSend('now')}
                className="items-start py-1.5"
              >
                <LightningIcon className="mt-0.5" aria-hidden />
                <span className="flex flex-col">
                  <span className="font-medium">Send now</span>
                  <span className="text-xs text-muted-foreground">Typed in at once.</span>
                </span>
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <button
        type="submit"
        aria-label={label}
        title={
          working
            ? 'Send now: typed in while Claude works, and Claude reads it during this turn. The caret queues it until Claude is done, or interrupts Claude. Every message is recorded in the audit log.'
            : wouldHold
              ? 'Send when Claude is done: queued here until then, and you can still edit or cancel it. Every message is recorded in the audit log.'
              : 'Send. Every message is recorded in the audit log.'
        }
        aria-disabled={sending || undefined}
        className={cn(
          'grid size-8 shrink-0 cursor-pointer place-items-center rounded-full bg-gradient-primary text-on-gradient shadow-[inset_0_1px_0_rgb(255_255_255/0.18)] transition hover:brightness-[0.94] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card focus-visible:outline-none active:scale-95',
          empty && 'opacity-45',
        )}
      >
        {sending ? (
          <CircleNotchIcon className="size-4 animate-spin" aria-hidden />
        ) : (
          <ArrowUpIcon weight="bold" className="size-4" aria-hidden />
        )}
      </button>
    </span>
  );
}
