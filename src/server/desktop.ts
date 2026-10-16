import type { IncomingMessage } from 'node:http';
import { isCloud } from './cloud-mode.js';
import { hasValidDeviceSession } from './handsfree-auth.js';
import { isLoopbackPeer } from './network-auth.js';
import { isPhoneSocket } from './phone-origin.js';

/**
 * Shared desktop-gate for server routes.
 *
 * The desktop Rust shell exports `DREAMCONTEXT_DESKTOP=1`; interactive-shell and
 * privileged local features (agent terminal, file drop, session roster, the
 * brain cloud-sync routes) only exist inside the desktop app and 403 otherwise.
 *
 * `src/server/` is flat (no `lib/` sub-dir), so this lives at the server root.
 * It is DISTINCT from `dashboard/src/lib/desktop.ts`, which detects the desktop
 * shell client-side.
 */
export function isDesktop(): boolean {
  return process.env.DREAMCONTEXT_DESKTOP === '1';
}

/** A server that hosts agents: the desktop app, or the hands-free cloud (`cloud-mode.ts`). */
export function isAgentHost(): boolean {
  return isDesktop() || isCloud();
}

/**
 * May this request drive an agent surface? On the desktop: a loopback peer. In the cloud,
 * where GitHub's forwarder makes EVERY request loopback, only a live device session counts —
 * and the same on a Mac-mode phone socket, where cloudflared does (a MAC device session; the
 * store is picked per request by `authFor`).
 */
export function isAgentRequest(req: IncomingMessage): boolean {
  if (isPhoneSocket(req)) return hasValidDeviceSession(req);
  return isCloud() ? hasValidDeviceSession(req) : isDesktop() && isLoopbackPeer(req);
}
