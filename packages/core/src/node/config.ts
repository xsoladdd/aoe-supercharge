import { readFile } from 'node:fs/promises';
import { patch as tomlPatch } from '@decimalturn/toml-patch';
import { parse as tomlParse } from 'smol-toml';
import { z } from 'zod';
import { ensureDir, writeFileAtomic } from './fs.ts';
import type { Paths } from './paths.ts';
import { validTimeZone } from '../shared/office-ambience.ts';

/** Arguments that land on AoE's shell launch line must not contain shell metacharacters (SPEC §10.1). */
export const SAFE_ARG = /^[A-Za-z0-9_@%+=:,./-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;

const seconds = (def: number, min: number, desc: string) =>
  z.number().int().min(min).max(3600).default(def).describe(desc);

export const ConfigSchema = z.strictObject({
  server: z
    .strictObject({
      port: z
        .number()
        .int()
        .min(1024)
        .max(65535)
        .default(4280)
        .describe('Dashboard port. The daemon always binds to 127.0.0.1.'),
      hostname: z
        .string()
        .regex(HOSTNAME, 'Must be a plain hostname')
        .default('supercharge.localhost')
        .describe('Hostname in the dashboard URL. Must resolve to loopback.'),
    })
    .prefault({}),
  aoe: z
    .strictObject({
      binary: z.string().min(1).default('aoe').describe('Path or name of the aoe binary.'),
      profile: z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,64}$/, 'Letters, digits, _ and - only')
        .default('main')
        .describe('AoE profile Supercharge manages.'),
      autoStart: z.boolean().default(true).describe('Start `aoe serve --daemon` when it is not running.'),
      url: z
        .string()
        .refine(
          (v) => v === '' || /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(v),
          'Must be a loopback http URL or empty',
        )
        .default('')
        .describe('AoE daemon URL. Empty means discover it with `aoe url`.'),
    })
    .prefault({}),
  agent: z
    .strictObject({
      kind: z.literal('claude-code').default('claude-code').describe('Only Claude Code is supported in v1.'),
      extraArgs: z
        .array(z.string().regex(SAFE_ARG, 'No spaces or shell metacharacters'))
        .default([])
        .describe('Extra claude arguments for every session.'),
      workerPermissionMode: z
        .enum(['plan', 'default', 'acceptEdits', 'auto'])
        .default('plan')
        .describe('Permission mode workers start in.'),
      controlModel: z
        .string()
        .regex(/^[A-Za-z0-9._-]*$/, 'An alias like opus or sonnet, or a full model id')
        .default('opus')
        .describe(
          'Model for new control chats: they split and judge the work, so Opus by default. The opus alias is Opus 5.5 on the current Claude Code and follows the next Opus; pin a full id to stop that. An alias (fable, opus, opusplan, sonnet, haiku) or a full id. Empty uses your Claude Code default.',
        ),
      controlEffort: z
        .enum(['low', 'medium', 'high', 'xhigh', 'max'])
        .default('xhigh')
        .describe(
          'Effort for new control chats (claude --effort), separate from the workers. xhigh by default: they split and judge the work. It applies to that chat only, and your Claude Code default is not touched.',
        ),
      model: z
        .string()
        .regex(/^[A-Za-z0-9._-]*$/, 'An alias like opus or sonnet, or a full model id')
        .default('')
        .describe(
          'Model for workers started without --model. The control chat picks one per task (sonnet for well-scoped work, opus for harder work), so this is only the fallback. Workers that start in plan mode always plan with Opus: sonnet, or nothing here, starts them on opusplan (Opus while planning, Sonnet once the plan is approved).',
        ),
      effort: z
        .enum(['default', 'low', 'medium', 'high', 'xhigh', 'max'])
        .default('default')
        .describe(
          'Effort for workers started without --effort (claude --effort). Applies to that session only.',
        ),
      autoCompactWindow: z
        .number()
        .int()
        .refine((n) => n === 0 || (n >= 100_000 && n <= 1_000_000), '0, or 100000 to 1000000')
        .default(500_000)
        .describe(
          'Tokens before Claude Code compacts the conversation, for new sessions (like /autocompact). Lower keeps every turn cheaper. 0 uses your Claude Code setting.',
        ),
      statusLine: z
        .boolean()
        .default(true)
        .describe(
          "Give new sessions Supercharge's status line, which records your 5-hour and weekly usage for the limits below. Your own status line, if you have one, still shows.",
        ),
    })
    .prefault({}),
  limits: z
    .strictObject({
      enabled: z
        .boolean()
        .default(true)
        .describe('Check your 5-hour and weekly usage before a new worker starts.'),
      maxWorkers: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(4)
        .describe('Workers that may be active at once (planning, implementing, verifying or blocked).'),
      busyMaxWorkers: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(2)
        .describe('Workers that may be active at once while a limit is getting full.'),
      fiveHourBusyAt: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(50)
        .describe('5-hour usage (%) at which fewer workers run at once.'),
      fiveHourStopAt: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(85)
        .describe('5-hour usage (%) at which no new worker starts until the window resets.'),
      weeklyBusyAt: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(75)
        .describe('Weekly usage (%) at which fewer workers run at once.'),
      weeklyStopAt: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(95)
        .describe('Weekly usage (%) at which no new worker starts until the week resets.'),
    })
    .prefault({}),
  remoteControl: z
    .strictObject({
      enabled: z
        .boolean()
        .default(false)
        .describe(
          'Start control sessions with Claude Code Remote Control (use them from claude.ai or your phone).',
        ),
      nameTemplate: z
        .string()
        .regex(/^[a-z0-9{}-]+$/, 'Lowercase letters, digits, - and {project} only')
        .default('{project}-control')
        .describe('Remote Control session name. {project} is replaced with the project slug.'),
    })
    .prefault({}),
  tasks: z
    .strictObject({
      branchPrefix: z
        .string()
        .regex(/^[A-Za-z0-9._/-]*$/, 'Letters, digits, . _ / - only')
        .default('sc/')
        .describe('Prefix for worker branches.'),
      idPrefix: z
        .string()
        .regex(/^[A-Z0-9]{0,6}$/, 'Up to 6 uppercase letters or digits')
        .default('')
        .describe('Task id prefix. Empty derives it from the project name.'),
    })
    .prefault({}),
  poll: z
    .strictObject({
      aoeSessions: seconds(3, 1, 'Seconds between AoE polls while a dashboard is open.'),
      aoeSessionsIdle: seconds(15, 1, 'Seconds between AoE polls with no dashboard open.'),
      mr: seconds(60, 10, 'Seconds between merge request polls.'),
      reconcile: seconds(60, 5, 'Seconds between full ledger and parent-link rescans.'),
    })
    .prefault({}),
  mr: z
    .strictObject({
      provider: z
        .enum(['auto', 'gitlab'])
        .default('auto')
        .describe('Deprecated: the provider is picked per project from its remote, and per MR from its URL.'),
      gitlab: z
        .strictObject({
          hosts: z
            .array(z.string().regex(HOSTNAME, 'Must be a hostname'))
            .min(1)
            .default(['gitlab.com'])
            .describe('GitLab hosts to watch, including self-hosted ones.'),
          glabBinary: z.string().min(1).default('glab').describe('Path or name of the glab binary.'),
          readyRequiresNonDraft: z
            .boolean()
            .default(false)
            .describe('Draft MRs never count as ready for review.'),
        })
        .prefault({}),
      github: z
        .strictObject({
          hosts: z
            .array(z.string().regex(HOSTNAME, 'Must be a hostname'))
            .min(1)
            .default(['github.com'])
            .describe('GitHub hosts to watch, including GitHub Enterprise ones.'),
          ghBinary: z.string().min(1).default('gh').describe('Path or name of the gh binary.'),
          readyRequiresNonDraft: z
            .boolean()
            .default(false)
            .describe('Draft pull requests never count as ready for review.'),
        })
        .prefault({}),
    })
    .prefault({}),
  notifications: z
    .strictObject({
      enabled: z.boolean().default(true).describe('Desktop notifications.'),
      blocked: z.boolean().default(true).describe('A worker asks a question.'),
      readyForReview: z.boolean().default(true).describe('An MR becomes ready for review.'),
      aoeWaiting: z.boolean().default(true).describe('A worker waits for approval or input in AoE.'),
      controlWaiting: z.boolean().default(true).describe('A control chat waits for you.'),
      error: z.boolean().default(true).describe('A session errors.'),
      runaway: z.boolean().default(true).describe('A worker is flagged as a runaway in the office.'),
      waitingDebounceSeconds: z
        .number()
        .int()
        .min(0)
        .max(3600)
        .default(20)
        .describe('How long a session must wait before it counts.'),
    })
    .prefault({}),
  watch: z
    .strictObject({
      enabled: z
        .boolean()
        .default(true)
        .describe(
          "Tell each project's control chat when one of its workers asks a question, is done, waits on a permission prompt, errors or stalls. Each project can turn it off.",
        ),
      stallMinutes: z
        .number()
        .int()
        .min(1)
        .max(1440)
        .default(15)
        .describe('A worker idle this long with nothing to report has stalled.'),
    })
    .prefault({}),
  ui: z
    .strictObject({
      theme: z.enum(['dark', 'light', 'system']).default('dark').describe('Dashboard theme.'),
      density: z.enum(['comfortable', 'compact']).default('comfortable').describe('Row density.'),
      sound: z
        .boolean()
        .default(true)
        .describe('Play a sound in the dashboard when something new needs you.'),
      scale: z
        .enum(['small', 'default', 'large', 'larger'])
        .default('default')
        .describe('Interface size: text and spacing scale together.'),
      displayName: z
        .string()
        .trim()
        .max(40)
        .default('')
        .describe(
          'Your name on the office door ("Ericson" reads "Ericson’s office"). Empty reads "Your office".',
        ),
      officeAnimations: z
        .boolean()
        .default(true)
        .describe(
          'Walking, errands and arrivals in the office. Off, everyone jumps to their place (as with reduced motion).',
        ),
    })
    .prefault({}),
  office: z
    .strictObject({
      history: z
        .strictObject({
          retentionDays: z
            .number()
            .int()
            .min(1)
            .max(365)
            .default(30)
            .describe('Days of office history to keep. Older days are deleted.'),
        })
        .prefault({}),
      runaway: z
        .strictObject({
          sessionTokens: z
            .number()
            .int()
            .min(0)
            .max(1_000_000_000)
            .default(50_000_000)
            .describe(
              'Flag a worker whose conversation passes this many tokens (every kind, cache reads included). 0 is off.',
            ),
          usdPerHour: z
            .number()
            .min(0)
            .max(10_000)
            .default(20)
            .describe(
              'Flag a worker whose estimated spend in the last hour passes this, in US dollars. 0 is off.',
            ),
          stallMinutes: z
            .number()
            .int()
            .min(0)
            .max(1440)
            .default(30)
            .describe(
              'Flag a working worker that keeps spending tokens with no progress (no file changed, no stage moved) for this long. 0 is off.',
            ),
        })
        .prefault({}),
      idle: z
        .strictObject({
          promptMinutes: z
            .number()
            .int()
            .min(0)
            .max(10_080)
            .default(30)
            .describe(
              'Ask a worker idle in the pantry this long to go home (Archive, Keep, Snooze). 0 is off.',
            ),
          autoArchiveMinutes: z
            .number()
            .int()
            .min(0)
            .max(10_080)
            .default(0)
            .describe(
              'Send a worker idle this long home by itself. Office-only: its session, worktree and history stay. 0 is off.',
            ),
        })
        .prefault({}),
      clocks: z
        .strictObject({
          home: z
            .string()
            .refine(validTimeZone, 'Expected an IANA time zone, like Europe/Stockholm')
            .default('Europe/Stockholm')
            .describe('Your time zone, for the first clock (an IANA name, like Europe/Stockholm).'),
          away: z
            .string()
            .refine(validTimeZone, 'Expected an IANA time zone, like Asia/Manila')
            .default('Asia/Manila')
            .describe('A second time zone to keep an eye on (an IANA name, like Asia/Manila).'),
        })
        .prefault({}),
      weather: z
        .strictObject({
          enabled: z
            .boolean()
            .default(false)
            .describe(
              "Show the weather at home beside its clock, from Open-Meteo's free API. Off by default: review Open-Meteo's terms (non-commercial use) before turning it on.",
            ),
          latitude: z
            .number()
            .min(-90)
            .max(90)
            .default(59.33)
            .describe('Where the weather is for (Stockholm).'),
          longitude: z
            .number()
            .min(-180)
            .max(180)
            .default(18.07)
            .describe('Where the weather is for (Stockholm).'),
        })
        .prefault({}),
      windows: z
        .enum(['activity', 'weather'])
        .default('activity')
        .describe(
          "What the office windows show: the office's own activity, or the real sky at home (needs the weather on).",
        ),
    })
    .prefault({}),
  logging: z
    .strictObject({
      level: z.enum(['debug', 'info', 'warn', 'error']).default('info').describe('Daemon log level.'),
      maxFileMb: z.number().int().min(1).max(1000).default(10).describe('Rotate the log at this size.'),
      maxFiles: z.number().int().min(1).max(50).default(5).describe('Rotated log files to keep.'),
    })
    .prefault({}),
  projects: z
    .record(
      z.string().regex(SLUG, 'Project names are slugs'),
      z.strictObject({
        gitlabHost: z.string().regex(HOSTNAME).optional(),
        baseBranch: z.string().min(1).optional(),
        mr: z
          .enum(['none'])
          .optional()
          .describe(
            'Set to "none" when this project merges branches without merge requests: workers report a pushed branch ready to merge, and Supercharge marks it done once it lands.',
          ),
        branchPrefix: z
          .string()
          .regex(/^[A-Za-z0-9._/-]*$/)
          .optional(),
        watch: z.boolean().optional().describe('Worker watch for this project. Unset follows watch.enabled.'),
      }),
    )
    .default({})
    .describe('Per-project overrides.'),
});

export type Config = z.output<typeof ConfigSchema>;

/** Keys whose change needs a daemon restart (SPEC §5). Everything else hot-reloads. */
export const RESTART_PREFIXES = ['server', 'aoe', 'agent'] as const;

export const DEFAULT_CONFIG_TOML = `# Agent of Empires: Supercharge configuration.
# Every key is optional. Edit this file, use \`supercharge config set <key> <value>\`,
# or use the dashboard Settings page. All three use the same validation.

[server]
port = 4280

[remoteControl]
# Start control sessions with Claude Code Remote Control, so you can use them from your phone.
enabled = false

[mr.gitlab]
# Add self-hosted GitLab hosts here, e.g. ["gitlab.com", "gitlab.example.com"].
hosts = ["gitlab.com"]

[mr.github]
# Add GitHub Enterprise hosts here, e.g. ["github.com", "github.example.com"].
hosts = ["github.com"]

[ui]
theme = "dark"
`;

/** Whether a project's control chat hears about its workers (`projects.<name>.watch`, else `watch.enabled`). */
export function watchEnabled(config: Config, project: string): boolean {
  return config.projects[project]?.watch ?? config.watch.enabled;
}

export function defaultConfig(): Config {
  return ConfigSchema.parse({});
}

export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`);
}

export interface LoadedConfig {
  config: Config;
  errors: string[];
  exists: boolean;
  raw: string | null;
}

export async function loadConfig(paths: Paths): Promise<LoadedConfig> {
  let raw: string | null = null;
  try {
    raw = await readFile(paths.configFile, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (raw === null) return { config: defaultConfig(), errors: [], exists: false, raw: null };
  let parsed: unknown;
  try {
    parsed = tomlParse(raw);
  } catch (err) {
    return {
      config: defaultConfig(),
      errors: [`config.toml: ${(err as Error).message.split('\n')[0]}`],
      exists: true,
      raw,
    };
  }
  const result = ConfigSchema.safeParse(parsed);
  if (!result.success)
    return { config: defaultConfig(), errors: formatIssues(result.error), exists: true, raw };
  return { config: result.data, errors: [], exists: true, raw };
}

export async function ensureConfigFile(paths: Paths): Promise<boolean> {
  await ensureDir(paths.configDir, 0o700);
  try {
    await readFile(paths.configFile);
    return false;
  } catch {
    await writeFileAtomic(paths.configFile, DEFAULT_CONFIG_TOML, 0o644);
    return true;
  }
}

type Plain = Record<string, unknown>;
const isPlain = (v: unknown): v is Plain => typeof v === 'object' && v !== null && !Array.isArray(v);

export function deepMerge(base: Plain, patch: Plain): Plain {
  const out: Plain = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlain(v) && isPlain(out[k]) ? deepMerge(out[k] as Plain, v) : v;
  }
  return out;
}

export function leafKeys(obj: Plain, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    isPlain(v) && Object.keys(v).length ? leafKeys(v, `${prefix}${k}.`) : [`${prefix}${k}`],
  );
}

export function getByPath(obj: unknown, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((acc, k) => (isPlain(acc) ? acc[k] : undefined), obj);
}

export function patchFromPath(dotted: string, value: unknown): Plain {
  return dotted
    .split('.')
    .reverse()
    .reduce<unknown>((acc, k) => ({ [k]: acc }), value) as Plain;
}

export function restartRequiredFor(keys: string[]): string[] {
  return keys.filter((k) => RESTART_PREFIXES.some((p) => k === p || k.startsWith(`${p}.`)));
}

export class ConfigValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n  ${issues.join('\n  ')}`);
  }
}

export interface PatchResult {
  config: Config;
  changedKeys: string[];
  restartRequired: string[];
}

/** Validate `patch` merged over the file's current contents, then write it back preserving comments. */
export async function patchConfig(paths: Paths, patch: Plain): Promise<PatchResult> {
  await ensureConfigFile(paths);
  const raw = await readFile(paths.configFile, 'utf8');
  let current: Plain;
  try {
    current = tomlParse(raw) as Plain;
  } catch (err) {
    throw new ConfigValidationError([`config.toml: ${(err as Error).message.split('\n')[0]}`]);
  }
  const merged = deepMerge(current, patch);
  const result = ConfigSchema.safeParse(merged);
  if (!result.success) throw new ConfigValidationError(formatIssues(result.error));
  const changedKeys = leafKeys(patch).filter(
    (k) => JSON.stringify(getByPath(current, k)) !== JSON.stringify(getByPath(merged, k)),
  );
  if (changedKeys.length) await writeFileAtomic(paths.configFile, tomlPatch(raw, merged), 0o644);
  return { config: result.data, changedKeys, restartRequired: restartRequiredFor(changedKeys) };
}

/** `config set` coercion: try the JSON reading of the value, then the raw string (SPEC §5). */
export async function setConfigValue(paths: Paths, key: string, rawValue: string): Promise<PatchResult> {
  const candidates: unknown[] = [];
  try {
    candidates.push(JSON.parse(rawValue));
  } catch {
    // not JSON
  }
  if (rawValue.includes(',') && !rawValue.trim().startsWith('['))
    candidates.push(
      rawValue
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
  candidates.push(rawValue);
  let lastError: unknown;
  for (const value of candidates) {
    try {
      return await patchConfig(paths, patchFromPath(key, value));
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

export function configJsonSchema(): unknown {
  return z.toJSONSchema(ConfigSchema, { io: 'input', unrepresentable: 'any' });
}
