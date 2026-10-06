import { describe, expect, it } from 'vitest';
import { pickWorkerName, WORKER_NAMES, workerLabel, workerName } from '../src/shared/index.ts';

describe('worker names', () => {
  it('are medieval, unique in the list, and include the classics', () => {
    expect(new Set(WORKER_NAMES).size).toBe(WORKER_NAMES.length);
    for (const n of ['Arthur', 'Gareth', 'Godfrey']) expect(WORKER_NAMES).toContain(n);
  });

  it('never repeat within a project, in a stable order per project', () => {
    const taken: string[] = [];
    for (let i = 0; i < WORKER_NAMES.length; i++) taken.push(pickWorkerName(taken, 'charma-base'));
    expect(new Set(taken).size).toBe(WORKER_NAMES.length);
    expect(pickWorkerName([], 'charma-base')).toBe(taken[0]);
    expect(pickWorkerName([], 'koino')).not.toBe(pickWorkerName([], 'charma-base'));
    // Every name used: the next round carries a numeral.
    expect(pickWorkerName(taken, 'charma-base')).toBe(`${taken[0]} II`);
  });

  it('label with the id kept beside the name', () => {
    expect(workerLabel({ id: 'CB-0007', name: 'Gareth' })).toBe('Gareth (CB-0007)');
    expect(workerLabel({ id: 'CB-0007' })).toBe('CB-0007');
    expect(workerName({ id: 'CB-0007', name: 'Gareth' })).toBe('Gareth');
  });
});
