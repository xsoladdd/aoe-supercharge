import { ArrowClockwiseIcon, CircleNotchIcon, HandGrabbingIcon } from '@phosphor-icons/react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal, type ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { takeShellRuns, useShellRunVersion } from '@/lib/shell-runs';

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

type State = 'connecting' | 'live' | 'elsewhere' | 'closed';

/**
 * A session's own shell, in its folder: AoE's paired terminal (the Terminal tab in AoE's web view),
 * through the daemon. Type in it as in any terminal. Commands from a chat's Run button arrive through
 * `requestShellRun` and are sent once the shell is connected.
 */
export default function ShellTerminal({ sessionId }: { sessionId: string }) {
  const host = useRef<HTMLDivElement>(null);
  const socket = useRef<WebSocket | null>(null);
  const ready = useRef(false);
  const [state, setState] = useState<State>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const runs = useShellRunVersion();

  const flush = () => {
    const ws = socket.current;
    if (!ready.current || ws?.readyState !== WebSocket.OPEN) return;
    for (const command of takeShellRuns(sessionId)) ws.send(JSON.stringify({ type: 'run', command }));
  };

  useEffect(() => {
    const el = host.current!;
    const term = new Terminal({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim(),
      fontSize: 13,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 2000,
      theme: theme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();
    ready.current = false;
    setState('connecting');
    setError(null);
    const ws = new WebSocket(
      `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/sessions/${encodeURIComponent(sessionId)}/shell/ws`,
    );
    ws.binaryType = 'arraybuffer';
    socket.current = ws;
    const send = (m: object) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
    };
    const resize = () => {
      fit.fit();
      send({ type: 'resize', cols: term.cols, rows: term.rows });
    };
    let pending: Frame | null = null;
    const atBottom = () => term.buffer.active.viewportY >= term.buffer.active.baseY;
    ws.onopen = () => {
      // Scrollback to read back through; AoE caps it at 4000.
      send({ type: 'window', lines: 1000 });
      resize();
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      const m = JSON.parse(e.data) as { type?: string; is_owner?: boolean; message?: string };
      if (m.type === 'frame') {
        // While you read back through the scrollback, hold the latest frame until you are at the end.
        if (atBottom()) paint(term, m as Frame);
        else pending = m as Frame;
      } else if (m.type === 'size_owner') {
        ready.current = true;
        setState(m.is_owner ? 'live' : 'elsewhere');
        flush();
      } else if (m.type === 'sc_error') setError(m.message ?? 'Something went wrong.');
      else if (m.type === 'sc_ran') term.focus();
    };
    ws.onclose = () => {
      ready.current = false;
      setState('closed');
    };
    const enc = new TextEncoder();
    const typed = term.onData((d) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(enc.encode(d));
    });
    const typedBinary = term.onBinary((d) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(Uint8Array.from(d, (c) => c.charCodeAt(0)));
    });
    const scrolled = term.onScroll(() => {
      if (pending && atBottom()) {
        paint(term, pending);
        pending = null;
      }
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(resize, 80);
    });
    observer.observe(el);
    const themeWatch = new MutationObserver(() => (term.options.theme = theme()));
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => {
      clearTimeout(timer);
      observer.disconnect();
      themeWatch.disconnect();
      typed.dispose();
      typedBinary.dispose();
      scrolled.dispose();
      ws.close();
      socket.current = null;
      term.dispose();
    };
  }, [sessionId, attempt]);

  // A Run button queued a command while the shell was open.
  useEffect(flush, [runs]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {(state !== 'live' || error) && (
        <div
          role={error ? 'alert' : 'status'}
          className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-sm text-muted-foreground"
        >
          {state === 'connecting' && !error && (
            <>
              <CircleNotchIcon className="size-4 animate-spin" />
              Opening the terminal…
            </>
          )}
          {state === 'elsewhere' && (
            <>
              <span className="mr-auto">This terminal is open in AoE, which has the keyboard.</span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  const ws = socket.current;
                  ws?.send(JSON.stringify({ type: 'claim' }));
                }}
              >
                <HandGrabbingIcon />
                Take over
              </Button>
            </>
          )}
          {state === 'closed' && (
            <>
              <span className="mr-auto">{error ?? 'The terminal connection closed.'}</span>
              <Button size="sm" variant="outline" onClick={() => setAttempt((a) => a + 1)}>
                <ArrowClockwiseIcon />
                Reconnect
              </Button>
            </>
          )}
          {state !== 'closed' && error && <span className="text-st-red">{error}</span>}
        </div>
      )}
      <div
        ref={host}
        aria-label="Terminal"
        className="min-h-0 flex-1 overflow-hidden bg-background px-2 py-1.5"
      />
    </div>
  );
}
