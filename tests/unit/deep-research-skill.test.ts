import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';

/**
 * Spec for the `dreamcontext-deep-research` core skill — the iterative,
 * sub-agent-driven corpus-synthesis orchestrator (the heavy counterpart to
 * `dreamcontext-explore`) for large / multi-project / federated brains.
 *
 * Task: add-a-deep-research-mode-beyond-dreamcontext-explore-for-large-multi-project-tagged-corpora
 *
 * These assertions pin the contract the skill must keep: it ships at the repo
 * root (like skill-curator / skill-initializer), it is user-invocable, it is
 * recall-driven and federation-aware, it fans out → verifies → synthesizes with
 * mandatory citations, and it stays read-only.
 */

const SKILL_PATH = join(__dirname, '..', '..', 'skill-deep-research', 'SKILL.md');

function loadSkill() {
  const raw = readFileSync(SKILL_PATH, 'utf-8');
  return matter(raw);
}

describe('deep-research skill — packaging', () => {
  it('ships SKILL.md at the repo root (mirrors skill-curator / skill-initializer)', () => {
    expect(existsSync(SKILL_PATH)).toBe(true);
  });

  it('is listed in package.json `files` so it lands in the published tarball', () => {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'),
    ) as { files: string[] };
    expect(pkg.files).toContain('skill-deep-research');
  });
});

describe('deep-research skill — frontmatter', () => {
  it('has the distinct name (no collision with the generic web deep-research skill)', () => {
    const { data } = loadSkill();
    expect(data.name).toBe('dreamcontext-deep-research');
  });

  it('is user-invocable and not always-applied (an on-demand escalation)', () => {
    const { data } = loadSkill();
    expect(data['user-invocable']).toBe(true);
    expect(data.alwaysApply).toBe(false);
  });

  it('description carries triggers covering the multi-project / cross-corpus case', () => {
    const { data } = loadSkill();
    const desc = String(data.description).toLowerCase();
    expect(desc).toContain('multi-project');
    expect(desc).toContain('/dreamcontext-deep-research');
    // It must position itself as the escalation beyond a single explore pass.
    expect(desc).toContain('dreamcontext-explore');
  });
});

describe('deep-research skill — orchestration contract', () => {
  const body = () => loadSkill().content;

  it('is recall-driven (recall is the seed engine of every wave)', () => {
    expect(body()).toMatch(/dreamcontext memory recall/);
  });

  it('is federation-aware (spans connected peer vaults)', () => {
    const b = body();
    expect(b).toMatch(/--connected|--all-vaults|--vault/);
    expect(b.toLowerCase()).toContain('peer');
  });

  it('reuses dreamcontext-explore as the searcher rather than a new sub-agent', () => {
    expect(body()).toContain('dreamcontext-explore');
  });

  it('covers fan-out → verify → synthesize, with adversarial verification', () => {
    const b = body().toLowerCase();
    expect(b).toContain('fan-out');
    expect(b).toContain('verif'); // verify / verification
    expect(b).toContain('synthes'); // synthesize / synthesis
    expect(b).toContain('adversarial');
  });

  it('mandates citations in the output contract (not a raw hit dump)', () => {
    const b = body().toLowerCase();
    expect(b).toContain('cit'); // citation / cited
    expect(b).toContain('output contract');
  });

  it('declares itself read-only (a reader, not a writer)', () => {
    expect(body().toLowerCase()).toContain('read-only');
  });
});
