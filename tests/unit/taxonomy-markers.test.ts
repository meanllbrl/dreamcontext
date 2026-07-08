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

  // Lab docs went missing from skill/ once already (v0.11.0 shipped the code with
  // zero skill docs and agents misrouted "create insight" to knowledge create).
  // These markers make that failure loud instead of silent.
  it('has the Entity Router section', () => {
    expect(content).toContain('## Entity Router');
  });

  it('has a Lab / Insights capabilities row', () => {
    expect(content).toContain('**Lab / Insights**');
  });

  it('names the lab create command for insights', () => {
    expect(content).toContain('dreamcontext lab create');
  });

  // A real session routed "insight oluşturalım" (Turkish) to a prose analysis and
  // then designed an external dashboard for what `lab create` already covers.
  // These markers pin the two router rules that prevent that.
  it('declares entity nouns as language-independent reserved words', () => {
    expect(content).toContain('Entity nouns are reserved words — in ANY language.');
  });

  it("has the 'don't rebuild what the brain already has' rule", () => {
    expect(content).toContain("Don't rebuild what the brain already has.");
  });
});

// ── skill/references lab markers ─────────────────────────────────────────────

describe('skill/references lab doc markers', () => {
  it('cli-reference.md documents the lab verbs', () => {
    const content = readFileSync(join(ROOT, 'skill', 'references', 'cli-reference.md'), 'utf-8');
    expect(content).toContain('lab sync');
    expect(content).toContain('lab credentials set');
  });

  it('tasks-and-features.md has the insight-capture protocol', () => {
    const content = readFileSync(join(ROOT, 'skill', 'references', 'tasks-and-features.md'), 'utf-8');
    expect(content).toContain('Insight capture (in-session — ASK, never auto-create)');
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

// ── brain-sync.md markers ────────────────────────────────────────────────────
// Brain-sync docs lagged the code once: full-repo mode + cross-OS setup shipped
// with zero skill coverage, so an agent could neither explain nor guide GitHub
// sync across machines. These markers make a silent doc regression loud.

describe('skill/references/brain-sync.md markers', () => {
  const content = readFileSync(
    join(ROOT, 'skill', 'references', 'brain-sync.md'),
    'utf-8',
  );

  it('documents the two sync modes (full-repo / in-tree)', () => {
    expect(content).toContain('## The two sync modes');
    expect(content).toContain('full-repo');
    expect(content).toContain('in-tree');
    // separate mode was removed — it must not creep back into the doc.
    expect(content).not.toContain('brain init');
    expect(content).not.toContain('brain platform');
  });

  it('has the cross-machine / cross-OS setup section', () => {
    expect(content).toContain('## Cross-machine / cross-OS setup');
    expect(content).toContain('core.autocrlf false'); // Windows CRLF gotcha
    expect(content).toContain('enclosing-repo trap'); // the git-root footgun
  });

  it('documents token resolution + that gh/credential helpers are NOT used', () => {
    expect(content).toContain('resolveBrainSyncToken');
    expect(content).toContain('config github-token');
  });

  it('has the silent-failure troubleshooting playbook', () => {
    expect(content).toContain('When sync is');
    expect(content).toContain('brain sync --push-only');
  });
});

describe('skill/SKILL.md brain-sync routing', () => {
  const content = readFileSync(join(ROOT, 'skill', 'SKILL.md'), 'utf-8');
  it('routes the shared-brain capability to brain-sync.md', () => {
    expect(content).toContain('references/brain-sync.md');
  });
});

describe('skill/references/sleep.md brain-sync step', () => {
  const content = readFileSync(join(ROOT, 'skill', 'references', 'sleep.md'), 'utf-8');
  it('documents that sleep done runs brain sync', () => {
    expect(content).toContain('Brain sync also fires here');
  });
});
