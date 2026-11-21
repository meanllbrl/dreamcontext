/**
 * A Super's child started by the server when no window is there (plan sirket-yavaslik D12).
 *
 * Measured 2026-11-21 on the company Mac: with the app's window closed, `delegate` and `resume`
 * answered `no_window`, AI Team jobs waited 30+ minutes in the queue and stopped children never
 * woke. The Super itself already starts headless (headless-super.ts); its children did not.
 *
 * Contract C6: only THIS Super's own job (the caller passed the cap and every check `delegate` or
 * `resume` makes), with the same fields the window's delegate frame carries (mode, model, effort,
 * the lean MCP list, a member's crew tie decided here directly, no ticket minted), under the vault's
 * permission switch read the way the window reads it (`rosterPermissionMode`: auto is never
 * bypass). A permission the child asks for goes to the Super's queue like any detached child's:
 * nothing answers it here. A job this path cannot run (another tool than Claude) is refused, so
 * the caller keeps today's `no_window`; never a wider child.
 *
 * The socket belongs to nobody (headless-super.ts HeadlessSocket): the window adopts the child
 * when it opens (`reattach=passive`) and shows its card.
 */
import { randomUUID } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import { appendOpenLog } from '../lib/window-open-log.js';
import { HEADLESS_START_MS, HeadlessSocket } from './headless-super.js';
import { findLiveChat } from './routes/agent-chat-live.js';
import { rosterPermissionMode } from './routes/agent-sessions.js';

export interface HeadlessChildOpts {
  contextRoot: string;
  vault?: string;
  /** A new child: its first prompt. A resume: none (the conversation goes on). */
  prompt?: string;
  /** Resume this recorded child's conversation instead of a new one. */
  resumeId?: string;
  mode: string;
  model?: string;
  effort?: string;
  /** The lean MCP list the job named ([] = none). */
  mcp: string[];
  tool?: string;
  /** The member whose Super's child this is (tied exactly); null = main's. */
  member: string | null;
  home?: string;
  waitMs?: number;
}

export type HeadlessChildStart = { ok: true; sessionId: string } | { ok: false; why: string };

type StartFn = (ws: import('ws').WebSocket, projectRoot: string, opts: Parameters<typeof import('./routes/agent-chat.js').startChatSession>[2]) => void;
let startOverride: StartFn | null = null;
/** Test seam. */
export function _setHeadlessChildStartForTests(fn: StartFn | null): void { startOverride = fn; }

const MODES = new Set(['basic', 'plan', 'develop']);

/** Wait until the child's process is live (it registered with the chat registry), at most `ms`. */
async function liveWithin(sessionId: string, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (findLiveChat(sessionId)) return true;
    await new Promise((r) => { const t = setTimeout(r, 250); t.unref?.(); });
  }
  return !!findLiveChat(sessionId);
}

export async function startChildHeadless(o: HeadlessChildOpts): Promise<HeadlessChildStart> {
  if (o.tool) return { ok: false, why: `a ${o.tool} child is started only by a window` };
  if (!MODES.has(o.mode)) return { ok: false, why: 'unknown mode' };
  if (!o.resumeId && !o.prompt) return { ok: false, why: 'no first prompt' };
  const contextRoot = resolve(o.contextRoot);
  const projectRoot = dirname(contextRoot);
  const sessionId = o.resumeId ?? randomUUID();
  if (o.resumeId && findLiveChat(o.resumeId)) return { ok: true, sessionId };
  const { startChatSession } = await import('./routes/agent-chat.js');
  const sock = new HeadlessSocket();
  const short = sessionId.slice(0, 8);
  const asked = Date.now();
  appendOpenLog('child_headless_start', { session: short, member: o.member ?? 'main', resumed: !!o.resumeId }, o.home);
  try {
    (startOverride ?? startChatSession)(sock as unknown as import('ws').WebSocket, projectRoot, {
      // The vault's switch as the window reads it: only `bypass` is bypass, auto never is.
      bypass: rosterPermissionMode(contextRoot) === 'bypass', serverStarted: true,
      sessionId: o.resumeId ? '' : sessionId, resumeId: o.resumeId ?? '',
      model: o.model ?? '', effort: o.effort ?? '', mode: o.mode as 'basic',
      account: '', initialPrompt: o.prompt ?? '', deferPrompt: false, vault: o.vault || basename(projectRoot),
      leanMcp: o.mcp,
      ...(o.member ? { memberCrew: o.member, memberCrewCap: [o.member] } : {}),
    });
  } catch (err) {
    appendOpenLog('child_headless_failed', { session: short, error: String((err as Error)?.message ?? err).slice(0, 120) }, o.home);
    sock.close();
    return { ok: false, why: 'the start failed' };
  }
  const up = await liveWithin(sessionId, o.waitMs ?? HEADLESS_START_MS);
  if (!up || sock.refusal) {
    appendOpenLog('child_headless_failed', { session: short, ms: Date.now() - asked, ...(sock.refusal ? { refusal: sock.refusal } : {}) }, o.home);
    sock.close();
    return { ok: false, why: sock.refusal ? `refused (${sock.refusal})` : 'it did not come up in time' };
  }
  appendOpenLog('child_headless_up', { session: short, ms: Date.now() - asked }, o.home);
  // Detached from here on, as a closed window leaves it: the window adopts it when it opens.
  const t = setTimeout(() => sock.close(), 0);
  t.unref?.();
  return { ok: true, sessionId };
}
