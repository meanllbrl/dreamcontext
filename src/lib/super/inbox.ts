import { createHash, randomBytes } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { listVaults } from '../vaults.js';
import { wrapUntrusted } from '../assistant/autonomy.js';
import { GONE_DEBOUNCE_MS } from '../assistant/delegations.js';
import {
  STARTING_GRACE_MS, activityOf, chatTopic, getChat, onChatChange, type ChatChange, type ChatEntry,
} from '../assistant/chat-registry.js';
import { pushFrame, tokenOfSession } from '../window-control.js';
import {
  isSuperChild, primeSuperIndex, readSuperState, superIndex, superRootOfChild, superRootOfEnded, superRootOfSession,
  updateSuperState, type SanitizeOpts,
} from './store.js';
import {
  DONE_SETTLE_MS, MAX_BATCH, MAX_CONTAINERS, MAX_OWNER_BATCHES, OWNER_LEASE_MS, READOPT_GRACE_MS, STALE_SWEEP_MS,
  SUPER_FRAME_STATE,
  type ChildRow, type QueueKind, type StuckReason, type SuperChild, type SuperEventKind,
  type SuperQueueItem, type SuperState, type SuperStateView,
} from './types.js';

/**
 * The Super Agent's INBOX: one job list and one question queue per vault (plan-r7 D6, D7, D13,
 * D16; plan r4 "rows, not turns").
 *
 * FED BY THE REGISTRY. Every change of a recorded child of a handed-over vault (`onChatChange`)
 * updates that child's ROW in `state/.super-agent.json` (the job list the owner and the super
 * agent both read) and, only for a decision, adds a queue item:
 *   asking (permission) → a `permission` item at once. NEVER delivered to the super agent: the
 *                         owner's bar answers it through the child's own ChatSession.
 *   asking (question)   → a `question` item, delivered to the super agent.
 *   working             → the row is `working`; its pending done/stuck items close (old news).
 *   idle                → the row starts settling ("bitiyor"); after DONE_SETTLE_MS still idle it
 *                         is `done` (or `stuck` for an error turn that was neither interrupted nor
 *                         a limit switch) with ONE `done`/`stuck` item. A turn end alone opens no
 *                         super turn.
 *   stale               → found by the sweep: `stuck` once per episode, `working` again when it
 *                         moves.
 *   gone                → a `gone` item after GONE_DEBOUNCE_MS, unless the id is live again.
 *   leaving `asking`    → the child's open permission/question items are done.
 *
 * Rows are RECONCILED, never trusted blindly (`reconcileRows`): at boot, when the super socket
 * attaches, on a child's first frame and on every sweep tick.
 *
 * THE PUMP delivers what piled up as ONE `[super events]` turn (at most MAX_BATCH, oldest
 * first; a handover or recap alone and first), and only when every rule of D7 holds: handed
 * over, the super chat's socket attached, the super chat idle by `activityOf` and by the
 * bridge's own turn count, the owner silent for OWNER_LEASE_MS, and NO question open with the
 * owner (the single-question rule: a live escalation or the super agent's own `ask`).
 *
 * The owner's messages never wait for any of this: the bridge writes them into the running turn
 * at once (`superOwnerSpoke` only stamps the lease and closes an open `ask`).
 *
 * Every write here pushes `_meta{subtype:'super_state'}` down the super chat's socket: the
 * window never polls.
 */

// ─── Small helpers ──────────────────────────────────────────────────────────────

const keyOf = (root: string) => resolve(root);
const isLive = (e: ChatEntry | null) => !!e && e.status !== 'gone';

/** A registry entry that may never be a child: another mode's chat or an Assistant delegation. */
export function isExcludedChat(sessionId: string): boolean {
  const c = getChat(sessionId);
  return !!c && (c.mode === 'super' || c.mode === 'assistant' || c.origin === 'assistant');
}

/** The sanitize options every server write of the record uses (D2, D17). */
export function superSanitizeOpts(): SanitizeOpts {
  return { isExcludedChat };
}

/** The vault's registered name for a context root (the chat registry's own fallback otherwise). */
export function superVaultName(contextRoot: string): string {
  const want = resolve(contextRoot);
  const v = listVaults().find((x) => resolve(join(x.path, '_dream_context')) === want);
  return v?.name ?? basename(dirname(want));
}

export function superView(contextRoot: string, state: SuperState): SuperStateView {
  return { ...state, vault: superVaultName(contextRoot) };
}

export function newQueueId(): string {
  return `q-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

/** An event turn's batch id (QUEUE_ID_RE). */
export function newBatchId(): string {
  return `b-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

/** A container id for (kind, ref): stable, so reopening the same thing updates it. */
export function containerIdFor(kind: string, ref: string): string {
  return `${kind}-${createHash('sha1').update(ref).digest('hex').slice(0, 12)}`;
}

/** A child's `chat` card, appended when there is room (the 13th is never added): tall,
 *  floating, placed automatically (plan-r8 F1). */
export function ensureChatContainer(s: SuperState, sessionId: string, title?: string): string | null {
  const have = s.containers.find((c) => c.kind === 'chat' && c.ref === sessionId);
  if (have) return have.id;
  if (s.containers.length >= MAX_CONTAINERS) return null;
  const id = containerIdFor('chat', sessionId);
  s.containers.push({ id, kind: 'chat', ref: sessionId, shape: 'tall', place: 'float', ...(title ? { title } : {}) });
  return id;
}

/** Move a child's row (and stamp when). */
export function setRow(ch: SuperChild, row: ChildRow, reason?: StuckReason, now = Date.now()): boolean {
  if (ch.row === row && (row !== 'stuck' || ch.stuckReason === reason)) return false;
  ch.row = row;
  ch.rowAt = now;
  if (row === 'stuck' && reason) ch.stuckReason = reason; else delete ch.stuckReason;
  if (row !== 'working') delete ch.settling;
  return true;
}

/** Append a batch id to the ring of turns that render in full (never mutated after). */
export function noteOwnerBatch(s: SuperState, batch: string | undefined): void {
  if (!batch || s.ownerBatches.includes(batch)) return;
  s.ownerBatches.push(batch);
  if (s.ownerBatches.length > MAX_OWNER_BATCHES) s.ownerBatches.splice(0, s.ownerBatches.length - MAX_OWNER_BATCHES);
}

// ─── The queue head (D16: what reaches the owner) ───────────────────────────────

/**
 * What the owner's bar leads with, and the ONE super row the notch glance may carry: the oldest
 * open permission (permissions jump the line), else the oldest escalation: a child's question
 * the super agent escalated, or its own `ask`. A second one waits behind the first, so the
 * owner never has two at once.
 */
export function superQueueHead(state: Pick<SuperState, 'queue'>): SuperQueueItem | null {
  const byAge = [...state.queue].sort((a, b) => a.createdAt - b.createdAt);
  return byAge.find((q) => q.kind === 'permission' && q.state !== 'done')
    ?? byAge.find((q) => (q.kind === 'question' || q.kind === 'ask') && q.state === 'escalated')
    ?? null;
}

/** Is the child still asking exactly this question (and is it a question)? */
function stillAsking(item: SuperQueueItem): boolean {
  const c = getChat(item.sessionId);
  return !!c && c.status === 'asking' && !!c.pendingQuestion && !c.pendingQuestion.isPermission
    && c.pendingQuestion.requestId === item.requestId;
}

/** The single-question rule (plan r4 D16): a question is open with the owner — the super
 *  agent's own `ask`, or an escalated child question the child is STILL asking. */
export function ownerQuestionOpen(state: Pick<SuperState, 'queue'>): boolean {
  return state.queue.some((q) => q.state === 'escalated'
    && (q.kind === 'ask' || (q.kind === 'question' && stillAsking(q))));
}

interface HeadEntry { root: string; vault: string; enabled: boolean; head: SuperQueueItem | null; children: Set<string> }
const heads = new Map<string, HeadEntry>();

function noteHead(root: string, state: SuperState): void {
  heads.set(keyOf(root), {
    root: keyOf(root),
    vault: superVaultName(root),
    enabled: state.enabled,
    head: superQueueHead(state),
    children: new Set(Object.keys(state.children)),
  });
}

/** Per handed-over vault, its queue head when that is a permission or an escalation. */
export function superAttentionRows(): Array<{ root: string; vault: string; item: SuperQueueItem }> {
  const out: Array<{ root: string; vault: string; item: SuperQueueItem }> = [];
  for (const h of heads.values()) if (h.enabled && h.head) out.push({ root: h.root, vault: h.vault, item: h.head });
  return out;
}

// ─── Writes + pushes ────────────────────────────────────────────────────────────

/** Push the vault's state down its super chat's socket (when that chat is running). */
export function pushSuperState(contextRoot: string, state: SuperState): boolean {
  if (!state.session) return false;
  const token = tokenOfSession(state.session);
  return token ? pushFrame(token, { subtype: SUPER_FRAME_STATE, state: superView(contextRoot, state) }) : false;
}

/** Everything a write of the record owes: the glance's head cache, the window's push, and the
 *  stale sweep armed or stopped by the rows it now holds. */
export function afterSuperWrite(contextRoot: string, state: SuperState): void {
  noteHead(contextRoot, state);
  pushSuperState(contextRoot, state);
  syncSweep(keyOf(contextRoot), state);
}

/** Change the record (locked, sanitized), then push. Every write in wave 2 goes through here. */
export async function writeSuper(contextRoot: string, fn: (draft: SuperState) => SuperState | void): Promise<SuperState> {
  const next = await updateSuperState(contextRoot, fn, superSanitizeOpts());
  afterSuperWrite(contextRoot, next);
  return next;
}

function countEvent(s: SuperState): void {
  s.away.events += 1;
  if (s.away.since === null) s.away.since = Date.now();
}

// ─── The super chat's inbox (agent-chat.ts attaches it) ─────────────────────────

/** What the `super_event` frame before an injected turn says. A batch names every item. */
export interface SuperEventFrame {
  kind: SuperEventKind;
  /** The child (a solo handover/recap names the super session). */
  child: string;
  batch?: string;
  items?: Array<{ item: string; child: string; kind: QueueKind }>;
}

export interface SuperInbox {
  id: string;
  /** The super chat's pin id. */
  sessionId: string;
  /** A socket is bound right now (not detached). */
  attached(): boolean;
  /** No turn of the bridge's own is in flight. */
  idle(): boolean;
  /** Write one injected turn. Resolves true only when it was written. Once `cancelled()` is true
   *  (the inbox gave up waiting) it must never write: the items are still `pending`. */
  deliver(text: string, event: SuperEventFrame, cancelled?: () => boolean): Promise<boolean>;
}

const inboxes = new Map<string, SuperInbox>();

/** The super chat came up (or a respawn of it): attach, push the state, pump. Last wins. */
export function attachSuperInbox(inbox: SuperInbox): () => void {
  inboxes.set(inbox.sessionId, inbox);
  superSocketAttached(inbox.sessionId);
  return () => {
    if (inboxes.get(inbox.sessionId)?.id === inbox.id) inboxes.delete(inbox.sessionId);
    // The process is gone: no turn-end will ever come for what it carried. Its exit IS the end
    // of that turn, and an exit puts what it carried back for the successor (plan r4 D10).
    endTurn(inbox.sessionId, inbox.id, true);
  };
}

/** The super chat's socket (re)attached: it gets the state at once, the rows a reconcile, and
 *  the queue a chance. */
export function superSocketAttached(sessionId: string): void {
  const root = superRootOfSession(sessionId);
  if (!root) return;
  void track(readSuperState(root, superSanitizeOpts()).then((s) => {
    noteHead(root, s);
    pushSuperState(root, s);
    void track(reconcileRows(root));
    void pumpSuper(root);
  }).catch(() => { /* a refused record: the mode is off there */ }));
}

/**
 * The super chat's bridge closed a turn (its own `turnsInFlight` is back to 0). The registry's
 * `idle` arrives BEFORE that, on the same `result` frame, so a pump it starts still reads the
 * bridge as busy and stops; this is the edge that lets the next batch go. Not a poll: one call
 * per closed turn.
 */
export function superTurnEnded(sessionId: string): void {
  endTurn(sessionId, inboxes.get(sessionId)?.id ?? null, false);
}

/** Every turn end gets the next number: a carried item is settled only by an end numbered after
 *  its own delivery, so an earlier turn's late end never settles it early. */
let endSeq = 0;
interface Carried { itemId: string; inboxId: string; seq: number; batch: string; steered?: boolean }
interface TurnEnd { inboxId: string | null; seq: number; exited: boolean }
/** Delivered items not settled yet, per vault: a LIST, never overwritten, so a turn end the
 *  pump learns of late still finds every item it carried (w5 Minor 1). */
const carried = new Map<string, Carried[]>();
/** Turn ends (or process exits) since the last pump, per vault, with the inbox that ended it. */
const turnsEnded = new Map<string, TurnEnd[]>();
/** The event turn running in each super session (plan r4 D8): set at deliver, cleared at its
 *  end, its process's exit, or when the owner speaks. */
const openBatch = new Map<string, { batch: string; inboxId: string; root: string }>();

function endTurn(sessionId: string, inboxId: string | null, exited: boolean): void {
  const ob = openBatch.get(sessionId);
  if (ob && (inboxId === null || ob.inboxId === inboxId)) openBatch.delete(sessionId);
  const root = superRootOfSession(sessionId);
  if (!root) return;
  const key = keyOf(root);
  const list = turnsEnded.get(key) ?? [];
  endSeq += 1;
  list.push({ inboxId, seq: endSeq, exited });
  turnsEnded.set(key, list);
  void pumpSuper(key);
}

/** The batch of the event turn running in `sessionId` right now, or null. */
export function superOpenBatch(sessionId: string): string | null {
  return openBatch.get(sessionId)?.batch ?? null;
}

/** The child's own question, as the owner's bar shows it after the super agent left it
 *  unsettled twice (plain text; fenced wherever an agent reads it). */
function childQuestionText(sessionId: string): string {
  const pq = getChat(sessionId)?.pendingQuestion;
  if (!pq) return 'A child is waiting for an answer.';
  return pq.options.length ? `${pq.text} (options: ${pq.options.join(' | ')})` : pq.text;
}

/**
 * The turn that carried delivered items ended (or its process did). A `result` end (any
 * non-exit end numbered after the item wins over an exit in the same pass, r2-E4): every
 * non-question is done; a question still `delivered` and still asked goes back to `pending` the
 * first time and is escalated to the owner with the child's own question the second (M1) —
 * unless the owner steered into that turn, which spends no attempt. A PURE exit puts every item
 * back to `pending` for the successor; after two exits it is dropped (a question escalated).
 * Runs inside the pump's single flight; a write that fails puts them (and the ends) back for
 * the next pump. Returns whether it settled anything.
 */
async function settleCarried(key: string): Promise<boolean> {
  const ended = turnsEnded.get(key);
  if (!ended) return false;
  turnsEnded.delete(key);
  const list = carried.get(key) ?? [];
  const ends = (c: Carried) => ended.filter((e) => e.seq > c.seq && (e.inboxId === null || e.inboxId === c.inboxId));
  const settle = list.filter((c) => ends(c).length > 0);
  const keep = list.filter((c) => ends(c).length === 0);
  if (!settle.length) return false;
  if (keep.length) carried.set(key, keep); else carried.delete(key);
  try {
    await writeSuper(key, (s) => {
      for (const c of settle) {
        const it = s.queue.find((q) => q.id === c.itemId);
        if (!it || it.state !== 'delivered') continue;
        const pureExit = ends(c).every((e) => e.exited);
        if (pureExit) {
          const exits = (it.exits ?? 0) + 1;
          it.exits = exits;
          if (exits < 2) { it.state = 'pending'; continue; }
          if (it.kind === 'question' && stillAsking(it)) { it.state = 'escalated'; it.ownerText = childQuestionText(it.sessionId); continue; }
          it.state = 'done';
          continue;
        }
        if (it.kind !== 'question') { it.state = 'done'; continue; }
        if (!stillAsking(it)) { it.state = 'done'; continue; }
        if (c.steered) { it.state = 'pending'; continue; }
        const attempts = (it.attempts ?? 0) + 1;
        it.attempts = attempts;
        if (attempts < 2) { it.state = 'pending'; continue; }
        it.state = 'escalated';
        it.ownerText = childQuestionText(it.sessionId);
      }
    });
  } catch (err) {
    carried.set(key, [...settle, ...(carried.get(key) ?? [])]);
    turnsEnded.set(key, [...ended, ...(turnsEnded.get(key) ?? [])]);
    throw err;
  }
  return true;
}

/** Turns the inbox opened, until the owner's next message: the notch never announces them. */
const eventTurns = new Set<string>();
export function markSuperEventTurn(sessionId: string, open: boolean): void {
  if (open) eventTurns.add(sessionId); else eventTurns.delete(sessionId);
}
export function isSuperEventTurn(sessionId: string): boolean {
  return eventTurns.has(sessionId);
}

/** Is `sessionId` a vault's super session while that vault is handed over? */
export function isHandedOverSuperSession(sessionId: string): boolean {
  const root = superRootOfSession(sessionId);
  return !!root && superIndex(root).enabled;
}

/** The super session or one of its children, while handed over: the Assistant leaves it alone. */
export function isSuperManaged(sessionId: string): boolean {
  return isSuperChild(sessionId) || isHandedOverSuperSession(sessionId);
}

// ─── The owner-activity lease (D7, plan r4 D18) ─────────────────────────────────

const leases = new Map<string, number>();

/** The owner typed in the super composer. No event goes in for OWNER_LEASE_MS; and the owner is
 *  plainly here, so the away counter starts over. */
export async function noteOwnerActivity(contextRoot: string, now = Date.now()): Promise<void> {
  const key = keyOf(contextRoot);
  leases.set(key, now);
  scheduleRetry(key, now + OWNER_LEASE_MS + 50);
  const s = await readSuperState(contextRoot, superSanitizeOpts());
  if (s.away.events > 0 || s.away.since !== null) {
    await writeSuper(contextRoot, (d) => { d.away = { since: null, events: 0 }; });
  }
}

export function leaseActive(contextRoot: string, now = Date.now()): boolean {
  const at = leases.get(keyOf(contextRoot));
  return at !== undefined && now - at < OWNER_LEASE_MS;
}

export function clearOwnerLease(contextRoot: string): void {
  leases.delete(keyOf(contextRoot));
}

/**
 * The bridge WROTE an owner message (not a slash command) into the super session — typed, or a
 * bar option click. Server-side, so a frame racing a `result` never lets the pump deliver inside
 * the owner's turn (D18): the lease is stamped; the running event turn is marked steered (it
 * spends no question attempt, r2-C3: marked BEFORE the batch is cleared) and stops being the
 * open batch (an `ask` written after this is about the owner's message, not the events); and an
 * open `ask` is closed: this message is its answer (D7).
 */
export function superOwnerSpoke(sessionId: string, now = Date.now()): void {
  const root = superRootOfSession(sessionId);
  if (!root) return;
  const key = keyOf(root);
  leases.set(key, now);
  scheduleRetry(key, now + OWNER_LEASE_MS + 50);
  const ob = openBatch.get(sessionId);
  if (ob) {
    for (const c of carried.get(key) ?? []) if (c.batch === ob.batch) c.steered = true;
    openBatch.delete(sessionId);
  }
  void track(closeOpenAsks(key));
}

async function closeOpenAsks(key: string): Promise<void> {
  const cur = await readSuperState(key, superSanitizeOpts());
  if (!cur.queue.some((q) => q.kind === 'ask' && q.state !== 'done')) return;
  await writeSuper(key, (s) => { for (const q of s.queue) if (q.kind === 'ask') q.state = 'done'; });
  void pumpSuper(key);
}

// ─── Event texts (server-authored header and last line; child text fenced) ──────

/** How the super agent writes to the owner (plan r4 D13). Shipped to every user: worded for
 *  anyone juggling many things, it names no condition. */
export const OWNER_VOICE = 'in his language and plain words, one subject, the result or what you need from him first, 2-4 short sentences, no ids, hashes, paths, commands or inside jargon unless he asks, an estimate of when anything still running is ready, at most one question and only at the end; name any irreversible or outward action (a push, a merge, a delete, a message sent) in plain words';

/** The last line of every `[super events]` turn. */
export const BATCH_LAST_LINE = [
  'These events already updated the job list the owner reads; he sees this turn as ONE line.',
  'A question: answer it with `dreamcontext super answer <child> <question id> "<option>"` only when the brief and the project settle it; otherwise escalate ONE clear question with `dreamcontext super queue ask <item> "<question>"`.',
  'Done, stuck or closed: set the row with `dreamcontext super brief <child> "<doing / next>"`; when a slot frees, start the next job with `dreamcontext super delegate --from <pool id>`. Write the owner nothing about them.',
  `If the owner writes to you during this turn, answer him normally (${OWNER_VOICE}); the no-message rule covers only your notes about the events. Then end your turn.`,
].join('\n');

function childLine(vault: string, s: SuperState, sid: string, now: number): string[] {
  const e = getChat(sid);
  const status = e ? activityOf(e, now) : 'gone';
  const row = s.children[sid]?.row;
  const lines = [`- child=${sid} status=${status}${row ? ` row=${row}` : ''}`];
  const brief = s.children[sid]?.brief || (e ? chatTopic(e) : '');
  if (brief) lines.push(wrapUntrusted(vault, `Brief: ${brief}`));
  const last = e?.lastAssistantText[e.lastAssistantText.length - 1];
  if (last) lines.push(wrapUntrusted(vault, `Last reply: ${last.length > 600 ? `${last.slice(0, 600)}…` : last}`));
  return lines;
}

/** One event inside a batch: the server's line, then the child's text fenced. */
function itemLines(vault: string, s: SuperState, item: SuperQueueItem, now: number): string[] {
  const sid = item.sessionId;
  const e = getChat(sid);
  const status = e ? activityOf(e, now) : 'gone';
  const ch = s.children[sid];
  let head = `- item=${item.id} child=${sid} event=${item.kind}`;
  if (item.kind === 'stuck' && ch?.stuckReason) head += ` reason=${ch.stuckReason}`;
  head += ` status=${status}`;
  const pq = item.kind === 'question' && e?.pendingQuestion && !e.pendingQuestion.isPermission ? e.pendingQuestion : null;
  if (pq && /^[A-Za-z0-9_.:-]{1,120}$/.test(pq.requestId)) head += ` question=${pq.requestId}`;
  const lines = [head];
  const brief = ch?.brief || (e ? chatTopic(e) : '');
  if (brief) lines.push(wrapUntrusted(vault, `Brief: ${brief}`));
  if (pq) {
    if (pq.text) lines.push(wrapUntrusted(vault, `Question: ${pq.text}`));
    if (pq.options.length) lines.push(wrapUntrusted(vault, `Options: ${pq.options.join(' | ')}`));
  }
  const last = e?.lastAssistantText[e.lastAssistantText.length - 1];
  if (last) lines.push(wrapUntrusted(vault, `Last reply: ${last.length > 600 ? `${last.slice(0, 600)}…` : last}`));
  return lines;
}

/** The text of a `[super events]` turn carrying `items`. Exported for tests. */
export function superBatchText(contextRoot: string, state: SuperState, items: readonly SuperQueueItem[], batch: string, now = Date.now()): string {
  const vault = superVaultName(contextRoot);
  return [
    `[super events] batch=${batch} items=${items.length}`,
    ...items.flatMap((it) => itemLines(vault, state, it, now)),
    BATCH_LAST_LINE,
  ].join('\n');
}

/** The text of a solo turn (handover, recap); any other item is a batch of one. Exported for tests. */
export function superEventText(contextRoot: string, state: SuperState, item: SuperQueueItem, now = Date.now(), batch = item.batch ?? newBatchId()): string {
  const vault = superVaultName(contextRoot);
  if (item.kind === 'handover') {
    const ids = Object.keys(state.children);
    return [
      `[super handover] item=${item.id} children=${ids.length}`,
      ...ids.flatMap((sid) => childLine(vault, state, sid, now)),
      `The owner handed the Chat screen over to you; every chat above is a card around you and a row in the job list. Write EVERY child's row line now with \`dreamcontext super brief <child> "<doing / next>"\`, arrange the cards if it helps, then tell the owner what is running (${OWNER_VOICE}). End your turn.`,
    ].join('\n');
  }
  if (item.kind === 'recap') {
    const ids = Object.keys(state.children);
    return [
      `[super recap] item=${item.id} children=${ids.length}`,
      ...ids.flatMap((sid) => childLine(vault, state, sid, now)),
      `The owner is back. Tell him what finished, what waits on him and what still runs, each with when it should be ready, unless you told him already (${OWNER_VOICE}). End your turn.`,
    ].join('\n');
  }
  return superBatchText(contextRoot, state, [item], batch, now);
}

// ─── The pump ───────────────────────────────────────────────────────────────────

const pumping = new Set<string>();
const again = new Set<string>();
const retry = new Map<string, { at: number; t: ReturnType<typeof setTimeout> }>();

function scheduleRetry(key: string, at: number): void {
  const cur = retry.get(key);
  if (cur && cur.at <= at) return;
  if (cur) clearTimeout(cur.t);
  const t = setTimeout(() => { retry.delete(key); void pumpSuper(key); }, Math.max(0, at - Date.now()));
  t.unref?.();
  retry.set(key, { at, t });
}

const SOLO: Partial<Record<QueueKind, number>> = { handover: 0, recap: 1 };
const BATCHED = new Set<QueueKind>(['question', 'done', 'gone', 'stuck']);

/**
 * What the next event turn carries (plan r4 D10): a pending handover or recap ALONE (handover
 * first); otherwise up to MAX_BATCH pending question/done/gone/stuck items, oldest first. Items
 * that are no longer true are dropped, never delivered: a question no longer asked, a `done` or
 * `stuck` whose row moved on (the child started working again), a `gone` whose child is live.
 */
export function nextBatch(state: SuperState): { items: SuperQueueItem[]; drop: string[] } {
  const pending = state.queue.filter((q) => q.state === 'pending').sort((a, b) => a.createdAt - b.createdAt);
  const solo = pending.filter((q) => SOLO[q.kind] !== undefined).sort((a, b) => (SOLO[a.kind] ?? 2) - (SOLO[b.kind] ?? 2) || a.createdAt - b.createdAt);
  if (solo.length) return { items: [solo[0]], drop: [] };
  const items: SuperQueueItem[] = [];
  const drop: string[] = [];
  for (const q of pending) {
    if (!BATCHED.has(q.kind)) continue;
    const row = state.children[q.sessionId]?.row;
    const stale = (q.kind === 'question' && !stillAsking(q))
      || (q.kind === 'done' && row !== 'done')
      || (q.kind === 'stuck' && row !== 'stuck')
      || (q.kind === 'gone' && isLive(getChat(q.sessionId)));
    if (stale) { drop.push(q.id); continue; }
    if (items.length < MAX_BATCH) items.push(q);
  }
  return { items, drop };
}

/** Why nothing can be delivered right now, or null when something can. `state` (when the caller
 *  has a fresh record) adds the single-question rule. Exported for tests. */
export function deliveryBlocker(contextRoot: string, now = Date.now(), state?: Pick<SuperState, 'queue'>): string | null {
  const key = keyOf(contextRoot);
  const idx = superIndex(key);
  if (!idx.enabled || !idx.session) return 'off';
  const inbox = inboxes.get(idx.session);
  if (!inbox || !inbox.attached()) return 'no_socket';
  const chat = getChat(idx.session);
  if (!chat) return 'no_chat';
  const act = activityOf(chat, now);
  if (act === 'starting') return 'starting';
  if (act !== 'idle' || !inbox.idle()) return 'busy';
  if (leaseActive(key, now)) return 'owner_typing';
  if (state && ownerQuestionOpen(state)) return 'owner_question';
  return null;
}

/** Work the inbox started that no caller awaits (pumps, registry-fed writes), so a test can wait
 *  for it before removing the vault ({@link _superInboxDrained}). Each entry never rejects. */
const inflight = new Set<Promise<void>>();

function track(p: Promise<unknown>): Promise<void> {
  const done = p.then(() => undefined, () => undefined);
  inflight.add(done);
  void done.then(() => { inflight.delete(done); });
  return done;
}

/** Deliver the next batch when D7 allows. Single-flight per vault; one turn per call. Never
 *  rejects: every caller fires and forgets it, and a record that cannot be written (the vault
 *  removed, a refused file) must end this pass, not the server. The next event pumps again. */
export function pumpSuper(contextRoot: string): Promise<void> {
  return track(pumpRun(keyOf(contextRoot)));
}

async function pumpRun(key: string): Promise<void> {
  if (pumping.has(key)) { again.add(key); return; }
  pumping.add(key);
  try {
    do {
      again.delete(key);
      await pumpOnce(key);
    } while (again.has(key));
  } finally {
    pumping.delete(key);
  }
}

/** A deliver that never settles must not hold the vault's pump forever. */
export const SUPER_DELIVER_TIMEOUT_MS = 30_000;

/** Run a deliver for at most SUPER_DELIVER_TIMEOUT_MS. Giving up CANCELS it: the deliver sees
 *  `cancelled()` and never writes its turn later, while the items stay `pending` (w5 Minor 2). */
function bounded(run: (cancelled: () => boolean) => Promise<boolean>): Promise<boolean> {
  let gaveUp = false;
  const cancelled = () => gaveUp;
  return new Promise((resolve) => {
    const t = setTimeout(() => { gaveUp = true; resolve(false); }, SUPER_DELIVER_TIMEOUT_MS);
    t.unref?.();
    let p: Promise<boolean>;
    try { p = run(cancelled); } catch { p = Promise.resolve(false); }
    // A write that lands in the same tick as the give-up still counts as not delivered here,
    // and the deliver checked `cancelled()` before writing, so it did not write.
    p.then((v) => { clearTimeout(t); resolve(v && !gaveUp); }, () => { clearTimeout(t); resolve(false); });
  });
}

/** Escalated questions the child no longer asks (respawn, take-back, gone) close: they never
 *  hold the single-question rule (D16). */
function closeStaleEscalations(s: SuperState): boolean {
  let changed = false;
  for (const q of s.queue) {
    if (q.kind === 'question' && q.state === 'escalated' && !stillAsking(q)) { q.state = 'done'; changed = true; }
  }
  return changed;
}

async function pumpOnce(key: string): Promise<void> {
  try { await settleCarried(key); } catch { /* the record could not be written: next turn end */ }
  const now = Date.now();
  const blocker = deliveryBlocker(key, now);
  const idx = superIndex(key);
  if (blocker === 'starting') {
    const chat = idx.session ? getChat(idx.session) : null;
    if (chat) scheduleRetry(key, Date.parse(chat.lastFrameAt) + STARTING_GRACE_MS + 50);
    return;
  }
  if (blocker === 'owner_typing') {
    const at = leases.get(key);
    if (at !== undefined) scheduleRetry(key, at + OWNER_LEASE_MS + 50);
    return;
  }
  if (blocker) return;
  const session = idx.session as string;
  const inbox = inboxes.get(session) as SuperInbox;
  let state: SuperState;
  try { state = await readSuperState(key, superSanitizeOpts()); } catch { return; }
  // A turn end recorded while the read waited (closeTurn defers it a tick): settle first, then
  // decide on the fresh record, and only if the super is still free (w5 Minor 1).
  if (turnsEnded.has(key)) {
    try {
      if (await settleCarried(key)) {
        if (deliveryBlocker(key)) return;
        state = await readSuperState(key, superSanitizeOpts());
      }
    } catch { return; }
  }
  try {
    if (closeStaleEscalations({ ...state, queue: state.queue.map((q) => ({ ...q })) })) {
      state = await writeSuper(key, (s) => { closeStaleEscalations(s); });
    }
    // The single-question rule (D16): while the owner has a question open, the super agent takes
    // no turn on its own; what piles up meanwhile goes in one batch when it closes.
    if (ownerQuestionOpen(state)) return;
    let { items, drop } = nextBatch(state);
    if (drop.length) {
      state = await writeSuper(key, (s) => { for (const q of s.queue) if (drop.includes(q.id) && q.state === 'pending') q.state = 'done'; });
      ({ items } = nextBatch(state));
    }
    if (!items.length) return;
    const batch = newBatchId();
    const solo = items.length === 1 && SOLO[items[0].kind] !== undefined;
    const text = solo ? superEventText(key, state, items[0], now, batch) : superBatchText(key, state, items, batch, now);
    const event: SuperEventFrame = solo
      ? { kind: items[0].kind as SuperEventKind, child: items[0].sessionId, batch }
      : { kind: 'batch', child: items[0].sessionId, batch, items: items.map((q) => ({ item: q.id, child: q.sessionId, kind: q.kind })) };
    let ok = false;
    try { ok = await bounded((cancelled) => inbox.deliver(text, event, cancelled)); } catch { ok = false; }
    if (!ok) return;
    // Taken in the same tick the write was confirmed: every end numbered after this one is this
    // turn's (or a later one's), every end before it belongs to an earlier turn.
    const seq = endSeq;
    markSuperEventTurn(session, true);
    openBatch.set(session, { batch, inboxId: inbox.id, root: key });
    // Carried BEFORE the record write, so an end arriving while it waits still finds it; a
    // carried item the write did not mark `delivered` is skipped when settled.
    carried.set(key, [...(carried.get(key) ?? []), ...items.map((q) => ({ itemId: q.id, inboxId: inbox.id, seq, batch }))]);
    const ids = new Set(items.map((q) => q.id));
    await writeSuper(key, (s) => {
      for (const it of s.queue) if (ids.has(it.id) && it.state === 'pending') { it.state = 'delivered'; it.batch = batch; }
    });
  } catch { /* the record could not be written: the next event pumps again */ }
}

// ─── Rows: settle, reconcile, sweep (plan r4 D5, D6, D15, D17) ──────────────────

const settleTimers = new Map<string, ReturnType<typeof setTimeout>>();
const goneTimers = new Map<string, ReturnType<typeof setTimeout>>();
const regraceTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** One stale sweep per handed-over vault, armed only while a row works (or is stale-stuck). */
const sweeps = new Map<string, ReturnType<typeof setTimeout>>();
let unsubscribe: (() => void) | null = null;

function clearTimer(map: Map<string, ReturnType<typeof setTimeout>>, sid: string): void {
  const t = map.get(sid);
  if (t) clearTimeout(t);
  map.delete(sid);
}

/** The settle test: the child is idle by the clock (`idle`, or `starting` past its grace). */
function settledIdle(e: ChatEntry | null, now: number): boolean {
  return !!e && activityOf(e, now) === 'idle';
}

/** An error turn that was neither interrupted nor a limit switch (D6). */
function errorTurn(e: ChatEntry | null): boolean {
  const lt = e?.lastTurn;
  return !!lt && lt.isError === true && !lt.interrupted && !lt.limited;
}

/** Push one `done`/`stuck` item for a child unless one is already pending. */
function pushRowItem(s: SuperState, sid: string, kind: 'done' | 'stuck', now: number): boolean {
  if (s.queue.some((q) => q.sessionId === sid && q.kind === kind && q.state === 'pending')) return false;
  s.queue.push({ id: newQueueId(), sessionId: sid, kind, state: 'pending', createdAt: now });
  countEvent(s);
  return true;
}

/** Close a child's pending done/stuck items: it moved on (D10). */
function closeRowItems(s: SuperState, sid: string): boolean {
  let changed = false;
  for (const q of s.queue) {
    if (q.sessionId === sid && (q.kind === 'done' || q.kind === 'stuck') && q.state === 'pending') { q.state = 'done'; changed = true; }
  }
  return changed;
}

/** The settle window ran out: still idle → `done` (or `stuck` for an error turn), exactly once:
 *  a row that already left working/asking adds nothing. */
function settleDraft(s: SuperState, sid: string, now: number): boolean {
  const ch = s.children[sid];
  if (!ch || ch.endedAt !== undefined) return false;
  delete ch.settling;
  if (ch.row !== undefined && ch.row !== 'working' && ch.row !== 'asking') return false;
  const e = getChat(sid);
  const stuck = errorTurn(e);
  setRow(ch, stuck ? 'stuck' : 'done', stuck ? 'error' : undefined, now);
  return pushRowItem(s, sid, stuck ? 'stuck' : 'done', now);
}

async function settleChild(root: string, sid: string): Promise<void> {
  if (!settledIdle(getChat(sid), Date.now())) return;
  let added = false;
  await writeSuper(root, (s) => {
    if (!s.enabled || !s.children[sid] || !settledIdle(getChat(sid), Date.now())) return;
    added = settleDraft(s, sid, Date.now());
  });
  if (added) void pumpSuper(root);
}

function armSettle(root: string, sid: string, ms = DONE_SETTLE_MS): void {
  clearTimer(settleTimers, sid);
  const t = setTimeout(() => {
    settleTimers.delete(sid);
    if (!superIndex(root).enabled) return;
    void track(settleChild(root, sid));
  }, Math.max(0, ms));
  t.unref?.();
  settleTimers.set(sid, t);
}

/**
 * Bring every row in line with the registry (D15). Mutates `s`; returns whether anything changed,
 * whether an item was added, and the settle windows to arm. A child the registry does not know
 * is skipped (the re-adoption grace decides it); a `gone` row whose child is live again takes its
 * activity. A missing row is set from the activity with no item. A `working` row whose child is
 * idle settles at once when its turn ended long enough ago, else arms the window; one gone
 * `stale` becomes `stuck` once; a `stuck` or `done` row that works again is `working`.
 */
export function reconcileDraft(s: SuperState, now: number, armed: (sid: string) => boolean): { changed: boolean; added: boolean; arm: Array<{ sid: string; ms: number }> } {
  let changed = false;
  let added = false;
  const arm: Array<{ sid: string; ms: number }> = [];
  for (const [sid, ch] of Object.entries(s.children)) {
    // An ended child (`super end`) is history: its row rests in done, never stuck or gone noise,
    // until `super resume` (or the owner reopening it) makes it a child again.
    if (ch.endedAt !== undefined) {
      if (setRow(ch, 'done', undefined, now)) changed = true;
      if (ch.settling) { delete ch.settling; changed = true; }
      continue;
    }
    const e = getChat(sid);
    if (!e) continue;
    const act = activityOf(e, now);
    if (ch.row === 'gone' && act !== 'gone') { delete ch.row; changed = true; }
    if (ch.row === undefined) {
      const derived: ChildRow | null = act === 'working' || act === 'stale' ? 'working' : act === 'asking' ? 'asking' : act === 'gone' ? null : 'done';
      if (derived) { setRow(ch, derived, undefined, now); changed = true; }
      continue;
    }
    if (ch.row === 'working' || ch.row === 'asking') {
      if (act === 'asking') { if (setRow(ch, 'asking', undefined, now)) changed = true; }
      else if (act === 'working' || act === 'starting') { if (setRow(ch, 'working', undefined, now)) changed = true; }
      else if (act === 'stale') {
        setRow(ch, 'stuck', 'stale', now);
        changed = true;
        if (pushRowItem(s, sid, 'stuck', now)) added = true;
      } else if (act === 'idle' && !armed(sid)) {
        const ended = e.lastTurn ? Date.parse(e.lastTurn.endedAt) : Number.NaN;
        if (Number.isFinite(ended) && now - ended >= DONE_SETTLE_MS) {
          if (settleDraft(s, sid, now)) added = true;
          changed = true;
        } else {
          arm.push({ sid, ms: Number.isFinite(ended) ? DONE_SETTLE_MS - (now - ended) : DONE_SETTLE_MS });
          if (setRow(ch, 'working', undefined, now)) changed = true;
          if (!ch.settling) { ch.settling = true; changed = true; }
        }
      }
    } else if (ch.row === 'stuck' || ch.row === 'done') {
      if (act === 'working' || act === 'asking') {
        setRow(ch, act === 'asking' ? 'asking' : 'working', undefined, now);
        closeRowItems(s, sid);
        changed = true;
      }
    }
    // The "bitiyor" chip is true only while a window really runs (r2-C2).
    const settling = armed(sid) || arm.some((a) => a.sid === sid);
    if (!!ch.settling !== settling) { if (settling) ch.settling = true; else delete ch.settling; changed = true; }
  }
  if (closeStaleEscalations(s)) changed = true;
  return { changed, added, arm };
}

/** Reconcile one vault's rows against the registry: read, and write only when something moves. */
export async function reconcileRows(contextRoot: string, now = Date.now()): Promise<void> {
  const key = keyOf(contextRoot);
  let s: SuperState;
  try { s = await readSuperState(key, superSanitizeOpts()); } catch { stopSweep(key); return; }
  if (!s.enabled) { stopSweep(key); return; }
  const armed = (sid: string) => settleTimers.has(sid);
  const probe = reconcileDraft(structuredClone(s), now, armed);
  if (!probe.changed) { for (const a of probe.arm) armSettle(key, a.sid, a.ms); syncSweep(key, s); return; }
  let result = probe;
  try {
    await writeSuper(key, (d) => { if (d.enabled) result = reconcileDraft(d, now, armed); });
  } catch { stopSweep(key); return; }
  for (const a of result.arm) armSettle(key, a.sid, a.ms);
  if (result.added) void pumpSuper(key);
}

/** Does this record need the sweep: handed over, and a row works or is stuck as stale. */
function needsSweep(s: SuperState): boolean {
  return s.enabled && Object.values(s.children).some((c) => c.endedAt === undefined && (c.row === 'working' || (c.row === 'stuck' && c.stuckReason === 'stale')));
}

function syncSweep(key: string, s: SuperState): void {
  if (!needsSweep(s)) { stopSweep(key); return; }
  if (sweeps.has(key)) return;
  const t = setTimeout(() => {
    sweeps.delete(key);
    void track(reconcileRows(key));
  }, STALE_SWEEP_MS);
  t.unref?.();
  sweeps.set(key, t);
}

/** Stop a vault's sweep (take-back, a refused record). */
export function stopSweep(contextRoot: string): void {
  const key = keyOf(contextRoot);
  const t = sweeps.get(key);
  if (t) clearTimeout(t);
  sweeps.delete(key);
}

/** Tests only: is a vault's sweep armed. */
export function _sweepArmed(contextRoot: string): boolean {
  return sweeps.has(keyOf(contextRoot));
}

// ─── Registry changes → rows and queue items ────────────────────────────────────

/** Close the child's open permission/question items whose request is no longer pending. */
export function resolveAnswered(s: SuperState, sid: string, pendingRequest: string | null): boolean {
  let changed = false;
  for (const q of s.queue) {
    if (q.sessionId !== sid || q.state === 'done') continue;
    if (q.kind !== 'permission' && q.kind !== 'question') continue;
    if (q.requestId && q.requestId === pendingRequest) continue;
    q.state = 'done';
    changed = true;
  }
  return changed;
}

/** The child moved (working, starting, idle): answered items close, the row follows, and only
 *  when something changes is anything written. */
async function onMoved(root: string, sid: string, status: 'working' | 'starting' | 'idle'): Promise<void> {
  const apply = (s: SuperState): { changed: boolean; resolved: boolean } => {
    // Read the child as it is NOW, inside the locked write: a turn that starts and asks at once
    // (working, then asking, in one burst of frames) lands its asking write first, and this one
    // must neither close the request it just opened nor move its row off `asking`.
    const live = getChat(sid);
    const asking = live?.status === 'asking';
    const resolved = resolveAnswered(s, sid, asking ? live?.pendingQuestion?.requestId ?? null : null);
    let changed = resolved;
    const ch = s.enabled && !asking ? s.children[sid] : undefined;
    if (ch && status === 'working') {
      if (setRow(ch, 'working')) changed = true;
      if (ch.settling) { delete ch.settling; changed = true; }
      if (closeRowItems(s, sid)) changed = true;
    }
    if (ch && status === 'idle' && (ch.row === undefined || ch.row === 'working' || ch.row === 'asking')) {
      if (setRow(ch, 'working')) changed = true;
      if (!ch.settling) { ch.settling = true; changed = true; }
    }
    return { changed, resolved };
  };
  const cur = await readSuperState(root, superSanitizeOpts());
  if (!apply(structuredClone(cur)).changed) return;
  let resolved = false;
  await writeSuper(root, (s) => { resolved = apply(s).resolved; });
  // An escalation that closed may free the single-question rule.
  if (resolved) void pumpSuper(root);
}

/** Queue one gone event for a child (one open item per child); its row is `gone` in the same
 *  write, so the row never says gone before the debounce believed it. */
async function addGone(root: string, sid: string): Promise<void> {
  let added = false;
  await writeSuper(root, (s) => {
    if (!s.enabled || !s.children[sid]) return;
    resolveAnswered(s, sid, null);
    setRow(s.children[sid], 'gone');
    if (s.queue.some((q) => q.sessionId === sid && q.kind === 'gone' && q.state === 'pending')) return;
    s.queue.push({ id: newQueueId(), sessionId: sid, kind: 'gone', state: 'pending', createdAt: Date.now() });
    countEvent(s);
    added = true;
  });
  if (added) void pumpSuper(root);
}

async function onAsking(root: string, entry: ChatEntry): Promise<void> {
  const q = entry.pendingQuestion;
  if (!q) return;
  const sid = entry.sessionId;
  let added = false;
  await writeSuper(root, (s) => {
    resolveAnswered(s, sid, q.requestId);
    if (!s.enabled || !s.children[sid]) return;
    setRow(s.children[sid], 'asking');
    if (s.queue.some((i) => i.sessionId === sid && i.requestId === q.requestId && i.state !== 'done')) return;
    s.queue.push({
      id: newQueueId(), sessionId: sid, kind: q.isPermission ? 'permission' : 'question',
      requestId: q.requestId, state: 'pending', createdAt: Date.now(),
    });
    countEvent(s);
    added = true;
  });
  if (added && !q.isPermission) void pumpSuper(root);
}

function armGone(root: string, sid: string, ms: number, map: Map<string, ReturnType<typeof setTimeout>>): void {
  clearTimer(map, sid);
  const t = setTimeout(() => {
    map.delete(sid);
    if (isLive(getChat(sid))) return;
    const idx = superIndex(root);
    if (!idx.enabled || !idx.children.has(sid)) return;
    void track(addGone(root, sid));
  }, ms);
  t.unref?.();
  map.set(sid, t);
}

/** Children `super resume` is reopening right now: their new process is the super's doing. */
const resuming = new Map<string, number>();

/** `super resume` brackets its window command with this, so the child's new process is not
 *  taken for the owner reopening it. Counted: two resumes in flight both hold it. */
export function noteResuming(sessionId: string, on: boolean): void {
  const n = (resuming.get(sessionId) ?? 0) + (on ? 1 : -1);
  if (n > 0) resuming.set(sessionId, n); else resuming.delete(sessionId);
}

/**
 * A chat process was just registered (agent-chat.ts). A NEW process of an ended child that
 * `super resume` did not start is the owner reopening it himself (Past chats): it is his,
 * recorded adopted (so ending, changing or reopening it again takes his word) and no longer
 * ended (so a later park or relaunch never closes his tab). While handed over it is a child
 * again, as every open chat of the project is: its card and the hand-over note come back.
 * Returns the write (tests await it); the route does not wait.
 */
export function noteChatStarted(sessionId: string): Promise<void> {
  if (resuming.has(sessionId)) return Promise.resolve();
  const root = superRootOfEnded(sessionId);
  return root ? track(reopenedByOwner(root, sessionId)) : Promise.resolve();
}

async function reopenedByOwner(root: string, sid: string): Promise<void> {
  await writeSuper(root, (s) => {
    const x = s.children[sid];
    if (!x || x.endedAt === undefined) return;
    delete x.endedAt;
    x.adopted = true;
    if (!s.enabled) return;
    ensureChatContainer(s, sid, x.brief.slice(0, 120));
    s.notes[sid] = 'handover';
  });
}

function onChange({ entry, from }: ChatChange): void {
  const sid = entry.sessionId;
  const superRoot = superRootOfSession(sid);
  if (superRoot) {
    // The super chat settled: the next batch may go.
    if (entry.status === 'idle' || entry.status === 'starting') void pumpSuper(superRoot);
    return;
  }
  const root = superRootOfChild(sid);
  if (!root) return;
  if (entry.status !== 'gone') { clearTimer(goneTimers, sid); clearTimer(regraceTimers, sid); }
  if (entry.status !== 'idle') clearTimer(settleTimers, sid);
  if (!superIndex(root).enabled) return;
  // Failures are swallowed by `track` (a write that could not land: the next change retries).
  switch (entry.status) {
    case 'asking':
      void track(onAsking(root, entry));
      break;
    case 'starting':
    case 'working':
      void track(onMoved(root, sid, entry.status));
      break;
    case 'idle':
      void track(onMoved(root, sid, 'idle'));
      armSettle(root, sid);
      break;
    case 'gone':
      // An old child's teardown after its replacement already registered under this id.
      if (isLive(getChat(sid))) return;
      armGone(root, sid, GONE_DEBOUNCE_MS, goneTimers);
      return;
  }
  // A child's first frame after it registered (a respawn, a restored tab): its row is checked
  // against what the registry now says (D15).
  if (from === 'starting') void track(reconcileRows(root));
}

/** Subscribe to the registry (idempotent). */
export function wireSuperInbox(): void {
  if (!unsubscribe) unsubscribe = onChatChange(onChange);
}

/**
 * At server boot, BEFORE the first registry event: prime the in-memory index over every vault,
 * subscribe, fill the glance's head cache, give each handed-over vault's children that are not
 * registered yet the re-adoption grace (they re-register under their pin id as the window
 * restores its tabs), and reconcile the rows (which arms the sweep for any that work).
 */
export async function startSuperInbox(contextRoots: readonly string[]): Promise<void> {
  await primeSuperIndex(contextRoots, superSanitizeOpts());
  wireSuperInbox();
  await Promise.all(contextRoots.map(async (root) => {
    let s: SuperState;
    try { s = await readSuperState(root, superSanitizeOpts()); } catch { return; }
    noteHead(root, s);
    if (!s.enabled) return;
    for (const sid of Object.keys(s.children)) {
      if (!isLive(getChat(sid))) armGone(keyOf(root), sid, READOPT_GRACE_MS, regraceTimers);
    }
    syncSweep(keyOf(root), s);
    await reconcileRows(root);
  }));
}

/** Tests only: the inbox the bridge attached for a super session. */
export function _superInboxFor(sessionId: string): SuperInbox | null {
  return inboxes.get(sessionId) ?? null;
}

/** Tests only: resolves once nothing the inbox started is still running (work that starts more
 *  work is waited for too), so a test's vault can be removed with no write still landing in it. */
export async function _superInboxDrained(): Promise<void> {
  while (inflight.size > 0) await Promise.all([...inflight]);
}

/** Tests only. */
export function _resetSuperInbox(): void {
  for (const m of [settleTimers, goneTimers, regraceTimers, sweeps]) { for (const t of m.values()) clearTimeout(t); m.clear(); }
  for (const r of retry.values()) clearTimeout(r.t);
  retry.clear();
  inboxes.clear();
  resuming.clear();
  carried.clear();
  turnsEnded.clear();
  openBatch.clear();
  eventTurns.clear();
  leases.clear();
  heads.clear();
  pumping.clear();
  again.clear();
  unsubscribe?.();
  unsubscribe = null;
}
