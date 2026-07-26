/**
 * Unit tests for the incremental markdown renderer's two pure halves: splitting a message into
 * top-level blocks, and deciding how many of those blocks the DOM can keep.
 *
 * The load-bearing property is not "it splits" — it is that a block, once complete, keeps
 * BYTE-IDENTICAL source as the message grows underneath it. That is what stops a `<video>` in
 * a finished paragraph from being rebuilt (and therefore re-requested) on every streamed
 * token, which is the defect this exists to prevent (owner report 07-26).
 *
 * The second property is equivalence: rendering the blocks separately must produce the same
 * HTML as rendering the whole message, or the optimization has changed what the user reads.
 */
import { describe, it, expect } from 'vitest';
import {
  markdownBlocks, firstChangedBlock, renderMarkdownBlock,
} from '../../dashboard/src/lib/markdownBlocks.js';

const RICH = `# Heading

Video artık uçtan uca destekleniyor:

[demo](tmp/demo.mp4)

**Asıl engel** formatta değil, \`src/server/media.ts\` idi.

- bir
- iki
  - iç

1. sayı
2. sayı

| a | b |
|---|---|
| 1 | 2 |

\`\`\`ts
const x: number = 1;
\`\`\`

> alıntı
> devam

---

Setext başlık
=============

![shot](docs/a.png)

<div class="raw">html blok</div>

Son paragraf
tek newline satırı

- [ ] görev
- [x] bitti
`;

describe('markdownBlocks — splitting a message into re-renderable units', () => {
  it('renders block-by-block to exactly the HTML the whole message renders to', () => {
    const whole = renderMarkdownBlock(RICH);
    const perBlock = markdownBlocks(RICH).map(renderMarkdownBlock).join('');
    expect(perBlock).toBe(whole);
  });

  it('gives each top-level construct its own block, and drops blank lines', () => {
    const blocks = markdownBlocks('# A\n\nbir\n\niki\n');
    expect(blocks).toEqual(['# A\n\n', 'bir', 'iki\n']);
    // The blank line between the paragraphs lexes as a `space` token of its own, and is
    // dropped: it renders to nothing, and keeping it would re-render a block for no output.
    expect(blocks.some((b) => b.trim() === '')).toBe(false);
  });

  it('keeps a fenced block whole, including the blank lines inside it', () => {
    const blocks = markdownBlocks('para\n\n```ts\na\n\nb\n```\n\nson\n');
    expect(blocks).toHaveLength(3);
    expect(blocks[1]).toContain('a\n\nb');
  });

  it('keeps a table and a multi-paragraph list whole', () => {
    expect(markdownBlocks('| a |\n|---|\n| 1 |\n')).toHaveLength(1);
    expect(markdownBlocks('- a\n\n- b\n')).toHaveLength(1);
  });

  it('renders a message with a link reference definition whole, since the ref is document state', () => {
    const withRef = 'See [the docs][d].\n\n[d]: https://example.com\n';
    expect(markdownBlocks(withRef)).toEqual([withRef]);
    // Proof the guard earns its keep: split, that link would render as literal brackets.
    expect(renderMarkdownBlock('See [the docs][d].\n\n')).toContain('[the docs][d]');
  });

  it('never loses the text: empty in, empty out; unrecognisable in, one block out', () => {
    expect(markdownBlocks('')).toEqual([]);
    expect(markdownBlocks('   ')).toEqual(['   ']);
  });
});

describe('markdownBlocks — under a stream, which is the whole point', () => {
  // The shape of the answer that provoked the report: a clip written a fifth of the way in,
  // with the rest of the explanation streaming underneath it.
  const MSG = `Video artık uçtan uca destekleniyor. İşte kaydettiğim gerçek klip, v0.22.0 sayfasında duruyor:

[demo](tmp/demo.mp4)

**Asıl engel formatta değil, sunucudaydı.** \`static.ts\` ne video mime type'ı veriyordu ne de byte range. WKWebView range-servis edilmeyen bir klibi oynatmayı reddeder — ve bunu sessizce yapar: ölü bir oynatıcı, konsolda hata yok.

Format: \`StoryClip = { src, poster, alt, caption?, frame?, sound? }\` — tam genişlikte yeni bir \`video\` bloğunda ve hero'da kullanılabiliyor.

- \`poster\` zorunlu. Üç yüzey hikâyeyi hareketsiz görsel olarak render ediyor — feed teaser'ı, popup ve baytlar gelmeden önceki kare.
- \`sound\` opsiyonel; varsayılan sessiz.

\`\`\`ts
type StoryClip = { src: string; poster: string; alt: string };
\`\`\`

Son satır: sayfa hazır.`;

  /** Every prefix a 12-char-per-frame stream would render. */
  const prefixes = () => {
    const out: string[] = [];
    for (let n = 1; n <= MSG.length; n += 12) out.push(MSG.slice(0, n));
    if (out[out.length - 1] !== MSG) out.push(MSG);
    return out;
  };

  it('re-renders the clip block ONCE — the frame its blank line arrives — not once per token', () => {
    let prev: string[] = [];
    let clipRenders = 0;
    let frozenAt: number | null = null;
    for (const text of prefixes()) {
      const blocks = markdownBlocks(text);
      const reused = firstChangedBlock(prev, blocks);
      const clip = blocks.findIndex((b) => b.includes('demo](tmp/demo.mp4'));
      if (clip >= 0 && clip >= reused) clipRenders++;               // this frame rebuilds it
      if (clip >= 0 && clip < reused && frozenAt === null) frozenAt = text.length;
      prev = blocks;
    }
    // 64 frames stream this message; the clip's block is built in ONE of them. Under a
    // whole-body rewrite it was built in all 64 — a fresh `<video src>` per frame.
    expect(clipRenders).toBe(1);
    expect(frozenAt).not.toBeNull();
    // Frozen 133 chars in, of 762 — every one of the remaining frames leaves that clip alone.
    expect(frozenAt as number).toBeLessThan(MSG.length / 4);
  });

  it('only ever changes the LAST block while a paragraph is being typed', () => {
    let prev: string[] = [];
    for (const text of prefixes()) {
      const blocks = markdownBlocks(text);
      const reused = firstChangedBlock(prev, blocks);
      // Everything before the tail is untouched: at most the final block is re-rendered, plus
      // whatever new blocks the delta introduced.
      if (prev.length > 0) expect(reused).toBeGreaterThanOrEqual(prev.length - 1);
      prev = blocks;
    }
  });

  it('costs a fraction of the block renders a whole-body rewrite does', () => {
    let prev: string[] = [];
    let incremental = 0;
    let wholeBody = 0;
    for (const text of prefixes()) {
      const blocks = markdownBlocks(text);
      incremental += blocks.length - firstChangedBlock(prev, blocks);
      wholeBody += blocks.length;                 // what a per-frame innerHTML write rebuilt
      prev = blocks;
    }
    // Measured 69 against 241 for this message. The saving grows with the answer's length,
    // because the tail is the only part that ever moves.
    expect(incremental * 3).toBeLessThan(wholeBody);
  });
});

describe('firstChangedBlock — how much of the DOM survives', () => {
  it('reuses everything when nothing changed', () => {
    expect(firstChangedBlock(['a', 'b'], ['a', 'b'])).toBe(2);
  });

  it('reuses everything when a block was appended — the streaming case', () => {
    expect(firstChangedBlock(['a', 'b'], ['a', 'b', 'c'])).toBe(2);
  });

  it('cuts at the block that grew', () => {
    expect(firstChangedBlock(['a', 'b'], ['a', 'b2'])).toBe(1);
  });

  it('cuts at the first change even when later blocks match', () => {
    expect(firstChangedBlock(['a', 'b', 'c'], ['a2', 'b', 'c'])).toBe(0);
  });

  it('cuts at the truncation point when blocks were removed — a rewind', () => {
    expect(firstChangedBlock(['a', 'b', 'c'], ['a'])).toBe(1);
  });

  it('handles the empty cases', () => {
    expect(firstChangedBlock([], ['a'])).toBe(0);
    expect(firstChangedBlock(['a'], [])).toBe(0);
    expect(firstChangedBlock([], [])).toBe(0);
  });
});
