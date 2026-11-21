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

/**
 * Consent matches display (G2): true when `text`, escaped into a Telegram message, reaches the
 * phone exactly as written. The transport redacts the ESCAPED html, where `&quot;`, `&amp;`,
 * `&lt;` and `&gt;` shift what a secret rule matches, so a check on the raw text alone can pass
 * a value the phone then shows as `[gizli]`. Every card that offers a yes on the text it shows
 * (a permission's Allow, a run's Çalıştır, an automation's Onayla) asks this.
 */
export function showsAsWritten(text: string): boolean {
  return !wouldRedact(text) && !wouldRedact(escapeHtml(text));
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
  /** A long text keeps its first paragraphs open and the rest in an expandable quote. `true`: a
   *  routine's forwarded result (`foldLong`, past ~900 visible characters). `'answer'`: what a
   *  bot's Super writes him (owner 2026-11-21, "Hepsini uygula" on Doc's diagnosis, replacing the
   *  2026-11-14 "never folds"): the writer's `**Ayrıntı**` quote folds; an unmarked answer folds only its
   *  extra groups past ~1,200 characters, never the answer or a state line (`foldAnswer`). Off by default. */
  fold?: boolean | 'answer';
}

/** The fences the hub sends as their own message in `'hub'` mode (M5). */
export function hubDrawsFence(lang: string, body: string): boolean {
  if (lang === 'dream-html' || lang === 'dream-actions') return true;
  if (lang !== 'dream-view') return false;
  try { return ['insight', 'agent-thread', 'automation', 'app-request'].includes(String((JSON.parse(body) as { type?: unknown }).type)); } catch { return false; }
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
  s = s.replace(/\[([^\]\n]+)\]\((?:<([^>\n]+)>|((?:[^()\s]|\([^()\s]*\))+))(?:\s+"[^"\n]*")?\)/g, (m, label: string, angled: string | undefined, plain: string | undefined) => {
    const href = (angled ?? plain ?? '').trim();
    const safe = safeHref(href);
    // A local target (a project path, `file:`, an anchor) means nothing on a phone and leaks an
    // internal path: show the label alone. A scheme link we do not send (mailto:, tel:) stays as written.
    if (!safe) return /^(?:mailto|tel|tg|sms):/i.test(href) ? m : label;
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

/** The head that folds a quote (TELEGRAM_WRITING_RULE): `**Ayrıntı**`, its plural, or the English word. */
const DETAIL_HEAD = /^\*\*(?:ayrıntı|ayrıntılar|detay|detaylar|details?)\*\*:?$/iu;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;
function tableCells(row: string): string[] {
  return row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

/** `block`: a quote, a code block, a rule or a "Mac'te" line: its own box on the phone, so no gap rule. */
type LineKind = 'head' | 'top' | 'sub' | 'text' | 'block' | 'blank';

/** Telegram drops leading ASCII spaces; a no-break space survives, so a sub-item's indent shows. */
export const SUB_INDENT = '\u00a0\u00a0\u00a0\u00a0';
/** One marker per list level: a sub-item never looks like its parent. */
export const SUB_MARKER = ['•', '◦', '▪'] as const;

/** A list line's level, at most 2: how many deeper indents than the run's own it sits under, so
 *  two, four or a tab per level all read the same. `levels` is the run's indent stack. */
function listDepth(indent: string, levels: number[]): number {
  const width = indent.replace(/\t/g, '    ').length;
  while (levels.length && levels[levels.length - 1] > width) levels.pop();
  if (!levels.length || levels[levels.length - 1] < width) levels.push(width);
  return Math.min(2, levels.length - 1);
}

/** A line that is all bold (`**İadeler: …**`): a section head, kept on its own line with room above. */
function isBoldHead(line: string): boolean {
  const t = line.trim();
  return /^\*\*[^*\n]+\*\*$/.test(t) && Array.from(t).length <= 124;
}

/**
 * A short line of its own that ends with ':' and opens a list ("Senden beklenenler:") is a
 * section head: drawn bold like a `#` heading. Only at a paragraph start (first line or after a
 * blank one), at most 60 characters, not already marked up, so a sentence ending in ':' inside a
 * paragraph stays as written.
 */
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

// ─── Markdown pictures ──────────────────────────────────────────────────────

/** `![alt](src)`, `![alt](<src with spaces>)`, an optional "title". Code spans are matched first
 *  (the first alternative) so a picture written inside backticks stays text. */
const IMAGE_OR_CODE = /`[^`\n]+`|!\[([^\]\n]*)\]\((?:<([^>\n]+)>|((?:[^()\s]|\([^()\s]*\))+))(?:\s+"[^"\n]*")?\)/g;

export interface MarkdownImage { alt: string; src: string; web: boolean }

const isWebSrc = (src: string): boolean => /^https?:\/\//i.test(src);
function localSrc(src: string): string {
  const s = src.replace(/^file:\/\//i, '');
  try { return decodeURIComponent(s); } catch { return s; }
}

/** Each line of `md` outside a code fence, with its index (`fn` returns the replacement). */
function mapProseLines(md: string, fn: (line: string) => string | null): string[] {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of md.split('\n')) {
    const f = /^[ \t]*(```|~~~)/.exec(line);
    if (fence) { if (line.trim().startsWith(fence)) fence = null; out.push(line); continue; }
    if (f) { fence = f[1]; out.push(line); continue; }
    const r = fn(line);
    if (r !== null) out.push(r);
  }
  return out;
}

/**
 * The pictures a text shows (`![alt](path)`), outside code fences and code spans, in order. The
 * hub sends each local one as a photo after the text (`blocks.ts`); a web one stays a link in
 * the text. Owner 2026-11-13: a child's screenshot in the Super's answer reached the phone as
 * nothing at all.
 */
export function markdownImages(md: string): MarkdownImage[] {
  const found: MarkdownImage[] = [];
  mapProseLines(stripReplyMarks(md), (line) => {
    for (const m of line.matchAll(IMAGE_OR_CODE)) {
      if (m[0].startsWith('`')) continue;
      const raw = (m[2] ?? m[3] ?? '').trim();
      if (!raw) continue;
      const web = isWebSrc(raw);
      found.push({ alt: m[1].trim(), src: web ? raw : localSrc(raw), web });
    }
    return line;
  });
  return found;
}

const FILE_LINK_OR_CODE = /`[^`\n]+`|(^|[^!])\[([^\]\n]+)\]\((?:<([^>\n]+)>|((?:[^()\s]|\([^()\s]*\))+))(?:\s+"[^"\n]*")?\)/g;
const DOC_FILE = /\.pdf$/i;
/** A line that is only a local PDF link (in a list item or not): in `'hub'` mode the hub sends the
 *  file itself, so the line goes. */
const DOC_LINE = /^\s*(?:[-*+]\s+)?\[[^\]\n]+\]\((?:<[^>\n]+>|[^()\s]+)(?:\s+"[^"\n]*")?\)\s*$/;

/**
 * The files a text links (`[label](path.pdf)`), local ones only, outside code fences and code
 * spans, in order. The hub sends each as a document after the text (`blocks.ts`); owner
 * 2026-11-21: a PDF the Super linked reached his phone as its label, a file he could not open.
 */
export function markdownFileLinks(md: string): MarkdownImage[] {
  const found: MarkdownImage[] = [];
  mapProseLines(stripReplyMarks(md), (line) => {
    for (const m of line.matchAll(FILE_LINK_OR_CODE)) {
      if (m[0].startsWith('`')) continue;
      const raw = (m[3] ?? m[4] ?? '').trim();
      if (!raw || isWebSrc(raw) || /^[a-z][a-z0-9+.-]*:/i.test(raw.replace(/^file:\/\//i, ''))) continue;
      const src = localSrc(raw);
      if (DOC_FILE.test(src.split(/[?#]/)[0])) found.push({ alt: m[2].trim(), src: src.split(/[?#]/)[0], web: false });
    }
    return line;
  });
  return found;
}

/** A picture's name for a caption or a line: its alt text, else its file name. */
export function imageName(img: Pick<MarkdownImage, 'alt' | 'src'>): string {
  const alt = img.alt.replace(/^\.+$/, '').trim();
  return alt || img.src.split(/[\\/]/).pop() || 'resim';
}

/** The text with its pictures rewritten: a web picture → a link; a local one → nothing in
 *  `'hub'` mode (the hub sends the picture itself after the text), else "Resim: name (Mac'te)".
 *  A line left with nothing but its list marker goes. */
/** Where a removed picture stood, until the line is tidied (never in a written text). */
const GONE = '\u0002';
function picturesOut(md: string, mode: 'mac' | 'hub'): string {
  return mapProseLines(md, (line) => {
    if (mode === 'hub' && DOC_LINE.test(line) && markdownFileLinks(line).length) return null;
    let touched = false;
    const next = line.replace(IMAGE_OR_CODE, (m: string, alt: string | undefined, a: string | undefined, b: string | undefined) => {
      if (m.startsWith('`')) return m;
      const raw = (a ?? b ?? '').trim();
      if (!raw) return m;
      touched = true;
      const name = imageName({ alt: alt ?? '', src: isWebSrc(raw) ? raw : localSrc(raw) });
      if (isWebSrc(raw)) return `[${name.replace(/[[\]]/g, '')}](${raw})`;
      return mode === 'hub' ? GONE : `Resim: ${name} (Mac'te)`;
    });
    if (!touched) return next;
    // Markup that wrapped ONLY a removed picture (`**![a](p)**`, `~~…~~`, `==…==`) goes with it (a
    // bare `~~~~` would open a code fence that swallows the rest); markup of the words around it stays.
    let tidy = next.replace(new RegExp(`(^|\\s)(\\*\\*|~~|==)\\s*${GONE}\\s*\\2(?=\\s|$|[.,;:!?)])`, 'g'), '$1').split(GONE).join('').replace(/(\S) {2,}/g, '$1 ').replace(/[ \t]+$/, '');
    if (!/^\s/.test(line)) tidy = tidy.trimStart();
    // A line left with only its list marker, a heading mark, a quote mark or punctuation goes.
    if (line.trim() && /^\s*(?:[-*+>#|]|\d{1,3}[.)])*\s*[:.,;–|-]?\s*$/.test(tidy)) return null;
    return tidy;
  }).join('\n');
}

/** Markdown (a Super/member text) → Telegram HTML. Reply marks are stripped first. */
export function markdownToTelegramHtml(md: string, opts: FormatOptions = {}): string {
  const lines = picturesOut(stripReplyMarks(md), opts.blocks ?? 'mac').split('\n');
  const out: string[] = [];
  // Readability on a phone (owner 2026-11-10, "okuması çok güç"; 2026-11-14, B2): a sub-item gets
  // its own marker and a visible indent, a heading never sticks to the line above it, and a list
  // is a group of its own: a blank line before it (unless the line above leads into it with ':')
  // and after it, so the facts never glue to the sentences around them.
  let last = 'blank' as LineKind; // set inside push(): a plain annotation narrows it to 'blank'
  // The line above a list leads into it (no gap): it ends with ':' or opens with a bold head
  // (`**Aldım** (14 video)`), the B2 group head with a note beside it.
  let leadsIn = false;
  const levels: number[] = [];
  const push = (html: string, kind: LineKind): void => {
    if (kind === 'head') levels.length = 0;
    const gap = out.length > 0 && last !== 'blank' && (
      (kind === 'head' && last !== 'head')
      || (last === 'sub' && kind !== 'sub' && kind !== 'blank')
      || (kind === 'top' && last === 'text' && !leadsIn)
      || (kind === 'text' && last === 'top')
    );
    if (gap) out.push('');
    out.push(html);
    last = kind;
    leadsIn = kind === 'text' && (html.startsWith('<b>') || telegramHtmlToPlain(html).trimEnd().endsWith(':'));
  };
  const list = (indent: string, marker: string, body: string): void => {
    const depth = listDepth(indent, levels);
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
        if (!isSilentView(lang, text)) push(`<i>Mac'te: ${escapeHtml(oneLine(fenceTitle(lang, text)))}</i>`, 'block');
      } else if (opts.codeFences === 'mac') {
        push(`<i>Mac'te: ${escapeHtml(lang ? `${lang} kodu` : 'kod')}</i>`, 'block');
      } else {
        push(lang ? `<pre><code class="language-${escapeHtml(lang)}">${escapeHtml(text)}</code></pre>` : `<pre>${escapeHtml(text)}</pre>`, 'block');
      }
      continue;
    }
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
    if (heading) { push(`<b>${inline(heading[1].replace(/\s*#+\s*$/, ''))}</b>`, 'head'); i++; continue; }
    if (/^\s*>/.test(line)) {
      const raw: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) raw.push(lines[i++].replace(/^\s*>\s?/, ''));
      // A quote that opens with its `**Ayrıntı**` head is detail he did not ask for: it opens
      // folded (Bot API 7.4 expandable quote, TELEGRAM_WRITING_RULE). Its body is inline only
      // (a quote holds no code block or quote here), so Telegram never refuses the nesting.
      const fold = raw.length > 1 && DETAIL_HEAD.test(raw[0].trim());
      push(`<blockquote${fold ? ' expandable' : ''}>${raw.map(inline).join('\n')}</blockquote>`, 'block');
      continue;
    }
    // A markdown table (Telegram draws none): each body row becomes one bullet, "first: rest".
    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1])) {
      const head = tableCells(line);
      i += 2;
      while (i < lines.length && TABLE_ROW.test(lines[i])) {
        const cells = tableCells(lines[i++]);
        const rest = cells.slice(1).map((c, k) => (head[k + 1] ? `${head[k + 1]} ${c}` : c)).filter((c) => c.trim());
        list('', '•', rest.length ? `${cells[0]}: ${rest.join(' · ')}` : cells[0] ?? '');
      }
      continue;
    }
    const bullet = /^([ \t]*)[-*+•]\s+(.*)$/.exec(line);
    if (bullet) { list(bullet[1], '•', bullet[2]); i++; continue; }
    const numbered = /^([ \t]*)(\d{1,3})[.)]\s+(.*)$/.exec(line);
    if (numbered) { list(numbered[1], `${numbered[2]}.`, numbered[3]); i++; continue; }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { push('──────', 'block'); i++; continue; }
    if (isSectionHead(lines, i) || isBoldHead(line)) { push(`<b>${inline(line.trim().replace(/^\*\*(.*)\*\*$/, '$1'))}</b>`, 'head'); i++; continue; }
    // An indented line under a list item is its continuation: the run's levels stay; a line at the
    // margin ends the list.
    if (line.trim() && !/^[ \t]/.test(line)) levels.length = 0;
    // An indented line right under an item continues it: it stays in the item's group (no gap).
    const cont = !!line.trim() && /^[ \t]/.test(line) && (last === 'top' || last === 'sub');
    push(inline(line), !line.trim() ? 'blank' : cont ? last : 'text');
    i++;
  }
  const html = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return opts.fold === true ? foldLong(html) : opts.fold === 'answer' ? foldAnswer(html) : html;
}

/** Visible characters an unmarked answer may show before anything folds (owner 2026-11-21,
 *  "under-information": about a phone screen and a half; the writing rule keeps answers far
 *  shorter, this is only the net under a reply written the old way). */
export const ANSWER_FOLD_AT = 1200;

/** Open `<pre>`/`<blockquote>` tags minus closed ones in a piece of converter HTML. */
function openDepth(b: string): number {
  return (b.match(/<(?:pre|blockquote)\b/gi)?.length ?? 0) - (b.match(/<\/(?:pre|blockquote)>/gi)?.length ?? 0);
}

/** A line that says where the work stands (owner 2026-11-21: "under-information"): it never folds.
 *  Over-keeping is the safe side: a state line folded away is information he lost. */
const STATE_LINE = /(?:^|[^\p{L}])(?:sürüyor|devam ediyor|henüz|hâlâ|bekliyor|bekleniyor|bekleyen|yapılıyor|yazılıyor|bitince|bitti|bitenler|tamamlandı|yazıldı|geçti|durdu|takıldı|başarısız|çalışıyor|onay(?:ını|ın|ınızı)? bekl|still running|waiting|blocked|pending|not yet)/iu;
export function isStateLine(html: string): boolean { return STATE_LINE.test(telegramHtmlToPlain(html)); }

/**
 * An answer on his phone (owner 2026-11-21, "Hepsini uygula", then "sadece son kısımda
 * under-information mı verecek super diye çekindim"): what he asked is never folded. Only the
 * writer knows which part that is, so the code folds only what it can trust (nothing is deleted;
 * a fold is an expandable quote he opens with a tap):
 *  - a `**Ayrıntı**` quote means the writer marked the extras: nothing else folds;
 *  - an unmarked answer up to ~1,200 visible characters stays whole;
 *  - past that, the answer stays open (the first block, any blocks before the first head, and the
 *    first group after it) and so does every later group with a state line in it (sürüyor, henüz,
 *    bekliyor, yapılıyor, bitince…), whole; the other groups fold.
 * A code block or a plain quote cannot sit inside a fold (Telegram nests neither): it stays in
 * its place.
 */
export function foldAnswer(html: string): string {
  const visible = (h: string): number => telegramHtmlToPlain(h).length;
  if (visible(html) <= ANSWER_FOLD_AT) return html;
  // Top-level blocks: a blank line inside a code block or a quote does not end it.
  const tops: string[] = [];
  let cur: string[] = [];
  let depth = 0;
  for (const b of html.split('\n\n')) {
    cur.push(b);
    depth += openDepth(b);
    if (depth <= 0) { tops.push(cur.join('\n\n')); cur = []; depth = 0; }
  }
  if (cur.length) tops.push(cur.join('\n\n'));
  const nested = (b: string): boolean => /<(?:pre|blockquote)\b/i.test(b);
  // The writer marked the extras: what stands outside that quote is what he asked.
  if (tops.some((b) => /^<blockquote expandable>/.test(b))) return html;
  const isHead = (b: string): boolean => /^<b>(?:(?!<\/b>).)*<\/b>$/.test(b.split('\n')[0]);
  const heads = tops.map((b, k) => k > 0 && isHead(b));
  const firstHead = heads.indexOf(true);
  // The answer: through the end of the first head's group, or the first block after the lead.
  let answerEnd: number;
  if (firstHead < 0) answerEnd = Math.min(1, tops.length - 1);
  else {
    answerEnd = firstHead;
    while (answerEnd + 1 < tops.length && !heads[answerEnd + 1]) answerEnd++;
  }
  const out = tops.slice(0, answerEnd + 1);
  let fold: string[] = [];
  const flush = (): void => { if (fold.length) out.push(`<blockquote expandable>${fold.join('\n\n')}</blockquote>`); fold = []; };
  for (let k = answerEnd + 1; k < tops.length; k++) {
    const b = tops[k];
    // A code block or plain quote stays in place; a block that says where work stands stays whole.
    if (nested(b) || b.split('\n').some(isStateLine) || (isHead(b) && /^(?:durum|status)(?:[^\p{L}]|$)/iu.test(telegramHtmlToPlain(b.split('\n')[0])))) { flush(); out.push(b); continue; }
    fold.push(b);
  }
  flush();
  return out.join('\n\n');
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
  // A blank line also sits INSIDE a code block or a quote: the fold may only fall between
  // top-level blocks, where no <pre>/<blockquote> is open (else Telegram refuses the nesting and
  // the reply goes out as plain text, the wall this exists to prevent).
  const blocks = html.split('\n\n');
  if (blocks.length < 2) return html;
  const opens = (b: string): number => (b.match(/<(?:pre|blockquote)\b/gi)?.length ?? 0) - (b.match(/<\/(?:pre|blockquote)>/gi)?.length ?? 0);
  let depth = 0;
  let seen = 0;
  let cut = 0;
  for (let k = 0; k < blocks.length - 1; k++) {
    depth += opens(blocks[k]);
    seen += visible(blocks[k]);
    if (depth !== 0) continue;
    if (cut > 0 && seen > FOLD_HEAD) break;
    cut = k + 1;
  }
  if (cut === 0) return html;
  const rest = blocks.slice(cut).join('\n\n');
  // Code or a quote behind the fold stays open (Telegram nests neither in a quote).
  if (/<\/?(?:pre|blockquote)\b/i.test(rest) || visible(rest) < 200) return html;
  return `${blocks.slice(0, cut).join('\n\n')}\n\n<blockquote expandable>${rest}</blockquote>`;
}

/** The whole pipeline for one outbound text: redact, format, split. */
export function toTelegramMessages(md: string, opts: FormatOptions = {}): string[] {
  // A message with no visible text (a quote or strike that held only a picture the hub sends
  // itself) is not sent: Telegram refuses it, and that refusal would skip the pictures after it.
  return splitTelegramHtml(markdownToTelegramHtml(redactSecrets(md), opts)).filter((h) => telegramHtmlToPlain(h).trim() !== '');
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
