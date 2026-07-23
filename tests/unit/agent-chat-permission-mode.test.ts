/**
 * Unit test for `permissionModeFor` — the Agent Chat view's (task_nQb0y85X) bypass →
 * permission-mode mapping. Pinned identical to the embedded terminal's rule
 * (`agent-terminal.ts:1206`): no bypass → Auto (`acceptEdits`); bypass armed →
 * `bypassPermissions`. There is deliberately no third "manual" mode.
 */
import { describe, it, expect } from 'vitest';
import { permissionModeFor } from '../../src/server/routes/agent-chat.js';

describe('permissionModeFor', () => {
  it('no bypass → acceptEdits (Auto)', () => {
    expect(permissionModeFor(false)).toBe('acceptEdits');
  });

  it('bypass armed → bypassPermissions', () => {
    expect(permissionModeFor(true)).toBe('bypassPermissions');
  });

  it('is a pure function of its single argument (no hidden state across calls)', () => {
    expect(permissionModeFor(false)).toBe('acceptEdits');
    expect(permissionModeFor(true)).toBe('bypassPermissions');
    expect(permissionModeFor(false)).toBe('acceptEdits');
  });
});
