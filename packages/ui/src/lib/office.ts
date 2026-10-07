import { useEffect, useMemo, useRef, useState } from 'react';
import {
  buildOffice as buildFloor,
  nextHoldEnd,
  type HoldMemory,
  type OfficeModel,
  type Snapshot,
  type Zone,
} from '@aoe-supercharge/core/shared';

export type { OfficeModel, OfficeTeam, OfficeWorker } from '@aoe-supercharge/core/shared';

/** Where each character was last seen, kept across visits so a hold survives navigating away and back. */
const lastZone: HoldMemory = new Map();

export function buildOffice(snap: Snapshot, now: Date): OfficeModel {
  return buildFloor(snap, now, lastZone);
}

const MOVED: Record<Zone, string> = {
  door: 'is waiting at your door',
  desk: 'went back to their desk',
  pantry: 'went to the pantry',
  away: 'stepped away',
  review: 'went to the review lounge',
  archived: 'went home for now',
  gone: 'went home',
};

/**
 * The office for the current snapshot. It looks again when a hold runs out (an idle worker finishing
 * up before the pantry), and says in a polite live region who moved where.
 */
export function useOffice(snap: Snapshot): { office: OfficeModel; announcement: string } {
  const [tick, setTick] = useState(0);
  // `tick` re-reads the clock when a hold ends.
  const office = useMemo(() => buildOffice(snap, new Date()), [snap, tick]);

  const nextLook = nextHoldEnd(office, Date.now());
  useEffect(() => {
    if (nextLook === null) return;
    const t = setTimeout(() => setTick((n) => n + 1), Math.max(250, nextLook - Date.now() + 50));
    return () => clearTimeout(t);
  }, [nextLook]);

  const seen = useRef<Map<string, Zone> | null>(null);
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    const before = seen.current;
    seen.current = new Map(office.everyone.map((w) => [w.key, w.zone]));
    if (!before) return;
    const moved = office.everyone.filter((w) => before.has(w.key) && before.get(w.key) !== w.zone);
    if (moved.length) setAnnouncement(moved.map((w) => `${w.name} ${MOVED[w.zone]}.`).join(' '));
  }, [office]);

  return { office, announcement };
}
