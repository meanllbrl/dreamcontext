import { describe, it, expect } from 'vitest';
import {
  sleepinessLevel,
  consolidationDepth,
  isDestructiveAllowed,
} from '../../src/lib/sleep-consolidation.js';

/**
 * WS-DEPTH / level unit coverage (issue #9). Pure functions only — no disk.
 */

describe('sleepinessLevel — boundary-exact', () => {
  it.each([
    [3, 'Alert'],
    [4, 'Drowsy'],
    [6, 'Drowsy'],
    [7, 'Sleepy'],
    [9, 'Sleepy'],
    [10, 'Must Sleep'],
  ] as const)('debt %i → %s', (debt, expected) => {
    expect(sleepinessLevel(debt)).toBe(expected);
  });
});

describe('consolidationDepth — debt base', () => {
  it.each([
    [0, 'light'],
    [3, 'light'],
    [4, 'standard'],
    [9, 'standard'],
    [10, 'deep'],
    [50, 'deep'],
  ] as const)('debt %i → %s (source debt)', (debt, depth) => {
    const d = consolidationDepth(debt);
    expect(d.depth).toBe(depth);
    expect(d.source).toBe('debt');
  });
});

describe('consolidationDepth — user override', () => {
  it('userRequestedDeep at low debt forces deep with source user', () => {
    const d = consolidationDepth(0, { userRequestedDeep: true });
    expect(d.depth).toBe('deep');
    expect(d.source).toBe('user');
  });

  it('userRequestedDeep wins over a bump', () => {
    const d = consolidationDepth(0, { userRequestedDeep: true, agentBump: 1 });
    expect(d.depth).toBe('deep');
    expect(d.source).toBe('user');
  });
});

describe('consolidationDepth — agent bump (clamped, monotonic)', () => {
  it('bump 1 raises one tier from the debt base', () => {
    const d = consolidationDepth(0, { agentBump: 1 }); // light -> standard
    expect(d.depth).toBe('standard');
    expect(d.source).toBe('agent');
  });

  it('bump 2 raises two tiers to deep', () => {
    const d = consolidationDepth(0, { agentBump: 2 }); // light -> deep
    expect(d.depth).toBe('deep');
    expect(d.source).toBe('agent');
  });

  it('bump 5 clamps to at most two tiers (deep)', () => {
    const d = consolidationDepth(0, { agentBump: 5 }); // clamps to 2 -> deep
    expect(d.depth).toBe('deep');
  });

  it('negative bump does NOT lower; stays at the debt base', () => {
    const d = consolidationDepth(4, { agentBump: -3 }); // base standard, neutralized
    expect(d.depth).toBe('standard');
    expect(d.source).toBe('debt');
  });

  it('never drops below the debt base even with a negative bump at high debt', () => {
    const d = consolidationDepth(10, { agentBump: -2 }); // base deep
    expect(d.depth).toBe('deep');
  });

  it('bump never exceeds deep at an already-high base', () => {
    const d = consolidationDepth(10, { agentBump: 2 }); // base deep, clamps at deep
    expect(d.depth).toBe('deep');
  });
});

describe('isDestructiveAllowed', () => {
  it('false for null/undefined/light/standard', () => {
    expect(isDestructiveAllowed(null)).toBe(false);
    expect(isDestructiveAllowed(undefined)).toBe(false);
    expect(isDestructiveAllowed('light')).toBe(false);
    expect(isDestructiveAllowed('standard')).toBe(false);
  });

  it('true only for deep', () => {
    expect(isDestructiveAllowed('deep')).toBe(true);
  });
});
