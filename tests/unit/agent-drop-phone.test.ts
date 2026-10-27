/**
 * A photo from the hands-free phone (task hands-free-phone-shows-every-picture…, D5), through the
 * real `POST /api/agent/drop` handler on a socket the phone listener marked:
 *   • a declared size over 25 MB is refused before any byte is read; a stream past it too; an
 *     image past 10 MB too;
 *   • an image is known by its bytes and named by the server; any other file (a zip, a PDF, a
 *     text file) is kept as its bytes under its sanitized name behind the server's prefix, never
 *     extracted;
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
import { PHONE_DROPS_MAX_BYTES, PHONE_MAX_FILE_BYTES, PHONE_MAX_PHOTO_BYTES, resetPhonePhotoGates } from '../../src/lib/handsfree/mac/photo-limits.js';

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

  it('saves a zip as its bytes under its own name, never extracted', async () => {
    // A real zip header (PK\x03\x04) with one entry's worth of bytes.
    const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(128, 3)]);
    const r = await drop(ZIP, { 'x-dreamcontext-filename': encodeURIComponent('site export.zip'), 'content-type': 'application/zip' });
    expect(r.status(), JSON.stringify(r.body())).toBe(200);
    expect(r.body().contentType).toBe(null);
    const path = String(r.body().path);
    expect(path.startsWith(dropDir() + '/')).toBe(true);
    expect(basename(path)).toMatch(/^phone-\d+-[0-9a-f]{8}-site_export\.zip$/);
    expect(readFileSync(path).equals(ZIP)).toBe(true);
    expect(readdirSync(dropDir())).toEqual([basename(path)]);
  });

  it('saves a PDF and a text file, keeping what they are', async () => {
    const pdf = await drop(Buffer.from('%PDF-1.7 a report'), { 'x-dreamcontext-filename': 'Q3 report.pdf' });
    expect(basename(String(pdf.body().path))).toMatch(/^phone-\d+-[0-9a-f]{8}-Q3_report\.pdf$/);
    const txt = await drop(Buffer.from('hello\n'), { 'x-dreamcontext-filename': 'notes.txt' });
    expect(basename(String(txt.body().path))).toMatch(/-notes\.txt$/);
    expect(readFileSync(String(txt.body().path), 'utf-8')).toBe('hello\n');
  });

  it('a file\'s name can never leave the drop folder or hide', async () => {
    for (const name of ['../../evil.sh', '/etc/passwd', '..\\..\\x.bat', '.env', '']) {
      const r = await drop(Buffer.from('x'), { 'x-dreamcontext-filename': encodeURIComponent(name) });
      expect(r.status(), name).toBe(200);
      const path = String(r.body().path);
      expect(path.startsWith(dropDir() + '/'), name).toBe(true);
      expect(basename(path), name).toMatch(/^phone-\d+-[0-9a-f]{8}-[^/]+$/);
    }
    const long = await drop(Buffer.from('x'), { 'x-dreamcontext-filename': `${'a'.repeat(400)}.zip` });
    expect(basename(String(long.body().path)).length).toBeLessThan(160);
    expect(String(long.body().path)).toMatch(/\.zip$/);
  });

  it('a file named like a photo but not one by its bytes is stored as a file, not a photo', async () => {
    const r = await drop(Buffer.from('%PDF-1.7 not a photo'), { 'content-type': 'image/jpeg', 'x-dreamcontext-filename': 'a.jpg' });
    expect(r.status()).toBe(200);
    expect(r.body().contentType).toBe(null);
    expect(basename(String(r.body().path))).toMatch(/^phone-\d+-[0-9a-f]{8}-a\.jpg$/);
  });

  it('refuses a declared size over 25 MB before reading, and a stream past it', async () => {
    const declared = await drop(Buffer.from('x'), { 'content-length': String(PHONE_MAX_FILE_BYTES + 1) });
    expect(declared.status()).toBe(413);
    const streamed = await drop(Buffer.alloc(PHONE_MAX_FILE_BYTES + 1), { 'content-length': '' });
    expect(streamed.status()).toBe(413);
    expect(readdirSync(join(contextRoot)).includes('tmp') ? readdirSync(dropDir()).length : 0).toBe(0);
  });

  it('still holds a photo to 10 MB', async () => {
    const r = await drop(Buffer.concat([JPEG, Buffer.alloc(PHONE_MAX_PHOTO_BYTES)]), { 'content-length': '' });
    expect(r.status()).toBe(413);
    expect(readdirSync(join(contextRoot)).includes('tmp') ? readdirSync(dropDir()).length : 0).toBe(0);
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

  it('a file counts toward the 500 MB of phone uploads too', async () => {
    mkdirSync(dropDir(), { recursive: true });
    writeFileSync(join(dropDir(), 'phone-1-aaaaaaaa-big.zip'), '');
    const { truncateSync } = await import('node:fs');
    truncateSync(join(dropDir(), 'phone-1-aaaaaaaa-big.zip'), PHONE_DROPS_MAX_BYTES);
    expect((await drop(Buffer.from('x'), { 'x-dreamcontext-filename': 'b.txt' })).status()).toBe(507);
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
