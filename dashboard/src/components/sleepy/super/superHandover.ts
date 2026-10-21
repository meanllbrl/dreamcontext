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
  SUPER_EVENT_PREFIXES, type SuperEventKind, type SuperQueueItem, type SuperState,
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

/** An item that is the OWNER's to answer: a permission (never the agent's), or a question the
 *  Super Agent escalated with words of its own. */
export function needsOwner(item: SuperQueueItem): boolean {
  if (item.state === 'done') return false;
  return item.kind === 'permission' || item.state === 'escalated';
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

// ─── Injected turns ────────────────────────────────────────────────────────────

/** Which prefix an injected super turn starts with, per the `super_event` kind. */
export function superEventPrefix(kind: string): typeof SUPER_EVENT_PREFIXES[number] {
  if (kind === 'recap') return '[super recap]';
  if (kind === 'handover') return '[super handover]';
  return '[super event]';
}

/** The text of an event chip the window adds live (the protocol never echoes a user frame):
 *  the prefix, the kind, and the child it is about. */
export function superEventText(kind: string, child: string): string {
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
  return kind === 'question' || kind === 'idle' || kind === 'gone' || kind === 'recap' || kind === 'handover';
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
  ok: true; prompt: string; mode: AgentSpawnMode; model: string; effort: string; title: string;
} | { ok: false; error: string } {
  const prompt = typeof args.prompt === 'string' ? args.prompt : '';
  if (!prompt.trim()) return { ok: false, error: 'no_prompt' };
  const mode = (AGENT_SPAWN_MODES as readonly string[]).includes(args.mode as string) ? args.mode as AgentSpawnMode : 'basic';
  // eslint-disable-next-line no-control-regex
  const str = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n) : '');
  const title = str(args.title, MAX_TITLE) || str(args.brief, MAX_TITLE);
  return { ok: true, prompt, mode, model: str(args.model, 80), effort: str(args.effort, 20), title };
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
