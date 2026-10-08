import { FitAddon } from '@xterm/addon-fit';
import { Terminal, type ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import { cn } from '@/lib/utils';

/** A frame of AoE's live view (src/server/live_ws.rs, AoE 1.17.2): the window, history lines first. */
interface Frame {
  type: 'frame';
  content: string;
  rows: number;
  cursor: { x: number; y: number } | null;
}

/** VS Code's light terminal colours: xterm's defaults are made for a dark background. */
const LIGHT_ANSI: ITheme = {
  black: '#000000',
  red: '#cd3131',
  green: '#107c10',
  yellow: '#949800',
  blue: '#0451a5',
  magenta: '#bc05bc',
  cyan: '#0598bc',
  white: '#555555',
  brightBlack: '#666666',
  brightRed: '#cd3131',
  brightGreen: '#14ce14',
  brightYellow: '#b5ba00',
  brightBlue: '#0451a5',
  brightMagenta: '#bc05bc',
  brightCyan: '#0598bc',
  brightWhite: '#a5a5a5',
};

function theme(): ITheme {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  const dark = document.documentElement.classList.contains('dark');
  return {
    ...(dark ? {} : LIGHT_ANSI),
    background: v('--background'),
    foreground: v('--foreground'),
    cursor: v('--foreground'),
    cursorAccent: v('--background'),
    selectionBackground: dark ? '#ffffff33' : '#00000026',
  };
}

/**
 * Paint a frame. AoE sends the whole window each time, so the terminal is cleared and written again in
 * one go (one repaint, no flicker), and the cursor put where AoE says.
 */
function paint(term: Terminal, f: Frame) {
  const lines = f.content.split('\n');
  const top = Math.max(0, lines.length - term.rows);
  const screenTop = lines.length - f.rows - top;
  const cursor = f.cursor ? `\x1b[${screenTop + f.cursor.y + 1};${f.cursor.x + 1}H\x1b[?25h` : '\x1b[?25l';
  term.write(`\x1b[H\x1b[2J\x1b[3J${lines.map((l) => `${l}\x1b[0m`).join('\r\n')}${cursor}`);
}

export type LiveState = 'connecting' | 'live' | 'elsewhere' | 'closed';

/** A message from the daemon or AoE other than a frame: `size_owner`, `sc_error`, `sc_note`, `sc_ran`. */
export interface LiveMessage {
  type?: string;
  is_owner?: boolean;
  message?: string;
}

export interface LiveTerminalHandle {
  /** Send a control message; false when the terminal is not connected. */
  send: (m: object) => boolean;
  /** Type as if on the keyboard. */
  type: (keys: string) => void;
  focus: () => void;
}

/**
 * One of a session's shells, through the daemon: AoE's live view of a paired terminal, drawn with
 * xterm.js. Type in it as in any terminal; scroll back through its last 1000 lines. Reconnects when
 * `attempt` changes.
 */
export function LiveTerminal({
  path,
  attempt,
  label,
  onState,
  onMessage,
  ref,
  className,
}: {
  /** The daemon's websocket path for this terminal. */
  path: string;
  attempt: number;
  label: string;
  onState: (state: LiveState) => void;
  onMessage?: (m: LiveMessage) => void;
  ref?: Ref<LiveTerminalHandle>;
  className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const socket = useRef<WebSocket | null>(null);
  const term = useRef<Terminal | null>(null);
  // The latest callbacks, without reconnecting when they change.
  const handlers = useRef({ onState, onMessage });
  handlers.current = { onState, onMessage };

  useImperativeHandle(ref, () => ({
    send: (m) => {
      const ws = socket.current;
      if (ws?.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(m));
      return true;
    },
    type: (keys) => {
      const ws = socket.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(keys));
    },
    focus: () => term.current?.focus(),
  }));

  useEffect(() => {
    const el = host.current!;
    const t = new Terminal({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim(),
      fontSize: 13,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 2000,
      theme: theme(),
    });
    term.current = t;
    const fit = new FitAddon();
    t.loadAddon(fit);
    t.open(el);
    fit.fit();
    handlers.current.onState('connecting');
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`);
    ws.binaryType = 'arraybuffer';
    socket.current = ws;
    const send = (m: object) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
    };
    const resize = () => {
      fit.fit();
      send({ type: 'resize', cols: t.cols, rows: t.rows });
    };
    let pending: Frame | null = null;
    const atBottom = () => t.buffer.active.viewportY >= t.buffer.active.baseY;
    ws.onopen = () => {
      // Scrollback to read back through; AoE caps it at 4000.
      send({ type: 'window', lines: 1000 });
      resize();
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      const m = JSON.parse(e.data) as LiveMessage;
      if (m.type === 'frame') {
        // While you read back through the scrollback, hold the latest frame until you are at the end.
        if (atBottom()) paint(t, m as unknown as Frame);
        else pending = m as unknown as Frame;
        return;
      }
      if (m.type === 'size_owner') handlers.current.onState(m.is_owner ? 'live' : 'elsewhere');
      else if (m.type === 'sc_ran') t.focus();
      handlers.current.onMessage?.(m);
    };
    ws.onclose = () => handlers.current.onState('closed');
    const enc = new TextEncoder();
    const typed = t.onData((d) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(enc.encode(d));
    });
    const typedBinary = t.onBinary((d) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(Uint8Array.from(d, (c) => c.charCodeAt(0)));
    });
    const scrolled = t.onScroll(() => {
      if (pending && atBottom()) {
        paint(t, pending);
        pending = null;
      }
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(resize, 80);
    });
    observer.observe(el);
    const themeWatch = new MutationObserver(() => (t.options.theme = theme()));
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => {
      clearTimeout(timer);
      observer.disconnect();
      themeWatch.disconnect();
      typed.dispose();
      typedBinary.dispose();
      scrolled.dispose();
      ws.onclose = null;
      ws.close();
      socket.current = null;
      term.current = null;
      t.dispose();
    };
  }, [path, attempt]);

  return (
    <div
      ref={host}
      aria-label={label}
      className={cn('min-h-0 overflow-hidden bg-background px-2 py-1.5', className)}
    />
  );
}
