/**
 * The Bot API over fetch: JSON calls, multipart uploads, capped downloads. `fetch` is injectable
 * (tests use a fake Telegram).
 *
 * Fences that hold for EVERY outbound call, so no caller can forget them:
 * - text and captions pass `redactSecrets` (which also scrubs the hands-free login token);
 * - `sendMessage` / `editMessageText` carry `link_preview_options: {is_disabled: true}`;
 * - the token never appears in an error, a log line or a thrown message (the URL carries it).
 */
import { TG_DOWNLOAD_MAX_BYTES, TG_UPLOAD_MAX_BYTES, type TgUserRef } from './contract.js';
import { redactToken } from './config.js';
import { redactSecrets } from './format.js';

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: unknown; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
  headers?: { get(name: string): string | null };
  body?: unknown;
}>;

export class TelegramError extends Error {
  constructor(
    readonly method: string,
    /** HTTP-ish code: Telegram's `error_code`, or 0 for a network failure. */
    readonly code: number,
    description: string,
    readonly retryAfter?: number,
  ) {
    super(`telegram ${method}: ${code} ${description}`);
    this.name = 'TelegramError';
  }
}

export interface TgFile { file_id: string; file_unique_id?: string; file_size?: number; file_path?: string }
export interface TgSentMessage { message_id: number; date?: number; chat: { id: number } }
export interface TgWebhookInfo { url: string; pending_update_count?: number }
export interface TgMe extends TgUserRef { can_join_groups?: boolean; can_manage_bots?: boolean; [k: string]: unknown }

/** The `getManagedBotToken` parameter naming the created bot. Sources disagree (`user_id` vs
 *  `bot_user_id`); `scripts/telegram-managed-spike.mjs` settles it on a real bot (X1a). */
export const MANAGED_BOT_TOKEN_PARAM = 'user_id';

export interface UploadFile { name: string; data: Buffer; contentType?: string }

export interface TransportOptions {
  token: string;
  fetchImpl?: FetchLike;
  baseUrl?: string;
  /** Per request (not the long poll, which adds its own wait). */
  timeoutMs?: number;
}

const TEXT_FIELDS = ['text', 'caption'] as const;

/** Text fields redacted; link previews off on every text message. */
export function fenceOutbound(method: string, params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...params };
  for (const f of TEXT_FIELDS) if (typeof out[f] === 'string') out[f] = redactSecrets(out[f] as string);
  if (Array.isArray(out.media)) {
    out.media = (out.media as Record<string, unknown>[]).map((m) => (typeof m?.caption === 'string' ? { ...m, caption: redactSecrets(m.caption) } : m));
  }
  if (method === 'sendMessage' || method === 'editMessageText') {
    out.link_preview_options = { is_disabled: true };
    delete out.disable_web_page_preview;
  }
  return out;
}

export class TelegramTransport {
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: TransportOptions) {
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.baseUrl = (opts.baseUrl ?? 'https://api.telegram.org').replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  /** The bot id is the token's prefix: known without a request. */
  get botId(): number { return Number(this.token.split(':')[0]); }

  private url(method: string): string { return `${this.baseUrl}/bot${this.token}/${method}`; }

  private sanitize(text: string): string { return redactToken(text, this.token); }

  private async request(method: string, init: { body: unknown; headers?: Record<string, string> }, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<unknown> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? this.timeoutMs);
    const onAbort = (): void => ctl.abort();
    opts.signal?.addEventListener('abort', onAbort);
    let res;
    try {
      res = await this.fetchImpl(this.url(method), { method: 'POST', headers: init.headers, body: init.body, signal: ctl.signal });
    } catch (err) {
      throw new TelegramError(method, 0, this.sanitize(ctl.signal.aborted ? 'aborted' : (err as Error)?.message ?? 'network error'));
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
    let body: unknown;
    try { body = await res.json(); } catch { throw new TelegramError(method, res.status, 'bad response'); }
    const b = body as { ok?: boolean; result?: unknown; error_code?: number; description?: string; parameters?: { retry_after?: number } };
    if (!res.ok || b.ok !== true) {
      throw new TelegramError(method, b.error_code ?? res.status, this.sanitize(String(b.description ?? 'error')).slice(0, 300), b.parameters?.retry_after);
    }
    return b.result;
  }

  /** One JSON call; every outbound fence applied. */
  call<T = unknown>(method: string, params: Record<string, unknown> = {}, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    const body = JSON.stringify(fenceOutbound(method, params));
    return this.request(method, { body, headers: { 'content-type': 'application/json' } }, opts) as Promise<T>;
  }

  /** One multipart call: `files` are attached under their field names (≤50 MB in total). */
  async upload<T = unknown>(method: string, params: Record<string, unknown>, files: Record<string, UploadFile>): Promise<T> {
    let total = 0;
    for (const f of Object.values(files)) total += f.data.length;
    if (total > TG_UPLOAD_MAX_BYTES) throw new TelegramError(method, 413, 'file too large');
    const form = new FormData();
    for (const [k, v] of Object.entries(fenceOutbound(method, params))) {
      if (v === undefined) continue;
      form.append(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
    for (const [field, f] of Object.entries(files)) {
      form.append(field, new Blob([new Uint8Array(f.data)], { type: f.contentType ?? 'application/octet-stream' }), f.name);
    }
    return this.request(method, { body: form }, { timeoutMs: Math.max(this.timeoutMs, 60_000) }) as Promise<T>;
  }

  // ── Methods ──

  getMe(): Promise<TgMe> { return this.call('getMe'); }
  getWebhookInfo(): Promise<TgWebhookInfo> { return this.call('getWebhookInfo'); }

  getUpdates(params: { offset?: number; timeout?: number; allowed_updates?: readonly string[] }, signal?: AbortSignal): Promise<unknown[]> {
    const wait = (params.timeout ?? 0) * 1000;
    return this.call<unknown[]>('getUpdates', { ...params }, { signal, timeoutMs: wait + this.timeoutMs });
  }

  sendMessage(chatId: number, html: string, extra: Record<string, unknown> = {}): Promise<TgSentMessage> {
    return this.call('sendMessage', { chat_id: chatId, text: html, parse_mode: 'HTML', ...extra });
  }
  editMessageText(chatId: number, messageId: number, html: string, extra: Record<string, unknown> = {}): Promise<unknown> {
    return this.call('editMessageText', { chat_id: chatId, message_id: messageId, text: html, parse_mode: 'HTML', ...extra });
  }
  sendChatAction(chatId: number, action: 'typing' | 'upload_photo' | 'upload_document' = 'typing'): Promise<unknown> {
    return this.call('sendChatAction', { chat_id: chatId, action });
  }
  answerCallbackQuery(id: string, text?: string): Promise<unknown> {
    return this.call('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) });
  }
  setMyCommands(commands: readonly { command: string; description: string }[]): Promise<unknown> {
    return this.call('setMyCommands', { commands });
  }
  sendPhoto(chatId: number, file: UploadFile, caption?: string): Promise<TgSentMessage> {
    return this.upload('sendPhoto', { chat_id: chatId, ...(caption ? { caption, parse_mode: 'HTML' } : {}) }, { photo: file });
  }
  sendDocument(chatId: number, file: UploadFile, caption?: string): Promise<TgSentMessage> {
    return this.upload('sendDocument', { chat_id: chatId, ...(caption ? { caption, parse_mode: 'HTML' } : {}) }, { document: file });
  }
  sendVideo(chatId: number, file: UploadFile, caption?: string): Promise<TgSentMessage> {
    return this.upload('sendVideo', { chat_id: chatId, ...(caption ? { caption, parse_mode: 'HTML' } : {}) }, { video: file });
  }
  sendSticker(chatId: number, file: UploadFile): Promise<TgSentMessage> {
    return this.upload('sendSticker', { chat_id: chatId }, { sticker: file });
  }
  getFile(fileId: string): Promise<TgFile> { return this.call('getFile', { file_id: fileId }); }

  /** A file's bytes, refused past `cap` (20 MB: what a bot may download) before AND while reading. */
  async download(file: TgFile, cap: number = TG_DOWNLOAD_MAX_BYTES): Promise<Buffer> {
    if (typeof file.file_size === 'number' && file.file_size > cap) throw new TelegramError('download', 413, 'file too large');
    if (!file.file_path || !/^[A-Za-z0-9_./-]+$/.test(file.file_path) || file.file_path.includes('..')) {
      throw new TelegramError('download', 400, 'no file path');
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 120_000);
    // The timer covers the headers AND the body: a stalled body must time out, not hang.
    try {
      let res;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/file/bot${this.token}/${file.file_path}`, { method: 'GET', signal: ctl.signal });
      } catch (err) {
        throw new TelegramError('download', 0, this.sanitize(ctl.signal.aborted ? 'timed out' : (err as Error)?.message ?? 'network error'));
      }
      if (!res.ok) throw new TelegramError('download', res.status, 'download failed');
      const declared = Number(res.headers?.get('content-length') ?? NaN);
      if (Number.isFinite(declared) && declared > cap) throw new TelegramError('download', 413, 'file too large');
      let buf: Buffer;
      try {
        buf = Buffer.from(await res.arrayBuffer());
      } catch (err) {
        throw new TelegramError('download', 0, this.sanitize(ctl.signal.aborted ? 'timed out' : (err as Error)?.message ?? 'network error'));
      }
      if (buf.length > cap) throw new TelegramError('download', 413, 'file too large');
      return buf;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Managed bots (X1, X6, Z4) ──

  /** The created bot's token (the manager's call). The result is a token: never logged. */
  async getManagedBotToken(botUserId: number, param: string = MANAGED_BOT_TOKEN_PARAM): Promise<string> {
    const r = await this.call<unknown>('getManagedBotToken', { [param]: botUserId });
    const token = typeof r === 'string' ? r : (r as { token?: unknown })?.token;
    if (typeof token !== 'string') throw new TelegramError('getManagedBotToken', 500, 'no token in result');
    return token;
  }

  /** Revokes the created bot's token and returns the new one (Kaldır discards it, X6). */
  async replaceManagedBotToken(botUserId: number, param: string = MANAGED_BOT_TOKEN_PARAM): Promise<string> {
    const r = await this.call<unknown>('replaceManagedBotToken', { [param]: botUserId });
    const token = typeof r === 'string' ? r : (r as { token?: unknown })?.token;
    if (typeof token !== 'string') throw new TelegramError('replaceManagedBotToken', 500, 'no token in result');
    return token;
  }
}
