import type { ControlAsk } from './control-asks.ts';
import type { SessionPrompt } from './prompt.ts';
import type { Stage } from './stages.ts';
import type { UsageReport } from './usage.ts';

export type Actor = 'worker' | 'daemon' | 'user' | 'control';

export interface HistoryEntry {
  at: string;
  from: Stage | null;
  to: Stage;
  by: Actor;
  note: string | null;
}

export interface OpenQuestion {
  text: string;
  /** Suggested answers (`supercharge ask --option`); the user can still write their own. */
  options?: string[];
  askedAt: string;
  answeredAt: string | null;
}

export interface PlanRef {
  status: 'draft' | 'approved';
  savedAt: string;
  sha256: string;
}

export type PipelineStatus =
  | 'created'
  | 'waiting_for_resource'
  | 'preparing'
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'canceled'
  | 'skipped'
  | 'manual'
  | 'scheduled';

export interface MrState {
  provider: 'gitlab';
  host: string;
  repo: string;
  iid: number;
  url: string;
  state: 'opened' | 'merged' | 'closed' | 'locked';
  draft: boolean;
  pipeline: PipelineStatus | null;
  unresolvedThreads: number;
  detailedMergeStatus: string | null;
  checkedAt: string | null;
  error: string | null;
}

/** A note you left on a plan: the text you selected and what you want changed. */
export interface PlanComment {
  id: string;
  quote: string;
  text: string;
  createdAt: string;
  /** Set once it went to the worker (in a batch with the others). */
  sentAt: string | null;
}

export interface TaskRecord {
  schema: 1;
  rev: number;
  id: string;
  project: string;
  /** A medieval name ("Gareth") shown with the id; older tasks get one when the daemon next loads them. */
  name?: string;
  /** Its desk in the office view (from 1, unique among the project's open tasks); the daemon backfills it. */
  desk?: number;
  title: string;
  brief: string;
  branch: string;
  baseBranch: string;
  worktreePath: string;
  aoeSessionId: string;
  parentSessionId: string;
  stage: Stage;
  blockedFrom: Stage | null;
  openQuestion: OpenQuestion | null;
  plan: PlanRef | null;
  mr: MrState | null;
  /** The model and effort the worker was started with (null: Claude Code's default). Older tasks lack them. */
  model?: string | null;
  effort?: string | null;
  createdAt: string;
  updatedAt: string;
  history: HistoryEntry[];
}

export interface ProjectRecord {
  schema: 1;
  name: string;
  repoPath: string;
  remoteUrl: string | null;
  controlSessionId: string | null;
  idPrefix: string;
  nextTaskSeq: number;
  installMode: 'user' | 'commit';
  createdAt: string;
  updatedAt: string;
  /**
   * Names for the workers its control chat started straight through AoE (`aoe add -P`), by session
   * id, as tasks have theirs. Kept after a session is gone, so a name is never given twice.
   */
  crew?: Record<string, string>;
}

/**
 * A note or a todo on the whiteboard (SPEC §14.6): for one project, or for everything (`project: null`,
 * a global note). Archived ones are kept, out of sight.
 */
export interface NoteRecord {
  /** Short, to type in `supercharge todo done <id>`: four letters and digits. */
  id: string;
  project: string | null;
  kind: 'note' | 'todo';
  text: string;
  /** A todo you ticked. */
  done: boolean;
  doneAt: string | null;
  archivedAt: string | null;
  /** Who wrote it: Claude (from a session, through the /note skills) or you. */
  by: 'claude' | 'you';
  /** The AoE session Claude wrote it from, when there was one. */
  sessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Dashboard-level session status, normalised from AoE's PascalCase enum. */
export type LiveStatus = 'working' | 'waiting' | 'idle' | 'error' | 'stopped' | 'unknown';

export interface SessionView {
  id: string;
  title: string;
  status: LiveStatus;
  rawStatus: string;
  /** When the daemon first saw the current status (used for debounce and Needs-you age). */
  statusSince: string | null;
  parentId: string | null;
  branch: string | null;
  projectPath: string | null;
  group: string | null;
  tool: string | null;
  unread: boolean;
  lastError: string | null;
  createdAt: string | null;
  lastAccessedAt: string | null;
  /** The menu Claude is showing while it waits on you (plan approval, permission), if any. */
  prompt: SessionPrompt | null;
  /** Pinned in AoE: listed first. */
  pinned: boolean;
  /** Archived in AoE: stopped and kept (worktree and branch too), listed apart until unarchived. */
  archived: boolean;
  /** Locked in Supercharge: it cannot be archived, deleted, stopped or cleared until unlocked. */
  locked: boolean;
  /**
   * A control chat only: what its latest reply lists under NEEDS YOU, and since when it has had
   * something there. Kept while it works on the next reply.
   */
  asks?: { at: string; items: ControlAsk[] } | null;
}

export type NeedsYouKind =
  | 'question'
  | 'approval'
  | 'plan_approval'
  | 'permission'
  | 'control_waiting'
  | 'control_replied'
  /** An item under NEEDS YOU in a control chat's latest reply; a blocker when it says work is stopped. */
  | 'control_blocker'
  | 'control_needs'
  | 'session_error'
  | 'session_missing'
  | 'mr_ready'
  | 'mr_closed';

export interface NeedsYouItem {
  id: string;
  kind: NeedsYouKind;
  project: string | null;
  taskId: string | null;
  sessionId: string | null;
  title: string;
  detail: string;
  since: string;
}

export type AoeState = 'ok' | 'starting' | 'unreachable' | 'incompatible' | 'missing';

export interface Health {
  daemon: {
    version: string;
    pid: number;
    port: number;
    startedAt: string;
    uptimeSec: number;
    rssMb: number;
    mode: 'ok' | 'degraded' | 'incompatible';
    /** Set by `npm run demo`: the data is fake and the UI says so. */
    demo: boolean;
  };
  aoe: {
    state: AoeState;
    installedVersion: string | null;
    serveVersion: string | null;
    range: string;
    origin: string | null;
    profile: string;
    message: string | null;
    fix: string | null;
    lastPollAt: string | null;
  };
  config: {
    ok: boolean;
    errors: string[];
    restartRequired: string[];
  };
  remoteControl: boolean;
}

/**
 * A character's mark in the office (SPEC §14.5), by its key. Office-only: archiving takes it off the
 * floor and leaves its session, worktree and history alone.
 */
export interface OfficeMark {
  archivedAt: string | null;
  /** "Keep" on the go-home prompt: not asked again for this idle stretch (the one that began before it). */
  keptAt: string | null;
  snoozedUntil: string | null;
}

/** What the office needs beyond the ledger and AoE: its marks. */
export interface OfficeState {
  marks: Record<string, OfficeMark>;
}

export interface Snapshot {
  seq: number;
  generatedAt: string;
  health: Health;
  sessions: SessionView[];
  projects: ProjectRecord[];
  tasks: TaskRecord[];
  needsYou: NeedsYouItem[];
  /** Notes and todos that are not archived, oldest first. */
  notes: NoteRecord[];
  /** Your 5-hour and weekly usage and whether another worker may start (null until the daemon has read it). */
  usage: UsageReport | null;
  office: OfficeState;
  ui: {
    theme: 'dark' | 'light' | 'system';
    density: 'comfortable' | 'compact';
    scale: 'small' | 'default' | 'large' | 'larger';
    sound: boolean;
    /** Your name on the office door; empty reads "Your office". */
    displayName: string;
    /** Walking, errands and arrivals in the office (off: everyone jumps, as with reduced motion). */
    officeAnimations: boolean;
  };
}

export type SnapshotEvent =
  | { type: 'snapshot'; data: Snapshot }
  | { type: 'sessions'; data: SessionView[] }
  | { type: 'tasks'; data: TaskRecord[] }
  | { type: 'projects'; data: ProjectRecord[] }
  | { type: 'needs_you'; data: NeedsYouItem[] }
  | { type: 'notes'; data: NoteRecord[] }
  | { type: 'usage'; data: UsageReport }
  | { type: 'office'; data: OfficeState }
  | { type: 'health'; data: Health };

export interface ProjectStatus {
  project: string;
  control: { sessionId: string | null; status: LiveStatus | 'missing'; remoteControl: boolean };
  counts: Record<Stage, number>;
  blocked: { taskId: string; name: string | null; title: string; question: string; since: string }[];
  readyForReview: { taskId: string; name: string | null; title: string; mrUrl: string | null }[];
  failingPipelines: { taskId: string; name: string | null; title: string; mrUrl: string | null }[];
  tasks: {
    id: string;
    /** The worker's medieval name ("Gareth"); call it that, with the id. */
    name: string | null;
    title: string;
    stage: Stage;
    branch: string;
    aoeStatus: LiveStatus | 'missing';
    mr: { url: string; pipeline: PipelineStatus | null; unresolvedThreads: number } | null;
    updatedAt: string;
  }[];
  generatedAt: string;
}
