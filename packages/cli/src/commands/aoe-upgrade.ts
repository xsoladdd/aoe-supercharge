import { createHash } from 'node:crypto';
import { copyFile, chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addLocalVerified,
  appendAudit,
  isAllowed,
  readLocalCompat,
  writeJsonAtomic,
} from '@aoe-supercharge/core/node';
import { runLiveContract } from '../aoe/contract.ts';
import { SHIPPED_COMPAT, type Ctx } from '../context.ts';
import { CliError, EXIT } from '../util/errors.ts';
import { run } from '../util/exec.ts';
import { c, confirm, out, sym } from '../util/term.ts';

const REPO = 'agent-of-empires/agent-of-empires';

export function releaseAsset(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const os = platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : null;
  const cpu = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'amd64' : null;
  if (!os || !cpu) throw new CliError(`No AoE release for ${platform}/${arch}.`);
  return `aoe-${os}-${cpu}.tar.gz`;
}

export function parseUpdateCheck(output: string): { current: string | null; latest: string | null } {
  return {
    current: output.match(/current:\s*v?(\d+\.\d+\.\d+)/)?.[1] ?? null,
    latest: output.match(/latest:\s*v?(\d+\.\d+\.\d+)/)?.[1] ?? null,
  };
}

async function download(url: string, file: string): Promise<void> {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(180_000) });
  if (!res.ok) throw new CliError(`Download failed (${res.status}): ${url}`);
  await writeFile(file, Buffer.from(await res.arrayBuffer()));
}

/** Release tarballs ship the binary as `aoe-<os>-<arch>` (v1.18.0); older ones as `aoe`. */
export async function findBinary(dir: string): Promise<string | null> {
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile() && /^aoe(-(darwin|linux)-(arm64|amd64))?$/.test(e.name)) return join(e.parentPath, e.name);
  }
  return null;
}

/**
 * `supercharge aoe upgrade` (SPEC §10.4): test the latest AoE release in a sandbox first, and only
 * then run `aoe update` and widen the locally allowed range. On failure, report what broke and change nothing.
 */
export async function aoeUpgrade(ctx: Ctx, opts: { check?: boolean; yes?: boolean }): Promise<number> {
  const r = await run(ctx.config.aoe.binary, ['update', '--check'], { env: ctx.env, timeoutMs: 60_000 });
  if (r.code !== 0 && !r.stdout)
    throw new CliError(`"aoe update --check" failed: ${(r.stderr || r.error?.message || '').trim()}`);
  const { current, latest } = parseUpdateCheck(r.stdout);
  if (!latest) throw new CliError('Could not read the latest AoE version from "aoe update --check".');
  const local = await readLocalCompat(ctx.paths);
  out(
    `AoE installed ${c.bold(current ?? 'unknown')}, latest ${c.bold(latest)}, tested range ${SHIPPED_COMPAT.aoe.range}`,
  );
  const latestAllowed = isAllowed(latest, SHIPPED_COMPAT, local);
  if (current === latest) {
    out(
      `${sym.ok} Already on the latest AoE${latestAllowed ? '' : ` (but ${latest} is outside the tested range; run without --check to verify it)`}.`,
    );
    if (latestAllowed || opts.check) return EXIT.ok;
  }
  if (opts.check) {
    out(
      latestAllowed
        ? `${sym.ok} ${latest} is already allowed; "aoe update" is safe.`
        : `${sym.info} ${latest} has not been tested. Run "supercharge aoe upgrade" to test it.`,
    );
    return EXIT.ok;
  }

  const asset = releaseAsset();
  const base = `https://github.com/${REPO}/releases/download/v${latest}`;
  const work = await mkdtemp(join(tmpdir(), 'sc-aoe-upgrade-'));
  try {
    out(`${sym.info} Downloading ${asset} (v${latest})`);
    const tarball = join(work, asset);
    await download(`${base}/${asset}`, tarball);
    await download(`${base}/${asset}.sha256`, `${tarball}.sha256`);
    const expected = (await readFile(`${tarball}.sha256`, 'utf8')).trim().split(/\s+/)[0]?.toLowerCase();
    const actual = createHash('sha256')
      .update(await readFile(tarball))
      .digest('hex');
    if (!expected || expected !== actual)
      throw new CliError(`Checksum mismatch for ${asset}. Nothing was changed.`);
    out(`${sym.ok} Checksum verified (${(await stat(tarball)).size} bytes)`);
    const extract = await run('tar', ['-xzf', tarball, '-C', work], { timeoutMs: 120_000 });
    if (extract.code !== 0) throw new CliError(`Could not extract ${asset}: ${extract.stderr.trim()}`);
    const found = await findBinary(work);
    if (!found) throw new CliError(`No aoe binary inside ${asset}.`);
    // AoE 1.18 only recognises its own daemon when the binary is named `aoe`; installs always are.
    const bin = join(work, 'bin', 'aoe');
    await mkdir(join(work, 'bin'), { recursive: true });
    await copyFile(found, bin);
    await chmod(bin, 0o755);

    out(
      `${sym.info} Running the live contract tests against ${latest} in a sandbox (your AoE data is not touched)`,
    );
    const result = await runLiveContract(bin, (line) => out(`    ${c.dim(line)}`));
    if (!result.ok) {
      out(`\n${sym.fail} AoE ${latest} broke the contract. Nothing was changed. Failed checks:`);
      for (const ch of result.checks.filter((x) => !x.ok)) out(`    ${ch.name}: ${ch.detail}`);
      out('Report this, or keep using a tested AoE version (README#aoe-versions).');
      return EXIT.aoeIncompatible;
    }
    out(`${sym.ok} All ${result.checks.length} contract checks passed`);
    if (!opts.yes && !(await confirm(`Upgrade AoE ${current} → ${latest} now with "aoe update"?`))) {
      out('Not upgraded. Re-run with --yes to skip this question.');
      return EXIT.ok;
    }
    const upd = await run(ctx.config.aoe.binary, ['update', '-y'], { env: ctx.env, timeoutMs: 300_000 });
    if (upd.code !== 0) throw new CliError(`"aoe update -y" failed: ${(upd.stderr || upd.stdout).trim()}`);
    const now = await ctx.aoeCli.version();
    if (now !== latest) {
      throw new CliError(
        `After "aoe update" the binary reports ${now}, not the tested ${latest}. Run "supercharge aoe upgrade" again to test ${now}.`,
      );
    }
    await addLocalVerified(ctx.paths, latest);
    await writeJsonAtomic(join(ctx.paths.localFixturesDir, latest, 'fixtures.json'), result.fixtures);
    await appendAudit(ctx.paths, {
      actor: 'cli',
      action: 'aoe_upgrade',
      details: { from: current, to: latest, checks: result.checks.length },
    });
    out(`${sym.ok} AoE upgraded to ${latest} and added to the locally verified versions.`);
    out(`  If "aoe serve" still reports the old version, run: aoe serve --restart`);
    out(`  Then restart Supercharge: supercharge restart`);
    return EXIT.ok;
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
