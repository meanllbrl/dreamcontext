/**
 * Claude's headless argv, byte for byte (Track T W4). The fixture was produced from the commit
 * before W4 (4afcd4c0) by this same file with UPDATE_GOLDEN=1: adding Codex to a surface must not
 * move a single argument of its Claude run. The home is fixed at /home/fixture (see the mock
 * below); the fixture's credential denies were rewritten to it once, nothing else moved.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// The light run denies Read on the credential folders of THIS machine's home, so the argv
// carries the home path. The golden is about the argv, not about who runs it: every machine
// (a Mac, the Linux CI runner) answers the same fixed home, so the bytes compare exactly.
vi.mock('node:os', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:os')>();
  return { ...real, homedir: () => '/home/fixture' };
});
import { buildClaudeArgs, buildContinueArgs } from '../../src/lib/automations/runner.js';
import { buildResumeArgs } from '../../src/lib/automations/verdict.js';
import { canonicalApprovalPayload } from '../../src/lib/automations/registry.js';
import type { AutomationManifest } from '../../src/lib/automations/types.js';

const FIXTURE = join(__dirname, '..', 'fixtures', 'headless-claude-golden', 'argv.json');

const manifest = (over: Partial<AutomationManifest> = {}): AutomationManifest => ({
  slug: 'digest', title: 'Digest', prompt: 'Write the digest.', outputInstructions: '', model: 'opus', effort: 'high',
  timeoutMinutes: 30, outputDir: null, learning: false, review: 'off', mode: 'sched', flow: null, whiteboard: null, job: '',
  soul: '', ...over,
} as AutomationManifest);

function cases(): Record<string, unknown> {
  const m = manifest();
  const bare = manifest({ model: null, effort: null });
  const scope = ['--permission-mode', 'default', '--allowedTools', 'Read'];
  return {
    plain: buildClaudeArgs(m, 'go'),
    bare: buildClaudeArgs(bare, 'go'),
    scoped: buildClaudeArgs(m, 'go', scope),
    override: buildClaudeArgs(m, 'go', null, { model: 'sonnet', effort: 'low' } as never),
    light: buildClaudeArgs(m, 'go', null, { light: true } as never),
    continued: buildContinueArgs(m, 'sess-1'),
    resumed: buildResumeArgs(m, 'sess-1', 'again'),
    hash: canonicalApprovalPayload(m),
    hashBare: canonicalApprovalPayload(bare),
  };
}

describe('Claude headless argv', () => {
  it('is byte-identical to the pre-W4 golden', () => {
    const now = JSON.stringify(cases(), null, 2);
    if (process.env.UPDATE_GOLDEN === '1') { writeFileSync(FIXTURE, `${now}\n`); return; }
    expect(now).toBe(readFileSync(FIXTURE, 'utf-8').trimEnd());
  });
});
