/**
 * Inline reference chips in the Super composer (owner 2026-10-24: several references in one
 * message, each dropped INTO the text at the caret with his words after it).
 *
 * ── Why a token in a string, not contenteditable ────────────────────────────────────
 * The composer is one textarea shared by every chat, the agents channel, AI Team and the phone,
 * and everything it does (caret math, the `/` and `@` menus, ↑ recall, voice takes inserted at
 * the caret, IME, the draft carried across a respawn as a string) reads `selectionStart` and a
 * string. So a reference is a TOKEN in that string, drawn as a chip by the existing mirror:
 *
 *   FSI <glyph> NBSP <name> <id digits> PDI
 *
 * - glyph `●` for an agenda line, `↩` for a reply: the KIND (the hue, by order, is the identity);
 * - FSI/PDI (U+2068/U+2069) are zero-width isolates, NBSPs keep the token from wrapping inside;
 * - the id digits are the staged ref's id (this run's nonce + its attachment sequence) in base 4,
 *   written with the invisible format characters U+2061..U+2064, so labels may repeat freely
 *   and a token from another run, window or device never matches a ref of this one.
 *
 * React-free and DOM-free, so root vitest loads it directly (composer-refs.test.ts).
 */
import { ABOUT_AGENDA_RE, MAX_MESSAGE_REFS, REPLY_TO_RE, aboutHeads } from '../../../lib/superTypes';
import { splitAbout, type MessageAbout } from '../super/superHandover';
import type { Attachment } from './composerScratch';

const FSI = '\u2068';
const PDI = '\u2069';
const NBSP = '\u00A0';
const DIGITS = ['\u2061', '\u2062', '\u2063', '\u2064'] as const;
const DIGIT_RE = /[\u2061-\u2064]/;
export const GLYPH_NOTE = '●';
export const GLYPH_REPLY = '↩';
/** The chip's name in the box, at most this many graphemes (measured at 390 px, W2). */
export const REF_LABEL_MAX = 24;
/** How far the remains of a damaged token may reach when its id digits are gone too. */
const DAMAGE_REACH = 40;

/** A well-formed token: `[start, end)` in the draft, its glyph, its name and its id (base 4). */
export interface RefTokenSpan { start: number; end: number; glyph: string; label: string; id: string }

const TOKEN_RE = /\u2068([●↩])\u00A0([^\u2068\u2069\n\u2061-\u2064]*)([\u2061-\u2064]+)\u2069/g;

const toBase4 = (n: number, width = 1): string => {
  let s = Math.max(0, Math.floor(n)).toString(4);
  while (s.length < width) s = `0${s}`;
  return s;
};

/** This run's nonce: four base-4 digits from crypto random, fixed at module load. */
const RUN_NONCE = (() => {
  let n = 0;
  try {
    const a = new Uint8Array(1);
    globalThis.crypto.getRandomValues(a);
    n = a[0];
  } catch { n = Math.floor(Math.random() * 256); }
  return toBase4(n, 4);
})();

/** A staged ref's token id (base-4 string): the run nonce + its attachment sequence. */
export function refTokenId(att: Pick<Attachment, 'id'>): string {
  const seq = Number(/(\d+)$/.exec(att.id)?.[1] ?? 0);
  return `${RUN_NONCE}${toBase4(seq)}`;
}

const encodeId = (id: string) => Array.from(id, (d) => DIGITS[Number(d)] ?? '').join('');
const decodeId = (digits: string) => Array.from(digits, (c) => String(c.charCodeAt(0) - 0x2061)).join('');

/** What a ref names, for "the same target twice": `note:n7`, `item:q-1`, `reply:k3f9q0`. */
export function refKey(att: Pick<Attachment, 'text'>): string | null {
  const text = att.text ?? '';
  const a = ABOUT_AGENDA_RE.exec(text);
  if (a) return `${a[1]}:${a[2]}`;
  const r = REPLY_TO_RE.exec(text);
  return r ? `reply:${r[1]}` : null;
}

function graphemes(s: string): string[] {
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(t: string): Iterable<{ segment: string }> } }).Segmenter;
  if (Seg) return Array.from(new Seg(undefined, { granularity: 'grapheme' }).segment(s), (x) => x.segment);
  return Array.from(s);
}

/** The chip's name as the token carries it: format characters gone (so pad text can never break
 *  parsing), one line, clipped to REF_LABEL_MAX graphemes with `…`, spaces as NBSP. */
export function refLabel(att: Pick<Attachment, 'name'>): string {
  const flat = (att.name ?? '').replace(/[\p{Cf}\u0000-\u001f\u007f\u2028\u2029]/gu, '').replace(/\s+/g, ' ').trim();
  const g = graphemes(flat);
  const clipped = g.length > REF_LABEL_MAX ? `${g.slice(0, REF_LABEL_MAX - 1).join('').trimEnd()}…` : flat;
  return clipped.replace(/ /g, NBSP);
}

/** The glyph a ref's chip opens with: ↩ for a reply, ● for an agenda line. */
export function refGlyph(att: Pick<Attachment, 'text'>): string {
  return REPLY_TO_RE.test(att.text ?? '') ? GLYPH_REPLY : GLYPH_NOTE;
}

/** The token a staged ref is drawn as in the draft. */
export function refToken(att: Pick<Attachment, 'id' | 'name' | 'text'>): string {
  return `${FSI}${refGlyph(att)}${NBSP}${refLabel(att)}${encodeId(refTokenId(att))}${PDI}`;
}

/** Every well-formed token in the draft, in order. */
export function parseRefTokens(draft: string): RefTokenSpan[] {
  const out: RefTokenSpan[] = [];
  for (const m of (draft ?? '').matchAll(TOKEN_RE)) {
    const start = m.index ?? 0;
    out.push({ start, end: start + m[0].length, glyph: m[1], label: m[2], id: decodeId(m[3]) });
  }
  return out;
}

/** A token read as plain text: its glyph and name, delimiters and id gone. */
const asText = (t: Pick<RefTokenSpan, 'glyph' | 'label'>) => `${t.glyph} ${t.label.replace(/\u00A0/g, ' ')}`;
/** Stray token characters (a delimiter or id digit outside any token) never reach the wire. */
const stripStray = (s: string) => s.replace(/[\u2068\u2069\u2061-\u2064]/g, '');

/** The draft without its tokens (and without any stray token characters): what send gating,
 *  the slash test and every commit path read. */
export function stripTokens(draft: string): string {
  return stripStray((draft ?? '').replace(TOKEN_RE, ''));
}

/** Only the draft's tokens, space-separated with a trailing space: what stays in the box after
 *  a slash command (the chips are for the next message). '' when there are none. */
export function tokensOnly(draft: string): string {
  const spans = parseRefTokens(draft);
  return spans.length ? `${spans.map((t) => draft.slice(t.start, t.end)).join(' ')} ` : '';
}

/**
 * A caret strictly inside a token goes to its FAR edge in the direction of travel (`prevCaret`
 * at or before the token's start → its end; otherwise → its start). A selection whose start or
 * end lies strictly inside a token grows to cover all of it.
 */
export function snapSelection(draft: string, start: number, end: number, prevCaret: number): { start: number; end: number } {
  const spans = parseRefTokens(draft);
  const inside = (p: number) => spans.find((t) => t.start < p && p < t.end);
  if (start === end) {
    const t = inside(start);
    if (!t) return { start, end };
    const c = prevCaret <= t.start ? t.end : t.start;
    return { start: c, end: c };
  }
  const a = inside(start);
  const b = inside(end);
  return { start: a ? a.start : start, end: b ? b.end : end };
}

/**
 * Backspace at a token's end (or Delete at its start) removes the whole token plus one adjacent
 * space (the one before it for Backspace, after it for Delete, else the other). null when the
 * caret is at no token edge, so the key does what it always did.
 */
export function deleteTokenAt(draft: string, caret: number, dir: 'backward' | 'forward'): { draft: string; caret: number; id: string } | null {
  const t = parseRefTokens(draft).find((x) => (dir === 'backward' ? x.end === caret : x.start === caret));
  if (!t) return null;
  let s = t.start;
  let e = t.end;
  const before = draft[s - 1] === ' ';
  const after = draft[e] === ' ';
  if (dir === 'backward' ? before : !after && before) s -= 1;
  else if (after) e += 1;
  return { draft: draft.slice(0, s) + draft.slice(e), caret: s, id: t.id };
}

/** Insert a token at the caret, padded with a space where the neighbour is not one; the caret
 *  lands after the token and its trailing space. */
export function insertTokenAt(draft: string, caret: number, token: string): { draft: string; caret: number } {
  const c = Math.max(0, Math.min(caret, draft.length));
  const before = draft.slice(0, c);
  const after = draft.slice(c);
  const left = before && !/\s$/.test(before) ? ' ' : '';
  const right = after.startsWith(' ') ? '' : ' ';
  const next = `${before}${left}${token}${right}${after}`;
  return { draft: next, caret: before.length + left.length + token.length + 1 };
}

interface Edit { s: number; e: number; rep: string }

function applyEdits(text: string, edits: Edit[], caret: number): { text: string; caret: number } {
  let out = '';
  let pos = 0;
  let c = caret;
  for (const ed of [...edits].sort((x, y) => x.s - y.s)) {
    out += text.slice(pos, ed.s);
    // The caret moves with the text: past an edit it shifts by the edit's delta, inside one it
    // lands after the replacement.
    if (caret >= ed.e) c += ed.rep.length - (ed.e - ed.s);
    else if (caret > ed.s) c = out.length + ed.rep.length;
    out += ed.rep;
    pos = ed.e;
  }
  out += text.slice(pos);
  return { text: out, caret: Math.max(0, Math.min(c, out.length)) };
}

/**
 * The remains of damaged tokens in a stretch with no well-formed token (autocorrect or a
 * spellcheck replace took a delimiter or digits). Starting at an FSI they reach the PDI, else the
 * last id digit, else DAMAGE_REACH characters; never past another FSI or a newline. A PDI with no
 * FSI reaches back over its digits and, within DAMAGE_REACH, to its `glyph NBSP`. Any other
 * stray token character goes on its own. Each edit names the ids its digits carried.
 */
function damageEdits(text: string, from: number, to: number): Array<Edit & { ids: string[] }> {
  const out: Array<Edit & { ids: string[] }> = [];
  const idsIn = (s: string) => (s.match(/[\u2061-\u2064]+/g) ?? []).map(decodeId);
  let i = from;
  while (i < to) {
    const ch = text[i];
    if (ch === FSI) {
      let bound = to;
      for (let j = i + 1; j < to; j++) if (text[j] === FSI || text[j] === '\n') { bound = j; break; }
      const pdi = text.indexOf(PDI, i + 1);
      let end: number;
      if (pdi >= 0 && pdi < bound) end = pdi + 1;
      else {
        let lastDigit = -1;
        for (let j = i + 1; j < bound; j++) if (DIGIT_RE.test(text[j])) lastDigit = j;
        end = lastDigit >= 0 ? lastDigit + 1 : Math.min(bound, i + DAMAGE_REACH);
      }
      out.push({ s: i, e: end, rep: '', ids: idsIn(text.slice(i, end)) });
      i = end;
      continue;
    }
    if (ch === PDI) {
      let s = i;
      while (s > from && DIGIT_RE.test(text[s - 1])) s -= 1;
      for (let j = s - 1; j >= Math.max(from, i - DAMAGE_REACH); j--) {
        if (text[j] === '\n' || text[j] === PDI || text[j] === FSI) break;
        if ((text[j] === GLYPH_NOTE || text[j] === GLYPH_REPLY) && text[j + 1] === NBSP) { s = j; break; }
      }
      // Never reach back over an edit already made.
      const prev = out[out.length - 1];
      if (prev && s < prev.e) s = prev.e;
      out.push({ s, e: i + 1, rep: '', ids: idsIn(text.slice(s, i + 1)) });
      i += 1;
      continue;
    }
    if (DIGIT_RE.test(ch)) {
      let e = i;
      while (e < to && DIGIT_RE.test(text[e])) e += 1;
      // Digits right before a PDI belong to that PDI's remains.
      if (text[e] === PDI) { i = e; continue; }
      out.push({ s: i, e, rep: '', ids: [decodeId(text.slice(i, e))] });
      i = e;
      continue;
    }
    i += 1;
  }
  return out;
}

/**
 * The draft as the chips must stand after any edit the composer did not make itself (cut, drag,
 * autocorrect, a paste already sanitised, an external adoption). Each well-formed token is matched
 * by id to a staged About ref (`pending` ones are skipped: their tokens are not in yet); a token
 * no ref claims becomes plain text; a damaged token's remains go whole (and its ref with them);
 * a staged ref with no token is `dropped` (the caller keeps it in `recent`). `caret` follows.
 */
export function reconcileRefs(
  draft: string, staged: readonly Attachment[], caret = draft.length,
): { draft: string; caret: number; keep: Attachment[]; dropped: Attachment[] } {
  const abouts = staged.filter((a) => a.kind === 'about' && !a.pending);
  const byId = new Map(abouts.map((a) => [refTokenId(a), a] as const));
  const spans = parseRefTokens(draft);
  const edits: Edit[] = [];
  const keep: Attachment[] = [];
  let pos = 0;
  for (const t of spans) {
    edits.push(...damageEdits(draft, pos, t.start));
    const att = byId.get(t.id);
    if (att && !keep.includes(att)) keep.push(att);
    else edits.push({ s: t.start, e: t.end, rep: asText(t) });
    pos = t.end;
  }
  edits.push(...damageEdits(draft, pos, draft.length));
  const dropped = abouts.filter((a) => !keep.includes(a));
  if (!edits.length) return { draft, caret, keep, dropped };
  const done = applyEdits(draft, edits, caret);
  return { draft: done.text, caret: done.caret, keep, dropped };
}

/** What a paste does to the chips. */
export interface PasteResult {
  /** The text to insert: restored tokens kept, every other token as plain text. */
  text: string;
  /** Refs whose tokens the paste brings back (from `recent`, or staged within the replaced range). */
  restore: Attachment[];
  /** Ids of staged refs to flash: a pasted copy of a chip already in the box became text. */
  flash: string[];
  /** A pasted chip would have made more than MAX_MESSAGE_REFS: it became text, the notice shows. */
  max: boolean;
}

/**
 * A paste never forges a chip (plan R2-4, R3-1). A pasted token stays a chip only when (a) its
 * id and label name a ref staged in, or in `recent` for, this conversation; (b) that id is not
 * in the draft outside the replaced range `[selStart, selEnd)`, nor earlier in this paste;
 * (c) no other staged ref outside that range names the same target; (d) the chip count after
 * the paste is at most MAX_MESSAGE_REFS. Evaluated token by token, in order.
 */
export function sanitizePaste(
  pasted: string,
  ctx: { draft: string; selStart: number; selEnd: number; staged: readonly Attachment[]; recent: readonly Attachment[] },
): PasteResult {
  const spans = parseRefTokens(pasted);
  const outsideSpans = parseRefTokens(ctx.draft).filter((t) => t.end <= ctx.selStart || t.start >= ctx.selEnd);
  const outsideIds = new Set(outsideSpans.map((t) => t.id));
  const abouts = ctx.staged.filter((a) => a.kind === 'about');
  const outsideRefs = abouts.filter((a) => a.pending || outsideIds.has(refTokenId(a)));
  const takenKeys = new Set(outsideRefs.map(refKey).filter(Boolean) as string[]);
  const candidates = [...abouts, ...ctx.recent.filter((a) => a.kind === 'about')];
  let count = outsideIds.size + abouts.filter((a) => a.pending).length;
  const seen = new Set<string>();
  const restore: Attachment[] = [];
  const flash: string[] = [];
  let max = false;
  let text = '';
  let pos = 0;
  for (const t of spans) {
    text += stripStray(pasted.slice(pos, t.start));
    pos = t.end;
    const cand = candidates.find((a) => refTokenId(a) === t.id && refLabel(a) === t.label);
    const key = cand ? refKey(cand) : null;
    const dup = !cand || outsideIds.has(t.id) || seen.has(t.id) || (!!key && takenKeys.has(key));
    if (dup) {
      const same = abouts.find((a) => refTokenId(a) === t.id) ?? (key ? outsideRefs.find((a) => refKey(a) === key) : undefined);
      if (same && !flash.includes(same.id)) flash.push(same.id);
      text += asText(t);
      continue;
    }
    if (count + 1 > MAX_MESSAGE_REFS) { max = true; text += asText(t); continue; }
    count += 1;
    seen.add(t.id);
    if (key) takenKeys.add(key);
    restore.push(cand);
    text += pasted.slice(t.start, t.end);
  }
  text += stripStray(pasted.slice(pos));
  return { text, restore, flash, max };
}

/** What a chip reads for a ref the window reads back from a sent message. */
export interface RefLabelWords {
  /** An open question's row ("a question"); `label` may name it better. */
  question: string;
  /** Before a reply to the Super's message ("Super:"). */
  super: string;
  /** Before a reply to his own message ("You:"). */
  own: string;
}
export const REF_LABEL_WORDS_EN: RefLabelWords = { question: 'a question', super: 'Super:', own: 'You:' };

/** The chip's name for what a sent part is about (the words, before `refLabel` clips them). */
export function refNameFor(about: MessageAbout, words: RefLabelWords = REF_LABEL_WORDS_EN): string {
  if (about.kind === 'reply') return `${about.from === 'super' ? words.super : words.own} ${about.quote}`;
  if (about.kind === 'note') return about.line ?? '';
  return words.question;
}

/** A line he typed that would read as a header carries a leading U+200B on the wire; read back,
 *  the mark goes, and the next send puts it back. */
const NEUTRALISED_RE = /(^|\n)\u200B(?=\[(?:About agenda line |Reply to message ref=))/g;

/**
 * A sent message back as a draft with chips (the inverse of `composeOutgoing`, D3): ↑ recall and
 * the rewind prefill, so raw header text never appears in the box. Every header becomes a staged
 * ref (`mint` gives its attachment id) and its token stands where the header stood; the words keep
 * their place. Idempotent: a draft with tokens and no header lines comes back unchanged.
 */
export function draftFromMessage(
  message: string,
  opts: { mint: () => string; words?: RefLabelWords; label?: (about: MessageAbout) => string | undefined },
): { draft: string; refs: Attachment[] } {
  const text = typeof message === 'string' ? message : '';
  const heads = aboutHeads(text);
  if (!heads.length) return { draft: text.replace(NEUTRALISED_RE, '$1'), refs: [] };
  const refs: Attachment[] = [];
  const pieces: string[] = [];
  const pre = text.slice(0, heads[0].at).replace(/\n+$/, '');
  if (pre.trim()) pieces.push(pre);
  heads.forEach((h, i) => {
    const block = text.slice(h.at, h.end);
    const about = splitAbout(block).about;
    const next = i + 1 < heads.length ? heads[i + 1].at : text.length;
    const words = text.slice(h.end, next).replace(/^\n+/, '').replace(/\n+$/, '');
    if (about) {
      const att: Attachment = { id: opts.mint(), kind: 'about', name: opts.label?.(about) ?? refNameFor(about, opts.words), text: block };
      refs.push(att);
      pieces.push(refToken(att));
    } else pieces.push(block);
    if (words.trim()) pieces.push(words);
  });
  return { draft: pieces.join(' ').replace(NEUTRALISED_RE, '$1'), refs };
}
