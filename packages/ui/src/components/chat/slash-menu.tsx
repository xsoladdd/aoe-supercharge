import type { SlashCommand } from '@aoe-supercharge/core/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { getJson } from '@/lib/api';
import { cn } from '@/lib/utils';

const cache = new Map<string, { at: number; commands: SlashCommand[] }>();

/** The session's "/" commands, fetched the first time you type a slash (and kept for a minute). */
function useCommands(sessionId: string, wanted: boolean): SlashCommand[] {
  const [commands, setCommands] = useState<SlashCommand[]>(() => cache.get(sessionId)?.commands ?? []);
  useEffect(() => {
    if (!wanted) return;
    const hit = cache.get(sessionId);
    if (hit && Date.now() - hit.at < 60_000) {
      setCommands(hit.commands);
      return;
    }
    let live = true;
    getJson<{ commands: SlashCommand[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/commands`)
      .then((r) => {
        cache.set(sessionId, { at: Date.now(), commands: r.commands });
        if (live) setCommands(r.commands);
      })
      .catch(() => {
        // No list, no completion: typing a command still works.
      });
    return () => {
      live = false;
    };
  }, [sessionId, wanted]);
  return commands;
}

/** Names that start with what you typed come first, then names (or, from 3 letters, descriptions) containing it. */
export function matchCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase();
  const starts = commands.filter((c) => c.name.toLowerCase().startsWith(q));
  const rest = commands.filter(
    (c) =>
      !starts.includes(c) &&
      (c.name.toLowerCase().includes(q) || (q.length >= 3 && c.description.toLowerCase().includes(q))),
  );
  return [...starts, ...rest].slice(0, 60);
}

const SOURCE: Record<SlashCommand['source'], string> = {
  claude: 'Claude Code',
  user: 'yours',
  project: 'project',
  plugin: 'plugin',
};

/**
 * Completion for "/" in the chat box: Claude Code's commands plus your and the project's skills and
 * commands. Open while the text before the caret is a single "/word"; ↑/↓ choose, Tab or Enter
 * completes (Enter sends a command already typed in full), Escape closes.
 */
export function useSlashMenu({
  sessionId,
  value,
  caret,
  onChange,
  inputRef,
}: {
  sessionId: string;
  value: string;
  caret: number;
  onChange: (v: string) => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const token = /^\/[^\s]*$/.test(value.slice(0, caret)) ? value.slice(0, caret) : null;
  const commands = useCommands(sessionId, token !== null);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const items = useMemo(
    () => (token === null ? [] : matchCommands(commands, token.slice(1))),
    [commands, token],
  );
  const open = token !== null && dismissed !== token && items.length > 0;
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => setActive(0), [token]);
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const pick = (c: SlashCommand) => {
    const next = `/${c.name} ${value.slice(caret).replace(/^\s+/, '')}`;
    onChange(next);
    const at = c.name.length + 2;
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(at, at);
    });
  };

  /** Handles the keys the list owns; true means the composer should not act on it. */
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open) return false;
    const move = (d: number) => {
      e.preventDefault();
      setActive((i) => (i + d + items.length) % items.length);
      return true;
    };
    if (e.key === 'ArrowDown') return move(1);
    if (e.key === 'ArrowUp') return move(-1);
    if (e.key === 'Escape') {
      e.preventDefault();
      setDismissed(token);
      return true;
    }
    const chosen = items[active];
    if (!chosen) return false;
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing)) {
      // A command typed out in full runs on Enter, like in Claude Code.
      if (e.key === 'Enter' && token === `/${chosen.name}`) return false;
      e.preventDefault();
      pick(chosen);
      return true;
    }
    return false;
  };

  const inputProps = {
    'aria-autocomplete': 'list' as const,
    'aria-controls': open ? 'slash-list' : undefined,
    'aria-activedescendant': open ? `slash-opt-${active}` : undefined,
  };

  const list = open ? (
    <div className="absolute inset-x-0 bottom-full z-20 mb-2 overflow-hidden rounded-xl border border-border bg-popover shadow-float">
      <ul
        ref={listRef}
        id="slash-list"
        role="listbox"
        aria-label="Commands and skills"
        className="max-h-72 overflow-y-auto overscroll-contain p-1"
      >
        {items.map((c, i) => (
          <li
            key={`${c.kind}:${c.name}`}
            id={`slash-opt-${i}`}
            role="option"
            aria-selected={i === active}
            data-index={i}
            onMouseDown={(e) => {
              // Keep focus in the text box.
              e.preventDefault();
              pick(c);
            }}
            onMouseMove={() => setActive(i)}
            className={cn(
              'flex cursor-pointer items-baseline gap-2 rounded-lg px-2.5 py-1.5 text-sm',
              i === active && 'bg-accent text-accent-foreground',
            )}
          >
            <span translate="no" className="shrink-0 font-mono font-medium">
              /{c.name}
            </span>
            {c.argumentHint && (
              <span className="shrink-0 truncate font-mono text-xs text-muted-foreground max-sm:hidden">
                {c.argumentHint}
              </span>
            )}
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{c.description}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {c.terminal
                ? 'opens in terminal'
                : c.kind === 'builtin'
                  ? SOURCE.claude
                  : `${c.kind === 'skill' ? 'skill' : 'command'}, ${SOURCE[c.source]}`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  ) : null;

  return { open, onKeyDown, inputProps, list };
}
