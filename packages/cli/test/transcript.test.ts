import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatBlock } from '@aoe-supercharge/core/shared';
import { FakeTranscript, seedControlChat } from '../../fake-aoe/src/transcript.ts';
import type { AoeCli } from '../src/aoe/cli.ts';
import { encodeProjectDir, TranscriptParser, TranscriptStore } from '../src/transcript.ts';

const line = (o: Record<string, unknown>) => JSON.stringify(o);
const user = (content: unknown, extra: Record<string, unknown> = {}) =>
  line({
    type: 'user',
    uuid: `u-${Math.random()}`,
    timestamp: '2026-10-01T10:00:00.000Z',
    message: { role: 'user', content },
    ...extra,
  });
const assistant = (id: string, block: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  line({
    type: 'assistant',
    uuid: `a-${Math.random()}`,
    timestamp: '2026-10-01T10:00:01.000Z',
    message: { id, role: 'assistant', content: [block] },
    ...extra,
  });
const tools = (blocks: ChatBlock[]) =>
  blocks.filter((b): b is Extract<ChatBlock, { kind: 'tool' }> => b.kind === 'tool');

describe('TranscriptParser: Claude Code JSONL → chat messages', () => {
  it('keeps typed prompts and drops command echoes, meta, sidechains and non-human turns', () => {
    const p = new TranscriptParser();
    for (const l of [
      line({ type: 'ai-title', aiTitle: 'Launch plan' }),
      user('Plan the launch', { origin: { kind: 'human' } }),
      user('<command-name>/clear</command-name>'),
      user('<system-reminder>be nice</system-reminder>'),
      user('Caveat: hidden', { isMeta: true }),
      user('subagent prompt', { isSidechain: true }),
      user('queued by a hook', { origin: { kind: 'hook' } }),
      user([
        { type: 'text', text: 'pasted text' },
        { type: 'image', source: {} },
      ]),
      '{not json',
    ])
      p.push(l);
    expect(p.title).toBe('Launch plan');
    expect(p.messages.map((m) => [m.role, m.blocks[0]])).toEqual([
      ['user', { kind: 'text', text: 'Plan the launch' }],
      ['user', { kind: 'text', text: 'pasted text\n\n*(image)*' }],
    ]);
  });

  it('merges split assistant records, skips thinking, and attaches tool results by id', () => {
    const p = new TranscriptParser();
    p.push(assistant('msg_1', { type: 'thinking', thinking: 'secret' }));
    p.push(assistant('msg_1', { type: 'text', text: 'Looking.' }));
    p.push(
      assistant('msg_1', { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls -la' } }),
    );
    p.push(
      assistant('msg_1', { type: 'tool_use', id: 'toolu_2', name: 'Read', input: { file_path: '/r/a.ts' } }),
    );
    p.push(user([{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a.ts\nb.ts' }]));
    p.push(
      user([
        {
          type: 'tool_result',
          tool_use_id: 'toolu_2',
          content: [{ type: 'text', text: 'boom' }],
          is_error: true,
        },
      ]),
    );
    p.push(assistant('msg_2', { type: 'text', text: 'Done.' }));
    expect(p.messages).toHaveLength(2);
    const [first, second] = p.messages;
    expect(first!.blocks[0]).toEqual({ kind: 'text', text: 'Looking.' });
    expect(tools(first!.blocks)).toMatchObject([
      { name: 'Bash', summary: 'ls -la', result: 'a.ts\nb.ts', isError: false },
      { name: 'Read', summary: '/r/a.ts', result: 'boom', isError: true },
    ]);
    expect(JSON.stringify(p.messages)).not.toContain('secret');
    expect(second!.blocks).toEqual([{ kind: 'text', text: 'Done.' }]);
  });

  it('tracks the model and effort from replies and from /model, /effort', () => {
    const p = new TranscriptParser();
    p.push(
      assistant(
        'msg_1',
        { type: 'text', text: 'Hi' },
        {
          effort: 'high',
          message: {
            id: 'msg_1',
            role: 'assistant',
            model: 'claude-opus-5',
            content: [{ type: 'text', text: 'Hi' }],
          },
        },
      ),
    );
    expect([p.model, p.effort]).toEqual(['claude-opus-5', 'high']);
    p.push(
      user(
        '<local-command-stdout>Set model to `claude-sonnet-5-5` and saved as your default for new sessions</local-command-stdout>',
      ),
    );
    p.push(
      user(
        '<local-command-stdout>Set effort level to max (this session only): deepest reasoning</local-command-stdout>',
      ),
    );
    expect([p.model, p.effort]).toEqual(['claude-sonnet-5-5', 'max']);
    p.push(user('<local-command-stdout>Effort level set to auto</local-command-stdout>'));
    expect(p.effort).toBeNull();
    expect(p.messages.filter((m) => m.role === 'user')).toHaveLength(0);
  });

  it('leaves a tool without a result as pending', () => {
    const p = new TranscriptParser();
    p.push(
      assistant('msg_1', { type: 'tool_use', id: 'toolu_9', name: 'Bash', input: { command: 'npm test' } }),
    );
    expect(tools(p.messages[0]!.blocks)[0]).toMatchObject({ result: null, isError: false });
  });
});

describe('TranscriptStore: finds and incrementally reads a session transcript', () => {
  let dir: string;
  let claudeDir: string;
  let hooksDir: string;
  const cwd = '/work/northwind web';
  const noCli = { agentSessionId: async () => null } as unknown as AoeCli;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sc-transcript-'));
    claudeDir = join(dir, '.claude');
    hooksDir = join(dir, 'hooks');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('encodes the project folder like Claude Code', () => {
    expect(encodeProjectDir('/Users/me/Dev/my_app.v2')).toBe('-Users-me-Dev-my-app-v2');
  });

  it('is empty until AoE knows the Claude session, then reads it through the hook file', async () => {
    const store = new TranscriptStore(claudeDir, hooksDir, noCli);
    expect((await store.read('aoe1', cwd)).state).toBe('empty');
    const t = new FakeTranscript({ claudeDir, hooksDir }, 'aoe1', cwd);
    seedControlChat(t, cwd);
    const chat = await store.read('aoe1', cwd);
    expect(chat.state).toBe('ok');
    expect(chat.title).toBe('Northwind launch plan');
    expect(chat.messages[0]).toMatchObject({
      role: 'user',
      blocks: [{ kind: 'text', text: expect.stringMatching(/^Plan the launch/) }],
    });
    expect(chat.messages.flatMap((m) => tools(m.blocks)).every((b) => b.result !== null)).toBe(true);
    expect(chat.version).toMatch(new RegExp(`^${t.claudeId}:\\d+$`));
  });

  it('only parses what was appended, and starts over when the file shrinks', async () => {
    const store = new TranscriptStore(claudeDir, hooksDir, noCli);
    const t = new FakeTranscript({ claudeDir, hooksDir }, 'aoe1', cwd);
    t.user('first');
    const a = await store.read('aoe1', cwd);
    expect((await store.read('aoe1', cwd)).version).toBe(a.version);
    t.assistant({ type: 'text', text: 'second' });
    const b = await store.read('aoe1', cwd);
    expect(b.version).not.toBe(a.version);
    expect(b.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    await truncate(t.file, 0);
    t.user('fresh');
    const c = await store.read('aoe1', cwd);
    expect(c.messages.map((m) => (m.blocks[0] as { text: string }).text)).toEqual(['fresh']);
  });

  it('follows /clear at once through the per-launch hook file AoE 1.17 writes', async () => {
    const store = new TranscriptStore(claudeDir, hooksDir, noCli);
    const before = new FakeTranscript({ claudeDir, hooksDir }, 'aoe3', cwd);
    before.user('old conversation');
    expect((await store.read('aoe3', cwd)).messages).toHaveLength(1);
    // /clear: Claude starts a new conversation and AoE writes its id under the launch's own name.
    const after = new FakeTranscript({ claudeDir, hooksDir: join(dir, 'scratch') }, 'aoe3', cwd);
    after.user('fresh start');
    const launch = '0b6cdb1e-2c5a-4f0e-9b7a-6a4f6d3c9e21';
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(join(hooksDir, 'aoe3', `session_id.${launch}`), after.claudeId);
    const chat = await store.read('aoe3', cwd);
    expect(chat.messages.map((m) => (m.blocks[0] as { text: string }).text)).toEqual(['fresh start']);
  });

  it('falls back to `aoe session show` and to scanning other project folders', async () => {
    const elsewhere = new FakeTranscript(
      { claudeDir, hooksDir: join(dir, 'unused') },
      'aoe2',
      '/somewhere/else',
    );
    elsewhere.user('from another folder');
    const cli = {
      agentSessionId: async (id: string) => (id === 'aoe2' ? elsewhere.claudeId : null),
    } as unknown as AoeCli;
    const chat = await new TranscriptStore(claudeDir, hooksDir, cli).read('aoe2', cwd);
    expect(chat.state).toBe('ok');
    expect(chat.messages[0]?.blocks[0]).toEqual({ kind: 'text', text: 'from another folder' });
  });
});
