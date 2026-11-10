/**
 * Pictures and media to a bound Telegram chat (plan L2, S1, T2, T5, N2).
 *
 *  - `snapshotPage`: a server-built sealed page → PNG slices, rendered by the shell's sealed
 *    `html_snapshot` webview through the Super window (`hub_command html_snapshot`). No window,
 *    no shell, a refusal or a blank page → null, and the caller sends text.
 *  - `sendMedia`: one photo / video / document with an HTML caption and optional buttons.
 *  - `sendAlbum`: 2-10 photos/videos as ONE `sendMediaGroup`, stage order kept, the caption on
 *    the first item (Telegram puts no buttons on an album: the caller sends them after).
 * Every caption is escaped and redacted (the transport redacts again as the last fence).
 */
import { RENDER_MAX_SLICES } from '../../lib/telegram/contract.js';
import { escapeHtml, redactSecrets } from '../../lib/telegram/format.js';
import { sendHubCommand, superTokenOfSession, tokenOfSession } from '../../lib/window-control.js';
import type { UploadFile } from '../../lib/telegram/transport.js';
import type { ActiveBinding } from './hub.js';

export type MediaKind = 'photo' | 'video' | 'document';
export interface MediaItem { kind: MediaKind; file: UploadFile; title: string }

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type Snapshotter = (sessionId: string, page: string, width: number) => Promise<Buffer[] | null>;

/** The shell's sealed renderer, reached through the Super chat's own window socket. */
export const snapshotPage: Snapshotter = async (sessionId, page, width) => {
  const token = superTokenOfSession(sessionId) ?? tokenOfSession(sessionId);
  if (!token) return null;
  const r = await sendHubCommand(token, 'html_snapshot', { html: page, width }, { timeoutMs: 20_000 }).catch(() => null);
  if (!r || !r.ok) return null;
  const raw = (r as unknown as { pngs?: unknown }).pngs;
  const pngs = Array.isArray(raw) ? raw : [];
  const out: Buffer[] = [];
  for (const b of pngs.slice(0, RENDER_MAX_SLICES)) {
    if (typeof b !== 'string') return null;
    const buf = Buffer.from(b, 'base64');
    if (buf.length < 64 || !buf.subarray(0, 8).equals(PNG_MAGIC)) return null;
    out.push(buf);
  }
  return out.length ? out : null;
};

/** A caption: escaped, redacted, ≤1024 UTF-16 units cut on a code point. */
export function caption(text: string): string {
  const safe = escapeHtml(redactSecrets(text));
  if (safe.length <= 1000) return safe;
  // Cut on code points first (never half a surrogate pair), then never inside an entity.
  let out = '';
  for (const cp of Array.from(safe)) { if (out.length + cp.length > 990) break; out += cp; }
  return `${out.replace(/&[a-z#0-9]*$/i, '')}…`;
}

/** Telegram's limits: a photo ≤10 MB, one request ≤50 MB (the transport's upload fence). */
export const PHOTO_MAX_BYTES = 10 * 1024 * 1024;
export const REQUEST_MAX_BYTES = 50 * 1024 * 1024;

/** Can Telegram take this item in its form? (A larger photo fails `sendPhoto`.) */
export function fitsTelegram(item: MediaItem): boolean {
  return item.file.data.length <= (item.kind === 'photo' ? PHOTO_MAX_BYTES : REQUEST_MAX_BYTES);
}

/** A picture's width and height from its PNG or JPEG header (null: unknown, treated as ordinary). */
export function imageSize(data: Buffer): { w: number; h: number } | null {
  if (data.length >= 24 && data.subarray(0, 8).equals(PNG_MAGIC)) {
    if (data.toString('latin1', 12, 16) !== 'IHDR') return null;
    const w = data.readUInt32BE(16);
    const h = data.readUInt32BE(20);
    return w > 0 && h > 0 && w <= 100_000 && h <= 100_000 ? { w, h } : null;
  }
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < data.length) {
    if (data[i] !== 0xff) { i++; continue; }
    const marker = data[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: data.readUInt16BE(i + 5), w: data.readUInt16BE(i + 7) };
    }
    i += 2 + data.readUInt16BE(i + 2);
  }
  return null;
}

/** Taller than 1:2: an album tile crops it to an unreadable strip, so it goes as its own photo. */
export const TALL_RATIO = 2;
export function isTall(item: MediaItem): boolean {
  if (item.kind !== 'photo') return false;
  const s = imageSize(item.file.data);
  return !!s && s.w > 0 && s.h / s.w > TALL_RATIO;
}
/** Over Telegram's photo dimensions (w+h ≤ 10000, ratio ≤ 20): only a document keeps it whole. */
export function overPhotoDimensions(item: MediaItem): boolean {
  if (item.kind !== 'photo') return false;
  const s = imageSize(item.file.data);
  return !!s && s.w > 0 && s.h > 0 && (s.w + s.h > 10_000 || Math.max(s.w / s.h, s.h / s.w) > 20);
}

/** One picture's name on one line, at most 200 characters (a caption is never cut mid-line). */
function pictureName(title: string): string {
  const one = title.replace(/\s+/g, ' ').trim();
  const cps = Array.from(one);
  return cps.length > 200 ? `${cps.slice(0, 199).join('').trimEnd()}…` : one;
}

/** A picture's own caption in a group: "3 · <name>" (the number the list below uses). */
export function numberedCaption(n: number, title: string): string {
  return caption(`${n} · ${pictureName(title)}`);
}

/**
 * The text under a group of pictures: a heading, then one numbered line per picture in the order
 * they were sent, then the footer lines. Never a run-on line; split into messages of whole lines.
 */
export function pictureListMessages(heading: string, rows: ReadonlyArray<{ n: number; title: string }>, footer: readonly string[] = [], max = 4000): string[] {
  const lines = [
    `<b>${escapeHtml(redactSecrets(heading))}</b>`,
    ...rows.map((r) => `${r.n}. ${escapeHtml(redactSecrets(pictureName(r.title)))}`),
    ...footer.map((f) => escapeHtml(redactSecrets(f))),
  ];
  const out: string[] = [];
  let cur = '';
  for (const l of lines) {
    if (cur && cur.length + 1 + l.length > max) { out.push(cur); cur = ''; }
    cur = cur ? `${cur}\n${l}` : l;
  }
  if (cur) out.push(cur);
  return out;
}

export interface PictureNames {
  /** The list's heading for `n` pictures sent, e.g. `Sahnede 6 resim:`. */
  heading: (n: number) => string;
  /** Lines under the list (e.g. "Ve 2 kart daha."). */
  footer?: string[];
}

/**
 * THE way pictures leave (one place for every caller: presentations, dream-html, previews):
 * items Telegram would refuse are left out first, then one photo/clip or one album of 2-10
 * within the request fence. Returns the items that did NOT go, so the caller sends their text
 * lines (a refused send leaves every item unsent, never silence).
 *
 * With `names` (pictures that each have a name): every picture carries "N · name" as its own
 * caption, and a numbered list follows in the same order (owner 2026-11-10: one run-on caption
 * line under a cropped collage could not be read). A picture taller than 1:2 goes as its own
 * photo after the album, so it is seen whole; one beyond Telegram's photo dimensions as a document.
 * Without `names` (slices of one card): no captions, as before.
 */
export async function sendPictures(ab: ActiveBinding, items: MediaItem[], names?: PictureNames): Promise<{ sent: MediaItem[]; unsent: MediaItem[] }> {
  const fit: MediaItem[] = [];
  const unsent: MediaItem[] = [];
  let total = 0;
  for (const it of items) {
    if (it.kind === 'document' || !fitsTelegram(it) || fit.length >= 10 || total + it.file.data.length > REQUEST_MAX_BYTES) { unsent.push(it); continue; }
    fit.push(it);
    total += it.file.data.length;
  }
  if (!fit.length) return { sent: [], unsent };
  if (!names) {
    const ok = fit.length === 1 ? !!(await sendMedia(ab, fit[0])) : await sendAlbum(ab, fit);
    return ok ? { sent: fit, unsent } : { sent: [], unsent: [...fit, ...unsent] };
  }
  if (fit.length === 1) {
    const one = fit[0];
    const ok = !!(await sendMedia(ab, overPhotoDimensions(one) ? { ...one, kind: 'document' } : one, caption(pictureName(one.title))));
    return ok ? { sent: fit, unsent } : { sent: [], unsent: [...fit, ...unsent] };
  }
  // Numbers follow the order he sees: the album first (grid order = sent order), then each
  // tall picture on its own.
  const grid = fit.filter((m) => !isTall(m));
  const alone = fit.filter((m) => isTall(m));
  const order = [...grid, ...alone];
  const num = new Map(order.map((m, i) => [m, i + 1]));
  const sent = new Set<MediaItem>();
  if (grid.length >= 2) {
    if (await sendAlbum(ab, grid, (m) => numberedCaption(num.get(m)!, m.title))) for (const m of grid) sent.add(m);
  } else if (grid.length === 1 && await sendMedia(ab, grid[0], numberedCaption(1, grid[0].title))) sent.add(grid[0]);
  for (const m of alone) {
    const asSent = overPhotoDimensions(m) ? { ...m, kind: 'document' as const } : m;
    if (await sendMedia(ab, asSent, numberedCaption(num.get(m)!, m.title))) sent.add(m);
  }
  const went = order.filter((m) => sent.has(m));
  if (went.length) {
    for (const html of pictureListMessages(names.heading(went.length), went.map((m) => ({ n: num.get(m)!, title: m.title })), names.footer)) {
      await ab.transport.sendMessage(ab.binding.chatId, html).catch(() => {});
    }
  }
  return { sent: fit.filter((m) => sent.has(m)), unsent: [...fit.filter((m) => !sent.has(m)), ...unsent] };
}

const METHOD: Record<MediaKind, string> = { photo: 'sendPhoto', video: 'sendVideo', document: 'sendDocument' };

/** One media message; `buttons` as an inline keyboard (callback or url buttons). */
export async function sendMedia(ab: ActiveBinding, item: MediaItem, captionHtml?: string, keyboard?: unknown[][]): Promise<{ message_id: number } | null> {
  const params: Record<string, unknown> = { chat_id: ab.binding.chatId, parse_mode: 'HTML' };
  if (captionHtml) params.caption = captionHtml;
  if (keyboard?.length) params.reply_markup = { inline_keyboard: keyboard };
  const r = await ab.transport.upload<{ message_id?: number }>(METHOD[item.kind], params, { [item.kind]: item.file }).catch(() => null);
  return r && typeof r === 'object' && Number.isSafeInteger(r.message_id) ? { message_id: r.message_id! } : r ? { message_id: 0 } : null;
}

/** 2-10 photos/videos as one album, in order; `captionOf` gives each item its own caption. */
export async function sendAlbum(ab: ActiveBinding, items: MediaItem[], captionOf?: (item: MediaItem) => string): Promise<boolean> {
  const list = items.filter((i) => i.kind !== 'document').slice(0, 10);
  if (list.length < 2) return false;
  const files: Record<string, UploadFile> = {};
  const media = list.map((it, i) => {
    files[`f${i}`] = it.file;
    const cap = captionOf?.(it);
    return { type: it.kind, media: `attach://f${i}`, ...(cap ? { caption: cap, parse_mode: 'HTML' } : {}) };
  });
  const r = await ab.transport.upload('sendMediaGroup', { chat_id: ab.binding.chatId, media }, files).catch(() => null);
  return !!r;
}

/** A file name for a picture slice. */
export function pngFile(name: string, data: Buffer): UploadFile {
  return { name: `${name.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 40) || 'kart'}.png`, data, contentType: 'image/png' };
}
