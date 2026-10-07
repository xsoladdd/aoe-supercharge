import { appendHistory, lastHistoryState, pruneHistory, readOfficeMarks } from '@aoe-supercharge/core/node';
import {
  buildOffice,
  diffFloor,
  FRAME_EVERY_MS,
  floorStates,
  historyDay,
  nextHoldEnd,
  type CharState,
  type HistoryRecord,
  type HoldMemory,
  type OfficeModel,
  RUNAWAY_LABEL,
  runawayReasons,
  summarizeCost,
  type SessionCost,
} from '@aoe-supercharge/core/shared';
import type { Ctx } from '../context.ts';
import { notify } from '../notify.ts';
import type { TranscriptStore } from '../transcript.ts';
import type { Store } from './store.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The daemon's view of the office (SPEC §14.5): it builds the floor with the dashboard's rules on every
 * change, appends what moved to the office history, and keeps the office marks in the store.
 */
export class OfficeWatcher {
  private holds: HoldMemory = new Map();
  private last = new Map<string, CharState>();
  private lastFrameAt = 0;
  private lastDay: string | null = null;
  private started = false;
  private debounce: NodeJS.Timeout | null = null;
  private holdTimer: NodeJS.Timeout | null = null;
  private frameTimer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private writing: Promise<void> = Promise.resolve();
  /** The floor as last built, for the other office checks. */
  model: OfficeModel | null = null;

  constructor(
    private ctx: Ctx,
    private store: Store,
    private now: () => Date = () => new Date(),
  ) {}

  async start() {
    await this.reloadMarks();
    this.last = await lastHistoryState(this.ctx.paths).catch(() => new Map());
    await this.prune();
    this.pruneTimer = setInterval(() => void this.prune(), DAY_MS);
    this.pruneTimer.unref();
    this.frameTimer = setInterval(() => this.queue(true), 15 * 60_000);
    this.frameTimer.unref();
    this.unsubscribe = this.store.subscribe((e) => {
      if (e.type === 'health' || e.type === 'usage' || e.type === 'notes') return;
      this.schedule();
    });
    this.schedule();
  }

  stop() {
    this.unsubscribe?.();
    for (const t of [this.debounce, this.holdTimer]) if (t) clearTimeout(t);
    for (const t of [this.frameTimer, this.pruneTimer]) if (t) clearInterval(t);
  }

  async reloadMarks() {
    try {
      this.store.setOffice({
        marks: await readOfficeMarks(this.ctx.paths),
        runaway: this.ctx.config.office.runaway,
      });
    } catch (err) {
      this.ctx.logger.warn('office state unreadable', { err: (err as Error).message });
    }
  }

  private async prune() {
    try {
      const removed = await pruneHistory(
        this.ctx.paths,
        this.ctx.config.office.history.retentionDays,
        this.now().getTime(),
      );
      if (removed.length) this.ctx.logger.info('office history pruned', { days: removed });
    } catch (err) {
      this.ctx.logger.warn('office history prune failed', { err: (err as Error).message });
    }
  }

  private schedule() {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.queue(false), 250);
    this.debounce.unref();
  }

  /** Writes run one after another, so records stay in order. */
  private queue(periodic: boolean) {
    this.writing = this.writing
      .then(async () => {
        await this.tick(periodic);
      })
      .catch((err: unknown) => {
        this.ctx.logger.warn('office history write failed', { err: (err as Error).message });
      });
  }

  /** Builds the floor and records the change. Exposed for tests. */
  async tick(periodic = false): Promise<HistoryRecord[]> {
    // Until both the ledger and AoE have loaded, the floor would be half-empty: wait.
    if (!this.store.ledgerLoaded || !this.store.sessionsLoaded) return [];
    const now = this.now();
    const ts = now.toISOString();
    const model = buildOffice(this.store, now, this.holds);
    this.model = model;
    this.scheduleHold(model, now.getTime());
    const next = floorStates(model);
    const out: HistoryRecord[] = [];
    const day = historyDay(now);
    const frameDue =
      !this.started || day !== this.lastDay || now.getTime() - this.lastFrameAt >= FRAME_EVERY_MS;
    if (frameDue) {
      // The state just before: so each day's file (and each start) can be replayed on its own.
      out.push({ v: 1, type: 'frame', ts, chars: [...this.last.values()] });
      this.lastFrameAt = now.getTime();
      this.lastDay = day;
      this.started = true;
    } else if (periodic) return [];
    out.push(...diffFloor(this.last, next, ts));
    this.last = new Map(next.map((c) => [c.key, c]));
    const only = out.length === 1 ? out[0]! : null;
    if (only?.type === 'frame' && !only.chars.length) out.length = 0;
    if (out.length) await appendHistory(this.ctx.paths, out);
    return out;
  }

  private scheduleHold(model: OfficeModel, now: number) {
    if (this.holdTimer) clearTimeout(this.holdTimer);
    const next = nextHoldEnd(model, now);
    if (next === null) return;
    this.holdTimer = setTimeout(() => this.queue(false), Math.max(250, next - now + 50));
    this.holdTimer.unref();
  }
}

/** How often the meters read what is new in the transcripts. */
const COST_EVERY_MS = 15_000;

/**
 * The office's cost meters (SPEC §14.5): every 15 seconds it reads what is new in the live Claude
 * conversation of each session on the floor (incrementally, as the chat view does), estimates the
 * cost, flags runaways, and notifies once when someone becomes one.
 */
export class CostWatcher {
  private timer: NodeJS.Timeout | null = null;
  private flagged = new Set<string>();
  private armed = false;

  constructor(
    private ctx: Ctx,
    private store: Store,
    private office: OfficeWatcher,
    private transcripts: Pick<TranscriptStore, 'usage'>,
    private alert: (title: string, body: string) => Promise<unknown> = notify,
    private now: () => Date = () => new Date(),
  ) {}

  start() {
    const loop = async () => {
      await this.tick().catch((err: unknown) =>
        this.ctx.logger.warn('office costs failed', { err: (err as Error).message }),
      );
      this.timer = setTimeout(() => void loop(), COST_EVERY_MS);
      this.timer.unref();
    };
    this.timer = setTimeout(() => void loop(), 2_000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
  }

  /** Reads the costs once. Exposed for tests. */
  async tick(): Promise<Record<string, SessionCost>> {
    const model = this.office.model;
    if (!model) return this.store.costs;
    const now = this.now();
    const limits = this.ctx.config.office.runaway;
    const costs: Record<string, SessionCost> = {};
    const names = new Map<string, string>();
    for (const w of model.everyone) {
      const s = w.session;
      if (!s || s.tool !== 'claude') continue;
      const { entries, lastEditAt } = await this.transcripts
        .usage(s.id, s.projectPath)
        .catch(() => ({ entries: [], lastEditAt: null }));
      if (!entries.length) continue;
      const moved = w.task?.history.at(-1)?.at ?? null;
      const progressAt =
        [lastEditAt, moved]
          .filter((x): x is string => !!x)
          .sort()
          .at(-1) ?? null;
      const cost = summarizeCost(s.id, entries, now, progressAt);
      cost.runaway = runawayReasons(cost, s.status === 'working', limits, now);
      costs[s.id] = cost;
      names.set(s.id, w.role === 'lead' ? `${w.project}'s control chat` : w.name);
    }
    this.store.setCosts(costs);
    // Notify once per runaway; who was flagged when the daemon started counts as seen.
    const now2 = new Set(
      Object.values(costs)
        .filter((c) => c.runaway.length)
        .map((c) => c.sessionId),
    );
    const n = this.ctx.config.notifications;
    if (this.armed && n.enabled && n.runaway)
      for (const id of now2)
        if (!this.flagged.has(id))
          void this.alert(
            'Possible runaway worker',
            `${names.get(id)}: ${costs[id]!.runaway.map((r) => RUNAWAY_LABEL[r]).join(', ')}`,
          );
    this.flagged = now2;
    this.armed = true;
    return costs;
  }
}
