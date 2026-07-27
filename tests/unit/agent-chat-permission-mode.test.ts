/**
 * Unit test for `permissionModeFor` — the Agent Chat view's (task_nQb0y85X) bypass →
 * permission-mode mapping. Pinned identical to the embedded terminal's rule
 * (`agent-terminal.ts:209/1148`): no bypass → Auto (`auto`); bypass armed →
 * `bypassPermissions`. There is deliberately no third "manual" mode.
 *
 * The `acceptEdits` assertions below are the regression guard, not pedantry: chat shipped
 * `acceptEdits` while the terminal used `auto`, and on CLI 2.1.220 `acceptEdits` raises a
 * permission prompt for every non-edit command (`npm --version`, `curl`, …) — so the
 * composer's Auto card promised "risky commands still ask" while the session asked about
 * everything. Only `auto` matches the promise.
 */
import { describe, it, expect } from 'vitest';
import { permissionModeFor } from '../../src/server/routes/agent-chat.js';

describe('permissionModeFor', () => {
  it('no bypass → auto (Auto)', () => {
    expect(permissionModeFor(false)).toBe('auto');
  });

  it('never maps Auto to acceptEdits (that mode prompts on every non-edit command)', () => {
    expect(permissionModeFor(false)).not.toBe('acceptEdits');
    expect(permissionModeFor(true)).not.toBe('acceptEdits');
  });

  it('bypass armed → bypassPermissions', () => {
    expect(permissionModeFor(true)).toBe('bypassPermissions');
  });

  it('is a pure function of its single argument (no hidden state across calls)', () => {
    expect(permissionModeFor(false)).toBe('auto');
    expect(permissionModeFor(true)).toBe('bypassPermissions');
    expect(permissionModeFor(false)).toBe('auto');
  });
});
