import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { appendAudit, applyStage, SAFE_ARG, writeFileAtomic, type Config } from '@aoe-supercharge/core/node';
import {
  derivePrefix,
  isSlug,
  nextStageHint,
  slugify,
  STAGE_LABEL,
  transition,
  type Actor,
  type MrState,
  type ProjectRecord,
  type Stage,
  type TaskRecord,
  EFFORT_LEVELS,
  MODEL_ALIASES,
} from '@aoe-supercharge/core/shared';
import type { AoeCliListEntry } from './aoe/schemas.ts';
import { VERSION, type Ctx } from './context.ts';
import { GitLabProvider, type MrProvider } from './mr/gitlab.ts';
import { installUserSkills, readTemplate, render, SKILL_NAMES, upsertManagedBlock } from './skills.ts';
import { TerminalBusyError } from './aoe/client.ts';
import { menuOnScreen } from './prompt.ts';
import type { TranscriptStore } from './transcript.ts';
import { CliError, EXIT } from './util/errors.ts';
import { run } from './util/exec.ts';
import { currentBranch, defaultBranch, mainCheckout, parseRemote, remoteUrl } from './util/git.ts';

export function mrProvider(config: Config, env: NodeJS.ProcessEnv): MrProvider {
  return new GitLabProvider(config.mr.gitlab.glabBinary, config.mr.gitlab.hosts, env);
}

function assertSafeArg(value: string, what: string) {
  if (!SAFE_ARG.test(value)) {
    throw new CliError(
      `${what} contains spaces or shell metacharacters: ${value}`,
      EXIT.error,
      'AoE passes these on a shell command line. Point XDG_DATA_HOME at a path without spaces, then retry.',
    );
  }
}

// ── whoami ────────────────────────────────────────────────────────────────────

export interface WhoAmI {
  role: 'control' | 'worker' | 'none';
  project: string | null;
  sessionId: string | null;
  branch: string | null;
  task: Pick<TaskRecord, 'id' | 'title' | 'stage' | 'branch' | 'baseBranch' | 'blockedFrom'> | null;
  /** Actor used for stage changes: the worker itself, or a human running the CLI in the worktree. */
  actor: Actor;
}

export async function whoami(
  ctx: Ctx,
  cwd: string,
): Promise<WhoAmI & { record: TaskRecord | null; projectRecord: ProjectRecord | null }> {
  const sessionId = ctx.env.AOE_INSTANCE_ID || null;
  const repo = await mainCheckout(cwd);
  const project = repo ? await ctx.ledger.findProjectByRepo(repo) : null;
  const branch = await currentBranch(cwd);
  const none = {
    role: 'none' as const,
    project: project?.name ?? null,
    sessionId,
    branch,
    task: null,
    actor: 'user' as const,
    record: null,
    projectRecord: project,
  };
  if (!project) return none;
  if (sessionId && sessionId === project.controlSessionId) {
    return { ...none, role: 'control', actor: 'control' };
  }
  const task = branch ? await ctx.ledger.findTaskByBranch(project.name, branch) : null;
  if (!task) return none;
  if (sessionId && sessionId !== task.aoeSessionId) {
    throw new CliError(
      `This session (${sessionId}) is not the AoE session for task ${task.id} (${task.aoeSessionId}).`,
      EXIT.notInTask,
      'Run supercharge commands from the worker session that owns this worktree.',
    );
  }
  return {
    role: 'worker',
    project: project.name,
    sessionId,
    branch,
    task: {
      id: task.id,
      title: task.title,
      stage: task.stage,
      branch: task.branch,
      baseBranch: task.baseBranch,
      blockedFrom: task.blockedFrom,
    },
    actor: sessionId ? 'worker' : 'user',
    record: task,
    projectRecord: project,
  };
}

async function requireTask(ctx: Ctx, cwd: string) {
  const who = await whoami(ctx, cwd);
  if (who.role !== 'worker' || !who.record || !who.projectRecord) {
    throw new CliError(
      'Not inside a Supercharge task worktree.',
      EXIT.notInTask,
      'Run this from a worker worktree created by "supercharge task new". "supercharge whoami" shows what was detected.',
    );
  }
  return who as typeof who & { record: TaskRecord; projectRecord: ProjectRecord };
}

// ── init ──────────────────────────────────────────────────────────────────────

export interface InitResult {
  project: ProjectRecord;
  controlCreated: boolean;
  committed: boolean;
  warnings: string[];
}

/** AoE can create a session but fail to launch it (e.g. hook paths not yet acknowledged). */
function launchWarning(
  r: { code: number | null; stderr: string; stdout: string },
  sessionId: string,
): string | null {
  if (r.code === 0) return null;
  const msg =
    (r.stderr || r.stdout)
      .trim()
      .split('\n')
      .find((l) => l.trim()) ?? 'unknown error';
  return `AoE created session ${sessionId} but could not launch it: ${msg.replace(/^(Warning|Error):\s*/i, '')}\n  Fix the cause, then run: aoe session start ${sessionId}`;
}

async function listAoe(ctx: Ctx): Promise<AoeCliListEntry[]> {
  try {
    return await ctx.aoeCli.list();
  } catch (err) {
    throw new CliError(
      `Could not list AoE sessions: ${(err as Error).message}`,
      EXIT.error,
      'Run "supercharge doctor".',
    );
  }
}

export function remoteControlName(config: Config, project: string): string {
  return config.remoteControl.nameTemplate.replace('{project}', project);
}

export async function initProject(
  ctx: Ctx,
  opts: { cwd: string; name?: string; commit?: boolean },
): Promise<InitResult> {
  const repo = await mainCheckout(opts.cwd);
  if (!repo)
    throw new CliError(
      'Not inside a git repository.',
      EXIT.usage,
      'Run "supercharge init" from inside the repository you want to manage.',
    );
  const name = slugify(opts.name ?? basename(repo));
  if (!isSlug(name))
    throw new CliError(
      `Can't derive a project name from "${opts.name ?? basename(repo)}".`,
      EXIT.usage,
      'Pass one with --name <slug>.',
    );

  let project = await ctx.ledger.findProjectByRepo(repo);
  if (project && opts.name && project.name !== name) {
    throw new CliError(`This repository is already registered as "${project.name}".`, EXIT.usage);
  }
  if (!project) {
    const clash = await ctx.ledger.getProject(name);
    if (clash)
      throw new CliError(
        `Project "${name}" already exists for ${clash.repoPath}.`,
        EXIT.usage,
        'Pick another name with --name.',
      );
    const at = new Date().toISOString();
    project = {
      schema: 1,
      name,
      repoPath: repo,
      remoteUrl: await remoteUrl(repo),
      controlSessionId: null,
      idPrefix: ctx.config.tasks.idPrefix || derivePrefix(name),
      nextTaskSeq: 1,
      installMode: opts.commit ? 'commit' : 'user',
      createdAt: at,
      updatedAt: at,
    };
    await ctx.ledger.saveProject(project);
  }

  const promptFile = ctx.ledger.controlPromptFile(project.name);
  assertSafeArg(promptFile, 'The control prompt path');
  await writeFileAtomic(
    promptFile,
    render(await readTemplate('roles/control.md'), { project: project.name, repoPath: repo }),
  );
  await installUserSkills(ctx.paths, VERSION);

  let committed = false;
  if (opts.commit) committed = await commitRepoAssets(repo);

  let controlCreated = false;
  const warnings: string[] = [];
  const sessions = await listAoe(ctx);
  const existing = project.controlSessionId
    ? sessions.find((s) => s.id === project!.controlSessionId)
    : undefined;
  if (!existing) {
    const before = new Set(sessions.map((s) => s.id));
    const title = `${project.name} control`;
    const extraArgs = [
      '--append-system-prompt-file',
      promptFile,
      ...modelArgs(ctx.config),
      ...ctx.config.agent.extraArgs,
    ];
    if (ctx.config.remoteControl.enabled)
      extraArgs.push('--remote-control', remoteControlName(ctx.config, project.name));
    const r = await ctx.aoeCli.add({
      path: repo,
      title,
      group: `supercharge/${project.name}`,
      tool: 'claude',
      extraArgs,
      launch: true,
    });
    const created = (await listAoe(ctx)).find((s) => !before.has(s.id) && s.title === title);
    if (!created)
      throw new CliError(
        `aoe add failed: ${(r.stderr || r.stdout || r.error?.message || '').trim() || 'no session was created'}`,
      );
    project = await ctx.ledger.updateProject(project.name, (p) => ({ ...p, controlSessionId: created.id }));
    controlCreated = true;
    const w = launchWarning(r, created.id);
    if (w) warnings.push(w);
  }
  await appendAudit(ctx.paths, {
    actor: 'cli',
    action: 'project_init',
    project: project.name,
    details: { repo, controlCreated, commit: !!opts.commit },
  });
  return { project, controlCreated, committed, warnings };
}

async function commitRepoAssets(repo: string): Promise<boolean> {
  const files: string[] = [];
  for (const n of SKILL_NAMES) {
    const rel = `.claude/skills/${n}/SKILL.md`;
    await writeFileAtomic(join(repo, rel), await readTemplate(`skills/${n}/SKILL.md`));
    files.push(rel);
  }
  const claudeMd = join(repo, 'CLAUDE.md');
  const current = await readFile(claudeMd, 'utf8').catch(() => '');
  await writeFile(claudeMd, upsertManagedBlock(current, await readTemplate('claude-md-block.md')));
  files.push('CLAUDE.md');
  await run('git', ['add', '--', ...files], { cwd: repo });
  const r = await run('git', ['commit', '-m', 'Add Supercharge skills and CLAUDE.md block', '--', ...files], {
    cwd: repo,
  });
  return r.code === 0;
}

// ── task new ──────────────────────────────────────────────────────────────────

export async function resolveProject(ctx: Ctx, cwd: string, name?: string): Promise<ProjectRecord> {
  if (name) {
    const p = await ctx.ledger.getProject(name);
    if (!p)
      throw new CliError(
        `Unknown project "${name}".`,
        EXIT.usage,
        'List projects with "supercharge status".',
      );
    return p;
  }
  const repo = await mainCheckout(cwd);
  const p = repo ? await ctx.ledger.findProjectByRepo(repo) : null;
  if (!p)
    throw new CliError(
      'No Supercharge project here.',
      EXIT.usage,
      'Run "supercharge init" in the repository, or pass --project <name>.',
    );
  return p;
}

export async function newTask(
  ctx: Ctx,
  opts: { cwd: string; title: string; project?: string; brief?: string; base?: string; actor?: Actor },
): Promise<TaskRecord & { warnings?: string[] }> {
  const title = opts.title.trim();
  if (!title) throw new CliError('A task needs a title.', EXIT.usage);
  const project = await resolveProject(ctx, opts.cwd, opts.project);
  if (!project.controlSessionId)
    throw new CliError(
      `Project "${project.name}" has no control session.`,
      EXIT.usage,
      'Run "supercharge init" in its repository first.',
    );
  const overrides = ctx.config.projects[project.name] ?? {};
  const id = await ctx.ledger.allocateTaskId(project.name);
  const prefix = overrides.branchPrefix ?? ctx.config.tasks.branchPrefix;
  const branch = `${prefix}${id.toLowerCase()}-${slugify(title, 40) || 'task'}`;
  const baseBranch = opts.base ?? overrides.baseBranch ?? (await defaultBranch(project.repoPath));
  const brief =
    opts.brief?.trim() || '(no brief given; ask the control chat or the user if anything is unclear)';

  const promptFile = ctx.ledger.sessionPromptFile(project.name, id);
  assertSafeArg(promptFile, 'The session prompt path');
  await writeFileAtomic(
    promptFile,
    render(await readTemplate('roles/worker.md'), {
      project: project.name,
      taskId: id,
      title,
      branch,
      baseBranch,
      brief,
    }),
  );

  const before = new Set((await listAoe(ctx)).map((s) => s.id));
  const r = await ctx.aoeCli.add({
    path: project.repoPath,
    title: `${id} ${title}`,
    parent: project.controlSessionId,
    worktreeBranch: branch,
    newBranch: true,
    baseBranch,
    tool: 'claude',
    extraArgs: [
      '--append-system-prompt-file',
      promptFile,
      ...modelArgs(ctx.config),
      '--permission-mode',
      ctx.config.agent.workerPermissionMode,
      ...ctx.config.agent.extraArgs,
    ],
    launch: true,
  });
  const created = (await listAoe(ctx)).find(
    (s) => !before.has(s.id) && (s.worktree?.branch === branch || s.title === `${id} ${title}`),
  );
  if (!created) {
    throw new CliError(
      `aoe add failed: ${(r.stderr || r.stdout || r.error?.message || '').trim() || `no session was created for ${branch}`}`,
      EXIT.error,
      'Check "aoe list"; a half-made worktree can be removed with "aoe worktree cleanup".',
    );
  }
  const launchWarn = launchWarning(r, created.id);

  const at = new Date().toISOString();
  const task: TaskRecord = {
    schema: 1,
    rev: 1,
    id,
    project: project.name,
    title,
    brief: opts.brief?.trim() ?? '',
    branch,
    baseBranch,
    worktreePath: created.path ?? '',
    aoeSessionId: created.id,
    parentSessionId: project.controlSessionId,
    stage: 'planning',
    blockedFrom: null,
    openQuestion: null,
    plan: null,
    mr: null,
    createdAt: at,
    updatedAt: at,
    history: [{ at, from: null, to: 'planning', by: opts.actor ?? 'control', note: 'Task created' }],
  };
  try {
    await ctx.ledger.createTask(task);
  } catch (err) {
    await ctx.aoe.deleteSession(created.id, { deleteWorktree: true, deleteBranch: true }).catch(() => {});
    throw err;
  }
  await appendAudit(ctx.paths, {
    actor: 'cli',
    action: 'task_created',
    project: project.name,
    taskId: id,
    sessionId: created.id,
    details: { branch, baseBranch },
  });
  return launchWarn ? { ...task, warnings: [launchWarn] } : task;
}

// ── stage / ask / plan ────────────────────────────────────────────────────────

export class TransitionError extends CliError {}

function rejection(task: TaskRecord, to: Stage, reason: string, allowed: Stage[]): TransitionError {
  const lines = allowed.map((s) => `  ${STAGE_LABEL[s].padEnd(16)} ${nextStageHint(s)}`);
  const hint = allowed.length ? `Allowed from ${STAGE_LABEL[task.stage]}:\n${lines.join('\n')}` : null;
  return new TransitionError(reason, EXIT.invalidTransition, hint);
}

export async function stageTask(
  ctx: Ctx,
  opts: { cwd: string; stage: Stage; note?: string; mrUrl?: string; force?: boolean },
): Promise<TaskRecord> {
  const who = await requireTask(ctx, opts.cwd);
  const task = who.record;
  let mr: MrState | null = task.mr;

  if (opts.stage === 'mr_raised') {
    const provider = mrProvider(ctx.config, ctx.env);
    if (opts.mrUrl) {
      const ref = provider.parseUrl(opts.mrUrl);
      if (!ref)
        throw new CliError(
          `Not a GitLab merge request URL: ${opts.mrUrl}`,
          EXIT.usage,
          'Expected https://<host>/<group>/<repo>/-/merge_requests/<iid>',
        );
      mr = {
        provider: 'gitlab',
        host: ref.host,
        repo: ref.repo,
        iid: ref.iid,
        url: ref.url,
        state: 'opened',
        draft: false,
        pipeline: null,
        unresolvedThreads: 0,
        detailedMergeStatus: null,
        checkedAt: null,
        error: null,
      };
    } else {
      const remote = parseRemote(
        who.projectRecord.remoteUrl ?? (await remoteUrl(who.projectRecord.repoPath)),
      );
      if (remote && provider.matches(remote)) {
        const ref = await provider.findOpenMrForBranch(remote, task.branch).catch(() => null);
        if (ref)
          mr = {
            provider: 'gitlab',
            host: ref.host,
            repo: ref.repo,
            iid: ref.iid,
            url: ref.url,
            state: 'opened',
            draft: false,
            pipeline: null,
            unresolvedThreads: 0,
            detailedMergeStatus: null,
            checkedAt: null,
            error: null,
          };
      }
    }
  }

  const res = transition(task, opts.stage, who.actor, {
    planApproved: task.plan?.status === 'approved',
    hasMr: !!mr,
    question: task.openQuestion?.text ?? null,
    force: opts.force,
  });
  if (!res.ok) throw rejection(task, opts.stage, res.reason, res.allowed);

  return ctx.ledger.updateTask(task.project, task.id, (t) => {
    const next = applyStage(t, opts.stage, who.actor, opts.note?.trim() || (opts.force ? 'Forced' : null));
    return opts.stage === 'mr_raised' ? { ...next, mr } : next;
  });
}

export async function askQuestion(
  ctx: Ctx,
  opts: { cwd: string; question: string; options?: string[] },
): Promise<TaskRecord> {
  const who = await requireTask(ctx, opts.cwd);
  const task = who.record;
  const question = opts.question.trim();
  const options = (opts.options ?? []).map((o) => o.trim()).filter(Boolean);
  if (options.length > 6 || options.some((o) => o.length > 200))
    throw new CliError('Give at most 6 options of up to 200 characters each.', EXIT.usage);
  const res = transition(task, 'blocked', who.actor, { planApproved: true, hasMr: true, question });
  if (!res.ok) throw rejection(task, 'blocked', res.reason, res.allowed);
  return ctx.ledger.updateTask(task.project, task.id, (t) => ({
    ...applyStage(t, 'blocked', who.actor, question),
    openQuestion: {
      text: question,
      ...(options.length ? { options } : {}),
      askedAt: new Date().toISOString(),
      answeredAt: null,
    },
  }));
}

export async function savePlan(
  ctx: Ctx,
  opts: { cwd: string; markdown: string; draft?: boolean },
): Promise<TaskRecord> {
  const who = await requireTask(ctx, opts.cwd);
  const task = who.record;
  if (task.stage === 'done') throw new CliError('This task is done.', EXIT.invalidTransition);
  if (!opts.markdown.trim())
    throw new CliError(
      'The plan is empty.',
      EXIT.usage,
      'Pass a markdown file, or "-" and the plan on stdin.',
    );
  const hash = await ctx.ledger.writePlan(task.project, task.id, opts.markdown);
  return ctx.ledger.updateTask(task.project, task.id, (t) => ({
    ...t,
    plan: { status: opts.draft ? 'draft' : 'approved', savedAt: new Date().toISOString(), sha256: hash },
  }));
}

// ── reply ─────────────────────────────────────────────────────────────────────

/** Explicit, audited prompt to a worker (SPEC §8.4). Callers must have confirmed with the human first. */
/**
 * Switch a running session's model or effort by typing /model or /effort into it, the only way AoE
 * offers. Claude Code also saves a typed /model (and /effort low to xhigh) as the user's default for new
 * sessions; the dashboard says so before it calls this. Only short aliases are accepted: AoE types
 * them as a command (with the trailing space that keeps autocomplete from eating the Enter).
 */
export async function setSessionModel(
  ctx: Ctx,
  opts: {
    sessionId: string;
    model?: string;
    effort?: string;
    actor: 'cli' | 'ui' | 'control';
    project?: string | null;
    taskId?: string | null;
  },
): Promise<void> {
  if (opts.model === undefined && opts.effort === undefined)
    throw new CliError('Pick a model or an effort level.', EXIT.usage);
  if (opts.model !== undefined && !(MODEL_ALIASES as readonly string[]).includes(opts.model))
    throw new CliError(`Unknown model "${opts.model}". Use one of: ${MODEL_ALIASES.join(', ')}.`, EXIT.usage);
  if (opts.effort !== undefined && !(EFFORT_LEVELS as readonly string[]).includes(opts.effort))
    throw new CliError(
      `Unknown effort "${opts.effort}". Use one of: ${EFFORT_LEVELS.join(', ')}.`,
      EXIT.usage,
    );
  if (opts.model !== undefined) await sendToSession(ctx, { ...opts, message: `/model ${opts.model}` });
  if (opts.effort !== undefined) await sendToSession(ctx, { ...opts, message: `/effort ${opts.effort}` });
}

/** `--model` / `--effort` for a new session from config: session-only, unlike /model typed later. */
export function modelArgs(config: Config): string[] {
  const args: string[] = [];
  if (config.agent.model) args.push('--model', config.agent.model);
  if (config.agent.effort !== 'default') args.push('--effort', config.agent.effort);
  return args;
}

/**
 * Send a message into an AoE session (SPEC §8.4): always audited, REST first with the CLI as
 * fallback. Callers make sure the human explicitly asked for it (a Send click, a confirmed reply).
 */
export async function sendToSession(
  ctx: Ctx,
  opts: {
    sessionId: string;
    message: string;
    actor: 'cli' | 'ui' | 'control';
    project?: string | null;
    taskId?: string | null;
  },
): Promise<void> {
  const message = opts.message.trim();
  if (!message) throw new CliError('The message is empty.', EXIT.usage);
  // AoE types the text and then presses Enter. With a menu open, that Enter picks its highlighted option
  // (for a plan: "Yes, and use auto mode"), so a message must wait until the menu is answered.
  const menu = await menuOnScreen(ctx, opts.sessionId);
  if (menu)
    throw new MenuOpenError(
      `The session is showing a menu${menu.question ? ` ("${menu.question}")` : ''}, so a message now would pick its highlighted option.`,
      'Answer the menu first, in the dashboard or the terminal, then send the message.',
    );
  await appendAudit(ctx.paths, {
    actor: opts.actor,
    action: 'prompt_sent',
    project: opts.project ?? null,
    taskId: opts.taskId ?? null,
    sessionId: opts.sessionId,
    text: message,
  });
  await deliver(ctx, opts.sessionId, message);
}

export interface QuestionAnswer {
  question: string;
  /** Labels of the options picked (one for single choice). */
  picked: string[];
  /** Free text ("Type something"). */
  other?: string;
}

/** The answers as one message Claude can read, in the order it asked. */
export function formatAnswers(answers: QuestionAnswer[], note?: string): string {
  const lines = ['My answers to your questions:', ''];
  answers.forEach((a, i) => {
    const parts = [...a.picked, ...(a.other?.trim() ? [a.other.trim()] : [])];
    lines.push(
      `${i + 1}. ${a.question}`,
      `   Answer: ${parts.length ? parts.join('; ') : '(no answer)'}`,
      '',
    );
  });
  if (note?.trim()) lines.push(note.trim());
  return lines.join('\n').trim();
}

/**
 * Answer Claude's own multiple-choice tool (AskUserQuestion). Its tabs move on with every key, so
 * typing answers into it with AoE's always-on Enter is unsafe. Instead: press Escape through AoE's live
 * terminal (no Enter), which closes the menu and stops Claude, then send the answers as a message.
 */
export async function answerQuestions(
  ctx: Ctx,
  transcripts: TranscriptStore,
  opts: {
    sessionId: string;
    cwd: string | null;
    /** The AskUserQuestion call id, or the on-screen menu key when Claude has not written the call yet. */
    toolId: string;
    answers: QuestionAnswer[];
    /** Anything else for Claude, e.g. about the questions the screen did not show. */
    note?: string;
    actor: 'cli' | 'ui' | 'control';
    project?: string | null;
    taskId?: string | null;
  },
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  const pending = await transcripts.pendingTool(opts.sessionId, opts.cwd).catch(() => null);
  const inTranscript = pending?.name === 'AskUserQuestion' && pending.id === opts.toolId;
  const onScreen = !inTranscript && (await menuOnScreen(ctx, opts.sessionId))?.key === opts.toolId;
  if (!inTranscript && !onScreen)
    throw new PromptChangedError('Those questions are no longer waiting, so nothing was sent.');
  if (!opts.answers.length) throw new CliError('Answer at least one question.', EXIT.usage);
  const message = formatAnswers(opts.answers, opts.note);
  await appendAudit(ctx.paths, {
    actor: opts.actor,
    action: 'prompt_answered',
    project: opts.project ?? null,
    taskId: opts.taskId ?? null,
    sessionId: opts.sessionId,
    text: message,
  });
  try {
    await ctx.aoe.pressKeys(opts.sessionId, ['\x1b']);
  } catch (err) {
    if (err instanceof TerminalBusyError) throw new TerminalBusyCliError(err.message);
    throw new CliError(`Could not close Claude's question: ${(err as Error).message}`);
  }
  for (let i = 0; ; i++) {
    await wait(250);
    const still = await transcripts.pendingTool(opts.sessionId, opts.cwd).catch(() => null);
    if (still?.id !== opts.toolId && !(await menuOnScreen(ctx, opts.sessionId))) break;
    if (i >= 24)
      throw new CliError(
        'Claude did not close its question, so your answers were not sent. Check the terminal.',
      );
  }
  await sendToSession(ctx, { ...opts, message });
}

/** Someone is viewing the session in AoE and holds its typing lock. */
export class TerminalBusyCliError extends CliError {}

/** A message was refused because Claude is showing a menu. */
export class MenuOpenError extends CliError {
  constructor(message: string, hint: string) {
    super(message, EXIT.usage, hint);
  }
}

/** The menu someone tried to answer is no longer the one on screen. */
export class PromptChangedError extends CliError {}

/** REST first, the CLI as fallback (SPEC §8.4). */
async function deliver(ctx: Ctx, sessionId: string, text: string) {
  try {
    await ctx.aoe.send(sessionId, text);
  } catch (err) {
    const r = await ctx.aoeCli.send(sessionId, text);
    if (r.code !== 0) throw new CliError(`Could not deliver the message: ${(err as Error).message}`);
  }
}

/**
 * Answer the menu a session is showing by typing the option's number, as you would in the terminal.
 * Claude Code confirms a numbered option on the digit alone; AoE's Enter after it lands on the empty
 * prompt. For an option that means telling Claude something, the digit focuses (or picks) it, the menu
 * closes, and the text then goes in as a normal message. Only delivered while the same menu is on screen.
 */
export async function answerPrompt(
  ctx: Ctx,
  opts: {
    sessionId: string;
    key: string;
    option: number;
    text?: string;
    actor: 'cli' | 'ui' | 'control';
    project?: string | null;
    taskId?: string | null;
  },
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  const menu = await menuOnScreen(ctx, opts.sessionId);
  if (!menu || menu.key !== opts.key)
    throw new PromptChangedError(
      'That menu is no longer on screen, so nothing was sent. Look at it again before answering.',
    );
  const option = menu.options.find((o) => o.n === opts.option);
  if (!option) throw new CliError(`Option ${opts.option} is not in this menu.`, EXIT.usage);
  const text = opts.text?.trim() ?? '';
  if (text && !option.feedback) throw new CliError(`Option ${option.n} does not take a message.`, EXIT.usage);
  await appendAudit(ctx.paths, {
    actor: opts.actor,
    action: 'prompt_answered',
    project: opts.project ?? null,
    taskId: opts.taskId ?? null,
    sessionId: opts.sessionId,
    text: `${option.n}. ${option.label}${menu.question ? ` (to: ${menu.question})` : ''}`,
  });
  await deliver(ctx, opts.sessionId, String(option.n));
  if (!text) return;
  for (let i = 0; ; i++) {
    await wait(250);
    const now = await menuOnScreen(ctx, opts.sessionId);
    if (!now || now.key !== opts.key) break;
    if (i >= 20)
      throw new CliError('Claude did not close the menu, so your message was not sent. Check the terminal.');
  }
  await sendToSession(ctx, { ...opts, message: text });
}

export async function replyToTask(
  ctx: Ctx,
  opts: { project: string; taskId: string; message: string; actor: 'cli' | 'ui' | 'control' },
): Promise<TaskRecord> {
  const message = opts.message.trim();
  if (!message) throw new CliError('The reply is empty.', EXIT.usage);
  const task = await ctx.ledger.getTask(opts.project, opts.taskId);
  if (!task) throw new CliError(`Unknown task ${opts.taskId} in ${opts.project}.`, EXIT.usage);
  await sendToSession(ctx, {
    sessionId: task.aoeSessionId,
    message,
    actor: opts.actor,
    project: task.project,
    taskId: task.id,
  });
  if (task.openQuestion && !task.openQuestion.answeredAt) {
    return ctx.ledger.updateTask(task.project, task.id, (t) => ({
      ...t,
      openQuestion: t.openQuestion ? { ...t.openQuestion, answeredAt: new Date().toISOString() } : null,
    }));
  }
  return task;
}

export async function findTask(ctx: Ctx, taskId: string, project?: string): Promise<TaskRecord> {
  const all = await ctx.ledger.listTasks(project);
  const matches = all.filter((t) => t.id.toLowerCase() === taskId.toLowerCase());
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1)
    throw new CliError(`Task id ${taskId} exists in several projects.`, EXIT.usage, 'Pass --project <name>.');
  throw new CliError(`Unknown task ${taskId}.`, EXIT.usage);
}
