/**
 * The server starts a Super Agent's own chat by itself, with no window (owner 2026-11-16, Ege on
 * Telegram: "kapalı olan ya da uyutulmuş olan bir agent Telegram'dan yazdığımda tekrar uyanmıyor").
 *
 * Until now a Super process (main's or an AI Team member's) was born ONLY from a window's socket:
 * the Telegram hub could do nothing but `open -g` a session link and wait for the app to open the
 * stage and spawn it. When the window did not (the app's window hidden, an old app copy running, a
 * window still loading its records, a heavy machine), no process ever ran, the held messages
 * waited for nothing, and a member's link could even land as a PLAIN chat tab of the member's
 * conversation (no Super, so no injector), which then blanked the member's stage.
 *
 * Here the server spawns the Super through the very same `startChatSession` a window's socket
 * reaches, in `super` mode, resuming its recorded session, on a socket that belongs to nobody. The
 * phantom socket is cut as soon as the process registers its injector, so the child is DETACHED:
 * exactly the state a closed window leaves a Super in. The window's own Super pane adopts it later
 * (`reattach=passive`), and with nobody coming it is reaped like any detached chat (idle 15 min).
 */
import { EventEmitter } from 'node:events';
import { basename, dirname, resolve } from 'node:path';
import { chatInjector, onChatInjector } from '../lib/assistant/chat-registry.js';
import { getAgent } from '../lib/agents/store.js';
import { superEntry } from '../lib/super/store.js';
import { setSuperOwnerLineSink, setSuperWaker, superVaultName, type SuperWakeCause, type SuperWakeOutcome } from '../lib/super/inbox.js';
import { appendOpenLog } from '../lib/window-open-log.js';
import { claudeConversationExists } from './routes/agent-spawn-shared.js';
import { findLiveChat, stopLiveChat } from './routes/agent-chat-live.js';
import { readAgentUiSettings } from './routes/launcher.js';
import { rosterPermissionMode } from './routes/agent-sessions.js';

/** What a wake did. `live`: the Super already runs (its injector is there). `started`: a process
 *  was spawned and registered its injector. `refused`: no Super may run for this session now (off,
 *  waiting for approval, another session recorded), or the spawn failed; the caller falls back. */
export type HeadlessWake = 'live' | 'started' | 'refused';
/** The same, with the refusal's kind (owner 2026-11-22): `gate` (off, unapproved, not the recorded
 *  session: never retried), `start_failed` (a spawn that threw or never came up: a try), `busy`
 *  (a plain chat mid-turn, a holder that would not stop, a Super mid-respawn: retried, not a try). */
export type HeadlessWakeDetail = SuperWakeOutcome;

/** How long a headless spawn has to register its injector. */
export const HEADLESS_START_MS = 90_000;

/** A member Super's model and effort when its manifest names none (the window's own fallback,
 *  `memberStageModel.ts` MEMBER_SUPER_FALLBACK). */
const MEMBER_FALLBACK = { model: 'opus', effort: 'medium' } as const;

/**
 * A socket nobody holds. `send` drops (and keeps the refusal a spawn may write, for the log);
 * `ping` is never answered, so a window's passive reattach probes it as dead and adopts the
 * child; `close`/`terminate` end it once, the way a closed window's socket does.
 */
export class HeadlessSocket extends EventEmitter {
  readonly OPEN = 1;
  readonly CLOSED = 3;
  readyState = 1;
  refusal: string | null = null;
  send(data: unknown): void {
    if (this.readyState !== this.OPEN || this.refusal) return;
    try {
      const o = JSON.parse(String(data)) as { type?: unknown; subtype?: unknown; code?: unknown; message?: unknown };
      if (o?.type === '_meta' && o.subtype === 'error') this.refusal = String(o.code ?? o.message ?? 'error').slice(0, 120);
    } catch { /* not ours to read */ }
  }
  ping(): void { /* nobody answers: a reattach probing this holder adopts the child */ }
  close(): void { this.end(); }
  terminate(): void { this.end(); }
  private end(): void {
    if (this.readyState === this.CLOSED) return;
    this.readyState = this.CLOSED;
    this.emit('close', 1000, Buffer.from(''));
  }
}

export interface HeadlessSuperOpts {
  contextRoot: string;
  /** The registered vault name the chat registry lists it under (basename of the project when unknown). */
  vault?: string;
  /** The Super's recorded session (main's `session`, or the member record's). */
  sessionId: string;
  /** The AI Team member whose Super it is; null = the project's own Super. */
  member: string | null;
  home?: string;
  /** Tests: how long to wait for the injector. */
  waitMs?: number;
  /** Why it is woken, for the open log: his Telegram message, team mail, or its own child's event. */
  cause?: SuperWakeCause;
}

/** The spawn, injected by tests (default: agent-chat.ts `startChatSession`). */
type StartFn = (ws: import('ws').WebSocket, projectRoot: string, opts: Parameters<typeof import('./routes/agent-chat.js').startChatSession>[2]) => void;
let startOverride: StartFn | null = null;
/** Test seam. */
export function _setHeadlessStartForTests(fn: StartFn | null): void { startOverride = fn; }
/** The window's open gate, injected by tests (default: agent-chat.ts `superUpgradeRefusal`). */
type GateFn = typeof import('./routes/agent-chat.js').superUpgradeRefusal;
let gateOverride: GateFn | null = null;
/** Test seam. */
export function _setHeadlessGateForTests(fn: GateFn | null): void { gateOverride = fn; }

/** One start per session at a time: a second message waits for the first start, never spawns a twin. */
const starting = new Map<string, Promise<HeadlessWakeDetail>>();

/** Wait for `sessionId`'s injector, at most `ms`. */
function injectorWithin(sessionId: string, ms: number): Promise<boolean> {
  if (chatInjector(sessionId)) return Promise.resolve(true);
  return new Promise((done) => {
    const off = onChatInjector((sid) => { if (sid === sessionId) { clearTimeout(timer); off(); done(true); } });
    const timer = setTimeout(() => { off(); done(!!chatInjector(sessionId)); }, ms);
    timer.unref?.();
  });
}

/**
 * Start the Super of `sessionId` with no window, or say why not. Idempotent: a live Super answers
 * `live`, a start already running is shared. A process that holds the conversation but is no
 * Super (a plain chat tab opened on it by a link that landed before the window knew the record) is
 * stopped first: it can never take the owner's message, and while it runs no Super can.
 */
export function wakeSuperHeadless(o: HeadlessSuperOpts): Promise<HeadlessWake> {
  return wakeSuperHeadlessDetail(o).then((d) => (d === 'live' || d === 'started' ? d : 'refused'));
}

/** `wakeSuperHeadless` with the refusal's kind (the inbox's bounded wake reads it). One shared start. */
export function wakeSuperHeadlessDetail(o: HeadlessSuperOpts): Promise<HeadlessWakeDetail> {
  if (chatInjector(o.sessionId)) return Promise.resolve('live');
  const have = starting.get(o.sessionId);
  if (have) return have;
  const p = startOnce(o).finally(() => { if (starting.get(o.sessionId) === p) starting.delete(o.sessionId); });
  starting.set(o.sessionId, p);
  return p;
}

/**
 * The inbox wakes a stopped Super holding team mail (owner 2026-11-22, the window closed), and tells the
 * owner its one "could not start" line through the Super bot or a banner. The desktop server only.
 */
export function wireSuperWake(opts: { wake: boolean }): void {
  if (opts.wake) setSuperWaker((o) => wakeSuperHeadlessDetail({ contextRoot: o.root, sessionId: o.sessionId, member: o.member, cause: o.cause, vault: superVaultName(o.root) }));
  setSuperOwnerLineSink(async (root, line) => { const { sayToOwner } = await import('./super-schedule.js'); await sayToOwner(root, line); });
}

async function startOnce(o: HeadlessSuperOpts): Promise<HeadlessWakeDetail> {
  const cause = o.cause ?? 'telegram';
  const short = o.sessionId.slice(0, 8);
  const contextRoot = resolve(o.contextRoot);
  const projectRoot = dirname(contextRoot);
  // The same gate a window's open of this Super passes (a member off or unapproved, a session
  // that is not the recorded one): refused here too, never a back door.
  const { superUpgradeRefusal, startChatSession } = await import('./routes/agent-chat.js');
  const refused = (gateOverride ?? superUpgradeRefusal)({ mode: 'super', phone: false, contextRoot, resumeId: o.sessionId, sessionId: '', chatAgent: o.member, home: o.home });
  if (refused) { appendOpenLog('telegram_headless_refused', { session: short, status: refused, cause }, o.home); return 'gate'; }
  // Main's Super turned off keeps its session recorded (the window just never opens it while off):
  // the server never starts it then either, and its old conversation is the owner's again.
  if (!o.member && !superEntry(contextRoot, 'main').enabled) { appendOpenLog('telegram_headless_refused', { session: short, status: 'off', cause }, o.home); return 'gate'; }
  const holder = findLiveChat(o.sessionId);
  if (holder) {
    // A Super process without its injector is mid-respawn or leaving: the caller waits for it.
    if (holder.mirror) return chatInjector(o.sessionId) ? 'live' : 'busy';
    // A plain chat in the middle of a turn is left to finish it: the caller tries again later.
    if (holder.busy) { appendOpenLog('telegram_headless_refused', { session: short, status: 'plain_busy', cause }, o.home); return 'busy'; }
    appendOpenLog('telegram_headless_plain_holder', { session: short, cause }, o.home);
    const gone = await stopLiveChat(o.sessionId, { graceMs: 2_000 }).catch(() => false);
    if (!gone) { appendOpenLog('telegram_headless_refused', { session: short, status: 'held', cause }, o.home); return 'busy'; }
  }
  if (chatInjector(o.sessionId)) return 'live';
  let model: string;
  let effort: string;
  let bypass = false;
  if (o.member) {
    let agent: ReturnType<typeof getAgent> = null;
    try { agent = getAgent(contextRoot, o.member, o.home); } catch { agent = null; }
    const claude = !agent?.tool;
    model = (claude && agent?.model) || MEMBER_FALLBACK.model;
    effort = (claude && agent?.effort) || MEMBER_FALLBACK.effort;
  } else {
    const s = readAgentUiSettings();
    model = s.superModel;
    effort = s.superEffort;
    // The window spawns main's Super under the project's chat permission mode (its roster's).
    bypass = rosterPermissionMode(contextRoot) === 'bypass';
  }
  // A record whose first turn never ran has no transcript yet: started under its id, never resumed.
  const resumed = claudeConversationExists(o.sessionId);
  const sock = new HeadlessSocket();
  const asked = Date.now();
  appendOpenLog('telegram_headless_start', { session: short, member: o.member ?? 'main', resumed, cause }, o.home);
  try {
    (startOverride ?? startChatSession)(sock as unknown as import('ws').WebSocket, projectRoot, {
      bypass, serverStarted: true, sessionId: resumed ? '' : o.sessionId, resumeId: resumed ? o.sessionId : '', model, effort, mode: 'super',
      account: '', initialPrompt: '', deferPrompt: false, vault: o.vault || basename(projectRoot),
      ...(o.member ? { agent: o.member } : {}),
    });
  } catch (err) {
    appendOpenLog('telegram_headless_failed', { session: short, error: String((err as Error)?.message ?? err).slice(0, 120), cause }, o.home);
    sock.close();
    return 'start_failed';
  }
  const up = await injectorWithin(o.sessionId, o.waitMs ?? HEADLESS_START_MS);
  if (!up) {
    appendOpenLog('telegram_headless_failed', { session: short, ms: Date.now() - asked, cause, ...(sock.refusal ? { refusal: sock.refusal } : {}) }, o.home);
    sock.close();
    return 'start_failed';
  }
  appendOpenLog('telegram_headless_up', { session: short, ms: Date.now() - asked, cause }, o.home);
  // Detached from here on, as a closed window leaves it: adoptable by the window, reaped when idle.
  const t = setTimeout(() => sock.close(), 0);
  t.unref?.();
  return 'started';
}

/** Tests only. */
export function _resetHeadlessSuperForTests(): void {
  starting.clear();
  startOverride = null;
  gateOverride = null;
}
