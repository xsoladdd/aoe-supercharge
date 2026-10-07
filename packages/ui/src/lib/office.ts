import { useEffect, useMemo, useRef, useState } from 'react';
import {
  byQueue,
  leadSpot,
  officeSpot,
  outfitFor,
  pickDesk,
  sessionSpot,
  workerName,
  type NeedsYouItem,
  type OfficeSpot,
  type Outfit,
  type SessionView,
  type Snapshot,
  type TaskRecord,
  type Zone,
} from '@aoe-supercharge/core/shared';
import { spawnedBy } from '@/lib/derive';
import { chatHref } from '@/lib/nav';

/** One character in the office: a worker, or a project's control chat as its team lead. */
export interface OfficeWorker {
  /**
   * Unique across projects: `<project>/<task id>`, `<project>/lead`, or `<project>/s/<session id>` for a
   * worker the control chat started without a task.
   */
  key: string;
  role: 'worker' | 'lead';
  project: string;
  /** The task id ("NW-0007"); null for a lead, and for a worker with no task. */
  id: string | null;
  name: string;
  title: string;
  task: TaskRecord | null;
  session: SessionView | null;
  desk: number | null;
  outfit: Outfit;
  spot: OfficeSpot;
  /** Where it stands after holds are applied (see `OfficeSpot.hold`). */
  zone: Zone;
  /** When it got to where it is, for "12m" labels. */
  since: string | null;
  href: string;
  /** The Needs-you items that put it at your door. */
  items: NeedsYouItem[];
}

export interface OfficeTeam {
  project: string;
  lead: OfficeWorker | null;
  /** Workers at their desks, by desk number. */
  seated: OfficeWorker[];
  /** Every open worker's desk, seated or not: the size of the team's desk cluster. */
  desks: number;
}

export interface OfficeModel {
  door: OfficeWorker[];
  teams: OfficeTeam[];
  pantry: OfficeWorker[];
  away: OfficeWorker[];
  everyone: OfficeWorker[];
}

/** Where each character was last seen, kept across visits so a hold survives navigating away and back. */
const lastZone = new Map<string, Zone>();

function itemsByOwner(items: NeedsYouItem[]) {
  const byTask = new Map<string, NeedsYouItem[]>();
  const bySession = new Map<string, NeedsYouItem[]>();
  for (const i of items) {
    if (i.project && i.taskId) {
      const k = `${i.project}/${i.taskId}`;
      byTask.set(k, [...(byTask.get(k) ?? []), i]);
    } else if (i.sessionId) bySession.set(i.sessionId, [...(bySession.get(i.sessionId) ?? []), i]);
  }
  return { byTask, bySession };
}

function resolve(key: string, spot: OfficeSpot): Zone {
  const zone = spot.hold ? (lastZone.get(key) ?? spot.zone) : spot.zone;
  lastZone.set(key, zone);
  return zone;
}

export function buildOffice(snap: Snapshot, now: Date): OfficeModel {
  const sessions = new Map(snap.sessions.map((s) => [s.id, s]));
  const { byTask, bySession } = itemsByOwner(snap.needsYou);
  const everyone: OfficeWorker[] = [];
  const teams: OfficeTeam[] = [];

  for (const project of snap.projects) {
    const name = project.name;
    let lead: OfficeWorker | null = null;
    if (project.controlSessionId) {
      const session = sessions.get(project.controlSessionId) ?? null;
      const items = bySession.get(project.controlSessionId) ?? [];
      const spot = leadSpot(session, items);
      const key = `${name}/lead`;
      lead = {
        key,
        role: 'lead',
        project: name,
        id: null,
        name: 'Control chat',
        title: 'Team lead',
        task: null,
        session,
        desk: null,
        outfit: outfitFor('lead', name),
        spot,
        zone: resolve(key, spot),
        since: spot.queuedSince ?? session?.statusSince ?? null,
        href: chatHref(project.controlSessionId),
        items,
      };
      everyone.push(lead);
    }
    const tasks = snap.tasks.filter((t) => t.project === name && t.stage !== 'done');
    for (const task of tasks) {
      const session = sessions.get(task.aoeSessionId) ?? null;
      const key = `${name}/${task.id}`;
      const items = byTask.get(key) ?? [];
      const spot = officeSpot(task, session, items, now);
      everyone.push({
        key,
        role: 'worker',
        project: name,
        id: task.id,
        name: workerName(task),
        title: task.title,
        task,
        session,
        desk: task.desk ?? null,
        outfit: outfitFor(task.id, name),
        spot,
        zone: resolve(key, spot),
        since: spot.queuedSince ?? session?.statusSince ?? null,
        href: `/p/${encodeURIComponent(name)}/t/${encodeURIComponent(task.id)}`,
        items,
      });
    }
    // Workers the control chat started straight through AoE: no task, so they take the free desks after
    // the tasks', oldest first, and go where their session says.
    const taken = new Set(tasks.map((t) => t.desk).filter((d): d is number => typeof d === 'number'));
    const spawned = spawnedBy(snap, project.controlSessionId).sort(
      (a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id),
    );
    for (const session of spawned) {
      const key = `${name}/s/${session.id}`;
      const items = bySession.get(session.id) ?? [];
      const spot = sessionSpot(session, items, now);
      const desk = pickDesk(taken);
      taken.add(desk);
      everyone.push({
        key,
        role: 'worker',
        project: name,
        id: null,
        name: session.title,
        title: session.branch ?? 'Started by the control chat',
        task: null,
        session,
        desk,
        outfit: outfitFor(session.id, name),
        spot,
        zone: resolve(key, spot),
        since: spot.queuedSince ?? session.statusSince ?? null,
        href: chatHref(session.id),
        items,
      });
    }
    const mine = everyone.filter((w) => w.project === name && w.role === 'worker');
    teams.push({
      project: name,
      lead,
      seated: mine.filter((w) => w.zone === 'desk').sort((a, b) => (a.desk ?? 0) - (b.desk ?? 0)),
      desks: Math.max(0, ...mine.map((w) => w.desk ?? 0)),
    });
  }

  return {
    door: everyone
      .filter((w) => w.zone === 'door')
      .sort((a, b) => byQueue({ ...a, id: a.key }, { ...b, id: b.key })),
    teams,
    pantry: everyone.filter((w) => w.zone === 'pantry'),
    away: everyone.filter((w) => w.zone === 'away'),
    everyone,
  };
}

const MOVED: Record<Zone, string> = {
  door: 'is waiting at your door',
  desk: 'went back to their desk',
  pantry: 'went to the pantry',
  away: 'stepped away',
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

  const nextLook = Math.min(
    ...office.everyone.map((w) => w.spot.holdUntil ?? Infinity).filter((t) => t > Date.now()),
  );
  useEffect(() => {
    if (!Number.isFinite(nextLook)) return;
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
