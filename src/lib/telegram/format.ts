/**
 * What a Super (or a member) text becomes in Telegram.
 *
 * - `redactSecrets`: secret-shaped substrings replaced; every outbound text passes it (A6), and
 *   the transport runs it again as the last fence.
 * - `scrubLoginToken`: the hands-free login token never leaves in any body (plan "Media").
 * - `splitReplySections` / `stripReplyMarks`: the Super's line-start `<!-- re:<ref> -->`
 *   sections (outside fences), so the hub sends exactly the sections answering a Telegram ref.
 * - `markdownToTelegramHtml`: paragraphs, lists, headings (and a short `Başlık:` line opening a
 *   list, or an all-bold line, drawn bold with room above), quotes, code, links (https/http only),
 *   sub-items with their own marker and a no-break-space indent, a blank line after a group that
 *   had sub-items, and a long text folded into one expandable quote after its opening (`foldLong`),
 *   `==mark==` (the Mac highlighter, all three pens); dream fences become one
 *   "Mac'te: <başlık>" line (`dream-view` pin/title/checkout dropped, M5).
 * - `splitTelegramHtml`: ≤4096 per message, cut on a code-point boundary outside any tag or
 *   entity, open tags closed and reopened, so Turkish (and emoji) survive every split.
 */
import { TG_TEXT_MAX } from './contract.js';
import { MAC_LOGIN_TOKEN_PARAM } from '../handsfree/mac/contract.js';

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Secrets ────────────────────────────────────────────────────────────────

export const REDACTED = '[gizli]';

interface SecretRule { name: string; re: RegExp; replace?: (m: string, ...g: string[]) => string }

const SECRET_RULES: SecretRule[] = [
  { name: 'private-key', re: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END[A-Z ]*PRIVATE KEY-----|$)/g },
  { name: 'telegram-token', re: /\b\d{5,}:[A-Za-z0-9_-]{30,}/g },
  { name: 'anthropic', re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'openai', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { name: 'stripe', re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/g },
  { name: 'github', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { name: 'aws', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'google', re: /\bAIza[0-9A-Za-z_-]{35}/g },
  { name: 'slack', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { name: 'bearer', re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, replace: (_m, kind) => `${kind} ${REDACTED}` },
  { name: 'url-userinfo', re: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:"'<>]+:[^\s/@"'<>]+@/gi, replace: (_m, scheme) => `${scheme}${REDACTED}@` },
  {
    name: 'url-secret-param',
    re: /([?&](?:access_token|refresh_token|id_token|token|api[_-]?key|apikey|secret|client_secret|password|passwd|sig|signature)=)[^\s&#"'<>]+/gi,
    replace: (_m, head) => `${head}${REDACTED}`,
  },
  {
    name: 'assignment',
    re: /\b((?:password|passwd|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)["']?\s*[:=]\s*["']?)([^\s"'<>,;]{8,})/gi,
    replace: (_m, head) => `${head}${REDACTED}`,
  },
];

/** Every secret-shaped substring replaced. Idempotent. */
export function redactSecrets(text: string): string {
  let out = scrubLoginToken(String(text));
  for (const rule of SECRET_RULES) {
    out = out.replace(rule.re, (...args) => (rule.replace ? rule.replace(...(args as [string, ...string[]])) : REDACTED));
  }
  return out;
}

/** True when the redactor would change `text` (a run card's command, an approval review: no
 *  button then, H2/H3). */
export function wouldRedact(text: string): boolean {
  return redactSecrets(text) !== text;
}

const LOGIN_TOKEN_RE = new RegExp(`(/login)\\?(?:[^\\s"'<>#]*&)?${MAC_LOGIN_TOKEN_PARAM}=[^\\s"'<>#]*`, 'g');

/** The hands-free QR's `/login?t=<token>` keeps its path only (the passphrase signs in). */
export function scrubLoginToken(text: string): string {
  return String(text).replace(LOGIN_TOKEN_RE, '$1');
}

// ─── The Super's reply marks ────────────────────────────────────────────────

const MARK_AT_LINE = /^[ \t]*<!--\s*re:([^\n>]*?)-->[ \t]*$/;
const MARK_HEAD = /^[ \t]*<!--\s*re:([^\n>]*?)-->[ \t]*/;
const FENCE_LINE = /^[ \t]*(```|~~~)/;
const REF_RE = /^[0-9a-z]{6}$/;

export interface ReplySection { refs: string[]; text: string }

/**
 * The text cut at each line-start reply mark outside a code fence (the server twin of
 * `replyMarkRefs`). Text before the first mark is a section with no refs. Marks are removed.
 */
export function splitReplySections(text: string): ReplySection[] {
  const sections: ReplySection[] = [{ refs: [], text: '' }];
  let fence: string | null = null;
  const lines: string[][] = [[]];
  for (const line of text.split('\n')) {
    const f = FENCE_LINE.exec(line);
    if (f) fence = fence === null ? f[1] : fence === f[1] ? null : fence;
    const m = fence === null && !f ? MARK_HEAD.exec(line) : null;
    if (m) {
      const refs = m[1].split(/[\s,]+/).map((r) => r.trim().toLowerCase()).filter((r) => REF_RE.test(r));
      const rest = line.slice(m[0].length);
      sections.push({ refs, text: '' });
      lines.push(rest.trim() ? [rest] : []);
      continue;
    }
    lines[lines.length - 1].push(line);
  }
  sections.forEach((s, i) => { s.text = lines[i].join('\n').trim(); });
  return sections.filter((s, i) => i > 0 || s.text);
}

/** Every reply mark line removed (hands-free streaming sends the whole text, B1). */
export function stripReplyMarks(text: string): string {
  return splitReplySections(text).map((s) => s.text).filter(Boolean).join('\n\n');
}

// ─── Fence adapters ─────────────────────────────────────────────────────────

const DREAM_FENCES = new Set(['dream-html', 'dream-view', 'dream-actions', 'mermaid', 'excalidraw', 'dream-checklist']);
const SILENT_VIEWS = new Set(['pin', 'title', 'checkout']);

function textOfHtml(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();
}

/** A one-line title for a fence the phone cannot draw. */
export function fenceTitle(lang: string, body: string): string {
  if (lang === 'dream-html') {
    const h = /<(h[1-3])\b[^>]*>([\s\S]*?)<\/\1>/i.exec(body)
      ?? /class="[^"]*\bdc-(?:h1|h2|card-title|option-title)\b[^"]*"[^>]*>([\s\S]*?)</i.exec(body);
    const title = h ? textOfHtml(h[h.length - 1]) : '';
    return title || 'bir kart';
  }
  if (lang === 'dream-view') {
    try {
      const v = JSON.parse(body) as { type?: string; title?: string; id?: string };
      return v.title || v.id || v.type || 'bir kart';
    } catch { return 'bir kart'; }
  }
  if (lang === 'dream-actions') {
    try {
      const a = JSON.parse(body);
      return Array.isArray(a) ? `${a.length} düğme` : 'düğmeler';
    } catch { return 'düğmeler'; }
  }
  if (lang === 'mermaid') return 'bir diyagram';
  return 'bir kart';
}

function isSilentView(lang: string, body: string): boolean {
  if (lang !== 'dream-view') return false;
  try { return SILENT_VIEWS.has(String((JSON.parse(body) as { type?: unknown }).type)); } catch { return false; }
}

function oneLine(text: string, max = 80): string {
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, ' ').replace(/\s+/g, ' ').trim();
  const cps = Array.from(clean);
  return cps.length > max ? `${cps.slice(0, max - 1).join('')}…` : clean;
}

// ─── Markdown → Telegram HTML ───────────────────────────────────────────────

export interface FormatOptions {
  /** Ordinary code fences: kept as <pre> (chat answers) or one "Mac'te" line (routine forwards, W6). */
  codeFences?: 'pre' | 'mac';
  /** Dream fences the hub draws itself (`blocks.ts`: dream-html pictures, dream-actions buttons,
   *  insight / agent-thread / automation views) are left out of the text with `'hub'`; with
   *  `'mac'` (the default, e.g. routine forwards) every dream fence is one "Mac'te" line. */
  blocks?: 'mac' | 'hub';
  /** A long text keeps its first paragraphs open and the rest in an expandable quote (default on). */
  fold?: boolean;
}

/** The fences the hub sends as their own message in `'hub'` mode (M5). */
export function hubDrawsFence(lang: string, body: string): boolean {
  if (lang === 'dream-html' || lang === 'dream-actions') return true;
  if (lang !== 'dream-view') return false;
  try { return ['insight', 'agent-thread', 'automation'].includes(String((JSON.parse(body) as { type?: unknown }).type)); } catch { return false; }
}

function safeHref(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.href;
  } catch { return null; }
}

/** Inline markdown on ONE line of raw text → HTML. Code spans are protected first. */
function inline(raw: string): string {
  const codes: string[] = [];
  let s = raw.replace(/`([^`\n]+)`/g, (_m, c: string) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  const links: string[] = [];
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, label: string, href: string) => {
    const safe = safeHref(href);
    if (!safe) return m;
    links.push(`<a href="${escapeHtml(safe)}">${escapeHtml(label)}</a>`);
    return `\u0001${links.length - 1}\u0001`;
  });
  s = escapeHtml(s);
  s = s.replace(/==[!+]?([^=\n]+?)==/g, '<b>$1</b>');
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<b>$1</b>').replace(/__([^_\n]+?)__/g, '<b>$1</b>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\*)/g, '$1<i>$2</i>').replace(/(^|[^_\w])_([^_\n]+?)_(?![_\w])/g, '$1<i>$2</i>');
  s = s.replace(/~~([^~\n]+?)~~/g, '<s>$1</s>');
  s = s.replace(/\u0001(\d+)\u0001/g, (_m, i: string) => links[Number(i)]);
  s = s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => `<code>${escapeHtml(codes[Number(i)])}</code>`);
  return s;
}

const LIST_LINE = /^\s*(?:[-*+]|\d{1,3}[.)])\s+\S/;

/**
 * A short line of its own that ends with ':' and opens a list ("Senden beklenenler:") is a
 * section head: drawn bold like a `#` heading. Only at a paragraph start (first line or after a
 * blank one), at most 60 characters, not already marked up, so a sentence ending in ':' inside a
 * paragraph stays as written.
 */
type LineKind = 'head' | 'top' | 'sub' | 'text' | 'blank';

/** Telegram drops leading ASCII spaces; a no-break space survives, so a sub-item's indent shows. */
export const SUB_INDENT = '    ';
/** One marker per list level: a sub-item never looks like its parent. */
export const SUB_MARKER = ['•', '◦', '▪'] as const;

/** A list line's level from its indent (two spaces or a tab per level), at most 2. */
function listDepth(indent: string): number {
  const width = indent.replace(/\t/g, '  ').length;
  return Math.min(2, Math.floor(width / 2));
}

/** A line that is all bold (`**İadeler: …**`): a section head, kept on its own line with room above. */
function isBoldHead(line: string): boolean {
  const t = line.trim();
  return /^\*\*[^*\n]+\*\*$/.test(t) && Array.from(t).length <= 124;
}

function isSectionHead(lines: string[], i: number): boolean {
  const t = lines[i].trim();
  if (!t.endsWith(':') || t.length < 2 || Array.from(t).length > 60) return false;
  if (/[*_`=<\[]/.test(t) || LIST_LINE.test(lines[i])) return false;
  if (i > 0 && lines[i - 1].trim() !== '') return false;
  return i + 1 < lines.length && LIST_LINE.test(lines[i + 1]);
}

/** Telegram HTML back to the text it shows: tags dropped, the four escapes undone. The resend
 *  when Telegram refuses a message's entities (a message is never lost to formatting). */
export function telegramHtmlToPlain(html: string): string {
  return html.replace(/<a\s+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
    const h = href.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    return label === h ? label : `${label} (${h})`;
  }).replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

/** Markdown (a Super/member text) → Telegram HTML. Reply marks are stripped first. */
export function markdownToTelegramHtml(md: string, opts: FormatOptions = {}): string {
  const lines = stripReplyMarks(md).split('\n');
  const out: string[] = [];
  // Readability on a phone (owner 2026-11-10, "okuması çok güç"): a sub-item gets its own marker
  // and a visible indent, a group that had sub-items is followed by a blank line, and a heading
  // never sticks to the line above it.
  let last: LineKind = 'blank';
  const push = (html: string, kind: LineKind): void => {
    const gap = out.length > 0 && last !== 'blank' && (
      (kind === 'head' && last !== 'head')
      || (last === 'sub' && kind !== 'sub' && kind !== 'blank')
    );
    if (gap) out.push('');
    out.push(html);
    last = kind;
  };
  const list = (indent: string, marker: string, body: string): void => {
    const depth = listDepth(indent);
    push(depth === 0 ? `${marker} ${inline(body)}` : `${SUB_INDENT.repeat(depth)}${marker === '•' ? SUB_MARKER[depth] : marker} ${inline(body)}`, depth === 0 ? 'top' : 'sub');
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^[ \t]*(```|~~~)\s*([A-Za-z0-9_-]*)/.exec(line);
    if (fence) {
      const marker = fence[1];
      const lang = fence[2].toLowerCase();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(marker)) body.push(lines[i++]);
      i++; // closing fence
      const text = body.join('\n');
      if (DREAM_FENCES.has(lang)) {
        if (opts.blocks === 'hub' && hubDrawsFence(lang, text)) continue;
        if (!isSilentView(lang, text)) push(`<i>Mac'te: ${escapeHtml(oneLine(fenceTitle(lang, text)))}</i>`, 'text');
      } else if (opts.codeFences === 'mac') {
        push(`<i>Mac'te: ${escapeHtml(lang ? `${lang} kodu` : 'kod')}</i>`, 'text');
      } else {
        push(lang ? `<pre><code class="language-${escapeHtml(lang)}">${escapeHtml(text)}</code></pre>` : `<pre>${escapeHtml(text)}</pre>`, 'text');
      }
      continue;
    }
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
    if (heading) { push(`<b>${inline(heading[1].replace(/\s*#+\s*$/, ''))}</b>`, 'head'); i++; continue; }
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(inline(lines[i++].replace(/^\s*>\s?/, '')));
      push(`<blockquote>${quote.join('\n')}</blockquote>`, 'text');
      continue;
    }
    const bullet = /^([ \t]*)[-*+•]\s+(.*)$/.exec(line);
    if (bullet) { list(bullet[1], '•', bullet[2]); i++; continue; }
    const numbered = /^([ \t]*)(\d{1,3})[.)]\s+(.*)$/.exec(line);
    if (numbered) { list(numbered[1], `${numbered[2]}.`, numbered[3]); i++; continue; }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { push('──────', 'text'); i++; continue; }
    if (isSectionHead(lines, i) || isBoldHead(line)) { push(`<b>${inline(line.trim().replace(/^\*\*(.*)\*\*$/, '$1'))}</b>`, 'head'); i++; continue; }
    push(inline(line), line.trim() ? 'text' : 'blank');
    i++;
  }
  const html = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return opts.fold === false ? html : foldLong(html);
}

/** Visible characters past which a text folds (about one phone screen, 24 lines at 360pt). */
export const FOLD_AT = 900;
/** What stays open above the fold: whole paragraphs up to about this many visible characters. */
export const FOLD_HEAD = 450;

/**
 * A long text on a phone (owner 2026-11-10, "Telegramda daha okunabilir olmalı"): its first
 * paragraphs stay open and the rest goes into one expandable quote he opens with a tap (Bot API
 * 7.4 `<blockquote expandable>`). Never folds code or a quote (Telegram does not nest them), and
 * never leaves less than a paragraph behind the fold.
 */
export function foldLong(html: string): string {
  const visible = (h: string): number => telegramHtmlToPlain(h).length;
  if (visible(html) <= FOLD_AT) return html;
  const blocks = html.split('\n\n');
  if (blocks.length < 2) return html;
  let k = 0;
  let seen = 0;
  while (k < blocks.length - 1 && (k === 0 || seen + visible(blocks[k]) <= FOLD_HEAD)) seen += visible(blocks[k++]);
  const rest = blocks.slice(k).join('\n\n');
  if (/<(?:pre|blockquote)\b/i.test(rest) || visible(rest) < 200) return html;
  return `${blocks.slice(0, k).join('\n\n')}\n\n<blockquote expandable>${rest}</blockquote>`;
}

/** The whole pipeline for one outbound text: redact, format, split. */
export function toTelegramMessages(md: string, opts: FormatOptions = {}): string[] {
  return splitTelegramHtml(markdownToTelegramHtml(redactSecrets(md), opts));
}

// ─── Splitting ──────────────────────────────────────────────────────────────

interface Tok { kind: 'tag' | 'text'; s: string }

function tokenize(html: string): Tok[] {
  const out: Tok[] = [];
  const re = /<\/?[a-zA-Z][^>]*>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m.index > last) out.push({ kind: 'text', s: html.slice(last, m.index) });
    out.push({ kind: 'tag', s: m[0] });
    last = m.index + m[0].length;
  }
  if (last < html.length) out.push({ kind: 'text', s: html.slice(last) });
  return out;
}

const tagName = (tag: string): string => /^<\/?([a-zA-Z0-9-]+)/.exec(tag)![1].toLowerCase();

/** The text cut into atoms that may never be split: one code point, or one HTML entity. */
function atoms(text: string): string[] {
  const out: string[] = [];
  const re = /&(?:[a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);|[\s\S]/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[0]);
  return out;
}

/**
 * Telegram HTML cut into messages of at most `max` UTF-16 units (tags included, so the limit
 * holds however Telegram counts). Prefers a paragraph break, then a line break, then a space;
 * never cuts inside a tag, an entity or a surrogate pair. Tags open at a cut are closed at the
 * end of one part and reopened at the start of the next.
 */
export function splitTelegramHtml(html: string, max: number = TG_TEXT_MAX): string[] {
  if (html.length <= max) return html ? [html] : [];
  const parts: string[] = [];
  const open: string[] = [];
  let cur = '';
  const closers = (): string => open.slice().reverse().map((t) => `</${tagName(t)}>`).join('');
  const budget = (): number => max - closers().length;
  const flush = (): void => {
    // Back up to the best break inside the current part (outside a tag, not in an entity).
    parts.push(cur + closers());
    cur = open.join('');
  };
  for (const tok of tokenize(html)) {
    if (tok.kind === 'tag') {
      const isClose = tok.s.startsWith('</');
      const extra = isClose ? 0 : `</${tagName(tok.s)}>`.length;
      if (cur.length + tok.s.length + extra > budget() && cur.length > open.join('').length) flush();
      cur += tok.s;
      if (isClose) {
        const name = tagName(tok.s);
        const at = open.map(tagName).lastIndexOf(name);
        if (at >= 0) open.splice(at, 1);
      } else if (!tok.s.endsWith('/>')) {
        open.push(tok.s);
      }
      continue;
    }
    const as = atoms(tok.s);
    let k = 0;
    while (k < as.length) {
      const room = budget() - cur.length;
      // Take as many atoms as fit.
      let take = 0;
      let len = 0;
      while (k + take < as.length && len + as[k + take].length <= room) { len += as[k + take].length; take++; }
      if (k + take >= as.length) { cur += as.slice(k).join(''); break; }
      // Not all fit: prefer a break inside the slice that fits.
      let cut = take;
      const slice = as.slice(k, k + take);
      const pick = (pred: (a: string, i: number) => boolean): number => {
        for (let j = slice.length - 1; j > slice.length / 3; j--) if (pred(slice[j], j)) return j + 1;
        return -1;
      };
      const para = pick((a, j) => a === '\n' && slice[j - 1] === '\n');
      const nl = para > 0 ? para : pick((a) => a === '\n');
      const sp = nl > 0 ? nl : pick((a) => a === ' ');
      if (sp > 0) cut = sp;
      if (cut === 0 && cur.length <= open.join('').length) cut = 1; // a single atom bigger than the room: never loop
      cur += as.slice(k, k + cut).join('');
      k += cut;
      flush();
    }
  }
  if (cur.length > open.join('').length || parts.length === 0) parts.push(cur + closers());
  return parts.map((p) => p.replace(/^\n+|\n+$/g, '')).filter((p) => p.replace(/<[^>]+>/g, '').trim().length > 0);
}
