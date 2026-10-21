import { classifyWebTarget } from '../whiteboards/validate.js';

/**
 * What a Super Agent `web` container may show (jarvis plan r9, K5): the whiteboard web widget's
 * rule (`classifyWebTarget`, mirrored by the window's `validateWebUrl`), so no second URL rule
 * exists. That is an `https:` page, an `http:` page on this machine spelled `localhost`,
 * `127.0.0.1` or `[::1]` (a dev server the owner approves port by port in the card), or a
 * project-relative file the board's reader draws (.html, .pdf, a picture).
 *
 * On top of it, two refusals:
 *  - a port THIS process listens on (`owned-port`): the dashboard, the phone listener, a live
 *    browser mirror's CDP port, whisper-server. The caller passes `ownedLoopbackPorts()` at the
 *    moment of asking; ports change on every launch.
 *  - any other name for this machine (`local`): `0.0.0.0`, `127.1` (the URL parser rewrites it
 *    to 127.0.0.1, so the spelling is checked as written), `*.localhost`, `[::ffff:…]`, a
 *    trailing dot, an `https:` page on this machine (the window's rule would trust it as a remote
 *    host). An absolute file path is refused too (`file-path`): the agent opens files of
 *    its project, never the disk.
 *
 * Loading a loopback page stays the owner's click in the window ("Open once" / "Always allow
 * localhost:PORT"); no verb trusts a port. `tests/unit/super-web-url.test.ts` runs this and the
 * window's rule over the same cases.
 */

export type SuperWebUrl =
  | { ok: true; kind: 'url'; href: string; host: string; loopbackPort?: number }
  | { ok: true; kind: 'file'; href: string; host: '' }
  | { ok: false; reason: string };

const MAX_URL = 2048;
const LOOPBACK_SPELLINGS = ['localhost', '127.0.0.1', '[::1]'];

/** Hostnames that name this machine (or every interface of it). */
function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '[::1]' || h === '[::]' || h === '0.0.0.0') return true;
  if (/^127(\.\d{1,3}){3}$/.test(h)) return true;
  if (/^\[(::ffff:)?(127\.|0:0:0:0:0:0:0:1)/i.test(h)) return true;
  // IPv4-mapped IPv6 (`[::ffff:127.0.0.1]` reads back as `[::ffff:7f00:1]`): refused outright.
  if (h.startsWith('[::ffff:')) return true;
  return false;
}

/** The host as WRITTEN (before the URL parser normalizes it), lowercased, without the port. */
function writtenHost(text: string): string {
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?([^/?#]*)/i.exec(text);
  const authority = (m?.[1] ?? '').toLowerCase();
  if (authority.startsWith('[')) return authority.slice(0, authority.indexOf(']') + 1);
  return authority.replace(/:\d*$/, '');
}

export function validateSuperWebUrl(raw: unknown, ownedPorts: ReadonlySet<number> = new Set()): SuperWebUrl {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: 'empty' };
  const text = raw.trim();
  if (text.length > MAX_URL || /[\u0000-\u001f\u007f\s\\]/.test(text)) return { ok: false, reason: 'invalid' };
  const t = classifyWebTarget(text);
  if (!t.ok) return { ok: false, reason: t.reason };
  if (t.kind === 'file') {
    if (t.absolute) return { ok: false, reason: 'file-path' };
    return { ok: true, kind: 'file', href: t.path, host: '' };
  }
  let u: URL;
  try { u = new URL(t.href); } catch { return { ok: false, reason: 'invalid' }; }
  if (u.username || u.password) return { ok: false, reason: 'userinfo' };
  const host = u.hostname.toLowerCase();
  if (u.protocol === 'http:' && LOOPBACK_SPELLINGS.includes(host)) {
    // Written as one of the three spellings, not a form the parser folded into one (`127.1`).
    if (writtenHost(text) !== host) return { ok: false, reason: 'local' };
    const port = Number(u.port || 80);
    if (ownedPorts.has(port)) return { ok: false, reason: 'owned-port' };
    return { ok: true, kind: 'url', href: u.href, host, loopbackPort: port };
  }
  if (!host || isLocalHost(host)) return { ok: false, reason: 'local' };
  return { ok: true, kind: 'url', href: u.href, host };
}
