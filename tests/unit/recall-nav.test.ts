/**
 * Unit tests for recallNavTarget — the pure mapping from a RecallHit to the
 * dashboard page + slug that renders it.
 *
 * Key requirement: knowledge hits carry a folder-qualified slug derived from
 * `hit.path`, NOT from `hit.slug`.  A hit at `knowledge/decisions/foo.md`
 * must produce `{ page: 'knowledge', slug: 'decisions/foo' }`, not `{ slug: 'foo' }`.
 */

import { describe, it, expect } from 'vitest';
import { recallNavTarget } from '../../dashboard/src/lib/recallNav.js';

// Minimal structural type matching RecallHit (type-only import would be erased
// anyway; we define the shape inline so this file stays self-contained and
// importable without dashboard's React context).
interface MinHit {
  type: 'knowledge' | 'feature' | 'task' | 'memory' | 'changelog';
  slug: string;
  path: string;
  title: string;
  description: string;
  tags: string[];
  snippet: string;
  body: string;
  score: number;
  rankScore: number;
}

function hit(type: MinHit['type'], slug: string, path: string): MinHit {
  return { type, slug, path, title: '', description: '', tags: [], snippet: '', body: '', score: 1, rankScore: 1 };
}

describe('recallNavTarget', () => {
  describe('knowledge', () => {
    it('top-level knowledge file → page=knowledge, slug=basename-no-ext', () => {
      const h = hit('knowledge', 'auth-system', '/vault/_dream_context/knowledge/auth-system.md');
      expect(recallNavTarget(h)).toEqual({ page: 'knowledge', slug: 'auth-system' });
    });

    it('subfolder knowledge file → folder-qualified slug (NOT basename)', () => {
      const h = hit('knowledge', 'foo', '/vault/_dream_context/knowledge/decisions/foo.md');
      expect(recallNavTarget(h)).toEqual({ page: 'knowledge', slug: 'decisions/foo' });
    });

    it('deeply nested knowledge file → full path from knowledge/ onward', () => {
      const h = hit('knowledge', 'bar', '/vault/_dream_context/knowledge/arch/deep/bar.md');
      expect(recallNavTarget(h)).toEqual({ page: 'knowledge', slug: 'arch/deep/bar' });
    });

    it('knowledge slug from path ignores hit.slug value', () => {
      // hit.slug may be stale or basename-only; path is authoritative.
      const h = hit('knowledge', 'wrong-slug', '/vault/_dream_context/knowledge/decisions/real-name.md');
      const result = recallNavTarget(h);
      expect(result.page).toBe('knowledge');
      expect(result.slug).toBe('decisions/real-name');
      expect(result.slug).not.toBe('wrong-slug');
    });
  });

  describe('feature', () => {
    // Feature PRDs are typed knowledge (knowledge/features/**) — a feature hit
    // opens the Knowledge page at the path-derived, folder-qualified slug.
    it('feature hit → page=knowledge, slug=features/<basename> from hit.path', () => {
      const h = hit('feature', 'agent-drop', '/vault/_dream_context/knowledge/features/agent-drop.md');
      expect(recallNavTarget(h)).toEqual({ page: 'knowledge', slug: 'features/agent-drop' });
    });

    it('feature slug from path ignores hit.slug value', () => {
      const h = hit('feature', 'wrong-slug', '/vault/_dream_context/knowledge/features/real-name.md');
      expect(recallNavTarget(h)).toEqual({ page: 'knowledge', slug: 'features/real-name' });
    });
  });

  describe('task', () => {
    it('task hit → page=tasks, slug=hit.slug', () => {
      const h = hit('task', 'feat-sleepy-agent-surface-ux-redesign', '/vault/_dream_context/state/feat-sleepy-agent-surface-ux-redesign.md');
      expect(recallNavTarget(h)).toEqual({ page: 'tasks', slug: 'feat-sleepy-agent-surface-ux-redesign' });
    });
  });

  describe('changelog', () => {
    it('changelog hit → page=core, slug=containing core filename (CHANGELOG.json)', () => {
      const h = hit('changelog', 'some-entry', '/vault/_dream_context/core/CHANGELOG.json');
      expect(recallNavTarget(h)).toEqual({ page: 'core', slug: 'CHANGELOG.json' });
    });
  });

  describe('memory', () => {
    it('memory hit → page=core, slug=containing core filename (2.memory.md)', () => {
      const h = hit('memory', 'memory#3', '/vault/_dream_context/core/2.memory.md');
      expect(recallNavTarget(h)).toEqual({ page: 'core', slug: '2.memory.md' });
    });

    it('bookmark-backed memory hit (state/.sleep.json) → page=core, empty slug (default file)', () => {
      const h = hit('memory', 'bookmark#abc', '/vault/_dream_context/state/.sleep.json');
      expect(recallNavTarget(h)).toEqual({ page: 'core', slug: '' });
    });
  });
});
