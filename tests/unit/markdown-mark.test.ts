/**
 * `==highlight==` — the marker stroke the Chat briefing promises (owner report 08-02: bold is
 * already carrying structure, so nothing in a long answer stands out).
 *
 * Two things are pinned here. First that the syntax RENDERS, because the briefing tells every
 * chat agent it exists and `chat-surface.ts`'s standing rule is that a named capability the
 * view doesn't render is worse than one left unnamed. Second, and the reason this file is
 * mostly negative cases: `==` is two characters people also just TYPE. A tokenizer that grabs
 * them too eagerly turns `a == b` in a sentence into a highlight that swallows the rest of the
 * line — a regression nobody would attribute to a markdown extension.
 */
import { describe, it, expect } from 'vitest';
import { marked } from 'marked';
import '../../dashboard/src/lib/markdownMark.js';
import { CHAT_SURFACE_BRIEFING } from '../../src/server/chat-surface.js';

/** Inline render of one line, unwrapped from the paragraph marked puts around it. */
const inline = (src: string) => (marked.parse(src) as string).replace(/^<p>|<\/p>\n?$/g, '').trim();

describe('==highlight== → <mark>', () => {
  it('wraps the phrase and nothing around it', () => {
    expect(inline('the number that ==decides it== is 26px'))
      .toBe('the number that <mark>decides it</mark> is 26px');
  });

  it('carries inline markup inside the stroke — a highlight may hold code, a link, bold', () => {
    expect(inline('==the `li` rule==')).toBe('<mark>the <code>li</code> rule</mark>');
    expect(inline('==**this** matters==')).toBe('<mark><strong>this</strong> matters</mark>');
    expect(inline('==[the task](x.md)==')).toBe('<mark><a href="x.md">the task</a></mark>');
  });

  it('highlights more than once in a line, and keeps the text between them', () => {
    expect(inline('==one== then ==two==')).toBe('<mark>one</mark> then <mark>two</mark>');
  });

  it('works where prose works — in a list item, a heading, a table cell', () => {
    expect(marked.parse('- a ==finding==') as string).toContain('<mark>finding</mark>');
    expect(marked.parse('## a ==verdict==') as string).toContain('<mark>verdict</mark>');
  });

  // ── the pens ─────────────────────────────────────────────────────────────────────────

  it('a leading ! is the red pen, and the character itself never reaches the reader', () => {
    expect(inline('==!FAIL== on both kernels'))
      .toBe('<mark class="mark-alarm">FAIL</mark> on both kernels');
  });

  it('a leading + is the green pen', () => {
    expect(inline('the wiring is ==+logically sound=='))
      .toBe('the wiring is <mark class="mark-good">logically sound</mark>');
  });

  it('a pen must be followed by a WORD — otherwise the character is just text the reader wanted, '
    + 'and the highlight falls back to the default pen rather than disappearing', () => {
    expect(inline('==+1 to that==')).toBe('<mark>+1 to that</mark>');
    expect(inline('==!!! read this==')).toBe('<mark>!!! read this</mark>');
  });

  it('an unmarked highlight is the default yellow pen — no class at all', () => {
    expect(inline('==plain==')).toBe('<mark>plain</mark>');
  });

  // ── the negative half: `==` that is not a highlight ──────────────────────────────────

  it('leaves a comparison alone — a space after the opener is not a pen stroke', () => {
    expect(inline('if a == b then c == d')).toBe('if a == b then c == d');
  });

  it('an unclosed opener is literal text — it cannot swallow what follows', () => {
    const html = marked.parse('==unclosed here\nand the next line') as string;
    expect(html).not.toContain('<mark>');
    expect(html).toContain('unclosed here');
  });

  it('a highlight MAY cross a soft line break — agents hard-wrap prose, and the clauses worth '
    + 'marking are longer than one wrapped line', () => {
    const html = marked.parse('do not classify a message as ==ambiguous because it is short,\n'
      + 'decide from the visitor own words alone== please') as string;
    expect(html).toContain('<mark>');
    expect(html).toContain('own words alone</mark>');
  });

  it('…but never past its own paragraph — inline tokenizing is per block', () => {
    const html = marked.parse('first ==paragraph opener\n\nsecond paragraph closer== here') as string;
    expect(html).not.toContain('<mark>');
  });

  it('leaves `==` inside a code span alone — the span is tokenized first', () => {
    expect(inline('run `if (a == b) and (c == d)` first'))
      .toBe('run <code>if (a == b) and (c == d)</code> first');
  });

  it('leaves a fenced block alone, ==markers== and all', () => {
    const html = marked.parse('```js\nconst ok = a ==b== c;\n```') as string;
    expect(html).not.toContain('<mark>');
  });

  it('is not fooled by an empty or all-marker run', () => {
    expect(inline('====')).toBe('====');
    expect(inline('===== a heading rule =====')).toContain('=====');
  });

  it('a setext heading underline is still a heading, not a highlight', () => {
    const html = marked.parse('A title\n=======\n') as string;
    expect(html).toContain('<h1');
    expect(html).not.toContain('<mark>');
  });
});

describe('CHAT_SURFACE_BRIEFING <-> highlighter lockstep', () => {
  it('the briefing shows the syntax the renderer actually implements', () => {
    // The briefing's own example, pulled out of it rather than restated here — restating it
    // is how the two drift.
    const example = /`(==[^`\n]+==)`/.exec(CHAT_SURFACE_BRIEFING)?.[1];
    expect(example, 'the briefing no longer shows a ==…== example').toBeTruthy();
    expect(marked.parse(example as string) as string).toContain('<mark>');
  });

  it('it also teaches the DISCIPLINE, not just the syntax — an unrationed highlighter is a wall', () => {
    expect(/highlight everything|A handful per answer|never a whole sentence/i.test(CHAT_SURFACE_BRIEFING)).toBe(true);
  });
});
