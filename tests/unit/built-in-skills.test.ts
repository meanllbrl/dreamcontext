/**
 * council, multi-review, goal-skill and video-watching ship as guarded core skills (2026-11-11): every
 * install and update brings them, an edited copy is kept, and their agents ship from agents/. A user's
 * own unrecorded agent by one of those names is never overwritten.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { adoptedAgentRefusal, installCoreForPlatform } from '../../src/cli/commands/install-skill.js';
import { emptyManifest, recordFile, writeManifest } from '../../src/lib/manifest.js';
import { agentBaselineSha } from '../../src/lib/sleep-specialist-frontmatter.js';
import { GUARDED_SKILLS, guardedFileSha, installGuardedSpec } from '../../src/lib/core-guarded-skill.js';
import { ADOPTED_AGENT_SHAS } from '../../src/lib/core-guarded-skill/adopted-agents.js';
import { TOOL_SKILL_SOURCES } from '../../src/lib/tool-skills.js';

const ROOT = join(__dirname, '..', '..');
const BUILT_IN = ['council', 'multi-review', 'goal-skill', 'video-watching'] as const;
const AGENTS = ['reviewer', 'review-router', 'review-security', 'review-cloud-functions', 'review-frontend', 'review-edge-cases',
  'goal-planner', 'goal-plan-reviewer', 'goal-implementer', 'goal-validator', 'council-persona', 'council-synthesizer'];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) walk(abs, out);
    else if (e.isFile()) out.push(abs);
  }
  return out;
}
const spec = (name: string) => GUARDED_SKILLS.find((g) => g.name === name)!;
const filesOf = (name: string): string[] =>
  walk(join(ROOT, spec(name).source)).map((f) => relative(join(ROOT, spec(name).source), f).split(sep).join('/')).filter(spec(name).filter).sort();

describe('the four built-in skills: shipped as guarded core', () => {
  it.each(BUILT_IN)('%s ships at the repo root, in package files, the desktop resources and every tool copy', (name) => {
    const s = spec(name);
    expect(s.source).toBe(`skill-${name}`);
    expect(existsSync(join(ROOT, s.source, 'SKILL.md'))).toBe(true);
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as { files: string[] };
    expect(pkg.files).toContain(s.source);
    const tauri = JSON.parse(readFileSync(join(ROOT, 'desktop', 'src-tauri', 'tauri.conf.json'), 'utf-8')) as {
      bundle: { resources: Record<string, string> };
    };
    expect(tauri.bundle.resources[`../../${s.source}`]).toBe(s.source);
    expect(TOOL_SKILL_SOURCES).toContain(s.source);
  });

  it.each(BUILT_IN)('%s: every shipped file is in its shipped table (regenerate with scripts/gen-guarded-tables.sh)', (name) => {
    const s = spec(name);
    for (const f of filesOf(name)) {
      expect(s.shippedShas[f], `${name}/${f}`).toContain(guardedFileSha(readFileSync(join(ROOT, s.source, f))));
    }
  });

  it('their agents ship from agents/, and each current version is a known shipped one', () => {
    for (const a of AGENTS) {
      const file = join(ROOT, 'agents', `${a}.md`);
      expect(existsSync(file), a).toBe(true);
      expect(ADOPTED_AGENT_SHAS[`${a}.md`], a).toContain(guardedFileSha(readFileSync(file)));
    }
    expect(existsSync(join(ROOT, 'skill-packs'))).toBe(false);
  });
});

describe('the four built-in skills: install', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'dc-builtin-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('installCoreForPlatform writes all four and their agents, recorded as core', async () => {
    const manifest = emptyManifest();
    await installCoreForPlatform('claude', tmp, manifest);
    for (const name of BUILT_IN) {
      for (const f of filesOf(name)) {
        const rel = `.claude/skills/${name}/${f}`;
        expect(existsSync(join(tmp, rel)), rel).toBe(true);
        expect(manifest.files[rel]?.kind, rel).toBe('core');
      }
    }
    for (const a of AGENTS) expect(existsSync(join(tmp, '.claude', 'agents', `${a}.md`)), a).toBe(true);
    // The old pack record is not what keeps them: no pack is recorded at all.
    expect(Object.keys(manifest.packs)).toEqual([]);
  });

  it('keeps the exec bit of video-watching scripts', async () => {
    await installCoreForPlatform('claude', tmp, emptyManifest());
    const mode = statSync(join(tmp, '.claude', 'skills', 'video-watching', 'scripts', 'transcribe.sh')).mode;
    expect(mode & 0o111).not.toBe(0);
  });

  it('keeps an edited council file and refreshes the rest', () => {
    const s = spec('council');
    const first = installGuardedSpec(s, join(ROOT, s.source), tmp, '.claude/skills', null);
    const recorded = emptyManifest();
    for (const w of first.written) recorded.files[w.rel] = { version: '1', kind: 'core', baselineSha: w.baselineSha };
    const edited = join(tmp, '.claude', 'skills', 'council', 'SKILL.md');
    writeFileSync(edited, 'my council rules\n');
    const r = installGuardedSpec(s, join(ROOT, s.source), tmp, '.claude/skills', recorded);
    expect(readFileSync(edited, 'utf-8')).toBe('my council rules\n');
    expect(r.kept.map((k) => k.rel)).toEqual(['.claude/skills/council/SKILL.md']);
  });
});

describe('adoptedAgentRefusal', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'dc-adopted-'));
    mkdirSync(join(tmp, '.claude', 'agents'), { recursive: true });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const put = (body: string) => writeFileSync(join(tmp, '.claude', 'agents', 'reviewer.md'), body);

  it('installs when the file is absent, or is a version dreamcontext shipped', () => {
    expect(adoptedAgentRefusal(tmp, 'reviewer.md', null)).toBeNull();
    put(readFileSync(join(ROOT, 'agents', 'reviewer.md'), 'utf-8'));
    expect(adoptedAgentRefusal(tmp, 'reviewer.md', null)).toBeNull();
  });

  it("keeps a user's own unrecorded reviewer.md, and says why", () => {
    put('---\nname: reviewer\n---\nmy own reviewer\n');
    expect(adoptedAgentRefusal(tmp, 'reviewer.md', null)).toMatch(/dreamcontext did not write it/);
    expect(adoptedAgentRefusal(tmp, 'reviewer.md', emptyManifest())).toMatch(/dreamcontext did not write it/);
  });

  it('a recorded agent, or a pack-agent with no baseline, is ours to manage', () => {
    put('---\nname: reviewer\n---\nedited\n');
    const m = emptyManifest();
    recordFile(m, '.claude/agents/reviewer.md', '0.41.0', 'pack-agent');
    expect(adoptedAgentRefusal(tmp, 'reviewer.md', m)).toBeNull();
    recordFile(m, '.claude/agents/reviewer.md', '0.41.0', 'agent');
    expect(adoptedAgentRefusal(tmp, 'reviewer.md', m)).toBeNull();
  });

  it('a recorded pack-agent the user edited is kept; an unedited one is refreshed', () => {
    const shipped = readFileSync(join(ROOT, 'agents', 'reviewer.md'), 'utf-8');
    const m = emptyManifest();
    recordFile(m, '.claude/agents/reviewer.md', '0.40.0', 'pack-agent', { baselineSha: agentBaselineSha(shipped) });
    put(shipped);
    expect(adoptedAgentRefusal(tmp, 'reviewer.md', m)).toBeNull();
    put(shipped + '\nmy own rule\n');
    expect(adoptedAgentRefusal(tmp, 'reviewer.md', m)).toMatch(/^Kept your edited \.claude\/agents\/reviewer\.md/);
  });

  it('installCoreForPlatform leaves an edited pack-agent as it is and keeps its record', async () => {
    const shipped = readFileSync(join(ROOT, 'agents', 'reviewer.md'), 'utf-8');
    const onDisk = emptyManifest();
    recordFile(onDisk, '.claude/agents/reviewer.md', '0.40.0', 'pack-agent', { baselineSha: agentBaselineSha(shipped) });
    writeManifest(tmp, onDisk);
    put(shipped + '\nmy own rule\n');
    const manifest = emptyManifest();
    const { notes } = await installCoreForPlatform('claude', tmp, manifest);
    expect(readFileSync(join(tmp, '.claude', 'agents', 'reviewer.md'), 'utf-8')).toContain('my own rule');
    expect(manifest.files['.claude/agents/reviewer.md']).toEqual(onDisk.files['.claude/agents/reviewer.md']);
    expect(notes.some((n) => n.includes('Kept your edited .claude/agents/reviewer.md'))).toBe(true);
  });

  it('is not about agents that always shipped from agents/', () => {
    expect(adoptedAgentRefusal(tmp, 'sleep-state.md', null)).toBeNull();
  });
});
