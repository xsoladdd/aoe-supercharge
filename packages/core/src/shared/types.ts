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
}

export type NeedsYouKind =
  | 'question'
  | 'approval'
  | 'plan_approval'
  | 'permission'
  | 'control_waiting'
  | 'control_replied'
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

export interface Snapshot {
  seq: number;
  generatedAt: string;
  health: Health;
  sessions: SessionView[];
  projects: ProjectRecord[];
  tasks: TaskRecord[];
  needsYou: NeedsYouItem[];
  /** Your 5-hour and weekly usage and whether another worker may start (null until the daemon has read it). */
  usage: UsageReport | null;
  ui: {
    theme: 'dark' | 'light' | 'system';
    density: 'comfortable' | 'compact';
    scale: 'small' | 'default' | 'large' | 'larger';
    sound: boolean;
    /** Your name on the office door; empty reads "Your office". */
    displayName: string;
  };
}

export type SnapshotEvent =
  | { type: 'snapshot'; data: Snapshot }
  | { type: 'sessions'; data: SessionView[] }
  | { type: 'tasks'; data: TaskRecord[] }
  | { type: 'projects'; data: ProjectRecord[] }
  | { type: 'needs_you'; data: NeedsYouItem[] }
  | { type: 'usage'; data: UsageReport }
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
