/**
 * The phone's view of a handed-over Super Agent (task hands-free-de-super-agent-aciksa…): a
 * MIRROR socket on the live super child, never its holder.
 *
 * The desktop window holds the super chat's socket because it is the bridge: `delegate` and
 * `answer` travel down that socket as `super_command` and the window runs them (window-control.ts).
 * A phone that ADOPTED the socket would take the bridge with it, and every delegation would answer
 * `no_window`. So the phone joins beside the holder:
 *
 *   • OUT: every stdout line but the CLI's `control_request` prompts (a permission or question the
 *     super agent itself waits on is answered on the Mac, never by a tunnel socket), the inbox's
 *     `super_event` chips, and the owner's words typed on another surface (`owner_echo`). Never a
 *     `super_command`, `window_command` or `super_state`: the window's channel is not fanned out.
 *   • IN: ONLY a `user` text frame (the owner chatting). An answer, an interrupt, a model, mode or
 *     effort switch, a rewind, any `*_command_result`, and a slash command (`/effort`, `/model`…
 *     ride the text path into the CLI) are dropped here, so the phone can talk to the Super Agent
 *     and never drive it. Its text joins the SAME path the desktop's does, so the inbox's hold
 *     (D8) orders both surfaces' messages as one queue.
 *   • LIFETIME: one mirror per device (a reconnect replaces the half-open socket it left behind),
 *     pinged like the holder (a socket that misses a pong is terminated), at most
 *     {@link MAX_MIRRORS} devices; closed when the child drains, respawns or ends.
 *
 * Trust is per socket (`[[pattern-a-tunnel-makes-every]]`): a mirror is added only for a socket
 * the phone listener accepted, carries that socket's device, and is closed the moment that device
 * is no longer signed in or Mac mode returns.
 */

/** The socket surface a mirror needs (the `ws` package's WebSocket satisfies it). */
export interface MirrorSocket {
  readonly readyState: number;
  readonly OPEN: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  ping?(): void;
  terminate?(): void;
  on(event: 'message', fn: (raw: Buffer | string) => void): unknown;
  on(event: 'close' | 'error' | 'pong', fn: () => void): unknown;
}

/** Closed: the device behind the mirror signed out, or Mac mode returned. */
export const MIRROR_CLOSE_REVOKED = 4401;
/** Closed: the super child this mirror watched ended (a respawn, a take-back). The client
 *  reconnects and lands on the successor, or is refused once the mode is off. */
export const MIRROR_CLOSE_ENDED = 4410;
/** A phone message longer than this is not chat: dropped. */
export const MIRROR_MAX_TEXT = 100_000;
/** At most this many phone mirrors (devices) on one super child. */
export const MAX_MIRRORS = 4;
/** Closed: the same device joined again; its newer socket is the mirror now. */
export const MIRROR_CLOSE_REPLACED = 4409;
/** How often a mirror is pinged; one missed pong and it is terminated. */
export const MIRROR_PING_MS = 25_000;

export interface MirrorOpts<D> {
  /** Is this device still signed in? Asked on every frame the mirror sends up. */
  valid: (device: D) => boolean;
  /** The owner's text from the phone, handed to the chat's own owner path (a raw `user` frame).
   *  Unused by a read-only set. */
  onOwnerFrame?: (raw: string) => void;
  /** WATCH-ONLY (a Super Agent child on a remote screen, hands-free sekmeler D6): no inbound
   *  handler is attached at all, so no text, answer or permission response from the socket
   *  reaches the child. Its questions reach the owner through the Super's escalation. */
  readOnly?: boolean;
  /** The socket holding the child right now (the desktop window), or null while detached. */
  holder: () => MirrorSocket | null;
  /** Which device a mirror belongs to (one mirror per device). */
  key: (device: D) => string;
  /** Ping interval (tests shorten it). */
  pingMs?: number;
}

interface Mirror<D> { ws: MirrorSocket; device: D; waiting: boolean }

/** The one frame a mirror may send up, or null. */
export function mirrorOwnerText(raw: Buffer | string): string | null {
  const str = typeof raw === 'string' ? raw : raw.toString('utf-8');
  if (str.length > MIRROR_MAX_TEXT + 200) return null;
  let msg: unknown;
  try { msg = JSON.parse(str); } catch { return null; }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
  const m = msg as { type?: unknown; text?: unknown };
  if (m.type !== 'user' || typeof m.text !== 'string') return null;
  const text = m.text;
  // A slash command is not chat: `/effort`, `/model` and the like are run by the CLI itself.
  if (text.trimStart().startsWith('/')) return null;
  return text.trim() && text.length <= MIRROR_MAX_TEXT ? text : null;
}

/** Does a stdout line go to a mirror? Everything but the CLI's own prompts. */
export function mirrorCarriesLine(line: string): boolean {
  // Cheap first: a prompt line always names its type; anything else passes unparsed.
  if (!line.includes('"control_request"')) return true;
  try {
    const o = JSON.parse(line) as { type?: unknown };
    return o?.type !== 'control_request';
  } catch { return true; }
}

/** The `_meta` frame that shows the owner's words on the surfaces that did not type them. */
export function ownerEchoFrame(text: string): string {
  return JSON.stringify({ type: '_meta', subtype: 'owner_echo', text });
}

/** At most this many pictures in one `stage_media` frame. */
export const STAGE_MEDIA_MAX = 6;

/** One picture the Super Agent has on its stage: the card's project-relative ref and its title. */
export interface StageMediaItem { ref: string; title?: string }

/**
 * The `_meta` frame that tells a phone mirror which pictures the Super Agent opened on the Mac's
 * stage (task hands-free-phone-shows-every-picture…, D2). The phone has no stage; it draws these
 * as a strip in the chat. `snapshot`: what the stage holds as the phone joins, not a new open.
 *
 * Only `image` cards, whose refs `super open` already confines to project-relative paths with no
 * `..` (super.ts `refFor`), so the phone loads them through the ordinary inside-project rule of
 * `GET /api/agent/file`. Null when there is nothing to send.
 */
export function stageMediaFrame(items: readonly StageMediaItem[], snapshot = false): string | null {
  const clean = items
    .filter((i) => typeof i.ref === 'string' && i.ref && !i.ref.startsWith('/') && !i.ref.split('/').includes('..'))
    .slice(-STAGE_MEDIA_MAX)
    .map((i) => ({ ref: i.ref, ...(i.title ? { title: i.title.slice(0, 120) } : {}) }));
  if (!clean.length) return null;
  return JSON.stringify({ type: '_meta', subtype: 'stage_media', items: clean, ...(snapshot ? { snapshot: true } : {}) });
}

/** The image cards floating on a stage now (not resting in Others), oldest first. */
export function stageImageItems(state: { containers: ReadonlyArray<{ kind: string; ref: string; place: string; title?: string }> }): StageMediaItem[] {
  return state.containers
    .filter((k) => k.kind === 'image' && k.place === 'float')
    .map((k) => ({ ref: k.ref, ...(k.title ? { title: k.title } : {}) }));
}

export class MirrorSet<D> {
  private readonly mirrors = new Set<Mirror<D>>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: MirrorOpts<D>) {}

  get size(): number { return this.mirrors.size; }

  /** Is `ws` one of the mirrors right now? */
  has(ws: MirrorSocket): boolean {
    for (const m of this.mirrors) if (m.ws === ws) return true;
    return false;
  }

  /** Is there room for `device`? Its own earlier mirror counts as room: it is replaced. */
  room(device: D): boolean {
    const k = this.opts.key(device);
    return this.mirrors.size < MAX_MIRRORS || [...this.mirrors].some((m) => this.opts.key(m.device) === k);
  }

  /** Join `ws` as a mirror owned by `device`, replacing that device's earlier one. False when
   *  the set is full of other devices (the caller refuses). */
  add(ws: MirrorSocket, device: D): boolean {
    if (!this.room(device)) return false;
    const k = this.opts.key(device);
    for (const old of [...this.mirrors]) if (this.opts.key(old.device) === k) this.drop(old, MIRROR_CLOSE_REPLACED, 'replaced');
    const m: Mirror<D> = { ws, device, waiting: false };
    this.mirrors.add(m);
    const gone = (): void => { this.mirrors.delete(m); this.idle(); };
    ws.on('close', gone);
    ws.on('error', gone);
    ws.on('pong', () => { m.waiting = false; });
    this.arm();
    if (this.opts.readOnly) return true;
    ws.on('message', (raw) => {
      if (!this.mirrors.has(m)) return;
      if (!this.opts.valid(device)) { this.drop(m, MIRROR_CLOSE_REVOKED, 'device signed out'); return; }
      const text = mirrorOwnerText(raw);
      if (text === null) return;
      // Echoed to the holder and the other mirrors BEFORE the chat sees it, so every surface
      // shows the owner's words in the order they were typed.
      this.echo(text, ws);
      this.opts.onOwnerFrame?.(JSON.stringify({ type: 'user', text }));
    });
    return true;
  }

  /** The owner's words, to every socket but the one that typed them (the holder included). */
  echo(text: string, from: MirrorSocket | null): void {
    if (!this.mirrors.size) return;
    const frame = ownerEchoFrame(text);
    const holder = this.opts.holder();
    if (holder && holder !== from) safeSend(holder, frame);
    for (const m of this.mirrors) if (m.ws !== from) safeSend(m.ws, frame);
  }

  /** One stdout line, to every mirror (prompts excepted). */
  line(line: string): void {
    if (!this.mirrors.size || !mirrorCarriesLine(line)) return;
    for (const m of this.mirrors) safeSend(m.ws, line);
  }

  /** One `_meta` frame (already serialised) to every mirror. */
  frame(serialised: string): void {
    for (const m of this.mirrors) safeSend(m.ws, serialised);
  }

  /** Close every mirror whose device is no longer signed in. Returns how many. */
  revokeStale(): number {
    let n = 0;
    for (const m of [...this.mirrors]) if (!this.opts.valid(m.device)) { this.drop(m, MIRROR_CLOSE_REVOKED, 'device signed out'); n++; }
    return n;
  }

  /** Close every mirror (the child ended, or Mac mode returned). */
  closeAll(code: number, reason: string): number {
    const n = this.mirrors.size;
    for (const m of [...this.mirrors]) this.drop(m, code, reason);
    return n;
  }

  private drop(m: Mirror<D>, code: number, reason: string): void {
    this.mirrors.delete(m);
    try { m.ws.close(code, reason); } catch { /* gone */ }
    // A peer that never answers the close frame is cut after a second.
    const t = setTimeout(() => { try { m.ws.terminate?.(); } catch { /* gone */ } }, 1000);
    t.unref?.();
    this.idle();
  }

  /** Ping every mirror; one that did not answer the last ping is terminated (a half-open
   *  socket — the phone locked without a FIN — must not hold a device's place for hours). */
  private arm(): void {
    if (this.pingTimer) return;
    this.pingTimer = setInterval(() => {
      for (const m of [...this.mirrors]) {
        if (m.waiting) {
          this.mirrors.delete(m);
          try { m.ws.terminate?.(); } catch { /* gone */ }
          continue;
        }
        m.waiting = true;
        try { m.ws.ping?.(); } catch { /* closing */ }
      }
      this.idle();
    }, this.opts.pingMs ?? MIRROR_PING_MS);
    this.pingTimer.unref?.();
  }

  private idle(): void {
    if (this.mirrors.size || !this.pingTimer) return;
    clearInterval(this.pingTimer);
    this.pingTimer = null;
  }
}

function safeSend(ws: MirrorSocket, data: string): void {
  if (ws.readyState !== ws.OPEN) return;
  try { ws.send(data); } catch { /* closing */ }
}

/**
 * What a phone's chat open does about the Super Agent, decided before any spawn:
 *   • `mirror` — the vault is handed over, the open names its recorded super session, and the
 *     super child is live: join it as a mirror.
 *   • `refuse` — a super open the phone may not make: `mode=super` anywhere else (the hand-over is
 *     the desktop's, D4), or ANY open naming the vault's recorded super session — handed over or
 *     parked after a take-back — that cannot mirror (no live child, or the mode is off): a resume
 *     or reattach of it would supersede, evict or respawn the window's Super Agent.
 *   • `pass` — nothing to do with the Super Agent: the open goes on as before.
 */
export function phoneSuperOpen(o: {
  mode: string; resumeId: string; sessionId: string;
  index: { session: string | null; enabled: boolean };
  liveSuper: boolean;
  /** Each member Super of THIS vault (plan-r10 2.4): its record's session, mirrored like main's
   *  only when enabled, live on the Mac and the member is ready (on and approved). */
  members?: ReadonlyArray<PhoneMemberSuper>;
}): 'mirror' | 'refuse' | 'pass' {
  return phoneSuperTarget(o).decision;
}

/** One member Super as the phone's open decision reads it (in memory, no disk). */
export interface PhoneMemberSuper {
  slug: string;
  session: string | null;
  enabled: boolean;
  /** Its chat is live on the Mac, in this project, with a mirror to join. */
  live: boolean;
  /** The member is on and approved (`memberCallState` ready); asked only when its session is named. */
  ready: () => boolean;
}

/** Does this open name `session` (resume or pin)? Case-blind: an id is a UUID, and an upper-case
 *  copy must not slip past as "another chat". */
export function opensSession(o: { resumeId: string; sessionId: string }, session: string | null | undefined): boolean {
  const s = session?.toLowerCase();
  return !!s && (o.resumeId.toLowerCase() === s || o.sessionId.toLowerCase() === s);
}

/**
 * `phoneSuperOpen` with WHICH super it mirrors: main's (`slug` absent) or one member's. A member's
 * recorded session is held exactly like main's: a phone mirrors it when it may, and is refused any
 * other open of it (resume, spawn, reattach).
 */
export function phoneSuperTarget(o: Parameters<typeof phoneSuperOpen>[0]): { decision: 'mirror' | 'refuse' | 'pass'; slug?: string } {
  // The RECORDED session, handed over or parked: a phone never adopts, resumes or respawns it
  // (a parked super child it took would hold the session from the next hand-over).
  if (opensSession(o, o.index.session)) return { decision: o.index.enabled && o.liveSuper ? 'mirror' : 'refuse' };
  for (const m of o.members ?? []) {
    if (!opensSession(o, m.session)) continue;
    let ready = false;
    try { ready = m.enabled && m.live && m.ready(); } catch { ready = false; }
    return { decision: ready ? 'mirror' : 'refuse', slug: m.slug };
  }
  return { decision: o.mode === 'super' ? 'refuse' : 'pass' };
}

/** The live-chat row shapes this module needs (contract.ts `LiveChatWire`). */
interface LiveRow { conversationId: string; vault: string | null; title: string | null; busy: boolean; state: 'working' | 'asking' | 'idle'; lastLine: string | null; updatedAt: number | null }

/** At most this many jobs reach a phone: every one still running first, then the newest ended. */
export const PHONE_JOBS_MAX = 12;
/** An ended job stays on the phone's list this long ("just finished"). */
export const PHONE_JOB_DONE_MS = 24 * 60 * 60 * 1000;

/** A project's Super record as the phone's list reads it. */
export interface PhoneSuperRecord {
  /** Its recorded session: handed over, or parked after a take-back. */
  session: string;
  enabled: boolean;
  /** Every child of the record, named as a remote screen is told it (`childDigestName`). */
  children: ReadonlyArray<{ id: string; title: string; startedAt: number; endedAt?: number; adopted?: boolean }>;
  /** Children pruned from the record: still the Super's (`formerChildren`). */
  former?: readonly string[];
}

/** One line of a Super's work on the phone (`SuperJobWire`). */
export interface PhoneJob { conversationId: string; title: string; state: 'working' | 'asking' | 'idle' | 'stopped' | 'done'; startedAt: number }

type PhoneSuperRow = LiveRow & { vault: string; live: boolean; jobs: PhoneJob[]; runningIds: string[]; childIds: string[] };

/**
 * The phone's live list with the Super Agent applied. The Super Agent and the owner's chats live
 * side by side in one project, so a handed-over project lists its own chats AND one super row
 * (`live` false when the Mac runs no super chat right now), with the work it gave out on that row.
 * Two things never list as a chat, because a phone may not take them over: a project's recorded
 * super session, handed over OR parked after a take-back (`phoneSuperOpen` refuses the open, and a
 * listed row would be a chat that never connects; `parked` names those for History), and the
 * running children of a handed-over Super. Every other row is returned untouched.
 */
export function phoneLiveChats<R extends LiveRow>(chats: readonly R[], records: ReadonlyMap<string, PhoneSuperRecord>, now = Date.now()): {
  chats: R[]; supers: PhoneSuperRow[]; parked: string[];
} {
  if (!records.size) return { chats: [...chats], supers: [], parked: [] };
  const hidden = new Set<string>();
  const supers: PhoneSuperRow[] = [];
  const parked: string[] = [];
  for (const [vault, record] of records) {
    hidden.add(`${vault}\u0000${record.session.toLowerCase()}`);
    if (!record.enabled) { parked.push(record.session); continue; }
    const running = record.children.filter((c) => c.endedAt === undefined);
    for (const c of running) hidden.add(`${vault}\u0000${c.id.toLowerCase()}`);
    const runningIds = running.map((c) => c.id);
    // An adopted chat the Super ended is the owner's again (`ownersChat`): History lists it.
    const childIds = [...record.children.filter((c) => !(c.adopted && c.endedAt !== undefined)).map((c) => c.id), ...(record.former ?? [])];
    const row = chats.find((c) => c.vault === vault && c.conversationId === record.session);
    const jobs = phoneJobs(record.children, chats.filter((c) => c.vault === vault), now);
    supers.push(row
      ? { conversationId: row.conversationId, vault, title: null, busy: row.busy, state: row.state, lastLine: row.lastLine, updatedAt: row.updatedAt, live: true, jobs, runningIds, childIds }
      : { conversationId: record.session, vault, title: null, busy: false, state: 'idle', lastLine: null, updatedAt: null, live: false, jobs, runningIds, childIds });
  }
  return { chats: chats.filter((c) => !c.vault || !hidden.has(`${c.vault}\u0000${c.conversationId.toLowerCase()}`)), supers, parked };
}

/** The record's children with their state now: running ones first, then stopped, then ended,
 *  newest first in each part; ended ones only while recent. Ended is the record's word, never the absence of a
 *  process: a child with none that nobody ended is `stopped`. No name reads as the short id. */
function phoneJobs(children: PhoneSuperRecord['children'], live: readonly LiveRow[], now: number): PhoneJob[] {
  const stateOf = (c: PhoneSuperRecord['children'][number]): PhoneJob['state'] => {
    if (c.endedAt !== undefined) return 'done';
    return live.find((l) => l.conversationId === c.id)?.state ?? 'stopped';
  };
  const rows = children
    .filter((c) => c.endedAt === undefined || now - c.endedAt < PHONE_JOB_DONE_MS)
    .map((c): PhoneJob => ({ conversationId: c.id, title: c.title || c.id.slice(0, 8), state: stateOf(c), startedAt: c.startedAt }));
  const rank = (j: PhoneJob) => (j.state === 'done' ? 2 : j.state === 'stopped' ? 1 : 0);
  return rows.sort((a, b) => rank(a) - rank(b) || b.startedAt - a.startedAt).slice(0, PHONE_JOBS_MAX);
}

// ─── The agenda's digest (task hands-free-telefonda-super-agent-sohbeti-ajandayi…) ──────────

/** The digest's fields, mirrored by `dashboard/src/lib/superTypes.ts` (super-types-mirror test). */
export const SUPER_DIGEST_FIELDS = ['pad', 'waiting', 'ownerBatches', 'mainBatches', 'names', 'owed', 'key'] as const;
export const DIGEST_MAX_PAD = 40;
export const DIGEST_MAX_PAD_TEXT = 160;
export const DIGEST_MAX_WAITING = 40;
export const DIGEST_MAX_OWNER_TEXT = 300;
export const DIGEST_MAX_BATCHES = 50;
export const DIGEST_MAX_NAMES = 40;
export const DIGEST_MAX_NAME = 80;
/** Open debts a digest carries (owed.ts), and how much of each gist. */
export const DIGEST_MAX_OWED = 40;
export const DIGEST_MAX_OWED_GIST = 160;

/** The slice of the super record a digest reads (`SuperState` satisfies it). */
export interface SuperDigestSource {
  pad?: ReadonlyArray<{ id: string; section: string; text: string; at: number; for?: string; by?: 'auto' | 'owner' }>;
  queue: ReadonlyArray<{ id: string; kind: string; state: string; createdAt: number; sessionId: string; ownerText?: string; direct?: true; workOrigin?: string; toSuper?: true }>;
  ownerBatches: readonly string[];
  /** A member Super's main-origin turns (plan-r10 1); absent = none. */
  mainBatches?: readonly string[];
  containers: ReadonlyArray<{ kind: string; ref: string; title?: string }>;
  children: Readonly<Record<string, { brief: string; startedAt: number; workOrigin?: string }>>;
  /** What the Super still owes him (owed.ts); absent = none. */
  owed?: ReadonlyArray<{ id: string; kind: string; ref: string; seq: number; at: number; gist: string; nudges: number; parked?: 'stop' | 'limit'; parkedAt?: number; closed?: unknown }>;
}

/**
 * What a phone mirror is told of the Super Agent's agenda: the desktop's `SuperAgenda` is drawn
 * from it (`superNotepad`), the event turns fold with its `ownerBatches` and `names`. A
 * whitelist, never the record: no prompt, worktree, branch, task, ask spec, options, request id
 * or permission content. A name is the Mac's job card title (the chat card's `title`, else the
 * child's brief), never the chat registry's title (the prompt's first 80 characters).
 */
export interface SuperDigest {
  /** `for` and `by` ride along so the phone's card rolls a day over and flags a stale line the
   *  way the desktop does (pad.ts: the owner's own move stays, a linked line is not stale). */
  pad: Array<{ id: string; section: string; text: string; at: number; for?: string; by?: 'auto' | 'owner' }>;
  /** What waits on the owner (`needsOwner`) and the questions queued behind an open one. `text`
   *  is the item's `ownerText` (an `owner` item's is the child's card: untrusted plain text),
   *  '' on a permission. */
  waiting: Array<{ id: string; kind: string; state: string; createdAt: number; sessionId: string; text: string }>;
  ownerBatches: string[];
  /** A member Super's main-origin turns: the phone's unread skips them (plan-r10 1). */
  mainBatches: string[];
  names: Record<string, string>;
  /** The OPEN debts (owed.ts), so the phone draws "Cevaplanmadı" the way the desktop does. The
   *  phone only reads them: no drop door is there. */
  owed: Array<{ id: string; kind: 'msg' | 'result'; ref: string; seq: number; at: number; gist: string; nudges: number; parked?: 'stop' | 'limit'; parkedAt?: number }>;
  /** Changes when (and only when) anything above changes. */
  key: string;
}

function digestText(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  const flat = raw.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(flat).slice(0, max).join('').trim();
}

/** A short, stable hash (FNV-1a): the digest's key, never a secret. */
function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

/** A child's name as a remote screen is told it: its chat card's title, else its brief, flattened
 *  and cut to {@link DIGEST_MAX_NAME}. The ONE name every mirror frame carries (the digest's
 *  `names`, the remote stage's chat card); the brief beyond it never travels. */
export function childDigestName(state: Pick<SuperDigestSource, 'containers' | 'children'>, sid: string): string {
  const card = state.containers.find((c) => c.kind === 'chat' && c.ref === sid);
  const brief = Object.prototype.hasOwnProperty.call(state.children, sid) ? state.children[sid].brief : undefined;
  return digestText(card?.title || brief, DIGEST_MAX_NAME);
}

/** The digest of `state`. Pure. */
export function superDigest(state: SuperDigestSource): SuperDigest {
  const pad = (state.pad ?? []).slice(-DIGEST_MAX_PAD)
    .map((p) => ({
      id: digestText(p.id, 12), section: p.section, text: digestText(p.text, DIGEST_MAX_PAD_TEXT), at: p.at,
      ...(typeof p.for === 'string' && p.for ? { for: digestText(p.for, 80) } : {}),
      ...(p.by === 'auto' || p.by === 'owner' ? { by: p.by } : {}),
    }))
    .filter((p) => p.id && p.text);
  // Main Super's work in a member's Super (`main:*`, plan-r10 1) never waits on the owner.
  const mainWork = (o: string | undefined) => typeof o === 'string' && o.startsWith('main:');
  const owes = (q: SuperDigestSource['queue'][number]) => q.state !== 'done'
    && !mainWork(q.workOrigin) && !mainWork(Object.prototype.hasOwnProperty.call(state.children, q.sessionId) ? state.children[q.sessionId].workOrigin : undefined)
    // A Bypass child's permission its Super decides first (`toSuper`) waits on nobody's phone.
    && !(q.kind === 'permission' && q.toSuper)
    && (q.kind === 'permission' || q.kind === 'owner' || q.state === 'escalated' || (q.kind === 'question' && (q.state === 'pending' || q.direct === true)));
  const waiting = state.queue.filter(owes).slice(0, DIGEST_MAX_WAITING).map((q) => ({
    id: q.id, kind: q.kind, state: q.state, createdAt: q.createdAt, sessionId: q.sessionId,
    text: q.kind === 'permission' ? '' : digestText(q.ownerText, DIGEST_MAX_OWNER_TEXT),
  }));
  const ownerBatches = state.ownerBatches.filter((b) => typeof b === 'string').slice(-DIGEST_MAX_BATCHES);
  const mainBatches = (state.mainBatches ?? []).filter((b) => typeof b === 'string').slice(-DIGEST_MAX_BATCHES);
  // The children the phone may name: the ones it waits on first, then the newest.
  const sids = [...new Set([
    ...waiting.map((w) => w.sessionId).filter((sid) => state.children[sid]),
    ...Object.entries(state.children).sort((a, b) => b[1].startedAt - a[1].startedAt).map(([sid]) => sid),
  ])].slice(0, DIGEST_MAX_NAMES);
  const names: Record<string, string> = {};
  for (const sid of sids) {
    const name = childDigestName(state, sid);
    if (name) names[sid] = name;
  }
  const owed = (state.owed ?? []).filter((d) => d.closed === undefined && (d.kind === 'msg' || d.kind === 'result')).slice(-DIGEST_MAX_OWED).map((d) => ({
    id: digestText(d.id, 12), kind: d.kind as 'msg' | 'result', ref: digestText(d.ref, 6), seq: d.seq, at: d.at, gist: digestText(d.gist, DIGEST_MAX_OWED_GIST), nudges: d.nudges,
    ...(d.parked === 'stop' || d.parked === 'limit' ? { parked: d.parked, ...(typeof d.parkedAt === 'number' ? { parkedAt: d.parkedAt } : {}) } : {}),
  }));
  const body = { pad, waiting, ownerBatches, mainBatches, names, owed };
  return { ...body, key: fnv(JSON.stringify(body)) };
}

/** The `_meta` frame carrying `d` to a phone mirror. */
export function superDigestFrame(d: SuperDigest): string {
  return JSON.stringify({ type: '_meta', subtype: 'super_digest', pad: d.pad, waiting: d.waiting, ownerBatches: d.ownerBatches, mainBatches: d.mainBatches, names: d.names, owed: d.owed, key: d.key });
}
