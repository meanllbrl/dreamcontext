import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync, existsSync, mkdirSync, rmSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import matter from 'gray-matter';
import { installCoreForPlatform } from '../../src/cli/commands/install-skill.js';
import { emptyManifest, type Manifest } from '../../src/lib/manifest.js';
import { AGENT_CORE_SKILL } from '../../src/lib/catalog.js';
import { loadSkillDocs } from '../../src/lib/recall.js';
import { RECALL_GUIDANCE, TASK_CREATE_GUIDANCE } from '../../src/lib/agent-guidance.js';

/**
 * Spec for `dreamcontext-agent-core`: the small skill dreamcontext's own
 * sub-agents preload instead of the full 70 KB `dreamcontext` skill.
 *
 * What is pinned and why:
 *  - it ships and installs through the same core pipeline as the other core
 *    skills (repo-root folder, package.json `files`, manifest kind `core`), or an
 *    agent naming it in `skills:` would start without it;
 *  - it stays preloadable: Claude Code refuses to preload a skill that sets
 *    `disable-model-invocation: true`;
 *  - it stays SMALL (the whole point) and says recall/task essentials in the
 *    exact words the SubagentStart briefing uses, so the two never drift apart;
 *  - skill recall never surfaces it in the main session, which already carries
 *    the full skill.
 */

const ROOT = join(__dirname, '..', '..');
const SKILL_PATH = join(ROOT, 'skill-agent-core', 'SKILL.md');
const MAX_BYTES = 6_144;

const raw = (): string => readFileSync(SKILL_PATH, 'utf-8');

describe('agent-core skill: the shipped file', () => {
  it('ships at the repo root and is listed in package.json files', () => {
    expect(existsSync(SKILL_PATH)).toBe(true);
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as { files: string[] };
    expect(pkg.files).toContain('skill-agent-core');
  });

  it('frontmatter name is the single shared constant', () => {
    expect(matter(raw()).data.name).toBe(AGENT_CORE_SKILL);
  });

  it('is hidden from the slash menu but stays preloadable', () => {
    const data = matter(raw()).data as Record<string, unknown>;
    expect(data['user-invocable']).toBe(false);
    expect(data['disable-model-invocation']).toBeUndefined();
  });

  it(`stays small: at most ${MAX_BYTES} bytes`, () => {
    expect(Buffer.byteLength(raw(), 'utf-8')).toBeLessThanOrEqual(MAX_BYTES);
  });

  it('contains no em dash', () => {
    expect(raw()).not.toContain('\u2014');
  });

  it('uses the briefing\'s exact recall and task-creation wording', () => {
    expect(raw()).toContain(RECALL_GUIDANCE);
    expect(raw()).toContain(TASK_CREATE_GUIDANCE);
  });

  it('points at the full manual and carries the path-safety rule', () => {
    const b = raw();
    expect(b).toContain('.claude/skills/dreamcontext/SKILL.md');
    expect(b).toContain('dreamcontext memory recall');
    expect(b.toLowerCase()).toContain('symlink');
  });
});

describe('agent-core skill: install wiring and recall exclusion', () => {
  let projectRoot: string;
  let manifest: Manifest;

  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const dir = join(tmpdir(), `ac-agent-core-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    projectRoot = realpathSync(dir);
    manifest = emptyManifest();
    await installCoreForPlatform('claude', projectRoot, manifest);
  });

  afterAll(() => {
    vi.restoreAllMocks();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it(`installs to .claude/skills/${AGENT_CORE_SKILL}/SKILL.md, byte-identical to the source`, () => {
    const installed = join(projectRoot, '.claude', 'skills', AGENT_CORE_SKILL, 'SKILL.md');
    expect(existsSync(installed)).toBe(true);
    expect(readFileSync(installed, 'utf-8')).toBe(raw());
  });

  it('is recorded in the manifest as kind `core`', () => {
    const entry = manifest.files[`.claude/skills/${AGENT_CORE_SKILL}/SKILL.md`];
    expect(entry).toBeDefined();
    expect(entry.kind).toBe('core');
  });

  it('never surfaces in skill recall, while an ordinary pack skill still does', () => {
    const skillsRoot = join(projectRoot, '.claude', 'skills');
    mkdirSync(join(skillsRoot, 'northwind-pack'), { recursive: true });
    writeFileSync(
      join(skillsRoot, 'northwind-pack', 'SKILL.md'),
      '---\nname: northwind-pack\ndescription: A fictional pack for this test.\n---\n\nBody.\n',
    );
    const slugs = loadSkillDocs(skillsRoot).map((d) => d.slug);
    expect(slugs).not.toContain(AGENT_CORE_SKILL);
    expect(slugs).toContain('northwind-pack');
  });
});
