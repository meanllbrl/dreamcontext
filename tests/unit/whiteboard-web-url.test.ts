/**
 * The web widget's URL rule (D7): https only, no userinfo, never the dashboard's own origin.
 * Plus the Unicode/punycode pair the Load prompt shows, and the per-machine trusted-host list.
 */
import { describe, it, expect } from 'vitest';
import {
  validateWebUrl, hostnameToUnicode, decodePunycode, isTrustedHost, trustHost, readTrustedHosts, TRUSTED_HOSTS_KEY,
} from '../../dashboard/src/components/whiteboard/webUrl.js';

const OWN = 'https://box.tailnet-1234.ts.net';

describe('validateWebUrl', () => {
  it('accepts a plain https URL and reports its host', () => {
    const r = validateWebUrl('https://example.com/dash?x=1', OWN);
    expect(r).toEqual({ ok: true, href: 'https://example.com/dash?x=1', host: 'example.com', unicodeHost: 'example.com' });
  });

  it('refuses anything but https', () => {
    for (const url of ['http://example.com', 'javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'ftp://example.com']) {
      const r = validateWebUrl(url, OWN);
      expect(r.ok, url).toBe(false);
    }
    expect(validateWebUrl('http://example.com', OWN)).toEqual({ ok: false, reason: 'not-https' });
  });

  it('refuses userinfo', () => {
    expect(validateWebUrl('https://user@example.com/', OWN)).toEqual({ ok: false, reason: 'userinfo' });
    expect(validateWebUrl('https://user:pass@example.com/', OWN)).toEqual({ ok: false, reason: 'userinfo' });
    expect(validateWebUrl('https://example.com@evil.test/', OWN)).toEqual({ ok: false, reason: 'userinfo' });
  });

  it('refuses the dashboard\'s own origin', () => {
    expect(validateWebUrl(`${OWN}/api/whiteboards`, OWN)).toEqual({ ok: false, reason: 'own-origin' });
    expect(validateWebUrl('https://BOX.tailnet-1234.ts.net:443/', OWN)).toEqual({ ok: false, reason: 'own-origin' });
    // Another port is another origin.
    expect(validateWebUrl('https://box.tailnet-1234.ts.net:8443/', OWN).ok).toBe(true);
  });

  it('refuses empty and unparseable input', () => {
    expect(validateWebUrl('', OWN)).toEqual({ ok: false, reason: 'empty' });
    expect(validateWebUrl(undefined, OWN)).toEqual({ ok: false, reason: 'empty' });
    expect(validateWebUrl('not a url', OWN)).toEqual({ ok: false, reason: 'invalid' });
    expect(validateWebUrl('/relative', OWN)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('shows a look-alike domain in both spellings', () => {
    // Cyrillic "а" in place of Latin "a".
    const r = validateWebUrl('https://аpple.com/', OWN);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.host).toBe('xn--pple-43d.com');
    expect(r.unicodeHost).toBe('аpple.com');
    expect(r.unicodeHost).not.toBe(r.host);
  });
});

describe('punycode', () => {
  it('decodes known labels', () => {
    expect(decodePunycode('mnchen-3ya')).toBe('münchen');
    expect(decodePunycode('bcher-kva')).toBe('bücher');
    expect(hostnameToUnicode('xn--mnchen-3ya.de')).toBe('münchen.de');
    expect(hostnameToUnicode('example.com')).toBe('example.com');
  });

  it('leaves an undecodable label as written', () => {
    expect(hostnameToUnicode('xn--!!!.com')).toBe('xn--!!!.com');
  });
});

describe('trusted hosts', () => {
  function memStore() {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, m };
  }

  it('stores lower-cased ASCII hosts under dc.whiteboard.trustedHosts', () => {
    const s = memStore();
    expect(isTrustedHost('example.com', s)).toBe(false);
    trustHost('Example.com', s);
    expect(isTrustedHost('example.com', s)).toBe(true);
    expect(JSON.parse(s.m.get(TRUSTED_HOSTS_KEY)!)).toEqual(['example.com']);
    expect(TRUSTED_HOSTS_KEY).toBe('dc.whiteboard.trustedHosts');
  });

  it('survives a corrupt stored value', () => {
    const s = memStore();
    s.setItem(TRUSTED_HOSTS_KEY, '{not json');
    expect(readTrustedHosts(s)).toEqual([]);
    s.setItem(TRUSTED_HOSTS_KEY, JSON.stringify(['a.com', 42]));
    expect(readTrustedHosts(s)).toEqual(['a.com']);
  });
});
