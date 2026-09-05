import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installAgentForPlatform, applySleepSpecialistOverrides } from '../../src/lib/install-packs.js';
import { emptyManifest, recordFile, writeManifest, readManifest } from '../../src/lib/manifest.js';
import { updateSetupConfig } from '../../src/lib/setup-config.js';
import { agentBaselineSha, readSpecialistFrontmatter } from '../../src/lib/sleep-specialist-frontmatter.js';

/**
 * `applySleepSpecialistOverrides` re-copies from the REAL package agents dir
 * (`findPackageDir('agents')`), which in this repo is `agents/`. The two tests
 * that exercise that path assert against the shipped file rather than a literal,
 * so changing a shipped default cannot silently rot them.
 */
const PACKAGED_SLEEP_TASKS = readSpecialistFrontmatter(
  readFileSync(join(__dirname, '..', '..', 'agents', 'sleep-tasks.md'), 'utf8'),
);

/**
 * A6 end to end: a brain's per-specialist model/effort must survive the install
 * path (which is what `install-skill` / `setup` / `update --core-only` all run),
 * and re-applying one specialist's change must never disturb another's file —
 * least of all one somebody customized by hand.
 */

let root = '';
let pkgAgents = '';

const AGENT = `---
name: sleep-tasks
description: >
  Sleep-cycle specialist that owns task files.
tools: Read, Write, Edit, Bash, Glob, Grep
model: claude-opus-5
effort: medium
skills:
  - dreamcontext
---

# Sleep — Tasks Specialist

Body prose that must never be rewritten by an override.
`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-a6-'));
  mkdirSync(join(root, '_dream_context', 'state'), { recursive: true });
  pkgAgents = mkdtempSync(join(tmpdir(), 'dc-a6-pkg-'));
  writeFileSync(join(pkgAgents, 'sleep-tasks.md'), AGENT);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(pkgAgents, { recursive: true, force: true });
});

const installed = (name = 'sleep-tasks') =>
  readFileSync(join(root, '.claude', 'agents', `${name}.md`), 'utf8');

function install(): { relPath: string; baselineSha: string } {
  return installAgentForPlatform('claude', root, join(pkgAgents, 'sleep-tasks.md'));
}

describe('installAgentForPlatform injects the brain\'s override', () => {
  it('writes the packaged file verbatim when the brain configured nothing', () => {
    install();
    expect(installed()).toBe(AGENT);
  });

  it('injects the configured model and effort', () => {
    updateSetupConfig(root, {
      sleep: { specialists: { 'sleep-tasks': { model: 'claude-haiku-4-5', effort: 'low' } } },
    });
    install();
    const out = installed();
    expect(out).toContain('model: claude-haiku-4-5');
    expect(out).toContain('effort: low');
    expect(out).not.toContain('model: claude-opus-5');
  });

  it('leaves the body byte-identical while injecting', () => {
    updateSetupConfig(root, { sleep: { specialists: { 'sleep-tasks': { model: 'claude-haiku-4-5' } } } });
    install();
    expect(installed()).toContain('Body prose that must never be rewritten by an override.');
  });

  it('survives a RE-install — the packaged default never wins back', () => {
    updateSetupConfig(root, { sleep: { specialists: { 'sleep-tasks': { model: 'claude-haiku-4-5' } } } });
    install();
    install(); // second run == `dreamcontext update --core-only`
    expect(installed()).toContain('model: claude-haiku-4-5');
  });

  it('reports a baselineSha describing the PACKAGE, unchanged by the override', () => {
    const clean = install();
    updateSetupConfig(root, { sleep: { specialists: { 'sleep-tasks': { model: 'claude-haiku-4-5' } } } });
    const overridden = install();
    expect(overridden.baselineSha).toBe(clean.baselineSha);
    expect(clean.baselineSha).toBe(agentBaselineSha(AGENT));
  });

  it('ignores non-specialist agents entirely', () => {
    writeFileSync(join(pkgAgents, 'reviewer.md'), '---\nname: reviewer\nmodel: claude-opus-5\n---\n\n# R\n');
    updateSetupConfig(root, { sleep: { specialists: { 'sleep-tasks': { model: 'claude-haiku-4-5' } } } });
    installAgentForPlatform('claude', root, join(pkgAgents, 'reviewer.md'));
    expect(installed('reviewer')).toContain('model: claude-opus-5');
  });
});

describe('applySleepSpecialistOverrides is scoped to what changed', () => {
  function seedManifest(baselineSha: string): void {
    const m = emptyManifest();
    recordFile(m, '.claude/agents/sleep-tasks.md', '1.0.0', 'agent', { baselineSha });
    writeManifest(root, m);
  }

  it('records the baseline on the manifest entry at install time', () => {
    const { relPath, baselineSha } = install();
    seedManifest(baselineSha);
    expect(readManifest(root)?.files[relPath]?.baselineSha).toBe(baselineSha);
  });

  it('patches a CUSTOMIZED agent\'s frontmatter without touching its body', () => {
    const { baselineSha } = install();
    seedManifest(baselineSha);
    const customized = AGENT.replace('Body prose', 'MY OWN body prose');
    writeFileSync(join(root, '.claude', 'agents', 'sleep-tasks.md'), customized);

    updateSetupConfig(root, { sleep: { specialists: { 'sleep-tasks': { effort: 'high' } } } });
    const res = applySleepSpecialistOverrides(root, ['sleep-tasks']);

    expect(res.updated).toEqual(['.claude/agents/sleep-tasks.md']);
    const out = installed();
    expect(out).toContain('MY OWN body prose');   // customization survived
    expect(out).toContain('effort: high');        // setting applied
  });

  it('clearing an override on a customized agent restores the PACKAGED values', () => {
    const { baselineSha } = install();
    seedManifest(baselineSha);
    writeFileSync(
      join(root, '.claude', 'agents', 'sleep-tasks.md'),
      AGENT.replace('model: claude-opus-5', 'model: claude-haiku-4-5').replace('Body prose', 'MY OWN body prose'),
    );
    applySleepSpecialistOverrides(root, ['sleep-tasks']); // no override configured
    const out = installed();
    expect(out).toContain(`model: ${PACKAGED_SLEEP_TASKS.model}`);  // back to what the package ships
    expect(out).not.toContain('model: claude-haiku-4-5');
    expect(out).toContain('MY OWN body prose');     // still not our file to rewrite
  });

  it('re-copies an UNCUSTOMIZED agent from the package with the new override', () => {
    const { baselineSha } = install();
    seedManifest(baselineSha);
    updateSetupConfig(root, { sleep: { specialists: { 'sleep-tasks': { model: 'claude-sonnet-5' } } } });
    applySleepSpecialistOverrides(root, ['sleep-tasks']);
    expect(installed()).toContain('model: claude-sonnet-5');
  });

  it('never touches a specialist whose own setting did not change', () => {
    writeFileSync(join(pkgAgents, 'sleep-state.md'), AGENT.replace('sleep-tasks', 'sleep-state'));
    install();
    installAgentForPlatform('claude', root, join(pkgAgents, 'sleep-state.md'));
    const before = installed('sleep-tasks');

    updateSetupConfig(root, { sleep: { specialists: { 'sleep-state': { effort: 'high' } } } });
    applySleepSpecialistOverrides(root, ['sleep-state']);

    expect(installed('sleep-tasks')).toBe(before);
  });

  it('skips a specialist that is not installed rather than throwing', () => {
    const res = applySleepSpecialistOverrides(root, ['sleep-learn']);
    expect(res.updated).toEqual([]);
    expect(res.skipped).toEqual(['.claude/agents/sleep-learn.md']);
    expect(existsSync(join(root, '.claude', 'agents', 'sleep-learn.md'))).toBe(false);
  });

  it('is a no-op for an empty change list', () => {
    expect(applySleepSpecialistOverrides(root, [])).toEqual({ updated: [], skipped: [] });
  });
});
