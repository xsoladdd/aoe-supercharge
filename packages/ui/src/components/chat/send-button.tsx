import {
  ArrowUpIcon,
  CaretUpIcon,
  CircleNotchIcon,
  LightningIcon,
  StopCircleIcon,
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
 * The composer's send button. While Claude is busy (or a menu is open, or messages wait already) Send
 * holds the message until Claude is done; the caret beside it sends now instead, or stops Claude first.
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
  /** Claude is in a turn, so Interrupt can stop it. */
  working: boolean;
  onSend: (mode: SendMode) => void;
}) {
  const label = sending ? 'Sending' : wouldHold ? 'Send when Claude is done' : 'Send message';
  return (
    <span className="flex shrink-0 items-center gap-0.5">
      {wouldHold && (
        <DropdownMenu>
          <DropdownMenuTrigger
            type="button"
            disabled={sending}
            aria-label="More ways to send"
            className="grid size-8 cursor-pointer place-items-center rounded-full text-muted-foreground transition hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
          >
            <CaretUpIcon weight="bold" className="size-3.5" aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top" className="w-72">
            <DropdownMenuItem disabled={empty} onSelect={() => onSend('now')} className="items-start py-1.5">
              <LightningIcon className="mt-0.5" aria-hidden />
              <span className="flex flex-col">
                <span className="font-medium">Send now</span>
                <span className="text-xs text-muted-foreground">Claude reads it during this turn.</span>
              </span>
            </DropdownMenuItem>
            {working && (
              <DropdownMenuItem
                disabled={empty}
                onSelect={() => onSend('interrupt')}
                className="items-start py-1.5"
              >
                <StopCircleIcon className="mt-0.5" aria-hidden />
                <span className="flex flex-col">
                  <span className="font-medium">Interrupt and send</span>
                  <span className="text-xs text-muted-foreground">Stops Claude (Esc), then sends.</span>
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
          wouldHold
            ? 'Send when Claude is done: held here until then, and you can still edit or cancel it. Every message is recorded in the audit log.'
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
