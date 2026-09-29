import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

/**
 * `hook subagent-start` end to end: the hook calls `generateSubagentBriefing()`
 * with NO arguments, so the budget it applies is whatever the default resolves
 * to. This pins that the built command's JSON stays under the hard cap on a
 * large brain, and that the one escape hatch (DREAMCONTEXT_SNAPSHOT_BUDGET=off)
 * lifts it. Needs `dist/` (npm run build); the vault is fictional.
 */

const CLI = join(__dirname, '..', '..', 'dist', 'index.js');
const MAX_CHARS = 12_000; // SUBAGENT_BRIEFING_MAX_CHARS

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf-8');
}

function buildLargeVault(project: string): void {
  const ctx = join(project, '_dream_context');
  write(join(ctx, 'core', '0.soul.md'), '---\nname: northwind-atlas\ntype: soul\n---\n\nA fictional route planner.\n');
  for (let i = 1; i <= 60; i++) {
    write(join(ctx, 'knowledge', 'features', `route-feature-${i}.md`),
      `---\nstatus: active\ntags: [routing]\n---\n\n## Why\n\nFictional feature ${i}, described at length so the list is worth demoting.\n`);
  }
  for (let i = 1; i <= 150; i++) {
    const rel = i <= 8 ? `pinned-${i}` : i <= 48 ? `patterns/rule-${i}` : `notes/note-${i}`;
    write(join(ctx, 'knowledge', `${rel}.md`),
      `---\nname: note ${i}\ndescription: Fictional knowledge ${i}, long enough that the full index would blow the budget.\n${i <= 8 ? 'pinned: true\n' : ''}---\n\nBody.\n`);
  }
}

function briefing(cwd: string, home: string, budgetEnv?: string): string {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.DREAMCONTEXT_SNAPSHOT_BUDGET;
  if (budgetEnv !== undefined) env.DREAMCONTEXT_SNAPSHOT_BUDGET = budgetEnv;
  const out = execFileSync('node', [CLI, 'hook', 'subagent-start'], { cwd, env, encoding: 'utf-8', timeout: 30_000 });
  const parsed = JSON.parse(out) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  expect(parsed.hookSpecificOutput.hookEventName).toBe('SubagentStart');
  return parsed.hookSpecificOutput.additionalContext;
}

describe('hook subagent-start budget (integration)', () => {
  let tmp: string;
  let project: string;
  let home: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'dc-briefing-hook-'));
    project = join(tmp, 'project');
    home = join(tmp, 'home');
    mkdirSync(home, { recursive: true });
    buildLargeVault(project);
  });

  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('stays under the hard cap on a large brain with the default budget', () => {
    const text = briefing(project, home);
    expect(text.length).toBeLessThanOrEqual(MAX_CHARS);
    expect(text).toContain('MANDATORY');
    expect(text).toContain('sections demoted to fit the briefing budget');
  });

  it('is unbounded when DREAMCONTEXT_SNAPSHOT_BUDGET=off', () => {
    const text = briefing(project, home, 'off');
    expect(text.length).toBeGreaterThan(MAX_CHARS);
    expect(text).not.toContain('Budget note');
  });
});
