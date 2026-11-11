import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import matter from 'gray-matter';
import { installCoreForPlatform } from '../../src/cli/commands/install-skill.js';
import { emptyManifest, writeManifest, type Manifest } from '../../src/lib/manifest.js';
import { TOOL_SKILL_SOURCES } from '../../src/lib/tool-skills.js';
import { guardedFileIsUnchanged, guardedFileSha as designFileSha, installDesignSkill, isGuardedSkillPath, GUARDED_SKILLS } from '../../src/lib/core-guarded-skill.js';

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

  it('is a guarded core skill named `design`, and there is no pack catalog any more', () => {
    expect(existsSync(join(ROOT, 'skill-packs'))).toBe(false);
    expect(GUARDED_SKILLS.find((g) => g.name === 'design')?.source).toBe('skill-design');
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
    // design defers to "the project's style guide", which is the HOST's brand: never the app's.
    expect(apps).toMatch(/style guide wins" line does not apply here/);
  });
});

describe('design skill: principles, never the host identity', () => {
  // An app built with this skill must not look like dreamcontext: no brand hue, mark, typeface or
  // token value of ours (pattern a-template-default-must-not-carry-the-host-identity).
  it.each(SHIPPED)('%s carries no dreamcontext identity and no em dash', (f) => {
    const text = readFileSync(join(SOURCE, f), 'utf-8');
    expect(text).not.toMatch(/violet|purple|magenta|dream gem|visby|wordmark|dreamcontext|sleepy|--color-violet|#641787|#781ca3|#8200a6|#db04b4/i);
    expect(text).not.toContain('\u2014');
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
    const first = installDesignSkill(SOURCE, tmp, '.claude/skills', null);
    for (const w of first.written) recorded.files[w.rel] = { version: '1', kind: 'core', baselineSha: w.baselineSha };
    return { skillRoot, recorded };
  };

  it('keeps a file edited since dreamcontext wrote it', () => {
    const { skillRoot, recorded } = setup();
    const edited = join(skillRoot, 'design', 'product-ui.md');
    writeFileSync(edited, 'my own rules\n');
    const r = installDesignSkill(SOURCE, tmp, '.claude/skills', recorded);
    expect(readFileSync(edited, 'utf-8')).toBe('my own rules\n');
    expect(r.kept).toEqual([{ rel: '.claude/skills/design/product-ui.md', reason: 'edited', baselineSha: recorded.files['.claude/skills/design/product-ui.md'].baselineSha }]);
    expect(r.written).toHaveLength(SHIPPED.length - 1);
  });

  it('refreshes an unedited older copy (a new package version)', () => {
    const { skillRoot, recorded } = setup();
    const f = join(skillRoot, 'design', 'SKILL.md');
    writeFileSync(f, 'older shipped text\n');
    recorded.files['.claude/skills/design/SKILL.md'].baselineSha = designFileSha('older shipped text\n');
    const r = installDesignSkill(SOURCE, tmp, '.claude/skills', recorded);
    expect(readFileSync(f, 'utf-8')).toBe(readFileSync(join(SOURCE, 'SKILL.md'), 'utf-8'));
    expect(r.kept).toEqual([]);
  });

  it('old pack install (listed, no baseline): a shipped version is refreshed, an edit is kept', () => {
    const skillRoot = join(tmp, '.claude', 'skills');
    mkdirSync(join(skillRoot, 'design'), { recursive: true });
    writeFileSync(join(skillRoot, 'design', 'SKILL.md'), 'old pack text\n');
    writeFileSync(join(skillRoot, 'design', 'product-ui.md'), 'tuned by the owner\n');
    writeFileSync(join(skillRoot, 'design', 'design-web.md'), 'hand made\n');
    const recorded = emptyManifest();
    recorded.files['.claude/skills/design/SKILL.md'] = { version: '0.40.0', kind: 'pack-skill' };
    recorded.files['.claude/skills/design/product-ui.md'] = { version: '0.40.0', kind: 'pack-skill' };
    const shipped = { 'SKILL.md': [designFileSha('old pack text\n')] };
    const r = installDesignSkill(SOURCE, tmp, '.claude/skills', recorded, shipped);
    expect(readFileSync(join(skillRoot, 'design', 'SKILL.md'), 'utf-8')).toBe(readFileSync(join(SOURCE, 'SKILL.md'), 'utf-8'));
    expect(readFileSync(join(skillRoot, 'design', 'product-ui.md'), 'utf-8')).toBe('tuned by the owner\n');
    expect(readFileSync(join(skillRoot, 'design', 'design-web.md'), 'utf-8')).toBe('hand made\n');
    expect(r.kept).toEqual([
      { rel: '.claude/skills/design/design-web.md', reason: 'not-ours' },
      { rel: '.claude/skills/design/product-ui.md', reason: 'edited' },
    ]);
  });

  it('no manifest (a fresh clone, a second machine): an edited copy is kept, a shipped one refreshed', () => {
    const skillRoot = join(tmp, '.claude', 'skills');
    mkdirSync(join(skillRoot, 'design'), { recursive: true });
    writeFileSync(join(skillRoot, 'design', 'SKILL.md'), 'old pack text\n');
    writeFileSync(join(skillRoot, 'design', 'product-ui.md'), 'the team tuned this\n');
    const r = installDesignSkill(SOURCE, tmp, '.claude/skills', null, { 'SKILL.md': [designFileSha('old pack text\n')] });
    expect(readFileSync(join(skillRoot, 'design', 'SKILL.md'), 'utf-8')).toBe(readFileSync(join(SOURCE, 'SKILL.md'), 'utf-8'));
    expect(readFileSync(join(skillRoot, 'design', 'product-ui.md'), 'utf-8')).toBe('the team tuned this\n');
    expect(r.kept).toEqual([{ rel: '.claude/skills/design/product-ui.md', reason: 'edited' }]);
  });

  it('a CRLF checkout of the shipped text is not an edit', () => {
    const { skillRoot, recorded } = setup();
    const f = join(skillRoot, 'design', 'product-ui.md');
    writeFileSync(f, readFileSync(join(SOURCE, 'product-ui.md'), 'utf-8').split('\n').join('\r\n'));
    const r = installDesignSkill(SOURCE, tmp, '.claude/skills', recorded);
    expect(r.kept).toEqual([]);
    expect(designFileSha('a\r\nb')).toBe(designFileSha('a\nb'));
  });

  it('guardedFileIsUnchanged: only an untouched copy may be pruned when a release drops it', () => {
    mkdirSync(join(tmp, '.claude', 'skills', 'design'), { recursive: true });
    const rel = '.claude/skills/design/x.md';
    writeFileSync(join(tmp, rel), 'shipped\n');
    expect(guardedFileIsUnchanged(tmp, rel, designFileSha('shipped\n'))).toBe(true);
    writeFileSync(join(tmp, rel), 'edited\n');
    expect(guardedFileIsUnchanged(tmp, rel, designFileSha('shipped\n'))).toBe(false);
    expect(guardedFileIsUnchanged(tmp, rel, undefined)).toBe(false);
    expect(guardedFileIsUnchanged(tmp, '.claude/skills/design/missing.md', undefined)).toBe(false);
    // With no baseline, a version we shipped at that path is ours.
    writeFileSync(join(tmp, '.claude', 'skills', 'design', 'SKILL.md'), readFileSync(join(SOURCE, 'SKILL.md')));
    expect(guardedFileIsUnchanged(tmp, '.claude/skills/design/SKILL.md', undefined)).toBe(true);
  });

  it('never writes through a symlink', () => {
    const skillRoot = join(tmp, '.claude', 'skills');
    mkdirSync(join(skillRoot, 'design'), { recursive: true });
    const outside = join(tmp, 'outside.md');
    writeFileSync(outside, 'outside\n');
    symlinkSync(outside, join(skillRoot, 'design', 'product-ui.md'));
    const r = installDesignSkill(SOURCE, tmp, '.claude/skills', null);
    expect(readFileSync(outside, 'utf-8')).toBe('outside\n');
    expect(r.kept.map((k) => k.reason)).toEqual(['symlink']);
  });

  it('never writes through a linked folder on the way (design, or skills above it)', () => {
    const outside = mkdtempSync(join(tmpdir(), 'dc-design-core-out-'));
    try {
      writeFileSync(join(outside, 'SKILL.md'), 'not ours\n');
      mkdirSync(join(tmp, '.claude', 'skills'), { recursive: true });
      symlinkSync(outside, join(tmp, '.claude', 'skills', 'design'));
      const r = installDesignSkill(SOURCE, tmp, '.claude/skills', null);
      expect(r.written).toEqual([]);
      expect(r.kept.every((k) => k.reason === 'symlink')).toBe(true);
      expect(readdirSync(outside)).toEqual(['SKILL.md']);
      expect(readFileSync(join(outside, 'SKILL.md'), 'utf-8')).toBe('not ours\n');

      rmSync(join(tmp, '.claude'), { recursive: true, force: true });
      mkdirSync(join(tmp, '.claude'), { recursive: true });
      symlinkSync(outside, join(tmp, '.claude', 'skills'));
      expect(installDesignSkill(SOURCE, tmp, '.claude/skills', null).written).toEqual([]);
      expect(readdirSync(outside)).toEqual(['SKILL.md']);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
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

  it('isGuardedSkillPath matches only the guarded skill folders', () => {
    expect(isGuardedSkillPath('.claude/skills/design/SKILL.md')).toBe(true);
    for (const n of ['council', 'multi-review', 'goal-skill', 'video-watching']) expect(isGuardedSkillPath(`.claude/skills/${n}/SKILL.md`), n).toBe(true);
    expect(isGuardedSkillPath('.claude/skills/growth/SKILL.md')).toBe(false);
    expect(isGuardedSkillPath('.claude/skills/draw/scripts/lib/style.js')).toBe(true);
    expect(isGuardedSkillPath('.claude/skills/design-extra/SKILL.md')).toBe(false);
    expect(isGuardedSkillPath('.claude/skills/drawer/SKILL.md')).toBe(false);
    expect(isGuardedSkillPath('.claude/skills/engineering/SKILL.md')).toBe(false);
  });
});
