/**
 * A Super Agent `web` container uses the whiteboard web widget's rule (jarvis plan r9, K5): an
 * https page, a dev server on `localhost` / `127.0.0.1` / `[::1]`, or a project-relative file.
 * On top: never a port this process owns (`owned-port`), never another spelling of this machine,
 * never an absolute file. The drift test runs the window's own rule over the same cases.
 */
import { describe, it, expect } from 'vitest';
import { validateSuperWebUrl } from '../../src/lib/super/web-url.js';
import { validateWebUrl } from '../../dashboard/src/components/whiteboard/webUrl.js';

const OWN = 'http://127.0.0.1:4173';
const OWNED = new Set([4173, 47113, 9222]);
const CASES = [
  'https://example.com', 'https://example.com/a?b=c#d', 'https://sub.example.co.uk:8443/x', 'https://xn--bcher-kva.example/',
  'http://example.com', 'https://localhost', 'https://localhost:4173/', 'http://127.0.0.1:4173', 'https://127.0.0.1/',
  'https://127.1.2.3/', 'https://[::1]/', 'https://0.0.0.0/', 'https://app.localhost/', 'https://user:pw@example.com',
  'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'example.com', 'docs/page.html', '', '   ',
  'https://exa mple.com', 'https://example.com\\@evil.test',
  'http://localhost:5173', 'localhost:5173', 'http://LOCALHOST:5173/x', 'http://[::1]:3000', 'http://127.0.0.1:80/',
  'http://localhost.:5173', 'http://127.1:5173', 'http://0.0.0.0:5173', 'http://app.localhost:5173', 'http://[::ffff:127.0.0.1]:5173',
  'http://localhost:47113', 'http://127.0.0.1:9222/json', 'mockups/a.png', 'mockups/b.svg', 'docs/report.pdf', '/Users/x/a.html',
];

describe('validateSuperWebUrl', () => {
  it('accepts an https page on another host', () => {
    expect(validateSuperWebUrl('https://example.com/a')).toEqual({ ok: true, kind: 'url', href: 'https://example.com/a', host: 'example.com' });
  });

  it('accepts a dev server on the three loopback spellings, any case, with or without a scheme, :80 included', () => {
    for (const [raw, port] of [['http://localhost:5173', 5173], ['localhost:5173', 5173], ['http://LOCALHOST:5173/x', 5173],
      ['http://127.0.0.1:3000', 3000], ['http://[::1]:3000', 3000], ['http://127.0.0.1:80/', 80]] as const) {
      const r = validateSuperWebUrl(raw, OWNED);
      expect(r.ok, raw).toBe(true);
      if (r.ok && r.kind === 'url') expect(r.loopbackPort, raw).toBe(port);
    }
  });

  it('refuses a port this process owns (the dashboard, phone listener, CDP, whisper): owned-port', () => {
    for (const raw of ['http://127.0.0.1:4173', 'http://localhost:4173/', 'http://localhost:47113', 'http://[::1]:9222/json']) {
      expect(validateSuperWebUrl(raw, OWNED), raw).toEqual({ ok: false, reason: 'owned-port' });
    }
  });

  it('refuses every other name for this machine, http elsewhere, userinfo, other schemes', () => {
    for (const raw of ['http://example.com', 'https://0.0.0.0', 'http://0.0.0.0:5173', 'http://127.1:5173', 'https://127.1.2.3/',
      'https://app.localhost', 'http://app.localhost:5173', 'https://[::ffff:127.0.0.1]/', 'http://[::ffff:127.0.0.1]:5173',
      'https://[::ffff:7f00:1]/', 'http://localhost.:5173', 'https://localhost./', 'https://localhost:4173', 'https://127.0.0.1/', 'https://[::1]/', 'https://u:p@example.com', 'javascript:alert(1)']) {
      expect(validateSuperWebUrl(raw, OWNED).ok, raw).toBe(false);
    }
  });

  it('opens a project-relative file the reader draws, never an absolute one', () => {
    expect(validateSuperWebUrl('mockups/a.png')).toEqual({ ok: true, kind: 'file', href: 'mockups/a.png', host: '' });
    expect(validateSuperWebUrl('./docs/report.pdf')).toMatchObject({ ok: true, kind: 'file', href: 'docs/report.pdf' });
    for (const raw of ['/Users/x/a.html', 'file:///etc/passwd', 'docs/../../x.html', 'docs/run.sh']) expect(validateSuperWebUrl(raw).ok, raw).toBe(false);
  });

  it('never accepts what the window\'s own rule refuses, and agrees on what is local (drift)', () => {
    for (const raw of CASES) {
      const server = validateSuperWebUrl(raw, OWNED);
      if (!server.ok) continue;
      const client = validateWebUrl(raw, OWN);
      expect(client.ok, raw).toBe(true);
      if (!client.ok) continue;
      expect(client.kind, raw).toBe(server.kind);
      if (client.kind === 'url' && server.kind === 'url') expect(client.local, raw).toBe(server.loopbackPort !== undefined);
    }
  });
});
