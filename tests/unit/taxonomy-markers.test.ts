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
});

// ── src/templates/init/taxonomy.md markers ───────────────────────────────────

describe('src/templates/init/taxonomy.md markers', () => {
  const content = readFileSync(
    join(ROOT, 'src', 'templates', 'init', 'taxonomy.md'),
    'utf-8',
  );

  it("has '## Naming Rules' section", () => {
    expect(content).toContain('## Naming Rules');
  });

  it("has '## Aliases' section", () => {
    expect(content).toContain('## Aliases');
  });

  it('contains no stray {{...}} template tokens', () => {
    // The init replaceTokens loop processes {{TOKEN}} patterns;
    // taxonomy.md must not have any (it has no project-specific tokens).
    expect(content).not.toMatch(/\{\{[^}]+\}\}/);
  });
});

// ── skill/SKILL.md markers ───────────────────────────────────────────────────

describe('skill/SKILL.md markers', () => {
  const content = readFileSync(join(ROOT, 'skill', 'SKILL.md'), 'utf-8');

  it("has the 'Tag before you create.' operational rule", () => {
    expect(content).toContain('Tag before you create.');
  });

  it('has a pointer to core/taxonomy.md in the knowledge section', () => {
    expect(content).toContain('core/taxonomy.md');
  });

  it('has a pointer to dreamcontext taxonomy vocab command', () => {
    expect(content).toContain('dreamcontext taxonomy vocab');
  });
});
