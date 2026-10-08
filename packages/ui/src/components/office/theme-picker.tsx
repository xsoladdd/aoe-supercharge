import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { PaletteIcon } from '@phosphor-icons/react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ApiError, sendJson } from '@/lib/api';
import { makePalette } from '@/lib/office/palette';
import { resolveTheme, THEMES } from '@/lib/office/themes';
import type { Mode, OfficeTheme } from '@/lib/office/themes/types';

/**
 * The office theme you picked (`ui.officeTheme`, SPEC §14.5), shown at once and saved in the background.
 * Saves go one at a time, the latest pick last; while one is on its way, what the daemon sends back of an
 * older pick (each write comes back twice) is not shown, so the floor does not flip back and forth.
 */
export function useOfficeTheme(saved: string): [string, (id: string) => void] {
  const [chosen, setChosen] = useState(saved);
  /** The latest pick, until the daemon has it. */
  const pending = useRef<string | null>(null);
  const sending = useRef(false);
  const savedRef = useRef(saved);
  savedRef.current = saved;

  useEffect(() => {
    if (pending.current === null) setChosen(saved);
    else if (saved === pending.current && !sending.current) pending.current = null;
  }, [saved]);

  const send = useCallback(async () => {
    if (sending.current) return;
    sending.current = true;
    let sent: string | null = null;
    try {
      while (pending.current !== null && pending.current !== sent) {
        sent = pending.current;
        await sendJson('PUT', '/api/config', { patch: { ui: { officeTheme: sent } } });
      }
      // It may have come back while it was on its way (the daemon sends an unchanged setting only once).
      if (pending.current === savedRef.current) pending.current = null;
    } catch (e) {
      pending.current = null;
      setChosen(savedRef.current);
      toast.error('Theme not saved', { description: e instanceof ApiError ? e.message : undefined });
    } finally {
      sending.current = false;
    }
  }, []);

  const pick = useCallback(
    (id: string) => {
      setChosen(id);
      pending.current = id;
      void send();
    },
    [send],
  );
  return [chosen, pick];
}

/** A corner of the office in a theme's colours: its floor, both walls with a window, and its accent. */
export function ThemeThumb({ theme, mode }: { theme: OfficeTheme; mode: Mode }) {
  const p = makePalette(mode, theme);
  const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;
  const accent = theme.thumb.accent[mode];
  // Floor: the corner at (32, 16), out to (4, 30) and (60, 30), the front at (32, 44) under the edge.
  const floor = '32,16 60,30 32,44 4,30';
  const lines: string[] = [];
  const along = (t: number) => `M${4 + 28 * t},${30 - 14 * t} L${32 + 28 * t},${44 - 14 * t}`;
  const across = (t: number) => `M${32 - 28 * t},${16 + 14 * t} L${60 - 28 * t},${30 + 14 * t}`;
  const hint = theme.thumb.floor;
  if (hint === 'planks') for (const t of [0.2, 0.4, 0.6, 0.8]) lines.push(along(t));
  if (hint === 'slabs' || hint === 'plates' || hint === 'flags')
    for (const t of [0.33, 0.66]) lines.push(along(t), across(t));
  if (hint === 'mats') lines.push(along(0.5), across(0.33), across(0.66));
  return (
    <svg
      viewBox="0 0 64 40"
      className="size-auto h-10 w-16 shrink-0 rounded-md ring-1 ring-foreground/10"
      aria-hidden="true"
    >
      <rect width="64" height="40" fill={hex(p.bg)} />
      {/* The walls, with a window on the left and the theme's accent on the right. */}
      <polygon points="4,30 32,16 32,0 4,14" fill={hex(p.wallLeft)} />
      <polygon points="32,16 60,30 60,14 32,0" fill={hex(p.wallRight)} />
      <polygon
        points="10,21 22,15 22,6 10,12"
        fill={hex(p.window)}
        stroke={hex(p.windowFrame)}
        strokeWidth="1"
      />
      <polygon points="40,14 52,20 52,11 40,5" fill={hex(accent)} />
      <polygon points="4,15 32,1 32,0 4,14" fill={hex(p.wallTop)} />
      <polygon points="32,1 60,15 60,14 32,0" fill={hex(p.wallTop)} />
      <polygon points={floor} fill={hex(p.corridor[0])} />
      <path d={lines.join(' ')} stroke={hex(p.seam)} strokeWidth="0.8" opacity="0.8" fill="none" />
      {hint === 'pattern' &&
        [0.25, 0.5, 0.75].flatMap((a) =>
          [0.25, 0.5, 0.75].map((b) => (
            <circle
              key={`${a}${b}`}
              cx={4 + 28 * a + 28 * b}
              cy={30 - 14 * a + 14 * b}
              r="1.2"
              fill={hex(accent)}
              opacity="0.8"
            />
          )),
        )}
      {/* A rug, in the first team's colour. */}
      <polygon
        points="32,27 44,33 32,39 20,33"
        fill={hex(p.carpets[0]![0])}
        stroke={hex(p.runner.border)}
        strokeWidth="0.6"
      />
    </svg>
  );
}

/** The Office page's theme picker: every theme, with a thumbnail in the current mode; picking applies it. */
export function ThemePicker({
  value,
  mode,
  onPick,
}: {
  value: string;
  mode: Mode;
  onPick: (id: string) => void;
}) {
  const current = resolveTheme(value);
  const heading = useId();
  return (
    // Not modal: the floor behind stays in view and in reach while you try one theme after another.
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="px-3"
          title="Dress the office: its floors, walls, windows and decor"
          data-theme-button
        >
          <PaletteIcon />
          Theme
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-[min(20rem,calc(100vw-2rem))] overscroll-contain p-1.5"
        // Named by its heading, not by the button that opens it.
        aria-labelledby={heading}
      >
        <DropdownMenuLabel className="flex flex-col gap-0.5 px-2 pt-1 pb-2">
          <span id={heading} className="text-sm font-semibold text-foreground">
            Office theme
          </span>
          <span className="text-xs font-normal text-muted-foreground">Follows light and dark mode</span>
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup value={current.id} onValueChange={onPick}>
          {THEMES.map((t) => (
            <DropdownMenuRadioItem
              key={t.id}
              value={t.id}
              // Stay open, so you can try one theme after another on the floor behind.
              onSelect={(e) => e.preventDefault()}
              className="gap-3 py-1.5 pr-8 pl-1.5"
              data-office-theme-option={t.id}
            >
              <ThemeThumb theme={t} mode={mode} />
              <span className="flex min-w-0 flex-col">
                <span className="font-medium">{t.name}</span>
                <span className="truncate text-xs text-muted-foreground">{t.blurb}</span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
