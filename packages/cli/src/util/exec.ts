import { spawn } from 'node:child_process';

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the binary could not be started (ENOENT, EACCES) or timed out. */
  error: NodeJS.ErrnoException | null;
  timedOut: boolean;
}

export interface RunOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  input?: string;
}

/** Run a binary with an argv array. Never goes through a shell. */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: [opts.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    const timer =
      opts.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            setTimeout(() => child.kill('SIGKILL'), 2000).unref();
          }, opts.timeoutMs)
        : null;
    timer?.unref();
    child.stdout?.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr?.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    const finish = (code: number | null, error: NodeJS.ErrnoException | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, error, timedOut });
    };
    child.on('error', (err: NodeJS.ErrnoException) => finish(null, err));
    child.on('close', (code) => finish(timedOut ? null : code, null));
  });
}

/** Resolve a binary on PATH (like `command -v`). */
export async function which(bin: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (bin.includes('/')) return bin;
  const { access, constants } = await import('node:fs/promises');
  for (const dir of (env.PATH ?? '').split(':').filter(Boolean)) {
    const p = `${dir}/${bin}`;
    try {
      await access(p, constants.X_OK);
      return p;
    } catch {
      // keep looking
    }
  }
  return null;
}
