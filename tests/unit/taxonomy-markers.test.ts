/**
 * Marker tests: verify that required behavior headings / labels exist in the
 * correct files. These are exact-string presence checks — no logic, just guard
 * against accidental deletion of critical behavioral markers.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');

// ── sleep-product.md markers ─────────────────────────────────────────────────

describe('agents/sleep-product.md markers', () => {
  const content = readFileSync(join(ROOT, 'agents', 'sleep-product.md'), 'utf-8');

  it("has the '### Pass C — Taxonomy maintenance' heading", () => {
    // Pass A and Pass B use ### level; Pass C must be at the same level.
    expect(content).toContain('### Pass C — Taxonomy maintenance');
  });

  it('has a Taxonomy return sub-section in the report block', () => {
    expect(content).toContain('### Taxonomy');
  });

  it('has the B3 taxonomy vocab pointer rewrite', () => {
    // B3 should reference taxonomy vocab
    expect(content).toContain('taxonomy vocab');
  });

  it('Pass C contains the taxonomy alias CLI command', () => {
    // Agents must use CLI to mutate vocabulary, not edit markdown directly.
    expect(content).toContain('taxonomy alias');
  });
});

// ── skill/SKILL.md markers ───────────────────────────────────────────────────

describe('skill/SKILL.md markers', () => {
  const content = readFileSync(join(ROOT, 'skill', 'SKILL.md'), 'utf-8');

  it("has the 'Tag before you create.' operational rule", () => {
    expect(content).toContain('Tag before you create.');
  });

  it('has a pointer to dreamcontext taxonomy vocab command', () => {
    expect(content).toContain('dreamcontext taxonomy vocab');
  });
});

// ── skill/references/knowledge-and-recall.md markers ─────────────────────────
// The taxonomy depth lives in the knowledge-and-recall reference (progressive
// disclosure); the always-loaded SKILL.md names the capability + points here.

describe('skill/references/knowledge-and-recall.md markers', () => {
  const content = readFileSync(
    join(ROOT, 'skill', 'references', 'knowledge-and-recall.md'),
    'utf-8',
  );

  it('has a pointer to core/taxonomy.json', () => {
    expect(content).toContain('core/taxonomy.json');
  });

  it('documents the taxonomy vocab + alias commands', () => {
    expect(content).toContain('taxonomy vocab');
    expect(content).toContain('taxonomy alias');
  });
});
