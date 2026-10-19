import { createHash, randomBytes } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { listVaults } from '../vaults.js';
import { wrapUntrusted } from '../assistant/autonomy.js';
import { GONE_DEBOUNCE_MS, IDLE_DEBOUNCE_MS, eventText } from '../assistant/delegations.js';
import {
  STARTING_GRACE_MS, activityOf, chatTopic, getChat, onChatChange, type ChatChange, type ChatEntry,
} from '../assistant/chat-registry.js';
import { pushFrame, tokenOfSession } from '../window-control.js';
import {
  isSuperChild, primeSuperIndex, readSuperState, superIndex, superRootOfChild, superRootOfSession,
  updateSuperState, type SanitizeOpts,
} from './store.js';
import {
  MAX_CONTAINERS, OWNER_LEASE_MS, READOPT_GRACE_MS, SUPER_FRAME_STATE,
  type QueueKind, type SuperContainer, type SuperEventKind, type SuperQueueItem,
  type SuperState, type SuperStateView,
} from './types.js';

/**
 * The Super Agent's INBOX: one question queue per vault (plan-r7 D6, D7, D13, D16).
 *
 * A separate module from the Assistant's (`assistant/delegations.ts`), which stays as it is; the
 * two share only `eventText` (its optional header and last line are ours).
 *
 * FED BY THE REGISTRY. Every change of a recorded child of a handed-over vault (`onChatChange`)
 * becomes a queue item in `state/.super-agent.json`:
 *   asking (permission) → a `permission` item at once. NEVER delivered to the super agent: the
 *                         owner's queue strip answers it through the child's own ChatSession.
 *   asking (question)   → a `question` item, delivered to the super agent.
 *   idle                → an `idle` item after IDLE_DEBOUNCE_MS (a turn that restarts at once
 *                         is not news).
 *   gone                → a `gone` item after GONE_DEBOUNCE_MS, unless the id is live again (a
 *                         respawn under the same id).
 *   leaving `asking`    → the child's open permission/question items are done (the owner
 *                         answered in the child's tab, or the super agent did).
 *
 * THE PUMP delivers ONE item per turn, and only when every rule of D7 holds: handed over, the
 * super chat's socket attached, the super chat idle by `activityOf` (a `starting` chat counts
 * only after STARTING_GRACE_MS, 30 s) and by the bridge's own turn count, and the owner has not
 * typed in the super composer for OWNER_LEASE_MS (15 s). A question is re-read against the
 * registry before it goes: no longer asking that request → dropped.
 *
 * Persisted with the record, so a restart keeps the queue. After a restart a recorded child
 * absent from the registry gets READOPT_GRACE_MS to register again before it is `gone`.
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

// ─── The queue head (D16: what reaches the owner) ───────────────────────────────

/**
 * What the owner's queue strip leads with, and the ONE super row the notch glance may carry:
 * the oldest open permission (permissions jump the line), else the oldest escalated question.
 * A second escalation waits behind the first, so the owner never has two at once.
 */
export function superQueueHead(state: Pick<SuperState, 'queue'>): SuperQueueItem | null {
  const byAge = [...state.queue].sort((a, b) => a.createdAt - b.createdAt);
  return byAge.find((q) => q.kind === 'permission' && q.state !== 'done')
    ?? byAge.find((q) => q.kind === 'question' && q.state === 'escalated')
    ?? null;
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

/** Everything a write of the record owes: the glance's head cache and the window's push. */
export function afterSuperWrite(contextRoot: string, state: SuperState): void {
  noteHead(contextRoot, state);
  pushSuperState(contextRoot, state);
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

export interface SuperInbox {
  id: string;
  /** The super chat's pin id. */
  sessionId: string;
  /** A socket is bound right now (not detached). */
  attached(): boolean;
  /** No turn of the bridge's own is in flight and no owner message is held. */
  idle(): boolean;
  /** Write one injected turn. Resolves true only when it was written. Once `cancelled()` is true
   *  (the inbox gave up waiting) it must never write: the item is still `pending`. */
  deliver(text: string, kind: SuperEventKind, child: string, cancelled?: () => boolean): Promise<boolean>;
}

const inboxes = new Map<string, SuperInbox>();

/** The super chat came up (or a respawn of it): attach, push the state, pump. Last wins. */
export function attachSuperInbox(inbox: SuperInbox): () => void {
  inboxes.set(inbox.sessionId, inbox);
  superSocketAttached(inbox.sessionId);
  return () => {
    if (inboxes.get(inbox.sessionId)?.id === inbox.id) inboxes.delete(inbox.sessionId);
    // The process is gone: no turn-end will ever come for what it carried. Its exit IS the
    // end of that turn (M1).
    endTurn(inbox.sessionId, inbox.id);
  };
}

/** The super chat's socket (re)attached: it gets the state at once, and the queue a chance. */
export function superSocketAttached(sessionId: string): void {
  const root = superRootOfSession(sessionId);
  if (!root) return;
  void track(readSuperState(root, superSanitizeOpts()).then((s) => {
    noteHead(root, s);
    pushSuperState(root, s);
    void pumpSuper(root);
  }).catch(() => { /* a refused record: the mode is off there */ }));
}

/**
 * The super chat's bridge closed a turn (its own `turnsInFlight` is back to 0). The registry's
 * `idle` arrives BEFORE that, on the same `result` frame, so a pump it starts still reads the
 * bridge as busy and stops; this is the edge that lets the next pending item go. Not a poll:
 * one call per closed turn.
 */
export function superTurnEnded(sessionId: string): void {
  endTurn(sessionId, inboxes.get(sessionId)?.id ?? null);
}

/** Every turn end gets the next number: a carried question is settled only by an end numbered
 *  after its own delivery, so an earlier turn's late end never settles it early. */
let endSeq = 0;
interface Carried { itemId: string; inboxId: string; seq: number }
interface TurnEnd { inboxId: string | null; seq: number }
/** Delivered questions not settled yet, per vault: a LIST, never overwritten, so a turn end the
 *  pump learns of late still finds every question it carried (w5 Minor 1). */
const carried = new Map<string, Carried[]>();
/** Turn ends (or process exits) since the last pump, per vault, with the inbox that ended it. */
const turnsEnded = new Map<string, TurnEnd[]>();

function endTurn(sessionId: string, inboxId: string | null): void {
  const root = superRootOfSession(sessionId);
  if (!root) return;
  const key = keyOf(root);
  const list = turnsEnded.get(key) ?? [];
  endSeq += 1;
  list.push({ inboxId, seq: endSeq });
  turnsEnded.set(key, list);
  void pumpSuper(key);
}

/** The child's own question, as the owner's strip shows it after the super agent left it
 *  unsettled twice (plain text; fenced wherever an agent reads it). */
function childQuestionText(sessionId: string): string {
  const pq = getChat(sessionId)?.pendingQuestion;
  if (!pq) return 'A child is waiting for an answer.';
  return pq.options.length ? `${pq.text} (options: ${pq.options.join(' | ')})` : pq.text;
}

/**
 * The turn that carried a delivered question ended (or its process did) and the question is
 * still `delivered`: answered, escalated or dropped would have moved it. The FIRST time it goes
 * back to `pending` and is delivered again under D7; the SECOND time it is escalated to the
 * owner with the child's own question (M1). Runs inside the pump's single flight, so it always
 * follows the write that marked the item delivered. Settles EVERY carried question an end
 * reaches; a write that fails puts them (and the ends) back for the next pump. Returns whether
 * it settled anything.
 */
async function settleCarried(key: string): Promise<boolean> {
  const ended = turnsEnded.get(key);
  if (!ended) return false;
  turnsEnded.delete(key);
  const list = carried.get(key) ?? [];
  const reached = (c: Carried) => ended.some((e) => e.seq > c.seq && (e.inboxId === null || e.inboxId === c.inboxId));
  const settle = list.filter(reached);
  const keep = list.filter((c) => !reached(c));
  if (!settle.length) return false;
  if (keep.length) carried.set(key, keep); else carried.delete(key);
  try {
    await writeSuper(key, (s) => {
      for (const c of settle) {
        const it = s.queue.find((q) => q.id === c.itemId);
        if (!it || it.kind !== 'question' || it.state !== 'delivered') continue;
        if (!stillAsking(it)) { it.state = 'done'; continue; }
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

// ─── Owner messages held across a super process's death (M2) ───────────────────

/** Owner messages a dead super process held during an event turn, for its successor (same pin
 *  id): never dropped. Every key has a death: unclaimed after HELD_TTL_MS, they are given up. */
const heldOwnerTexts = new Map<string, { texts: string[]; timer: ReturnType<typeof setTimeout> }>();
export const HELD_TTL_MS = 10 * 60_000;

export function stashHeldOwnerTexts(sessionId: string, texts: readonly string[]): void {
  if (!texts.length) return;
  const prev = heldOwnerTexts.get(sessionId);
  if (prev) clearTimeout(prev.timer);
  const timer = setTimeout(() => heldOwnerTexts.delete(sessionId), HELD_TTL_MS);
  timer.unref?.();
  heldOwnerTexts.set(sessionId, { texts: [...(prev?.texts ?? []), ...texts], timer });
}

/** The successor takes them, exactly once. */
export function takeHeldOwnerTexts(sessionId: string): string[] {
  const e = heldOwnerTexts.get(sessionId);
  if (!e) return [];
  clearTimeout(e.timer);
  heldOwnerTexts.delete(sessionId);
  return e.texts;
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

// ─── The owner-activity lease (D7) ──────────────────────────────────────────────

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

// ─── Event texts (server-authored header and last line; child text fenced) ──────

const LAST_LINE: Record<'question' | 'idle' | 'gone', (sid: string, item: string) => string> = {
  question: (sid, item) => `Answer it with \`dreamcontext super answer ${sid} <question id above> "<option>"\` only when the brief and the project settle it; otherwise escalate ONE clear question with \`dreamcontext super queue ask ${item} "<question for the owner>"\`. Then end your turn.`,
  idle: (sid) => `It finished a turn. Update its reminder with \`dreamcontext super brief ${sid} "<line>"\` if it changed, decide the next step, and keep your reply to one or two sentences.`,
  gone: () => 'Its chat closed. Note it in one sentence.',
};

function childLine(vault: string, s: SuperState, sid: string, now: number): string[] {
  const e = getChat(sid);
  const status = e ? activityOf(e, now) : 'gone';
  const lines = [`- child=${sid} status=${status}`];
  const brief = s.children[sid]?.brief || (e ? chatTopic(e) : '');
  if (brief) lines.push(wrapUntrusted(vault, `Brief: ${brief}`));
  const last = e?.lastAssistantText[e.lastAssistantText.length - 1];
  if (last) lines.push(wrapUntrusted(vault, `Last reply: ${last.length > 600 ? `${last.slice(0, 600)}…` : last}`));
  return lines;
}

/** The text of the turn that delivers `item`. Exported for tests. */
export function superEventText(contextRoot: string, state: SuperState, item: SuperQueueItem, now = Date.now()): string {
  const vault = superVaultName(contextRoot);
  if (item.kind === 'handover') {
    const ids = Object.keys(state.children);
    return [
      `[super handover] item=${item.id} children=${ids.length}`,
      ...ids.flatMap((sid) => childLine(vault, state, sid, now)),
      'The owner handed the Chat screen over to you; every chat above is a container around you. Write each child\'s one-line reminder with `dreamcontext super brief <child> "<line>"`, arrange the containers if it helps, then tell the owner in two sentences what is running. End your turn.',
    ].join('\n');
  }
  if (item.kind === 'recap') {
    const ids = Object.keys(state.children);
    return [
      `[super recap] item=${item.id} children=${ids.length}`,
      ...ids.flatMap((sid) => childLine(vault, state, sid, now)),
      'The owner is back. Recap in at most three short lines: what finished, what waits on the owner, what is still running. End your turn.',
    ].join('\n');
  }
  const status = item.kind === 'question' ? 'asking' : item.kind === 'idle' ? 'idle' : 'gone';
  const sid = item.sessionId;
  const text = eventText(sid, vault, status, getChat(sid), {
    header: `[super event] item=${item.id} child=${sid} status=${status}`,
    lastLine: LAST_LINE[item.kind as 'question' | 'idle' | 'gone'](sid, item.id),
  });
  const brief = state.children[sid]?.brief;
  if (!brief) return text;
  const lines = text.split('\n');
  lines.splice(1, 0, wrapUntrusted(vault, `Brief: ${brief}`));
  return lines.join('\n');
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

/** Is the child still asking exactly this question (and is it a question)? */
function stillAsking(item: SuperQueueItem): boolean {
  const c = getChat(item.sessionId);
  return !!c && c.status === 'asking' && !!c.pendingQuestion && !c.pendingQuestion.isPermission
    && c.pendingQuestion.requestId === item.requestId;
}

const ORDER: Partial<Record<QueueKind, number>> = { handover: 0, recap: 1 };

/** The next item the super agent should hear (never a permission). */
export function nextDeliverable(state: SuperState): SuperQueueItem | null {
  return state.queue
    .filter((q) => q.state === 'pending' && q.kind !== 'permission')
    .sort((a, b) => (ORDER[a.kind] ?? 2) - (ORDER[b.kind] ?? 2) || a.createdAt - b.createdAt)[0] ?? null;
}

/** Why nothing can be delivered right now, or null when something can. Exported for tests. */
export function deliveryBlocker(contextRoot: string, now = Date.now()): string | null {
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

/** Deliver the next item when D7 allows. Single-flight per vault; one item per call. Never
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
 *  `cancelled()` and never writes its turn later, while the item stays `pending` (w5 Minor 2). */
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
  for (let guard = 0; guard < 50; guard += 1) {
    const item = nextDeliverable(state);
    if (!item) return;
    if (item.kind === 'question' && !stillAsking(item)) {
      // Answered meanwhile (in the child's tab, or it moved on): dropped, never delivered.
      state = await writeSuper(key, (s) => { const it = s.queue.find((q) => q.id === item.id); if (it) it.state = 'done'; });
      continue;
    }
    const text = superEventText(key, state, item);
    let ok = false;
    try { ok = await bounded((cancelled) => inbox.deliver(text, item.kind as SuperEventKind, item.sessionId, cancelled)); } catch { ok = false; }
    if (!ok) return;
    // Taken in the same tick the write was confirmed: every end numbered after this one is this
    // turn's (or a later one's), every end before it belongs to an earlier turn.
    const seq = endSeq;
    markSuperEventTurn(session, true);
    // Carried BEFORE the record write, so an end arriving while it waits still finds it; a
    // carried item the write did not mark `delivered` is skipped when settled.
    if (item.kind === 'question') carried.set(key, [...(carried.get(key) ?? []), { itemId: item.id, inboxId: inbox.id, seq }]);
    await writeSuper(key, (s) => {
      const it = s.queue.find((q) => q.id === item.id);
      if (it && it.state === 'pending') it.state = item.kind === 'question' ? 'delivered' : 'done';
    });
    return;
  }
}

// ─── Registry changes → queue items ─────────────────────────────────────────────

const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
const goneTimers = new Map<string, ReturnType<typeof setTimeout>>();
const regraceTimers = new Map<string, ReturnType<typeof setTimeout>>();
let unsubscribe: (() => void) | null = null;

function clearTimer(map: Map<string, ReturnType<typeof setTimeout>>, sid: string): void {
  const t = map.get(sid);
  if (t) clearTimeout(t);
  map.delete(sid);
}

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

async function resolveIfAnswered(root: string, sid: string, pendingRequest: string | null): Promise<void> {
  const cur = await readSuperState(root, superSanitizeOpts());
  const probe: SuperState = { ...cur, queue: cur.queue.map((q) => ({ ...q })) };
  if (!resolveAnswered(probe, sid, pendingRequest)) return;
  await writeSuper(root, (s) => { resolveAnswered(s, sid, pendingRequest); });
}

/** Queue one idle/gone event for a child (one open item of a kind per child). */
async function addEvent(root: string, sid: string, kind: 'idle' | 'gone'): Promise<void> {
  let added = false;
  await writeSuper(root, (s) => {
    if (!s.enabled || !s.children[sid]) return;
    if (kind === 'gone') resolveAnswered(s, sid, null);
    if (s.queue.some((q) => q.sessionId === sid && q.kind === kind && q.state === 'pending')) return;
    s.queue.push({ id: newQueueId(), sessionId: sid, kind, state: 'pending', createdAt: Date.now() });
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

function armIdle(root: string, sid: string): void {
  clearTimer(idleTimers, sid);
  const t = setTimeout(() => {
    idleTimers.delete(sid);
    const now = getChat(sid);
    if (!now || now.status !== 'idle' || !superIndex(root).enabled) return;
    void track(addEvent(root, sid, 'idle'));
  }, IDLE_DEBOUNCE_MS);
  t.unref?.();
  idleTimers.set(sid, t);
}

function armGone(root: string, sid: string, ms: number, map: Map<string, ReturnType<typeof setTimeout>>): void {
  clearTimer(map, sid);
  const t = setTimeout(() => {
    map.delete(sid);
    if (isLive(getChat(sid))) return;
    const idx = superIndex(root);
    if (!idx.enabled || !idx.children.has(sid)) return;
    void track(addEvent(root, sid, 'gone'));
  }, ms);
  t.unref?.();
  map.set(sid, t);
}

function onChange({ entry }: ChatChange): void {
  const sid = entry.sessionId;
  const superRoot = superRootOfSession(sid);
  if (superRoot) {
    // The super chat settled: the next item may go.
    if (entry.status === 'idle' || entry.status === 'starting') void pumpSuper(superRoot);
    return;
  }
  const root = superRootOfChild(sid);
  if (!root) return;
  if (entry.status !== 'gone') { clearTimer(goneTimers, sid); clearTimer(regraceTimers, sid); }
  if (entry.status !== 'idle') clearTimer(idleTimers, sid);
  if (!superIndex(root).enabled) return;
  // Failures are swallowed by `track` (a write that could not land: the next change retries).
  switch (entry.status) {
    case 'asking':
      void track(onAsking(root, entry));
      return;
    case 'starting':
    case 'working':
      void track(resolveIfAnswered(root, sid, null));
      return;
    case 'idle':
      void track(resolveIfAnswered(root, sid, null));
      armIdle(root, sid);
      return;
    case 'gone':
      // An old child's teardown after its replacement already registered under this id.
      if (isLive(getChat(sid))) return;
      armGone(root, sid, GONE_DEBOUNCE_MS, goneTimers);
  }
}

/** Subscribe to the registry (idempotent). */
export function wireSuperInbox(): void {
  if (!unsubscribe) unsubscribe = onChatChange(onChange);
}

/**
 * At server boot, BEFORE the first registry event: prime the in-memory index over every vault,
 * subscribe, fill the glance's head cache, and give each handed-over vault's children that are
 * not registered yet the re-adoption grace (they re-register under their pin id as the window
 * restores its tabs).
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
  for (const m of [idleTimers, goneTimers, regraceTimers]) { for (const t of m.values()) clearTimeout(t); m.clear(); }
  for (const r of retry.values()) clearTimeout(r.t);
  retry.clear();
  inboxes.clear();
  carried.clear();
  turnsEnded.clear();
  heldOwnerTexts.clear();
  eventTurns.clear();
  leases.clear();
  heads.clear();
  pumping.clear();
  again.clear();
  unsubscribe?.();
  unsubscribe = null;
}
