import type { IncomingMessage } from 'node:http';
import { isCloud } from './cloud-mode.js';
import { isTailnetAddress } from './remote-access.js';

/**
 * Per-request ORIGIN: which listener a request arrived on.
 *
 * Mac mode runs a second listener in this process (the phone listener, 127.0.0.1) and a
 * Cloudflare tunnel connects to it from 127.0.0.1. Peer-address trust ("loopback = this
 * machine") would therefore let the whole internet in. The phone listener marks every socket
 * it accepts here, in its `connection` event, before any request on it is read; every trust
 * check asks THIS module first: a phone socket is never loopback, and on it only a Mac device
 * session counts.
 *
 * One chokepoint on purpose: `isLoopback` (agent-spawn-shared.ts), `isLoopbackPeer`
 * (network-auth.ts) and `isAgentRequest` (desktop.ts) all route through {@link isPhoneSocket}.
 */

const phoneSockets = new WeakSet<object>();

/** The phone listener's `connection` handler: every socket it accepts is a phone socket. */
export function markPhoneSocket(socket: object): void {
  phoneSockets.add(socket);
}

/** True when the request (or WS upgrade) arrived on the phone listener. */
export function isPhoneSocket(req: { socket?: object | null } | null | undefined): boolean {
  const s = req?.socket;
  return !!s && phoneSockets.has(s);
}

/** The PHONE surface (trust meaning): the hands-free cloud, or a Mac-mode phone socket. */
export function isPhoneRequest(req: { socket?: object | null } | null | undefined): boolean {
  return isCloud() || isPhoneSocket(req);
}

export type RequestSurface = 'desktop' | 'tailnet' | 'mac-phone' | 'cloud';

/** Which surface one request belongs to. */
export function requestSurface(req: IncomingMessage): RequestSurface {
  if (isPhoneSocket(req)) return 'mac-phone';
  if (isCloud()) return 'cloud';
  if (isTailnetAddress(req.socket?.remoteAddress)) return 'tailnet';
  return 'desktop';
}

// ─── The tunnel's public origin (set once the URL is known) ─────────────────

let publicOrigin: string | null = null;

/** Set by the Mac session once the tunnel URL is known; null again at Return. Until it is set
 *  every phone write and every phone WS upgrade is refused. */
export function setMacPublicOrigin(origin: string | null): void {
  publicOrigin = origin ? origin.replace(/\/+$/, '') : null;
}

export function macPublicOrigin(): string | null {
  return publicOrigin;
}

/** A phone write or upgrade carries exactly the tunnel's public origin; a missing Origin is
 *  refused too (every browser write sends one). */
export function isMacOriginAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  return publicOrigin !== null && typeof origin === 'string' && origin === publicOrigin;
}

// ─── The reachability probe's per-start value ───────────────────────────────

let probeNonce: string | null = null;

/** Set per start (Mac session). Public by design: proves routing, never authenticates. */
export function setMacProbeNonce(nonce: string | null): void {
  probeNonce = nonce;
}

export function macProbeNonce(): string | null {
  return probeNonce;
}

// ─── Cloudflare's own headers (the main listener's backstop) ────────────────

/** Headers only a Cloudflare edge adds. A request carrying one came through a tunnel. */
export const CLOUDFLARE_HEADERS: readonly string[] = ['cf-ray', 'cf-connecting-ip', 'cf-warp-tag-id'];

/** True when the request carries any Cloudflare edge header. */
export function carriesCloudflareHeaders(req: Pick<IncomingMessage, 'headers'>): boolean {
  return CLOUDFLARE_HEADERS.some((h) => req.headers[h] !== undefined);
}
