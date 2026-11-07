/**
 * The Super's model map (owner, 2026-11-08): the always-on briefing carries the work → model
 * rows in short, super-orchestration.md §3 holds the detail. Mirror-with-drift-test: the sonnet
 * row (small fix, merge, build, install, chores) must read the same in both.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { modeBriefing } from '../../src/server/chat-modes.js';

const guide = readFileSync('skill/references/super-orchestration.md', 'utf8');
const section3 = guide.slice(guide.indexOf('## 3. Models and effort'), guide.indexOf('## 4. Flow map'));

describe('super model map: briefing and §3 agree', () => {
  const brief = modeBriefing('super', { worktreeAllowed: true });

  it('decides the model for every job, cheapest that fits, never by habit or handoff', () => {
    expect(brief).toContain('decided for EVERY job before you delegate, the cheapest that fits');
    expect(brief).toContain('a habit or a handoff line never sets');
  });

  it('the sonnet and haiku rows name the same work in both', () => {
    expect(brief).toMatch(/small clear fix \(1-3 files[^)]*\), merge, build,\s+install, chores `sonnet` `medium`/);
    expect(section3).toMatch(/merge, build, install, brain chores, a small clear fix \(1-3 files\)[\s\S]*`sonnet` \/ `medium`/);
    expect(section3).toContain('a mechanical edit with an exact spec → `haiku` / `low`');
    expect(brief).toMatch(/exact spec `haiku` `low`/);
  });

  it('other tools get the same rows in their own small/mid/large model', () => {
    expect(brief).toContain("that tool's small, mid, large model");
  });

  it('the handoff never records a fixed model per job kind', () => {
    expect(brief).toContain('never fixes a model per kind of job');
    expect(guide).toContain('never records a fixed model per kind of job');
  });
});
