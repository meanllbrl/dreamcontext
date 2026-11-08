import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import matter from 'gray-matter';
import { installCoreForPlatform } from '../../src/cli/commands/install-skill.js';
import { emptyManifest, writeManifest } from '../../src/lib/manifest.js';
import { TOOL_SKILL_SOURCES, copyToolSkills } from '../../src/lib/tool-skills.js';
import { GUARDED_SHIPPED_SHAS, designFilter, drawFilter, guardedFileSha, installDrawSkill } from '../../src/lib/core-guarded-skill.js';

/**
 * `draw` became a core skill on 2026-11-08 (it was the optional excalidraw pack, plus the
 * dreamcontext skill's whiteboards reference). Pinned here:
 *  - it ships from `skill-draw/` (package files, the desktop resources, the built CLI) and is gone
 *    from the optional pack catalog; its router stays small and its description fits the listing;
 *  - the core install writes the whole folder (router, references, scripts, the binary example)
 *    byte for byte and records each file as core with a baseline;
 *  - an edited file is kept and reported; a user's own `draw/` with no manifest record is not ours;
 *  - Codex and Antigravity get it through the one shared core copy list;
 *  - every file as it ships now is in its shipped table (append, never remove).
 */

const ROOT = join(__dirname, '..', '..');
const SOURCE = join(ROOT, 'skill-draw');

function walk(dir: string, out: string[] = []): string[] {
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (d.isDirectory()) walk(join(dir, d.name), out);
    else if (d.isFile()) out.push(join(dir, d.name));
  }
  return out;
}
const SHIPPED = walk(SOURCE).map((f) => relative(SOURCE, f).split(sep).join('/')).filter(drawFilter).sort();

describe('draw skill: shipped as core', () => {
  it('ships at the repo root, in package files, the desktop resources and the built CLI', () => {
    expect(existsSync(join(SOURCE, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(ROOT, 'skill-packs', 'excalidraw'))).toBe(false);
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as { files: string[] };
    expect(pkg.files).toContain('skill-draw');
    const tauri = JSON.parse(readFileSync(join(ROOT, 'desktop', 'src-tauri', 'tauri.conf.json'), 'utf-8')) as {
      bundle: { resources: Record<string, string> };
    };
    expect(tauri.bundle.resources['../../skill-draw']).toBe('skill-draw');
    expect(readFileSync(join(ROOT, 'tsup.config.ts'), 'utf-8')).toContain("cpSync('skill-draw', 'dist/skill-draw'");
  });

  it('is absent from the optional pack catalog, named `draw`, and in the copy every tool gets', () => {
    const catalog = JSON.parse(readFileSync(join(ROOT, 'skill-packs', 'catalog.json'), 'utf-8')) as {
      packs: { name: string }[];
      standalone: { name: string }[];
    };
    expect([...catalog.packs, ...catalog.standalone].map((p) => p.name)).not.toContain('excalidraw');
    expect(matter(readFileSync(join(SOURCE, 'SKILL.md'), 'utf-8')).data.name).toBe('draw');
    expect(TOOL_SKILL_SOURCES).toContain('skill-draw');
  });

  it('the router is small, its description fits the listing with EN and TR triggers, and nothing is duplicated', () => {
    const md = readFileSync(join(SOURCE, 'SKILL.md'), 'utf-8');
    expect(Buffer.byteLength(md)).toBeLessThanOrEqual(8192);
    const description = String(matter(md).data.description);
    expect(description.length).toBeLessThanOrEqual(1000);
    expect(description.startsWith('Drawing: Excalidraw files and dreamcontext whiteboards.')).toBe(true);
    for (const t of ['diagram', 'wireframe', 'excalidraw', 'whiteboard', 'çiz', 'diyagram', 'tahtaya çiz']) expect(description).toContain(t);
    for (const ref of ['references/whiteboards.md', 'references/excalidraw.md', 'references/format.md']) {
      expect(md).toContain(ref);
      expect(existsSync(join(SOURCE, ref))).toBe(true);
    }
    expect(md).toContain('`dc-graph`');
    expect(existsSync(join(ROOT, 'skill', 'references', 'whiteboards.md'))).toBe(false);
    expect(readFileSync(join(SOURCE, 'references', 'excalidraw.md'), 'utf-8')).not.toContain('.claude/skills/excalidraw/');
  });

  it('every file as it ships now is in its shipped table, and design keeps every hash it had', () => {
    for (const f of SHIPPED) {
      expect(GUARDED_SHIPPED_SHAS.draw[f] ?? [], f).toContain(guardedFileSha(readFileSync(join(SOURCE, f))));
    }
    const design = join(ROOT, 'skill-design');
    for (const f of readdirSync(design).filter(designFilter)) {
      expect(GUARDED_SHIPPED_SHAS.design[f] ?? [], f).toContain(guardedFileSha(readFileSync(join(design, f))));
    }
    // The design pack's two released versions (2026-03-24, 2026-11-03) stay ours forever.
    expect(GUARDED_SHIPPED_SHAS.design['SKILL.md']).toEqual(expect.arrayContaining([
      '08e18d36b6dc3f9940ae94f51d41ed9d00d786fcd07ff93c42a2b836bef74281',
      '1d730ba5a1fb8bebe18ccdb29d1af12663758860ac19e90c89e15324f7ba8c1b',
    ]));
  });

  it('the builder runs as a command and exports main for a forwarding copy', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const builder = require(join(SOURCE, 'scripts', 'build_excalidraw.js')) as { main: unknown; buildExcalidraw: unknown };
    expect(typeof builder.main).toBe('function');
    expect(typeof builder.buildExcalidraw).toBe('function');
  });
});

describe('draw skill: core install and the edit guard', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'dc-draw-core-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('a fresh install writes the whole folder byte for byte, recorded as core with baselines', async () => {
    const manifest = emptyManifest();
    const { installed, draw } = await installCoreForPlatform('claude', tmp, manifest);
    expect(installed.some((l) => l.includes('.claude/skills/draw/'))).toBe(true);
    expect(draw?.skillRootRel).toBe('.claude/skills');
    for (const f of SHIPPED) {
      const rel = `.claude/skills/draw/${f}`;
      expect(readFileSync(join(tmp, rel)), f).toEqual(readFileSync(join(SOURCE, f)));
      expect(manifest.files[rel]?.kind).toBe('core');
      expect(manifest.files[rel]?.baselineSha).toBe(guardedFileSha(readFileSync(join(SOURCE, f))));
    }
    for (const f of ['scripts/lib/style.js', 'examples/sample.png', 'references/whiteboards.md']) expect(SHIPPED).toContain(f);
  });

  it('a second install changes nothing', async () => {
    const first = emptyManifest();
    await installCoreForPlatform('claude', tmp, first);
    writeManifest(tmp, first);
    const second = emptyManifest();
    const r = await installCoreForPlatform('claude', tmp, second);
    expect(r.draw?.result.kept).toEqual([]);
    for (const [rel, entry] of Object.entries(first.files)) if (rel.includes('/draw/')) expect(second.files[rel]).toEqual(entry);
  });

  it('an edited file is kept, still tracked, and reported', async () => {
    const first = emptyManifest();
    await installCoreForPlatform('claude', tmp, first);
    writeManifest(tmp, first);
    const edited = join(tmp, '.claude', 'skills', 'draw', 'scripts', 'lib', 'style.js');
    writeFileSync(edited, '// mine\n');
    const next = emptyManifest();
    const { notes } = await installCoreForPlatform('claude', tmp, next);
    expect(readFileSync(edited, 'utf-8')).toBe('// mine\n');
    expect(next.files['.claude/skills/draw/scripts/lib/style.js']?.kind).toBe('core');
    expect(notes.join('\n')).toContain('Kept .claude/skills/draw/scripts/lib/style.js');
  });

  it("a user's own draw/SKILL.md that a manifest does not list is not ours: kept, untracked", () => {
    mkdirSync(join(tmp, '.claude', 'skills', 'draw'), { recursive: true });
    writeFileSync(join(tmp, '.claude', 'skills', 'draw', 'SKILL.md'), '---\nname: draw\n---\nmy own\n');
    const recorded = emptyManifest();
    recorded.files['.claude/skills/dreamcontext/SKILL.md'] = { version: '1', kind: 'core' };
    const r = installDrawSkill(SOURCE, tmp, '.claude/skills', recorded);
    expect(readFileSync(join(tmp, '.claude', 'skills', 'draw', 'SKILL.md'), 'utf-8')).toContain('my own');
    expect(r.kept).toEqual([{ rel: '.claude/skills/draw/SKILL.md', reason: 'not-ours' }]);
  });

  it('with no manifest, a copy of a shipped version is refreshed; anything else is kept', () => {
    const r1 = installDrawSkill(SOURCE, tmp, '.claude/skills', null);
    expect(r1.kept).toEqual([]);
    const style = join(tmp, '.claude', 'skills', 'draw', 'scripts', 'lib', 'style.js');
    const old = '// an older shipped style.js\n';
    writeFileSync(style, old);
    const r2 = installDrawSkill(SOURCE, tmp, '.claude/skills', null, { 'scripts/lib/style.js': [guardedFileSha(old)] });
    expect(readFileSync(style)).toEqual(readFileSync(join(SOURCE, 'scripts', 'lib', 'style.js')));
    expect(r2.kept).toEqual([]);
    writeFileSync(style, '// mine\n');
    const r3 = installDrawSkill(SOURCE, tmp, '.claude/skills', null);
    expect(r3.kept.map((k) => [k.rel, k.reason])).toEqual([['.claude/skills/draw/scripts/lib/style.js', 'edited']]);
  });

  it('a linked .claude/skills, draw folder or scripts folder is never written through', () => {
    const outside = mkdtempSync(join(tmpdir(), 'dc-draw-core-out-'));
    try {
      mkdirSync(join(tmp, '.claude'), { recursive: true });
      symlinkSync(outside, join(tmp, '.claude', 'skills'));
      const r = installDrawSkill(SOURCE, tmp, '.claude/skills', null);
      expect(r.written).toEqual([]);
      expect(r.kept.every((k) => k.reason === 'symlink')).toBe(true);
      expect(readdirSync(outside)).toEqual([]);

      rmSync(join(tmp, '.claude'), { recursive: true, force: true });
      mkdirSync(join(tmp, '.claude', 'skills', 'draw'), { recursive: true });
      symlinkSync(outside, join(tmp, '.claude', 'skills', 'draw', 'scripts'));
      const r2 = installDrawSkill(SOURCE, tmp, '.claude/skills', null);
      expect(readdirSync(outside)).toEqual([]);
      expect(r2.kept.filter((k) => k.rel.includes('/draw/scripts/')).every((k) => k.reason === 'symlink')).toBe(true);
      expect(r2.written.some((w) => w.rel.endsWith('/draw/SKILL.md'))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('the Codex/Antigravity copy contains draw with its scripts', () => {
    const dir = join(tmp, 'skills');
    const staging = join(tmp, 'staging');
    mkdirSync(dir);
    mkdirSync(staging);
    const { names } = copyToolSkills(dir, { tool: 'codex', stagingParent: staging, packageDir: (s) => join(ROOT, s) });
    expect(names).toContain('draw');
    expect(existsSync(join(dir, 'draw', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(dir, 'draw', 'scripts', 'build_excalidraw.js'))).toBe(true);
  });
});
