/**
 * The embed token (`tk`, plan r19 W4): one per running app, bound to its gateway port. It is the
 * ONE thing that lets a dreamcontext screen be drawn inside another origin, so everything about
 * it is narrow: it names one app, one vault and one parent origin, it dies with the gateway, and
 * the frame exception (`embedFrameGrant`) needs a document navigation from a same-site iframe on
 * top of it. The token never reaches the app's own backend: the gateway only ever writes it into
 * the redirect it sends the window's own frame.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export interface EmbedGrant {
  tk: string;
  slug: string;
  vault: string;
  projectRoot: string;
  gwPort: number;
}

const grants = new Map<string, EmbedGrant>();

export function mintEmbedToken(g: Omit<EmbedGrant, 'tk'>): string {
  for (const [tk, v] of grants) if (v.gwPort === g.gwPort) return tk;
  const tk = randomBytes(32).toString('base64url');
  grants.set(tk, { ...g, tk });
  return tk;
}

export function dropEmbedToken(gwPort: number): void {
  for (const [tk, v] of grants) if (v.gwPort === gwPort) grants.delete(tk);
}

/** The grant for this token, compared in constant time; null for anything else. */
export function resolveEmbedToken(tk: unknown): EmbedGrant | null {
  if (typeof tk !== 'string' || tk.length !== 43) return null;
  const given = Buffer.from(tk);
  for (const [known, grant] of grants) {
    const k = Buffer.from(known);
    if (k.length === given.length && timingSafeEqual(k, given)) return grant;
  }
  return null;
}

/**
 * The grant a framed document navigation may use, or null. Only a GET of the page, in an iframe,
 * from a same-site parent (another loopback port): a foreign site is cross-site and never gets
 * past this, whatever token it stole.
 */
export function embedFrameGrant(req: Pick<IncomingMessage, 'headers' | 'method' | 'url'>): EmbedGrant | null {
  if ((req.method ?? 'GET').toUpperCase() !== 'GET') return null;
  if (String(req.headers['sec-fetch-dest'] ?? '').toLowerCase() !== 'iframe') return null;
  if (String(req.headers['sec-fetch-site'] ?? '').toLowerCase() !== 'same-site') return null;
  let url: URL;
  try { url = new URL(req.url ?? '/', 'http://local'); } catch { return null; }
  if (url.pathname !== '/' || !url.searchParams.has('embed')) return null;
  const grant = resolveEmbedToken(url.searchParams.get('tk'));
  return grant && url.searchParams.get('vault') === grant.vault ? grant : null;
}
