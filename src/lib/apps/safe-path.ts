/**
 * The one door every app-relative path goes through (dreamcontext-apps plan r19, "Aksiyon"):
 * manifest actions, schedules, `POST /api/apps/:slug/call`, `dc.notify` paths and app-link
 * nonces.
 *
 * - The PATHNAME is percent-decoded to a fixed point (the query never is); a malformed `%`
 *   is refused. Fixed-point decoding changes meaning (`/x%3fa=1`, `/a%2fb`; a literal `%25`
 *   decodes to a bare `%` and is refused) on purpose, toward the safe side.
 * - Every check runs on the decoded form: one leading slash, never `//`, no control
 *   characters, no backslash, same origin as the base, not under `/__dc` once normalized.
 * - The final parse is `new URL(decoded + rawQuery, base)`, and a pathname that normalized to
 *   `//…` (`/.//evil.com`) is refused: in a `Location` header it would be protocol-relative.
 * - Only that parse's `pathname + search` leaves; never the raw or decoded string.
 */

const BASE = 'http://127.0.0.1';
const MAX_DECODE_ROUNDS = 6;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export type SafePath = { ok: true; path: string } | { ok: false; reason: string };

export function safeAppPath(raw: unknown): SafePath {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return { ok: false, reason: 'path must be a string of 1-2048 characters' };
  if (raw.includes('#')) return { ok: false, reason: 'path must not carry a fragment' };
  const q = raw.indexOf('?');
  let path = q >= 0 ? raw.slice(0, q) : raw;
  const rawQuery = q >= 0 ? raw.slice(q + 1) : '';
  if (CONTROL.test(rawQuery)) return { ok: false, reason: 'control characters in the query' };

  for (let round = 0; ; round++) {
    if (!path.includes('%')) break;
    if (/%(?![0-9a-fA-F]{2})/.test(path)) return { ok: false, reason: 'malformed or literal % in the path' };
    let next: string;
    try {
      next = decodeURIComponent(path);
    } catch {
      return { ok: false, reason: 'malformed percent-encoding in the path' };
    }
    if (next === path) break;
    path = next;
    if (round >= MAX_DECODE_ROUNDS) return { ok: false, reason: 'path is encoded too many times' };
  }

  if (!path.startsWith('/')) return { ok: false, reason: 'path must start with /' };
  if (path.startsWith('//')) return { ok: false, reason: 'path must not start with //' };
  if (CONTROL.test(path)) return { ok: false, reason: 'control characters in the path' };
  if (path.includes('\\')) return { ok: false, reason: 'backslash in the path' };

  let url: URL;
  try {
    url = new URL(path + (q >= 0 ? `?${rawQuery}` : ''), BASE);
  } catch {
    return { ok: false, reason: 'path does not parse' };
  }
  if (url.origin !== BASE) return { ok: false, reason: 'path leaves the app' };
  if (url.pathname.startsWith('//')) return { ok: false, reason: 'path normalizes to //' };
  if (url.pathname === '/__dc' || url.pathname.startsWith('/__dc/')) return { ok: false, reason: 'path is reserved (/__dc)' };
  return { ok: true, path: url.pathname + url.search };
}
