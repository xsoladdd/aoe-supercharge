import { describe, expect, it } from 'vitest';
import { controlAsks } from '../src/shared/control-asks.ts';

describe('controlAsks: what a control chat says needs you', () => {
  it('reads the numbered items under 🔴 NEEDS YOU and stops at the next section', () => {
    const reply = [
      'All three workers are moving.',
      '',
      '🔴 **NEEDS YOU**',
      '',
      '1. **Logins:** each tester stops and asks you for a login before signing in.',
      '2. **480:** who should I put down as owner?',
      '3. **Disk:** run this whenever you are ready:',
      '   ```bash',
      '   aoe session empty-trash',
      '   ```',
      '',
      '🟡 **WORKING**',
      '- test-web: checking the header',
    ].join('\n');
    expect(controlAsks(reply)).toEqual([
      { text: 'Logins: each tester stops and asks you for a login before signing in.', blocker: false },
      { text: '480: who should I put down as owner?', blocker: false },
      { text: 'Disk: run this whenever you are ready: aoe session empty-trash', blocker: false },
    ]);
  });

  it('takes plain lines too, and marks the ones that block work', () => {
    const reply = [
      '🔴 NEEDS YOU',
      '[auth #1] Magic links or SMS codes for login? This blocks the auth worker.',
      '[auth #2] OK to add a riders table migration? Not blocking.',
      '',
      '✅ DONE',
      'push-fix: token refresh fixed',
    ].join('\n');
    expect(controlAsks(reply)).toEqual([
      { text: '[auth #1] Magic links or SMS codes for login? This blocks the auth worker.', blocker: true },
      { text: '[auth #2] OK to add a riders table migration? Not blocking.', blocker: false },
    ]);
  });

  it('finds the heading as a markdown heading, in any case, and with a subtitle', () => {
    expect(controlAsks('## Needs you\n- Blocker: approve the plan for the API worker')).toEqual([
      { text: 'Blocker: approve the plan for the API worker', blocker: true },
    ]);
    expect(
      controlAsks(
        '**🔴 NEEDS YOU: questions from the testers**\n1. **[web]** May the tester edit the quote?',
      ),
    ).toEqual([{ text: '[web] May the tester edit the quote?', blocker: false }]);
  });

  it('has nothing when there is no NEEDS YOU section, or it says none', () => {
    expect(controlAsks('🟡 WORKING\n- api: building, no blockers')).toEqual([]);
    expect(controlAsks('🔴 NEEDS YOU\nNothing right now.\n\n🟡 WORKING\n- api')).toEqual([]);
    expect(controlAsks('Nothing here needs you yet, the workers are busy.')).toEqual([]);
  });
});
