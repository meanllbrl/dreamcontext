import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { loadSkillDocs, bm25Search } from '../../src/lib/recall.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `ac-skill-corpus-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeSkill(skillsRoot: string, pack: string, frontmatter: string, body: string): void {
  const dir = join(skillsRoot, pack);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}\n`);
}

describe('loadSkillDocs', () => {
  let tmpDir: string;
  let skillsRoot: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    skillsRoot = join(tmpDir, '.claude', 'skills');
    mkdirSync(skillsRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns one doc per non-alwaysApply SKILL.md with correct fields', () => {
    writeSkill(skillsRoot, 'multi-review', [
      'name: multi-review',
      'description: Multi-agent code review with a router and specialists.',
      'tags: [review, sub-agents]',
      'alwaysApply: false',
    ].join('\n'), 'Routes the diff to specialists.');

    writeSkill(skillsRoot, 'design', [
      'name: design',
      'description: Universal design system, spacing, typography, color.',
      'tags: [design, ui]',
    ].join('\n'), 'Design tokens and visual hierarchy.');

    const docs = loadSkillDocs(skillsRoot);
    expect(docs).toHaveLength(2);

    const review = docs.find(d => d.slug === 'multi-review')!;
    expect(review).toBeDefined();
    expect(review.type).toBe('skill');
    expect(review.slug).toBe('multi-review');
    expect(review.description).toContain('Multi-agent code review');
    expect(review.tags).toEqual(['review', 'sub-agents']);
    expect(review.relPath).toBe(join('multi-review', 'SKILL.md'));
    expect(review.tokens.length).toBeGreaterThan(0);
  });

  it('excludes skills with alwaysApply: true', () => {
    writeSkill(skillsRoot, 'engineering', [
      'description: Universal coding standards and security.',
      'alwaysApply: true',
    ].join('\n'), 'Coding standards.');
    writeSkill(skillsRoot, 'multi-review', [
      'name: multi-review',
      'description: Multi-agent code review.',
      'alwaysApply: false',
    ].join('\n'), 'Review.');

    const docs = loadSkillDocs(skillsRoot);
    expect(docs).toHaveLength(1);
    expect(docs[0].slug).toBe('multi-review');
    expect(docs.some(d => d.slug === 'engineering')).toBe(false);
  });

  it('falls back to the pack directory name when no name frontmatter', () => {
    writeSkill(skillsRoot, 'my-pack', [
      'description: A pack without a name field.',
    ].join('\n'), 'Body.');

    const docs = loadSkillDocs(skillsRoot);
    expect(docs).toHaveLength(1);
    expect(docs[0].slug).toBe('my-pack');
  });

  it('returns [] when skillsRoot does not exist', () => {
    const missing = join(tmpDir, 'nope', 'skills');
    expect(loadSkillDocs(missing)).toEqual([]);
  });

  it('skips malformed SKILL.md but still loads valid ones', () => {
    writeSkill(skillsRoot, 'good', [
      'name: good',
      'description: A valid skill.',
    ].join('\n'), 'Valid body.');

    // Malformed: broken YAML frontmatter
    const badDir = join(skillsRoot, 'bad');
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, 'SKILL.md'), '---\nname: : : [unbalanced\n  bad: yaml: here\n---\nbody');

    const docs = loadSkillDocs(skillsRoot);
    expect(docs.some(d => d.slug === 'good')).toBe(true);
  });

  it('does NOT load nested sub-skill SKILL.md files', () => {
    writeSkill(skillsRoot, 'engineering-pack', [
      'name: engineering-pack',
      'description: Top-level pack.',
      'alwaysApply: false',
    ].join('\n'), 'Top body.');

    // Nested sub-skill: engineering-pack/firebase/SKILL.md
    const subDir = join(skillsRoot, 'engineering-pack', 'firebase');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, 'SKILL.md'), '---\nname: firebase\ndescription: Nested sub-skill.\n---\nNested.');

    const docs = loadSkillDocs(skillsRoot);
    expect(docs).toHaveLength(1);
    expect(docs[0].slug).toBe('engineering-pack');
    expect(docs.some(d => d.slug === 'firebase')).toBe(false);
  });

  it('bm25Search ranks a multi-review-like skill above a design-like skill for a review query', () => {
    writeSkill(skillsRoot, 'multi-review', [
      'name: multi-review',
      'description: Multi-agent code review with a router and niche specialists. Review a PR with a team.',
      'tags: [review, sub-agents, code-review]',
      'alwaysApply: false',
    ].join('\n'), 'Routes the diff to specialist review sub-agents in parallel for a multi-aspect code review.');

    writeSkill(skillsRoot, 'design', [
      'name: design',
      'description: Universal design system with spacing, typography, and color tokens.',
      'tags: [design, ui, layout]',
      'alwaysApply: false',
    ].join('\n'), 'Spacing grid, typography scales, color palettes, and visual hierarchy.');

    const docs = loadSkillDocs(skillsRoot);
    const hits = bm25Search('multi agent code review', docs, 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].doc.slug).toBe('multi-review');
  });
});
