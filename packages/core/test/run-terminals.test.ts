import { describe, expect, it } from 'vitest';
import { CONTROL_SHELL_INDEX, MAX_TERMINAL_INDEX, pickTerminalIndex } from '../src/shared/run-terminals.ts';

describe('pickTerminalIndex: which AoE terminal a Run in a new terminal gets', () => {
  it('counts down from below the Shell tab, out of the way of the tabs AoE numbers up from 1', () => {
    expect(CONTROL_SHELL_INDEX).toBe(MAX_TERMINAL_INDEX);
    expect(pickTerminalIndex([])).toBe(30);
    expect(pickTerminalIndex([30])).toBe(29);
    expect(pickTerminalIndex([30, 28])).toBe(29);
  });

  it('never hands out the session’s own terminal or the Shell tab’s, and says when all are taken', () => {
    const all = Array.from({ length: 30 }, (_, i) => i + 1);
    expect(pickTerminalIndex(all)).toBeNull();
    expect(pickTerminalIndex(all.filter((i) => i !== 1))).toBe(1);
    expect(pickTerminalIndex([])).not.toBe(0);
    expect(pickTerminalIndex([])).not.toBe(CONTROL_SHELL_INDEX);
  });
});
