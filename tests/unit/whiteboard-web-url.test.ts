/**
 * The web widget's URL rule (D7): https only, no userinfo, never the dashboard's own origin.
 * Plus the Unicode/punycode pair the Load prompt shows, and the per-machine trusted-host list.
 */
import { describe, it, expect } from 'vitest';
import { classifyWebTarget, checkWebUrl } from '../../src/lib/whiteboards/validate.js';
import {
  validateWebUrl, hostnameToUnicode, decodePunycode, isTrustedHost, trustHost, readTrustedHosts, TRUSTED_HOSTS_KEY,
} from '../../dashboard/src/components/whiteboard/webUrl.js';

const OWN = 'https://box.tailnet-1234.ts.net';

describe('validateWebUrl', () => {
  it('accepts a plain https URL and reports its host', () => {
    const r = validateWebUrl('https://example.com/dash?x=1', OWN);
    expect(r).toEqual({ ok: true, kind: 'url', href: 'https://example.com/dash?x=1', host: 'example.com', unicodeHost: 'example.com', local: false });
  });

  it('refuses anything but https, a page on this machine or a file', () => {
    for (const url of ['http://example.com', 'javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'ftp://example.com', 'http://localhost.evil.test/', 'http://127.0.0.2/']) {
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

  it('takes a page on this machine, with or without the scheme (W2)', () => {
    expect(validateWebUrl('http://localhost:5173/app', OWN)).toEqual({
      ok: true, kind: 'url', href: 'http://localhost:5173/app', host: 'localhost:5173', unicodeHost: 'localhost:5173', local: true,
    });
    const bare = validateWebUrl('localhost:3000', OWN);
    expect(bare.ok && bare.kind === 'url' && bare.href).toBe('http://localhost:3000/');
    for (const url of ['http://127.0.0.1:8080/', 'http://[::1]:9000/', 'https://localhost:8443/']) {
      expect(validateWebUrl(url, OWN).ok, url).toBe(true);
    }
    expect(validateWebUrl('http://user@localhost:3000/', OWN)).toEqual({ ok: false, reason: 'userinfo' });
  });

  it('a loopback page on the dashboard\'s own port is the dashboard, in any spelling', () => {
    const own = 'http://127.0.0.1:4317';
    for (const url of ['http://127.0.0.1:4317/api/x', 'http://localhost:4317/', 'http://[::1]:4317/', 'localhost:4317']) {
      expect(validateWebUrl(url, own), url).toEqual({ ok: false, reason: 'own-origin' });
    }
    expect(validateWebUrl('http://localhost:4318/', own).ok).toBe(true);
  });

  it('takes a file the reader draws, project-relative or absolute (W2)', () => {
    expect(validateWebUrl('docs/report.html', OWN)).toEqual({ ok: true, kind: 'file', path: 'docs/report.html', absolute: false, name: 'report.html' });
    expect(validateWebUrl('./out/chart.PNG', OWN)).toEqual({ ok: true, kind: 'file', path: 'out/chart.PNG', absolute: false, name: 'chart.PNG' });
    expect(validateWebUrl('/Users/sam/Desktop/plan.pdf', OWN)).toEqual({ ok: true, kind: 'file', path: '/Users/sam/Desktop/plan.pdf', absolute: true, name: 'plan.pdf' });
    expect(validateWebUrl('file:///Users/sam/My%20Docs/a.html', OWN)).toEqual({ ok: true, kind: 'file', path: '/Users/sam/My Docs/a.html', absolute: true, name: 'a.html' });
  });

  it('refuses a file it cannot draw or a path that climbs', () => {
    expect(validateWebUrl('notes/todo.txt', OWN)).toEqual({ ok: false, reason: 'file-type' });
    expect(validateWebUrl('/Users/sam/.ssh/id_rsa', OWN)).toEqual({ ok: false, reason: 'invalid' });
    for (const p of ['../secret.html', 'docs/../../x.html', '/Users/../etc/x.html', 'docs//x.html', 'docs\\x.html', 'file://evil.test/x.html']) {
      expect(validateWebUrl(p, OWN), p).toEqual({ ok: false, reason: 'file-path' });
    }
  });

  it('shows a look-alike domain in both spellings', () => {
    // Cyrillic "а" in place of Latin "a".
    const r = validateWebUrl('https://аpple.com/', OWN);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'url') return;
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

describe('the server mirror (classifyWebTarget) agrees with the dashboard (validateWebUrl)', () => {
  const CASES = [
    'https://example.com/x', 'http://example.com', 'http://localhost:5173/a', 'localhost:3000', '127.0.0.1:8080/x',
    'http://[::1]:9000/', 'https://user@x.test/', 'javascript:alert(1)', 'data:text/html,hi', 'ftp://x.test',
    'docs/report.html', './a/b.pdf', '/Users/sam/x.png', 'file:///Users/sam/a%20b.svg', 'file://evil.test/x.html',
    'notes/todo.txt', '/Users/sam/.ssh/id_rsa', '../x.html', 'a//b.html', 'a\\b.html', '', '   ', 'not a url',
    'http://127.0.0.1:4317/', 'http://localhost:4317/', 'https://box.tailnet-1234.ts.net/api',
  ];
  for (const own of ['http://127.0.0.1:4317', OWN]) {
    it(`same verdict and reason for every case (own origin ${own})`, () => {
      for (const c of CASES) {
        const dash = validateWebUrl(c, own);
        const lib = classifyWebTarget(c, own);
        expect(lib.ok, c).toBe(dash.ok);
        if (!dash.ok && !lib.ok) expect(lib.reason, c).toBe(dash.reason);
        if (dash.ok && lib.ok) {
          expect(lib.kind, c).toBe(dash.kind);
          expect(lib.kind === 'url' ? lib.href : lib.path, c).toBe(dash.kind === 'url' ? dash.href : dash.path);
        }
      }
    });
  }

  it('checkWebUrl returns the normalized target and refuses with a reason', () => {
    expect(checkWebUrl('localhost:3000')).toBe('http://localhost:3000/');
    expect(checkWebUrl('./docs/r.html')).toBe('docs/r.html');
    expect(() => checkWebUrl('http://example.com')).toThrow(/localhost/);
    expect(() => checkWebUrl('../x.html')).toThrow(/\.\./);
    expect(() => checkWebUrl('x.txt')).toThrow(/\.html/);
  });
});
