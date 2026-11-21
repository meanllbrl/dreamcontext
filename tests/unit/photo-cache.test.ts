import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendPhotoFile } from '../../src/server/routes/automations.js';

/** A captured response: status, headers and the body length it ended with. */
function fakeRes() {
  const out: { status?: number; headers: Record<string, unknown>; bytes: number } = { headers: {}, bytes: 0 };
  const res = {
    writeHead(status: number, headers: Record<string, unknown> = {}) { out.status = status; out.headers = headers; return res; },
    setHeader() { return res; },
    end(body?: Buffer | string) { out.bytes = body ? body.length : 0; return res; },
  } as unknown as ServerResponse;
  return { res, out };
}

const req = (etag?: string) => ({ headers: etag ? { 'if-none-match': etag } : {} }) as unknown as IncomingMessage;

describe('sendPhotoFile caching', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'photo-cache-'));
    file = join(dir, 'fixture-agent.png');
    writeFileSync(file, Buffer.alloc(2048, 1));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('revalidates instead of storing nothing: no-cache + ETag, never no-store', () => {
    const { res, out } = fakeRes();
    sendPhotoFile(res, file, req());
    expect(out.status).toBe(200);
    expect(out.headers['Cache-Control']).toBe('private, no-cache');
    expect(typeof out.headers.ETag).toBe('string');
    expect(out.bytes).toBe(2048);
  });

  it('answers 304 with no body for an unchanged photo', () => {
    const first = fakeRes();
    sendPhotoFile(first.res, file, req());
    const second = fakeRes();
    sendPhotoFile(second.res, file, req(first.out.headers.ETag as string));
    expect(second.out.status).toBe(304);
    expect(second.out.bytes).toBe(0);
  });

  it('a replaced photo sends the new bytes, not a 304', () => {
    const first = fakeRes();
    sendPhotoFile(first.res, file, req());
    writeFileSync(file, Buffer.alloc(4096, 2));
    const later = new Date(Date.now() + 5_000);
    utimesSync(file, later, later);
    const second = fakeRes();
    sendPhotoFile(second.res, file, req(first.out.headers.ETag as string));
    expect(second.out.status).toBe(200);
    expect(second.out.bytes).toBe(4096);
  });
});
