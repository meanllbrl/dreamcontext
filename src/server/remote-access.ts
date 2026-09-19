import type { IncomingMessage } from 'node:http';
import { hasValidNetworkToken } from './network-auth.js';

/**
 * Remote access — the ONE opt-in that lets a device other than this machine reach the
 * `claude`-spawning surfaces (today: Agent Chat).
 *
 * Everything in `src/server/routes/agent-*.ts` is gated on `isLoopback()` because the
 * dashboard API is unauthenticated by design: binding to 127.0.0.1 IS the authentication.
 * A phone is not loopback, so the chat WebSocket upgrade answers it 403 — correctly, until
 * the operator says otherwise. This module is that "otherwise", and it deliberately asks
 * for THREE independent facts before it trusts a peer:
 *
 *  1. **The operator opted in** — `DREAMCONTEXT_REMOTE=1` in the server's own environment.
 *     Absent it, nothing here can ever return true, so the default posture is byte-identical
 *     to before this module existed.
 *  2. **The peer is on the tailnet** — its address is in Tailscale's CGNAT range
 *     (100.64.0.0/10) or its IPv6 ULA prefix (fd7a:115c:a1e0::/48). A tailnet address cannot
 *     be reached from the public internet or from the café wifi: it only exists between
 *     devices the operator has signed into their own tailnet. This is the network half of
 *     the gate, and it is why a Cloudflare/ngrok tunnel does NOT satisfy it — a tunnel
 *     terminates at loopback or at a public edge, and neither shape is a tailnet peer, so
 *     opening a tunnel cannot accidentally open the agent surface.
 *  3. **The peer holds the network token** — the per-process credential `network-auth.ts`
 *     already mints for every non-loopback bind, presented as the `dreamcontext_token`
 *     cookie the first tokenized visit sets. A browser sends that cookie on a same-origin
 *     WebSocket handshake, so the upgrade can check it exactly like an HTTP route does.
 *
 * All three, or nothing. Two of them are not "almost trusted": each one alone has a
 * plausible failure (a stale env var, a spoofable source address on a hostile LAN, a token
 * pasted into the wrong chat), and the point of the conjunction is that no single mistake
 * is sufficient.
 *
 * SCOPE — this widens the CHAT upgrade and nothing else. The PTY terminal
 * (`agent-terminal.ts`) stays loopback-only: xterm on a phone is not a surface anybody
 * wants, so it buys no capability and would double the blast radius for free.
 */

/** True when the operator opted this server process into remote access. */
export function remoteAccessEnabled(): boolean {
  return process.env.DREAMCONTEXT_REMOTE === '1';
}

/**
 * True for an address inside Tailscale's own ranges — IPv4 CGNAT `100.64.0.0/10` (what
 * `tailscale ip -4` hands out) or the IPv6 ULA prefix `fd7a:115c:a1e0::/48`. v4-mapped-v6
 * (`::ffff:100.x.y.z`) is unwrapped first: Node reports exactly that shape for an IPv4 peer
 * on a dual-stack listener, and reading it as "not IPv4" would refuse every real phone.
 *
 * Necessary, never sufficient — see the token check in {@link isTrustedRemotePeer}. Nothing
 * stops a host on a hostile LAN from choosing a 100.x source address; what stops it from
 * being useful is that it still has to present the token.
 */
export function isTailnetAddress(remote: string | undefined | null): boolean {
  if (!remote) return false;
  const addr = remote.startsWith('::ffff:') ? remote.slice(7) : remote;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    if (octets.some((o) => o > 255)) return false;
    // 100.64.0.0/10 — the second octet's top two bits are the mask.
    return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
  }
  return addr.toLowerCase().startsWith('fd7a:115c:a1e0:');
}

/**
 * True when the request's `Origin` is the very host it was sent TO.
 *
 * This is the precise definition of "not a cross-site request", and it is what the CSRF
 * guard needs once the dashboard answers on a name other than localhost. `LOCAL_ORIGIN_RE`
 * in `middleware.ts` hardcodes the loopback spellings, so from a phone every write carried
 * `Origin: http://100.x.y.z:4173` and was refused as cross-site — the request was same-origin
 * the whole time, the pattern just had no way to say so. Comparing against `Host` says it:
 * a drive-by page at evil.com still sends `Origin: https://evil.com`, which is not the host,
 * and stays blocked.
 */
export function isSameOriginAsHost(req: Pick<IncomingMessage, 'headers'>): boolean {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!origin || !host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * The gate itself: opted in AND on the tailnet AND holding the network token.
 *
 * `token` is the server's per-process network token, or null when the server is bound to
 * loopback (where no token is minted and no remote peer can arrive anyway). A null token
 * refuses — there is no credential to check, and "no credential required" is never the
 * answer for a non-loopback peer.
 */
export function isTrustedRemotePeer(req: IncomingMessage, token: string | null): boolean {
  if (!remoteAccessEnabled()) return false;
  if (!token) return false;
  if (!isTailnetAddress(req.socket?.remoteAddress)) return false;
  return hasValidNetworkToken(req, token);
}
