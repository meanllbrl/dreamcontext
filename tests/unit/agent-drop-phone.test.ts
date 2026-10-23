/**
 * A photo from the hands-free phone (task hands-free-phone-shows-every-picture…, D5), through the
 * real `POST /api/agent/drop` handler on a socket the phone listener marked:
 *   • a declared size over 10 MB is refused before any byte is read; a stream past it too;
 *   • images only, by their bytes; the client's name and type are ignored, the server names it;
 *   • two in flight and thirty a minute per DEVICE, the slot freed even when the upload aborts;
 *   • at most 500 MB of phone photos per project;
 *   • the desktop's own drop is unchanged.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os');
  process.env.HOME = fs.mkdtempSync(`${os.tmpdir()}/dc-phonedrop-home-`);
});

vi.mock('../../src/server/handsfree-auth.js', async (orig) => {
  const real = await orig<typeof import('../../src/server/handsfree-auth.js')>();
  return { ...real, deviceIdHash: (req: IncomingMessage) => (req.headers['x-test-device'] as string | undefined) ?? null };
});

import { handleAgentDrop } from '../../src/server/routes/agent-drop.js';
import { markPhoneSocket } from '../../src/server/phone-origin.js';
import { PHONE_DROPS_MAX_BYTES, PHONE_MAX_PHOTO_BYTES, resetPhonePhotoGates } from '../../src/lib/handsfree/mac/photo-limits.js';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

class FakeReq extends EventEmitter {
  socket = {};
  destroyed = false;
  constructor(public headers: Record<string, string>, phone = true) {
    super();
    if (phone) markPhoneSocket(this.socket);
  }
  destroy(): void { this.destroyed = true; }
  resume(): void {}
  /** Feed the body on the next tick, then end (or close early: an aborted upload). */
  feed(body: Buffer, how: 'end' | 'abort' = 'end'): this {
    setTimeout(() => {
      this.emit('data', body);
      if (how === 'end') this.emit('end');
      this.emit('close');
    }, 0);
    return this;
  }
}

function res(): { res: ServerResponse; status: () => number; body: () => Record<string, unknown> } {
  let code = 0;
  let body: unknown = null;
  const r = {
    headersSent: false,
    writeHead(c: number) { code = c; return r; },
    setHeader() {},
    end(d?: string) { if (typeof d === 'string') { try { body = JSON.parse(d); } catch { body = d; } } },
  } as unknown as ServerResponse;
  return { res: r, status: () => code, body: () => body as Record<string, unknown> };
}

let contextRoot: string;
const dropDir = (): string => join(contextRoot, 'tmp', 'agent-drops');

async function drop(body: Buffer, headers: Record<string, string> = {}, opts: { phone?: boolean; how?: 'end' | 'abort' } = {}) {
  const req = new FakeReq({ 'x-test-device': 'dev-a', 'content-length': String(body.length), ...headers }, opts.phone ?? true);
  const r = res();
  await handleAgentDrop(req.feed(body, opts.how) as unknown as IncomingMessage, r.res, {}, contextRoot);
  return r;
}

beforeEach(() => {
  contextRoot = join(mkdtempSync(join(tmpdir(), 'dc-phonedrop-')), '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
  resetPhonePhotoGates();
});

afterEach(() => {
  rmSync(join(contextRoot, '..'), { recursive: true, force: true });
  delete process.env.DREAMCONTEXT_DESKTOP;
});

describe('POST /api/agent/drop from the phone', () => {
  it('saves a photo under a name the server chose, in the project\'s gitignored tmp', async () => {
    const r = await drop(JPEG, { 'x-dreamcontext-filename': encodeURIComponent('../../evil.sh'), 'content-type': 'text/html' });
    expect(r.status(), JSON.stringify(r.body())).toBe(200);
    expect(r.body().contentType).toBe('image/jpeg');
    const path = String(r.body().path);
    expect(path.startsWith(dropDir() + '/')).toBe(true);
    expect(basename(path)).toMatch(/^phone-\d+-[0-9a-f]{8}\.jpg$/);
    expect(readFileSync(path).equals(JPEG)).toBe(true);
    expect(readFileSync(join(contextRoot, 'tmp', '.gitignore'), 'utf-8')).toBe('*\n');
  });

  it('works without the desktop flag (the phone branch is chosen by the socket)', async () => {
    delete process.env.DREAMCONTEXT_DESKTOP;
    expect((await drop(PNG)).status()).toBe(200);
  });

  it('refuses anything that is not an image by its bytes', async () => {
    const r = await drop(Buffer.from('%PDF-1.7 not a photo'), { 'content-type': 'image/jpeg', 'x-dreamcontext-filename': 'a.jpg' });
    expect(r.status()).toBe(415);
    expect(readdirSync(join(contextRoot)).includes('tmp') ? readdirSync(dropDir()).length : 0).toBe(0);
  });

  it('refuses a declared size over 10 MB before reading, and a stream past it', async () => {
    const declared = await drop(JPEG, { 'content-length': String(PHONE_MAX_PHOTO_BYTES + 1) });
    expect(declared.status()).toBe(413);
    const streamed = await drop(Buffer.concat([JPEG, Buffer.alloc(PHONE_MAX_PHOTO_BYTES)]), { 'content-length': '' });
    expect(streamed.status()).toBe(413);
  });

  it('caps a device at two in flight; another device is not held up', async () => {
    const slow = (): FakeReq => new FakeReq({ 'x-test-device': 'dev-a' });
    const a = slow(); const b = slow();
    const pa = handleAgentDrop(a as unknown as IncomingMessage, res().res, {}, contextRoot);
    const pb = handleAgentDrop(b as unknown as IncomingMessage, res().res, {}, contextRoot);
    const third = await drop(JPEG);
    expect(third.status()).toBe(429);
    expect(third.body().error).toBe('photo_busy');
    expect((await drop(JPEG, { 'x-test-device': 'dev-b' })).status()).toBe(200);
    a.feed(JPEG); b.feed(JPEG);
    await Promise.all([pa, pb]);
    expect((await drop(JPEG)).status()).toBe(200);
  });

  it('an aborted upload frees its slot', async () => {
    for (let i = 0; i < 3; i++) {
      const r = await drop(JPEG.subarray(0, 10), {}, { how: 'abort' });
      expect(r.status()).toBe(0); // nobody to answer
    }
    expect((await drop(JPEG)).status()).toBe(200);
  });

  it('caps a device at thirty a minute', async () => {
    for (let i = 0; i < 30; i++) expect((await drop(JPEG)).status()).toBe(200);
    const r = await drop(JPEG);
    expect(r.status()).toBe(429);
  });

  it('refuses past 500 MB of phone photos in the project', async () => {
    mkdirSync(dropDir(), { recursive: true });
    // A sparse stand-in: the size is what counts.
    writeFileSync(join(dropDir(), 'phone-1-aaaaaaaa.jpg'), '');
    const { truncateSync } = await import('node:fs');
    truncateSync(join(dropDir(), 'phone-1-aaaaaaaa.jpg'), PHONE_DROPS_MAX_BYTES);
    expect((await drop(JPEG)).status()).toBe(507);
  });

  it('needs a signed-in device', async () => {
    const req = new FakeReq({ 'content-length': String(JPEG.length) });
    const r = res();
    await handleAgentDrop(req.feed(JPEG) as unknown as IncomingMessage, r.res, {}, contextRoot);
    expect(r.status()).toBe(401);
  });
});

describe('POST /api/agent/drop on the desktop is unchanged', () => {
  it('keeps the dropped name and takes any file', async () => {
    process.env.DREAMCONTEXT_DESKTOP = '1';
    const r = await drop(Buffer.from('a,b\n1,2\n'), { 'x-dreamcontext-filename': 'data.csv' }, { phone: false });
    expect(r.status(), JSON.stringify(r.body())).toBe(200);
    expect(basename(String(r.body().path))).toMatch(/^\d+-data\.csv$/);
  });
});
