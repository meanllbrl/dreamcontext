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
    expect(heavySuggestion('npx vitest run tests/a.test.ts | grep FAIL | tail -5')).toBe(`dreamcontext builder heavy -- 'npx vitest run tests/a.test.ts | grep FAIL | tail -5'`);
    expect(heavySuggestion('npm run build')).toBe("dreamcontext builder heavy -- 'npm run build'");
  });
  // A full suite starts detached, its command alone (so its exit is its own and its record can
  // be red); while a red record is open, only its files rerun (plan C2, 2026-11-08).
  it('starts a full suite detached, alone, and offers --failed while a red is open', () => {
    expect(heavySuggestion('npx vitest run | grep FAIL | tail -5')).toBe("dreamcontext builder heavy --detach -- 'npx vitest run', then dreamcontext builder heavy --wait <id> (it prints the id)");
    expect(heavySuggestion('npx tsc --noEmit; npm test 2>&1 | tail -5')).toBe("dreamcontext builder heavy --detach -- 'npm test', then dreamcontext builder heavy --wait <id> (it prints the id)");
    expect(heavySuggestion('npm test', { redOpen: true })).toMatch(/^dreamcontext builder test --failed /);
    expect(heavySuggestion('npx tsc --noEmit', { redOpen: true })).toBe("dreamcontext builder heavy -- 'npx tsc --noEmit'");
  });
});
