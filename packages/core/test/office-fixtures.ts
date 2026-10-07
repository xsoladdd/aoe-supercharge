import type { OfficeInput, ProjectRecord, SessionView, TaskRecord } from '../src/shared/index.ts';

/** Made-up office data for the office tests: one project, `alpha`, whose control chat is `ctl`. */

export const T0 = Date.parse('2026-10-06T12:00:00.000Z');
export const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

export function session(
  id: string,
  status: SessionView['status'],
  extra: Partial<SessionView> = {},
): SessionView {
  return {
    id,
    title: id,
    status,
    rawStatus: status,
    statusSince: at(-30),
    parentId: null,
    branch: null,
    projectPath: null,
    group: null,
    tool: 'claude',
    unread: false,
    lastError: null,
    createdAt: at(-60),
    lastAccessedAt: null,
    prompt: null,
    pinned: false,
    archived: false,
    locked: false,
    ...extra,
  };
}

export function project(name: string, control: string | null): ProjectRecord {
  return {
    schema: 1,
    name,
    repoPath: `/r/${name}`,
    remoteUrl: null,
    controlSessionId: control,
    idPrefix: 'XX',
    nextTaskSeq: 1,
    installMode: 'user',
    createdAt: at(-60),
    updatedAt: at(-60),
  };
}

export function task(
  id: string,
  proj: string,
  sessionId: string,
  extra: Partial<TaskRecord> = {},
): TaskRecord {
  return {
    schema: 1,
    rev: 1,
    id,
    project: proj,
    name: 'Gareth',
    desk: 1,
    title: 'Do a thing',
    brief: '',
    branch: `sc/${id}`,
    baseBranch: 'main',
    worktreePath: `/w/${id}`,
    aoeSessionId: sessionId,
    parentSessionId: 'ctl',
    stage: 'implementing',
    blockedFrom: null,
    openQuestion: null,
    plan: null,
    mr: null,
    createdAt: at(-60),
    updatedAt: at(-60),
    history: [],
    ...extra,
  };
}

export const input = (sessions: SessionView[], tasks: TaskRecord[]): OfficeInput => ({
  sessions,
  projects: [project('alpha', 'ctl')],
  tasks,
  needsYou: [],
});
