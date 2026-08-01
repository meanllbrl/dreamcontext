import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  compressMarkdownBlock,
  packToCharBudget,
  compressedCoreFile,
  shrinkBody,
  type CompressOptions,
} from '../../src/lib/snapshot-compress.js';
import { CORE_L1, CORE_L2, CORE_L3 } from '../../src/lib/snapshot-caps.js';

const RUNGS: Array<[string, CompressOptions]> = [
  ['L1', CORE_L1],
  ['L2', CORE_L2],
  ['L3', CORE_L3],
];

describe('compressMarkdownBlock — structure survives every rung', () => {
  it('passes heading lines through verbatim at every rung', () => {
    const block = ['# Top', '## Section', '### Sub', '###### Deep'].join('\n');
    for (const [name, opts] of RUNGS) {
      expect(compressMarkdownBlock(block, opts), name).toBe(block);
    }
  });

  // PUBLISHED CONTRACT. Three snapshot fixtures in other suites build an
  // incompressible soul out of heading lines to force the demotion ladder to its
  // floors without any opt-in feature. If this ever stops holding, those fixtures
  // silently start passing for the wrong reason — so it is asserted directly.
  it('leaves a block built only of heading lines byte-identical at L1, L2 and L3', () => {
    const headings = Array.from(
      { length: 50 },
      (_, i) => `## Rule ${i} — ${'x'.repeat(40)}`,
    ).join('\n');
    for (const [name, opts] of RUNGS) {
      expect(compressMarkdownBlock(headings, opts), name).toBe(headings);
    }
  });

  it('keeps the original bullet marker', () => {
    const block = ['- dash item', '* star item', '+ plus item'].join('\n');
    const out = compressMarkdownBlock(block, CORE_L1);
    expect(out).toBe(block);
  });

  it('keeps ordered-list markers and their numbers', () => {
    // The largest live soul writes its binding rules as an ordered list; a
    // compressor that only understands `- ` renders them as bare `1.` `2.` lines.
    const block = ['1. **First rule** - why it exists.', '2) **Second rule** - why.'].join('\n');
    const out = compressMarkdownBlock(block, CORE_L3);
    expect(out).toBe(['1. **First rule**', '2) **Second rule**'].join('\n'));
  });

  it('preserves indentation of nested items', () => {
    const block = ['- parent item', '    - nested child item'].join('\n');
    const out = compressMarkdownBlock(block, CORE_L1);
    expect(out).toContain('\n    - nested child item');
  });

  it('folds indented continuation lines into the item they belong to', () => {
    const block = ['- **Rule** first sentence', '  continued here.', '  and more.'].join('\n');
    const out = compressMarkdownBlock(block, CORE_L1);
    expect(out.split('\n')).toHaveLength(1);
    expect(out).toBe('- **Rule** first sentence continued here.');
  });

  it('folds unindented continuation lines into the item too', () => {
    const block = ['- **Rule** first sentence', 'wrapped without indent.'].join('\n');
    const out = compressMarkdownBlock(block, CORE_L1);
    expect(out).toBe('- **Rule** first sentence wrapped without indent.');
  });

  it('ends an item at a blank line', () => {
    const block = ['- item one', '', 'A separate paragraph.'].join('\n');
    const out = compressMarkdownBlock(block, CORE_L1);
    expect(out).toBe(['- item one', '', 'A separate paragraph.'].join('\n'));
  });

  it('passes a mid-file thematic break through verbatim', () => {
    const block = ['## A', '', 'text', '', '---', '', '## B'].join('\n');
    const out = compressMarkdownBlock(block, CORE_L3);
    expect(out.split('\n')).toContain('---');
  });

  it('treats table rows as items and leaves short rows intact', () => {
    const block = ['| col | col |', '| --- | --- |', '| a | b |'].join('\n');
    const out = compressMarkdownBlock(block, CORE_L1);
    expect(out).toBe(block);
  });

  it('keeps blockquote prefixes and caps the quoted text at paraChars', () => {
    const block = `> ${'word '.repeat(60).trim()}`;
    const out = compressMarkdownBlock(block, { itemChars: 40, paraChars: 50 });
    expect(out.startsWith('> ')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(2 + 50);
    expect(out.endsWith('…')).toBe(true);
  });

  it('keeps fenced code verbatim unless titleOnly, where it collapses to a placeholder', () => {
    const block = ['```ts', 'const a = 1;', 'const b = 2;', '```'].join('\n');
    expect(compressMarkdownBlock(block, CORE_L1)).toBe(block);
    expect(compressMarkdownBlock(block, CORE_L3)).toBe(
      '`(code block, 2 lines — see the source file)`',
    );
  });

  it('never loses the contents of an unterminated fence', () => {
    const block = ['```ts', 'const a = 1;'].join('\n');
    expect(compressMarkdownBlock(block, CORE_L3)).toBe(block);
  });

  it('collapses runs of blank lines and trims the result', () => {
    const block = ['', '', '## A', '', '', '', '## B', '', ''].join('\n');
    expect(compressMarkdownBlock(block, CORE_L1)).toBe('## A\n\n## B');
  });

  it('returns an empty string for empty input', () => {
    expect(compressMarkdownBlock('', CORE_L1)).toBe('');
    expect(compressMarkdownBlock('\n\n\n', CORE_L3)).toBe('');
  });
});

describe('compressMarkdownBlock — YAML frontmatter', () => {
  const FM_BODY = ['---', 'name: "dreamcontext"', 'type: soul', 'updated: "2026-06-14"', '---', '', '## Project Identity', '', 'Some prose.'].join('\n');

  it('strips a leading frontmatter block at every rung', () => {
    for (const [name, opts] of RUNGS) {
      const out = compressMarkdownBlock(FM_BODY, opts);
      expect(out, name).not.toContain('name:');
      expect(out, name).not.toContain('type: soul');
      expect(out, name).not.toContain('updated:');
      expect(out.startsWith('## Project Identity'), name).toBe(true);
    }
  });

  it('strips a CRLF frontmatter block too', () => {
    const crlf = '---\r\nname: X\r\ntype: soul\r\n---\r\n\r\n## Heading\r\n';
    const out = compressMarkdownBlock(crlf, CORE_L1);
    expect(out).not.toContain('name: X');
    expect(out).not.toContain('type: soul');
    expect(out).toContain('## Heading');
  });

  it('only strips frontmatter at position 0 — a later --- block stays', () => {
    const block = ['## Heading', '', '---', 'name: not-frontmatter', '---', ''].join('\n');
    const out = compressMarkdownBlock(block, CORE_L1);
    expect(out.split('\n').filter((l) => l === '---')).toHaveLength(2);
    expect(out).toContain('name: not-frontmatter');
  });
});

describe('compressMarkdownBlock — item compression', () => {
  it('keeps a bold lead whole even when it alone exceeds itemChars', () => {
    const lead = '**A deliberately long behaviour-binding rule name that will not fit**';
    const block = `- ${lead}: the rationale that follows is long enough to be dropped.`;
    const out = compressMarkdownBlock(block, { itemChars: 10, paraChars: 10 });
    expect(out).toBe(`- ${lead}`);
  });

  it('keeps only the first sentence of an item', () => {
    const block = '- Rule one applies here. Rule two is extra. Rule three too.';
    expect(compressMarkdownBlock(block, { itemChars: 200, paraChars: 200 }))
      .toBe('- Rule one applies here.');
  });

  it('caps an over-long remainder at a word boundary and marks the elision', () => {
    const block = `- ${'alpha '.repeat(40).trim()}`;
    const out = compressMarkdownBlock(block, { itemChars: 50, paraChars: 50 });
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toContain('alph…'); // cut at a space, never mid-word
    expect(out.length).toBeLessThanOrEqual(2 + 50);
  });

  it('titleOnly keeps just the bold lead and drops the sentence remainder', () => {
    const block = '- **Never bundle runtime deps** the tsup config externalizes them deliberately.';
    expect(compressMarkdownBlock(block, CORE_L3)).toBe('- **Never bundle runtime deps**');
  });

  it('titleOnly splits on a colon followed by whitespace', () => {
    const block = '- Measurement source of truth: the cohort table, not raw retention.';
    expect(compressMarkdownBlock(block, CORE_L3)).toBe('- Measurement source of truth');
  });

  it('titleOnly splits on an em-dash or hyphen clause separator', () => {
    expect(compressMarkdownBlock('- Value over features — challenge low-RICE asks.', CORE_L3))
      .toBe('- Value over features');
    expect(compressMarkdownBlock('- Value over features - challenge low-RICE asks.', CORE_L3))
      .toBe('- Value over features');
  });

  it('titleOnly never splits on a bare period (versions, abbreviations)', () => {
    const version = compressMarkdownBlock('- Current version is v0.18.0 shipped Tuesday', CORE_L3);
    expect(version).toContain('v0.18.0');
    const abbrev = compressMarkdownBlock('- Reuse proven features e.g. the quiz funnel shell', CORE_L3);
    expect(abbrev).toContain('e.g.');
  });

  it('titleOnly does not split inside a URL scheme', () => {
    // A scheme colon has no trailing space; splitting there produced
    // `Flagship kitUP at https` in an early prototype.
    const out = compressMarkdownBlock('- Flagship kitUP at https://kitup.app is the revenue driver', CORE_L3);
    expect(out).toContain('https://kitup.app');
    expect(out).not.toMatch(/https…?$/);
  });

  it('joins a multi-line paragraph before compressing it at paraChars', () => {
    const block = ['First line of prose.', 'Second line of prose.', 'Third line.'].join('\n');
    expect(compressMarkdownBlock(block, { itemChars: 200, paraChars: 200 }))
      .toBe('First line of prose.');
  });
});

// Exported so callers outside a markdown block can elide identically — the
// demoted knowledge index runs each pinned entry's `description` through it.
// Previously covered only transitively via compressMarkdownBlock.
describe('shrinkBody', () => {
  it('returns an empty string for empty or whitespace-only input', () => {
    expect(shrinkBody('', 100, false)).toBe('');
    expect(shrinkBody('   \n\t ', 100, true)).toBe('');
  });

  it('normalizes internal whitespace and newlines before measuring', () => {
    expect(shrinkBody('a\n  b\t\tc', 100, false)).toBe('a b c');
  });

  it('stops at the first sentence boundary and keeps the terminator', () => {
    expect(shrinkBody('First one. Second one. Third.', 200, false)).toBe('First one.');
    expect(shrinkBody('Is it? Yes.', 200, false)).toBe('Is it?');
    expect(shrinkBody('Stop! More.', 200, false)).toBe('Stop!');
  });

  it('returns the whole text when there is no sentence terminator and it fits', () => {
    expect(shrinkBody('no terminator here', 100, false)).toBe('no terminator here');
  });

  it('caps at a word boundary and marks the elision', () => {
    const out = shrinkBody('alpha bravo charlie delta echo foxtrot', 20, false);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out.endsWith('…')).toBe(true);
    expect(out).toBe('alpha bravo charlie…');
  });

  it('reserves room for a bold lead when capping the remainder', () => {
    // cap 30 - lead(10) - 1 separator = 19 chars of room for the sentence.
    const out = shrinkBody('**LEAD-01**: alpha bravo charlie delta', 30, false);
    expect(out.startsWith('**LEAD-01** ')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(30);
  });

  it('returns the bold lead alone rather than a stub when no room remains', () => {
    const lead = '**A lead that is already longer than the cap**';
    const out = shrinkBody(`${lead}: some rationale`, 10, false);
    expect(out).toBe(lead);
    expect(out.endsWith('…')).toBe(false);
  });

  it('titleOnly returns just the bold lead, uncapped', () => {
    const lead = '**REUSE BEFORE CREATE — RULE #1, ABSOLUTE, ALL CODE**';
    expect(shrinkBody(`${lead} - applies to everything.`, 20, true)).toBe(lead);
  });

  it('titleOnly splits an unbolded item at its first clause separator', () => {
    expect(shrinkBody('Analytics never blocks: business logic first', 200, true))
      .toBe('Analytics never blocks');
    expect(shrinkBody('Analytics never blocks — business logic first', 200, true))
      .toBe('Analytics never blocks');
    expect(shrinkBody('Analytics never blocks - business logic first', 200, true))
      .toBe('Analytics never blocks');
  });

  it('titleOnly caps when there is no clause separator at all', () => {
    const out = shrinkBody('alpha bravo charlie delta echo foxtrot golf', 20, true);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out.endsWith('…')).toBe(true);
  });

  it('titleOnly never splits on a bare period or a URL scheme colon', () => {
    expect(shrinkBody('Pinned at v0.18.0 for now', 200, true)).toBe('Pinned at v0.18.0 for now');
    expect(shrinkBody('Docs at https://kitup.app today', 200, true)).toContain('https://kitup.app');
  });
});

describe('packToCharBudget', () => {
  const render = (s: string): string => s;
  const more = (rest: string[]): string => `(+${rest.length} more)`;

  it('returns an empty array for empty input and never calls more', () => {
    let called = false;
    const out = packToCharBudget<string>([], render, 100, () => { called = true; return 'x'; });
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });

  it('keeps every item and omits the tail when they all fit', () => {
    const out = packToCharBudget(['aaa', 'bbb', 'ccc'], render, 100, more);
    expect(out).toEqual(['aaa', 'bbb', 'ccc']);
  });

  it('accounts for the joining newline when measuring the budget', () => {
    // 'aaa' + '\n' = 4 chars each. A budget of 8 fits exactly two.
    const out = packToCharBudget(['aaa', 'bbb', 'ccc'], render, 8, more);
    expect(out).toEqual(['aaa', 'bbb', '(+1 more)']);
  });

  it('names the omitted remainder when the budget runs out', () => {
    const items = Array.from({ length: 10 }, (_, i) => `item-${i}`);
    const out = packToCharBudget(items, render, 20, more);
    expect(out[out.length - 1]).toBe(`(+${10 - (out.length - 1)} more)`);
    expect(out.length).toBeLessThan(items.length);
  });

  it('always emits at least one item, even when it alone busts the budget', () => {
    const out = packToCharBudget(['a-very-long-single-item', 'second'], render, 5, more);
    expect(out[0]).toBe('a-very-long-single-item');
    expect(out).toContain('(+1 more)');
  });

  it('omits the tail entirely when more() returns null', () => {
    const out = packToCharBudget(['aaa', 'bbb', 'ccc'], render, 4, () => null);
    expect(out).toEqual(['aaa']);
  });

  it('never splits an item to make it fit', () => {
    const out = packToCharBudget(['abcdefghij', 'k'], render, 3, more);
    expect(out[0]).toBe('abcdefghij');
  });
});

describe('compressedCoreFile', () => {
  const body = ['---', 'name: soul', '---', '', '## Warnings', '', '- **Never do X** because of a long rationale.'].join('\n');

  it('compresses the body per the rung and drops the frontmatter', () => {
    const out = compressedCoreFile(body, '_dream_context/core/0.soul.md', 13573, 69, CORE_L3);
    expect(out).toContain('## Warnings');
    expect(out).toContain('- **Never do X**');
    expect(out).not.toContain('name: soul');
    expect(out).not.toContain('because of a long rationale');
  });

  it('appends a one-line provenance footer naming the path, the size and doctor', () => {
    const out = compressedCoreFile(body, '_dream_context/core/0.soul.md', 13573, 69, CORE_L3);
    expect(out).toContain('_Compressed for budget — titles kept, rationale dropped.');
    expect(out).toContain('`_dream_context/core/0.soul.md`');
    expect(out).toContain('(13,573 chars)');
    expect(out).toContain('`dreamcontext doctor`._');
  });

  // The footer is paid twice (soul + user) out of the budget the compression
  // exists to defend, so its size is part of the ladder's accounting, not a
  // cosmetic detail. It used to be ~250 chars per file.
  it('keeps the footer to a single line of about 135 chars', () => {
    const out = compressedCoreFile('', '_dream_context/core/0.soul.md', 13573, 69, CORE_L3);
    expect(out.split('\n')).toHaveLength(1);
    expect(out.length).toBeLessThanOrEqual(150);
  });

  it('no longer spends budget restating the line count or the ceiling rule', () => {
    const out = compressedCoreFile(body, '_dream_context/core/0.soul.md', 13573, 69, CORE_L3);
    expect(out).not.toContain('69 lines');
    expect(out).not.toContain('over the ceiling');
  });

  it('separates the compressed body from the footer with a blank line', () => {
    const out = compressedCoreFile(body, 'p.md', 10, 2, CORE_L1);
    expect(out).toMatch(/\n\n_Compressed for budget/);
  });

  it('emits the footer alone when the body compresses to nothing', () => {
    const out = compressedCoreFile('', 'p.md', 0, 0, CORE_L1);
    expect(out.startsWith('_Compressed for budget')).toBe(true);
    expect(out.startsWith('\n')).toBe(false);
  });
});

describe('module surface — no verbatim-pinning surface exists', () => {
  // An earlier plan revision proposed an opt-in `snapshot_pin:` frontmatter key
  // so a user could hold headings verbatim. It was cut: it shipped zero bytes of
  // the size fix and the regression fixtures were made to depend on it. These
  // guards are RUNTIME, not type-level — tsconfig only includes src/, so a
  // `@ts-expect-error` in a test file would never be checked by anything.
  const FORBIDDEN = /pinnedHeadings|snapshot_pin|PINNED_HEADING_MAX_CHARS/;
  const read = (rel: string): string =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8');

  it('exports exactly the five documented functions', async () => {
    const mod = await import('../../src/lib/snapshot-compress.js');
    expect(Object.keys(mod).sort()).toEqual([
      // capAtWordBoundary joined the surface 2026-07-29: the changelog block's
      // three raw `slice(0, n) + '...'` cuts moved onto the shared word-safe
      // primitive instead of hand-rolling a fourth truncation style.
      'capAtWordBoundary',
      'compressMarkdownBlock',
      'compressedCoreFile',
      'packToCharBudget',
      'shrinkBody',
    ]);
    expect(Object.keys(mod)).not.toContain('parsePinnedHeadings');
  });

  it('has no pinning identifiers in the compressor source', () => {
    expect(read('../../src/lib/snapshot-compress.ts')).not.toMatch(FORBIDDEN);
  });

  it('has no pinning identifiers in the snapshot builder source', () => {
    expect(read('../../src/cli/commands/snapshot.ts')).not.toMatch(FORBIDDEN);
  });
});
