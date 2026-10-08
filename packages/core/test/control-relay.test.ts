import { describe, expect, it } from 'vitest';
import {
  callingFor,
  crewWorker,
  relayState,
  relayTarget,
  taskWorker,
  type NeedsYouItem,
  type SessionView,
  type TaskRecord,
} from '../src/shared/index.ts';

const session = (p: Partial<SessionView> & { id: string }) =>
  ({
    title: p.id,
    status: 'idle',
    statusSince: '2026-10-08T10:00:00Z',
    parentId: 'ctrl',
    ...p,
  }) as SessionView;
const task = (p: Partial<TaskRecord> & { id: string }) =>
  ({
    project: 'aoe',
    name: undefined,
    stage: 'implementing',
    aoeSessionId: `s-${p.id}`,
    openQuestion: null,
    history: [],
    ...p,
  }) as TaskRecord;

describe('relayTarget: who a control chat item is about', () => {
  const aldric = taskWorker(
    task({ id: 'AS-0018', name: 'Aldric' }),
    session({ id: 's-AS-0018', title: 'api' }),
  );
  const gareth = taskWorker(
    task({ id: 'AS-0017', name: 'Gareth' }),
    session({ id: 's-AS-0017', title: 'planning kitchen' }),
  );
  const osric = crewWorker(session({ id: 'crew', title: 'hero copy fix' }), 'Osric');
  const team = [aldric, gareth, osric];

  it('goes by the task id in any case, the name as written, and the session title in any case', () => {
    expect(relayTarget('Aldric (AS-0018): which db?', team)).toBe(aldric);
    expect(relayTarget('which db for as-0018?', team)).toBe(aldric);
    expect(relayTarget('Osric wants to push', team)).toBe(osric);
    expect(relayTarget('The Planning Kitchen worker asks', team)).toBe(gareth);
    expect(relayTarget('HERO COPY FIX is blocked', team)).toBe(osric);
  });

  it('only whole words count', () => {
    expect(relayTarget('AS-00181 and Aldrich are someone else', team)).toBeNull();
    expect(relayTarget('aldric, lower case, is a word here', team)).toBeNull();
    // "api" is Aldric's session title, but too common a word to go by.
    expect(relayTarget('Who owns the api keys?', team)).toBeNull();
  });

  it('two workers in one item is ambiguous', () => {
    expect(relayTarget('Aldric (AS-0018) and Gareth (AS-0017) both touch office.ts', team)).toBe('ambiguous');
    // One worker named three ways is still one worker.
    expect(relayTarget('Aldric (AS-0018), on as-0018', team)).toBe(aldric);
  });
});

describe('relayState: open while the worker waits on you, then cleared or the control chat’s own', () => {
  const since = '2026-10-08T10:30:00Z';
  const open = [{ kind: 'question' } as NeedsYouItem];
  const w = (p: Partial<SessionView>) => crewWorker(session({ id: 'crew', ...p }), 'Osric');

  it('is open while the worker has an item, or waits inside the debounce', () => {
    expect(relayState(since, w({}), open)).toBe('open');
    expect(relayState(since, w({ status: 'waiting', statusSince: '2026-10-08T10:20:00Z' }), [])).toBe('open');
  });

  it('is cleared once the worker works again or changed after it was listed', () => {
    expect(relayState(since, w({ status: 'working', statusSince: '2026-10-08T10:00:00Z' }), [])).toBe(
      'cleared',
    );
    expect(relayState(since, w({ status: 'idle', statusSince: '2026-10-08T10:45:00Z' }), [])).toBe('cleared');
  });

  it('is the control chat’s own while the worker sits idle with nothing new: a stall', () => {
    expect(relayState(since, w({ status: 'idle', statusSince: '2026-10-08T10:00:00Z' }), [])).toBe('own');
    expect(relayState(since, w({ status: 'stopped', statusSince: '2026-10-08T10:00:00Z' }), [])).toBe('own');
  });

  it('a done task counts by when it was done', () => {
    const done = (at: string) =>
      taskWorker(
        task({
          id: 'AS-1',
          stage: 'done',
          history: [{ at, from: 'verifying', to: 'done', by: 'daemon', note: null }],
        }),
        session({ id: 's-AS-1', status: 'working' }),
      );
    expect(relayState(since, done('2026-10-08T10:00:00Z'), [])).toBe('own');
    expect(relayState(since, done('2026-10-08T11:00:00Z'), [])).toBe('cleared');
  });
});

describe('callingFor', () => {
  const call = (name: string) => ({ relay: { name, label: name, taskId: null, sessionId: name } });
  it('names one or two workers, and counts more', () => {
    expect(callingFor([call('Aldric'), call('Aldric')])).toBe('Calling for Aldric');
    expect(callingFor([call('Aldric'), call('Gareth')])).toBe('Calling for Aldric and Gareth');
    expect(callingFor([call('Aldric'), call('Gareth'), call('Osric')])).toBe('Calling for 3 workers');
  });
});
