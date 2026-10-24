import { describe, it, expect } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { isCrossSiteWrite, isForeignFrameNavigation } from '../../src/server/middleware.js';
import { isFramedByForeignParent } from '../../dashboard/src/lib/frameGuard.js';
import { safeChildPath } from '../../src/server/safe-path.js';

function req(method: string, origin?: string, host?: string): IncomingMessage {
  return { method, headers: { ...(origin ? { origin } : {}), ...(host ? { host } : {}) } } as unknown as IncomingMessage;
}

describe('isCrossSiteWrite (CSRF guard)', () => {
  it('allows safe methods regardless of origin', () => {
    expect(isCrossSiteWrite(req('GET', 'https://evil.com'))).toBe(false);
    expect(isCrossSiteWrite(req('HEAD', 'https://evil.com'))).toBe(false);
    expect(isCrossSiteWrite(req('OPTIONS', 'https://evil.com'))).toBe(false);
  });

  it('allows writes with no Origin (non-browser client like curl/CLI)', () => {
    expect(isCrossSiteWrite(req('POST'))).toBe(false);
    expect(isCrossSiteWrite(req('PUT'))).toBe(false);
  });

  it('allows writes from this very loopback origin, and only it (port-strict, jarvis T3)', () => {
    expect(isCrossSiteWrite(req('POST', 'http://localhost:4173', 'localhost:4173'))).toBe(false);
    expect(isCrossSiteWrite(req('PUT', 'http://127.0.0.1:4173', '127.0.0.1:4173'))).toBe(false);
    expect(isCrossSiteWrite(req('PATCH', 'http://localhost:9999', 'localhost:4173'))).toBe(true);
    expect(isCrossSiteWrite(req('DELETE', 'http://localhost:4173', '127.0.0.1:4173'))).toBe(true);
  });

  it('blocks writes from a cross-site origin', () => {
    expect(isCrossSiteWrite(req('POST', 'https://evil.com'))).toBe(true);
    expect(isCrossSiteWrite(req('PUT', 'http://attacker.example'))).toBe(true);
    expect(isCrossSiteWrite(req('PATCH', 'http://localhost.evil.com'))).toBe(true);
    expect(isCrossSiteWrite(req('DELETE', 'http://notlocalhost'))).toBe(true);
  });

  // A10 — CSRF coverage for PATCH /api/config.
  // The guard at src/server/index.ts:103 runs isCrossSiteWrite BEFORE routing,
  // so any PATCH /api/config from a cross-site origin is blocked at the server
  // level before handleConfigUpdate is ever called.
  it('A10: blocks PATCH /api/config from a cross-site origin (covers handleConfigUpdate)', () => {
    expect(isCrossSiteWrite(req('PATCH', 'https://evil.com'))).toBe(true);
  });
});

describe('safeChildPath (path traversal guard)', () => {
  it('resolves a normal child inside the base', () => {
    expect(safeChildPath('/base', 'file.md')).toBe('/base/file.md');
    expect(safeChildPath('/base', 'sub/file.md')).toBe('/base/sub/file.md');
  });

  it('rejects parent-directory traversal', () => {
    expect(safeChildPath('/base', '../etc/passwd')).toBeNull();
    expect(safeChildPath('/base', '../../x')).toBeNull();
    expect(safeChildPath('/base', 'a/../../b')).toBeNull();
  });

  it('rejects absolute paths that escape the base', () => {
    expect(safeChildPath('/base', '/etc/passwd')).toBeNull();
  });

  it('rejects empty input and null bytes', () => {
    expect(safeChildPath('/base', '')).toBeNull();
    expect(safeChildPath('/base', 'x\0y')).toBeNull();
  });
});

describe('the frame gate (jarvis T1b): no foreign frame loads the dashboard', () => {
  const h = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;
  it('a frame navigation from another origin or another port of this site → refused', () => {
    for (const dest of ['iframe', 'frame', 'embed', 'object']) {
      expect(isForeignFrameNavigation(h({ 'sec-fetch-dest': dest, 'sec-fetch-site': 'cross-site' })), dest).toBe(true);
      expect(isForeignFrameNavigation(h({ 'sec-fetch-dest': dest, 'sec-fetch-site': 'same-site' })), dest).toBe(true);
    }
    expect(isForeignFrameNavigation(h({ 'sec-fetch-dest': 'iframe' }))).toBe(true);
  });
  it('the dashboard\'s own frames (PdfViewer src, same-origin) and every non-frame request pass', () => {
    expect(isForeignFrameNavigation(h({ 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'same-origin' }))).toBe(false);
    expect(isForeignFrameNavigation(h({ 'sec-fetch-dest': 'document', 'sec-fetch-site': 'cross-site' }))).toBe(false);
    expect(isForeignFrameNavigation(h({ 'sec-fetch-dest': 'image', 'sec-fetch-site': 'cross-site' }))).toBe(false);
    expect(isForeignFrameNavigation(h({}))).toBe(false);
  });
  it('the SPA fallback draws nothing in a foreign parent (no Fetch Metadata on an old WebKit)', () => {
    const self = { location: { origin: 'http://127.0.0.1:4173' } } as unknown as Window;
    const top = { ...self } as Window;
    expect(isFramedByForeignParent({ top: self, self, parent: self, location: self.location } as unknown as Window)).toBe(false);
    expect(isFramedByForeignParent({ top, self, parent: top, location: self.location } as unknown as Window)).toBe(false);
    const foreign = { get location(): Location { throw new Error('SecurityError'); } } as unknown as Window;
    expect(isFramedByForeignParent({ top: foreign, self, parent: foreign, location: self.location } as unknown as Window)).toBe(true);
    const other = { location: { origin: 'http://localhost:5173' } } as unknown as Window;
    expect(isFramedByForeignParent({ top: other, self, parent: other, location: self.location } as unknown as Window)).toBe(true);
  });
});
