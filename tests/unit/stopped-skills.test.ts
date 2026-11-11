/**
 * Skills dreamcontext stopped shipping on 2026-11-11 (growth, brand-voice, ...) leave a project on
 * `update` only with proof: the manifest on disk records the file as ours (right kind, a concrete
 * version) AND it is still exactly what we shipped. Anything else stays, untracked, named once.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pruneStoppedSkills, STOPPED_SKILLS, type StoppedSkill } from '../../src/lib/retired-packs.js';
import { STOPPED_AGENT_SHAS, GOAL_SKILL_OLD_ASSET_SHAS } from '../../src/lib/retired-packs/stopped.js';
import { emptyManifest, recordFile, PRE_MANIFEST_VERSION, type Manifest, type ManagedFileKind } from '../../src/lib/manifest.js';
import { agentBaselineSha } from '../../src/lib/sleep-specialist-frontmatter.js';

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const SKILL_V1 = '# oldskill v1\n';
const REF = '# ref\n';
const FAKE: StoppedSkill = { name: 'oldskill', shipped: { 'SKILL.md': [sha('# oldskill v0\n'), sha(SKILL_V1)], 'refs/a.md': [sha(REF)] } };
const AGENT = '---\nname: old-agent\n---\nshipped agent body\n';
const AGENTS = { 'old-agent.md': [sha(AGENT)] };
const ASSET = 'module.exports = 1;\n';
const ASSETS = { 'old-helper.cjs': [sha(ASSET)] };
const ROOT_REL = '.claude/skills';

let root: string;
let oldM: Manifest;
let newM: Manifest;

function put(rel: string, content: string, kind: ManagedFileKind | null = 'pack-skill', version = '0.41.0', baselineSha?: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  if (kind) recordFile(oldM, rel, version, kind, baselineSha ? { baselineSha } : undefined);
}
const run = () => pruneStoppedSkills(root, ROOT_REL, oldM, newM, [FAKE], AGENTS, ASSETS);

beforeEach(() => {
  const raw = join(tmpdir(), `dc-stopped-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  root = realpathSync(raw);
  oldM = emptyManifest();
  newM = emptyManifest();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('pruneStoppedSkills', () => {
  it('removes a recorded, unchanged copy (any shipped version), its folder, and every manifest trace', () => {
    put('.claude/skills/oldskill/SKILL.md', '# oldskill v0\n');
    put('.claude/skills/oldskill/refs/a.md', REF);
    oldM.packs.oldskill = { version: '0.41.0' };
    const r = run();
    expect(r.removed.sort()).toEqual(['.claude/skills/oldskill/SKILL.md', '.claude/skills/oldskill/refs/a.md']);
    expect(r.kept).toEqual([]);
    expect(existsSync(join(root, '.claude/skills/oldskill'))).toBe(false);
    expect(Object.keys(oldM.files)).toEqual([]);
    expect(oldM.packs.oldskill).toBeUndefined();
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toMatch(/^Removed the oldskill skill: dreamcontext stopped shipping it on 2026-11-11/);
  });

  it('keeps an edited file and an unrecorded one, untracks them, and names them once', () => {
    put('.claude/skills/oldskill/SKILL.md', '# oldskill v1\nmy own rule\n');
    put('.claude/skills/oldskill/refs/a.md', REF);
    put('.claude/skills/oldskill/mine.md', 'mine\n', null);
    const r = run();
    expect(r.removed).toEqual(['.claude/skills/oldskill/refs/a.md']);
    expect(r.kept.sort()).toEqual(['.claude/skills/oldskill/SKILL.md', '.claude/skills/oldskill/mine.md']);
    expect(readFileSync(join(root, '.claude/skills/oldskill/SKILL.md'), 'utf-8')).toContain('my own rule');
    expect(oldM.files['.claude/skills/oldskill/SKILL.md']).toBeUndefined();
    expect(r.notes.some((n) => n.startsWith('Kept 2 file(s) of the oldskill skill'))).toBe(true);
    // The next update: nothing recorded any more, so nothing is touched and nothing is said.
    const again = run();
    expect(again).toEqual({ removed: [], kept: ['.claude/skills/oldskill/SKILL.md', '.claude/skills/oldskill/mine.md'], notes: [] });
    expect(existsSync(join(root, '.claude/skills/oldskill/SKILL.md'))).toBe(true);
  });

  it('with no manifest (a fresh clone): an exact shipped copy is still not deleted, and nothing is named', () => {
    put('.claude/skills/oldskill/SKILL.md', SKILL_V1, null);
    put('.claude/agents/old-agent.md', AGENT, null);
    const r = run();
    expect(r.removed).toEqual([]);
    expect(r.notes).toEqual([]);
    expect(existsSync(join(root, '.claude/skills/oldskill/SKILL.md'))).toBe(true);
    expect(existsSync(join(root, '.claude/agents/old-agent.md'))).toBe(true);
  });

  it('a legacy bootstrap guess (pre-manifest version) is not proof', () => {
    put('.claude/skills/oldskill/SKILL.md', SKILL_V1, 'pack-skill', PRE_MANIFEST_VERSION);
    const r = run();
    expect(r.removed).toEqual([]);
    expect(existsSync(join(root, '.claude/skills/oldskill/SKILL.md'))).toBe(true);
  });

  it('a record of the wrong kind is not proof', () => {
    put('.claude/skills/oldskill/SKILL.md', SKILL_V1, 'core');
    expect(run().removed).toEqual([]);
    expect(existsSync(join(root, '.claude/skills/oldskill/SKILL.md'))).toBe(true);
  });

  it('never follows a symlinked skill folder or a symlinked file', () => {
    const outside = join(root, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'SKILL.md'), SKILL_V1);
    mkdirSync(join(root, '.claude/skills'), { recursive: true });
    symlinkSync(outside, join(root, '.claude/skills/oldskill'));
    recordFile(oldM, '.claude/skills/oldskill/SKILL.md', '0.41.0', 'pack-skill');
    const r = run();
    expect(r.removed).toEqual([]);
    expect(existsSync(join(outside, 'SKILL.md'))).toBe(true);

    rmSync(join(root, '.claude/skills/oldskill'));
    mkdirSync(join(root, '.claude/skills/oldskill'));
    symlinkSync(join(outside, 'SKILL.md'), join(root, '.claude/skills/oldskill/SKILL.md'));
    oldM = emptyManifest();
    recordFile(oldM, '.claude/skills/oldskill/SKILL.md', '0.41.0', 'pack-skill');
    expect(run().removed).toEqual([]);
    expect(existsSync(join(outside, 'SKILL.md'))).toBe(true);
  });

  it('never deletes through a symlinked sub-folder, and never follows a rel that climbs', () => {
    const outside = join(root, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'a.md'), REF);
    put('.claude/skills/oldskill/SKILL.md', SKILL_V1);
    symlinkSync(outside, join(root, '.claude/skills/oldskill/refs'));
    // The manifest still lists the file under the now-linked folder, exactly as shipped.
    recordFile(oldM, '.claude/skills/oldskill/refs/a.md', '0.41.0', 'pack-skill');
    const climb = '.claude/skills/oldskill/../../victim.md';
    writeFileSync(join(root, '.claude/victim.md'), REF);
    recordFile(oldM, climb, '0.41.0', 'pack-skill');
    const r = run();
    expect(r.removed).toEqual(['.claude/skills/oldskill/SKILL.md']);
    expect(r.kept).toContain('.claude/skills/oldskill/refs/a.md');
    expect(r.kept).toContain(climb);
    expect(readFileSync(join(outside, 'a.md'), 'utf-8')).toBe(REF);
    expect(existsSync(join(root, '.claude/victim.md'))).toBe(true);
  });

  it('never deletes an agent or helper through a symlinked .claude/agents', () => {
    const outside = join(root, 'shared-agents');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'old-agent.md'), AGENT);
    mkdirSync(join(root, '.claude'), { recursive: true });
    symlinkSync(outside, join(root, '.claude/agents'));
    recordFile(oldM, '.claude/agents/old-agent.md', '0.41.0', 'pack-agent');
    expect(run().removed).toEqual([]);
    expect(existsSync(join(outside, 'old-agent.md'))).toBe(true);
  });

  it('an agent: removed when unchanged against its recorded baseline, kept when edited', () => {
    put('.claude/agents/old-agent.md', AGENT, 'pack-agent', '0.41.0', agentBaselineSha(AGENT));
    expect(run().removed).toEqual(['.claude/agents/old-agent.md']);

    oldM = emptyManifest();
    put('.claude/agents/old-agent.md', AGENT + 'my line\n', 'pack-agent', '0.41.0', agentBaselineSha(AGENT));
    const r = run();
    expect(r.removed).toEqual([]);
    expect(r.kept).toEqual(['.claude/agents/old-agent.md']);
    expect(r.notes.some((n) => n.includes('the agents of the stopped skills'))).toBe(true);
  });

  it("goal-skill's old helpers in .claude/ go when recorded and unchanged", () => {
    put('.claude/old-helper.cjs', ASSET, 'pack-asset');
    expect(run().removed).toEqual(['.claude/old-helper.cjs']);
    expect(existsSync(join(root, '.claude/old-helper.cjs'))).toBe(false);
  });

  it('works on another tool root (.agents/skills) the same way', () => {
    const rel = '.agents/skills/oldskill/SKILL.md';
    mkdirSync(join(root, '.agents/skills/oldskill'), { recursive: true });
    writeFileSync(join(root, rel), SKILL_V1);
    recordFile(oldM, rel, '0.41.0', 'pack-skill');
    expect(pruneStoppedSkills(root, '.agents/skills', oldM, newM, [FAKE], {}, {}).removed).toEqual([rel]);
  });

  it('is a no-op on a project that never had any of them', () => {
    expect(run()).toEqual({ removed: [], kept: [], notes: [] });
  });
});

describe('the shipped stop tables', () => {
  it('name the seven stopped skills, each file with sha256 hashes', () => {
    expect(STOPPED_SKILLS.map((s) => s.name).sort()).toEqual(
      ['brand-voice', 'business-idea-discovery', 'business-idea-validation', 'growth', 'jev-verify', 'meta-marketing', 'system-prompts'],
    );
    for (const s of STOPPED_SKILLS) {
      expect(s.shipped['SKILL.md'], s.name).toBeDefined();
      for (const hashes of Object.values(s.shipped)) for (const h of hashes) expect(h).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('cover the stopped agents and none that still ship', () => {
    const names = Object.keys(STOPPED_AGENT_SHAS);
    expect(names).toContain('discover-brand.md');
    expect(names.some((n) => n.startsWith('biv-'))).toBe(true);
    expect(names.some((n) => n.startsWith('marketing-'))).toBe(true);
    for (const n of names) expect(existsSync(join(__dirname, '..', '..', 'agents', n)), n).toBe(false);
    expect(Object.keys(GOAL_SKILL_OLD_ASSET_SHAS).sort()).toEqual(['goal-skill-demo.cjs', 'goal-skill-viewer.cjs', 'statusline-goalskill.cjs']);
  });
});
