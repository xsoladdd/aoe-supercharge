import { describe, expect, it } from 'vitest';
import { allowedNext, STAGES, transition, type Stage } from '@aoe-supercharge/core/shared';
import type { Actor } from '@aoe-supercharge/core/shared';

const ACTORS: Actor[] = ['worker', 'user', 'control', 'daemon'];
const OK_CTX = { planApproved: true, hasMr: true, question: 'q?' };

/**
 * The full expected edge table (SPEC §7). Anything not listed must be rejected.
 * W = worker/user/control, D = daemon, C = user/control/daemon (closers).
 */
const W = ['worker', 'user', 'control'] as const;
const D = ['daemon'] as const;
const C = ['user', 'control', 'daemon'] as const;
const EXPECTED: Record<Exclude<Stage, 'blocked'>, Partial<Record<Stage, readonly Actor[]>>> = {
  planning: { implementing: W, blocked: W, done: C },
  implementing: { verifying: W, blocked: W, done: C },
  verifying: { implementing: W, mr_raised: W, ready_for_review: W, blocked: W, done: C },
  mr_raised: { watching_mr: D, implementing: W, blocked: W, done: C },
  watching_mr: { ready_for_review: D, implementing: W, blocked: W, done: C },
  ready_for_review: { watching_mr: D, implementing: W, blocked: W, done: C },
  done: {},
};

describe('stage machine: exhaustive (from × to × actor)', () => {
  for (const from of Object.keys(EXPECTED) as (keyof typeof EXPECTED)[]) {
    for (const to of STAGES) {
      for (const actor of ACTORS) {
        const allowed = EXPECTED[from][to]?.includes(actor) ?? false;
        it(`${from} → ${to} by ${actor}: ${allowed ? 'allowed' : 'rejected'}`, () => {
          // Without an MR, a worker may report its branch ready (ready_for_review).
          const ctx = { ...OK_CTX, hasMr: to !== 'ready_for_review' };
          const r = transition({ stage: from, blockedFrom: null }, to, actor, ctx);
          expect(r.ok).toBe(allowed);
        });
      }
    }
  }
});

describe('blocked', () => {
  it('returns to blockedFrom and anything reachable from it', () => {
    const t = { stage: 'blocked' as const, blockedFrom: 'verifying' as const };
    expect(allowedNext(t, 'worker').sort()).toEqual(
      ['implementing', 'mr_raised', 'ready_for_review', 'verifying'].sort(),
    );
    expect(transition(t, 'verifying', 'worker', OK_CTX).ok).toBe(true);
    expect(transition(t, 'mr_raised', 'worker', OK_CTX).ok).toBe(true);
    expect(transition(t, 'done', 'user', OK_CTX).ok).toBe(true);
    expect(transition(t, 'done', 'worker', OK_CTX).ok).toBe(false);
    expect(transition(t, 'ready_for_review', 'worker', OK_CTX).ok).toBe(false);
  });
  it('requires a question', () => {
    const r = transition({ stage: 'implementing', blockedFrom: null }, 'blocked', 'worker', {
      ...OK_CTX,
      question: '',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/supercharge ask/);
  });
});

describe('guards and messages', () => {
  it('planning → implementing needs an approved plan', () => {
    const r = transition({ stage: 'planning', blockedFrom: null }, 'implementing', 'worker', {
      ...OK_CTX,
      planApproved: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/supercharge plan/);
  });
  it('verifying → mr_raised needs an MR', () => {
    const r = transition({ stage: 'verifying', blockedFrom: null }, 'mr_raised', 'worker', {
      ...OK_CTX,
      hasMr: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/--mr <url>/);
  });
  it('explains daemon-only moves', () => {
    const r = transition({ stage: 'watching_mr', blockedFrom: null }, 'ready_for_review', 'worker', OK_CTX);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.daemonOnly).toBe(true);
      expect(r.reason).toMatch(/automatically/);
    }
  });
  it('verifying → ready_for_review: a worker may report its branch ready only without an MR', () => {
    const verifying = { stage: 'verifying' as const, blockedFrom: null };
    expect(transition(verifying, 'ready_for_review', 'worker', { ...OK_CTX, hasMr: false }).ok).toBe(true);
    const r = transition(verifying, 'ready_for_review', 'worker', OK_CTX);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.daemonOnly).toBe(true);
    expect(transition(verifying, 'ready_for_review', 'daemon', { ...OK_CTX, hasMr: false }).ok).toBe(false);
  });
  it('rejects skipping stages and lists what is allowed', () => {
    const r = transition({ stage: 'planning', blockedFrom: null }, 'verifying', 'worker', OK_CTX);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.allowed).toEqual(['implementing', 'blocked']);
  });
  it('done is terminal unless forced', () => {
    expect(transition({ stage: 'done', blockedFrom: null }, 'implementing', 'user', OK_CTX).ok).toBe(false);
    expect(
      transition({ stage: 'done', blockedFrom: null }, 'implementing', 'user', { ...OK_CTX, force: true }).ok,
    ).toBe(true);
  });
});
