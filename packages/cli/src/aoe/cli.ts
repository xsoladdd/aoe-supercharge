import { parseAoeVersion } from '@aoe-supercharge/core/node';
import { run, type RunResult } from '../util/exec.ts';
import { AoeCliListSchema, type AoeCliListEntry } from './schemas.ts';

export interface AddSessionOptions {
  path: string;
  title: string;
  group?: string;
  parent?: string;
  worktreeBranch?: string;
  newBranch?: boolean;
  baseBranch?: string;
  tool: string;
  /** Joined with spaces onto AoE's shell launch line. Every element must already be shell-safe. */
  extraArgs?: string[];
  launch?: boolean;
}

/** Thin wrapper for the AoE CLI. Used for what REST lacks: parent links, `add -P`, version, serve control. */
export class AoeCli {
  constructor(
    public binary: string,
    public profile: string,
    private env: NodeJS.ProcessEnv = process.env,
  ) {}

  private exec(args: string[], timeoutMs = 20_000, input?: string): Promise<RunResult> {
    return run(this.binary, args, { env: this.env, timeoutMs, input });
  }

  async version(): Promise<string | null> {
    const r = await this.exec(['--version'], 10_000);
    return r.code === 0 ? parseAoeVersion(r.stdout) : null;
  }

  /** `aoe serve --status` exits 0 when a daemon is running. Output contains the token: never log it. */
  async serveRunning(): Promise<boolean> {
    const r = await this.exec(['serve', '--status'], 10_000);
    return r.code === 0;
  }

  async serveStart(): Promise<RunResult> {
    return this.exec(['serve', '--daemon'], 30_000);
  }

  /** Origin of the running daemon from `aoe url` (the token in the URL is dropped here). */
  async origin(): Promise<string | null> {
    const r = await this.exec(['url'], 10_000);
    if (r.code !== 0) return null;
    const m = r.stdout.match(/https?:\/\/[^\s]+/);
    if (!m) return null;
    try {
      return new URL(m[0]).origin;
    } catch {
      return null;
    }
  }

  async token(): Promise<string | null> {
    const r = await this.exec(['url', '--token-only'], 10_000);
    const t = r.code === 0 ? r.stdout.trim() : '';
    return t || null;
  }

  async list(): Promise<AoeCliListEntry[]> {
    const r = await this.exec(['list', '--json', '--state=live', '-p', this.profile], 20_000);
    if (r.code !== 0) throw new Error(`aoe list failed: ${(r.stderr || r.error?.message || '').trim()}`);
    return AoeCliListSchema.parse(JSON.parse(r.stdout || '[]'));
  }

  /** Claude's own session id for an AoE session (null until AoE has seen one). */
  async agentSessionId(id: string): Promise<string | null> {
    const r = await this.exec(['session', 'show', id, '--json', '-p', this.profile], 10_000);
    if (r.code !== 0) return null;
    try {
      const v = (JSON.parse(r.stdout) as { agent_session_id?: unknown }).agent_session_id;
      return typeof v === 'string' ? v : null;
    } catch {
      return null;
    }
  }

  async add(o: AddSessionOptions): Promise<RunResult> {
    const args = ['add', o.path, '-t', o.title, '--tool', o.tool, '-p', this.profile];
    if (o.group) args.push('-g', o.group);
    if (o.parent) args.push('-P', o.parent);
    if (o.worktreeBranch) args.push('-w', o.worktreeBranch);
    if (o.newBranch) args.push('-b');
    if (o.baseBranch) args.push('--base-branch', o.baseBranch);
    if (o.extraArgs?.length) args.push('--extra-args', o.extraArgs.join(' '));
    if (o.launch) args.push('-l');
    return this.exec(args, 120_000);
  }

  async send(id: string, message: string): Promise<RunResult> {
    return this.exec(['send', id, message, '-p', this.profile], 30_000);
  }
}
