import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  listSections,
  readSection,
  insertToSection,
  sectionHeadingName,
} from '../../src/lib/markdown.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `ac-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const SAMPLE_MD = `---
name: test
---

## Active Memory

<!-- LIFO: newest entries at top -->

### 2026-02-24 - Session One
- Did something.

## Technical Decisions

- Chose TypeScript over JavaScript.

## Known Issues

- None yet.
`;

describe('markdown', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('listSections', () => {
    it('lists all ## sections', () => {
      const file = join(tmpDir, 'test.md');
      writeFileSync(file, SAMPLE_MD);
      const sections = listSections(file);
      expect(sections).toEqual(['Active Memory', 'Technical Decisions', 'Known Issues']);
    });

    it('returns empty array for file with no sections', () => {
      const file = join(tmpDir, 'no-sections.md');
      writeFileSync(file, '---\nname: test\n---\n\nJust some text.\n');
      const sections = listSections(file);
      expect(sections).toEqual([]);
    });

    it('ignores ### sub-headers (not ##)', () => {
      const file = join(tmpDir, 'sub.md');
      writeFileSync(file, '---\nname: test\n---\n\n## Main\n\n### Sub\n\nContent.\n');
      const sections = listSections(file);
      expect(sections).toEqual(['Main']);
    });

    it('ignores # top-level headers', () => {
      const file = join(tmpDir, 'h1.md');
      writeFileSync(file, '---\nname: test\n---\n\n# Title\n\n## Section One\n\nContent.\n');
      const sections = listSections(file);
      expect(sections).toEqual(['Section One']);
    });

    it('handles file with only frontmatter', () => {
      const file = join(tmpDir, 'fm-only.md');
      writeFileSync(file, '---\nname: test\n---\n');
      const sections = listSections(file);
      expect(sections).toEqual([]);
    });
  });

  describe('readSection', () => {
    it('reads content of a named section', () => {
      const file = join(tmpDir, 'test.md');
      writeFileSync(file, SAMPLE_MD);
      const content = readSection(file, 'Technical Decisions');
      expect(content).toContain('Chose TypeScript over JavaScript');
    });

    it('returns null for non-existent section', () => {
      const file = join(tmpDir, 'test.md');
      writeFileSync(file, SAMPLE_MD);
      expect(readSection(file, 'Not A Section')).toBeNull();
    });

    it('is case-insensitive', () => {
      const file = join(tmpDir, 'test.md');
      writeFileSync(file, SAMPLE_MD);
      const content = readSection(file, 'technical decisions');
      expect(content).toContain('Chose TypeScript');
    });

    it('ignores special characters in name matching', () => {
      const file = join(tmpDir, 'test.md');
      writeFileSync(file, SAMPLE_MD);
      const content = readSection(file, 'Known-Issues');
      expect(content).toContain('None yet');
    });

    it('includes sub-headers in section content', () => {
      const file = join(tmpDir, 'test.md');
      writeFileSync(file, SAMPLE_MD);
      const content = readSection(file, 'Active Memory');
      expect(content).toContain('### 2026-02-24');
      expect(content).toContain('Did something');
    });

    it('reads last section correctly (no next section boundary)', () => {
      const file = join(tmpDir, 'test.md');
      writeFileSync(file, SAMPLE_MD);
      const content = readSection(file, 'Known Issues');
      expect(content).toContain('None yet');
    });
  });

  describe('insertToSection', () => {
    it('inserts at top (LIFO) by default', () => {
      const file = join(tmpDir, 'test.md');
      writeFileSync(file, SAMPLE_MD);
      insertToSection(file, 'Active Memory', '### 2026-02-25 - Session Two\n- New entry.');
      const content = readSection(file, 'Active Memory');
      // New entry should come before old entry
      const newIdx = content!.indexOf('Session Two');
      const oldIdx = content!.indexOf('Session One');
      expect(newIdx).toBeLessThan(oldIdx);
    });

    it('inserts at bottom when position=bottom', () => {
      const file = join(tmpDir, 'test.md');
      writeFileSync(file, SAMPLE_MD);
      insertToSection(file, 'Known Issues', '- New issue found.', 'bottom');
      const content = readSection(file, 'Known Issues');
      const oldIdx = content!.indexOf('None yet');
      const newIdx = content!.indexOf('New issue found');
      expect(newIdx).toBeGreaterThan(oldIdx);
    });

    it('throws for non-existent section', () => {
      const file = join(tmpDir, 'test.md');
      writeFileSync(file, SAMPLE_MD);
      expect(() =>
        insertToSection(file, 'Nonexistent', 'content'),
      ).toThrow('Section "Nonexistent" not found');
    });

    it('preserves frontmatter after insertion', () => {
      const file = join(tmpDir, 'test.md');
      writeFileSync(file, SAMPLE_MD);
      insertToSection(file, 'Technical Decisions', '- New decision.');
      const raw = readFileSync(file, 'utf-8');
      expect(raw).toContain('name: test');
    });

    it('skips HTML comments when inserting at top', () => {
      const file = join(tmpDir, 'test.md');
      writeFileSync(file, SAMPLE_MD);
      insertToSection(file, 'Active Memory', '### New Entry');
      const content = readSection(file, 'Active Memory');
      // HTML comment should still exist
      expect(readFileSync(file, 'utf-8')).toContain('<!-- LIFO');
    });

    it('handles inserting multiline content', () => {
      const file = join(tmpDir, 'test.md');
      writeFileSync(file, SAMPLE_MD);
      const multiLine = '### Session\n- Line one\n- Line two\n- Line three';
      insertToSection(file, 'Technical Decisions', multiLine);
      const content = readSection(file, 'Technical Decisions');
      expect(content).toContain('Line one');
      expect(content).toContain('Line two');
      expect(content).toContain('Line three');
    });

    it('works on empty sections', () => {
      const file = join(tmpDir, 'empty-sec.md');
      writeFileSync(file, '---\nname: test\n---\n\n## Empty Section\n\n## Next Section\n\nContent.\n');
      insertToSection(file, 'Empty Section', '- First entry');
      const content = readSection(file, 'Empty Section');
      expect(content).toContain('First entry');
    });
  });
});

describe('sectionHeadingName: the one rule every section reader shares', () => {
  // The rule as it was written for years; the helper must decide every line the same way.
  const regex = (line: string): string | null => {
    const m = line.match(/^(#{2})\s+(.+)$/);
    return m ? m[2].trim() : null;
  };

  it('agrees with /^(#{2})\\s+(.+)$/ on every short line over a hostile alphabet', () => {
    const alphabet = ['#', ' ', '\t', '\r', '\u2028', 'a', '-', '\u00a0'];
    let seed = 7;
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const fixed = ['## Changelog', '## Changelog\r', '##', '## ', '##  ', '##\tA', '###  A', '## \r x', '## \rx\r', ' ## A', '##A', '## a\u2028b', '## \u2028 b'];
    const lines = [...fixed];
    for (let i = 0; i < 20000; i++) {
      let l = '##';
      const len = rand(9);
      for (let k = 0; k < len; k++) l += alphabet[rand(alphabet.length)];
      lines.push(rand(4) === 0 ? l.slice(rand(3)) : l);
    }
    for (const l of lines) expect(sectionHeadingName(l), JSON.stringify(l)).toBe(regex(l));
  });

  it('decides a 100k-character line in linear time (the regex took 1.9 s at 20k)', () => {
    for (const line of [`## ${' '.repeat(100_000)}\rx\r`, `##${' \t'.repeat(50_000)}\u2028`, `## ${'a'.repeat(100_000)}\r`]) {
      const t = performance.now();
      sectionHeadingName(line);
      expect(performance.now() - t).toBeLessThan(50);
    }
  });
});
