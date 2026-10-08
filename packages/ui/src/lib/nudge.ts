import { isRelayed, type NeedsYouItem } from '@aoe-supercharge/core/shared';
import { useEffect, useRef, useState } from 'react';

const NUDGE_EVENT = 'supercharge:nudge';
let audio: HTMLAudioElement | null = null;

/** The "needs you" sound. Browsers only allow it after you have clicked somewhere on the page once. */
export function playNudge(): Promise<void> {
  audio ??= new Audio('/sounds/needs-you.mp3');
  audio.currentTime = 0;
  return audio.play().catch(() => {
    // Autoplay is blocked until the first interaction; the visual nudge still shows.
  });
}

/** An item that already nudged stays quiet this long, even if it drops out of Needs-you and returns. */
const RENUDGE_AFTER_MS = 30 * 60_000;

/**
 * Watches Needs-you for items that were not there before (not on first load) and nudges: plays the
 * sound when it is on, tells listeners (the control chat's status strip) which items are new, and
 * keeps the count in the tab title. Items flicker out and back in (a session going briefly back to
 * work, an AoE poll that failed), so each item nudges once per RENUDGE_AFTER_MS, not on every return.
 */
export function useNeedsYouNudge(all: NeedsYouItem[] | undefined, sound: boolean) {
  const seen = useRef<Set<string> | null>(null);
  const nudged = useRef(new Map<string, number>());
  useEffect(() => {
    if (!all) return;
    // A relayed item repeats what its worker's own item already told you.
    const items = all.filter((i) => !isRelayed(i));
    const ids = new Set(items.map((i) => i.id));
    const now = Date.now();
    if (!seen.current) for (const id of ids) nudged.current.set(id, now);
    else {
      const fresh = items.filter(
        (i) => !seen.current!.has(i.id) && now - (nudged.current.get(i.id) ?? 0) > RENUDGE_AFTER_MS,
      );
      for (const i of fresh) nudged.current.set(i.id, now);
      if (fresh.length) {
        if (sound) void playNudge();
        window.dispatchEvent(new CustomEvent<NeedsYouItem[]>(NUDGE_EVENT, { detail: fresh }));
      }
    }
    seen.current = ids;
    document.title = items.length ? `(${items.length}) Supercharge` : 'Supercharge';
  }, [all, sound]);
}

/** True for a few seconds after a new Needs-you item that matches `filter` arrives. */
export function useNudgeFlash(filter: (item: NeedsYouItem) => boolean, ms = 4000): boolean {
  const [on, setOn] = useState(false);
  const match = useRef(filter);
  match.current = filter;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const onNudge = (e: Event) => {
      if (!(e as CustomEvent<NeedsYouItem[]>).detail.some((i) => match.current(i))) return;
      setOn(true);
      clearTimeout(timer);
      timer = setTimeout(() => setOn(false), ms);
    };
    window.addEventListener(NUDGE_EVENT, onNudge);
    return () => {
      window.removeEventListener(NUDGE_EVENT, onNudge);
      clearTimeout(timer);
    };
  }, [ms]);
  return on;
}
