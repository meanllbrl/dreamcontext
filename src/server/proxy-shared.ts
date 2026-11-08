/**
 * The pieces of a loopback reverse proxy shared by the web card's session proxy
 * (web-session-proxy.ts) and the dreamcontext Apps gateway (apps/gateway.ts): hop-by-hop
 * header stripping, per-session cookie prefixing (cookies on 127.0.0.1 are shared by every
 * port, so each proxy keeps only its own, prefix removed, and prefixes what the upstream sets),
 * Host/Origin/Referer rewriting and Location rewriting.
 */

import type { IncomingHttpHeaders } from 'node:http';
import type { WebSessionCookie } from '../lib/super/web-session-store.js';

export const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

/** Only this session's cookies, their prefix removed (null: none). */
export function ownCookies(header: string | undefined, prefix: string): string | null {
  if (!header) return null;
  const mine = header.split(/;\s*/).filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length)).filter((p) => /^[^=]+=/.test(p));
  return mine.length ? mine.join('; ') : null;
}

/** Request headers as the upstream must see them. */
export function upstreamHeaders(
  headers: IncomingHttpHeaders, proxyOrigin: string, upstreamHost: string, upstreamPort: number, opts: { identity: boolean; prefix: string },
): Record<string, string | string[]> {
  const upstreamOrigin = `http://${upstreamHost}:${upstreamPort}`;
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined || HOP.has(k) || k === 'cookie') continue;
    out[k] = v;
  }
  out.host = `${upstreamHost}:${upstreamPort}`;
  const cookie = ownCookies(headers.cookie, opts.prefix);
  if (cookie) out.cookie = cookie;
  if (headers.origin === proxyOrigin) out.origin = upstreamOrigin;
  const ref = headers.referer;
  if (typeof ref === 'string' && (ref === proxyOrigin || ref.startsWith(`${proxyOrigin}/`))) out.referer = upstreamOrigin + ref.slice(proxyOrigin.length);
  if (opts.identity) out['accept-encoding'] = 'identity';
  return out;
}

/** A Location pointing at the upstream (any loopback spelling, same port) comes back here. */
export function rewriteLocation(location: string, proxyOrigin: string, upstreamPort: number): string {
  const m = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]):(\d+)(\/.*)?$/i.exec(location.trim());
  if (!m || Number(m[2]) !== upstreamPort) return location;
  return proxyOrigin + (m[3] ?? '/');
}

/** A Set-Cookie with its name prefixed and without Domain, and the cookie's own name and path. */
export function rewriteSetCookie(line: string, requestPath: string, prefix: string): { line: string; cookie: WebSessionCookie | null } {
  const parts = line.split(';');
  const kept = parts.filter((p, i) => i === 0 || !/^\s*domain\s*=/i.test(p));
  const nameMatch = /^\s*([^=;\s]+)\s*=/.exec(parts[0] ?? '');
  const pathAttr = parts.slice(1).map((p) => /^\s*path\s*=\s*(.*)$/i.exec(p)).find(Boolean);
  let path = pathAttr ? pathAttr[1].trim() : '';
  if (!path.startsWith('/')) {
    const i = requestPath.lastIndexOf('/');
    path = i > 0 ? requestPath.slice(0, i) : '/';
  }
  kept[0] = prefix + (kept[0] ?? '').replace(/^\s+/, '');
  return { line: kept.join(';'), cookie: nameMatch ? { name: nameMatch[1], path } : null };
}
