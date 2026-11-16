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
import { isLayoutRender } from '../../lib/whiteboards/render-mark.js';
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
  // A photo beyond Telegram's dimensions goes as a document, so the document limit is its limit.
  return item.file.data.length <= (item.kind === 'photo' && !overPhotoDimensions(item) ? PHOTO_MAX_BYTES : REQUEST_MAX_BYTES);
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

/**
 * The name a picture from a file goes under. A `whiteboard render` layout check (its kind is in
 * its own bytes) is named a draft: its pictures are empty boxes, and the owner must not take it
 * for the board (owner, 2026-11-17). It still goes: a guard explains, never hides.
 */
export function pictureTitle(data: Buffer, name: string): string {
  return isLayoutRender(data) ? `Yerleşim taslağı, panonun görüntüsü değil · ${name}` : name;
}

/** One picture's name on one line, at most 200 characters (a caption is never cut mid-line). */
function pictureName(title: string): string {
  // Redacted whole BEFORE the cut: a secret cut short would slip under its pattern's length.
  const one = redactSecrets(title).replace(/\s+/g, ' ').trim();
  const cps = Array.from(one);
  return cps.length > 200 ? `${cps.slice(0, 199).join('').trimEnd()}…` : one;
}

/** A picture's own caption in a group: "3 · <name>" (the number the list below uses). */
export function numberedCaption(n: number, title: string): string {
  return caption(`${n} · ${pictureName(title)}`);
}

/**
 * THE way pictures leave (one place for every caller: presentations, dream-html, previews):
 * items Telegram would refuse are left out first, then one photo/clip or one album of 2-10
 * within the request fence. Returns the items that did NOT go, so the caller sends their text
 * lines (a refused send leaves every item unsent, never silence).
 *
 * With `named` (pictures that each have a name): every picture carries "N · name" as its own
 * caption (owner 2026-11-10: one run-on caption line under a cropped collage could not be read).
 * No separate listing message follows (owner 2026-11-13: "Sahnede 2 resim: 1. Önce 2. Sonra" was noise). A picture taller than 1:2 goes as its own
 * photo after the album, so it is seen whole; one beyond Telegram's photo dimensions as a document.
 * Without `named` (slices of one card): no captions, as before.
 */
export async function sendPictures(ab: ActiveBinding, items: MediaItem[], named?: boolean, numberFrom = 0): Promise<{ sent: MediaItem[]; unsent: MediaItem[] }> {
  const fit: MediaItem[] = [];
  const unsent: MediaItem[] = [];
  let total = 0;
  for (const it of items) {
    if (it.kind === 'document' || !fitsTelegram(it) || fit.length >= 10 || total + it.file.data.length > REQUEST_MAX_BYTES) { unsent.push(it); continue; }
    fit.push(it);
    total += it.file.data.length;
  }
  if (!fit.length) return { sent: [], unsent };
  if (!named) {
    // Slices of one card: each tile says which part it is ("Kart · 2/3"), never one shared line.
    const part = (m: MediaItem): string => { const t = pictureName(m.title); return t ? caption(`${t} · ${fit.indexOf(m) + 1}/${fit.length}`) : ''; };
    const ok = fit.length === 1 ? !!(await sendMedia(ab, fit[0])) : await sendAlbum(ab, fit, part);
    return ok ? { sent: fit, unsent } : { sent: [], unsent: [...fit, ...unsent] };
  }
  if (fit.length === 1) {
    const one = fit[0];
    // One of a longer run (a later album of the same message) keeps its number.
    const cap = numberFrom > 0 ? numberedCaption(numberFrom + 1, one.title) : caption(pictureName(one.title));
    const ok = !!(await sendMedia(ab, overPhotoDimensions(one) ? { ...one, kind: 'document' } : one, cap));
    return ok ? { sent: fit, unsent } : { sent: [], unsent: [...fit, ...unsent] };
  }
  // Numbers follow the order he sees: the album first (grid order = sent order), then each
  // tall picture on its own.
  // A picture an album tile would crop (taller than 1:2) or Telegram would refuse as a photo
  // (beyond its dimensions: it would sink the whole album) goes on its own.
  const apart = (m: MediaItem): boolean => isTall(m) || overPhotoDimensions(m);
  const grid = fit.filter((m) => !apart(m));
  const alone = fit.filter(apart);
  const order = [...grid, ...alone];
  const num = new Map(order.map((m, i) => [m, numberFrom + i + 1]));
  const sent = new Set<MediaItem>();
  if (grid.length >= 2) {
    if (await sendAlbum(ab, grid, (m) => numberedCaption(num.get(m)!, m.title))) for (const m of grid) sent.add(m);
  } else if (grid.length === 1 && await sendMedia(ab, grid[0], numberedCaption(num.get(grid[0])!, grid[0].title))) sent.add(grid[0]);
  for (const m of alone) {
    const asSent = overPhotoDimensions(m) ? { ...m, kind: 'document' as const } : m;
    if (await sendMedia(ab, asSent, numberedCaption(num.get(m)!, m.title))) sent.add(m);
  }
  return { sent: fit.filter((m) => sent.has(m)), unsent: [...fit.filter((m) => !sent.has(m)), ...unsent] };
}

/** Taller than 1:3: Telegram shrinks a photo to 2560 px on its long side, so the text of a
 *  drawing this tall goes thin; a document keeps every pixel (one tap opens it whole). */
export const WHOLE_PHOTO_MAX_RATIO = 3;

/**
 * ONE picture as its own message, seen whole on a phone (a question option's drawing): a photo
 * keeps its real shape in the chat (never an album tile's square crop), with its own caption; a
 * picture taller than 1:3 or beyond Telegram's photo dimensions goes as a document instead.
 */
export async function sendWhole(ab: ActiveBinding, item: MediaItem, captionHtml: string): Promise<boolean> {
  const s = item.kind === 'photo' ? imageSize(item.file.data) : null;
  const tall = !!s && s.h / s.w > WHOLE_PHOTO_MAX_RATIO;
  const asSent = item.kind === 'photo' && (tall || overPhotoDimensions(item)) ? { ...item, kind: 'document' as const } : item;
  return !!(await sendMedia(ab, asSent, captionHtml));
}

const METHOD: Record<MediaKind, string> = { photo: 'sendPhoto', video: 'sendVideo', document: 'sendDocument' };

/** How long one upload may wait in all for Telegram's "too many requests" before it gives up. */
export const UPLOAD_WAIT_MAX_MS = 90_000;
/** The wait itself (a test makes it instant). */
export const uploadTiming = { wait: (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)) };

/**
 * One upload, waiting out Telegram's flood limit: a 429 carries `retry_after`, and the same
 * upload goes again after it, while the waits stay within {@link UPLOAD_WAIT_MAX_MS}. Many albums
 * in one answer (a board exported section by section) reach the chat instead of failing from
 * the first refusal on. Any other failure is null at once, as before.
 */
async function uploadPatiently<T>(ab: ActiveBinding, method: string, params: Record<string, unknown>, files: Record<string, UploadFile>): Promise<T | null> {
  let waited = 0;
  for (;;) {
    try {
      return await ab.transport.upload<T>(method, params, files);
    } catch (err) {
      const after = (err as { retryAfter?: unknown }).retryAfter;
      const ms = typeof after === 'number' && Number.isFinite(after) && after > 0 ? Math.ceil(after * 1000) : 0;
      if (!ms || waited + ms > UPLOAD_WAIT_MAX_MS) return null;
      waited += ms;
      await uploadTiming.wait(ms);
    }
  }
}

/** One media message; `buttons` as an inline keyboard (callback or url buttons). */
export async function sendMedia(ab: ActiveBinding, item: MediaItem, captionHtml?: string, keyboard?: unknown[][]): Promise<{ message_id: number } | null> {
  const params: Record<string, unknown> = { chat_id: ab.binding.chatId, parse_mode: 'HTML' };
  if (captionHtml) params.caption = captionHtml;
  if (keyboard?.length) params.reply_markup = { inline_keyboard: keyboard };
  const r = await uploadPatiently<{ message_id?: number }>(ab, METHOD[item.kind], params, { [item.kind]: item.file });
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
  const r = await uploadPatiently(ab, 'sendMediaGroup', { chat_id: ab.binding.chatId, media }, files);
  return !!r;
}

/** A file name for a picture slice. */
export function pngFile(name: string, data: Buffer): UploadFile {
  return { name: `${name.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 40) || 'kart'}.png`, data, contentType: 'image/png' };
}
