import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CharState, HistoryRecord } from '../packages/core/src/shared/index.ts';

/**
 * A made-up day of office history (SPEC §14.5), so history mode and "Since I was away" have something
 * to show without real agents. Three past workers who have all left by now: one finished after its MR
 * passed, one's pipeline failed, one asked a question and then finished. Every name, MR and number is
 * invented.
 */
export function seedHistory(stateDir: string, now = Date.now()): void {
  const dir = join(stateDir, 'history');
  mkdirSync(dir, { recursive: true });
  const ago = (h: number) => new Date(now - h * 60 * 60 * 1000).toISOString();
  const mrUrl = (repo: string, iid: number) => `https://gitlab.example.com/${repo}/-/merge_requests/${iid}`;
  const base = (key: string, name: string, desk: number): CharState => {
    const [project, taskId] = key.split('/') as [string, string];
    return {
      key,
      sessionId: `seed-${taskId.toLowerCase()}`,
      parentId: null,
      project,
      taskId,
      worktree: `sc/${taskId.toLowerCase()}`,
      name,
      role: 'worker',
      desk,
      zone: 'desk',
      reason: 'Implementing',
      prop: null,
      stage: 'implementing',
      cost: { tokens: 0, usd: 0 },
      mr: null,
    };
  };
  const percival = base('northwind-web/NW-0090', 'Percival', 6);
  const isolde = base('apollo-api/AA-0090', 'Isolde', 3);
  const tristan = base('northwind-web/NW-0091', 'Tristan', 7);
  const records: HistoryRecord[] = [];
  const frame = (h: number, chars: CharState[]) => records.push({ v: 1, type: 'frame', ts: ago(h), chars });
  const move = (h: number, c: CharState, from: CharState['zone'] | null, change: Partial<CharState>) => {
    const next = { ...c, ...change };
    records.push({ v: 1, type: 'move', ts: ago(h), from, ...next });
    return next;
  };

  let p: CharState = { ...percival, cost: { tokens: 400_000, usd: 0.3 } };
  frame(7, [p]);
  p = move(6.5, p, 'desk', { stage: 'verifying', reason: 'Verifying', cost: { tokens: 900_000, usd: 0.7 } });
  p = move(5.5, p, 'desk', {
    zone: 'review',
    stage: 'mr_raised',
    reason: 'Waiting on the pipeline',
    prop: 'folder_amber',
    mr: { iid: 31, url: mrUrl('northwind/web', 31), state: 'opened', pipeline: 'running', threads: 0 },
    cost: { tokens: 1_400_000, usd: 1.1 },
  });
  p = move(4, p, 'review', {
    stage: 'ready_for_review',
    reason: 'Ready for review',
    prop: 'folder',
    mr: { ...p.mr!, pipeline: 'success' },
  });
  move(3, p, 'review', {
    zone: 'gone',
    stage: 'done',
    reason: 'Done',
    cost: { tokens: 2_100_000, usd: 1.8 },
  });

  let i: CharState = move(5, isolde, null, {
    stage: 'planning',
    reason: 'Planning',
    cost: { tokens: 60_000, usd: 0.05 },
  });
  i = move(4.5, i, 'desk', {
    stage: 'implementing',
    reason: 'Implementing',
    cost: { tokens: 700_000, usd: 0.6 },
  });
  i = move(2, i, 'desk', {
    zone: 'review',
    stage: 'mr_raised',
    reason: 'Waiting on the pipeline',
    prop: 'folder_amber',
    mr: { iid: 11, url: mrUrl('apollo/api', 11), state: 'opened', pipeline: 'running', threads: 0 },
    cost: { tokens: 2_900_000, usd: 2.4 },
  });
  i = move(1.5, i, 'review', {
    stage: 'watching_mr',
    reason: 'Pipeline failed',
    prop: 'folder_red',
    mr: { ...i.mr!, pipeline: 'failed' },
  });
  move(0.8, i, 'review', { zone: 'gone', reason: 'Left' });

  let t: CharState = move(4.2, tristan, null, { cost: { tokens: 100_000, usd: 0.1 } });
  t = move(4, t, 'desk', { zone: 'door', reason: 'Question', prop: 'speech' });
  t = move(3.75, t, 'door', {
    zone: 'desk',
    reason: 'Implementing',
    prop: null,
    cost: { tokens: 600_000, usd: 0.5 },
  });
  t = move(2, t, 'desk', { zone: 'pantry', reason: 'Idle', prop: 'mug' });
  move(1.2, t, 'pantry', {
    zone: 'gone',
    stage: 'done',
    reason: 'Done',
    cost: { tokens: 1_200_000, usd: 0.95 },
  });

  records.sort((a, b) => a.ts.localeCompare(b.ts));
  for (const r of records) appendFileSync(join(dir, `${r.ts.slice(0, 10)}.jsonl`), `${JSON.stringify(r)}\n`);
}
