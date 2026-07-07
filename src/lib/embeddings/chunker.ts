import { createHash } from 'node:crypto';

/**
 * Heading-boundary markdown chunker for the dense embedding layer.
 *
 * Chunks are the embedding unit — NEVER whole documents (a whole-doc vector
 * averages into mush; Chroma's controlled study measured ~5× precision for
 * ~200-token chunks vs 800-token ones). Target size ~200–512 tokens, which we
 * approximate as 100–380 words (≈1.3 tokens/word on this EN/TR corpus).
 *
 * Deterministic by construction: same (title, body) → same chunks → same
 * content hashes. The hash is the embedding-cache key (survives git checkout;
 * mtime is only ever a pre-filter upstream).
 */
export interface Chunk {
  /** 0-based position of the chunk within its document. */
  seq: number;
  /** sha256 hex of `text` — the content-addressed cache key. */
  hash: string;
  /** The text that gets embedded (doc title prepended for context). */
  text: string;
}

const MAX_WORDS = 380; // ≈512 tokens
const MIN_WORDS = 100; // ≈130 tokens — below this, merge into the neighbour

const HEADING_RE = /^#{1,6}\s/;

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function wordCount(text: string): number {
  const m = text.match(/\S+/g);
  return m ? m.length : 0;
}

/** Split an oversized section into ≤MAX_WORDS pieces on paragraph boundaries. */
function splitByParagraphs(section: string): string[] {
  const paras = section.split(/\n{2,}/);
  const out: string[] = [];
  let cur: string[] = [];
  let curWords = 0;
  const flush = (): void => {
    if (cur.length > 0) {
      out.push(cur.join('\n\n'));
      cur = [];
      curWords = 0;
    }
  };
  for (const para of paras) {
    const w = wordCount(para);
    if (curWords > 0 && curWords + w > MAX_WORDS) flush();
    cur.push(para);
    curWords += w;
    // A single paragraph larger than MAX_WORDS still becomes one chunk — hard
    // word-splitting mid-sentence would hurt embedding quality more than an
    // oversized passage does.
    if (curWords > MAX_WORDS) flush();
  }
  flush();
  return out;
}

/**
 * Chunk one corpus document for embedding.
 *
 * - Splits `body` at markdown heading lines (any level).
 * - Merges runt sections forward until ≥ MIN_WORDS.
 * - Splits oversized sections on paragraph boundaries at ≤ MAX_WORDS.
 * - Prepends the document title to every chunk (E5-style context anchor) so a
 *   section chunk still knows which document it belongs to.
 * - An empty body yields a single title(+description) chunk so every doc has at
 *   least one vector.
 */
export function chunkDoc(title: string, body: string, description = ''): Chunk[] {
  const lines = body.split('\n');

  // Gather heading-delimited sections (preamble before the first heading is a
  // section of its own). A `# …` line inside a fenced code block is code, not
  // a heading — track fence state so shell comments/markdown samples in fences
  // never split a section.
  const sections: string[] = [];
  let cur: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence && HEADING_RE.test(line) && cur.length > 0) {
      sections.push(cur.join('\n').trim());
      cur = [line];
    } else {
      cur.push(line);
    }
  }
  if (cur.length > 0) sections.push(cur.join('\n').trim());

  // Merge runts forward, split giants.
  const pieces: string[] = [];
  let pending = '';
  for (const sec of sections) {
    if (sec === '') continue;
    const merged = pending === '' ? sec : `${pending}\n\n${sec}`;
    if (wordCount(merged) < MIN_WORDS) {
      pending = merged;
      continue;
    }
    pending = '';
    if (wordCount(merged) > MAX_WORDS) pieces.push(...splitByParagraphs(merged));
    else pieces.push(merged);
  }
  if (pending !== '') pieces.push(pending);

  if (pieces.length === 0) {
    const fallback = [title, description].filter(Boolean).join('\n').trim();
    if (fallback === '') return [];
    const text = fallback;
    return [{ seq: 0, hash: sha256(text), text }];
  }

  return pieces.map((piece, seq) => {
    const text = `${title}\n${piece}`;
    return { seq, hash: sha256(text), text };
  });
}
