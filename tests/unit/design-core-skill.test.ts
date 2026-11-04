import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import matter from 'gray-matter';
import { installCoreForPlatform } from '../../src/cli/commands/install-skill.js';
import { emptyManifest, writeManifest, type Manifest } from '../../src/lib/manifest.js';
import { TOOL_SKILL_SOURCES } from '../../src/lib/tool-skills.js';
import { designFileSha, installDesignSkill, isDesignSkillPath } from '../../src/lib/core-design-skill.js';

/**
 * `design` became a core skill on 2026-11-04 (it was an optional pack): every skill and brief that
 * says "load `design`" must find it on every project and every tool. Pinned here:
 *  - it ships from `skill-design/` (package files, the desktop resources) and is gone from the
 *    optional pack catalog;
 *  - the core install writes every file and records it as core with a baseline hash;
 *  - Codex and Antigravity get it through the one shared core copy list;
 *  - an installed file edited since we wrote it is kept, still tracked, and named in a note.
 */

const ROOT = join(__dirname, '..', '..');
const SOURCE = join(ROOT, 'skill-design');
const SHIPPED = readdirSync(SOURCE).filter((f) => f.endsWith('.md')).sort();

describe('design skill: shipped as core', () => {
  it('ships at the repo root, in package files and the desktop resources', () => {
    expect(existsSync(join(SOURCE, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(ROOT, 'skill-packs', 'design'))).toBe(false);
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as { files: string[] };
    expect(pkg.files).toContain('skill-design');
    const tauri = JSON.parse(readFileSync(join(ROOT, 'desktop', 'src-tauri', 'tauri.conf.json'), 'utf-8')) as {
      bundle: { resources: Record<string, string> };
    };
    expect(tauri.bundle.resources['../../skill-design']).toBe('skill-design');
  });

  it('is absent from the optional pack catalog and named `design`', () => {
    const catalog = JSON.parse(readFileSync(join(ROOT, 'skill-packs', 'catalog.json'), 'utf-8')) as {
      packs: { name: string; crossPackDeps?: string[] }[];
      standalone: { name: string }[];
    };
    expect([...catalog.packs, ...catalog.standalone].map((p) => p.name)).not.toContain('design');
    // engineering no longer "recommends" installing design: it is always there. Other packs still
    // point at design sub-files (design/onboarding-design...), which are always installed too.
    expect(catalog.packs.find((p) => p.name === 'engineering')?.crossPackDeps ?? []).toEqual([]);
    expect(matter(readFileSync(join(SOURCE, 'SKILL.md'), 'utf-8')).data.name).toBe('design');
  });

  it('is in the core copy every non-Claude tool gets', () => {
    expect(TOOL_SKILL_SOURCES).toContain('skill-design');
  });

  it('the /apps skill loads it as the guaranteed source, frontend-design only if available', () => {
    const apps = readFileSync(join(ROOT, 'skill-apps', 'SKILL.md'), 'utf-8');
    expect(apps).toMatch(/load the `design` skill/);
    expect(apps).toMatch(/product-ui\.md/);
    expect(apps).not.toMatch(/load `frontend-design` and `design`/);
    expect(apps).toMatch(/`frontend-design`[^.]*never required/);
  });
});

describe('design skill: core install and the edit guard', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'dc-design-core-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('installCoreForPlatform writes every file and records it as core with a baseline', async () => {
    const manifest = emptyManifest();
    const { installed } = await installCoreForPlatform('claude', tmp, manifest);
    expect(installed.some((l) => l.includes('.claude/skills/design/'))).toBe(true);
    for (const f of SHIPPED) {
      const rel = `.claude/skills/design/${f}`;
      expect(readFileSync(join(tmp, rel), 'utf-8')).toBe(readFileSync(join(SOURCE, f), 'utf-8'));
      expect(manifest.files[rel]?.kind).toBe('core');
      expect(manifest.files[rel]?.baselineSha).toBe(designFileSha(readFileSync(join(SOURCE, f))));
    }
  });

  const setup = (): { skillRoot: string; recorded: Manifest } => {
    const skillRoot = join(tmp, '.claude', 'skills');
    const recorded = emptyManifest();
    const first = installDesignSkill(SOURCE, skillRoot, '.claude/skills', null);
    for (const w of first.written) recorded.files[w.rel] = { version: '1', kind: 'core', baselineSha: w.baselineSha };
    return { skillRoot, recorded };
  };

  it('keeps a file edited since dreamcontext wrote it', () => {
    const { skillRoot, recorded } = setup();
    const edited = join(skillRoot, 'design', 'product-ui.md');
    writeFileSync(edited, 'my own rules\n');
    const r = installDesignSkill(SOURCE, skillRoot, '.claude/skills', recorded);
    expect(readFileSync(edited, 'utf-8')).toBe('my own rules\n');
    expect(r.kept).toEqual([{ rel: '.claude/skills/design/product-ui.md', reason: 'edited', baselineSha: recorded.files['.claude/skills/design/product-ui.md'].baselineSha }]);
    expect(r.written).toHaveLength(SHIPPED.length - 1);
  });

  it('refreshes an unedited older copy (a new package version)', () => {
    const { skillRoot, recorded } = setup();
    const f = join(skillRoot, 'design', 'SKILL.md');
    writeFileSync(f, 'older shipped text\n');
    recorded.files['.claude/skills/design/SKILL.md'].baselineSha = designFileSha('older shipped text\n');
    const r = installDesignSkill(SOURCE, skillRoot, '.claude/skills', recorded);
    expect(readFileSync(f, 'utf-8')).toBe(readFileSync(join(SOURCE, 'SKILL.md'), 'utf-8'));
    expect(r.kept).toEqual([]);
  });

  it('refreshes the old pack install (listed, no baseline) and leaves a file it never wrote', () => {
    const skillRoot = join(tmp, '.claude', 'skills');
    mkdirSync(join(skillRoot, 'design'), { recursive: true });
    writeFileSync(join(skillRoot, 'design', 'SKILL.md'), 'old pack text\n');
    writeFileSync(join(skillRoot, 'design', 'design-web.md'), 'hand made\n');
    const recorded = emptyManifest();
    recorded.files['.claude/skills/design/SKILL.md'] = { version: '0.40.0', kind: 'pack-skill' };
    const r = installDesignSkill(SOURCE, skillRoot, '.claude/skills', recorded);
    expect(readFileSync(join(skillRoot, 'design', 'SKILL.md'), 'utf-8')).toBe(readFileSync(join(SOURCE, 'SKILL.md'), 'utf-8'));
    expect(readFileSync(join(skillRoot, 'design', 'design-web.md'), 'utf-8')).toBe('hand made\n');
    expect(r.kept).toEqual([{ rel: '.claude/skills/design/design-web.md', reason: 'not-ours' }]);
  });

  it('never writes through a symlink', () => {
    const skillRoot = join(tmp, '.claude', 'skills');
    mkdirSync(join(skillRoot, 'design'), { recursive: true });
    const outside = join(tmp, 'outside.md');
    writeFileSync(outside, 'outside\n');
    symlinkSync(outside, join(skillRoot, 'design', 'product-ui.md'));
    const r = installDesignSkill(SOURCE, skillRoot, '.claude/skills', null);
    expect(readFileSync(outside, 'utf-8')).toBe('outside\n');
    expect(r.kept.map((k) => k.reason)).toEqual(['symlink']);
  });

  it('the core install keeps an edited file tracked and says so', async () => {
    const first = emptyManifest();
    await installCoreForPlatform('claude', tmp, first);
    writeManifest(tmp, first);
    writeFileSync(join(tmp, '.claude', 'skills', 'design', 'product-ui.md'), 'mine\n');
    const next = emptyManifest();
    const { notes } = await installCoreForPlatform('claude', tmp, next);
    expect(readFileSync(join(tmp, '.claude', 'skills', 'design', 'product-ui.md'), 'utf-8')).toBe('mine\n');
    expect(next.files['.claude/skills/design/product-ui.md']?.kind).toBe('core');
    expect(notes.join('\n')).toContain('Kept .claude/skills/design/product-ui.md');
  });

  it('isDesignSkillPath matches only the design skill folder', () => {
    expect(isDesignSkillPath('.claude/skills/design/SKILL.md')).toBe(true);
    expect(isDesignSkillPath('.claude/skills/design-extra/SKILL.md')).toBe(false);
    expect(isDesignSkillPath('.claude/skills/engineering/SKILL.md')).toBe(false);
  });
});
