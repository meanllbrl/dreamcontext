import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync, existsSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import matter from 'gray-matter';
import { installCoreForPlatform } from '../../src/cli/commands/install-skill.js';
import { emptyManifest } from '../../src/lib/manifest.js';
import type { Manifest } from '../../src/lib/manifest.js';

/**
 * Spec for the `patterns` core skill — the drift-free browse/load bridge to
 * `_dream_context/knowledge/patterns/` ("/patterns" lists, "/patterns <slug>"
 * loads). Task: patterns-first-class.
 *
 * These assertions pin the contract the skill must keep: it ships at the repo
 * root (like skill-curator / skill-task-manager), it carries NO pattern content
 * of its own (always reads the live files), it degrades gracefully when the
 * patterns folder is missing/empty, it surfaces feature-integration-pattern on
 * feature work, and setup/update installs it as a manifest-tracked core asset.
 */

const SKILL_PATH = join(__dirname, '..', '..', 'skill-patterns', 'SKILL.md');

function loadSkill() {
  const raw = readFileSync(SKILL_PATH, 'utf-8');
  return matter(raw);
}

describe('patterns skill — packaging', () => {
  it('ships SKILL.md at the repo root (mirrors skill-curator / skill-task-manager)', () => {
    expect(existsSync(SKILL_PATH)).toBe(true);
  });

  it('is listed in package.json `files` so it lands in the published tarball', () => {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'),
    ) as { files: string[] };
    expect(pkg.files).toContain('skill-patterns');
  });
});

describe('patterns skill — frontmatter', () => {
  it('is named `patterns` so it installs to .claude/skills/patterns/', () => {
    const { data } = loadSkill();
    expect(data.name).toBe('patterns');
  });

  it('description carries the /patterns triggers and the live-folder source of truth', () => {
    const { data } = loadSkill();
    const desc = String(data.description);
    expect(desc).toContain('/patterns');
    expect(desc).toContain('_dream_context/knowledge/patterns/');
  });
});

describe('patterns skill — body contract', () => {
  const body = () => loadSkill().content;

  it('declares the live files as the source of truth and carries no pattern content', () => {
    const b = body();
    expect(b).toContain('_dream_context/knowledge/patterns/*.md');
    expect(b.toUpperCase()).toContain('NO');
    expect(b.toLowerCase()).toContain('always read the live files');
  });

  it('degrades gracefully when the patterns folder is missing or empty (never creates it)', () => {
    const b = body().toLowerCase();
    expect(b).toContain('missing or empty');
    expect(b).toContain('do not create the folder');
  });

  it('resolves keyword arguments with a recall fallback', () => {
    expect(body()).toMatch(/dreamcontext memory recall/);
  });

  it('surfaces the mandatory feature-integration-pattern on NEW FEATURE work', () => {
    expect(body()).toContain('feature-integration-pattern.md');
  });

  it('requires offer-and-confirm before editing patterns from the browse surface', () => {
    expect(body().toLowerCase()).toContain('offer-and-confirm');
  });
});

describe('patterns skill — install wiring (setup/update on platform claude)', () => {
  let projectRoot: string;
  let manifest: Manifest;

  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const raw = join(tmpdir(), `ac-patterns-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(raw, { recursive: true });
    projectRoot = realpathSync(raw);
    manifest = emptyManifest();
    await installCoreForPlatform('claude', projectRoot, manifest);
  });

  afterAll(() => {
    vi.restoreAllMocks();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('installCoreForPlatform copies the skill to .claude/skills/patterns/SKILL.md', () => {
    const installed = join(projectRoot, '.claude', 'skills', 'patterns', 'SKILL.md');
    expect(existsSync(installed)).toBe(true);
    expect(readFileSync(installed, 'utf-8')).toBe(readFileSync(SKILL_PATH, 'utf-8'));
  });

  it('records the installed copy in the manifest as kind `core` (refreshed, never pruned as a pack)', () => {
    const entry = manifest.files['.claude/skills/patterns/SKILL.md'];
    expect(entry).toBeDefined();
    expect(entry.kind).toBe('core');
  });
});
