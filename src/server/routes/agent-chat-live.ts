/**
 * agent-chat-live — the registry of chat children that outlive their socket.
 *
 * Until this module, an agent chat's `claude` child lived and died with ONE WebSocket: a
 * dropped socket (a phone screen lock, a Wi-Fi ↔ cellular handover, a forwarder hiccup) gave
 * the child stdin EOF, and a turn longer than the linger window was SIGTERMed mid-work. On a
 * phone a dropped socket is the normal case, not an error, so "give an order and pocket the
 * phone" never worked.
 *
 * Now a dropped socket DETACHES the child (agent-chat.ts `onSocketGone`): stdin stays open,
 * the child keeps running, and the entry here, keyed by the tab's conversation id, lets a
 * reconnecting client (`resume=<id>&reattach=1`) ADOPT the very same process instead of
 * spawning a new one. What the client missed while away it replays from chat-history.
 *
 * Reaping still happens — no child lives forever:
 *  • a detached child that is IDLE is ended after {@link DETACH_IDLE_MS} through the old
 *    EOF → linger → kill path;
 *  • a detached child that is BUSY is never reaped for lack of a socket, up to
 *    {@link DETACH_BUSY_CAP_MS} after it lost its socket.
 *
 * THE ACTIVITY CONTRACT (pinned for the cloud's idle clock, decision D14): the snapshot below
 * reports, per live child, whether a turn is running, when the current turn started and when
 * the last one ended. Those three move ONLY on turn edges. A reconnect, a reattach, a WS ping
 * and a chat-history replay fetch never touch them, so a phone that keeps reconnecting, or a
 * tab left open, can never look like the owner doing something.
 */

/** How long an IDLE child may stay detached before it is ended (stdin EOF → linger → kill). */
export const DETACH_IDLE_MS = 15 * 60_000;
/** How long a BUSY child may stay detached before it is ended anyway — the backstop for a turn
 *  that never ends. Measured from the moment it lost its socket. */
export const DETACH_BUSY_CAP_MS = 4 * 60 * 60_000;
/** How often an attached chat socket is pinged. A socket whose previous ping got no pong is
 *  terminated, which turns a half-open connection (the phone vanished without a FIN) into a
 *  detach instead of a socket the server keeps writing into for minutes. */
export const WS_PING_MS = 25_000;

/** A positive-integer env override, read per call — ONLY a scratch verify run sets these, so
 *  it can prove the 15 min / 4 h behaviour in seconds. Anything else falls back to `fallback`. */
function envMs(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}
export function detachIdleMs(): number { return envMs('DREAMCONTEXT_CHAT_DETACH_IDLE_MS', DETACH_IDLE_MS); }
export function detachBusyCapMs(): number { return envMs('DREAMCONTEXT_CHAT_DETACH_BUSY_CAP_MS', DETACH_BUSY_CAP_MS); }
export function wsPingMs(): number { return envMs('DREAMCONTEXT_CHAT_WS_PING_MS', WS_PING_MS); }

/** One live child as the idle clock may see it. Read-only by construction: a fresh frozen
 *  copy per {@link liveChatsSnapshot} call, never the registry's own object. */
export interface LiveChatSnapshotEntry {
  readonly conversationId: string;
  /** The project the child runs in (the laptop's go/return cut picks its in-scope turns by it). */
  readonly projectRoot: string;
  /** A turn is running inside the CLI right now. */
  readonly busy: boolean;
  /** When the running turn started (epoch ms), null when idle. */
  readonly turnStartedAt: number | null;
  /** When the last turn ended (epoch ms), null until one has. */
  readonly lastTurnEndedAt: number | null;
  /** Present (true) only while the child drains after its socket said goodbye (D22): it is
   *  still running, so it is listed busy and cuttable, but no longer adoptable. */
  readonly draining?: true;
}

/** What a chat session registers. Owned and mutated by agent-chat.ts; the registry only
 *  stores it and answers lookups. */
export interface LiveChatEntry {
  conversationId: string;
  /** The project the child runs in. A reattach for another project never adopts it. */
  projectRoot: string;
  busy: boolean;
  turnStartedAt: number | null;
  lastTurnEndedAt: number | null;
  /** Bind a new socket to this child. False when the child can no longer be adopted (it is
   *  exiting or draining) — the caller then spawns as if nothing were live. */
  adopt: (ws: import('ws').WebSocket) => boolean;
  /** A NON-reattach connection wants this conversation (a respawn: account, mode or Resume).
   *  Returns the settlement the caller runs once that connection is decided (`true` accepted,
   *  `false` refused). The child gives the conversation up only for an accepted open: a
   *  detached idle child is drained at once, a detached BUSY one lends its hold and is drained
   *  on acceptance, an attached one drains at its socket's close. A refused open (a second tab
   *  while this one still holds the conversation) leaves the child running and detachable. */
  supersede: () => (accepted: boolean) => void;
  /** Kill the child's whole process group (SIGTERM, SIGKILL after {@link CUT_KILL_GRACE_MS}),
   *  resolving once it exited. The conversation stays resumable (its transcript is on disk). */
  cut?: () => Promise<void>;
  /** The child's pid (it leads its own process group): labels what a process scan finds. */
  pid?: number;
}

/** How long a cut child gets between SIGTERM and SIGKILL. */
export const CUT_KILL_GRACE_MS = 5000;

const liveChats = new Map<string, LiveChatEntry>();
/** Children draining towards exit (D22): no longer adoptable, still running and cuttable. A
 *  respawn of the same conversation may already hold its id in {@link liveChats}. */
const drainingChats = new Set<LiveChatEntry>();
const drainingSince = new WeakMap<LiveChatEntry, number>();

export function registerLiveChat(entry: LiveChatEntry): void {
  if (!entry.conversationId) return;
  liveChats.set(entry.conversationId, entry);
}

/** Remove `entry` — only if it is still the one registered under its id, so a late cleanup of
 *  an old child can never unregister its successor. */
export function unregisterLiveChat(entry: LiveChatEntry): void {
  if (liveChats.get(entry.conversationId) === entry) liveChats.delete(entry.conversationId);
  drainingChats.delete(entry);
}

/** The child stops being adoptable but stays listed (busy) until it exits: then the caller
 *  unregisters it (D22). */
export function markLiveChatDraining(entry: LiveChatEntry, now = Date.now()): void {
  if (liveChats.get(entry.conversationId) === entry) liveChats.delete(entry.conversationId);
  drainingChats.add(entry);
  if (!drainingSince.has(entry)) drainingSince.set(entry, now);
}

export function findLiveChat(conversationId: string): LiveChatEntry | null {
  return conversationId ? liveChats.get(conversationId) ?? null : null;
}

/** Mark a turn edge. The ONLY writers of the three activity fields. */
export function markTurnStarted(entry: LiveChatEntry, now = Date.now()): void {
  if (entry.busy) return;
  entry.busy = true;
  entry.turnStartedAt = now;
}
export function markTurnEnded(entry: LiveChatEntry, now = Date.now()): void {
  if (!entry.busy) return;
  entry.busy = false;
  entry.turnStartedAt = null;
  entry.lastTurnEndedAt = now;
}

/** The read-only view the cloud's idle clock (wave 2) reads. */
export function liveChatsSnapshot(): readonly LiveChatSnapshotEntry[] {
  const live = [...liveChats.values()].map((e) => Object.freeze({
    conversationId: e.conversationId,
    projectRoot: e.projectRoot,
    busy: e.busy,
    turnStartedAt: e.turnStartedAt,
    lastTurnEndedAt: e.lastTurnEndedAt,
  }));
  const draining = [...drainingChats].map((e) => Object.freeze({
    conversationId: e.conversationId,
    projectRoot: e.projectRoot,
    busy: true,
    turnStartedAt: e.turnStartedAt ?? drainingSince.get(e) ?? null,
    lastTurnEndedAt: e.lastTurnEndedAt,
    draining: true as const,
  }));
  return Object.freeze([...live, ...draining]);
}

/**
 * Cut every live chat whose snapshot matches `pred` (PINNED for the hands-free go/return and
 * the cloud's `cut`): each child's whole process group gets SIGTERM, then SIGKILL after
 * {@link CUT_KILL_GRACE_MS}; resolves once they all exited, with the conversation ids cut.
 * The sessions stay resumable: only the processes end, never a transcript.
 */
export async function cutLiveChats(pred: (e: LiveChatSnapshotEntry) => boolean): Promise<string[]> {
  const ids: string[] = [];
  const entries: LiveChatEntry[] = [...liveChats.values(), ...drainingChats];
  await Promise.all(entries.map(async (entry) => {
    const snap = liveChatsSnapshot().find((s) => s.conversationId === entry.conversationId && (s.draining === true) === drainingChats.has(entry));
    if (!snap || !pred(snap) || !entry.cut) return;
    ids.push(entry.conversationId);
    try { await entry.cut(); } catch { /* already gone */ }
  }));
  return ids;
}

/** Signal a child's process group (it is spawned as a group leader); falls back to the child. */
export function signalGroup(child: { pid?: number; kill: (s?: NodeJS.Signals) => boolean }, signal: NodeJS.Signals): void {
  try {
    if (child.pid) { process.kill(-child.pid, signal); return; }
  } catch { /* not a group leader (or gone): signal the child itself */ }
  try { child.kill(signal); } catch { /* gone */ }
}

/** Live and draining chats by their child's pid (= its process group), for labelling a
 *  process scan (D22: the scan finds the work, the registry only names it). */
export function liveChatsByPgid(): Map<number, { conversationId: string; busy: boolean; startedAt: number | null; draining: boolean }> {
  const out = new Map<number, { conversationId: string; busy: boolean; startedAt: number | null; draining: boolean }>();
  for (const e of liveChats.values()) if (e.pid) out.set(e.pid, { conversationId: e.conversationId, busy: e.busy, startedAt: e.turnStartedAt, draining: false });
  for (const e of drainingChats) if (e.pid) out.set(e.pid, { conversationId: e.conversationId, busy: true, startedAt: e.turnStartedAt ?? drainingSince.get(e) ?? null, draining: true });
  return out;
}
