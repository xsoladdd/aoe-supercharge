import {
  computeNeedsYou,
  type Health,
  type NeedsYouItem,
  type NoteRecord,
  type OfficeState,
  type ProjectRecord,
  type SessionView,
  type Snapshot,
  type SnapshotEvent,
  type TaskRecord,
  type UsageReport,
} from '@aoe-supercharge/core/shared';

export type SeqEvent = SnapshotEvent & { seq: number };
type Listener = (e: SeqEvent) => void;

const RING_SIZE = 500;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * In-memory snapshot of everything the dashboard shows, plus an event bus for SSE.
 * Each change emits one event with a monotonic `seq`; a ring buffer lets reconnecting
 * clients replay via Last-Event-ID, otherwise they get a fresh snapshot.
 */
export class Store {
  private seq = 0;
  private ring: SeqEvent[] = [];
  private listeners = new Set<Listener>();
  sessions: SessionView[] = [];
  projects: ProjectRecord[] = [];
  tasks: TaskRecord[] = [];
  needsYou: NeedsYouItem[] = [];
  notes: NoteRecord[] = [];
  usage: UsageReport | null = null;
  office: OfficeState = { marks: {} };
  ui: Snapshot['ui'] = {
    theme: 'dark',
    density: 'comfortable',
    scale: 'default',
    sound: true,
    displayName: '',
    officeAnimations: true,
  };
  sessionsLoaded = false;
  ledgerLoaded = false;

  constructor(
    public health: Health,
    private opts: { waitingDebounceSeconds: () => number },
  ) {}

  get clientCount() {
    return this.listeners.size;
  }

  snapshot(): Snapshot {
    return {
      seq: this.seq,
      generatedAt: new Date().toISOString(),
      health: this.health,
      sessions: this.sessions,
      projects: this.projects,
      tasks: this.tasks,
      needsYou: this.needsYou,
      notes: this.notes,
      usage: this.usage,
      office: this.office,
      ui: this.ui,
    };
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Events after `seq`, or null when the ring no longer covers it. */
  since(seq: number): SeqEvent[] | null {
    if (seq >= this.seq) return [];
    const first = this.ring[0];
    if (!first || first.seq > seq + 1) return null;
    return this.ring.filter((e) => e.seq > seq);
  }

  private emit(e: SnapshotEvent) {
    const ev = { ...e, seq: ++this.seq } as SeqEvent;
    this.ring.push(ev);
    if (this.ring.length > RING_SIZE) this.ring.shift();
    for (const l of this.listeners) {
      try {
        l(ev);
      } catch {
        // a broken client must not affect the others
      }
    }
  }

  setSessions(sessions: SessionView[]) {
    this.sessionsLoaded = true;
    if (same(sessions, this.sessions)) return;
    this.sessions = sessions;
    this.emit({ type: 'sessions', data: sessions });
    this.recomputeNeedsYou();
  }

  setLedger(projects: ProjectRecord[], tasks: TaskRecord[]) {
    this.ledgerLoaded = true;
    let changed = false;
    if (!same(projects, this.projects)) {
      this.projects = projects;
      this.emit({ type: 'projects', data: projects });
      changed = true;
    }
    if (!same(tasks, this.tasks)) {
      this.tasks = tasks;
      this.emit({ type: 'tasks', data: tasks });
      changed = true;
    }
    if (changed) this.recomputeNeedsYou();
  }

  /** Every note; the dashboard gets the ones not archived. */
  setNotes(all: NoteRecord[]) {
    const open = all.filter((n) => !n.archivedAt);
    if (same(open, this.notes)) return;
    this.notes = open;
    this.emit({ type: 'notes', data: open });
  }

  setHealth(health: Health) {
    const prevReachable = this.health.aoe.state === 'ok';
    const { uptimeSec: _a, rssMb: _b, ...rest } = health.daemon;
    const { uptimeSec: _c, rssMb: _d, ...prevRest } = this.health.daemon;
    const meaningful = !same(
      { ...health, daemon: rest, aoe: { ...health.aoe, lastPollAt: null } },
      {
        ...this.health,
        daemon: prevRest,
        aoe: { ...this.health.aoe, lastPollAt: null },
      },
    );
    this.health = health;
    if (meaningful) this.emit({ type: 'health', data: health });
    if (prevReachable !== (health.aoe.state === 'ok')) this.recomputeNeedsYou();
  }

  setUsage(usage: UsageReport) {
    if (same(usage, this.usage)) return;
    this.usage = usage;
    this.emit({ type: 'usage', data: usage });
  }

  setOffice(office: OfficeState) {
    if (same(office, this.office)) return;
    this.office = office;
    this.emit({ type: 'office', data: office });
  }

  setUi(ui: Snapshot['ui']) {
    if (same(ui, this.ui)) return;
    this.ui = ui;
    this.emit({ type: 'snapshot', data: this.snapshot() });
  }

  recomputeNeedsYou() {
    const next = computeNeedsYou({
      tasks: this.tasks,
      sessions: this.sessions,
      projects: this.projects,
      aoeReachable: this.health.aoe.state === 'ok' && this.sessionsLoaded,
      now: new Date(),
      waitingDebounceSeconds: this.opts.waitingDebounceSeconds(),
    });
    if (same(next, this.needsYou)) return;
    this.needsYou = next;
    this.emit({ type: 'needs_you', data: next });
  }
}
