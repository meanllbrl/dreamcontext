/**
 * The transport's fences hold on every call: link previews off, text redacted, no hands-free
 * login token in any body, the token never in an error; downloads capped at 20 MB; the managed-bot
 * methods (plan AC9, A6, X1).
 */
import { describe, it, expect, vi } from 'vitest';
import { TelegramTransport, TelegramError, MANAGED_BOT_TOKEN_PARAM, type FetchLike } from '../../src/lib/telegram/transport.js';

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ';
const LOGIN_URL = 'https://abc.trycloudflare.com/login?t=SECRETLOGIN123';

interface Call { url: string; body: unknown; method?: string }

function fakeFetch(result: unknown = { message_id: 1, chat: { id: 42 } }, opts: { ok?: boolean; status?: number; error?: Error; json?: unknown; bytes?: Buffer; headers?: Record<string, string> } = {}) {
  const calls: Call[] = [];
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, body: init?.body, method: init?.method });
    if (opts.error) throw opts.error;
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      json: async () => opts.json ?? { ok: true, result },
      arrayBuffer: async () => { const b = opts.bytes ?? Buffer.alloc(0); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); },
      headers: { get: (n: string) => opts.headers?.[n.toLowerCase()] ?? null },
    };
  };
  return { calls, impl };
}

/** Every string a request body carries (JSON or multipart), for "never in any body" checks. */
async function bodyText(body: unknown): Promise<string> {
  if (typeof body === 'string') return body;
  if (body instanceof FormData) {
    const parts: string[] = [];
    for (const [k, v] of body.entries()) parts.push(`${k}=${typeof v === 'string' ? v : await (v as Blob).text()}`);
    return parts.join('\n');
  }
  return String(body);
}

describe('outbound fences', () => {
  it('sendMessage and editMessageText always disable link previews', async () => {
    const f = fakeFetch();
    const t = new TelegramTransport({ token: TOKEN, fetchImpl: f.impl });
    await t.sendMessage(42, 'https://ornek.com');
    await t.editMessageText(42, 1, 'https://ornek.com', { disable_web_page_preview: false, link_preview_options: { is_disabled: false } });
    await t.call('sendMessage', { chat_id: 42, text: 'x' });
    for (const c of f.calls) {
      const b = JSON.parse(c.body as string);
      expect(b.link_preview_options).toEqual({ is_disabled: true });
      expect(b.disable_web_page_preview).toBeUndefined();
    }
  });

  it('no body ever carries the hands-free login token or a secret, whatever the method', async () => {
    const f = fakeFetch();
    const t = new TelegramTransport({ token: TOKEN, fetchImpl: f.impl });
    const evil = `Link ${LOGIN_URL} ve anahtar sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345`;
    await t.sendMessage(42, evil);
    await t.editMessageText(42, 1, evil);
    await t.sendPhoto(42, { name: 'a.png', data: Buffer.from('png') }, evil);
    await t.sendDocument(42, { name: 'a.pdf', data: Buffer.from('pdf') }, evil);
    await t.sendVideo(42, { name: 'a.mp4', data: Buffer.from('mp4') }, evil);
    await t.call('sendMediaGroup', { chat_id: 42, media: [{ type: 'photo', media: 'x', caption: evil }] });
    await t.call('sendMessage', { chat_id: 42, text: evil });
    expect(f.calls.length).toBe(7);
    for (const c of f.calls) {
      const text = await bodyText(c.body);
      expect(text).not.toContain('SECRETLOGIN123');
      expect(text).not.toContain('t=SECRETLOGIN');
      expect(text).not.toContain('sk-ant-api03');
    }
  });

  it('a Telegram error never carries the token (the URL has it)', async () => {
    const f = fakeFetch(null, { ok: false, status: 400, json: { ok: false, error_code: 400, description: `Bad Request: bot${TOKEN} broke` } });
    const t = new TelegramTransport({ token: TOKEN, fetchImpl: f.impl });
    const err = await t.sendMessage(42, 'x').catch((e) => e);
    expect(err).toBeInstanceOf(TelegramError);
    expect(err.code).toBe(400);
    expect(String(err.message)).not.toContain(TOKEN.split(':')[1]);
    const net = fakeFetch(null, { error: new Error(`connect ECONNREFUSED https://api.telegram.org/bot${TOKEN}/getMe`) });
    const e2 = await new TelegramTransport({ token: TOKEN, fetchImpl: net.impl }).getMe().catch((e) => e);
    expect(e2.code).toBe(0);
    expect(String(e2.message)).not.toContain(TOKEN.split(':')[1]);
    expect(String(e2.stack)).not.toContain(TOKEN.split(':')[1]);
  });

  it('retry_after is surfaced; the bot id is the token prefix', async () => {
    const f = fakeFetch(null, { ok: false, status: 429, json: { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 7 } } });
    const t = new TelegramTransport({ token: TOKEN, fetchImpl: f.impl });
    const err = await t.sendMessage(42, 'x').catch((e) => e);
    expect(err.retryAfter).toBe(7);
    expect(t.botId).toBe(123456789);
  });
});

describe('downloads', () => {
  it('refuses past 20 MB before downloading, by declared length, and by actual bytes', async () => {
    const f = fakeFetch(null, { bytes: Buffer.alloc(30) });
    const t = new TelegramTransport({ token: TOKEN, fetchImpl: f.impl });
    await expect(t.download({ file_id: 'a', file_path: 'p/a.jpg', file_size: 21 * 1024 * 1024 })).rejects.toMatchObject({ code: 413 });
    expect(f.calls.length).toBe(0);
    await expect(t.download({ file_id: 'a', file_path: 'p/a.jpg' }, 10)).rejects.toMatchObject({ code: 413 });
    const h = fakeFetch(null, { bytes: Buffer.alloc(1), headers: { 'content-length': String(25 * 1024 * 1024) } });
    await expect(new TelegramTransport({ token: TOKEN, fetchImpl: h.impl }).download({ file_id: 'a', file_path: 'p/a.jpg' })).rejects.toMatchObject({ code: 413 });
    const ok = fakeFetch(null, { bytes: Buffer.from('veri') });
    expect((await new TelegramTransport({ token: TOKEN, fetchImpl: ok.impl }).download({ file_id: 'a', file_path: 'p/a.jpg' })).toString()).toBe('veri');
  });

  it('refuses a file path that could climb', async () => {
    const f = fakeFetch(null, { bytes: Buffer.from('x') });
    const t = new TelegramTransport({ token: TOKEN, fetchImpl: f.impl });
    await expect(t.download({ file_id: 'a', file_path: '../../x' })).rejects.toMatchObject({ code: 400 });
  });

  it('a body that stalls after the headers times out as a timeout, not a hang', async () => {
    vi.useFakeTimers();
    try {
      const impl: FetchLike = async (_url, init) => ({
        ok: true, status: 200, json: async () => ({}),
        arrayBuffer: () => new Promise<ArrayBuffer>((_res, rej) => { init?.signal?.addEventListener('abort', () => rej(new Error('The operation was aborted'))); }),
        headers: { get: () => null },
      });
      const t = new TelegramTransport({ token: TOKEN, fetchImpl: impl });
      const p = t.download({ file_id: 'a', file_path: 'p/a.jpg' });
      const assertion = expect(p).rejects.toMatchObject({ code: 0, message: expect.stringContaining('timed out') });
      await vi.advanceTimersByTimeAsync(121_000);
      await assertion;
    } finally { vi.useRealTimers(); }
  });
});

describe('managed bots', () => {
  it('getManagedBotToken sends the bot user id under the pinned parameter and returns the token', async () => {
    const f = fakeFetch('987:BBBdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ');
    const t = new TelegramTransport({ token: TOKEN, fetchImpl: f.impl });
    expect(await t.getManagedBotToken(987)).toBe('987:BBBdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ');
    expect(f.calls[0].url.endsWith('/getManagedBotToken')).toBe(true);
    expect(JSON.parse(f.calls[0].body as string)).toEqual({ [MANAGED_BOT_TOKEN_PARAM]: 987 });
    await t.getManagedBotToken(987, 'bot_user_id');
    expect(JSON.parse(f.calls[1].body as string)).toEqual({ bot_user_id: 987 });
  });

  it('replaceManagedBotToken returns the new token (object result too)', async () => {
    const f = fakeFetch({ token: '987:CCCdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ' });
    const t = new TelegramTransport({ token: TOKEN, fetchImpl: f.impl });
    expect(await t.replaceManagedBotToken(987)).toBe('987:CCCdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ');
    expect(f.calls[0].url.endsWith('/replaceManagedBotToken')).toBe(true);
  });
});
