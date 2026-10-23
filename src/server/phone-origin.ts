import type { IncomingMessage } from 'node:http';
import { dirname } from 'node:path';
import { isTailnetAddress } from './remote-access.js';
import { listVaults } from '../lib/vaults.js';
import { registeredOwnerCandidates, resetOwnerCandidates, transcriptOwnerCheck } from '../lib/transcript-locate.js';
import { resetPhoneMediaRoots } from '../lib/handsfree/mac/phone-media-roots.js';

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

export type RequestSurface = 'desktop' | 'tailnet' | 'mac-phone';

/** Which surface one request belongs to. */
export function requestSurface(req: IncomingMessage): RequestSurface {
  if (isPhoneSocket(req)) return 'mac-phone';
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

// ─── The exposed projects (chosen at start) ─────────────────────────────────

let exposedVaults: readonly string[] = [];
let exposedEpoch = 0;

/** Set per start (Mac session): the registered names of the projects the owner chose. The phone
 *  sees and reaches only these; an empty list (Mac mode off) exposes nothing. */
export function setMacExposedVaults(names: readonly string[]): void {
  exposedVaults = Object.freeze([...new Set(names)]);
  // A start re-reads every project's worktrees (one may have been added since the last run).
  resetOwnerCandidates();
  resetPhoneMediaRoots();
  // Every start and stop is a new epoch: the phone's one-tap file grants of the last run end here
  // (phone-file-grants.ts reads it).
  exposedEpoch++;
}

/** Bumped by every Mac-mode start and stop. */
export function macExposedEpoch(): number {
  return exposedEpoch;
}

export function macExposedVaults(): readonly string[] {
  return exposedVaults;
}

export function isMacExposed(name: string | null | undefined): boolean {
  return !!name && exposedVaults.includes(name);
}

/**
 * AC16's id guard: true when a PHONE request must not see the transcript at `path`, because the
 * conversation belongs to a project the owner did not choose (or its owner cannot be proven).
 * `contextRoot`: the gate's root for this request; null (a vault-agnostic route with several
 * projects chosen) = any chosen project. `none` (no transcript yet) is never refused here: the
 * caller's own rules decide a new tab or an unflushed live chat. The laptop is never refused.
 */
export function phoneTranscriptRefused(req: Pick<IncomingMessage, 'socket'>, contextRoot: string | null, path: string | null): boolean {
  if (!isPhoneSocket(req)) return false;
  const roots = contextRoot
    ? [dirname(contextRoot)]
    : listVaults().filter((v) => exposedVaults.includes(v.name)).map((v) => v.path);
  return transcriptOwnerCheck(path, roots, registeredOwnerCandidates()) === 'other';
}

// ─── Cloudflare's own headers (the main listener's backstop) ────────────────

/** Headers only a Cloudflare edge adds. A request carrying one came through a tunnel. */
export const CLOUDFLARE_HEADERS: readonly string[] = ['cf-ray', 'cf-connecting-ip', 'cf-warp-tag-id'];

/** True when the request carries any Cloudflare edge header. */
export function carriesCloudflareHeaders(req: Pick<IncomingMessage, 'headers'>): boolean {
  return CLOUDFLARE_HEADERS.some((h) => req.headers[h] !== undefined);
}
