/**
 * Telegram'da Super sade konuşur (owner 2026-11-21, "Hepsini uygula" on Doc's diagnosis, plus his
 * 17:15 and 17:31 voice notes). The pure parts the hub uses to keep the chat quiet:
 *
 *  - one turn, one message: a short line written before a tool call (`isChatter`) never goes, a
 *    text with substance joins the turn's answer (`mergeHeld`);
 *  - a job's status is ONE message per job, from the Super's ```` ```dream-status <id> [done] ````
 *    block (`statusBlocks`), edited in place by the hub;
 *  - the agenda pin: ONE pinned message per Super bot, drawn from the Super's agenda card (`pad`):
 *    what runs now, what waits on him, what finished lately (`agendaPinHtml`). The pin is the
 *    summary, a job's status message the detail;
 *  - a raw model or network error (`isApiErrorText`, "API Error: 403 … Cloudflare") never reaches
 *    his phone: one Turkish sentence instead, at most once a day (the hub's `noticeOnce`);
 *  - the night: 00-08, while he is not writing, results of turns he did not open wait for ONE
 *    morning message (`nightDigestMarkdown`);
 *  - a voice day: once he asked for voice there, every answer that day speaks (`voiceFromText`);
 *    "yazıyla" ends it (`asksForText`).
 */
import type { SuperPadItem } from '../../lib/super/types.js';
import { escapeHtml, markdownFileLinks, markdownImages, redactSecrets, splitReplySections, telegramHtmlToPlain, markdownToTelegramHtml } from '../../lib/telegram/format.js';
import { voiceAnswer, type VoiceBlock } from '../../lib/telegram/voice-block.js';

/** A held text with no tool call or end after it goes out this soon (a provider that streams no hints). */
export const TEXT_GRACE_MS = 1500;
/** A line written before a tool call waits at most this long for the turn's answer. */
export const HELD_CAP_MS = 5 * 60_000;
/** The same notice goes at most once in this window (Doc: hands-free 20, battery 9, 403 seven times). */
export const NOTICE_ONCE_MS = 24 * 60 * 60_000;
/** The night: from this hour (inclusive) to `NIGHT_END_HOUR` (exclusive), local time. */
export const NIGHT_START_HOUR = 0;
export const NIGHT_END_HOUR = 8;
/** He counts as writing at night when his last Telegram message is newer than this. */
export const OWNER_ACTIVE_MS = 30 * 60_000;
/** A finished agenda line stays on the pin this long. */
export const PIN_DONE_MS = 12 * 60 * 60_000;
/** The pin's visible size (a summary; the detail is each job's status message). */
export const PIN_MAX = 1500;

/** The one sentence a raw model/network error becomes. */
export const API_DOWN_LINE = "Claude'a şu an ulaşılamıyor; birazdan kendiliğinden yeniden denenir, olmazsa Mac'e bak.";

// ─── One turn, one message ──────────────────────────────────────────────────

const FENCE_ANY = /^[ \t]*(```|~~~)\s*([A-Za-z0-9_-]*)/m;

/** A short line with nothing in it but words (no picture, no block, no voice): "Bakıyorum.",
 *  "Hâlâ sürüyor, bitince yazarım." Written before a tool call, it is not news for his phone. */
export function isChatter(md: string): boolean {
  const text = splitReplySections(md).map((s) => s.text).join('\n').trim();
  if (!text) return true;
  if (FENCE_ANY.test(text) || markdownImages(text).length || markdownFileLinks(text).length) return false;
  const plain = telegramHtmlToPlain(markdownToTelegramHtml(text)).replace(/\s+/g, ' ').trim();
  if (plain.length > 200) return false;
  // Only a line about the work itself is chatter ("Bakıyorum.", "Kontrol ediyorum, bitince
  // yazarım."): a short ANSWER ("Evet, bu normal.") is news and stays (owner 17:15: "under-
  // information da olmasın"). Every sentence must say what is being done or will be said.
  // Clauses, not only sentences: "Buluyorum, sonra PDF'i hazırlayacağım." is two work clauses
  // (the golden set, Doc's dc-b: three such lines reached the phone before the answer).
  const clauses = plain.split(/(?<=[.!?…])\s+|,\s*|;\s*/)
    .map((s) => s.replace(/[.!?…:]+$/, '').replace(/^(?:sonra|ardından|ve|then|and)\s+/iu, '').trim()).filter(Boolean);
  return clauses.length > 0 && clauses.every((s) => CHATTER_RE.test(s));
}

/** A sentence that only reports the work going on, in Turkish or English. */
const CHATTER_RE = new RegExp([
  // A work verb only (never "öneriyorum", "katılıyorum": those are answers).
  '(?:bak|kontrol ed|incel|hazırl|çalış|başl|den|ar|ok|bul|yaz|test ed|düzelt|kur|derl|topl|devam ed|bekl|ölç|tara|sorgul|getir|çıkar)(?:ıyorum|iyorum|uyorum|üyorum)$',
  // bitince yazacağım, sonra PDF'i hazırlayacağım
  '(?:yaz|bak|dön|haber ver|bildir|söyle|hazırla|kontrol ed|incele|getir|çıkar|bul)(?:y?acağım|y?eceğim)$|(?:yazarım|bakarım|dönerim|haber veririm|bildiririm)$',
  '\\b(?:hâlâ|hala|halen)\\s+(?:sürüyor|çalışıyor|devam ediyor|bekliyor)\\b',
  '^(?:bir (?:saniye|dakika)|şimdi bakıyorum|tamam,? bakıyorum)\\b',
  "^(?:let me|i'll|i will|i'm (?:checking|looking|on it)|checking|looking|working on it|still (?:running|working))\\b",
].join('|'), 'iu');

/** The reply-mark line a text opens with, or ''. */
function openingMark(md: string): string {
  const first = splitReplySections(md)[0];
  return first?.refs.length && !/^\s*$/.test(md.split('\n')[0] ?? '') && /^[ \t]*<!--\s*re:/.test(md) ? `<!-- re:${first.refs.join(' ')} -->` : '';
}

/**
 * The turn's text so far and the next one, as ONE text: an earlier line that was only chatter goes
 * (its reply mark kept when the next text has none, so the answer still finds his message), but only
 * when a tool call came after it (`betweenCalls`): two short answers in a row both stay; one
 * with substance stays and the next follows it.
 */
export function mergeHeld(prev: string, next: string, betweenCalls: boolean): string {
  if (!prev.trim()) return next;
  if (betweenCalls && isChatter(prev)) {
    const mark = openingMark(prev);
    return mark && !openingMark(next) ? `${mark}\n${next}` : next;
  }
  return `${prev.trimEnd()}\n\n${next.trimStart()}`;
}

// ─── Errors ─────────────────────────────────────────────────────────────────

/** A model or network failure the CLI wrote as the turn's text (never words for him): the CLI
 *  writes it as the WHOLE text, so only a text that OPENS with it counts. Super prose that quotes
 *  an error ("Stripe webhook'u API Error: 429 döndü") is an answer and goes (review r1). */
export function isApiErrorText(md: string): boolean {
  const t = md.trim();
  return /^(?:API Error:\s*\d{3}\b|Failed to authenticate\b|Request timed out\b|Connection error\b|overloaded_error\b)/i.test(t)
    || (/^(?:<!DOCTYPE html|<html)/i.test(t) && /Attention Required!\s*\|\s*Cloudflare/i.test(t));
}

/**
 * D12 (plan iyilesme-360): the CLI's usage-limit text as the WHOLE text ("You've hit your 5-hour
 * limit · resets 12am (Europe/Istanbul)"), anchored so a Super report quoting it inside other
 * words is an answer and goes as written. Returns its reset as written ('' when it names none),
 * or null when the text is not that form.
 */
const LIMIT_RE = /^(?:Claude AI usage limit reached|You(?:'|’)ve hit your (?:[\w-]+ )*limit|You've reached your usage limit)\b[^\n]*?(?:[·•|,.-]\s*resets?\s+(?:at\s+)?([^\n(]+?))?\s*(?:\(([^)\n]+)\))?\s*[.!]?\s*$/i;
export function limitTextReset(md: string): { reset: string; zone: string } | null {
  const t = md.trim();
  if (!t || t.includes('\n')) return null;
  const m = LIMIT_RE.exec(t);
  return m ? { reset: (m[1] ?? '').trim(), zone: (m[2] ?? '').trim() } : null;
}

/** "12am", "3:30pm", "15:00" → "HH:MM", or null for a form it does not know. */
export function resetClock(reset: string): string | null {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(reset.trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = m[3]?.toLowerCase();
  if (min > 59 || (ap ? h < 1 || h > 12 : h > 23)) return null;
  if (ap === 'am') h = h === 12 ? 0 : h;
  if (ap === 'pm') h = h === 12 ? 12 : h + 12;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** The next time "HH:MM" comes round on this machine's clock (the bot's zone), as epoch ms: the
 *  once-per key of a reset, so tomorrow's "12am" is a new reset and today's repeat is not. */
export function nextOccurrence(clock: string, now: number): number {
  const [h, m] = clock.split(':').map(Number);
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** The Turkish line that replaces it: when it opens, and "it goes on by itself" only when armed. */
export function limitLine(clock: string | null, resumes: boolean): string {
  return `Kullanım sınırına geldik; iş durdu.${clock ? ` Sınır saat ${clock}'de açılıyor.` : ''}${resumes ? ' Açılınca kaldığı yerden sürüyor.' : ''}`;
}

/** Held text that is only a line before a tool call: what must not reach him when something else
 *  is sent first (a job status, a card, a picture; review r1). Its reply mark is kept, so the
 *  answer that follows still answers his message. Null = the text has substance and goes. */
export function chatterRemains(md: string): string | null {
  return isChatter(md) ? openingMark(md) : null;
}

/** Nothing in it but reply marks. */
export function isOnlyMarks(md: string): boolean {
  return splitReplySections(md).every((s) => !s.text.trim());
}

// ─── Job status blocks ──────────────────────────────────────────────────────

export interface StatusBlock { id: string; done: boolean; lines: string[] }

const STATUS_FENCE = /^([ \t]*)(```|~~~)[ \t]*dream-status[ \t]+([^\n]*)\n([\s\S]*?)^\1\2[ \t]*$\n?/gm;

/** The `dream-status` blocks of a text and the text without them. The id is the first word of
 *  the info string (letters, digits, `-_.`, at most 64); `done` after it ends the job. */
export function statusBlocks(md: string): { rest: string; blocks: StatusBlock[] } {
  const blocks: StatusBlock[] = [];
  const rest = md.replace(STATUS_FENCE, (all, _i: string, _f: string, info: string, body: string) => {
    const [rawId, ...flags] = info.trim().split(/\s+/);
    const id = (rawId ?? '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64);
    if (!id) return all;
    const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
    blocks.push({ id, done: flags.some((f) => /^(?:done|bitti)$/i.test(f)), lines });
    return '';
  });
  return { rest: blocks.length ? rest.replace(/\n{3,}/g, '\n\n').trim() : md, blocks };
}

// ─── The agenda pin ─────────────────────────────────────────────────────────

function clipLine(text: string, max: number): string {
  const one = redactSecrets(text).replace(/\s+/g, ' ').trim();
  const cps = Array.from(one);
  return cps.length > max ? `${cps.slice(0, max - 1).join('').trimEnd()}…` : one;
}

/**
 * The pinned agenda (owner 2026-11-21 17:31: "şu anki gündemi, neler yapıldığını yazsak;
 * yapılacaklar listesi değil"): one line per agenda line, what runs now, what waits on him, what
 * finished in the last 12 hours. Null when the agenda holds nothing at all (no pin is made for an
 * empty one; one already pinned says so instead).
 */
export function agendaPinHtml(pad: readonly SuperPadItem[] | undefined, nowMs: number): string | null {
  const items = (pad ?? []).filter((p) => p.text.trim());
  const now = items.filter((p) => p.section === 'now');
  const waiting = items.filter((p) => p.section === 'waiting');
  const done = items.filter((p) => p.section === 'done' && nowMs - (p.at ?? 0) <= PIN_DONE_MS).sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  if (!now.length && !waiting.length && !done.length) return null;
  const head = '📌 <b>Gündem</b>';
  const rows = (list: readonly SuperPadItem[], glyph: string): string[] => list.map((p) => `${glyph} ${escapeHtml(clipLine(p.text, 80))}`);
  const body = [...rows(now, '⏳'), ...rows(waiting, '✋')];
  let finished = rows(done, '✓');
  const size = (): number => Array.from(telegramHtmlToPlain([head, ...body, ...finished].join('\n'))).length;
  // The newest finished lines stay when it grows long: the pin is what is going on now.
  while (finished.length && size() > PIN_MAX) finished = finished.slice(0, -1);
  if (!body.length && !finished.length) return `${head}\n<i>Şu an süren iş yok.</i>`;
  return [head, ...(body.length ? body : ['<i>Şu an süren iş yok.</i>']), ...finished].join('\n');
}

// ─── The night ──────────────────────────────────────────────────────────────

export function isNight(ms: number): boolean {
  const h = new Date(ms).getHours();
  return NIGHT_START_HOUR <= NIGHT_END_HOUR ? h >= NIGHT_START_HOUR && h < NIGHT_END_HOUR : h >= NIGHT_START_HOUR || h < NIGHT_END_HOUR;
}

/** The morning message: what finished in the night, one answer each, in the order they came. */
export function nightDigestMarkdown(items: readonly { md: string }[]): string {
  const parts = items.map((i) => splitReplySections(i.md).map((s) => s.text).filter(Boolean).join('\n\n').trim()).filter(Boolean);
  const head = parts.length === 1 ? '**Gece biten bir iş var.**' : `**Gece ${parts.length} iş bitti.**`;
  return [head, ...parts].join('\n\n');
}

// ─── The voice day ──────────────────────────────────────────────────────────

const TEXT_ASK_RE = /\b(?:yazıyla|yazılı(?:\s+(?:yaz|cevap|gönder))?|sesli(?:yi)?\s+(?:kapat|bırak|yeter|dur)|sesi\s+kapat|ses(?:\s+mesajı)?\s+(?:istemiyorum|gönderme)|by\s+text|in\s+writing|stop\s+(?:the\s+)?voice)\b/iu;

/** His message asks to go back to text: the voice day ends. */
export function asksForText(text: string): boolean {
  return !!text && TEXT_ASK_RE.test(text.normalize('NFC').replace(/İ/g, 'i'));
}

/** The local day a time falls on (`YYYY-MM-DD`). */
export function dayOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * An answer of a voice day written with no `dream-voice` block: spoken from its own words (code,
 * links, paths and quotes' markup out), its bold first line the title; null when it has a block
 * already or nothing to say. The text that goes beside it is that one line.
 */
export function voiceFromText(md: string): { voice: VoiceBlock; line: string } | null {
  if (voiceAnswer(md).voice) return null;
  const plain = telegramHtmlToPlain(markdownToTelegramHtml(md.replace(/^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm, ''), { blocks: 'hub' }))
    .replace(/`[^`]*`/g, '').replace(/https?:\/\/\S+/g, '').replace(/(?:^|\s)[\w.-]*\/[\w./-]+/g, ' ')
    .replace(/^[ \t]*[•◦▪]\s*/gm, '').replace(/[ \t]+/g, ' ').trim();
  if (!plain) return null;
  const first = plain.split('\n').find((l) => l.trim())?.trim() ?? '';
  const text = Array.from(plain).slice(0, 2500).join('');
  return { voice: { title: Array.from(first).slice(0, 60).join(''), text }, line: first };
}

/** The pictures and linked files (PDFs) of a text, as their own lines after a blank one (a voice
 *  day's one line keeps them: the hub sends each after the text, never a silent drop), or ''. */
export function picturesOnly(md: string): string {
  const pics = markdownImages(md).filter((i) => !i.web).map((i) => `![${i.alt.replace(/[[\]]/g, '')}](<${i.src}>)`);
  const files = markdownFileLinks(md).map((f) => `[${f.alt.replace(/[[\]]/g, '')}](<${f.src}>)`);
  const all = [...pics, ...files];
  return all.length ? `\n\n${all.join('\n')}` : '';
}
