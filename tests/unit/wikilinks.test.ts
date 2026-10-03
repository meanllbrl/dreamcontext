/**
 * `[[target]]` / `[[target|label]]` in the shared reader (dashboard/src/lib/wikilinks.ts): parsed
 * outside code, escaped into markup, and resolved against the knowledge list.
 */
import { describe, it, expect } from 'vitest';
import { marked } from 'marked';
import {
  findWikilinks, markdownWithWikilinks, parseWikilink, replaceWikilinks, resolveWikilinkTarget,
} from '../../dashboard/src/lib/wikilinks.js';

describe('parseWikilink', () => {
  it('reads a bare target as its own label', () => {
    expect(parseWikilink('whiteboards')).toEqual({ target: 'whiteboards', label: 'whiteboards' });
  });
  it('splits target and label on the pipe, trimmed', () => {
    expect(parseWikilink(' features/boards | The boards ')).toEqual({ target: 'features/boards', label: 'The boards' });
  });
  it('accepts the table-safe escaped pipe', () => {
    expect(parseWikilink('a\\|b')).toEqual({ target: 'a', label: 'b' });
  });
  it('falls back to the target when the label is empty, and rejects an empty target', () => {
    expect(parseWikilink('a|')).toEqual({ target: 'a', label: 'a' });
    expect(parseWikilink(' |b')).toBeNull();
  });
});

describe('findWikilinks', () => {
  it('finds [[a]] and [[a|b]] in prose, in order', () => {
    expect(findWikilinks('See [[a]] and [[c|d]].')).toEqual([
      { target: 'a', label: 'a' },
      { target: 'c', label: 'd' },
    ]);
  });
  it('ignores inline code spans, including double-backtick ones', () => {
    expect(findWikilinks('`[[a]]` and ``x [[b]] ` y`` but [[c]]')).toEqual([{ target: 'c', label: 'c' }]);
  });
  it('ignores fenced code blocks (``` and ~~~) until the fence closes', () => {
    const md = ['```md', '[[a]]', '```', '~~~~', '[[b]]', '~~~', '~~~~', '[[c]]'].join('\n');
    expect(findWikilinks(md)).toEqual([{ target: 'c', label: 'c' }]);
  });
  it('keeps an unclosed backtick literal, so a link after it still counts', () => {
    expect(findWikilinks('a ` stray [[x]]')).toEqual([{ target: 'x', label: 'x' }]);
  });
  it('honours a backslash escape', () => {
    expect(findWikilinks('\\[[not]] but [[yes]]')).toEqual([{ target: 'yes', label: 'yes' }]);
  });
  it('does not span lines or nest brackets', () => {
    expect(findWikilinks('[[a\nb]] [[[c]]]')).toEqual([{ target: 'c', label: 'c' }]);
  });
});

describe('replaceWikilinks / markdownWithWikilinks', () => {
  it('returns the same string when there is nothing to do', () => {
    const md = 'plain text';
    expect(replaceWikilinks(md, () => 'X')).toBe(md);
  });
  it('renders an href-less anchor carrying the target', () => {
    expect(markdownWithWikilinks('[[a|b]]')).toBe('<a class="md-wikilink" data-wikilink="a">b</a>');
  });
  it('escapes markup in target and label', () => {
    const out = markdownWithWikilinks('[["><script>|<b>&</b>]]');
    expect(out).toBe('<a class="md-wikilink" data-wikilink="&quot;&gt;&lt;script&gt;">&lt;b&gt;&amp;&lt;/b&gt;</a>');
    expect(out).not.toContain('<script>');
  });
  it('survives marked as a link inside a paragraph, and leaves code alone', () => {
    const html = marked.parse(markdownWithWikilinks('Go to [[x|X]].\n\n`[[y]]`')) as string;
    expect(html).toContain('<a class="md-wikilink" data-wikilink="x">X</a>');
    expect(html).toContain('<code>[[y]]</code>');
  });
});

describe('resolveWikilinkTarget', () => {
  const entries = [
    { slug: 'features/whiteboards', name: 'Whiteboards' },
    { slug: 'architecture/recall-engine', name: 'Recall Engine v2' },
  ];
  it('matches the slug, case-insensitively, ignoring .md and #heading', () => {
    expect(resolveWikilinkTarget('Features/Whiteboards.md#Goals', entries)).toBe('_dream_context/knowledge/features/whiteboards.md');
  });
  it('matches the file name', () => {
    expect(resolveWikilinkTarget('recall-engine', entries)).toBe('_dream_context/knowledge/architecture/recall-engine.md');
  });
  it('matches the title', () => {
    expect(resolveWikilinkTarget('recall engine V2', entries)).toBe('_dream_context/knowledge/architecture/recall-engine.md');
  });
  it('takes a path-shaped target as project-relative', () => {
    expect(resolveWikilinkTarget('./docs/spec.pdf', entries)).toBe('docs/spec.pdf');
    expect(resolveWikilinkTarget('report.html', entries)).toBe('report.html');
  });
  it('refuses parent traversal and returns null for an unknown name', () => {
    expect(resolveWikilinkTarget('../secret.md', entries)).toBeNull();
    expect(resolveWikilinkTarget('nothing here', entries)).toBeNull();
    expect(resolveWikilinkTarget('#only-a-heading', entries)).toBeNull();
  });
});
