/**
 * The web widget's target rule (D7), checked at render time as well as at write time: a board
 * can arrive from a shared repo, so the server's check is not the only one that counts. The
 * rule is MIRRORED in `src/lib/whiteboards/validate.ts` (`classifyWebTarget`); a drift test
 * runs the same cases through both.
 *
 * A target is one of (owner, 2026-10-06: "yerel dosya açamıyor"):
 *   - an `https:` page;
 *   - an `http:` page on this machine (`localhost`, `127.0.0.1`, `[::1]`, any port), a dev
 *     server; `localhost:5173` without a scheme means `http://localhost:5173`;
 *   - a FILE the board's reader can draw (.html, .pdf, a picture): project-relative, or an
 *     absolute path (`/…` or `file:///…`). Files are read through the project file route,
 *     which is desktop-only and asks the owner before it serves anything outside the project.
 * Never userinfo (`https://user:pass@host` is a classic look-alike trick), never the
 * dashboard's own origin (a loopback URL on the dashboard's own port is the dashboard too),
 * never a `..` step in a path.
 *
 * Also the per-machine trusted-host list (`dc.whiteboard.trustedHosts`) and a punycode decoder,
 * so the Load prompt can show a look-alike domain in both spellings.
 *
 * No React, no CSS: root vitest imports this file.
 */

export type WebUrlReason = 'empty' | 'invalid' | 'not-https' | 'userinfo' | 'own-origin' | 'file-type' | 'file-path';

export type WebUrlCheck =
  /** A page. `host` is what trust is recorded under: the hostname, or host:port on this machine. */
  | { ok: true; kind: 'url'; href: string; host: string; unicodeHost: string; local: boolean }
  /** A file: `path` project-relative, or absolute when `absolute`. */
  | { ok: true; kind: 'file'; path: string; absolute: boolean; name: string }
  | { ok: false; reason: WebUrlReason };

/** The files a web block can show: what the board's reader draws in a card. */
export const WEB_FILE_EXTENSIONS: readonly string[] = ['.html', '.htm', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'];

const MAX_WEB_PATH = 1024;
const LOOPBACK_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '[::1]'];
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const BARE_LOOPBACK_RE = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i;

function isLoopback(hostname: string): boolean {
  return LOOPBACK_HOSTS.includes(hostname.toLowerCase());
}

/** A loopback page on the dashboard's own port is the dashboard, whatever the spelling. */
function isOwnOrigin(u: URL, ownOrigin: string | null): boolean {
  if (!ownOrigin) return false;
  if (u.origin === ownOrigin) return true;
  let own: URL;
  try { own = new URL(ownOrigin); } catch { return false; }
  const port = (x: URL) => x.port || (x.protocol === 'https:' ? '443' : '80');
  return isLoopback(own.hostname) && isLoopback(u.hostname) && port(own) === port(u);
}

function fileTarget(path: string, absolute: boolean): WebUrlCheck {
  if (path.length > MAX_WEB_PATH || /[\u0000-\u001f\\]/.test(path)) return { ok: false, reason: 'file-path' };
  const segments = (absolute ? path.slice(1) : path).split('/');
  if (segments.some((seg) => seg === '..' || seg === '')) return { ok: false, reason: 'file-path' };
  const name = segments[segments.length - 1];
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { ok: false, reason: 'invalid' };
  if (!WEB_FILE_EXTENSIONS.includes(name.slice(dot).toLowerCase())) return { ok: false, reason: 'file-type' };
  return { ok: true, kind: 'file', path, absolute, name };
}

export function validateWebUrl(raw: unknown, ownOrigin: string | null): WebUrlCheck {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: 'empty' };
  let text = raw.trim();
  if (BARE_LOOPBACK_RE.test(text)) text = `http://${text}`;
  if (!SCHEME_RE.test(text)) {
    const rel = text.replace(/^(\.\/)+/, '');
    return fileTarget(rel, rel.startsWith('/'));
  }
  let u: URL;
  try { u = new URL(text); } catch { return { ok: false, reason: 'invalid' }; }
  if (u.protocol === 'file:') {
    if (u.host && !isLoopback(u.hostname)) return { ok: false, reason: 'file-path' };
    let path: string;
    try { path = decodeURIComponent(u.pathname); } catch { return { ok: false, reason: 'invalid' }; }
    return fileTarget(path, true);
  }
  const local = u.protocol === 'http:' && isLoopback(u.hostname);
  if (u.protocol !== 'https:' && !local) return { ok: false, reason: 'not-https' };
  if (u.username || u.password) return { ok: false, reason: 'userinfo' };
  if (isOwnOrigin(u, ownOrigin)) return { ok: false, reason: 'own-origin' };
  const host = local ? u.host.toLowerCase() : u.hostname;
  return { ok: true, kind: 'url', href: u.href, host, unicodeHost: local ? host : hostnameToUnicode(u.hostname), local };
}

export const WEB_URL_REASON_TEXT: Record<WebUrlReason, string> = {
  empty: 'Enter a web address or a file path.',
  invalid: 'That is not a web address or a file path.',
  'not-https': 'Only https:// pages, pages on this computer (localhost) and files can be shown.',
  userinfo: 'An address with a username or password cannot be embedded.',
  'own-origin': 'A board cannot embed this dashboard itself.',
  'file-type': 'Only .html, .pdf and picture files can be shown.',
  'file-path': 'That file path cannot be used (no ".." steps, no backslashes).',
};

// ── punycode (RFC 3492 decode only) ───────────────────────────────────────────────────────────

const BASE = 36, TMIN = 1, TMAX = 26, SKEW = 38, DAMP = 700, INITIAL_BIAS = 72, INITIAL_N = 128;

function adapt(delta: number, numPoints: number, first: boolean): number {
  let d = first ? Math.floor(delta / DAMP) : delta >> 1;
  d += Math.floor(d / numPoints);
  let k = 0;
  while (d > ((BASE - TMIN) * TMAX) >> 1) { d = Math.floor(d / (BASE - TMIN)); k += BASE; }
  return k + Math.floor(((BASE - TMIN + 1) * d) / (d + SKEW));
}

function digitOf(cp: number): number {
  if (cp >= 48 && cp <= 57) return cp - 22; // 0-9 → 26-35
  if (cp >= 65 && cp <= 90) return cp - 65; // A-Z
  if (cp >= 97 && cp <= 122) return cp - 97; // a-z
  return BASE;
}

/** Decode one punycode label body (without `xn--`), or null when it is malformed. */
export function decodePunycode(input: string): string | null {
  const out: number[] = [];
  const lastDash = input.lastIndexOf('-');
  const basicEnd = lastDash < 0 ? 0 : lastDash;
  for (let j = 0; j < basicEnd; j++) {
    const cp = input.charCodeAt(j);
    if (cp >= 0x80) return null;
    out.push(cp);
  }
  let n = INITIAL_N, bias = INITIAL_BIAS, i = 0;
  for (let idx = basicEnd > 0 ? basicEnd + 1 : 0; idx < input.length;) {
    const oldi = i;
    for (let w = 1, k = BASE; ; k += BASE) {
      if (idx >= input.length) return null;
      const digit = digitOf(input.charCodeAt(idx++));
      if (digit >= BASE) return null;
      i += digit * w;
      const t = k <= bias ? TMIN : k >= bias + TMAX ? TMAX : k - bias;
      if (digit < t) break;
      w *= BASE - t;
      if (w > 0x7fffffff) return null;
    }
    bias = adapt(i - oldi, out.length + 1, oldi === 0);
    n += Math.floor(i / (out.length + 1));
    i %= out.length + 1;
    if (n > 0x10ffff) return null;
    out.splice(i++, 0, n);
  }
  return String.fromCodePoint(...out);
}

/** `xn--` labels decoded for display; an undecodable label is shown as written. */
export function hostnameToUnicode(host: string): string {
  return host
    .split('.')
    .map((label) => {
      if (!label.toLowerCase().startsWith('xn--')) return label;
      return decodePunycode(label.slice(4)) ?? label;
    })
    .join('.');
}

// ── trusted hosts (per machine) ───────────────────────────────────────────────────────────────

export const TRUSTED_HOSTS_KEY = 'dc.whiteboard.trustedHosts';

interface HostStore { getItem(k: string): string | null; setItem(k: string, v: string): void }

function defaultStore(): HostStore | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

export function readTrustedHosts(store: HostStore | null = defaultStore()): string[] {
  if (!store) return [];
  try {
    const parsed = JSON.parse(store.getItem(TRUSTED_HOSTS_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((h): h is string => typeof h === 'string') : [];
  } catch {
    return [];
  }
}

/** Hosts are stored in their ASCII (punycode) spelling, the one `URL.hostname` returns. */
export function isTrustedHost(host: string, store: HostStore | null = defaultStore()): boolean {
  return readTrustedHosts(store).includes(host.toLowerCase());
}

export function trustHost(host: string, store: HostStore | null = defaultStore()): void {
  if (!store) return;
  const hosts = new Set(readTrustedHosts(store));
  hosts.add(host.toLowerCase());
  try { store.setItem(TRUSTED_HOSTS_KEY, JSON.stringify([...hosts])); } catch { /* quota / private mode */ }
}
