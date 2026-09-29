/**
 * The 12,000-char sub-agent briefing cap is a HARD guarantee, not a ladder hope.
 *
 * The ladder only shrinks demotable sections. The never-shrink blocks (the
 * task-format override, the project line with its linked repos) can overflow
 * the cap on their own; the cap clips them, override first, each with a pointer
 * to where the full text lives. Fixture names are fictional.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { measureSubagentBriefing } from '../../src/cli/commands/snapshot.js';
import { SUBAGENT_BRIEFING_MAX_CHARS } from '../../src/lib/snapshot-budget.js';
import { updateSetupConfig, type LinkedRepo } from '../../src/lib/setup-config.js';

let tmp: string;
let originalHome: string | undefined;

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf-8');
}

/** A small brain whose never-shrink blocks alone are far over the cap. */
function buildOversizedVault(repoCount: number, instructionLines: number): string {
  const project = join(tmp, 'project');
  const context = join(project, '_dream_context');
  write(join(context, 'core', '0.soul.md'),
    '---\nname: harbor-lantern\ntype: soul\n---\n\n## Project Identity\n\nHarbor Lantern is a fictional app used only by this test.\n');
  const instructions = Array.from({ length: instructionLines }, (_, i) =>
    `- Rule ${i + 1}: every task in Harbor Lantern names its dock, its tide window and its lantern colour.`);
  write(join(context, 'overrides', 'task.md'), [
    '---', 'custom_fields:', '  - name: Dock', '    type: text', '    required: true', '---', '',
    '## Task', '', '## Agent Instructions', '', ...instructions, '',
  ].join('\n'));
  mkdirSync(join(context, 'state'), { recursive: true });
  updateSetupConfig(project, {
    linkedRepos: Array.from({ length: repoCount }, (_, i): LinkedRepo => ({
      name: `lantern-service-${String(i + 1).padStart(3, '0')}`,
      gitRemoteUrl: `https://github.com/harbor-lantern-org/lantern-service-${String(i + 1).padStart(3, '0')}.git`,
    })),
  });
  return context;
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'dc-briefing-cap-')));
  originalHome = process.env.HOME;
  process.env.HOME = join(tmp, 'home');
  mkdirSync(process.env.HOME, { recursive: true });
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(tmp, { recursive: true, force: true });
});

describe('the sub-agent briefing hard cap', () => {
  it('stays within 12,000 chars with an oversized override and many linked repos', () => {
    const root = buildOversizedVault(400, 400);
    const unbounded = measureSubagentBriefing({ root, budgetTokens: null });
    // The fixture really is oversized, otherwise this test proves nothing.
    expect(unbounded.text.length).toBeGreaterThan(SUBAGENT_BRIEFING_MAX_CHARS * 2);

    const m = measureSubagentBriefing({ root });

    expect(m.text.length).toBeLessThanOrEqual(SUBAGENT_BRIEFING_MAX_CHARS);
    expect(m.clipped[0]).toBe('task-override');
    expect(m.text).toContain('read `_dream_context/overrides/task.md` for the full text');
    expect(m.text.indexOf('MANDATORY')).toBeLessThan(500);
    expect(m.text).toContain('ACTIVE TASK-FORMAT OVERRIDE:');
  });

  it('clips the override first, and the linked repos only when that is not enough', () => {
    const overrideOnly = measureSubagentBriefing({ root: buildOversizedVault(3, 600) });
    expect(overrideOnly.text.length).toBeLessThanOrEqual(SUBAGENT_BRIEFING_MAX_CHARS);
    expect(overrideOnly.clipped).toEqual(['task-override']);
    expect(overrideOnly.text).toContain('lantern-service-003');

    rmSync(join(tmp, 'project'), { recursive: true, force: true });
    const both = measureSubagentBriefing({ root: buildOversizedVault(600, 600) });
    expect(both.text.length).toBeLessThanOrEqual(SUBAGENT_BRIEFING_MAX_CHARS);
    expect(both.clipped).toContain('project');
    expect(both.text).toContain('`dreamcontext link ls` lists every one');
  });

  it('keeps the awareness rules when it clips', () => {
    const m = measureSubagentBriefing({ root: buildOversizedVault(400, 400) });
    expect(m.text).toContain('## Task Awareness');
    expect(m.text).toContain('dreamcontext tasks create');
  });

  it('leaves an unbounded render (budget switched off) alone', () => {
    const m = measureSubagentBriefing({ root: buildOversizedVault(400, 400), budgetTokens: null });
    expect(m.clipped).toEqual([]);
    expect(m.text.length).toBeGreaterThan(SUBAGENT_BRIEFING_MAX_CHARS);
  });

  it('clips nothing when the briefing already fits', () => {
    const m = measureSubagentBriefing({ root: buildOversizedVault(2, 3) });
    expect(m.clipped).toEqual([]);
  });
});
