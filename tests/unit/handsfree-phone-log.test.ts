/**
 * `POST /api/handsfree/phone-log` (hands-free, 2026-10-23): the phone sends its own connection
 * log to the Mac. A signed-in phone only, 64 KB, the shape checked key by key (no free text),
 * one upload per device per 10 s, owner-only files, the newest 20 kept. The dashboard's event
 * kinds and reasons are MIRRORED here (the server cannot import the dashboard): the drift test
 * holds them equal.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as auth from '../../src/server/handsfree-auth.js';
import { handsfreePhoneLogRoute, resetPhoneLogStampsForTests } from '../../src/server/routes/handsfree-mac.js';
import { markPhoneSocket } from '../../src/server/phone-origin.js';
import { PHONE_LOG_KEEP, PHONE_LOG_KINDS, PHONE_LOG_REASONS, parsePhoneLog, phoneLogsDir, writePhoneLog } from '../../src/lib/handsfree/mac/phone-log.js';
import * as client from '../../dashboard/src/lib/phoneConnLog';

const LOG = {
  v: 1, app: '0.34.4', ua: 'Mozilla/5.0 (iPhone)',
  events: [
    { t: 1_760_000_000_000, k: 'boot', cid8: '' },
    { t: 1_760_000_001_000, k: 'close', cid8: '6f1c2e9a', code: 1005 },
    { t: 1_760_000_002_000, k: 'reattached', cid8: '6f1c2e9a', busy: false },
    { t: 1_760_000_003_000, k: 'ask', cid8: '6f1c2e9a', req8: 'toolu_01' },
    { t: 1_760_000_004_000, k: 'respawn', cid8: '6f1c2e9a', reason: 'account' },
  ],
};

describe('the event vocabulary is mirrored', () => {
  it('kinds and reasons equal the dashboard\'s', () => {
    expect([...PHONE_LOG_KINDS]).toEqual([...client.PHONE_LOG_KINDS]);
    expect([...PHONE_LOG_REASONS]).toEqual([...client.PHONE_LOG_REASONS]);
  });
});

describe('parsePhoneLog', () => {
  it('accepts the schema and rebuilds it field by field', () => {
    const r = parsePhoneLog(LOG);
    expect(r).toEqual({ ok: true, log: LOG });
  });
  it('refuses unknown keys, free text, unknown kinds and reasons, long ids, a long ua', () => {
    const bad = [
      { ...LOG, note: 'hi' },
      { ...LOG, events: [{ ...LOG.events[0], text: 'my secret message' }] },
      { ...LOG, events: [{ ...LOG.events[0], k: 'message' }] },
      { ...LOG, events: [{ ...LOG.events[1], reason: 'because the owner typed X' }] },
      { ...LOG, events: [{ ...LOG.events[1], cid8: '6f1c2e9a-a001' }] },
      { ...LOG, events: [{ ...LOG.events[1], code: 'x' }] },
      { ...LOG, ua: 'x'.repeat(201) },
      { ...LOG, v: 2 },
      { ...LOG, events: Array.from({ length: 501 }, () => LOG.events[0]) },
      'not an object', null, [],
    ];
    for (const b of bad) expect(parsePhoneLog(b).ok, JSON.stringify(b).slice(0, 80)).toBe(false);
  });
});

describe('POST /api/handsfree/phone-log', { timeout: 60_000 }, () => {
  let home: string;
  const saved = process.env.HOME;
  let mac: auth.HandsfreeAuth;
  let sock: object;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'phone-log-'));
    process.env.HOME = home;
    resetPhoneLogStampsForTests();
    mac = new auth.HandsfreeAuth({ dir: join(home, 'mac') });
    (await import('node:fs')).mkdirSync(join(home, 'mac'), { recursive: true });
    auth.setMacHandsfreeAuthForTests(mac);
    sock = {};
    markPhoneSocket(sock);
  });
  afterEach(() => {
    auth.setMacHandsfreeAuthForTests(null);
    if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved;
    rmSync(home, { recursive: true, force: true });
  });

  function post(device: string | null, body: string | Buffer, onSocket: object = sock): Promise<{ status: number; body: Record<string, unknown> }> {
    return new Promise((resolve) => {
      const req = Readable.from([Buffer.isBuffer(body) ? body : Buffer.from(body)]) as unknown as IncomingMessage;
      Object.assign(req, { method: 'POST', url: '/api/handsfree/phone-log', socket: onSocket, headers: device ? { cookie: `${auth.DEVICE_COOKIE}=${device}` } : {} });
      let status = 0;
      const res = {
        setHeader() {}, writeHead(c: number) { status = c; return res; },
        end(b?: string) { resolve({ status, body: b ? JSON.parse(b) : {} }); },
      } as unknown as ServerResponse;
      void handsfreePhoneLogRoute(req, res);
    });
  }
  const files = () => { try { return readdirSync(phoneLogsDir(home)); } catch { return []; } };

  it('a signed-in phone: 201 with the count, one 0600 file in a 0700 dir holding only the schema', async () => {
    const id = mac.store.createDevice('iPhone');
    const r = await post(id, JSON.stringify(LOG));
    expect(r).toEqual({ status: 201, body: { ok: true, events: 5 } });
    expect(files()).toHaveLength(1);
    const file = join(phoneLogsDir(home), files()[0]);
    if (process.platform !== 'win32') expect(statSync(phoneLogsDir(home)).mode & 0o777).toBe(0o700); // Windows has no POSIX mode bits
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600); // Windows has no POSIX mode bits
    expect(files()[0]).toMatch(new RegExp(`-${auth.sha256Hex(id).slice(0, 8)}\\.json$`));
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual(LOG);
  });

  it('the laptop (not a phone socket), no cookie, a revoked device: refused, nothing written', async () => {
    const id = mac.store.createDevice('iPhone');
    expect((await post(id, JSON.stringify(LOG), {})).status).toBe(404);
    expect((await post(null, JSON.stringify(LOG))).status).toBe(404);
    expect((await post('not-a-device', JSON.stringify(LOG))).status).toBe(404);
    expect(files()).toEqual([]);
  });

  it('413 over 64 KB; 400 on bad JSON, unknown keys, free text — and a refusal does not burn the 10 s', async () => {
    const id = mac.store.createDevice('iPhone');
    expect((await post(id, Buffer.alloc(65 * 1024, 0x20))).status).toBe(413);
    expect((await post(id, '{not json')).status).toBe(400);
    expect((await post(id, JSON.stringify({ ...LOG, extra: 1 }))).status).toBe(400);
    expect((await post(id, JSON.stringify({ ...LOG, events: [{ ...LOG.events[0], text: 'hello' }] }))).status).toBe(400);
    expect(files()).toEqual([]);
    expect((await post(id, JSON.stringify(LOG))).status).toBe(201);
  });

  it('two concurrent posts from one phone: one 201, one 429; another phone is not limited', async () => {
    const a = mac.store.createDevice('iPhone');
    const b = mac.store.createDevice('iPad');
    const [x, y] = await Promise.all([post(a, JSON.stringify(LOG)), post(a, JSON.stringify(LOG))]);
    expect([x.status, y.status].sort()).toEqual([201, 429]);
    expect((await post(b, JSON.stringify(LOG))).status).toBe(201);
    expect(files()).toHaveLength(2);
  });

  it(`keeps the newest ${PHONE_LOG_KEEP}`, () => {
    for (let i = 0; i < PHONE_LOG_KEEP + 5; i += 1) {
      writePhoneLog(LOG as never, 'abcdef0123', home, new Date(Date.UTC(2026, 9, 23, 12, 0, i)));
    }
    const left = files().sort();
    expect(left).toHaveLength(PHONE_LOG_KEEP);
    expect(left[0]).toContain('12-00-05');
  });
});
