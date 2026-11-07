import { describe, expect, it } from 'vitest';
import { HOOK_SPECS } from '../../src/cli/commands/install-skill.js';
import { directHeavy, heavySuggestion } from '../../src/lib/run-budget.js';

describe('the heavy-step gate', () => {
  it('is installed on Bash', () => {
    expect(HOOK_SPECS.some((h) => h.event === 'PreToolUse' && h.name === 'pre-tool-use' && h.matcher === 'Bash')).toBe(true);
  });
  it('lets ordinary commands through', () => {
    for (const c of ['git status', 'ls -la', 'dreamcontext tasks log s "npm run build green"']) expect(directHeavy(c)).toBeNull();
  });
  // A pipe to tail hides the check's exit code, so that run could never keep a receipt
  // (lib/check-receipt.ts): the gate offers --tail on the check alone (2026-11-07).
  it('offers --tail N instead of a pipe to tail, and leaves anything else as it was', () => {
    expect(heavySuggestion('npx vitest run tests/a.test.ts 2>&1 | tail -40')).toBe("dreamcontext builder heavy --tail 40 -- 'npx vitest run tests/a.test.ts'");
    expect(heavySuggestion('cd app && npx tsc --noEmit | tail -n 5')).toBe("dreamcontext builder heavy --tail 5 -- 'cd app && npx tsc --noEmit'");
    expect(heavySuggestion('npx vitest run | grep FAIL | tail -5')).toBe(`dreamcontext builder heavy -- 'npx vitest run | grep FAIL | tail -5'`);
    expect(heavySuggestion('npx tsc --noEmit; npx vitest run | tail -5')).toBe(`dreamcontext builder heavy -- 'npx tsc --noEmit; npx vitest run | tail -5'`);
    expect(heavySuggestion('npm run build')).toBe("dreamcontext builder heavy -- 'npm run build'");
  });
});
