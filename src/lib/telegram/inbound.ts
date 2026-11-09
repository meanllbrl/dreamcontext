/**
 * What arrives from Telegram becomes a turn's text and files (plan "Media", A6, N4).
 *
 * - Media (photo: the largest size, video, document, voice, audio, video note, animation):
 *   `getFile` → refused past 20 MB (what a bot may download) with a clear line → written into
 *   the project's `_dream_context/tmp/agent-drops/` with a generated name, `wx`, the tmp folder
 *   self-ignored, a 200 MB total cap on Telegram drops. The path joins the turn like a desktop drop.
 * - Captions, file names, forwarded, quoted and replied-to content are DATA: JSON-quoted with a
 *   label ("İletilen mesaj: …"), never the owner's instruction.
 * - Header neutralisation: a Telegram-origin text can never forge a hub header
 *   (`[About agenda line `, `[About card `, `[Reply to message ref=`): a zero-width space is put
 *   in front, exactly as the composer does (N4). Only hub-built headers are real.
 * - Every private-use sentinel is removed (E4): only the injector writes the ref prefix.
 */
import { randomBytes } from 'node:crypto';
import { closeSync, constants, lstatSync, mkdirSync, openSync, readdirSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { agentDropsDir, ensureTmpGitignored, pruneDrops } from '../agent-drops.js';
import { TG_DOWNLOAD_MAX_BYTES, stripSentinels } from './contract.js';
import { TelegramError, type TelegramTransport } from './transport.js';

export const TELEGRAM_DROP_PREFIX = 'tg-';
export const TELEGRAM_DROPS_TOTAL_CAP = 200 * 1024 * 1024;
export const TOO_LARGE_LINE = "Bu dosya 20 MB'tan büyük, Telegram botlara bundan fazlasını indirtmiyor; Mac'ten gönder ya da küçült.";
export const TIMEOUT_LINE = "Telegram'dan indirme zaman aşımına uğradı; bir kez daha denedim, yine olmadı. Biraz sonra tekrar gönder.";
export const NO_FILE_LINE = 'Telegram bu dosyayı vermedi. Tekrar göndermeyi dene.';
const failedLine = (code: number): string => `Dosyayı Telegram'dan indiremedim (kod ${code}). Tekrar gönder.`;

export type InboundKind = 'photo' | 'video' | 'document' | 'voice' | 'audio' | 'video_note' | 'animation';

export interface InboundMedia {
  kind: InboundKind;
  fileId: string;
  fileSize?: number;
  /** The sender's file name: data only, never used as a path. */
  fileName?: string;
  mime?: string;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' ? (v as Obj) : null);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** The one file a message carries, or null. A photo is its largest size. */
export function pickInboundMedia(message: Obj): InboundMedia | null {
  const photos = Array.isArray(message.photo) ? (message.photo as unknown[]).map(obj).filter((p): p is Obj => !!p && typeof p.file_id === 'string') : [];
  if (photos.length) {
    const best = photos.reduce((a, b) => ((num(b.file_size) ?? (num(b.width) ?? 0) * (num(b.height) ?? 0)) > (num(a.file_size) ?? (num(a.width) ?? 0) * (num(a.height) ?? 0)) ? b : a));
    return { kind: 'photo', fileId: best.file_id as string, fileSize: num(best.file_size), mime: 'image/jpeg' };
  }
  for (const kind of ['video', 'voice', 'audio', 'video_note', 'animation', 'document'] as const) {
    const m = obj(message[kind]);
    if (m && typeof m.file_id === 'string') {
      return { kind, fileId: m.file_id, fileSize: num(m.file_size), fileName: str(m.file_name), mime: str(m.mime_type) };
    }
  }
  return null;
}

const EXT_BY_KIND: Record<InboundKind, string> = {
  photo: '.jpg', video: '.mp4', voice: '.ogg', audio: '.mp3', video_note: '.mp4', animation: '.mp4', document: '',
};

/** A generated drop name: never the sender's. The extension comes from the kind, or from the
 *  sender's name only when it is a short plain extension. */
export function dropNameFor(media: InboundMedia, now: number = Date.now()): string {
  let ext = EXT_BY_KIND[media.kind];
  if (!ext && media.fileName) {
    const m = /\.([A-Za-z0-9]{1,8})$/.exec(media.fileName);
    if (m) ext = `.${m[1].toLowerCase()}`;
  }
  return `${TELEGRAM_DROP_PREFIX}${now}-${randomBytes(4).toString('hex')}${ext || '.bin'}`;
}

function telegramDropBytes(dir: string): number {
  let total = 0;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(TELEGRAM_DROP_PREFIX)) continue;
      try {
        const st = lstatSync(join(dir, name));
        if (st.isFile()) total += st.size;
      } catch { /* gone */ }
    }
  } catch { /* no dir */ }
  return total;
}

export type SaveResult =
  | { ok: true; path: string; media: InboundMedia }
  | { ok: false; reason: 'too_large' | 'cap' | 'timeout' | 'no_file' | 'download_failed' | 'write_failed'; line: string };

export type FailKind = 'too_large' | 'timeout' | 'no_file' | 'download_failed';

/** What a getFile/download error means. The messages TelegramError carries are already token-free. */
export function classifyDownloadError(err: unknown): { kind: FailKind; code: number; transient: boolean } {
  if (!(err instanceof TelegramError)) return { kind: 'download_failed', code: 0, transient: true };
  const { code, message } = err;
  if (code === 413 || /too big|too large/i.test(message)) return { kind: 'too_large', code, transient: false };
  if (code === 0 && /timed out|abort|timeout/i.test(message)) return { kind: 'timeout', code, transient: true };
  if (/no file path/i.test(message)) return { kind: 'no_file', code, transient: false };
  return { kind: 'download_failed', code, transient: code === 0 || code === 429 || code >= 500 };
}

/** One log line per failure: kind, step, code and the (token-free) message. Never a URL. */
function logFailure(media: InboundMedia, step: string, attempt: number, c: { kind: FailKind; code: number }, err: unknown): void {
  const msg = (err instanceof Error ? err.message : String(err)).replace(/https?:\/\/\S+/g, '<url>').replace(/\d{6,}:[A-Za-z0-9_-]{20,}/g, '<token>').slice(0, 200);
  process.stderr.write(`[telegram] inbound ${media.kind} failed (${c.kind}, ${step}, attempt ${attempt}, code ${c.code}): ${msg}\n`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Downloads one inbound file into the drop folder. */
export async function saveInbound(
  input: { transport: Pick<TelegramTransport, 'getFile' | 'download'>; contextRoot: string; media: InboundMedia; now?: number; retryDelayMs?: number; log?: typeof logFailure },
): Promise<SaveResult> {
  const { transport, contextRoot, media } = input;
  if ((media.fileSize ?? 0) > TG_DOWNLOAD_MAX_BYTES) return { ok: false, reason: 'too_large', line: TOO_LARGE_LINE };
  const log = input.log ?? logFailure;
  let data: Buffer | null = null;
  for (let attempt = 1; attempt <= 2 && !data; attempt++) {
    let step = 'getFile';
    try {
      const file = await transport.getFile(media.fileId);
      if ((file.file_size ?? 0) > TG_DOWNLOAD_MAX_BYTES) return { ok: false, reason: 'too_large', line: TOO_LARGE_LINE };
      step = 'download';
      data = await transport.download(file, TG_DOWNLOAD_MAX_BYTES);
    } catch (err) {
      const c = classifyDownloadError(err);
      log(media, step, attempt, c, err);
      if (c.kind === 'too_large') return { ok: false, reason: 'too_large', line: TOO_LARGE_LINE };
      if (c.transient && attempt === 1) { await sleep(input.retryDelayMs ?? 700); continue; }
      if (c.kind === 'timeout') return { ok: false, reason: 'timeout', line: TIMEOUT_LINE };
      if (c.kind === 'no_file') return { ok: false, reason: 'no_file', line: NO_FILE_LINE };
      return { ok: false, reason: 'download_failed', line: failedLine(c.code) };
    }
  }
  if (!data) return { ok: false, reason: 'download_failed', line: failedLine(0) };
  const dir = agentDropsDir(contextRoot);
  try {
    mkdirSync(dir, { recursive: true });
    if (lstatSync(dir).isSymbolicLink()) throw new Error('drop folder is a link');
    ensureTmpGitignored(contextRoot);
    pruneDrops(dir);
  } catch {
    return { ok: false, reason: 'write_failed', line: "Dosyayı Mac'e yazamadım; tekrar gönder." };
  }
  if (telegramDropBytes(dir) + data.length > TELEGRAM_DROPS_TOTAL_CAP) {
    return { ok: false, reason: 'cap', line: "Mac'teki Telegram dosyaları 200 MB sınırında; eskiler silinince tekrar gönder." };
  }
  const path = join(dir, dropNameFor(media, input.now));
  try {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeSync(fd, data); } finally { closeSync(fd); }
  } catch {
    return { ok: false, reason: 'write_failed', line: "Dosyayı Mac'e yazamadım; tekrar gönder." };
  }
  return { ok: true, path, media };
}

// ─── Turn text ──────────────────────────────────────────────────────────────

/** Hub-only headers a Telegram text must not be able to forge. */
const FORGEABLE_HEADERS = ['[About agenda line ', '[About card ', '[Reply to message ref='];

/** Puts a zero-width space in front of every forgeable header, wherever it sits. */
export function neutraliseHeaders(text: string): string {
  let out = text;
  for (const h of FORGEABLE_HEADERS) out = out.split(h).join(`​${h}`);
  return out;
}

/** Owner text from Telegram, made safe to inject: sentinels out, headers neutralised, a leading
 *  owner-msg block lookalike defused (B1). */
export function cleanOwnerText(text: string): string {
  return neutraliseHeaders(stripSentinels(text)).replace(/^\s*<owner-msg/i, '​<owner-msg');
}

/** Content the owner did not author in this message, as data. */
export function quotedData(label: string, content: string): string {
  return `${label}: ${JSON.stringify(neutraliseHeaders(stripSentinels(content)))}`;
}

function forwardedFrom(origin: Obj | null): string {
  if (!origin) return '';
  const who = obj(origin.sender_user) ?? obj(origin.chat) ?? null;
  const name = str(origin.sender_user_name) ?? str(who?.username) ?? str(who?.title) ?? str(who?.first_name);
  return name ? ` (${name.replace(/[^\p{L}\p{N} @._-]/gu, '').slice(0, 40)})` : '';
}

/**
 * The turn text for one Telegram message: the owner's own words (cleaned), then everything that
 * is not his words as labelled, JSON-quoted data, then the saved file paths (like a desktop drop).
 * A forwarded message is wholly quoted: its text is not his instruction.
 */
export function inboundTurnText(message: Obj, paths: readonly string[] = []): string {
  const parts: string[] = [];
  const text = str(message.text) ?? '';
  const caption = str(message.caption) ?? '';
  const forwarded = obj(message.forward_origin);
  if (forwarded) {
    parts.push(quotedData(`İletilen mesaj${forwardedFrom(forwarded)}`, text || caption));
  } else {
    if (text.trim()) parts.push(cleanOwnerText(text));
    if (caption.trim()) parts.push(quotedData('Dosya açıklaması', caption));
  }
  const quote = obj(message.quote);
  if (quote && typeof quote.text === 'string') parts.push(quotedData('Alıntı', quote.text));
  const reply = obj(message.reply_to_message);
  if (reply && !quote) {
    const rt = str(reply.text) ?? str(reply.caption);
    if (rt) parts.push(quotedData('Yanıtlanan mesaj', rt.slice(0, 500)));
  }
  const external = obj(message.external_reply);
  if (external) parts.push(quotedData('Başka sohbetten yanıt', JSON.stringify(external).slice(0, 500)));
  const doc = obj(message.document);
  if (doc && typeof doc.file_name === 'string') parts.push(quotedData('Dosya adı', doc.file_name));
  for (const p of paths) parts.push(p);
  return parts.join('\n\n');
}
