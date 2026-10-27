import { toast } from 'sonner';
import { copyText } from '@/components/copy';
import { ApiError, sendJson } from '@/lib/api';
import { useLive } from '@/lib/live';

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
