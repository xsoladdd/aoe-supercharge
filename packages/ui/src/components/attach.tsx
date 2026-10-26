import { PlayIcon } from '@phosphor-icons/react';
import { toast } from 'sonner';
import { copyText } from '@/components/copy';
import { Button } from '@/components/ui/button';
import { ApiError, sendJson } from '@/lib/api';
import { useLive } from '@/lib/live';
import { cn } from '@/lib/utils';

/** What you type to attach to a session in your own terminal, in the AoE profile Supercharge manages. */
export function useAttachCommand(sessionId: string): string {
  const profile = useLive().snapshot?.health.aoe.profile;
  return profile ? `aoe session attach -p ${profile} ${sessionId}` : `aoe session attach ${sessionId}`;
}

/**
 * Open a new tab in your terminal app (iTerm2, else Terminal), attached to the session. Where the daemon
 * can't (not macOS, or not allowed to), the command is copied instead.
 */
export async function attachInTerminal(sessionId: string) {
  try {
    const r = await sendJson<{ opened: boolean; app?: string; command: string; message?: string }>(
      'POST',
      `/api/sessions/${encodeURIComponent(sessionId)}/attach`,
    );
    if (r.opened) toast.success(`Opened in ${r.app}`, { description: r.command });
    else if (await copyText(r.command))
      toast.info('Copied the attach command', { description: `${r.message} Paste it in a terminal.` });
    else toast.error('Could not open a terminal', { description: r.message });
  } catch (e) {
    toast.error('Could not open a terminal', { description: e instanceof ApiError ? e.message : undefined });
  }
}

/** The chat header's play button. */
export function AttachButton({ sessionId }: { sessionId: string }) {
  return (
    <Button
      variant="outline"
      size="icon-sm"
      className="size-8"
      aria-label="Attach in a terminal"
      title="Attach in a new terminal tab"
      onClick={() => void attachInTerminal(sessionId)}
    >
      <PlayIcon weight="fill" />
    </Button>
  );
}

/**
 * A sidebar chat row's play button: it covers the row's icon while you point at the row or tab to it,
 * and stays shown on touch screens. A sibling of the row's link, since a button can't sit inside one.
 */
export function SidebarAttach({ sessionId, title }: { sessionId: string; title: string }) {
  return (
    <button
      type="button"
      aria-label={`Attach ${title} in a terminal`}
      title="Attach in a new terminal tab"
      onClick={() => void attachInTerminal(sessionId)}
      className={cn(
        'absolute top-[calc((2rem_-_max(1.5rem,24px))/2)] left-1 grid size-[max(1.5rem,24px)] place-items-center rounded-md bg-sidebar-accent text-sidebar-accent-foreground opacity-0 outline-hidden group-data-[collapsible=icon]:hidden',
        'group-hover/menu-sub-item:opacity-100 hover:text-primary focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-sidebar-ring pointer-coarse:opacity-100',
      )}
    >
      <PlayIcon weight="fill" className="size-3.5" />
    </button>
  );
}
