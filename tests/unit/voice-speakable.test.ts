/**
 * `speakable()` — the last line of defence before a chunk is read aloud (AC16).
 *
 * Read the module doc for why it is LAST and not first: the client's chunker never hands
 * this function a fenced block, and it must not, because by the time a `dream-html` block
 * reached here it would already have been carved into "sentences" at every `.` in a CSS
 * rule. What is tested here is the residue that survives ordinary prose.
 */

import { describe, it, expect } from 'vitest';
import { speakable } from '../../src/lib/voice/speakable.js';

describe('speakable', () => {
  it('leaves plain prose completely alone', () => {
    expect(speakable('Bak, ekrana koyuyorum. Üç seçenek var.'))
      .toBe('Bak, ekrana koyuyorum. Üç seçenek var.');
  });

  it('drops markdown emphasis rather than reading the asterisks', () => {
    expect(speakable('This is **important** and _this_ is not'))
      .toBe('This is important and this is not');
  });

  it('drops heading hashes, bullets and blockquote carets', () => {
    expect(speakable('## Findings\n- one\n- two\n> a quote')).toBe('Findings one two a quote');
  });

  it('reads a link\'s LABEL and never its target', () => {
    const out = speakable('See [the handbook](docs/handbook.pdf) for more');
    expect(out).toBe('See the handbook for more');
    expect(out).not.toContain('docs');
  });

  it('removes a bare URL — one link read character by character outlasts the sentence', () => {
    const out = speakable('It is at https://example.com/a/b?c=d now');
    expect(out).not.toMatch(/https|example\.com/);
    expect(out).toContain('It is at');
    expect(out).toContain('now');
  });

  it('removes a file path, which is worse aloud than a URL', () => {
    expect(speakable('Look at src/lib/voice/speakable.ts for it')).not.toContain('speakable.ts');
    expect(speakable('Look at ./src/index.ts now')).not.toContain('index.ts');
  });

  it('leaves "and/or" alone — the path rule is narrow on purpose', () => {
    expect(speakable('take one and/or the other')).toBe('take one and/or the other');
  });

  it('turns an em dash into a comma, because that is the pause it stood for', () => {
    expect(speakable('One thing — then another')).toBe('One thing, then another');
  });

  it('keeps the words inside inline code but drops the backticks', () => {
    expect(speakable('run `sleep start` when ready')).toBe('run sleep start when ready');
  });

  it('unwraps the highlighter pens', () => {
    expect(speakable('this is ==important== and ==!broken==')).toBe('this is important and broken');
  });

  it('drops a fenced block entirely if one ever reaches it', () => {
    const out = speakable('Here it is:\n```dream-html\n<div class="dc-doc">x</div>\n```\nThat is it.');
    expect(out).toBe('Here it is: That is it.');
    expect(out).not.toContain('dc-doc');
  });

  it('drops an UNCLOSED fence too — a streaming chunk can end mid-block', () => {
    const out = speakable('Bir saniye:\n```dream-html\n<div class="dc-card">');
    expect(out).toBe('Bir saniye:');
  });

  it('drops table rows and horizontal rules', () => {
    expect(speakable('Result:\n| a | b |\n| - | - |\n---\nDone')).toBe('Result: Done');
  });

  it('returns EMPTY for a chunk with nothing speakable left, so the queue skips it', () => {
    expect(speakable('```dream-view\n{"type":"pin"}\n```')).toBe('');
    expect(speakable('https://example.com')).toBe('');
    expect(speakable('***')).toBe('');
    expect(speakable('   ')).toBe('');
    expect(speakable('')).toBe('');
  });

  it('collapses the whitespace every other rule leaves behind', () => {
    expect(speakable('a   \n\n  b')).toBe('a b');
  });
});
