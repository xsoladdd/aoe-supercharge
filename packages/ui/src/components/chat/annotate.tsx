import {
  ArrowUpIcon,
  ArrowUpRightIcon,
  ArrowCounterClockwiseIcon,
  CircleIcon,
  CircleNotchIcon,
  PaperclipIcon,
  PencilSimpleIcon,
  SquareIcon,
  TrashIcon,
  type Icon,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

type Tool = 'ellipse' | 'rect' | 'arrow' | 'pen';
type Point = { x: number; y: number };
type Shape = { tool: Tool; color: string; width: number; points: Point[] };

const TOOLS: { key: Tool; label: string; icon: Icon }[] = [
  { key: 'ellipse', label: 'Circle', icon: CircleIcon },
  { key: 'rect', label: 'Box', icon: SquareIcon },
  { key: 'arrow', label: 'Arrow', icon: ArrowUpRightIcon },
  { key: 'pen', label: 'Pen', icon: PencilSimpleIcon },
];
// Marks have to read on any screenshot, so these are fixed, not theme colours.
const COLORS = [
  { value: '#ef4444', label: 'Red' },
  { value: '#facc15', label: 'Yellow' },
  { value: '#3b82f6', label: 'Blue' },
  { value: '#22c55e', label: 'Green' },
  { value: '#ffffff', label: 'White' },
];
/** Large screenshots are scaled down to this before upload; plenty for Claude to read. */
const MAX_SIDE = 2400;

function draw(ctx: CanvasRenderingContext2D, s: Shape) {
  const a = s.points[0]!;
  const b = s.points.at(-1)!;
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineWidth = s.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  if (s.tool === 'pen') {
    ctx.moveTo(a.x, a.y);
    for (const p of s.points.slice(1)) ctx.lineTo(p.x, p.y);
    ctx.stroke();
  } else if (s.tool === 'rect') {
    ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  } else if (s.tool === 'ellipse') {
    ctx.ellipse(
      (a.x + b.x) / 2,
      (a.y + b.y) / 2,
      Math.abs(b.x - a.x) / 2,
      Math.abs(b.y - a.y) / 2,
      0,
      0,
      Math.PI * 2,
    );
    ctx.stroke();
  } else {
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const head = s.width * 4;
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - head * Math.cos(angle - Math.PI / 7), b.y - head * Math.sin(angle - Math.PI / 7));
    ctx.lineTo(b.x - head * Math.cos(angle + Math.PI / 7), b.y - head * Math.sin(angle + Math.PI / 7));
    ctx.closePath();
    ctx.fill();
  }
}

/**
 * A pasted or picked image opens here first: mark it up (circle, box, arrow, pen), add a message, then
 * Send (or Enter). "Attach" keeps it with the message you are writing instead.
 */
export function AnnotateDialog({
  image,
  initialText,
  onClose,
  onSend,
  onAttach,
}: {
  image: File | null;
  initialText: string;
  onClose: () => void;
  onSend: (png: Blob, text: string) => Promise<void>;
  onAttach: (png: Blob, text: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [draft, setDraft] = useState<Shape | null>(null);
  const [tool, setTool] = useState<Tool>('ellipse');
  const [color, setColor] = useState(COLORS[0]!.value);
  const [text, setText] = useState(initialText);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!image) return;
    let live = true;
    setShapes([]);
    setDraft(null);
    setError(null);
    setText(initialText);
    createImageBitmap(image)
      .then((b) => live && setBitmap(b))
      .catch(() => live && setError('This image could not be opened. Try a PNG or JPEG.'));
    return () => {
      live = false;
    };
    // initialText is read once per image on purpose.
  }, [image]);

  const scale = bitmap ? Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height)) : 1;
  const width = bitmap ? Math.round(bitmap.width * scale) : 0;
  const height = bitmap ? Math.round(bitmap.height * scale) : 0;
  const stroke = Math.max(3, Math.round(Math.max(width, height) / 250));

  const render = useCallback(() => {
    const c = canvasRef.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx || !bitmap) return;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(bitmap, 0, 0, c.width, c.height);
    for (const s of draft ? [...shapes, draft] : shapes) draw(ctx, s);
  }, [bitmap, shapes, draft]);
  useLayoutEffect(render, [render, width, height]);

  const at = (e: React.PointerEvent<HTMLCanvasElement>): Point => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * width, y: ((e.clientY - r.top) / r.height) * height };
  };

  const undo = () => setShapes((s) => s.slice(0, -1));
  const exportPng = () =>
    new Promise<Blob>((resolve, reject) => {
      render();
      canvasRef.current?.toBlob((b) => (b ? resolve(b) : reject(new Error('export failed'))), 'image/png');
    });

  const send = async () => {
    setSending(true);
    try {
      await onSend(await exportPng(), text);
    } catch (e) {
      setError((e as Error).message || 'Could not send.');
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={!!image} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="flex max-h-[94dvh] w-[min(96vw,72rem)] max-w-none flex-col gap-3 p-4 sm:max-w-none"
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
            e.preventDefault();
            undo();
          }
        }}
      >
        <div className="flex flex-wrap items-center gap-2 pr-8">
          <DialogTitle className="mr-2 text-base">Mark up the image</DialogTitle>
          <DialogDescription className="sr-only">
            Draw on the image, add a message, then send it to the session.
          </DialogDescription>
          <div
            role="radiogroup"
            aria-label="Tool"
            className="flex rounded-lg border border-border bg-background p-0.5"
          >
            {TOOLS.map(({ key, label, icon: I }) => (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={tool === key}
                aria-label={label}
                title={label}
                onClick={() => setTool(key)}
                className={cn(
                  'grid size-8 cursor-pointer place-items-center rounded-md transition-colors',
                  tool === key ? 'bg-raised text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <I weight={tool === key ? 'bold' : 'regular'} className="size-4" />
              </button>
            ))}
          </div>
          <div role="radiogroup" aria-label="Colour" className="flex items-center gap-1.5 px-1">
            {COLORS.map((c) => (
              <button
                key={c.value}
                type="button"
                role="radio"
                aria-checked={color === c.value}
                aria-label={c.label}
                title={c.label}
                onClick={() => setColor(c.value)}
                className={cn(
                  'size-6 cursor-pointer rounded-full border-2 transition-transform',
                  color === c.value ? 'scale-110 border-foreground' : 'border-border',
                )}
                style={{ backgroundColor: c.value }}
              />
            ))}
          </div>
          <Button variant="ghost" size="sm" onClick={undo} disabled={!shapes.length}>
            <ArrowCounterClockwiseIcon />
            Undo
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setShapes([])} disabled={!shapes.length}>
            <TrashIcon />
            Clear
          </Button>
        </div>

        <div className="grid min-h-0 flex-1 place-items-center overflow-auto rounded-lg bg-background p-2">
          {error ? (
            <p role="alert" className="p-6 text-sm text-st-red">
              {error}
            </p>
          ) : !bitmap ? (
            <CircleNotchIcon
              className="size-6 animate-spin text-muted-foreground"
              aria-label="Loading the image"
            />
          ) : (
            <canvas
              ref={canvasRef}
              width={width}
              height={height}
              aria-label="Image to mark up"
              className="max-h-[62dvh] max-w-full cursor-crosshair touch-none rounded-md object-contain"
              style={{ aspectRatio: `${width} / ${height}` }}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                const p = at(e);
                setDraft({ tool, color, width: stroke, points: [p, p] });
              }}
              onPointerMove={(e) => {
                if (!draft) return;
                const p = at(e);
                setDraft(
                  (d) => d && { ...d, points: d.tool === 'pen' ? [...d.points, p] : [d.points[0]!, p] },
                );
              }}
              onPointerUp={() => {
                if (draft) {
                  const [a, b] = [draft.points[0]!, draft.points.at(-1)!];
                  // A click without a drag draws nothing.
                  if (draft.tool === 'pen' || Math.hypot(b.x - a.x, b.y - a.y) > 4)
                    setShapes((s) => [...s, draft]);
                }
                setDraft(null);
              }}
            />
          )}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
          className="flex items-end gap-2 rounded-2xl border border-border-strong bg-card py-1.5 pr-1.5 pl-4 focus-within:border-ring/70 focus-within:ring-3 focus-within:ring-ring/25"
        >
          <label htmlFor="annotate-text" className="sr-only">
            Message with the image
          </label>
          <textarea
            id="annotate-text"
            rows={1}
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (!sending) void send();
              }
            }}
            placeholder="Add a message…"
            className="block max-h-40 min-h-9 min-w-0 flex-1 resize-none bg-transparent py-1.5 text-[0.9375rem] leading-relaxed placeholder:text-muted-foreground focus-visible:outline-none"
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!bitmap || sending}
            onClick={async () => onAttach(await exportPng(), text)}
            title="Keep it with the message you are writing"
          >
            <PaperclipIcon />
            Attach
          </Button>
          <button
            type="submit"
            disabled={!bitmap || sending}
            aria-label={sending ? 'Sending' : 'Send image'}
            title="Send (Enter)"
            className="grid size-9 shrink-0 cursor-pointer place-items-center rounded-full bg-gradient-primary text-on-gradient transition hover:brightness-[0.94] active:scale-95 disabled:opacity-50"
          >
            {sending ? (
              <CircleNotchIcon className="size-4 animate-spin" />
            ) : (
              <ArrowUpIcon weight="bold" className="size-4" />
            )}
          </button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
