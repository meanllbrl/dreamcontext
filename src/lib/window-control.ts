import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { SuperId } from './super/types.js';
import { HUB_VERBS, type HubResult, type HubVerb } from './telegram/contract.js';
import { getChat, listChats } from './assistant/chat-registry.js';
import { noteSuperSend, takeSuperSend } from './super/owner-wait.js';

/**
 * Window control: how a chat's own agent drives the chat surface it is drawn in — open a
 * chat, put two side by side, switch a tab's mode or model, focus or close a tab.
 *
 * NO NEW SOCKET, the Assistant relay's shape (`assistant/relay.ts`) scoped to ONE chat. Every
 * project chat spawn gets a token of its own in its env (`DREAMCONTEXT_WINDOW_TOKEN`); the CLI
 * (`dreamcontext window …`) posts a verb with it, and the server sends the verb DOWN that
 * chat's own WebSocket as a `_meta{subtype:'window_command'}` frame. The pane holding the chat
 * runs it against its own surface and answers UP the same socket. So a verb can only ever
 * reach the window that is showing the chat that asked: no window registry, no vault lookup,
 * and a token from another chat (or another project) names another socket, never this one.
 *
 * A token dies with its chat process. A socket that is gone (the window closed, the phone
 * slept) answers `no_window` at once; one that never answers, after {@link WINDOW_TIMEOUT_MS}.
 */

export const WINDOW_TIMEOUT_MS = 20_000;
export const WINDOW_TOKEN_HEADER = 'x-dreamcontext-window-token';

/** How long before the server gives up on a window a `deadline` arg runs out. */
const WINDOW_DEADLINE_MARGIN_MS = 2_000;
/**
 * The `deadline` a verb with a server fallback carries (`super send`, `super allow`): a window
 * that wakes after it (an app in the background, field 2026-11-13) refuses the verb, so the
 * server's own delivery after a timeout is the only one. Runs out before the server's timeout.
 */
export function windowDeadline(now = Date.now(), timeoutMs = WINDOW_TIMEOUT_MS): number {
  return now + Math.max(0, timeoutMs - WINDOW_DEADLINE_MARGIN_MS);
}

/** `sent` (on a failure the server itself decided): false = the frame never reached a window;
 *  true = it was written and no answer came in time (the window may still have acted on it). */
export type WindowResult = { ok: true; result: unknown } | { ok: false; error: string; sent?: boolean };

export interface WindowChannel {
  /** Send one `_meta` frame down the chat's CURRENT socket; false when none is open. */
  send: (frame: Record<string, unknown>) => boolean;
  /** WHO holds the token (task chat-gets-a-super-agent-mode…, plan-r7 D4): the chat's vault
   *  name and context root, its pin id, and the mode it was spawned in. A mode switch respawns
   *  the chat, which mints a new token, so `mode` is always the running process's. The route
   *  checks read these; a channel minted without them (tests) is nobody, and nobody passes a
   *  Super Agent check. */
  vault?: string;
  contextRoot?: string;
  sessionId?: string;
  mode?: string;
  /** Which super a `super`-mode chat speaks for (plan-r10 1): the project's own (`main`) or an AI
   *  Team member's (`m:<slug>`). Absent = `main`. The verb routes read the record by it. */
  superId?: SuperId;
}

/** What a token says about its chat — never the `send` function. */
export interface WindowIdentity {
  vault: string;
  contextRoot: string;
  sessionId: string;
  mode: string;
  /** Always set: `main` when the channel named none. */
  superId: SuperId;
}

/** Which frame a command travels as, and which result frame may settle it. */
export type CommandSubtype = 'window_command' | 'super_command' | 'hub_command';

interface Pending {
  token: string;
  subtype: CommandSubtype;
  /** The pin id of the chat it went to: a `super_command` may be answered on that chat's NEXT
   *  socket (a respawned super process mints a new token for the same session). */
  sessionId?: string;
  /** The frame was written to a socket. */
  sent: boolean;
  resolve: (r: WindowResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

const channels = new Map<string, WindowChannel>();
const pending = new Map<string, Pending>();
let baseUrl = '';

/** The loopback URL the CLI posts to, learned once the server is listening. */
export function setWindowControlBase(url: string): void {
  if (/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) baseUrl = url;
}

/**
 * Mint a token for one chat process. Returns its env (empty when the server's port is not
 * known yet, so a chat never gets a URL that points nowhere) and the release to run on exit.
 */
export function mintWindowToken(channel: WindowChannel): { env: Record<string, string>; token: string; release: () => void } {
  const token = randomBytes(24).toString('hex');
  channels.set(token, channel);
  const release = () => {
    channels.delete(token);
    // A `super_command` already written keeps waiting for the WINDOW's answer until its own
    // timeout: the window may already have acted on it (opened a child), and the answer can
    // still arrive on the respawned super session's socket. Everything else ends now.
    for (const [id, p] of [...pending]) {
      if (p.token !== token) continue;
      if (p.subtype === 'super_command' && p.sent) continue;
      settle(id, noWindow(p.subtype, p.sent));
    }
  };
  const env: Record<string, string> = baseUrl ? { DREAMCONTEXT_WINDOW_URL: baseUrl, DREAMCONTEXT_WINDOW_TOKEN: token } : {};
  return { env, token, release };
}

/** The channel behind a token, compared in constant time; null for anything unknown. */
export function channelFor(token: unknown): string | null {
  if (typeof token !== 'string' || !/^[0-9a-f]{48}$/.test(token)) return null;
  const given = Buffer.from(token);
  for (const known of channels.keys()) {
    const k = Buffer.from(known);
    if (k.length === given.length && timingSafeEqual(k, given)) return known;
  }
  return null;
}

function settle(id: string, r: WindowResult): boolean {
  const p = pending.get(id);
  if (!p) return false;
  clearTimeout(p.timer);
  pending.delete(id);
  p.resolve(r);
  return true;
}

/** The identity behind a live token, or null (unknown token, or minted without one). */
export function identityOf(token: string): WindowIdentity | null {
  const c = channels.get(token);
  if (!c || !c.vault || !c.contextRoot || !c.sessionId || !c.mode) return null;
  return { vault: c.vault, contextRoot: c.contextRoot, sessionId: c.sessionId, mode: c.mode, superId: c.superId ?? 'main' };
}

/** The live token of the chat with pin id `sessionId`, or null. The server uses it to push a
 *  frame (`super_state`, `super_event`) down that chat's socket; it never leaves the server. */
export function tokenOfSession(sessionId: string): string | null {
  if (!sessionId) return null;
  for (const [token, c] of channels) if (c.sessionId === sessionId) return token;
  return null;
}

/** The live token of the SUPER-mode chat with pin id `sessionId`, the newest one when a respawn
 *  briefly leaves the old channel registered beside its successor, or null. */
export function superTokenOfSession(sessionId: string): string | null {
  if (!sessionId) return null;
  let found: string | null = null;
  for (const [token, c] of channels) if (c.sessionId === sessionId && c.mode === 'super') found = token;
  return found;
}

/** Push one `_meta` frame down a token's socket without waiting for an answer. */
export function pushFrame(token: string, frame: Record<string, unknown>): boolean {
  const channel = channels.get(token);
  return channel ? channel.send(frame) : false;
}

/** The server's own `no_window`. A `super_command` also says whether its frame was written
 *  (`super delegate` keeps a worktree a window may already have handed to a child); a
 *  `window_command` answers exactly as it always did. */
function noWindow(subtype: CommandSubtype, sent: boolean): WindowResult {
  return subtype === 'super_command' ? { ok: false, error: 'no_window', sent } : { ok: false, error: 'no_window' };
}

function sendCommand(
  subtype: CommandSubtype,
  token: string,
  verb: string,
  args: Record<string, unknown>,
  opts: { timeoutMs?: number },
): Promise<WindowResult> {
  const channel = channels.get(token);
  if (!channel) return Promise.resolve(noWindow(subtype, false));
  const id = randomBytes(16).toString('hex');
  return new Promise<WindowResult>((resolve) => {
    const timer = setTimeout(() => settle(id, noWindow(subtype, true)), opts.timeoutMs ?? WINDOW_TIMEOUT_MS);
    timer.unref?.();
    const p: Pending = { token, subtype, resolve, timer, sent: false, ...(channel.sessionId ? { sessionId: channel.sessionId } : {}) };
    pending.set(id, p);
    // A member Super's verb names its super (plan-r10 1); main's frame stays exactly as before.
    const superId = subtype === 'super_command' && channel.superId && channel.superId !== 'main' ? { superId: channel.superId } : {};
    if (channel.send({ subtype, id, verb, args, ...superId })) p.sent = true;
    else settle(id, noWindow(subtype, false));
  });
}

/**
 * A verb only the Telegram hub sends (A2, B3): `answer_pending`, `render_card`, `run_report`,
 * `super_handover`, `interrupt`. Its own frame subtype and result frame, server-internal (no
 * HTTP surface; never in `WINDOW_VERBS`), by token (`superTokenOfSession` / `tokenOfSession`),
 * never by root. A verb outside the pinned set is refused before anything is sent.
 */
export async function sendHubCommand(
  token: string,
  verb: HubVerb,
  args: Record<string, unknown>,
  opts: { timeoutMs?: number } = {},
): Promise<HubResult> {
  if (!HUB_VERBS.includes(verb)) return { ok: false, error: 'unknown_verb' };
  const r = await sendCommand('hub_command', token, verb, args, opts);
  if (!r.ok) return { ok: false, error: r.error, ...(r.sent !== undefined ? { sent: r.sent } : {}) };
  const res = r.result;
  return res && typeof res === 'object' && !Array.isArray(res) ? { ok: true, ...(res as Record<string, unknown>) } : { ok: true, result: res };
}

/** The window's `hub_command_result`, accepted only from the socket the command went to. */
export function deliverHubResult(token: string, id: unknown, result: HubResult): boolean {
  return deliver('hub_command', token, id, result.ok ? { ok: true, result } : { ok: false, error: String(result.error ?? 'failed').slice(0, 300) });
}

/**
 * Send one verb down the token's chat socket and wait for the window's answer.
 *
 * A `send` is an AGENT's words into a tab, never the owner's (sahip-karti-yerinde K4, gap 7): it
 * is noted like `super send` (owner-wait.ts `noteSuperSend`) whatever tab it goes into, so its
 * frame answers no wait the child holds on the owner and closes no card. A send into a Super chat
 * is noted by the route (routes/window-control.ts); `noted`: the caller noted it itself (the
 * outbox, `super send`, a successor's stop). A send that never went in takes its note back.
 */
export async function sendWindowCommand(
  token: string,
  verb: string,
  args: Record<string, unknown>,
  opts: { timeoutMs?: number; noted?: boolean } = {},
): Promise<WindowResult> {
  let noted: { sid: string; text: string } | null = null;
  if (verb === 'send' && !opts.noted && typeof args.text === 'string' && args.text.trim()) {
    const tab = typeof args.tab === 'string' && args.tab ? args.tab : channels.get(token)?.sessionId ?? '';
    const target = tab ? getChat(tab) ?? listChats().find((c) => c.conversationId === tab) ?? null : null;
    const sid = target?.sessionId ?? tab;
    if (sid && target?.mode !== 'super') { noteSuperSend(sid, args.text); noted = { sid, text: args.text }; }
  }
  const r = await sendCommand('window_command', token, verb, args, opts);
  if (!r.ok && noted && !(r.error === 'no_window' && (r as { sent?: boolean }).sent)) takeSuperSend(noted.sid, noted.text);
  return r;
}

/** A Super Agent verb the WINDOW runs (`delegate`, `answer`), sent down the super chat's own
 *  socket as `super_command` — same transport, separate subtype, so a `window_command_result`
 *  can never settle it and the reverse (plan-r7 D4). */
export function sendSuperCommand(
  token: string,
  verb: string,
  args: Record<string, unknown>,
  opts: { timeoutMs?: number } = {},
): Promise<WindowResult> {
  return sendCommand('super_command', token, verb, args, opts);
}

function deliver(subtype: CommandSubtype, token: string, id: unknown, r: WindowResult): boolean {
  if (typeof id !== 'string') return false;
  const p = pending.get(id);
  if (!p || p.subtype !== subtype) return false;
  if (p.token !== token) {
    // Only a `super_command`, and only from the SAME chat's newer socket (same pin id).
    const now = channels.get(token);
    if (subtype !== 'super_command' || !p.sessionId || !now || now.sessionId !== p.sessionId) return false;
  }
  return settle(id, r);
}

/** The window's answer, accepted only from the socket of the chat the command went to. */
export function deliverWindowResult(token: string, id: unknown, r: WindowResult): boolean {
  return deliver('window_command', token, id, r);
}

/** The window's answer to a `super_command`, accepted only from the super chat's own socket. */
export function deliverSuperResult(token: string, id: unknown, r: WindowResult): boolean {
  return deliver('super_command', token, id, r);
}

/** Test seam. */
export function resetWindowControl(): void {
  for (const id of [...pending.keys()]) settle(id, { ok: false, error: 'no_window' });
  channels.clear();
  baseUrl = '';
}
