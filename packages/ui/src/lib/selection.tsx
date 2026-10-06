import { XIcon } from '@phosphor-icons/react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { Button } from '@/components/ui/button';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

interface Selection {
  /** AoE session ids picked for a bulk right-click action. */
  ids: ReadonlySet<string>;
  /**
   * A click on a row in a list (`order` is that list's session ids, top to bottom). Ctrl or ⌘ toggles
   * the row, Shift selects the range from the last toggled row. Returns true when the click selected
   * (the caller then stops it navigating); a plain click clears the selection and navigates.
   */
  click: (e: React.MouseEvent, id: string, order: readonly string[]) => boolean;
  /** The sessions a right-click on `id` acts on: the selection when `id` is in it, else just `id`. */
  targets: (id: string) => string[];
  clear: () => void;
}

const SelectionContext = createContext<Selection | null>(null);

export function SelectionProvider({ children }: { children: React.ReactNode }) {
  const [ids, setIds] = useState<ReadonlySet<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const [location] = useLocation();
  const clear = useCallback(() => {
    anchor.current = null;
    setIds((cur) => (cur.size ? new Set() : cur));
  }, []);

  // A plain click navigates, and a new page starts with nothing selected.
  useEffect(clear, [location, clear]);

  useEffect(() => {
    if (!ids.size) return;
    const onKey = (e: KeyboardEvent) => {
      // Escape closes an open menu or dialog first; only a second Escape drops the selection.
      if (
        e.key !== 'Escape' ||
        document.querySelector('[role="menu"], [role="dialog"], [role="alertdialog"]')
      )
        return;
      clear();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ids, clear]);

  const value = useMemo<Selection>(
    () => ({
      ids,
      click(e, id, order) {
        const toggle = e.metaKey || e.ctrlKey;
        if (e.shiftKey && anchor.current && order.includes(anchor.current)) {
          const [a, b] = [order.indexOf(anchor.current), order.indexOf(id)].sort((x, y) => x - y);
          const range = order.slice(a!, b! + 1);
          setIds((cur) => new Set(toggle ? [...cur, ...range] : range));
          return true;
        }
        if (toggle || e.shiftKey) {
          anchor.current = id;
          setIds((cur) => {
            const next = new Set(cur);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          });
          return true;
        }
        clear();
        return false;
      },
      targets(id) {
        if (ids.has(id) && ids.size > 1) return [...ids];
        // A right-click outside the selection acts on that row alone and leaves nothing selected.
        clear();
        return [id];
      },
      clear,
    }),
    [ids, clear],
  );

  return (
    <SelectionContext.Provider value={value}>
      {children}
      <SelectionBar />
    </SelectionContext.Provider>
  );
}

export function useSelection(): Selection {
  const s = useContext(SelectionContext);
  if (!s) throw new Error('useSelection outside SelectionProvider');
  return s;
}

/**
 * Props for a selectable row: Ctrl/⌘/Shift clicks select instead of opening the row (the browser would
 * otherwise open it in a new tab or window). On a Mac, Ctrl+click is the system's right-click, so the
 * browser sends it as a context menu event; a left-button one still means "select" here.
 */
export function useSelectableRow(id: string, order: readonly string[]) {
  const sel = useSelection();
  return {
    'data-selected': sel.ids.has(id) || undefined,
    onClickCapture: (e: React.MouseEvent) => {
      if (sel.click(e, id, order)) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    onMouseDown: (e: React.MouseEvent) => {
      // Shift+click would otherwise extend the page's text selection.
      if (e.shiftKey) e.preventDefault();
    },
    onContextMenu: (e: React.MouseEvent) => {
      if (isMac && e.ctrlKey && e.button === 0) {
        e.preventDefault();
        sel.click(e, id, order);
      }
    },
  };
}

/** Shows while more than one session is picked: how many, and how to act on or drop them. */
function SelectionBar() {
  const sel = useContext(SelectionContext)!;
  const n = sel.ids.size;
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-[calc(1rem+env(safe-area-inset-bottom,0px))] z-40 flex justify-center px-4"
    >
      {n > 1 && (
        <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-border bg-popover py-1 pr-1 pl-4 text-sm shadow-lg">
          <span>
            <strong className="tabular">{n}</strong> selected · right-click for actions
          </span>
          <Button variant="ghost" size="sm" className="h-7 rounded-full" onClick={sel.clear}>
            <XIcon />
            Clear
          </Button>
        </div>
      )}
    </div>
  );
}

/** Where the browser's own right-click menu still makes sense: text you can edit, select or open. */
const NATIVE_MENU =
  'input, textarea, select, [contenteditable=""], [contenteditable="true"], .chat-md, pre, code, a[href^="http"], [data-native-menu]';

/**
 * Supercharge is an app: right-click opens its own menus (session rows), and elsewhere the browser's
 * page menu (Back, Reload, Inspect) stays away. It still shows on editable fields, on chat and plan
 * text and code, on links out, and whenever you have text selected, so copy and paste keep working.
 */
export function useAppContextMenu() {
  useEffect(() => {
    const onMenu = (e: MouseEvent) => {
      if (e.defaultPrevented) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest(NATIVE_MENU)) return;
      if (window.getSelection()?.toString()) return;
      e.preventDefault();
    };
    document.addEventListener('contextmenu', onMenu);
    return () => document.removeEventListener('contextmenu', onMenu);
  }, []);
}
