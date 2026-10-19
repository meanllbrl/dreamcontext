/**
 * A Super Agent `web` container shows an https page on another host (plan-r7 D10). The rule is
 * the whiteboard web widget's (`validateWebUrl`) NARROWED: whatever the server accepts, the
 * window's own rule accepts as a non-local page — the drift test runs both over the same cases.
 */
import { describe, it, expect } from 'vitest';
import { validateSuperWebUrl } from '../../src/lib/super/web-url.js';
import { validateWebUrl } from '../../dashboard/src/components/whiteboard/webUrl.js';

const OWN = 'http://127.0.0.1:4173';
const CASES = [
  'https://example.com', 'https://example.com/a?b=c#d', 'https://sub.example.co.uk:8443/x', 'https://xn--bcher-kva.example/',
  'http://example.com', 'https://localhost', 'https://localhost:4173/', 'http://127.0.0.1:4173', 'https://127.0.0.1/',
  'https://127.1.2.3/', 'https://[::1]/', 'https://0.0.0.0/', 'https://app.localhost/', 'https://user:pw@example.com',
  'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'example.com', 'docs/page.html', '', '   ',
  'https://exa mple.com', 'https://example.com\\@evil.test',
];

describe('validateSuperWebUrl', () => {
  it('accepts an https page on another host', () => {
    expect(validateSuperWebUrl('https://example.com/a')).toEqual({ ok: true, href: 'https://example.com/a', host: 'example.com' });
  });

  it('refuses http, this machine, userinfo, files and other schemes', () => {
    for (const raw of ['http://example.com', 'https://localhost:4173', 'https://127.0.0.1', 'https://[::1]', 'https://0.0.0.0',
      'https://app.localhost', 'https://[::ffff:127.0.0.1]/', 'https://[::ffff:7f00:1]/', 'https://u:p@example.com', 'file:///etc/passwd', 'javascript:alert(1)', 'docs/x.html']) {
      expect(validateSuperWebUrl(raw).ok, raw).toBe(false);
    }
  });

  it('never accepts what the window\'s own rule would refuse or treat as local (drift)', () => {
    for (const raw of CASES) {
      const server = validateSuperWebUrl(raw);
      if (!server.ok) continue;
      const client = validateWebUrl(raw, OWN);
      expect(client.ok, raw).toBe(true);
      if (client.ok) {
        expect(client.kind, raw).toBe('url');
        if (client.kind === 'url') expect(client.local, raw).toBe(false);
      }
    }
  });
});
