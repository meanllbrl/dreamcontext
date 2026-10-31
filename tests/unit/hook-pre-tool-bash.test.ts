import { describe, expect, it } from 'vitest';
import { HOOK_SPECS } from '../../src/cli/commands/install-skill.js';
import { directHeavy } from '../../src/lib/run-budget.js';

describe('the heavy-step gate', () => {
  it('is installed on Bash', () => {
    expect(HOOK_SPECS.some((h) => h.event === 'PreToolUse' && h.name === 'pre-tool-use' && h.matcher === 'Bash')).toBe(true);
  });
  it('lets ordinary commands through', () => {
    for (const c of ['git status', 'ls -la', 'dreamcontext tasks log s "npm run build green"']) expect(directHeavy(c)).toBeNull();
  });
});
