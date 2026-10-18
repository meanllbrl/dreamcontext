/**
 * What a Super Agent `web` container may show (plan-r7 D10): an `https:` page on another host.
 *
 * The rules of the whiteboard web widget (`dashboard/src/components/whiteboard/webUrl.ts`
 * `validateWebUrl`), NARROWED: no file targets, no `http:` and nothing on this machine, so the
 * agent cannot point a container at the dashboard itself or a local dev server. Loading a host
 * the owner has not approved stays the owner's click in the window; no verb lets the agent trust
 * a host. `tests/unit/super-web-url.test.ts` runs both rules over the same cases: whatever this
 * accepts, `validateWebUrl` accepts as a non-local page.
 */

export type SuperWebUrl = { ok: true; href: string; host: string } | { ok: false; reason: string };

const MAX_URL = 2048;

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

export function validateSuperWebUrl(raw: unknown): SuperWebUrl {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: 'empty' };
  const text = raw.trim();
  if (text.length > MAX_URL || /[\u0000-\u001f\u007f\s\\]/.test(text)) return { ok: false, reason: 'invalid' };
  let u: URL;
  try { u = new URL(text); } catch { return { ok: false, reason: 'invalid' }; }
  if (u.protocol !== 'https:') return { ok: false, reason: 'not-https' };
  if (u.username || u.password) return { ok: false, reason: 'userinfo' };
  if (!u.hostname || isLocalHost(u.hostname)) return { ok: false, reason: 'local' };
  return { ok: true, href: u.href, host: u.hostname };
}
