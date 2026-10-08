import { mkdtemp, readdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pruneContext, readContext, recordContext, resolvePaths } from '../src/node/index.ts';
import { contextInfo, contextWindow, type StatusContext } from '../src/shared/chat.ts';
import { attentionKind, isBlocker } from '../src/shared/control-asks.ts';

const ID = '79bf6bc2-9212-4286-aba0-d0df40f8f766';
/** Claude Code 2.1.285's status line input, as its schema describes it. */
const input = (used: number, extra: Record<string, unknown> = {}) => ({
  session_id: ID,
  model: { id: 'claude-opus-5-5[1m]', display_name: 'Opus 5.5 (1M)' },
  context_window: {
    total_input_tokens: used,
    total_output_tokens: 900,
    context_window_size: 1_000_000,
    current_usage: {
      input_tokens: 10,
      output_tokens: 900,
      cache_creation_input_tokens: 2_000,
      cache_read_input_tokens: used - 2_010,
    },
    used_percentage: Math.round(used / 10_000),
    remaining_percentage: 100 - Math.round(used / 10_000),
  },
  ...extra,
});

describe("Claude Code's context figures, kept per conversation", () => {
  let home: string;
  let paths: ReturnType<typeof resolvePaths>;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'sc-ctx-'));
    paths = resolvePaths({ HOME: home }, home);
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('saves what the status line says, and only for a real session id', async () => {
    const now = new Date('2026-10-08T10:00:00.000Z');
    expect(await recordContext(paths, input(312_000), now)).toBe(true);
    const got = await readContext(paths, ID);
    expect(got?.context).toEqual({
      sessionId: ID,
      at: now.toISOString(),
      model: { id: 'claude-opus-5-5[1m]', name: 'Opus 5.5 (1M)' },
      window: 1_000_000,
      used: 312_000,
      percent: 31,
      current: { input: 10, cacheWrite: 2_000, cacheRead: 309_990, output: 900 },
    });
    expect(await recordContext(paths, input(1, { session_id: '../../etc/passwd' }))).toBe(false);
    expect(await recordContext(paths, { session_id: ID })).toBe(false);
    expect(await readContext(paths, '../x')).toBeNull();
  });

  it('writes again only when the figures change, or a minute on', async () => {
    const t = Date.parse('2026-10-08T10:00:00.000Z');
    await recordContext(paths, input(5_000), new Date(t));
    await recordContext(paths, input(5_000), new Date(t + 10_000));
    expect((await readContext(paths, ID))!.context.at).toBe(new Date(t).toISOString());
    await recordContext(paths, input(6_000), new Date(t + 20_000));
    expect((await readContext(paths, ID))!.context.at).toBe(new Date(t + 20_000).toISOString());
    await recordContext(paths, input(6_000), new Date(t + 90_000));
    expect((await readContext(paths, ID))!.context.at).toBe(new Date(t + 90_000).toISOString());
  });

  it('prunes figures not updated for a week', async () => {
    await recordContext(paths, input(5_000));
    const dir = join(paths.stateDir, 'context');
    const old = new Date(Date.now() - 8 * 86_400_000);
    await utimes(join(dir, `${ID}.json`), old, old);
    expect(await pruneContext(paths)).toBe(1);
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('contextInfo: the figures the meter shows', () => {
  const reply = {
    at: '2026-10-08T10:00:00.000Z',
    usage: { input: 5, cacheWrite: 1_000, cacheRead: 250_000, output: 300 },
  };
  const status = (at: string, extra: Partial<StatusContext> = {}): StatusContext => ({
    sessionId: ID,
    at,
    model: { id: 'claude-opus-5-5[1m]', name: 'Opus 5.5 (1M)' },
    window: 1_000_000,
    used: 251_005,
    percent: 25,
    current: { input: 5, cacheWrite: 1_000, cacheRead: 250_000, output: 300 },
    ...extra,
  });
  const chat = { model: 'claude-opus-5-5', contextTokens: 251_005, lastUsage: reply, compacted: null };

  it("prefers Claude Code's own figures, with the real window", () => {
    const c = contextInfo(chat, status('2026-10-08T10:00:00.400Z'), 500_000)!;
    expect(c).toMatchObject({
      used: 251_005,
      window: 1_000_000,
      percent: 25,
      source: 'claude',
      modelName: 'Opus 5.5 (1M)',
      autoCompactWindow: 500_000,
      compacted: false,
    });
  });

  it('estimates from the transcript when the status line is behind, keeping its window', () => {
    const c = contextInfo(chat, status('2026-10-08T09:59:00.000Z'), null)!;
    expect(c).toMatchObject({ used: 251_005, window: 1_000_000, source: 'estimate', at: reply.at });
    expect(c.lastRequest).toEqual(reply.usage);
  });

  it('without the status line, more than 200k in use means a 1M window', () => {
    expect(contextInfo(chat, null, null)).toMatchObject({
      window: 1_000_000,
      percent: 25,
      source: 'estimate',
    });
    expect(contextWindow('claude-opus-5-5', 150_000)).toBe(200_000);
    expect(contextWindow('claude-opus-5-5', 250_000)).toBe(1_000_000);
    expect(contextWindow('claude-opus-5-5[1m]')).toBe(1_000_000);
  });

  it('after a compaction, shows what it left until the next reply', () => {
    const compacted = { at: '2026-10-08T10:05:00.000Z', tokens: 16_243 };
    const c = contextInfo({ ...chat, compacted }, status('2026-10-08T10:00:00.400Z'), 500_000)!;
    expect(c).toMatchObject({ used: 16_243, source: 'estimate', compacted: true, window: 1_000_000 });
    // The next reply's figures take over again.
    const later = { ...reply, at: '2026-10-08T10:06:00.000Z' };
    expect(
      contextInfo(
        { ...chat, lastUsage: later, compacted },
        status('2026-10-08T10:06:00.300Z', { used: 20_000 }),
        null,
      ),
    ).toMatchObject({ used: 20_000, source: 'claude', compacted: false });
  });

  it('ignores status figures for another model', () => {
    const c = contextInfo({ ...chat, model: 'claude-sonnet-5-5' }, status('2026-10-08T10:00:00.400Z'), null)!;
    expect(c).toMatchObject({ source: 'estimate', window: 1_000_000, modelName: null });
  });

  it('has nothing to show before the first reply', () => {
    expect(
      contextInfo({ model: null, contextTokens: null, lastUsage: null, compacted: null }, null, null),
    ).toBeNull();
  });
});

describe('attentionKind: the report sections the chat colours', () => {
  it('reads NEEDS YOU the way the office does, and WORKING or DONE only as headings', () => {
    expect(attentionKind('🔴 NEEDS YOU')).toBe('needs');
    expect(attentionKind('🔴 **NEEDS YOU**')).toBe('needs');
    expect(attentionKind('**🔴 NEEDS YOU: questions from the testers**')).toBe('needs');
    expect(attentionKind('### Your call')).toBe('needs');
    expect(attentionKind('🟡 WORKING')).toBe('working');
    expect(attentionKind('**🟡 WORKING**')).toBe('working');
    expect(attentionKind('✅ DONE')).toBe('done');
    expect(attentionKind('## Done')).toBe('done');
    expect(attentionKind('Done')).toBeNull();
    expect(attentionKind('Working on the README now.')).toBeNull();
    expect(attentionKind('All three workers are moving.')).toBeNull();
  });

  it('tells a blocker from "not blocking"', () => {
    expect(isBlocker('Aldric (AS-0018): wants to push to main. Blocked.')).toBe(true);
    expect(isBlocker('Gisela (AS-0022): a question, not blocking.')).toBe(false);
  });
});
