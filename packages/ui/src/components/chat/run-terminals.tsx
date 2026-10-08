import type { RunTerminal } from '@aoe-supercharge/core/shared';
import { lazy, Suspense, useEffect, useState } from 'react';
import { useTerminalsAt, useUnplacedTerminals } from '@/lib/run-terminals';

// xterm.js loads only once a chat has a terminal to show.
const InlineTerminal = lazy(() => import('./inline-terminal'));

/** The terminals a Run opened at this place in the chat, right under the command. */
export function TerminalsAt({ anchor }: { anchor: string }) {
  const here = useTerminalsAt(anchor);
  if (!here.length) return null;
  return (
    <Suspense fallback={null}>
      {here.map((t) => (
        <InlineTerminal key={t.id} terminal={t} />
      ))}
    </Suspense>
  );
}

/**
 * Terminals whose command the chat no longer shows (after Start fresh, or from further back than the
 * chat loads), at the end of the conversation, so they can still be read and closed.
 */
export function EarlierTerminals({ sessionId }: { sessionId: string }) {
  const unplaced = useUnplacedTerminals(sessionId);
  // Wait until the chat has placed what it shows, so a terminal never opens twice on its way in.
  const [shown, setShown] = useState<RunTerminal[]>([]);
  useEffect(() => {
    const t = setTimeout(() => setShown(unplaced), 150);
    return () => clearTimeout(t);
  }, [unplaced]);
  const list = shown.filter((t) => unplaced.includes(t));
  if (!list.length) return null;
  return (
    <section aria-labelledby="earlier-terminals" className="space-y-2">
      <h2 id="earlier-terminals" className="text-sm font-medium text-muted-foreground">
        Terminals from earlier in this chat
      </h2>
      <Suspense fallback={null}>
        {list.map((t) => (
          <InlineTerminal key={t.id} terminal={t} />
        ))}
      </Suspense>
    </section>
  );
}
