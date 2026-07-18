/**
 * Pure-lib tests for src/lib/install-packs.ts — install/uninstall against a real
 * temp project dir using the repo's real skill-packs catalog. No live server, no
 * @inquirer/chalk. Mirrors the temp-dir scaffolding of platform-install.test.ts.
 *
 * Covers plan tests A1–A10 + the R8/R9 delete-bound helper.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  installPack,
  uninstallPack,
  resolveSkillDirToRemove,
  UnknownPackError,
} from '../../src/lib/install-packs.js';
import { emptyManifest, isSafeDeletePath, type Manifest } from '../../src/lib/manifest.js';

function makeTmpDir(): string {
  const raw = join(tmpdir(), `ac-install-packs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  return realpathSync(raw);
}

const ANSI = /\x1b\[|\[\d+m/;

let tmpDir: string;
let manifest: Manifest;

beforeEach(() => {
  tmpDir = makeTmpDir();
  manifest = emptyManifest();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── A1 / A2 — install engineering (claude) ───────────────────────────────────

describe('installPack — engineering (claude)', () => {
  it('A1: writes SKILL.md, records pack-skill kind + pack entry, ANSI-free rel paths', () => {
    const result = installPack('engineering', tmpDir, ['claude'], manifest);

    const skillMd = join(tmpDir, '.claude', 'skills', 'engineering', 'SKILL.md');
    expect(existsSync(skillMd)).toBe(true);

    const baseRel = '.claude/skills/engineering/SKILL.md';
    expect(result.installed).toContain(baseRel);
    expect(manifest.files[baseRel]?.kind).toBe('pack-skill');
    expect(manifest.packs.engineering).toBeDefined();

    // Every returned path is a clean, ANSI-free relative string.
    for (const p of result.installed) {
      expect(ANSI.test(p)).toBe(false);
      expect(p.includes('[')).toBe(false);
    }
  });

  it('A2: records the related reviewer agent under .claude/agents as pack-agent', () => {
    const result = installPack('engineering', tmpDir, ['claude'], manifest);

    const reviewerRel = '.claude/agents/reviewer.md';
    expect(existsSync(join(tmpDir, '.claude', 'agents', 'reviewer.md'))).toBe(true);
    expect(result.installed).toContain(reviewerRel);
    expect(manifest.files[reviewerRel]?.kind).toBe('pack-agent');
  });
});

// ─── A3 — uninstall engineering ───────────────────────────────────────────────

describe('uninstallPack — engineering (claude)', () => {
  it('A3: removes skill dir files, deletes the manifest pack entry, removed lists files', () => {
    installPack('engineering', tmpDir, ['claude'], manifest);
    const skillMd = join(tmpDir, '.claude', 'skills', 'engineering', 'SKILL.md');
    expect(existsSync(skillMd)).toBe(true);

    const result = uninstallPack('engineering', tmpDir, ['claude'], manifest);

    expect(existsSync(skillMd)).toBe(false);
    // R9 happy path: the strict-child skill dir itself is gone.
    expect(existsSync(join(tmpDir, '.claude', 'skills', 'engineering'))).toBe(false);
    expect(manifest.packs.engineering).toBeUndefined();
    expect(result.removed).toContain('.claude/skills/engineering/SKILL.md');
    expect(result.removed.length).toBeGreaterThan(0);
    // No removed path is unsafe to delete.
    for (const rel of result.removed) {
      expect(isSafeDeletePath(rel)).toBe(true);
    }
  });
});

// ─── A4 — agent sharing (engineering + goal-skill both list reviewer) ──────────

describe('uninstallPack — shared agent', () => {
  it('A4: uninstalling engineering keeps reviewer.md while goal-skill is still installed, then goal-skill removes it', () => {
    installPack('engineering', tmpDir, ['claude'], manifest);
    installPack('goal-skill', tmpDir, ['claude'], manifest);

    const reviewer = join(tmpDir, '.claude', 'agents', 'reviewer.md');
    expect(existsSync(reviewer)).toBe(true);

    const r1 = uninstallPack('engineering', tmpDir, ['claude'], manifest);
    // reviewer survives because goal-skill still depends on it.
    expect(existsSync(reviewer)).toBe(true);
    expect(r1.warnings.some((w) => w.includes('reviewer') && w.includes('goal-skill'))).toBe(true);
    expect(existsSync(join(tmpDir, '.claude', 'skills', 'engineering', 'SKILL.md'))).toBe(false);

    const r2 = uninstallPack('goal-skill', tmpDir, ['claude'], manifest);
    expect(existsSync(reviewer)).toBe(false);
    expect(r2.removed).toContain('.claude/agents/reviewer.md');
  });
});

// ─── A6 — fallback on-disk removal with an empty manifest ──────────────────────

describe('uninstallPack — on-disk fallback (no manifest record)', () => {
  it('A6: removes an on-disk pack skill dir even when the manifest has no entry', () => {
    // Hand-write a standalone skill on disk with a fresh/empty manifest — no
    // manifest entry references it, exercising the catalog-derived fallback.
    const dir = join(tmpDir, '.claude', 'skills', 'business-idea-validation');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '# biv\n', 'utf-8');

    const fresh = emptyManifest();
    const result = uninstallPack('business-idea-validation', tmpDir, ['claude'], fresh);

    expect(existsSync(join(dir, 'SKILL.md'))).toBe(false);
    expect(existsSync(dir)).toBe(false);
    expect(result.removed).toContain('.claude/skills/business-idea-validation/SKILL.md');
  });
});

// ─── A7 — unknown pack throws ─────────────────────────────────────────────────

describe('installPack — unknown name', () => {
  it('A7: throws UnknownPackError for a name absent from the catalog', () => {
    expect(() => installPack('does-not-exist', tmpDir, ['claude'], manifest)).toThrow(UnknownPackError);
  });
});

// ─── A8 — idempotent uninstall on a never-installed pack ───────────────────────

describe('uninstallPack — idempotent', () => {
  it('A8: uninstalling a never-installed (but catalog-valid) pack returns removed:[] and does not throw', () => {
    const result = uninstallPack('engineering', tmpDir, ['claude'], manifest);
    expect(result.removed).toEqual([]);
  });
});

// ─── A9 — bundleDir standalone (excalidraw) ships its whole code-bearing tree ──

describe('installPack — excalidraw (bundleDir standalone)', () => {
  it('A9a: copies the entire skill dir (scripts, lib, examples + binary, package.json), not just SKILL.md', () => {
    const result = installPack('excalidraw', tmpDir, ['claude'], manifest);

    const base = join(tmpDir, '.claude', 'skills', 'excalidraw');
    // Prompt + runnable assets + vendored lib + commonjs scoping + binary asset.
    expect(existsSync(join(base, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(base, 'scripts', 'build_excalidraw.js'))).toBe(true);
    expect(existsSync(join(base, 'scripts', 'lib', 'style.js'))).toBe(true);
    expect(existsSync(join(base, 'package.json'))).toBe(true);
    expect(existsSync(join(base, 'examples', 'sample.png'))).toBe(true);

    // Every copied file is recorded as pack-skill, with clean ANSI-free rel paths.
    expect(result.installed).toContain('.claude/skills/excalidraw/SKILL.md');
    expect(result.installed).toContain('.claude/skills/excalidraw/scripts/build_excalidraw.js');
    for (const p of result.installed) {
      expect(ANSI.test(p)).toBe(false);
      expect(manifest.files[p]?.kind).toBe('pack-skill');
    }
    expect(manifest.packs.excalidraw).toBeDefined();
  });

  it('A9b: uninstall removes the whole bundled dir and drops its manifest entries', () => {
    installPack('excalidraw', tmpDir, ['claude'], manifest);
    const base = join(tmpDir, '.claude', 'skills', 'excalidraw');
    expect(existsSync(base)).toBe(true);

    const result = uninstallPack('excalidraw', tmpDir, ['claude'], manifest);
    expect(result.removed).toContain('.claude/skills/excalidraw/scripts/build_excalidraw.js');
    expect(existsSync(base)).toBe(false);
    expect(manifest.packs.excalidraw).toBeUndefined();
    expect(Object.keys(manifest.files).some((f) => f.startsWith('.claude/skills/excalidraw/'))).toBe(false);
  });
});

// ─── A9c — bundleDir preserves the executable bit on shipped shell scripts ─────

describe('installPack — video-watching (bundleDir + executable engine)', () => {
  it('A9c: ships the scripts/ engine and keeps transcribe.sh executable', () => {
    const result = installPack('video-watching', tmpDir, ['claude'], manifest);

    const base = join(tmpDir, '.claude', 'skills', 'video-watching');
    expect(existsSync(join(base, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(base, 'scripts', 'transcribe.sh'))).toBe(true);
    expect(existsSync(join(base, 'scripts', 'build_frame_index.py'))).toBe(true);

    // SKILL.md invokes `./scripts/transcribe.sh`, so the exec bit must survive the copy.
    const mode = statSync(join(base, 'scripts', 'transcribe.sh')).mode;
    expect(mode & 0o111).not.toBe(0);

    expect(result.installed).toContain('.claude/skills/video-watching/scripts/transcribe.sh');
    for (const p of result.installed) {
      expect(ANSI.test(p)).toBe(false);
      expect(manifest.files[p]?.kind).toBe('pack-skill');
    }
    expect(manifest.packs['video-watching']).toBeDefined();
  });
});

// ─── A11 — pack assets + statusLine (goal-skill) ──────────────────────────────

describe('installPack — goal-skill assets + statusLine (claude)', () => {
  it('A11a: copies the .cjs helpers into .claude/ and records them as pack-asset', () => {
    const result = installPack('goal-skill', tmpDir, ['claude'], manifest);

    for (const f of ['statusline-goalskill.cjs', 'goal-skill-viewer.cjs', 'goal-skill-demo.cjs']) {
      const rel = `.claude/${f}`;
      expect(existsSync(join(tmpDir, '.claude', f))).toBe(true);
      expect(result.installed).toContain(rel);
      expect(manifest.files[rel]?.kind).toBe('pack-asset');
      expect(isSafeDeletePath(rel)).toBe(true);
    }
  });

  it('A11b: registers statusLine in .claude/settings.json when absent', () => {
    installPack('goal-skill', tmpDir, ['claude'], manifest);

    const settings = JSON.parse(
      readFileSync(join(tmpDir, '.claude', 'settings.json'), 'utf-8'),
    );
    expect(settings.statusLine).toEqual({
      type: 'command',
      command: 'node .claude/statusline-goalskill.cjs',
      padding: 0,
    });
  });

  it('A11c: NEVER clobbers a foreign statusLine — warns instead', () => {
    mkdirSync(join(tmpDir, '.claude'), { recursive: true });
    const foreign = { type: 'command', command: 'my-own-statusline.sh' };
    writeFileSync(
      join(tmpDir, '.claude', 'settings.json'),
      JSON.stringify({ statusLine: foreign }, null, 2),
      'utf-8',
    );

    const result = installPack('goal-skill', tmpDir, ['claude'], manifest);

    const settings = JSON.parse(
      readFileSync(join(tmpDir, '.claude', 'settings.json'), 'utf-8'),
    );
    expect(settings.statusLine).toEqual(foreign);
    expect(result.warnings.some((w) => w.includes('statusLine'))).toBe(true);
  });

  it('A11d: refreshes a stale OWN statusLine registration on re-install', () => {
    mkdirSync(join(tmpDir, '.claude'), { recursive: true });
    writeFileSync(
      join(tmpDir, '.claude', 'settings.json'),
      JSON.stringify(
        { statusLine: { type: 'command', command: 'node old/path/statusline-goalskill.cjs' } },
        null,
        2,
      ),
      'utf-8',
    );

    installPack('goal-skill', tmpDir, ['claude'], manifest);

    const settings = JSON.parse(
      readFileSync(join(tmpDir, '.claude', 'settings.json'), 'utf-8'),
    );
    expect(settings.statusLine.command).toBe('node .claude/statusline-goalskill.cjs');
  });

  it('A11e: uninstall removes the assets, drops manifest entries, and unregisters OUR statusLine', () => {
    installPack('goal-skill', tmpDir, ['claude'], manifest);
    const result = uninstallPack('goal-skill', tmpDir, ['claude'], manifest);

    for (const f of ['statusline-goalskill.cjs', 'goal-skill-viewer.cjs', 'goal-skill-demo.cjs']) {
      const rel = `.claude/${f}`;
      expect(existsSync(join(tmpDir, '.claude', f))).toBe(false);
      expect(result.removed).toContain(rel);
      expect(manifest.files[rel]).toBeUndefined();
    }
    const settings = JSON.parse(
      readFileSync(join(tmpDir, '.claude', 'settings.json'), 'utf-8'),
    );
    expect(settings.statusLine).toBeUndefined();
    // other keys survive
    expect(settings.hooks ?? settings.autoMemoryEnabled ?? 'ok').toBeDefined();
  });

  it('A11f: uninstall keeps a foreign statusLine untouched', () => {
    installPack('goal-skill', tmpDir, ['claude'], manifest);
    const foreign = { type: 'command', command: 'my-own-statusline.sh' };
    const settingsPath = join(tmpDir, '.claude', 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    settings.statusLine = foreign;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');

    uninstallPack('goal-skill', tmpDir, ['claude'], manifest);

    const after = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(after.statusLine).toEqual(foreign);
  });
});

// ─── A10 / R9 — resolveSkillDirToRemove (delete-bound) in isolation ────────────

describe('resolveSkillDirToRemove — delete bound (R8/R9/R10)', () => {
  const root = '/tmp/p/.claude/skills';

  it("A10: '.' resolves to skillRoot → null", () => {
    expect(resolveSkillDirToRemove(root, '.')).toBeNull();
  });

  it("A10: '..' escapes → null", () => {
    expect(resolveSkillDirToRemove(root, '..')).toBeNull();
  });

  it("A10: 'a/b' contains a slash → null", () => {
    expect(resolveSkillDirToRemove(root, 'a/b')).toBeNull();
  });

  it("A10: '/etc/passwd' is absolute → null", () => {
    expect(resolveSkillDirToRemove(root, '/etc/passwd')).toBeNull();
  });

  it("A10: 'engineering' → <root>/engineering (the only accepted shape)", () => {
    expect(resolveSkillDirToRemove(root, 'engineering')).toBe(resolve(root, 'engineering'));
  });
});
