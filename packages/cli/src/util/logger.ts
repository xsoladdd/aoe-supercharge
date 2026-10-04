import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { gzipSync } from 'node:zlib';

export type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Anything that looks like a 64-hex token (ours or AoE's) never reaches a log line. */
const TOKEN_RE = /\b[0-9a-f]{64}\b/g;
const SECRET_KEYS = /token|authorization|cookie|passphrase|secret/i;

export function redact(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(TOKEN_RE, '<redacted>');
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    if (value instanceof Error)
      return { name: value.name, message: redact(value.message), stack: redact(value.stack) };
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SECRET_KEYS.test(k) ? '<redacted>' : redact(v)]),
    );
  }
  return value;
}

export interface LoggerOptions {
  file?: string | null;
  level?: Level;
  maxBytes?: number;
  maxFiles?: number;
  stderr?: boolean;
}

/**
 * Small JSON-lines logger with size-based rotation (daemon.log → daemon.log.1.gz …). Log volume is
 * low (state changes, errors), so synchronous appends keep it simple and crash-safe.
 */
export class Logger {
  private size = 0;
  constructor(
    private opts: LoggerOptions,
    private bindings: Record<string, unknown> = {},
  ) {
    if (opts.file) {
      mkdirSync(dirname(opts.file), { recursive: true });
      this.size = existsSync(opts.file) ? statSync(opts.file).size : 0;
    }
  }

  setLevel(level: Level) {
    this.opts.level = level;
  }

  child(bindings: Record<string, unknown>): Logger {
    const c = new Logger({ ...this.opts, file: null }, { ...this.bindings, ...bindings });
    c.write = this.write.bind(this);
    return c;
  }

  debug(msg: string, fields?: Record<string, unknown>) {
    this.log('debug', msg, fields);
  }
  info(msg: string, fields?: Record<string, unknown>) {
    this.log('info', msg, fields);
  }
  warn(msg: string, fields?: Record<string, unknown>) {
    this.log('warn', msg, fields);
  }
  error(msg: string, fields?: Record<string, unknown>) {
    this.log('error', msg, fields);
  }

  private log(level: Level, msg: string, fields?: Record<string, unknown>) {
    if (ORDER[level] < ORDER[this.opts.level ?? 'info']) return;
    const line = JSON.stringify(
      redact({ time: new Date().toISOString(), level, msg, ...this.bindings, ...(fields ?? {}) }),
    );
    this.write(line);
  }

  private write(line: string) {
    if (this.opts.stderr) process.stderr.write(`${line}\n`);
    const file = this.opts.file;
    if (!file) return;
    try {
      appendFileSync(file, `${line}\n`, { mode: 0o600 });
      this.size += Buffer.byteLength(line) + 1;
      if (this.size > (this.opts.maxBytes ?? 10 * 1024 * 1024)) this.rotate(file);
    } catch {
      // logging must never take the daemon down
    }
  }

  private rotate(file: string) {
    const max = this.opts.maxFiles ?? 5;
    for (let i = max - 1; i >= 1; i--) {
      const from = `${file}.${i}.gz`;
      if (existsSync(from)) {
        if (i + 1 > max) unlinkSync(from);
        else renameSync(from, `${file}.${i + 1}.gz`);
      }
    }
    if (existsSync(`${file}.${max + 1}.gz`)) unlinkSync(`${file}.${max + 1}.gz`);
    writeFileSync(`${file}.1.gz`, gzipSync(readFileSync(file)), { mode: 0o600 });
    writeFileSync(file, '', { mode: 0o600 });
    this.size = 0;
  }
}
