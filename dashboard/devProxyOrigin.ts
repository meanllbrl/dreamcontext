/**
 * The Vite dev proxy's Origin rule (jarvis plan r9, T3). The server is port-strict about Origin on
 * loopback, and the proxy sends `Host: <target>` with the dev page's `Origin: localhost:5173`. So
 * the proxy rewrites the Origin to the target's own, but ONLY for the dev page itself: any other
 * Origin (another port, another site, `null`) passes through untouched and the server refuses it.
 * Rewriting every Origin would forge the very fact the gate checks.
 */
export function rewrittenOrigin(origin: string | undefined, devHost: string | undefined, target: string): string | null {
  if (!origin || !devHost) return null;
  return origin.toLowerCase() === `http://${devHost}`.toLowerCase() ? target : null;
}
