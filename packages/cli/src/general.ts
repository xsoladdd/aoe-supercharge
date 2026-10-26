import { appendAudit, readUsage, writeFileAtomic } from '@aoe-supercharge/core/node';
import {
  GENERAL_KEY,
  generalSessionIds,
  normalizeAoeStatus,
  pickWorkerName,
  usageReport,
  type LiveStatus,
  type UsageReport,
} from '@aoe-supercharge/core/shared';
import type { AoeCliListEntry } from './aoe/schemas.ts';
import { VERSION, type Ctx } from './context.ts';
import { installUserSkills, readTemplate } from './skills.ts';
import { uploadArgs } from './uploads.ts';
import { CliError, EXIT } from './util/errors.ts';
import {
  assertSafeArg,
  checkModelPick,
  claudeSettingsArgs,
  controlPick,
  launchWarning,
  listAoe,
  modelArgs,
  remoteControlName,
  sendToSession,
  usageNow,
} from './workflow.ts';

/** AoE group of the General control chat and General chats; the control chat's workers inherit it. */
export const GENERAL_GROUP = 'supercharge/general';

/** A role prompt from the templates, rewritten on every start so it follows upgrades. */
async function rolePrompt(file: string, template: string): Promise<string> {
  assertSafeArg(file, 'The General prompt path');
  await writeFileAtomic(file, await readTemplate(template));
  return file;
}

/** `aoe add --scratch`, launched, and the session it made (found by title among the new ones). */
async function addScratch(
  ctx: Ctx,
  before: AoeCliListEntry[],
  o: { title: string; group?: string; parent?: string; extraArgs: string[] },
): Promise<{ id: string; path: string; warning: string | null }> {
  const seen = new Set(before.map((s) => s.id));
  const r = await ctx.aoeCli.add({ scratch: true, tool: 'claude', launch: true, ...o });
  const created = (await listAoe(ctx)).find((s) => !seen.has(s.id) && s.title === o.title);
  if (!created)
    throw new CliError(
      `aoe add failed: ${(r.stderr || r.stdout || r.error?.message || '').trim() || 'no session was created'}`,
    );
  return { id: created.id, path: created.path ?? '', warning: launchWarning(r, created.id) };
}

const exists = (sessions: AoeCliListEntry[], id: string | null) =>
  !!id && sessions.some((s) => s.id === id && s.state !== 'trashed');

/**
 * The General control chat (SPEC §14.7): a coordinator with no project, in a scratch directory. Starts
 * it when there is none (an archived one still counts: unarchive it instead).
 */
export async function startGeneralControl(
  ctx: Ctx,
  actor: 'cli' | 'ui',
): Promise<{ sessionId: string; created: boolean; warnings: string[] }> {
  const general = await ctx.ledger.getGeneral();
  const sessions = await ctx.aoeCli.list('all');
  if (exists(sessions, general.controlSessionId))
    return { sessionId: general.controlSessionId!, created: false, warnings: [] };
  const extraArgs = [
    '--append-system-prompt-file',
    await rolePrompt(ctx.ledger.generalControlPromptFile, 'roles/general-control.md'),
    ...modelArgs(ctx.config, controlPick(ctx.config)),
    ...(await claudeSettingsArgs(ctx)),
    ...uploadArgs(ctx.paths),
    ...ctx.config.agent.extraArgs,
  ];
  if (ctx.config.remoteControl.enabled)
    extraArgs.push('--remote-control', remoteControlName(ctx.config, 'general'));
  await installUserSkills(ctx.paths, VERSION);
  const s = await addScratch(ctx, sessions, { title: 'General control', group: GENERAL_GROUP, extraArgs });
  await ctx.ledger.updateGeneral((g) => ({ ...g, controlSessionId: s.id }));
  await appendAudit(ctx.paths, {
    actor,
    action: 'general_session_created',
    project: null,
    sessionId: s.id,
    details: { control: true, path: s.path },
  });
  return { sessionId: s.id, created: true, warnings: s.warning ? [s.warning] : [] };
}

export interface NewGeneralSession {
  sessionId: string;
  name: string;
  title: string;
  /** Started under the General control chat, rather than on its own. */
  worker: boolean;
  path: string;
  model: string | null;
  effort: string | null;
  /** Usage counting the session that just started, for the control chat's next decision. */
  usage: UsageReport;
  warnings: string[];
}

/**
 * A General chat (on its own) or worker (under the General control chat): a Claude session in a fresh
 * scratch directory that AoE deletes with the session. Refused with exit 6 when your usage says wait,
 * unless `force`. Its first message is the caller's to send (the daemon holds it until the prompt).
 */
export async function newGeneralSession(
  ctx: Ctx,
  o: {
    title?: string;
    model?: string;
    effort?: string;
    worker?: boolean;
    force?: boolean;
    actor: 'cli' | 'ui' | 'control';
  },
): Promise<NewGeneralSession> {
  checkModelPick(o);
  const general = await ctx.ledger.getGeneral();
  const sessions = await listAoe(ctx);
  if (o.worker && !exists(sessions, general.controlSessionId))
    throw new CliError(
      'There is no General control chat.',
      EXIT.usage,
      'Start it from the General section of the dashboard.',
    );
  const name = pickWorkerName(Object.values(general.sessions), GENERAL_KEY);
  const title = o.title?.trim().slice(0, 120) || name;
  const usage = await usageNow(ctx, sessions);
  if (!usage.canStart && !o.force)
    throw new CliError(
      `Not starting "${title}": ${usage.advice}`,
      EXIT.limited,
      'Tell the user what is waiting and why. Start it later, or add --force if the user says to start it anyway.',
    );
  const model = o.model ?? (ctx.config.agent.model || null);
  const effort = o.effort ?? (ctx.config.agent.effort === 'default' ? null : ctx.config.agent.effort);
  const s = await addScratch(ctx, sessions, {
    title,
    ...(o.worker ? { parent: general.controlSessionId! } : { group: GENERAL_GROUP }),
    extraArgs: [
      '--append-system-prompt-file',
      await rolePrompt(ctx.ledger.generalSessionPromptFile, 'roles/general.md'),
      ...modelArgs(ctx.config, { model, effort }),
      ...(await claudeSettingsArgs(ctx)),
      ...uploadArgs(ctx.paths),
      ...ctx.config.agent.extraArgs,
    ],
  });
  await ctx.ledger.updateGeneral((g) => ({ ...g, sessions: { ...g.sessions, [s.id]: name } }));
  await appendAudit(ctx.paths, {
    actor: o.actor,
    action: 'general_session_created',
    project: null,
    sessionId: s.id,
    details: {
      name,
      title,
      worker: !!o.worker,
      path: s.path,
      model,
      effort,
      ...(usage.canStart ? {} : { forced: usage.advice }),
    },
  });
  return {
    sessionId: s.id,
    name,
    title,
    worker: !!o.worker,
    path: s.path,
    model,
    effort,
    usage: usageReport(await readUsage(ctx.paths), usage.activeWorkers + 1, ctx.config.limits),
    warnings: s.warning ? [s.warning] : [],
  };
}

export interface GeneralListEntry {
  sessionId: string;
  name: string | null;
  title: string;
  worker: boolean;
  status: LiveStatus;
  path: string | null;
}

/** The General chats and workers that are in AoE now (trashed ones left out), oldest first. */
export async function listGeneral(
  ctx: Ctx,
): Promise<{ control: string | null; sessions: GeneralListEntry[] }> {
  const general = await ctx.ledger.getGeneral();
  const all = (await listAoe(ctx)).filter((s) => s.state !== 'trashed');
  const status = new Map(
    ((await ctx.aoe.listSessions().catch(() => null)) ?? []).map((s) => [s.id, normalizeAoeStatus(s.status)]),
  );
  const ids = generalSessionIds(
    general,
    all.map((s) => ({ id: s.id, parentId: s.parent_session_id ?? null })),
  );
  return {
    control: general.controlSessionId,
    sessions: all
      .filter((s) => ids.has(s.id))
      .map((s) => ({
        sessionId: s.id,
        name: general.sessions[s.id] ?? null,
        title: s.title ?? s.id,
        worker: !!general.controlSessionId && s.parent_session_id === general.controlSessionId,
        status: status.get(s.id) ?? 'unknown',
        path: s.path ?? null,
      })),
  };
}

/** Message a General chat or worker by its name or session id: explicit and audited, like `reply`. */
export async function sendToGeneral(
  ctx: Ctx,
  o: { target: string; message: string; actor: 'cli' | 'control' },
): Promise<GeneralListEntry> {
  const { sessions } = await listGeneral(ctx);
  const want = o.target.trim().toLowerCase();
  const s =
    sessions.find((x) => x.sessionId === o.target) ??
    sessions.find((x) => x.name?.toLowerCase() === want) ??
    sessions.find((x) => x.title.toLowerCase() === want);
  if (!s)
    throw new CliError(
      `No General chat or worker "${o.target}".`,
      EXIT.usage,
      'List them with "supercharge general list".',
    );
  await sendToSession(ctx, { sessionId: s.sessionId, message: o.message, actor: o.actor, project: null });
  return s;
}
