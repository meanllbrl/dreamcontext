import type { IncomingMessage } from 'node:http';

/**
 * The dashboard server idles sockets out after 30 s (`server.setTimeout(30000)`). A long-poll,
 * a gated verb waiting on the owner, an app launch waiting on its backend or an app action
 * that runs for minutes legitimately stay silent longer, so those routes lift the timeout on
 * THEIR socket only. (Shared by routes/assistant.ts and routes/apps.ts.)
 */
export function holdOpen(req: IncomingMessage): void {
  try { req.socket?.setTimeout?.(0); } catch { /* a test double without a real socket */ }
}
