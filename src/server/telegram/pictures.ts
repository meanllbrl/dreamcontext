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
  return `${Array.from(safe.slice(0, 990).replace(/&[a-z#0-9]*$/i, '')).join('')}…`;
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

/** 2-10 photos/videos as one album, in order, the caption on the first item. */
export async function sendAlbum(ab: ActiveBinding, items: MediaItem[], captionHtml?: string): Promise<boolean> {
  const list = items.filter((i) => i.kind !== 'document').slice(0, 10);
  if (list.length < 2) return false;
  const files: Record<string, UploadFile> = {};
  const media = list.map((it, i) => {
    files[`f${i}`] = it.file;
    return { type: it.kind, media: `attach://f${i}`, ...(i === 0 && captionHtml ? { caption: captionHtml, parse_mode: 'HTML' } : {}) };
  });
  const r = await ab.transport.upload('sendMediaGroup', { chat_id: ab.binding.chatId, media }, files).catch(() => null);
  return !!r;
}

/** A file name for a picture slice. */
export function pngFile(name: string, data: Buffer): UploadFile {
  return { name: `${name.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 40) || 'kart'}.png`, data, contentType: 'image/png' };
}
