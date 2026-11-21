import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ciGateRefusal, superSessionOnDisk } from '../../src/cli/commands/hook.js';

/** The CI and Super gate of the PreToolUse hook (D6, AC4). */
describe('ciGateRefusal', () => {
  let dir: string;
  let brain: string;
  let outside: string;
  const SUPER = '11111111-2222-4333-8444-555555555555';
  const CHILD = '99999999-2222-4333-8444-555555555555';
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'ci-gate-')));
    outside = realpathSync(mkdtempSync(join(tmpdir(), 'ci-gate-out-')));
    brain = join(dir, '_dream_context');
    mkdirSync(join(brain, 'state', '.super', 'members'), { recursive: true });
    writeFileSync(join(brain, 'state', '.super-agent.json'), JSON.stringify({ session: SUPER }));
    writeFileSync(join(brain, 'state', '.super', 'members', 'doc.json'), JSON.stringify({ session: 'member-session' }));
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });

  it.each(['gh run watch 123', 'gh pr checks --watch', 'while true; do gh run view 1; sleep 30; done'])('in a dreamcontext project or one of our children: %s becomes ci wait; elsewhere it is not ours', (cmd) => {
    expect(ciGateRefusal(cmd, dir, CHILD)).toMatch(/dreamcontext ci wait/);
    // A folder with no brain, not our child: the owner's own session (review r1, mac-wide-hook-scope).
    const prev = process.env.DREAMCONTEXT_CONTEXT_BY;
    delete process.env.DREAMCONTEXT_CONTEXT_BY;
    try {
      expect(ciGateRefusal(cmd, outside, '')).toBeNull();
      process.env.DREAMCONTEXT_CONTEXT_BY = 'super';
      expect(ciGateRefusal(cmd, outside, '')).toMatch(/dreamcontext ci wait/);
    } finally {
      if (prev === undefined) delete process.env.DREAMCONTEXT_CONTEXT_BY; else process.env.DREAMCONTEXT_CONTEXT_BY = prev;
    }
  });

  it('a child may run ci wait; the Super may not', () => {
    expect(ciGateRefusal('dreamcontext ci wait 123', dir, CHILD)).toBeNull();
    expect(ciGateRefusal('dreamcontext ci wait 123', dir, SUPER)).toMatch(/a Super does not wait on CI/);
  });

  it('a member Super is a Super too', () => {
    expect(superSessionOnDisk(brain, 'member-session')).toBe(true);
    expect(ciGateRefusal('dreamcontext shots http://localhost:5173', dir, 'member-session')).toMatch(/run a browser/);
  });

  it('a browser run in the Super is refused, through the lock too; a child\'s is not this gate\'s', () => {
    expect(ciGateRefusal('dreamcontext builder heavy -- node scripts/verify/look.mjs /x', dir, SUPER)).toMatch(/run a browser/);
    expect(ciGateRefusal('dreamcontext shots http://localhost:5173', dir, CHILD)).toBeNull();
  });

  it('ordinary lines pass', () => {
    expect(ciGateRefusal('git status', dir, SUPER)).toBeNull();
    expect(ciGateRefusal('gh run view 5 --json status', dir, SUPER)).toBeNull();
  });
});
