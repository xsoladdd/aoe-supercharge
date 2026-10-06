/**
 * `npm run demo -- --live`: keeps the demo's workers busy, so the office floor and the lists move the
 * way they do with real agents. Every few seconds one worker does the next believable thing: works,
 * takes a break, asks for permission or asks a question, moves to the next stage, raises an MR whose
 * pipeline runs, gets merged and leaves. New workers join now and then. What waits on you waits a
 * minute for your answer in the dashboard, then answers itself so the floor keeps moving.
 *
 * Demo only: it drives the in-process fake AoE and the real CLI against the demo's temp dir.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TaskRecord } from '../packages/core/src/shared/types.ts';
import { ASK_MENU, PERMISSION_MENU, type FakeSession } from '../packages/fake-aoe/src/server.ts';
import { mrJson, sc, unresolved, type Demo } from '../e2e/harness.ts';

const TICK_MS = 3_000;
/** Something waiting on you answers itself after this. */
const ANSWER_AFTER_MS = 60_000;
const ARRIVE_EVERY_MS = 45_000;
const MAX_WORKERS = 8;

const NEW_WORK: Record<string, [string, string][]> = {
  'northwind-web': [
    ['Cookie banner copy', 'Swap the placeholder cookie banner text for the approved copy.'],
    ['Lazy-load the hero images', 'Hero images on listing pages load lazily with proper sizes.'],
    ['404 page', 'A branded 404 page with search and links back to the main sections.'],
    ['Footer links audit', 'Check every footer link; fix or remove the broken ones.'],
  ],
  'apollo-api': [
    ['Pagination on /orders', 'Cursor pagination with a 100-item cap and a next link.'],
    ['Health check endpoint', 'GET /healthz reporting database and queue status.'],
    ['Retry webhook deliveries', 'Exponential backoff, five tries, then the dead-letter queue.'],
    ['Drop the v1 auth shim', 'Remove the v1 token shim now that every client is on v2.'],
  ],
};
const MR_REPO: Record<string, string> = { 'northwind-web': 'northwind/web', 'apollo-api': 'apollo/api' };
const PROJECT_DIR: Record<string, string> = { 'northwind-web': 'northwind-web', 'apollo-api': 'apollo-api' };

const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)]!;
const chance = (p: number) => Math.random() < p;

export function startLife(demo: Demo): () => void {
  const { fake, env, dir } = demo;
  const glab = join(dir, 'glab');
  /** When each session started waiting on you, to answer for you after a while. */
  const waitingSince = new Map<string, number>();
  /** Sessions this simulation put a menu in front of: a closed menu there means you answered. */
  const asked = new Set<string>();
  /** What was last written for each MR, so the next step waits until the MR watcher has seen it. */
  const mrSent = new Map<number, string>();
  let nextMr = 200;
  let lastArrival = Date.now();
  let busy = false;

  const log = (msg: string) => process.stdout.write(`  ${new Date().toLocaleTimeString()}  ${msg}\n`);
  const session = (id: string) => fake.state.sessions.find((s) => s.id === id);
  const set = (s: FakeSession, status: FakeSession['status'], extra: Partial<FakeSession> = {}) => {
    Object.assign(s, { status, ...extra });
    if (status === 'Idle') s.idle_entered_at = new Date().toISOString();
  };
  const as = (t: TaskRecord, args: string[], input?: string) =>
    sc(env, args, t.worktreePath, { AOE_INSTANCE_ID: t.aoeSessionId }, input);
  const tasks = async () => JSON.parse(await sc(env, ['task', 'list', '--json'], dir)) as TaskRecord[];
  const transcript = (s: FakeSession) => fake.transcripts!.for(s.id, s.project_path);

  const writeMr = (t: TaskRecord, iid: number, state: string, pipeline: string | null, mergeable = false) => {
    const repo = MR_REPO[t.project] ?? 'demo/repo';
    writeFileSync(
      join(glab, `mr-${iid}.json`),
      mrJson(iid, repo, state, pipeline, mergeable ? { detailed_merge_status: 'mergeable' } : {}),
    );
    writeFileSync(join(glab, `discussions-${iid}.json`), unresolved(0));
    mrSent.set(iid, `${state}:${pipeline}`);
  };

  /** Asks you something: Claude's own question, or a command that needs your permission. */
  const askYou = (t: TaskRecord, s: FakeSession) => {
    if (chance(0.5)) {
      transcript(s).assistant(
        { type: 'text', text: 'Running the checks for this change before I go on.' },
        { type: 'tool_use', name: 'Bash', input: { command: 'npm run test -- --run', description: 'Tests' } },
      );
      set(s, 'Waiting', { menu: PERMISSION_MENU });
      log(`${t.name} (${t.id}) needs permission to run the tests`);
    } else {
      transcript(s).assistant({
        type: 'tool_use',
        name: 'AskUserQuestion',
        input: {
          questions: [
            {
              question: 'Which browsers should the QA pass cover?',
              header: 'Browsers',
              multiSelect: true,
              options: [{ label: 'Chrome' }, { label: 'Safari' }, { label: 'Firefox' }],
            },
          ],
        },
      });
      set(s, 'Waiting', { menu: ASK_MENU });
      log(`${t.name} (${t.id}) has a question for you`);
    }
    waitingSince.set(s.id, Date.now());
    asked.add(s.id);
  };

  /** The next believable step for one worker. */
  const step = async (t: TaskRecord, s: FakeSession) => {
    // Waiting on you: once you answered (the menu closed), back to work; else answer it after a while.
    if (s.status === 'Waiting') {
      const since = waitingSince.get(s.id) ?? Date.now();
      waitingSince.set(s.id, since);
      const answered = asked.has(s.id) && !s.menu;
      if (!answered && Date.now() - since < ANSWER_AFTER_MS) return;
      const tr = transcript(s);
      for (const id of [...tr.pending]) tr.result(id, 'Done.');
      set(s, 'Running', { menu: null });
      waitingSince.delete(s.id);
      asked.delete(s.id);
      log(`${t.name} (${t.id}) ${answered ? 'got your answer' : 'was answered for you'} and is back at work`);
      return;
    }
    if (t.stage === 'blocked') {
      if (t.openQuestion?.answeredAt) {
        await as(t, ['stage', t.blockedFrom ?? 'implementing']);
        set(s, 'Running');
        log(`${t.name} (${t.id}) read your reply and is back at work`);
      } else if (t.openQuestion && Date.now() - Date.parse(t.openQuestion.askedAt) > ANSWER_AFTER_MS) {
        await sc(env, ['reply', t.id, pick(t.openQuestion.options ?? ['Go ahead']), '--yes'], dir);
        set(s, 'Idle');
        log(`${t.name} (${t.id}): answered its question for you`);
      }
      return;
    }
    if (['mr_raised', 'watching_mr', 'ready_for_review'].includes(t.stage)) {
      const iid = t.mr?.iid;
      if (!iid) return;
      const sent = mrSent.get(iid);
      if (sent && sent !== `${t.mr?.state}:${t.mr?.pipeline}`) return;
      if (s.status !== 'Idle') set(s, 'Idle');
      if (t.mr?.pipeline === 'failed') {
        writeMr(t, iid, 'opened', 'running');
        log(`${t.name} (${t.id}) pushed a fix; MR !${iid}'s pipeline runs again`);
      } else if (t.mr?.pipeline !== 'success') {
        writeMr(t, iid, 'opened', chance(0.8) ? 'success' : 'failed', true);
        log(`${t.name} (${t.id}): MR !${iid}'s pipeline finished`);
      } else if (t.stage === 'ready_for_review' || chance(0.4)) {
        writeMr(t, iid, 'merged', 'success', true);
        log(`${t.name} (${t.id}): MR !${iid} merged, so the task is done`);
      }
      return;
    }
    if (s.status === 'Idle' || s.status === 'Stopped') {
      set(s, 'Running');
      log(`${t.name} (${t.id}) is back at the desk`);
      return;
    }
    // Working.
    if (t.stage === 'planning') {
      if (chance(0.25)) return askYou(t, s);
      if (chance(0.5)) {
        await as(
          t,
          ['plan', '-'],
          `# Plan: ${t.title}\n\n1. Read the code around it\n2. Make the change\n3. Test it\n`,
        );
        await as(t, ['stage', 'implementing']);
        log(`${t.name} (${t.id}) wrote a plan and started implementing`);
      }
      return;
    }
    if (t.stage === 'implementing') {
      const roll = Math.random();
      if (roll < 0.25) {
        set(s, 'Idle');
        log(`${t.name} (${t.id}) is taking a break`);
      } else if (roll < 0.45) askYou(t, s);
      else if (roll < 0.55) {
        await as(t, [
          'ask',
          'Should the old behaviour stay behind a flag for one release?',
          '--option',
          'Yes, keep a flag',
          '--option',
          'No, remove it',
        ]);
        set(s, 'Idle');
        log(`${t.name} (${t.id}) is blocked on a question for you`);
      } else if (roll < 0.85) {
        await as(t, ['stage', 'verifying']);
        log(`${t.name} (${t.id}) is verifying`);
      }
      return;
    }
    if (t.stage === 'verifying') {
      if (chance(0.2)) {
        await as(t, ['stage', 'implementing', '--note', 'A test failed; fixing it']);
        log(`${t.name} (${t.id}) found a failing test and went back to implementing`);
      } else if (chance(0.6)) {
        const iid = nextMr++;
        writeMr(t, iid, 'opened', 'running');
        await as(t, [
          'stage',
          'mr_raised',
          '--mr',
          `https://gitlab.example.com/${MR_REPO[t.project] ?? 'demo/repo'}/-/merge_requests/${iid}`,
        ]);
        set(s, 'Idle');
        log(`${t.name} (${t.id}) raised MR !${iid}; its pipeline is running`);
      }
    }
  };

  const arrive = async (all: TaskRecord[]) => {
    const active = all.filter((t) => t.stage !== 'done');
    if (active.length >= MAX_WORKERS) return;
    const project = pick(Object.keys(NEW_WORK));
    // A title comes back once its task is done, so new workers keep arriving.
    const taken = new Set(active.map((t) => t.title));
    const free = NEW_WORK[project]!.filter(([title]) => !taken.has(title));
    if (!free.length) return;
    const [title, brief] = pick(free);
    const out = JSON.parse(
      await sc(
        env,
        ['task', 'new', title, '--brief', brief, '--force', '--json'],
        join(dir, 'code', PROJECT_DIR[project]!),
      ),
    ) as { id: string; name: string; aoeSessionId: string };
    const s = session(out.aoeSessionId);
    if (s) set(s, 'Running');
    log(`${out.name} (${out.id}) joined ${project}: ${title}`);
  };

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const all = await tasks();
      if (Date.now() - lastArrival > ARRIVE_EVERY_MS) {
        lastArrival = Date.now();
        await arrive(all);
      }
      // Anyone you answered goes straight back to work; then one other worker takes a step.
      const live = all
        .map((t) => ({ t, s: session(t.aoeSessionId) }))
        .filter(
          (x): x is { t: TaskRecord; s: FakeSession } => !!x.s && x.t.stage !== 'done' && !x.s.archived_at,
        );
      for (const x of live.filter((x) => asked.has(x.s.id) && !x.s.menu)) await step(x.t, x.s);
      if (live.length) {
        const x = pick(live);
        await step(x.t, x.s);
      }
    } catch (err) {
      log(`(skipped a step: ${(err as Error).message.split('\n')[0]})`);
    } finally {
      busy = false;
    }
  };

  // MR changes show within seconds instead of a minute.
  void sc(env, ['config', 'set', 'poll.mr', '10'], dir);
  const timer = setInterval(() => void tick(), TICK_MS);
  log('Live: workers change status every few seconds. Ctrl+C stops the demo.');
  return () => clearInterval(timer);
}
