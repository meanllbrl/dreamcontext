/**
 * The streaming exception, measured.
 *
 * This surface's standing rule is that a half-written fence never reaches the screen
 * (`chatActions.ts`: "half-written markup must never flash on screen"). `dream-ui` breaks
 * that rule on purpose, and a deliberate exception has to be justified by evidence rather
 * than by the vendor's claim — so this file measures what a partial program actually draws.
 *
 * The claim under test: openui-lang is line-oriented and partial-tolerant, so a partial
 * program is a SMALLER version of the same picture rather than a damaged one. If that were
 * false — if a cut mid-program produced garbage, or threw — the exception would not be worth
 * having and `OpenUiPending` should go back to a skeleton.
 */
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { Renderer } from '@openuidev/react-lang';
import { openUiChatLibrary } from '../../dashboard/src/components/sleepy/chat/openuiLibrary.js';

/** Six statements: a frame, a title, a table with two columns of data, and a note. */
const PROGRAM = [
  'root = Card([title, tbl, note])',
  'title = TextContent("Top Languages", "large-heavy")',
  'tbl = Table([Col("Language", langs), Col("Users (M)", users)])',
  'langs = ["Python", "JavaScript", "Java"]',
  'users = [15.7, 14.2, 12.1]',
  'note = Callout("Estimates only", "info")',
];

function draw(source: string, streaming = true): string {
  return renderToString(createElement(Renderer, {
    response: source, library: openUiChatLibrary, isStreaming: streaming, toolProvider: null,
  } as never));
}

describe('dream-ui streams — a partial program is a smaller picture', () => {
  /** What each prefix drew, indexed by how many lines had arrived. */
  const byLine = PROGRAM.map((_, i) => draw(PROGRAM.slice(0, i + 1).join('\n')));

  it('draws something from the FIRST line, long before the program ends', () => {
    // This is the whole payoff of the exception. `dream-html` cannot do this by
    // construction: its block appears only when the closing fence arrives, i.e. at 6/6.
    expect(byLine[0].length).toBeGreaterThan(100);
  });

  it('fills in progressively — each stage adds, none destroys', () => {
    // MEASURED 2026-09-05 on this program: 229 → 462 → 462 → 1151 → 1400 → 1400 characters.
    // The flat steps are real and correct: line 3 declares a table whose data arrives on
    // lines 4-5, and a variable nothing references yet is dropped rather than half-drawn.
    for (let i = 1; i < byLine.length; i++) {
      expect(byLine[i].length, `line ${i + 1} shrank the picture`).toBeGreaterThanOrEqual(byLine[i - 1].length);
    }
    expect(byLine[byLine.length - 1].length).toBeGreaterThan(byLine[0].length * 3);
  });

  it('shows the title before the data it belongs to', () => {
    expect(byLine[1]).toContain('Top Languages');
    expect(byLine[1]).not.toContain('Python');
    expect(byLine[3]).toContain('Python');
  });

  it('survives a cut in the MIDDLE of a line — the real streaming case', () => {
    // Tokens do not arrive on line boundaries. A parser that only tolerated whole lines
    // would flicker on every partial statement.
    const whole = PROGRAM.join('\n');
    const midLine = whole.slice(0, whole.indexOf('langs = [') + 14);
    let html = '';
    expect(() => { html = draw(midLine); }).not.toThrow();
    expect(html).toContain('<table');
    expect(html).toContain('Top Languages');
  });

  it('never emits the source itself, at any prefix', () => {
    // The failure that would make the exception unacceptable: raw openui-lang spilling into
    // the transcript as text. Checked at every stage, not just the finished one.
    for (const [i, html] of byLine.entries()) {
      expect(html, `line ${i + 1} leaked source`).not.toContain('root = Card');
      expect(html, `line ${i + 1} leaked source`).not.toContain('TextContent(');
    }
  });

  it('degrades quietly on a prefix that is not yet valid anything', () => {
    for (const fragment of ['r', 'root', 'root =', 'root = Ca', 'root = Card([', '']) {
      expect(() => draw(fragment), `threw on ${JSON.stringify(fragment)}`).not.toThrow();
    }
  });
});

describe('dream-ui streams — the comparison that justifies the exception', () => {
  it('reaches its first visible component at a FRACTION of the program', () => {
    const firstVisible = PROGRAM.findIndex((_, i) => draw(PROGRAM.slice(0, i + 1).join('\n')).length > 100) + 1;
    // MEASURED: 1 of 6 statements. `dream-html` is 6/6 by construction — its block cannot
    // render until the closing fence, because partial markup is not a smaller document.
    expect(firstVisible).toBe(1);
    expect(firstVisible / PROGRAM.length).toBeLessThan(0.25);
  });
});
