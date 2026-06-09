import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isPlaceholderLine,
  formatListItems,
  insertToSection,
  readSection,
} from '../../src/lib/markdown.js';
import { prepareSectionInsert, SECTION_MAP } from '../../src/lib/section-insert.js';

describe('isPlaceholderLine', () => {
  it('detects whole-line parentheticals (optionally bulleted)', () => {
    expect(isPlaceholderLine('(To be defined)')).toBe(true);
    expect(isPlaceholderLine('- (Specific, testable conditions for this feature)')).toBe(true);
    expect(isPlaceholderLine('(How this feature is wired. Key files...)')).toBe(true);
  });

  it('detects user-story skeletons with bracketed tokens', () => {
    expect(isPlaceholderLine('- [ ] As a [user], I want [action] so that [outcome]')).toBe(true);
    expect(isPlaceholderLine('- [ ] As a [role], I can [action], so that [outcome]')).toBe(true);
  });

  it('detects task acceptance-criteria skeleton', () => {
    expect(isPlaceholderLine('- [ ] First criterion (matches node A1 in Workflow)')).toBe(true);
  });

  it('does NOT flag real content', () => {
    expect(isPlaceholderLine('- [ ] As a dev, I can filter tasks')).toBe(false);
    expect(isPlaceholderLine('Returns 200 with paginated results')).toBe(false);
    expect(isPlaceholderLine('We chose fetch over axios (no new dep)')).toBe(false); // has trailing text
  });

  it('ignores blanks and comments', () => {
    expect(isPlaceholderLine('')).toBe(false);
    expect(isPlaceholderLine('   ')).toBe(false);
    expect(isPlaceholderLine('<!-- LIFO -->')).toBe(false);
  });
});

describe('formatListItems', () => {
  it('wraps plain lines as checkbox items', () => {
    expect(formatListItems('As a dev, I can do X', true)).toBe('- [ ] As a dev, I can do X');
  });

  it('wraps as plain bullets when checkbox=false', () => {
    expect(formatListItems('a point', false)).toBe('- a point');
  });

  it('leaves existing bullets/checkboxes untouched', () => {
    expect(formatListItems('- already a bullet', true)).toBe('- already a bullet');
    expect(formatListItems('- [ ] already a checkbox', true)).toBe('- [ ] already a checkbox');
    expect(formatListItems('* star bullet', true)).toBe('* star bullet');
  });

  it('formats each non-empty line of multi-line content', () => {
    expect(formatListItems('one\ntwo', true)).toBe('- [ ] one\n- [ ] two');
  });
});

describe('prepareSectionInsert', () => {
  it('returns null for an unknown section', () => {
    expect(prepareSectionInsert('bogus', 'x', '2026-01-01')).toBeNull();
  });

  it('formats user_stories / acceptance_criteria as checkbox items (bottom, replace)', () => {
    const us = prepareSectionInsert('user_stories', 'As a dev, I can X', '2026-01-01')!;
    expect(us).toMatchObject({ sectionName: 'User Stories', position: 'bottom', replacePlaceholders: true });
    expect(us.content).toBe('- [ ] As a dev, I can X');

    const ac = prepareSectionInsert('acceptance_criteria', 'Returns 200', '2026-01-01')!;
    expect(ac.content).toBe('- [ ] Returns 200');
  });

  it('dates and prepends changelog / constraints (top)', () => {
    const cl = prepareSectionInsert('changelog', 'did a thing', '2026-02-02')!;
    expect(cl).toMatchObject({ sectionName: 'Changelog', position: 'top', replacePlaceholders: false });
    expect(cl.content).toBe('### 2026-02-02 - Update\n- did a thing');

    const ct = prepareSectionInsert('constraints', 'no axios', '2026-02-02')!;
    expect(ct).toMatchObject({ position: 'top', replacePlaceholders: false });
    expect(ct.content).toBe('- **[2026-02-02]** no axios');
  });

  it('passes other sections through at bottom', () => {
    const notes = prepareSectionInsert('notes', 'edge case', '2026-01-01')!;
    expect(notes).toMatchObject({ sectionName: 'Notes', content: 'edge case', position: 'bottom' });
  });

  it('every SECTION_MAP key prepares without error', () => {
    for (const key of Object.keys(SECTION_MAP)) {
      expect(prepareSectionInsert(key, 'x', '2026-01-01')).not.toBeNull();
    }
  });
});

describe('insertToSection (placeholder + spacing)', () => {
  let dir: string;
  let file: string;

  const FEATURE = `---
id: "x"
---

## Why

x

## User Stories

- [ ] As a [user], I want [action] so that [outcome]

## Acceptance Criteria

- (Specific, testable conditions for this feature to be complete)

## Notes

(Edge cases, open questions, future considerations.)

## Changelog
<!-- LIFO -->

### 2026-01-01 - Created
- created
`;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dc-insert-'));
    file = join(dir, 'demo.md');
    writeFileSync(file, FEATURE, 'utf-8');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('replaces a placeholder-only body on first insert', () => {
    insertToSection(file, 'User Stories', '- [ ] As a dev, I can X', 'bottom', true, true);
    const body = readSection(file, 'User Stories')!;
    expect(body).toContain('As a dev, I can X');
    expect(body).not.toContain('[user]');
    expect(body).not.toContain('[action]');
  });

  it('replaces the parenthetical AC placeholder', () => {
    insertToSection(file, 'Acceptance Criteria', '- [ ] Returns 200', 'bottom', true, true);
    const body = readSection(file, 'Acceptance Criteria')!;
    expect(body).toContain('Returns 200');
    expect(body).not.toContain('Specific, testable');
  });

  it('keeps a blank line before the next header (no glued headers)', () => {
    insertToSection(file, 'Notes', 'a note', 'bottom', true, true);
    const raw = readFileSync(file, 'utf-8');
    // The inserted note must not be glued directly to the next "##" header.
    expect(raw).not.toMatch(/a note\n## /);
    expect(raw).toMatch(/a note\n+\n## Changelog/);
  });

  it('appends a second item without removing the first', () => {
    insertToSection(file, 'User Stories', '- [ ] first real', 'bottom', true, true);
    insertToSection(file, 'User Stories', '- [ ] second real', 'bottom', true, true);
    const body = readSection(file, 'User Stories')!;
    expect(body).toContain('first real');
    expect(body).toContain('second real');
    expect(body).not.toContain('[user]');
  });

  it('does not collapse adjacent blank lines into glue (single blank kept)', () => {
    insertToSection(file, 'Notes', 'a note', 'bottom', true, true);
    const raw = readFileSync(file, 'utf-8');
    // No run of 3+ newlines (= 2+ blank lines) introduced around the insert.
    expect(raw).not.toMatch(/a note\n\n\n+## /);
  });
});
