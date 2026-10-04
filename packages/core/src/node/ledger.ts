import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Stage } from '../shared/stages.ts';
import type { Actor, ProjectRecord, TaskRecord } from '../shared/types.ts';
import { formatTaskId } from '../shared/util.ts';
import { appendLine, ensureDir, readJson, withLock, writeFileAtomic, writeJsonAtomic } from './fs.ts';
import type { Paths } from './paths.ts';

/** Pure stage mutation: sets stage, tracks blockedFrom, appends history. Guards live in `transition()`. */
export function applyStage(
  task: TaskRecord,
  to: Stage,
  by: Actor,
  note: string | null,
  now: Date = new Date(),
): TaskRecord {
  const at = now.toISOString();
  const next: TaskRecord = {
    ...task,
    stage: to,
    blockedFrom: to === 'blocked' ? (task.stage === 'blocked' ? task.blockedFrom : task.stage) : null,
    history: [...task.history, { at, from: task.stage, to, by, note }],
  };
  if (task.stage === 'blocked' && to !== 'blocked' && next.openQuestion && !next.openQuestion.answeredAt) {
    next.openQuestion = { ...next.openQuestion, answeredAt: at };
  }
  return next;
}

/**
 * The ledger: one JSON file per task plus its plan.md (SPEC §6). Every write is atomic, and
 * read-modify-write happens under a per-task (or per-project) lock so the worker CLI and the
 * daemon's MR watcher never clobber each other.
 */
export class Ledger {
  constructor(readonly paths: Paths) {}

  projectDir(project: string) {
    return join(this.paths.projectsDir, project);
  }
  projectFile(project: string) {
    return join(this.projectDir(project), 'project.json');
  }
  controlPromptFile(project: string) {
    return join(this.projectDir(project), 'control-prompt.md');
  }
  tasksDir(project: string) {
    return join(this.projectDir(project), 'tasks');
  }
  taskDir(project: string, id: string) {
    return join(this.tasksDir(project), id);
  }
  taskFile(project: string, id: string) {
    return join(this.taskDir(project, id), 'task.json');
  }
  planFile(project: string, id: string) {
    return join(this.taskDir(project, id), 'plan.md');
  }
  sessionPromptFile(project: string, id: string) {
    return join(this.taskDir(project, id), 'session-prompt.md');
  }

  async listProjects(): Promise<ProjectRecord[]> {
    let names: string[] = [];
    try {
      names = (await readdir(this.paths.projectsDir, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return [];
    }
    const out: ProjectRecord[] = [];
    for (const n of names.sort()) {
      const p = await this.getProject(n).catch(() => null);
      if (p) out.push(p);
    }
    return out;
  }

  getProject(name: string): Promise<ProjectRecord | null> {
    return readJson<ProjectRecord>(this.projectFile(name));
  }

  async findProjectByRepo(repoPath: string): Promise<ProjectRecord | null> {
    const target = resolve(repoPath);
    return (await this.listProjects()).find((p) => resolve(p.repoPath) === target) ?? null;
  }

  async saveProject(p: ProjectRecord): Promise<void> {
    await ensureDir(this.tasksDir(p.name));
    await writeJsonAtomic(this.projectFile(p.name), p);
  }

  async updateProject(name: string, fn: (p: ProjectRecord) => ProjectRecord): Promise<ProjectRecord> {
    return withLock(this.projectDir(name), async () => {
      const cur = await this.getProject(name);
      if (!cur) throw new Error(`Unknown project "${name}"`);
      const next = { ...fn(cur), updatedAt: new Date().toISOString() };
      await writeJsonAtomic(this.projectFile(name), next);
      return next;
    });
  }

  /** Allocates the next sequential id ("NW-0008") under the project lock. */
  async allocateTaskId(project: string): Promise<string> {
    let id = '';
    await this.updateProject(project, (p) => {
      id = formatTaskId(p.idPrefix, p.nextTaskSeq);
      return { ...p, nextTaskSeq: p.nextTaskSeq + 1 };
    });
    return id;
  }

  async listTasks(project?: string): Promise<TaskRecord[]> {
    const projects = project ? [project] : (await this.listProjects()).map((p) => p.name);
    const out: TaskRecord[] = [];
    for (const p of projects) {
      let ids: string[] = [];
      try {
        ids = (await readdir(this.tasksDir(p), { withFileTypes: true }))
          .filter((d) => d.isDirectory())
          .map((d) => d.name);
      } catch {
        continue;
      }
      for (const id of ids) {
        const t = await this.getTask(p, id).catch(() => null);
        if (t) out.push(t);
      }
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  getTask(project: string, id: string): Promise<TaskRecord | null> {
    return readJson<TaskRecord>(this.taskFile(project, id));
  }

  async findTaskByBranch(project: string, branch: string): Promise<TaskRecord | null> {
    return (await this.listTasks(project)).find((t) => t.branch === branch) ?? null;
  }

  async findTaskBySession(sessionId: string): Promise<TaskRecord | null> {
    return (await this.listTasks()).find((t) => t.aoeSessionId === sessionId) ?? null;
  }

  async createTask(task: TaskRecord): Promise<void> {
    await withLock(this.taskDir(task.project, task.id), async () => {
      if (await readJson(this.taskFile(task.project, task.id)))
        throw new Error(`Task ${task.id} already exists`);
      await writeJsonAtomic(this.taskFile(task.project, task.id), task);
    });
  }

  async updateTask(
    project: string,
    id: string,
    fn: (t: TaskRecord) => TaskRecord | Promise<TaskRecord>,
  ): Promise<TaskRecord> {
    return withLock(this.taskDir(project, id), async () => {
      const cur = await this.getTask(project, id);
      if (!cur) throw new Error(`Unknown task ${id} in project ${project}`);
      const next = await fn(cur);
      if (next === cur) return cur;
      const written: TaskRecord = { ...next, rev: cur.rev + 1, updatedAt: new Date().toISOString() };
      await writeJsonAtomic(this.taskFile(project, id), written);
      return written;
    });
  }

  async readPlan(project: string, id: string): Promise<string | null> {
    try {
      return await readFile(this.planFile(project, id), 'utf8');
    } catch {
      return null;
    }
  }

  async writePlan(project: string, id: string, markdown: string): Promise<string> {
    await writeFileAtomic(this.planFile(project, id), markdown);
    return createHash('sha256').update(markdown).digest('hex');
  }
}

export interface AuditEntry {
  at?: string;
  actor: Actor | 'cli' | 'ui';
  action:
    'prompt_sent' | 'config_changed' | 'daemon_restart' | 'task_created' | 'project_init' | 'aoe_upgrade';
  project?: string | null;
  taskId?: string | null;
  sessionId?: string | null;
  text?: string;
  details?: Record<string, unknown>;
}

/** Append-only JSONL audit log (SPEC §6.2). Every prompt sent to an agent lands here. */
export async function appendAudit(paths: Paths, entry: AuditEntry): Promise<void> {
  await appendLine(paths.auditFile, JSON.stringify({ at: new Date().toISOString(), ...entry }));
}
