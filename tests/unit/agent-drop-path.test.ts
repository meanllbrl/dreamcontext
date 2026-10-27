/**
 * `POST /api/agent/drop-path` — a picture picked with the composer's "Attach files…" is copied
 * into the project's drop folder, so its chip and the sent bubble can show it (owner 2026-10-28).
 * Desktop only, never the phone; only a real picture by its bytes; only an absolute literal path.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleAgentDropPath } from '../../src/server/routes/agent-drop.js';
import { markPhoneSocket } from '../../src/server/phone-origin.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

class FakeReq extends EventEmitter {
  socket: { remoteAddress: string } = { remoteAddress: '127.0.0.1' };
  headers: Record<string, string> = {};
  constructor(body: string, phone = false, from = '127.0.0.1') {
    super();
    this.socket.remoteAddress = from;
    if (phone) markPhoneSocket(this.socket);
    setTimeout(() => { this.emit('data', Buffer.from(body)); this.emit('end'); this.emit('close'); }, 0);
  }
  destroy(): void {}
}

function res() {
  let code = 0;
  let body: Record<string, unknown> = {};
  const r = {
    headersSent: false,
    writeHead(c: number) { code = c; return r; },
    setHeader() {},
    end(d?: string) { if (typeof d === 'string') body = JSON.parse(d); },
  } as unknown as ServerResponse;
  return { r, status: () => code, body: () => body };
}

let dir: string;
let contextRoot: string;
const prevDesktop = process.env.DREAMCONTEXT_DESKTOP;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dc-droppath-'));
  contextRoot = join(dir, 'proj', '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
  process.env.DREAMCONTEXT_DESKTOP = '1';
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (prevDesktop === undefined) delete process.env.DREAMCONTEXT_DESKTOP; else process.env.DREAMCONTEXT_DESKTOP = prevDesktop;
});

async function call(body: unknown, phone = false, from = '127.0.0.1') {
  const x = res();
  await handleAgentDropPath(new FakeReq(JSON.stringify(body), phone, from) as unknown as IncomingMessage, x.r, {}, contextRoot);
  return x;
}

describe('POST /api/agent/drop-path', () => {
  it('copies a picked picture into tmp/agent-drops and answers its path', async () => {
    const src = join(dir, 'Desktop', 'Screen Shot.png');
    mkdirSync(dirname(src), { recursive: true });
    writeFileSync(src, PNG);
    const x = await call({ path: src });
    expect(x.status()).toBe(200);
    const out = x.body().path as string;
    expect(dirname(out)).toBe(join(contextRoot, 'tmp', 'agent-drops'));
    expect(out.endsWith('-Screen_Shot.png')).toBe(true);
    expect(readFileSync(out).equals(PNG)).toBe(true);
  });

  it('a picture already inside the project is not copied: its own path comes back', async () => {
    const src = join(dir, 'proj', 'src', 'assets', 'logo.png');
    mkdirSync(dirname(src), { recursive: true });
    writeFileSync(src, PNG);
    const x = await call({ path: src });
    expect(x.status()).toBe(200);
    expect(x.body().path).toBe(src);
  });

  it('refuses a file that is not a picture by its bytes, even named .png', async () => {
    const src = join(dir, 'fake.png');
    writeFileSync(src, 'not a picture');
    expect((await call({ path: src })).status()).toBe(415);
  });

  it('refuses a relative path, a climb, a folder and a missing file', async () => {
    expect((await call({ path: 'a.png' })).status()).toBe(400);
    expect((await call({ path: `${dir}/../x.png` })).status()).toBe(400);
    expect((await call({ path: dir })).status()).toBe(400);
    expect((await call({ path: join(dir, 'gone.png') })).status()).toBe(404);
  });

  it('refuses the phone, a peer off loopback, and a non-desktop server', async () => {
    const src = join(dir, 'p.png');
    writeFileSync(src, PNG);
    expect((await call({ path: src }, true)).status()).toBe(403);
    expect((await call({ path: src }, false, '192.168.1.20')).status()).toBe(403);
    delete process.env.DREAMCONTEXT_DESKTOP;
    expect((await call({ path: src })).status()).toBe(403);
  });
});
