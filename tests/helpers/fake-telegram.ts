/**
 * A fake Telegram Bot API for hub tests: a FetchLike that serves the methods the hub calls and
 * records every outbound request. Updates are queued per token and served from `offset`.
 */
import type { FetchLike } from '../../src/lib/telegram/transport.js';

export interface SentCall { token: string; method: string; params: Record<string, unknown>; result?: { message_id: number } }

export class FakeTelegram {
  calls: SentCall[] = [];
  private queues = new Map<string, Record<string, unknown>[]>();
  private nextUpdate = 1000;
  private nextMessage = 1;
  bots = new Map<string, { id: number; username: string }>();
  webhook = '';
  files = new Map<string, Buffer>();
  /** Methods that answer an error: method → error_code. */
  failing = new Map<string, number>();
  /** Methods that fail exactly once more each (method → error_code), then work. */
  failOnce = new Map<string, number>();
  /** File ids whose download is slow (ms). */
  slowFiles = new Map<string, number>();

  addBot(token: string, username: string): void {
    this.bots.set(token, { id: Number(token.split(':')[0]), username });
  }

  push(token: string, update: Record<string, unknown>): number {
    const id = this.nextUpdate++;
    const q = this.queues.get(token) ?? [];
    q.push({ update_id: id, ...update });
    this.queues.set(token, q);
    return id;
  }

  sent(method = 'sendMessage'): SentCall[] { return this.calls.filter((c) => c.method === method); }
  texts(): string[] { return this.sent().map((c) => String(c.params.text)); }

  fetch: FetchLike = async (url, init) => {
    const m = /\/(file\/)?bot([^/]+)\/(.+)$/.exec(url);
    if (!m) return res(404, { ok: false, error_code: 404, description: 'no' });
    const [, file, token, method] = m;
    if (file) {
      const slow = this.slowFiles.get(method);
      if (slow) await new Promise((r) => setTimeout(r, slow));
      const data = this.files.get(method) ?? Buffer.from('x');
      return { ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.length) as ArrayBuffer, headers: { get: () => String(data.length) } };
    }
    let params: Record<string, unknown> = {};
    if (typeof init?.body === 'string') params = JSON.parse(init.body);
    else if (init?.body instanceof FormData) for (const [k, v] of init.body.entries()) params[k] = typeof v === 'string' ? v : '[file]';
    if (method !== 'getUpdates') this.calls.push({ token, method, params });
    const bot = this.bots.get(token);
    if (!bot) return res(401, { ok: false, error_code: 401, description: 'Unauthorized' });
    const fail = this.failing.get(method);
    if (fail) return res(fail, { ok: false, error_code: fail, description: 'failed' });
    const once = this.failOnce.get(method);
    if (once) { this.failOnce.delete(method); return res(once, { ok: false, error_code: once, description: 'failed once' }); }
    switch (method) {
      case 'getMe': return ok({ id: bot.id, is_bot: true, username: bot.username, first_name: bot.username });
      case 'getWebhookInfo': return ok({ url: this.webhook });
      case 'getUpdates': {
        const offset = Number(params.offset ?? 0);
        const q = (this.queues.get(token) ?? []).filter((u) => Number(u.update_id) >= offset);
        this.queues.set(token, q);
        if (!q.length) await new Promise((r) => setTimeout(r, 5));
        return ok(q.slice(0, 100));
      }
      case 'sendMessage': {
        const text = String(params.text ?? '').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
        const result = { message_id: this.nextMessage++, chat: { id: params.chat_id }, text };
        this.calls[this.calls.length - 1].result = result;
        return ok(result);
      }
      case 'getFile': return ok({ file_id: params.file_id, file_size: this.files.get(String(params.file_id))?.length ?? 1, file_path: String(params.file_id) });
      case 'getManagedBotToken': case 'replaceManagedBotToken': return ok({ token: `${params.user_id ?? params.bot_user_id}:NEWTOKENNEWTOKENNEWTOKENNEWTOKEN12` });
      default: return ok(true);
    }
  };
}

function ok(result: unknown) { return res(200, { ok: true, result }); }
function res(status: number, body: unknown) {
  return { ok: status === 200, status, json: async () => body, arrayBuffer: async () => new ArrayBuffer(0), headers: { get: () => null } };
}

/** A private message from `userId`. */
export function textUpdate(userId: number, text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { message: { message_id: Math.floor(Math.random() * 1e6), date: 1, chat: { id: userId, type: 'private' }, from: { id: userId, is_bot: false, username: 'owner' }, text, ...extra } };
}
