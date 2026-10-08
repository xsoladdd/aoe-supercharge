/**
 * How the chat composer sends: `hold` keeps a message in Supercharge while Claude is busy and types it
 * once Claude is done (the default); `now` types it straight away (Claude Code takes it mid-turn);
 * `interrupt` presses Escape to stop the turn, then types it.
 */
export type SendMode = 'hold' | 'now' | 'interrupt';
export const SEND_MODES: readonly SendMode[] = ['hold', 'now', 'interrupt'];

/** A message the daemon holds for a session until Claude is free (SPEC §8.4: still audited when typed). */
export interface HeldMessage {
  id: string;
  sessionId: string;
  /** Exactly what gets typed: the text, then an `Attached: <path>` line per file. */
  message: string;
  heldAt: string;
  /**
   * `held`: waiting its turn · `sending`: being typed now · `failed`: typing it failed and it may have
   * gone in anyway, so the session's line waits for you (Retry, Edit or Cancel).
   */
  state: 'held' | 'sending' | 'failed';
  error: string | null;
}

/** What the send route answers: typed now, or held. */
export type SendResult = { ok: true } | { held: HeldMessage; note?: string };

/** Why a held message is still waiting, for its bubble. */
export function heldReason(
  m: HeldMessage,
  index: number,
  session: { status: string; prompt?: unknown; archived?: boolean } | null,
): string {
  if (m.state === 'sending') return 'Sending…';
  if (m.state === 'failed') return m.error ?? 'Could not send this.';
  if (index > 0) return 'Held. Waiting its turn';
  if (session?.archived) return 'Held. Sends once the session is back from the archive';
  if (session?.prompt) return "Held. Sends after you answer Claude's menu";
  return 'Held. Sends when Claude is done';
}
