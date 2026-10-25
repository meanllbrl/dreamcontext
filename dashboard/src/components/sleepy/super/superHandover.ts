/**
 * The hand-over's decisions, pure (task chat-gets-a-super-agent-mode…, plan-r7 D5, D9, D16,
 * D17 window side). AgentSurface owns the state and the DOM; everything here is a question it
 * asks with plain data, so the rules are tested in Node without a window:
 *
 *  - which session IS the Super Agent (never a tab, never placed, never adopted, never an orphan);
 *  - what the hand-over posts (`adopt` + `titles`);
 *  - where a delegated child lands (a NON-active tab of the active pane — so take-back shows the
 *    owner's own layout plus the children, D5);
 *  - which children are "marked" (no ask alarm, no project-chip `waiting`, D16);
 *  - which queue item is the strip's head, and when a new head may raise the ONE alarm;
 *  - how `super answer` maps the agent's choices onto the child's AskUserQuestion;
 *  - which window verbs the browser executor refuses while handed over (D4b's re-check).
 *
 * React-free and DOM-free: imports only the window's mirror of the server types.
 */
import {
  ABOUT_AGENDA_RE, MAX_ABOUT_LINE, MAX_REPLY_QUOTE, REPLY_TO_RE, SUPER_EVENT_PREFIXES, msgRef, type ChildRow, type QueueKind, type SuperChild, type SuperEventKind, type SuperQueueItem, type SuperState,
} from '../../../lib/superTypes';

// ─── Who is the Super Agent ────────────────────────────────────────────────────

/**
 * D9's ONE predicate: a roster entry is the Super Agent's session when it runs in `super` mode
 * OR holds the vault's recorded super session id. Used by the tab save, the restore's grouping
 * loop, the orphan reconcile, the corner chips, the dock and the adoption body, so none of
 * them can disagree about it.
 */
export function isSuperSession(
  meta: { mode?: string; claudeId?: string } | undefined | null,
  superSession: string | null | undefined,
): boolean {
  if (!meta) return false;
  if (meta.mode === 'super') return true;
  return !!superSession && !!meta.claudeId && meta.claudeId === superSession;
}

/** One open tab as the hand-over sees it. `kind` is the TRANSPORT kind (an automation run on
 *  the chat screen is a chat). */
export interface HandoverTab {
  id: string;
  claudeId: string;
  title: string;
  kind: string;
  mode?: string;
  dormant?: boolean;
}

/** The modes an agent may start a chat in (`window new`, `super delegate`). */
export const AGENT_SPAWN_MODES = ['basic', 'plan', 'develop'] as const;
export type AgentSpawnMode = typeof AGENT_SPAWN_MODES[number];

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const MAX_TITLE = 120;

/**
 * The body of `POST /api/super/enable` (D17): the pin ids of the project's open CHAT tabs and
 * each one's title (the container's reminder until the agent writes a brief). Never the Super
 * Agent itself, never the Assistant's own mode, never a dormant tab (nothing is running behind
 * it, so the server would drop it anyway), never twice.
 */
export function adoptionBody(tabs: readonly HandoverTab[], superSession: string | null | undefined): {
  adopt: string[];
  titles: Record<string, string>;
} {
  const adopt: string[] = [];
  const titles: Record<string, string> = {};
  for (const t of tabs) {
    if (t.kind !== 'chat' || t.dormant) continue;
    if (isSuperSession(t, superSession) || t.mode === 'assistant') continue;
    if (!SESSION_ID_RE.test(t.claudeId) || t.claudeId in titles) continue;
    adopt.push(t.claudeId);
    // eslint-disable-next-line no-control-regex
    titles[t.claudeId] = (t.title || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_TITLE);
  }
  return { adopt, titles };
}

/** The tabs that cannot be adopted (terminals: a shell, a terminal Claude) — the Terminals row. */
export function terminalTabs<T extends HandoverTab>(tabs: readonly T[]): T[] {
  return tabs.filter((t) => t.kind === 'shell' || t.kind === 'agent');
}

// ─── Marked children (D16) ─────────────────────────────────────────────────────

/**
 * Is `id` one of the record's OWN keys? `children` and `notes` are plain objects parsed from the
 * server, and the ids indexing them come from frames and the server too: `children['__proto__']`
 * or `children['constructor']` would read the prototype, never a child.
 */
export function hasOwnKey(record: Readonly<Record<string, unknown>> | null | undefined, id: string): boolean {
  return !!record && typeof id === 'string' && Object.prototype.hasOwnProperty.call(record, id);
}

/** The pin ids of the children the owner is NOT pinged about: only while handed over. */
export function markedChildren(state: Pick<SuperState, 'enabled' | 'children'> | null | undefined): ReadonlySet<string> {
  if (!state?.enabled) return new Set();
  return liveChildIds(state.children);
}

/** The record's children minus the ended ones (`super end`): an ended child is history. */
export function liveChildIds(children: SuperState['children']): Set<string> {
  return new Set(Object.entries(children).filter(([, c]) => c?.endedAt === undefined).map(([k]) => k));
}

/** Pin ids of the children `super end` closed: a tab of theirs restored dormant (a relaunch)
 *  is closed when the record names them, so an ended child never comes back as a tab. */
export function endedChildIds(state: Pick<SuperState, 'children'> | null | undefined): Set<string> {
  if (!state) return new Set();
  return new Set(Object.entries(state.children).filter(([, c]) => c?.endedAt !== undefined).map(([k]) => k));
}

/** How long past the server's own delegate deadline a just-opened child stays marked before
 *  the record names it: the server records it at once when the window answers, so only a
 *  delegate the server gave up on ever runs this out. */
export const DELEGATE_MARK_GRACE_MS = 10_000;
/** No deadline on the frame (an older server): the server's 35 s wait plus the grace. */
const DELEGATE_MARK_DEFAULT_MS = 35_000 + DELEGATE_MARK_GRACE_MS;

/** Until when a child this window just opened for a `delegate` stays marked without the record. */
export function delegateMarkUntil(args: Record<string, unknown>, now: number = Date.now()): number {
  return typeof args.deadline === 'number' && Number.isFinite(args.deadline)
    ? args.deadline + DELEGATE_MARK_GRACE_MS
    : now + DELEGATE_MARK_DEFAULT_MS;
}

/**
 * The marks the window applies (D16): the record's children, plus every child this window just
 * opened for a `delegate` that the server's push has not named yet — so a fresh child is quiet
 * from its first frame, not only once `super_state` lands. A just-opened child leaves the
 * pending map when the record names it, when its mark runs out (the server never recorded it:
 * it is an ordinary chat again), or when the mode is off.
 */
export function childMarks(
  state: Pick<SuperState, 'enabled' | 'children'> | null | undefined,
  delegated: ReadonlyMap<string, number>,
  now: number,
): { marked: Set<string>; delegated: Map<string, number>; nextExpiry: number | null } {
  if (!state?.enabled) return { marked: new Set(), delegated: new Map(), nextExpiry: null };
  const marked = liveChildIds(state.children);
  const pending = new Map<string, number>();
  let nextExpiry: number | null = null;
  for (const [id, until] of delegated) {
    if (marked.has(id) || until <= now) continue;
    pending.set(id, until);
    marked.add(id);
    nextExpiry = nextExpiry === null ? until : Math.min(nextExpiry, until);
  }
  return { marked, delegated: pending, nextExpiry };
}

// ─── Hand-over / take-back results that arrive late ────────────────────────────

/**
 * A counter of the owner's hand-over actions (a hand-over, a take-back, a reversed flight). Each
 * action takes a generation before its request; a result is applied only while its generation is
 * still the newest, so a `disable` answer that lands after the owner reversed the take-back never
 * overwrites the `enable` that reversed it (and leaves the children unmarked, AC6).
 */
export function actionGeneration(): { begin: () => number; isCurrent: (gen: number) => boolean } {
  let n = 0;
  return { begin: () => ++n, isCurrent: (gen) => gen === n };
}

// ─── One answer per queue head ─────────────────────────────────────────────────

/** Which head item the strip already answered (`key` = item id + request id), and whether that
 *  request has since left the child's cards (the answer took it off). */
export interface AnswerLatch { key: string | null; cleared: boolean }
export const OPEN_LATCH: AnswerLatch = { key: null, cleared: false };

/**
 * A click on Allow, Deny or an option: answer only when this head item was not answered yet and
 * the child's socket can carry it (`ChatSession.answer` drops the card even when nothing was
 * sent, so a click on a closed socket would lose the request). A second click — a double-click
 * lands before React re-renders — sends nothing.
 */
export function latchClick(latch: AnswerLatch, key: string, canSend: boolean): { send: boolean; latch: AnswerLatch } {
  if (latch.key === key || !canSend) return { send: false, latch };
  return { send: true, latch: { key, cleared: false } };
}

/**
 * Re-read on every render: a new head reopens the strip; the answered request leaving the
 * child's cards is noted; the same request coming BACK afterwards (the server re-sent it: the
 * answer never landed) reopens it too.
 */
export function latchSeen(latch: AnswerLatch, key: string | null, pendingPresent: boolean): AnswerLatch {
  if (latch.key === null) return latch;
  if (latch.key !== key) return OPEN_LATCH;
  if (!pendingPresent) return latch.cleared ? latch : { key: latch.key, cleared: true };
  return latch.cleared ? OPEN_LATCH : latch;
}

// ─── The queue strip ───────────────────────────────────────────────────────────

/** An item that is the OWNER's to answer: a permission (never the agent's), a child waiting on
 *  something only he can do (`owner`: his from birth), or a question the Super Agent escalated
 *  with words of its own. */
export function needsOwner(item: SuperQueueItem): boolean {
  if (item.state === 'done') return false;
  return item.kind === 'permission' || item.kind === 'owner' || item.state === 'escalated';
}

/**
 * The strip's head (D7): a permission jumps the line — the oldest pending one first — then the
 * oldest escalated question. Nothing else reaches the owner.
 */
export function queueHead(state: Pick<SuperState, 'queue'> | null | undefined): SuperQueueItem | null {
  const items = (state?.queue ?? []).filter(needsOwner);
  if (items.length === 0) return null;
  const byAge = (a: SuperQueueItem, b: SuperQueueItem) => a.createdAt - b.createdAt;
  const permissions = items.filter((q) => q.kind === 'permission').sort(byAge);
  if (permissions.length) return permissions[0];
  return items.sort(byAge)[0];
}

/** How many items wait on the owner (the strip's "n more", the header button's dot). */
export function ownerQueueCount(state: Pick<SuperState, 'queue'> | null | undefined): number {
  return (state?.queue ?? []).filter(needsOwner).length;
}

/** Items whose alarm this window already raised, per project: the strip remounts (the stage is
 *  redrawn, the mode re-entered) and a ref would forget, ringing the same head again. Bounded:
 *  the oldest ids go first (an id never comes back once answered). */
const raisedHeads = new Map<string, string[]>();
const RAISED_HEADS_CAP = 200;

/**
 * The ONE alarm per item (AC6, owner 2026-10-21 "yalnız bir kez"): true the first time `head`
 * is an item the owner must answer in `vault`, false for every later sighting of it, wherever
 * the strip is drawn from.
 */
export function headAlarmOnce(vault: string, head: SuperQueueItem | null): boolean {
  if (!head || !needsOwner(head)) return false;
  const seen = raisedHeads.get(vault) ?? [];
  if (seen.includes(head.id)) return false;
  seen.push(head.id);
  if (seen.length > RAISED_HEADS_CAP) seen.splice(0, seen.length - RAISED_HEADS_CAP);
  raisedHeads.set(vault, seen);
  return true;
}

/** Test-only. */
export function _resetRaisedHeads(): void {
  raisedHeads.clear();
}

/**
 * The chat the window reports the owner as looking at (lib/focusedChat.ts). Handed over, the
 * Super Agent's stage is what he sees: its session, never the pane hidden under the stage, so a
 * reply he is reading pings nothing and one he is not reading is news (owner, 2026-10-21).
 */
export function presenceChatId(a: {
  expanded: boolean;
  isMobile: boolean;
  handedOver: boolean;
  superSession: string | null;
  focusedChat: string | null;
}): string | null {
  if (!a.expanded || a.isMobile) return null;
  if (a.handedOver) return a.superSession;
  return a.focusedChat;
}

/** Does a session link (a banner, a notch row) name the handed-over Super Agent? Then it opens
 *  the stage: the super chat is never a tab, so resuming it as one would fork it. */
export function linkOpensSuperStage(claudeId: string, state: Pick<SuperState, 'enabled' | 'session'> | null | undefined): boolean {
  return !!state?.enabled && !!state.session && state.session === claudeId;
}

/** The width a head's option buttons needed, learned the one time they overflowed the pill. */
export interface OptionsFit { key: string; need: number }

/**
 * Does the pill show its option buttons (end review r8)? An answer you cannot undo is never a
 * cut label: the options keep their full width, and when they do not all fit the pill shows
 * Reply only (the owner answers through the Super Agent). Decided on mount and on resize, never
 * on hover. Shown and overflowing by `overflow` px: the row needed `width + overflow`, so hide.
 * Hidden: back only once the row is that wide again (no flip-flop at the edge). A new head
 * starts shown, to be measured.
 */
export function optionsFit(prev: OptionsFit | null, key: string, width: number, overflow: number, shown: boolean): { show: boolean; fit: OptionsFit | null } {
  const known = prev && prev.key === key ? prev : null;
  if (shown) return overflow > 1 ? { show: false, fit: { key, need: width + overflow } } : { show: true, fit: known };
  return known ? { show: width >= known.need, fit: known } : { show: true, fit: null };
}

// ─── New session ───────────────────────────────────────────────────────────────

/** Is the owner's "New session" on its way? A fresh item still pending or delivered (the server
 *  sweeps one a restart left behind), or the pane rotating. The button greys while it is. */
export function freshPending(state: Pick<SuperState, 'queue'> & { rotating?: boolean }): boolean {
  return state.rotating === true || state.queue.some((q) => q.kind === 'fresh' && (q.state === 'pending' || q.state === 'delivered'));
}

// ─── Injected turns ────────────────────────────────────────────────────────────

/** Which prefix an injected super turn starts with, per the `super_event` kind. */
export function superEventPrefix(kind: string): typeof SUPER_EVENT_PREFIXES[number] {
  if (kind === 'recap') return '[super recap]';
  if (kind === 'handover') return '[super handover]';
  if (kind === 'fresh') return '[super fresh]';
  if (kind === 'batch') return '[super events]';
  return '[super event]';
}

/** The text of an event chip the window adds live (the protocol never echoes a user frame):
 *  the prefix, the kind, and the child it is about. */
export function superEventText(kind: string, child: string, batch?: SuperBatchFrame): string {
  // A batch stands for the server's text with the same header and item lines, so the live
  // chip and a history replay are read by ONE parser (`superBatchOf`).
  if (kind === 'batch' && batch) {
    const id = /^[A-Za-z0-9_-]{1,64}$/.test(batch.batch) ? batch.batch : 'b';
    const lines = batch.items.slice(0, 8).map((i) => `- item=${safeToken(i.item)} child=${safeToken(i.child)} event=${safeToken(i.kind)}`);
    return [`[super events] batch=${id} items=${lines.length}`, ...lines].join('\n');
  }
  const prefix = superEventPrefix(kind);
  const k = kind.replace(/[^a-z]/g, '').slice(0, 20);
  const c = child.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);
  return [prefix, k, c].filter(Boolean).join(' ');
}

/** A user item that is an injected super turn (live chip or history replay), or null. */
export function superEventOf(text: string): { prefix: string; rest: string } | null {
  if (typeof text !== 'string') return null;
  const head = text.trimStart();
  for (const p of SUPER_EVENT_PREFIXES) {
    if (head.startsWith(p)) return { prefix: p, rest: head.slice(p.length).trim() };
  }
  return null;
}

/** The event kinds the window accepts on a `super_event` frame. */
export function knownEventKind(kind: string): kind is SuperEventKind {
  return kind === 'question' || kind === 'idle' || kind === 'gone' || kind === 'recap' || kind === 'handover' || kind === 'batch' || kind === 'fresh';
}

/** A `super_event` batch frame's payload (plan r4 D10): the batch id and what it carries. */
export interface SuperBatchFrame { batch: string; items: Array<{ item: string; child: string; kind: string }> }

function safeToken(v: string): string {
  return String(v).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);
}

/** What an injected turn's text carries, for a live chip and a replay alike: its kind
 *  (`batch`, `recap`, `handover`, or an old single event's kind), the batch id, and the
 *  children it is about with what happened to each. Reads only server-written lines. */
export function superBatchOf(text: string): { kind: string; batch: string | null; items: Array<{ child: string; kind: string }> } | null {
  const ev = superEventOf(text);
  if (!ev) return null;
  if (ev.prefix === '[super recap]') return { kind: 'recap', batch: null, items: [] };
  if (ev.prefix === '[super handover]') return { kind: 'handover', batch: null, items: [] };
  if (ev.prefix === '[super fresh]') return { kind: 'fresh', batch: null, items: [] };
  if (ev.prefix === '[super event]') {
    const [k, c] = ev.rest.split(/\s+/);
    // A replay of the server's old text (`item=… child=… status=…`) or the live chip (`kind child`).
    const child = /child=(\S+)/.exec(ev.rest)?.[1] ?? (k && !k.includes('=') ? (c ?? '') : '');
    const kind = /status=(\S+)/.exec(ev.rest)?.[1] ?? (k && !k.includes('=') ? k : 'other');
    return { kind: kind === 'asking' ? 'question' : kind, batch: null, items: child ? [{ child, kind }] : [] };
  }
  const batch = /^batch=([A-Za-z0-9_-]+)/.exec(ev.rest)?.[1] ?? null;
  const items: Array<{ child: string; kind: string }> = [];
  // Only the server's own lines: a fenced block (child text) is skipped whole, so a child that
  // writes "- item=… event=done" never adds a name to the line (security review Minor 1).
  let fenced = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('<untrusted-project-output')) { fenced = !line.includes('</untrusted-project-output>'); continue; }
    if (fenced) { if (line.includes('</untrusted-project-output>')) fenced = false; continue; }
    const m = /^- item=\S+ child=(\S+) event=(\S+)/.exec(line);
    if (m) items.push({ child: m[1], kind: m[2] });
  }
  return { kind: 'batch', batch, items };
}

// ─── The event line (plan r4 D2, D8) ─────────────────────────────────────────────

interface EventItemLike { kind: string; id: string; text?: string; superEvent?: string; name?: string; input?: unknown }

/** One event turn as the centre draws it: the turn's anchor (the injected user item), what it
 *  carried, how many commands the super agent ran in it other than `dreamcontext super`, and
 *  whether it renders in full (its batch is one the super agent asked the owner in). */
export interface SuperEventGroup {
  anchor: string;
  kind: string;
  batch: string | null;
  items: Array<{ child: string; kind: string }>;
  commands: number;
  full: boolean;
  /** Ids of the items the compact line stands for (the anchor excluded). */
  folded: string[];
}

function isSuperCommand(it: EventItemLike): boolean {
  if (it.kind !== 'tool' || it.name !== 'Bash') return false;
  const cmd = (it.input && typeof it.input === 'object' ? (it.input as { command?: unknown }).command : undefined);
  return typeof cmd === 'string' && /^\s*dreamcontext\s+super\b/.test(cmd);
}

/**
 * Fold each event turn of a slice into ONE line (pure). A turn runs from its injected item to
 * the next user item (an owner message, steered or not, ends it and renders as his bubble) or
 * the next injected one. A turn whose batch is in `ownerBatches`, or that the owner expanded,
 * keeps every item. A recap is never kept flat: its whole turn is drawn inside the recap card,
 * which is open by default (owner 2026-10-23). Built per windowed slice, so a group never
 * straddles a window edge.
 */
export function groupSuperEventTurns<T extends EventItemLike>(
  items: readonly T[],
  opts: { ownerBatches: readonly string[]; expanded: ReadonlySet<string> },
): { kept: T[]; groups: Map<string, SuperEventGroup> } {
  const groups = new Map<string, SuperEventGroup>();
  const kept: T[] = [];
  let open: SuperEventGroup | null = null;
  const owner = new Set(opts.ownerBatches);
  for (const it of items) {
    const ev = it.kind === 'user' && typeof it.text === 'string' ? superBatchOf(it.text) : null;
    if (it.kind === 'user') open = null;
    if (ev) {
      const full = ev.kind !== 'recap' && ((ev.batch !== null && owner.has(ev.batch)) || opts.expanded.has(it.id));
      open = { anchor: it.id, kind: ev.kind, batch: ev.batch, items: ev.items, commands: 0, full, folded: [] };
      groups.set(it.id, open);
      kept.push(it);
      continue;
    }
    if (open) {
      if (it.kind === 'tool' && !isSuperCommand(it)) open.commands += 1;
      if (!open.full) { open.folded.push(it.id); continue; }
    }
    kept.push(it);
  }
  return { kept, groups };
}

/** The words of an event line (D13: which jobs, what happened), at most 3 names then "+N". */
export function eventLine(group: Pick<SuperEventGroup, 'kind' | 'items'>, titleFor: (child: string) => string): { names: Array<{ child: string; title: string }>; more: number; kinds: string[] } {
  const seen = new Set<string>();
  const names: Array<{ child: string; title: string }> = [];
  for (const i of group.items) {
    if (seen.has(i.child)) continue;
    seen.add(i.child);
    names.push({ child: i.child, title: titleFor(i.child) || i.child.slice(0, 8) });
  }
  const kinds = [...new Set(group.items.map((i) => (i.kind === 'asking' ? 'question' : i.kind)))];
  return { names: names.slice(0, 3), more: Math.max(0, names.length - 3), kinds: kinds.length ? kinds : [group.kind] };
}

// ─── Status tone and model chip (owner 2026-10-21) ───────────────────────────────

/** The ONE status -> tone map every card, ring, frame, dot and job row reads (superTone.css
 *  turns the tone into a colour token). Colour never travels alone: the state word stays. */
export type StatusTone = 'working' | 'idle' | 'asking' | 'ended' | 'starting';
export function toneOfStatus(kind: string): StatusTone {
  if (kind === 'working') return 'working';
  if (kind === 'asking') return 'asking';
  if (kind === 'ended') return 'ended';
  if (kind === 'starting') return 'starting';
  return 'idle';
}
export function toneOfRow(row: ChildRow): StatusTone {
  if (row === 'working') return 'working';
  if (row === 'asking' || row === 'waiting') return 'asking';
  if (row === 'stuck' || row === 'gone') return 'ended';
  return 'idle';
}

/** "Opus · medium": the model a child really runs (its session's spawn values, else what the
 *  record stored), never a guess; null when neither is known. */
export function modelChip(model: string | undefined | null, effort: string | undefined | null): string | null {
  const m = (model ?? '').trim();
  if (!m) return null;
  const family = /opus/i.test(m) ? 'Opus' : /sonnet/i.test(m) ? 'Sonnet' : /haiku/i.test(m) ? 'Haiku' : /fable/i.test(m) ? 'Fable' : m.replace(/^claude-/, '').slice(0, 16);
  const e = (effort ?? '').trim().toLowerCase();
  return e ? `${family} · ${e}` : family;
}

// ─── The agenda: the super agent's notepad (owner 2026-10-22 19:15) ──────────────

/** The agenda's three sections, in the order the owner reads them. */
export type AgendaSection = 'waiting' | 'now' | 'done';
export const AGENDA_SECTIONS: readonly AgendaSection[] = ['waiting', 'now', 'done'];
/** `needsYou`: a child waiting on something only the owner can do (an unrun run card, a secret, a checklist). */
export type AgendaChip = 'permission' | 'question' | 'ask' | 'queued' | 'needsYou';
export interface AgendaRow {
  key: string;
  section: AgendaSection;
  /** The line: a pad note's own words; for an open question, who asks. */
  text: string;
  /** An open question's own words (its second line). */
  line?: string;
  /** An open question to the owner: its queue item, its child (none for the super's own), its kind. */
  item?: string;
  sid?: string;
  chip?: AgendaChip;
  /** A pad note's id (`super note done <id>`). */
  note?: string;
  at: number;
}
export interface JobLook {
  /** The child's live status kind in this window, or null when it has no session here. */
  live: (sid: string) => string | null;
  titleFor: (sid: string) => string;
  /** The job's name: the child's tab title (falls back to `titleFor`). */
  nameFor?: (sid: string) => string;
  modelFor?: (sid: string) => string | null;
  superTitle: string;
}

/** A child's row, from the record, or from live status when the record has none (a v1 record). */
export function rowOf(child: Pick<SuperChild, 'row'>, live: string | null): ChildRow {
  if (child.row) return child.row;
  if (live === 'working' || live === 'starting') return 'working';
  if (live === 'asking') return 'asking';
  if (live === 'ended') return 'gone';
  return 'done';
}

/** A job's name as the owner reads it: a delegated brief's run suffix (" · develop opus/high",
 *  the orchestration guide's `<job> · <mode> <model>/<effort>`) is the agent's bookkeeping. */
export function plainJobName(name: string): string {
  return name.replace(/\s+·\s+(basic|plan|develop)\b[^·]*$/i, '').trim() || name;
}

function isQuestionOpen(state: Pick<SuperState, 'queue'>): boolean {
  return state.queue.some((q) => (q.kind === 'question' || q.kind === 'ask') && q.state === 'escalated');
}

/**
 * The agenda, composed from the record (never copied). Pure. It is the super agent's NOTEPAD
 * (`state.pad`, written with `super note`), never a mirror of its children: Now and Done are only
 * its own lines. Waiting on you adds, before its own lines, every question that is open with the
 * owner right now (`needsOwner`, head first; the questions held behind an open one, "queued"),
 * so nothing he must answer is missing from it. Done: newest first.
 */
export function superNotepad(state: Pick<SuperState, 'queue' | 'pad'>, look: JobLook): Record<AgendaSection, AgendaRow[]> {
  const out: Record<AgendaSection, AgendaRow[]> = { waiting: [], now: [], done: [] };
  const head = queueHead(state);
  const owner = state.queue.filter(needsOwner).sort((a, b) => (a.id === head?.id ? -1 : b.id === head?.id ? 1 : a.createdAt - b.createdAt));
  const chipOf = (k: QueueKind): AgendaChip => (k === 'permission' ? 'permission' : k === 'ask' ? 'ask' : k === 'owner' ? 'needsYou' : 'question');
  const nameOf = (sid: string) => plainJobName(look.nameFor?.(sid) || look.titleFor(sid));
  for (const q of owner) {
    const own = q.kind === 'ask' || q.kind === 'approval';
    out.waiting.push({
      key: `q:${q.id}`, section: 'waiting', item: q.id, ...(own ? {} : { sid: q.sessionId }),
      text: own ? look.superTitle : nameOf(q.sessionId),
      // A permission row shows only the child's own request (the bar draws it); never the super's words.
      line: q.kind === 'permission' ? '' : (q.ownerText ?? ''),
      chip: chipOf(q.kind), at: q.createdAt,
    });
  }
  if (isQuestionOpen(state)) {
    // A team job's question is the member's, asked of him in AI Team: no child here to name.
    for (const q of state.queue.filter((x) => x.kind === 'question' && x.state === 'pending' && !x.team).sort((a, b) => a.createdAt - b.createdAt)) {
      out.waiting.push({ key: `q:${q.id}`, section: 'waiting', item: q.id, sid: q.sessionId, text: nameOf(q.sessionId), line: '', chip: 'queued', at: q.createdAt });
    }
  }
  for (const p of state.pad ?? []) {
    out[p.section].push({ key: `n:${p.id}`, section: p.section, text: p.text, note: p.id, at: p.at });
  }
  out.done.sort((a, b) => b.at - a.at);
  return out;
}

// ─── Writing about one agenda line (owner 2026-10-23) ────────────────────────────

/** What a message written about an agenda line names: a pad note (with the line as he saw it)
 *  or an open question's queue item (no words: they are a child's). */
export interface AgendaAbout { kind: 'note' | 'item'; id: string; section: AgendaSection; line?: string }

const ABOUT_ID = /^[A-Za-z0-9_-]{1,40}$/;

/** A note's words as its `line:` carries them: one line, no control characters, at most
 *  MAX_ABOUT_LINE characters (counted whole, never half a character). */
function aboutLine(text: string): string {
  const flat = text.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(flat).slice(0, MAX_ABOUT_LINE).join('').trim();
}

/**
 * The block a message about this row opens with (the composer's About chip carries it): the
 * header, and for a note `line: "<its words>"`. A question row carries only its id and
 * section: its words are a child's, and the super reads them fenced from `super state`.
 * '' for a row that names neither.
 */
export function agendaAboutBlock(row: Pick<AgendaRow, 'section' | 'note' | 'item' | 'text'>): string {
  if (row.note && ABOUT_ID.test(row.note)) {
    return `[About agenda line note=${row.note} section=${row.section}]\nline: ${JSON.stringify(aboutLine(row.text))}`;
  }
  if (row.item && ABOUT_ID.test(row.item)) return `[About agenda line item=${row.item} section=${row.section}]`;
  return '';
}

/** The words the About chip and strip read, in the window's language. */
export interface AboutWords {
  /** "About" */
  about: string;
  /** "{name}'s question" */
  question: string;
  /** "Super's question" */
  superQuestion: string;
  /** "a question": a question no longer open (whose it was is not known any more). */
  aQuestion: string;
}
export const ABOUT_WORDS_EN: AboutWords = { about: 'About', question: "{name}'s question", superQuestion: "Super's question", aQuestion: 'a question' };

const ABOUT_CHIP_CHARS = 60;
const clip = (s: string, n: number) => { const a = Array.from(s); return a.length > n ? `${a.slice(0, n - 1).join('').trimEnd()}…` : s; };

/** The About chip's name: "About: <the note>" (clipped), or for a question "About: <child>'s
 *  question" / "About: Super's question". The window's words only; never sent. */
export function agendaAboutChipName(row: Pick<AgendaRow, 'note' | 'item' | 'sid' | 'text'>, words: AboutWords = ABOUT_WORDS_EN): string {
  if (row.note) return `${words.about}: ${clip(aboutLine(row.text), ABOUT_CHIP_CHARS)}`;
  const who = row.sid ? words.question.replace('{name}', () => clip(aboutLine(row.text), 40)) : words.superQuestion;
  return `${words.about}: ${who}`;
}

/**
 * The strip above a sent bubble: a note reads its line as he saw it; a question reads whose it
 * is only while it is still open in the live record (the super's own: "Super's question"), and
 * a neutral "a question" otherwise. Nothing from the message's own text names a child.
 */
export function agendaAboutStrip(
  about: AgendaAbout,
  open: readonly Pick<SuperQueueItem, 'id' | 'kind' | 'state' | 'sessionId'>[],
  nameFor: (sid: string) => string,
  words: AboutWords = ABOUT_WORDS_EN,
): { label: string; text: string } {
  if (about.kind === 'note') return { label: words.about, text: about.line ?? '' };
  const q = open.find((x) => x.id === about.id && x.state !== 'done');
  if (!q) return { label: words.about, text: words.aQuestion };
  if (q.kind === 'ask' || q.kind === 'approval') return { label: words.about, text: words.superQuestion };
  const name = plainJobName(nameFor(q.sessionId) || '');
  return { label: words.about, text: name ? words.question.replace('{name}', () => name) : words.aQuestion };
}

/**
 * A sent message split into the agenda line it is about and the owner's own words. The block
 * counts only at the very start; anything malformed (a header with junk after it, a note with
 * no readable `line:`, a question carrying words) is NOT a block: null, and the text is
 * returned untouched, so the bubble shows what was sent.
 */
export function splitAgendaAbout(text: string): { about: AgendaAbout | null; text: string } {
  const none = { about: null, text };
  if (typeof text !== 'string') return { about: null, text: '' };
  const m = ABOUT_AGENDA_RE.exec(text);
  if (!m) return none;
  const kind = m[1] as 'note' | 'item';
  let rest = text.slice(m[0].length);
  if (rest !== '' && !rest.startsWith('\n')) return none;
  let line: string | undefined;
  const lineHead = /^\nline: ([^\n]*)/.exec(rest);
  if (kind === 'note') {
    if (!lineHead) return none;
    try {
      const parsed: unknown = JSON.parse(lineHead[1]);
      if (typeof parsed !== 'string') return none;
      line = parsed;
    } catch { return none; }
    rest = rest.slice(lineHead[0].length);
    if (rest !== '' && !rest.startsWith('\n')) return none;
  } else if (lineHead) {
    return none;
  }
  return {
    about: { kind, id: m[2], section: m[3] as AgendaSection, ...(line !== undefined ? { line } : {}) },
    text: rest.replace(/^\n+/, ''),
  };
}

// ─── Replying to one message (owner 2026-10-23) ──────────────────────────────────

/** A message replying to one earlier message (its ↩): whose it was, its reference (a scroll
 *  anchor) and the quote as he saw it. */
export interface ReplyAbout { kind: 'reply'; ref: string; from: 'super' | 'owner'; quote: string }
/** What a sent message is about: an agenda line, or a message it replies to. */
export type MessageAbout = AgendaAbout | ReplyAbout;

/** A reply's quote: one line, no control characters, at most MAX_REPLY_QUOTE characters. */
function replyQuote(text: string): string {
  const flat = text.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(flat).slice(0, MAX_REPLY_QUOTE).join('').trim();
}

/**
 * The block a reply opens with (the composer's About chip carries it, the agenda's own chip):
 * the header with the target's reference, then `quote: "<its first words>"`. Never the whole
 * message: the super wrote it and knows it. `refText` is the target's text exactly as it was
 * sent or shown (its reference is hashed from it); `quoteText` what the quote reads (his own
 * words, without the block his message opened with), by default the same.
 */
export function replyAboutBlock(refText: string, from: 'super' | 'owner', quoteText: string = refText): string {
  return `[Reply to message ref=${msgRef(refText)} from=${from}]\nquote: ${JSON.stringify(replyQuote(quoteText))}`;
}

/** The words the reply chip reads, in the window's language. */
export interface ReplyWords { chipSuper: string; chipOwn: string }
export const REPLY_WORDS_EN: ReplyWords = { chipSuper: 'Reply to Super', chipOwn: 'Your message' };

/** The reply chip's name: "Reply to Super: <quote>" / "Your message: <quote>", clipped. */
export function replyAboutChipName(quoteText: string, from: 'super' | 'owner', words: ReplyWords = REPLY_WORDS_EN): string {
  return `${from === 'super' ? words.chipSuper : words.chipOwn}: ${clip(replyQuote(quoteText), ABOUT_CHIP_CHARS)}`;
}

function splitReplyAbout(text: string): { about: ReplyAbout | null; text: string } {
  const none = { about: null, text };
  const m = REPLY_TO_RE.exec(text);
  if (!m) return none;
  const rest = text.slice(m[0].length);
  const head = /^\nquote: ([^\n]*)/.exec(rest);
  if (!head) return none;
  let quote: string;
  try {
    const parsed: unknown = JSON.parse(head[1]);
    if (typeof parsed !== 'string') return none;
    quote = parsed;
  } catch { return none; }
  const words = rest.slice(head[0].length);
  if (words !== '' && !words.startsWith('\n')) return none;
  return { about: { kind: 'reply', ref: m[1], from: m[2] as 'super' | 'owner', quote }, text: words.replace(/^\n+/, '') };
}

/**
 * A sent message split into what it is about (an agenda line or the message it replies to) and
 * the owner's own words. Same rule as `splitAgendaAbout`: only at offset 0, malformed = null and
 * the text untouched.
 */
export function splitAbout(text: string): { about: MessageAbout | null; text: string } {
  if (typeof text !== 'string') return { about: null, text: '' };
  const agenda = splitAgendaAbout(text);
  return agenda.about ? agenda : splitReplyAbout(text);
}

// ─── Layout of the panes while handed over ─────────────────────────────────────

export interface PaneShape { id: string; tabs: string[]; active: string }

/**
 * Where a delegated child lands (D5): a NON-active tab of the active pane, so the owner's
 * layout is untouched and take-back shows it plus the children. With no pane at all, the child
 * gets one pane of its own (it is then that pane's only — and so active — tab).
 */
export function placeDelegatedChild(
  panes: readonly PaneShape[],
  activePaneId: string,
  sid: string,
  mintPaneId: () => string,
): { panes: PaneShape[]; activePaneId: string } {
  if (panes.some((p) => p.tabs.includes(sid))) return { panes: [...panes], activePaneId };
  if (panes.length === 0) {
    const id = mintPaneId();
    return { panes: [{ id, tabs: [sid], active: sid }], activePaneId: id };
  }
  const target = panes.some((p) => p.id === activePaneId) ? activePaneId : panes[0].id;
  return {
    panes: panes.map((p) => (p.id === target ? { ...p, tabs: [...p.tabs, sid] } : p)),
    activePaneId: target,
  };
}

/**
 * The ONE child that mounts its full (read-only) chat besides the centre (plan-r8 F11, §0
 * FE-minors: one slot name covers half and present): the half card's child, else the first
 * presented chat. Null when neither names a recorded child.
 */
export function shownChild(state: Pick<SuperState, 'containers' | 'children' | 'view'> | null | undefined): string | null {
  if (!state) return null;
  const ids = state.view.mode === 'half' && state.view.card ? [state.view.card]
    : state.view.mode === 'present' ? state.view.cards ?? [] : [];
  for (const id of ids) {
    const c = state.containers.find((x) => x.id === id);
    if (c?.kind === 'chat' && hasOwnKey(state.children, c.ref)) return c.ref;
  }
  return null;
}

/**
 * D9's homing while handed over: only the centre (the Super Agent) and the shown slot (the
 * shown child) are homed; every other session goes to the garage. Not handed over: each
 * pane's active tab, as always.
 */
export function homedSessions(opts: {
  handedOver: boolean;
  superSid: string | null;
  shownSid: string | null;
  paneActives: readonly string[];
}): Set<string> {
  if (!opts.handedOver) return new Set(opts.paneActives.filter(Boolean));
  return new Set([opts.superSid, opts.shownSid].filter((x): x is string => !!x));
}

// ─── The window verbs while handed over (D4b, the browser's re-check) ─────────

export type SuperCaller = 'super' | 'child' | 'other';

/** The window verbs the Super Agent's own verbs travel as (`super send`, `super update`), each
 *  into one tab that must be a marked child. */
export const SUPER_CHILD_VERBS = ['send', 'model', 'effort', 'mode'] as const;

/**
 * Refuse a window verb the server already refuses, in the browser too: the Super Agent drives
 * the screen with `dreamcontext super`, never `dreamcontext window`; a child may not open or
 * split chats (the cap must see every child). Returns the refusal, or null.
 */
export function superWindowRefusal(
  caller: SuperCaller,
  verb: string,
  handedOver: boolean,
  send?: { target: SuperSendTarget | null; superSession: string | null; children: ReadonlySet<string> },
): string | null {
  if (caller === 'super') {
    // `super send <child>` arrives as `window send`, and `super update <child>` as `window
    // model|effort|mode`, down the Super Agent's own socket: the only window verbs it may run,
    // and only into one of its marked children.
    if (!(SUPER_CHILD_VERBS as readonly string[]).includes(verb)) return 'the Super Agent drives the screen with `dreamcontext super`';
    return superSendRefusal(send?.target ?? null, send?.superSession ?? null, send?.children ?? new Set());
  }
  if (caller === 'child' && handedOver && (verb === 'new' || verb === 'split')) return 'a Super Agent child cannot open chats';
  return null;
}

/** The tab a `send` (or an `update` verb) names, as the window knows it: its internal sid, the
 *  pin id its roster entry holds, and the conversation id its LIVE session runs (null when
 *  nothing is running). */
export interface SuperSendTarget { sid: string; pin: string; conversation: string | null }

/**
 * Re-check a Super Agent `send` or `update` verb (the server already did): the target must resolve to a tab
 * whose sid, pin id and live conversation id all agree, that is a MARKED child (so the mode is
 * on), and that is never the Super Agent itself. Returns the refusal, or null.
 */
export function superSendRefusal(target: SuperSendTarget | null, superSession: string | null, children: ReadonlySet<string>): string | null {
  if (!target || !target.sid || !target.pin) return 'no such child in this window';
  if (target.conversation !== target.pin) return 'that tab is not running the child it names';
  if (superSession && (target.pin === superSession || target.conversation === superSession)) return 'the Super Agent cannot send to itself';
  if (!children.has(target.pin)) return 'only a child of the handed-over Super Agent can be sent to';
  return null;
}

/** The tabs a window verb may see: never the Super Agent; for a child only itself and the
 *  terminals (no sibling); for the Super Agent (its `send`) only its marked children. */
export function windowTabsFor<T extends { tab: string; kind: string }>(
  tabs: readonly T[],
  opts: { caller: SuperCaller; self: string; superSession: string | null; children: ReadonlySet<string> },
): T[] {
  return tabs.filter((t) => {
    if (opts.superSession && t.tab === opts.superSession) return false;
    if (opts.caller === 'super') return t.kind === 'chat' && opts.children.has(t.tab);
    if (opts.caller === 'child' && t.kind === 'chat' && t.tab !== opts.self && opts.children.has(t.tab)) return false;
    return true;
  });
}

// ─── `super answer` (D7: the window re-checks, then answers like the child's card) ──

export interface QuestionLike {
  question: string;
  options: Array<{ label: string }>;
  multiSelect?: boolean;
}

/**
 * Map the agent's `choices` (option labels, one per question in order; a multi-select
 * question's labels joined) and optional free `text` onto the `picked` record
 * `buildQuestionAnswer` takes. A label the question does not offer is refused, so the agent
 * cannot put words in the owner's mouth through a fake option.
 */
export function superAnswerPicks(
  questions: readonly QuestionLike[],
  choices: readonly string[],
  text?: string,
): { ok: true; picked: Record<string, string>; notes?: Record<string, string> } | { ok: false; error: string } {
  if (questions.length === 0) return { ok: false, error: 'no_question' };
  const picked: Record<string, string> = {};
  const clean = choices.filter((c) => typeof c === 'string' && c.trim()).map((c) => c.trim());
  if (questions.length === 1) {
    const q = questions[0];
    const labels = new Set(q.options.map((o) => o.label));
    if (clean.some((c) => !labels.has(c))) return { ok: false, error: 'unknown_choice' };
    if (clean.length > 1 && !q.multiSelect) return { ok: false, error: 'one_choice_only' };
    if (clean.length) picked[q.question] = clean.join(', ');
  } else {
    if (clean.length > questions.length) return { ok: false, error: 'too_many_choices' };
    for (let i = 0; i < clean.length; i++) {
      const q = questions[i];
      if (!q.options.some((o) => o.label === clean[i])) return { ok: false, error: 'unknown_choice' };
      picked[q.question] = clean[i];
    }
  }
  const free = typeof text === 'string' ? text.trim().slice(0, 4000) : '';
  if (!free && Object.keys(picked).length === 0) return { ok: false, error: 'empty_answer' };
  if (!free) return { ok: true, picked };
  const first = questions[0].question;
  // Free text with no pick IS the answer; beside a pick it rides as the question's note.
  if (!picked[first]) { picked[first] = free; return { ok: true, picked }; }
  return { ok: true, picked, notes: { [first]: free } };
}

/**
 * A `delegate` frame the window got too late (the server's `args.deadline`, epoch ms): the
 * server has given up waiting, so opening a child now would leave one it never records. A frame
 * with no deadline is never expired (older servers).
 */
export function delegateExpired(args: Record<string, unknown>, now: number = Date.now()): boolean {
  return typeof args.deadline === 'number' && now > args.deadline;
}

/** The `delegate` command's arguments, validated: the mode is one an agent may spawn, the
 *  prompt is present. */
export function delegateArgs(args: Record<string, unknown>): {
  ok: true; prompt: string; mode: AgentSpawnMode; model: string; effort: string; title: string; mcp: string[];
} | { ok: false; error: string } {
  const prompt = typeof args.prompt === 'string' ? args.prompt : '';
  if (!prompt.trim()) return { ok: false, error: 'no_prompt' };
  const mode = (AGENT_SPAWN_MODES as readonly string[]).includes(args.mode as string) ? args.mode as AgentSpawnMode : 'basic';
  // eslint-disable-next-line no-control-regex
  const str = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n) : '');
  const title = str(args.title, MAX_TITLE) || str(args.brief, MAX_TITLE);
  return { ok: true, prompt, mode, model: str(args.model, 80), effort: str(args.effort, 20), title, mcp: mcpNames(args.mcp) };
}

// ─── Lean children (orchestration plan r5 D14) ──────────────────────────────────

/** Mirrors `src/lib/super/lean-mcp.ts` (`MCP_NAME_RE`, `MAX_LEAN_MCP`); the server re-checks. */
const MCP_NAME_RE = /^[a-z0-9_-]{1,40}$/;
const MAX_LEAN_MCP = 6;
const FORBIDDEN_MCP_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

/** The well-formed server names in `v` (a list), at most six; anything else drops out. */
export function mcpNames(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const n of v) if (typeof n === 'string' && MCP_NAME_RE.test(n) && !FORBIDDEN_MCP_NAMES.has(n) && !out.includes(n)) out.push(n);
  return out.slice(0, MAX_LEAN_MCP);
}

/**
 * The MCP servers a chat runs with when it is a DELEGATED Super Agent child, or null for every
 * other chat (the owner's own adopted chats, the super's own session, anything not a child). A
 * child the window is opening right now, before the server's record names it, is in `opening`.
 * Every spawn of the same conversation (Resume, an account switch, a reconnect) asks again, so
 * a child never comes back with the owner's full MCP set.
 */
export function leanMcpFor(state: { session: string | null; children: Record<string, { adopted: boolean; mcp?: string[] }> } | null, claudeId: string, opening?: ReadonlyMap<string, string[]>): string[] | null {
  const now = opening?.get(claudeId);
  if (now) return now;
  if (!state || claudeId === state.session || !hasOwnKey(state.children, claudeId)) return null;
  const c = Object.entries(state.children).find(([k]) => k === claudeId)?.[1];
  return !c || c.adopted ? null : mcpNames(c.mcp);
}

/** The WS URL part of a lean child (`&lean=1&mcp=a,b`); '' for any other chat. */
export function leanMcpParam(names: readonly string[] | null): string {
  if (!names) return '';
  return `&lean=1${names.length ? `&mcp=${encodeURIComponent(names.join(','))}` : ''}`;
}

// ─── The return recap (D13) ────────────────────────────────────────────────────

/** Away this long (unfocused or hidden) and the return asks for a recap. */
export const RECAP_AWAY_MS = 10 * 60_000;

/** Post `/api/super/recap` on this window change? Only on the edge back to focused, after at
 *  least {@link RECAP_AWAY_MS} away, and only while handed over (the server decides whether
 *  anything happened meanwhile). */
export function shouldRecap(prevFocused: boolean, nextFocused: boolean, unfocusedMs: number, handedOver: boolean): boolean {
  return handedOver && !prevFocused && nextFocused && unfocusedMs >= RECAP_AWAY_MS;
}

// ─── What a card and the strip print (text, never markup) ─────────────────────

/** The last thing a child SAID, as one line: the newest text block's last non-empty line,
 *  markdown marks dropped, clipped. */
export function lastLineOf(items: ReadonlyArray<{ kind: string; text?: string }>, max = 140): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind !== 'text' || typeof it.text !== 'string' || !it.text.trim()) continue;
    const lines = it.text.split('\n').map((l) => l.trim()).filter(Boolean);
    const line = (lines[lines.length - 1] ?? '').replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim();
    if (line) return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
  }
  return '';
}

/** "4m", "1h 12m" — coarse on purpose: a card is glanced at, not read like a stopwatch. */
export function elapsedLabel(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** What a busy child is doing, from its newest tool in flight (plan-r8 F11, O10). */
export interface DoingLine { verb: 'run' | 'edit' | 'read' | 'search' | 'fetch' | 'agent' | 'tool'; subject: string }

const oneLine = (v: unknown, max = 80): string => {
  if (typeof v !== 'string') return '';
  const line = v.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};

/** A path as the owner reads it on a card: its last two segments. */
const shortPath = (v: unknown): string => {
  const p = oneLine(v, 400);
  const parts = p.split('/').filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : p;
};

/** The tool the child is running right now, as a verb and a subject; null when none runs. */
export function doingOf(items: ReadonlyArray<{ kind: string; name?: string; input?: unknown; status?: string }>): DoingLine | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind !== 'tool' || it.status !== 'running') continue;
    const name = it.name ?? '';
    const input = it.input && typeof it.input === 'object' ? it.input as Record<string, unknown> : {};
    if (name === 'Bash') return { verb: 'run', subject: oneLine(input.description) || oneLine(input.command) };
    if (name === 'Edit' || name === 'Write' || name === 'MultiEdit' || name === 'NotebookEdit') return { verb: 'edit', subject: shortPath(input.file_path ?? input.notebook_path) };
    if (name === 'Read') return { verb: 'read', subject: shortPath(input.file_path) };
    if (name === 'Grep' || name === 'Glob') return { verb: 'search', subject: oneLine(input.pattern) };
    if (name === 'WebFetch') return { verb: 'fetch', subject: oneLine(input.url) };
    if (name === 'WebSearch') return { verb: 'search', subject: oneLine(input.query) };
    if (name === 'Agent' || name === 'Task') return { verb: 'agent', subject: oneLine(input.description) };
    return { verb: 'tool', subject: name };
  }
  return null;
}

/** What a child runs in the background: shells and agents still running (the card's chip). */
export function backgroundOf(runs: ReadonlyArray<{ status: string; taskType?: string }>): { shells: number; agents: number } {
  let shells = 0;
  let agents = 0;
  for (const r of runs) {
    if (r.status !== 'running') continue;
    if (r.taskType === 'local_bash') shells++;
    else agents++;
  }
  return { shells, agents };
}

/** The last few lines a child wrote (a tall card shows up to 4 under its doing-line). */
export function lastLinesOf(items: ReadonlyArray<{ kind: string; text?: string }>, n = 4, max = 120): string[] {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind !== 'text' || typeof it.text !== 'string' || !it.text.trim()) continue;
    return it.text.split('\n')
      .map((l) => l.replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(-n)
      .map((l) => (l.length > max ? `${l.slice(0, max - 1).trimEnd()}…` : l));
  }
  return [];
}

/** The longest card title an `@card` reference carries (§0 C-minors). */
export const CARD_REF_TITLE_MAX = 60;

/**
 * O11: what dropping a card on the centre puts into the Super Agent's draft —
 * `@card:<id> “<title>” `, one line, the title clipped and stripped of control characters and
 * quotes. A space goes first when the draft does not end in whitespace.
 */
export function cardReference(id: string, title: string, draft: string): string {
  const clean = title.replace(/[\u0000-\u001f\u007f“”"]+/g, ' ').replace(/\s+/g, ' ').trim();
  const clipped = clean.length > CARD_REF_TITLE_MAX ? `${clean.slice(0, CARD_REF_TITLE_MAX - 1).trimEnd()}…` : clean;
  const lead = draft && !/\s$/.test(draft) ? ' ' : '';
  return `${lead}@card:${id} “${clipped}” `;
}

/** A one-line view of a permission's tool input — the command, the path, or compact JSON. */
export function permissionSummary(input: unknown): string {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    for (const k of ['command', 'file_path', 'path', 'url', 'pattern']) {
      if (typeof o[k] === 'string' && o[k]) return String(o[k]).replace(/\s+/g, ' ').slice(0, 200);
    }
  }
  let json = '';
  try { json = JSON.stringify(input) ?? ''; } catch { json = ''; }
  return json.replace(/\s+/g, ' ').slice(0, 200);
}
