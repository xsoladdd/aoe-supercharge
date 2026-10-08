import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  buildOffice as buildFloor,
  kitchenMemory,
  nextOfficeLook,
  RUNAWAY_LABEL,
  type HoldMemory,
  type OfficeModel,
  type Snapshot,
  type Zone,
} from '@aoe-supercharge/core/shared';

export type { OfficeModel, OfficeTeam, OfficeWorker } from '@aoe-supercharge/core/shared';

/** Where each character was last seen, kept across visits so a hold survives navigating away and back. */
const lastZone: HoldMemory = new Map();
/** Who holds a stove and who got which plate, kept across visits too (office-kitchen.ts). */
const pots = kitchenMemory();

export function buildOffice(snap: Snapshot, now: Date): OfficeModel {
  return buildFloor({ ...snap, costs: snap.costs ?? {} }, now, lastZone, pots);
}

const MOVED: Record<Zone, string> = {
  door: 'is waiting at your door',
  desk: 'went back to their desk',
  kitchen: 'went to the kitchen',
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
  // `tick` re-reads the clock when a hold ends or someone is due the "go home" prompt.
  const office = useMemo(() => buildOffice(snap, new Date()), [snap, tick]);

  const nextLook = nextOfficeLook(office, snap.office, new Date());
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

/**
 * A toast when a worker is newly flagged as a runaway (SPEC §14.5). Who was flagged when the page
 * opened counts as seen: the header's "needs attention" already says so.
 */
export function useRunawayToasts(snap: Snapshot | null, navigate: (to: string) => void) {
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!snap) return;
    const costs = snap.costs ?? {};
    const flagged = Object.values(costs).filter((c) => c.runaway.length);
    const ids = new Set(flagged.map((c) => c.sessionId));
    const before = seen.current;
    seen.current = ids;
    if (!before) return;
    const model = buildOffice(snap, new Date());
    for (const c of flagged) {
      if (before.has(c.sessionId)) continue;
      const w = model.everyone.find((x) => x.session?.id === c.sessionId);
      const name = w ? (w.role === 'lead' ? `${w.project}'s control chat` : w.name) : 'A worker';
      toast.warning(`${name} may be a runaway`, {
        description: c.runaway.map((r) => RUNAWAY_LABEL[r]).join(', '),
        action: w
          ? {
              label: 'Show',
              onClick: () =>
                navigate(
                  w.id
                    ? `/office?worker=${encodeURIComponent(w.id)}&project=${encodeURIComponent(w.project)}`
                    : '/office',
                ),
            }
          : undefined,
      });
    }
  }, [snap, navigate]);
}
