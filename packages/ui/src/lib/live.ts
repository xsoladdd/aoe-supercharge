import { useSyncExternalStore } from 'react';
import type {
  OfficeState,
  MrState,
  SessionCost,
  Health,
  NeedsYouItem,
  NoteRecord,
  ProjectRecord,
  SessionView,
  Snapshot,
  TaskRecord,
  UsageReport,
  WatchSummary,
} from '@aoe-supercharge/core/shared';
import { ApiError, getJson } from './api';

export type Connection = 'loading' | 'live' | 'reconnecting' | 'signed_out' | 'error';

export interface LiveState {
  connection: Connection;
  snapshot: Snapshot | null;
  error: string | null;
  /** task id → timestamp of its last stage change seen live (drives the one-shot highlight). */
  changed: Record<string, number>;
  /**
   * Counts whole snapshots (first load, and every reconnect that could not replay): the office places
   * everyone again without walking when it changes.
   */
  epoch: number;
}

let state: LiveState = { connection: 'loading', snapshot: null, error: null, changed: {}, epoch: 0 };
const listeners = new Set<() => void>();
let source: EventSource | null = null;
let started = false;

function set(patch: Partial<LiveState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function patchSnapshot(patch: Partial<Snapshot>) {
  if (!state.snapshot) return;
  set({ snapshot: { ...state.snapshot, ...patch } });
}

function markChanged(prev: TaskRecord[], next: TaskRecord[]) {
  const before = new Map(prev.map((t) => [t.id, t.stage]));
  const now = Date.now();
  const changed = { ...state.changed };
  for (const t of next) if (before.has(t.id) && before.get(t.id) !== t.stage) changed[t.id] = now;
  return changed;
}

function connectEvents() {
  source?.close();
  source = new EventSource('/api/events', { withCredentials: true });
  const on = <T>(type: string, fn: (data: T) => void) =>
    source!.addEventListener(type, (e) => {
      try {
        fn(JSON.parse((e as MessageEvent<string>).data) as T);
      } catch {
        // ignore malformed frames
      }
    });
  on<Snapshot>('snapshot', (snapshot) =>
    set({ snapshot, connection: 'live', error: null, epoch: state.epoch + 1 }),
  );
  on<SessionView[]>('sessions', (sessions) => patchSnapshot({ sessions }));
  on<TaskRecord[]>('tasks', (tasks) => {
    const changed = markChanged(state.snapshot?.tasks ?? [], tasks);
    set({ changed });
    patchSnapshot({ tasks });
  });
  on<ProjectRecord[]>('projects', (projects) => patchSnapshot({ projects }));
  on<NeedsYouItem[]>('needs_you', (needsYou) => patchSnapshot({ needsYou }));
  on<NoteRecord[]>('notes', (notes) => patchSnapshot({ notes }));
  on<Health>('health', (health) => patchSnapshot({ health }));
  on<UsageReport>('usage', (usage) => patchSnapshot({ usage }));
  on<OfficeState>('office', (office) => patchSnapshot({ office }));
  on<Record<string, SessionCost>>('costs', (costs) => patchSnapshot({ costs }));
  on<Record<string, MrState>>('session_mrs', (sessionMrs) => patchSnapshot({ sessionMrs }));
  on<Record<string, WatchSummary>>('watch', (watch) => patchSnapshot({ watch }));
  source.onopen = () => set({ connection: 'live' });
  source.onerror = async () => {
    set({ connection: 'reconnecting' });
    // EventSource retries on its own; check whether we were signed out meanwhile.
    try {
      await getJson('/api/csrf');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        source?.close();
        set({ connection: 'signed_out' });
      }
    }
  };
}

export async function startLive() {
  if (started) return;
  started = true;
  try {
    const snapshot = await getJson<Snapshot>('/api/snapshot');
    set({ snapshot, connection: 'live', epoch: state.epoch + 1 });
    connectEvents();
  } catch (err) {
    started = false;
    if (err instanceof ApiError && err.status === 401) set({ connection: 'signed_out' });
    else set({ connection: 'error', error: (err as Error).message });
  }
}

export function useLive(): LiveState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}
