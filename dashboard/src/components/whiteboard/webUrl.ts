/**
 * The web widget's URL rule (D7), checked at render time as well as at write time: a board can
 * arrive from a shared repo, so the server's check is not the only one that counts.
 *
 *   - `https:` only;
 *   - no userinfo (`https://user:pass@host` is a classic look-alike trick);
 *   - an origin different from the dashboard's own, so a tailnet https host can never iframe
 *     the dashboard itself.
 *
 * Also the per-machine trusted-host list (`dc.whiteboard.trustedHosts`) and a punycode decoder,
 * so the Load prompt can show a look-alike domain in both spellings.
 *
 * No React, no CSS: root vitest imports this file.
 */

export type WebUrlCheck =
  | { ok: true; href: string; host: string; unicodeHost: string }
  | { ok: false; reason: 'empty' | 'invalid' | 'not-https' | 'userinfo' | 'own-origin' };

export function validateWebUrl(raw: unknown, ownOrigin: string | null): WebUrlCheck {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: 'empty' };
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return { ok: false, reason: 'invalid' }; }
  if (u.protocol !== 'https:') return { ok: false, reason: 'not-https' };
  if (u.username || u.password) return { ok: false, reason: 'userinfo' };
  if (ownOrigin && u.origin === ownOrigin) return { ok: false, reason: 'own-origin' };
  return { ok: true, href: u.href, host: u.hostname, unicodeHost: hostnameToUnicode(u.hostname) };
}

export const WEB_URL_REASON_TEXT: Record<Exclude<WebUrlCheck, { ok: true }>['reason'], string> = {
  empty: 'Enter a web address.',
  invalid: 'That is not a web address.',
  'not-https': 'Only https:// addresses can be embedded.',
  userinfo: 'An address with a username or password cannot be embedded.',
  'own-origin': 'A board cannot embed this dashboard itself.',
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
