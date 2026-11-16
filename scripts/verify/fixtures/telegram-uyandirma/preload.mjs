/**
 * Loaded into the scratch dashboard server (`NODE_OPTIONS=--import`) by
 * scripts/verify/telegram-uyandirma.mjs. Two stand-ins, so the REAL server code runs with no
 * real Telegram and never touches the Mac's app:
 *  - `fetch` to api.telegram.org answers from files under $HOME/.verify: updates come from
 *    tg-inbox.jsonl (one Telegram update per line, `{token, update}`), every outbound call is
 *    appended to tg-outbox.jsonl;
 *  - `/usr/bin/open` (the hub's `open -g dreamcontext://…` to reopen a window) is never run:
 *    it is logged to opened.log, as if the app's window stayed hidden and never opened.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';

const V = path.join(process.env.HOME || '', '.verify');
fs.mkdirSync(V, { recursive: true });
const inbox = path.join(V, 'tg-inbox.jsonl');
const outbox = path.join(V, 'tg-outbox.jsonl');
const opened = path.join(V, 'opened.log');
let nextMessage = 1;

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ok = (result) => json(200, { ok: true, result });
const readInbox = () => {
  try { return fs.readFileSync(inbox, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  const m = /^https:\/\/api\.telegram\.org\/(file\/)?bot([^/]+)\/(.+)$/.exec(url);
  if (!m) return realFetch(input, init);
  const [, file, token, method] = m;
  if (file) return new Response(Buffer.from('OggS'), { status: 200 });
  let params = {};
  try { if (typeof init?.body === 'string') params = JSON.parse(init.body); } catch { params = {}; }
  if (method !== 'getUpdates') fs.appendFileSync(outbox, `${JSON.stringify({ at: Date.now(), token: token.split(':')[0], method, params })}\n`);
  switch (method) {
    case 'getMe': return ok({ id: Number(token.split(':')[0]), is_bot: true, username: `bot${token.split(':')[0]}`, first_name: 'bot' });
    case 'getWebhookInfo': return ok({ url: '' });
    case 'getUpdates': {
      const offset = Number(params.offset ?? 0);
      const wait = Math.min(2000, Number(params.timeout ?? 0) * 1000);
      const end = Date.now() + wait;
      for (;;) {
        const q = readInbox().filter((e) => e.token === token && e.update.update_id >= offset).map((e) => e.update);
        if (q.length || Date.now() >= end) return ok(q.slice(0, 100));
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    case 'sendMessage': return ok({ message_id: nextMessage++, chat: { id: params.chat_id }, text: String(params.text ?? '') });
    case 'editMessageText': return ok({ message_id: params.message_id, text: String(params.text ?? '') });
    case 'getFile': return ok({ file_id: params.file_id, file_size: 4, file_path: String(params.file_id) });
    default: return ok(true);
  }
};

const require = createRequire(import.meta.url);
const cp = require('node:child_process');
const realSpawn = cp.spawn;
cp.spawn = function spawn(file, args, opts) {
  if (file === '/usr/bin/open') {
    fs.appendFileSync(opened, `${new Date().toISOString()} ${(args || []).join(' ')}\n`);
    const child = new EventEmitter();
    child.unref = () => {};
    child.pid = 0;
    return child;
  }
  return realSpawn.call(this, file, args, opts);
};
syncBuiltinESMExports();
