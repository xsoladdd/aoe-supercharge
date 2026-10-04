import { ChatCenteredTextIcon, CircleNotchIcon, PaperPlaneRightIcon, TrashIcon } from '@phosphor-icons/react';
import type { PlanComment } from '@aoe-supercharge/core/shared';
import { lazy, Suspense, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError, getJson, sendJson } from '@/lib/api';
import { cn } from '@/lib/utils';

const ChatMarkdown = lazy(() =>
  import('@/components/chat/markdown').then((m) => ({ default: m.ChatMarkdown })),
);

const base = (project: string, taskId: string) =>
  `/api/tasks/${encodeURIComponent(project)}/${encodeURIComponent(taskId)}/comments`;

/** A task's plan comments, with add, delete and send. Other views refresh on the shared event. */
export function useComments(project: string, taskId: string) {
  const [comments, setComments] = useState<PlanComment[] | null>(null);
  const load = useCallback(
    () =>
      getJson<{ comments: PlanComment[] }>(base(project, taskId))
        .then((r) => setComments(r.comments))
        .catch(() => setComments((c) => c ?? [])),
    [project, taskId],
  );
  useEffect(() => {
    void load();
    const onChange = (e: Event) =>
      (e as CustomEvent<string>).detail === `${project}/${taskId}` && void load();
    window.addEventListener('supercharge:comments', onChange);
    return () => window.removeEventListener('supercharge:comments', onChange);
  }, [load, project, taskId]);
  const changed = (next: PlanComment[]) => {
    setComments(next);
    window.dispatchEvent(new CustomEvent('supercharge:comments', { detail: `${project}/${taskId}` }));
  };
  return {
    comments,
    add: async (quote: string, text: string) =>
      changed(
        (await sendJson<{ comments: PlanComment[] }>('POST', base(project, taskId), { quote, text }))
          .comments,
      ),
    remove: async (id: string) =>
      changed(
        (await sendJson<{ comments: PlanComment[] }>('DELETE', `${base(project, taskId)}/${id}`)).comments,
      ),
    send: async () =>
      changed(
        (await sendJson<{ comments: PlanComment[] }>('POST', `${base(project, taskId)}/send`, {})).comments,
      ),
  };
}

/** Text nodes under `root` and where each starts in their joined text, for mapping quotes back to ranges. */
function textIndex(root: Node) {
  const nodes: { node: Text; start: number }[] = [];
  let text = '';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push({ node: n as Text, start: text.length });
    text += (n as Text).data;
  }
  return { nodes, text };
}

/** A DOM range for `quote` inside `root`, matching across whitespace differences (selections add newlines). */
function findRange(root: Node, quote: string): Range | null {
  const { nodes, text } = textIndex(root);
  // Collapse whitespace in the haystack while remembering where each kept character came from.
  let flat = '';
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ws = /\s/.test(text[i]!);
    if (ws && flat.endsWith(' ')) continue;
    flat += ws ? ' ' : text[i];
    map.push(i);
  }
  const needle = quote.replace(/\s+/g, ' ').trim();
  const at = needle ? flat.indexOf(needle) : -1;
  if (at < 0) return null;
  const from = map[at]!;
  const to = map[at + needle.length - 1]! + 1;
  const locate = (pos: number) => {
    const hit = [...nodes].reverse().find((n) => n.start <= pos)!;
    return { node: hit.node, offset: Math.min(pos - hit.start, hit.node.data.length) };
  };
  const a = locate(from);
  const b = locate(to);
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  return range;
}

// One shared highlight for every commented passage on screen (CSS Custom Highlight API where supported).
const ranges = new Map<string, Range[]>();
function paintHighlights() {
  const css = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS;
  const H = (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  if (!css?.highlights || !H) return;
  css.highlights.set('plan-comments', new H(...[...ranges.values()].flat()));
}

/**
 * A plan you can comment on: select text and a Comment button appears; commented passages stay
 * highlighted. Comments are kept per task and sent to its worker together.
 */
export function CommentablePlan({
  markdown,
  comments,
  onAdd,
  className,
}: {
  markdown: string;
  comments: PlanComment[];
  onAdd: (quote: string, text: string) => Promise<void>;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const key = useId();
  const [pick, setPick] = useState<{ quote: string; top: number; left: number } | null>(null);
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);

  // Re-highlight when the comments change or the markdown finishes rendering (it loads lazily).
  useLayoutEffect(() => {
    const root = box.current;
    if (!root) return;
    const paint = () => {
      ranges.set(
        key,
        comments.map((c) => findRange(root, c.quote)).filter((r): r is Range => !!r),
      );
      paintHighlights();
    };
    paint();
    const obs = new MutationObserver(paint);
    obs.observe(root, { childList: true, subtree: true });
    return () => {
      obs.disconnect();
      ranges.delete(key);
      paintHighlights();
    };
  }, [comments, markdown, key]);

  const onSelect = () => {
    if (writing) return;
    const sel = window.getSelection();
    const root = box.current;
    if (!sel || sel.isCollapsed || !root || !sel.rangeCount) return setPick(null);
    const range = sel.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) return setPick(null);
    const quote = sel.toString().trim();
    if (!quote) return setPick(null);
    const r = range.getBoundingClientRect();
    const b = root.getBoundingClientRect();
    setPick({
      quote,
      top: r.bottom - b.top + 6,
      left: Math.max(0, Math.min(r.left - b.left, b.width - 320)),
    });
  };

  const save = async () => {
    if (!pick || !text.trim()) return;
    setSaving(true);
    try {
      await onAdd(pick.quote, text);
      setPick(null);
      setWriting(false);
      setText('');
      window.getSelection()?.removeAllRanges();
    } catch (e) {
      toast.error('Comment not saved', { description: e instanceof ApiError ? e.message : undefined });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div ref={box} className={cn('relative', className)} onMouseUp={onSelect} onKeyUp={onSelect}>
      <Suspense fallback={<Skeleton className="h-24 w-full" />}>
        <ChatMarkdown text={markdown} />
      </Suspense>
      {pick && !writing && (
        <Button
          size="sm"
          variant="secondary"
          className="absolute z-10 shadow-float"
          style={{ top: pick.top, left: pick.left }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setWriting(true)}
        >
          <ChatCenteredTextIcon />
          Comment
        </Button>
      )}
      {pick && writing && (
        <form
          className="absolute z-10 w-80 space-y-2 rounded-xl border border-border-strong bg-popover p-3 shadow-float"
          style={{ top: pick.top, left: pick.left }}
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <blockquote className="line-clamp-3 border-l-2 border-st-yellow pl-2 text-sm text-muted-foreground">
            {pick.quote}
          </blockquote>
          <label htmlFor={`${key}-comment`} className="sr-only">
            Your comment
          </label>
          <textarea
            id={`${key}-comment`}
            autoFocus
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void save();
              }
              if (e.key === 'Escape') {
                setWriting(false);
                setPick(null);
              }
            }}
            placeholder="What should change here?"
            className="block w-full resize-y rounded-lg border border-input bg-background px-2.5 py-2 text-[0.9375rem] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-none"
          />
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setWriting(false);
                setPick(null);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={saving || !text.trim()}>
              Save comment
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

/** Unsent comments with Send (all in one message), and the sent ones folded away. */
export function CommentList({
  comments,
  onDelete,
  onSend,
  target,
}: {
  comments: PlanComment[] | null;
  onDelete: (id: string) => Promise<void>;
  onSend: () => Promise<void>;
  /** Who gets them, e.g. "CB-0001". */
  target: string;
}) {
  const [sending, setSending] = useState(false);
  if (comments === null) return <Skeleton className="h-10 w-full" />;
  const open = comments.filter((c) => !c.sentAt);
  const sent = comments.length - open.length;
  if (!comments.length)
    return <p className="text-sm text-muted-foreground">Select text in the plan to comment on it.</p>;
  return (
    <div className="space-y-2">
      {open.length > 0 && (
        <ol className="space-y-2">
          {open.map((c, i) => (
            <li
              key={c.id}
              className="group/comment flex gap-2 rounded-lg border border-border bg-background px-3 py-2"
            >
              <span className="mt-0.5 font-mono text-xs text-muted-foreground">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <blockquote className="line-clamp-2 border-l-2 border-st-yellow pl-2 text-[0.8125rem] text-muted-foreground">
                  {c.quote}
                </blockquote>
                <p className="mt-1 text-[0.9375rem] break-words whitespace-pre-wrap">{c.text}</p>
              </div>
              <button
                type="button"
                aria-label="Delete comment"
                onClick={() => void onDelete(c.id)}
                className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-raised hover:text-st-red"
              >
                <TrashIcon className="size-4" />
              </button>
            </li>
          ))}
        </ol>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm text-muted-foreground">
          {sent > 0 ? `${sent} sent before` : open.length ? 'Not sent yet' : 'All sent'}
        </span>
        {open.length > 0 && (
          <Button
            size="sm"
            variant="gradient"
            disabled={sending}
            onClick={async () => {
              setSending(true);
              try {
                await onSend();
                toast.success(
                  `Sent ${open.length} ${open.length === 1 ? 'comment' : 'comments'} to ${target}`,
                );
              } catch (e) {
                toast.error('Comments not sent', {
                  description: e instanceof ApiError ? e.message : undefined,
                });
              } finally {
                setSending(false);
              }
            }}
          >
            {sending ? <CircleNotchIcon className="animate-spin" /> : <PaperPlaneRightIcon weight="fill" />}
            Send {open.length} to {target}
          </Button>
        )}
      </div>
    </div>
  );
}
