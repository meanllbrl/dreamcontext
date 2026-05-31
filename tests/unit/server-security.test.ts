import { describe, it, expect } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { isCrossSiteWrite } from '../../src/server/middleware.js';
import { safeChildPath } from '../../src/server/safe-path.js';

function req(method: string, origin?: string): IncomingMessage {
  return { method, headers: origin ? { origin } : {} } as unknown as IncomingMessage;
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

  it('allows writes from loopback origins', () => {
    expect(isCrossSiteWrite(req('POST', 'http://localhost:4173'))).toBe(false);
    expect(isCrossSiteWrite(req('PUT', 'http://127.0.0.1:4173'))).toBe(false);
    expect(isCrossSiteWrite(req('PATCH', 'http://localhost:9999'))).toBe(false);
    expect(isCrossSiteWrite(req('DELETE', 'https://127.0.0.1:4173'))).toBe(false);
  });

  it('blocks writes from a cross-site origin', () => {
    expect(isCrossSiteWrite(req('POST', 'https://evil.com'))).toBe(true);
    expect(isCrossSiteWrite(req('PUT', 'http://attacker.example'))).toBe(true);
    expect(isCrossSiteWrite(req('PATCH', 'http://localhost.evil.com'))).toBe(true);
    expect(isCrossSiteWrite(req('DELETE', 'http://notlocalhost'))).toBe(true);
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
