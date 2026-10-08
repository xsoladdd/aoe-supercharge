import {
  checkCompat,
  Ledger,
  loadConfig,
  Notes,
  readLocalCompat,
  resolvePaths,
  type CompatFile,
  type CompatResult,
  type Config,
  type Paths,
} from '@aoe-supercharge/core/node';
import compatJson from '../../../compat.json' with { type: 'json' };
import pkg from '../package.json' with { type: 'json' };
import { AoeCli } from './aoe/cli.ts';
import { AoeClient } from './aoe/client.ts';
import { Logger } from './util/logger.ts';

export const VERSION: string = pkg.version;
export const SHIPPED_COMPAT: CompatFile = compatJson;

export interface Ctx {
  paths: Paths;
  config: Config;
  configErrors: string[];
  configExists: boolean;
  logger: Logger;
  aoeCli: AoeCli;
  aoe: AoeClient;
  ledger: Ledger;
  notes: Notes;
  env: NodeJS.ProcessEnv;
  /** Told whenever something is typed into a session (the daemon's typing gate listens). */
  onTyped?: (sessionId: string) => void;
}

export async function createCtx(
  opts: { logFile?: boolean; stderr?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<Ctx> {
  const env = opts.env ?? process.env;
  const paths = resolvePaths(env);
  const loaded = await loadConfig(paths);
  const config = loaded.config;
  const logger = new Logger({
    file: opts.logFile ? paths.logFile : null,
    level: env.SUPERCHARGE_LOG_LEVEL === 'debug' ? 'debug' : config.logging.level,
    maxBytes: config.logging.maxFileMb * 1024 * 1024,
    maxFiles: config.logging.maxFiles,
    stderr: opts.stderr,
  });
  const aoeCli = new AoeCli(config.aoe.binary, config.aoe.profile, env);
  return {
    paths,
    config,
    configErrors: loaded.errors,
    configExists: loaded.exists,
    logger,
    aoeCli,
    aoe: new AoeClient(aoeCli, config.aoe.url),
    ledger: new Ledger(paths),
    notes: new Notes(paths),
    env,
  };
}

export async function checkAoeCompat(ctx: Ctx, version?: string | null): Promise<CompatResult> {
  const v = version === undefined ? await ctx.aoeCli.version() : version;
  return checkCompat(v, SHIPPED_COMPAT, await readLocalCompat(ctx.paths));
}

export function dashboardOrigin(config: Config): string {
  return `http://${config.server.hostname}:${config.server.port}`;
}
