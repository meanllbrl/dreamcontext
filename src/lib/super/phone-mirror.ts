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
  /** The owner's text from the phone, handed to the chat's own owner path (a raw `user` frame). */
  onOwnerFrame: (raw: string) => void;
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
    ws.on('message', (raw) => {
      if (!this.mirrors.has(m)) return;
      if (!this.opts.valid(device)) { this.drop(m, MIRROR_CLOSE_REVOKED, 'device signed out'); return; }
      const text = mirrorOwnerText(raw);
      if (text === null) return;
      // Echoed to the holder and the other mirrors BEFORE the chat sees it, so every surface
      // shows the owner's words in the order they were typed.
      this.echo(text, ws);
      this.opts.onOwnerFrame(JSON.stringify({ type: 'user', text }));
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
}): 'mirror' | 'refuse' | 'pass' {
  // The RECORDED session, handed over or parked: a phone never adopts, resumes or respawns it
  // (a parked super child it took would hold the session from the next hand-over).
  // Case-blind: an id is a UUID, and an upper-case copy must not slip past as "another chat".
  const session = o.index.session?.toLowerCase() ?? null;
  const names = !!session && (o.resumeId.toLowerCase() === session || o.sessionId.toLowerCase() === session);
  if (names) return o.index.enabled && o.liveSuper ? 'mirror' : 'refuse';
  return o.mode === 'super' ? 'refuse' : 'pass';
}

/** The live-chat row shapes this module needs (contract.ts `LiveChatWire`). */
interface LiveRow { conversationId: string; vault: string | null; title: string | null; busy: boolean; state: 'working' | 'asking' | 'idle'; lastLine: string | null; updatedAt: number | null }

/**
 * The phone's live list with the Super Agent applied: a project whose Super Agent is handed over
 * (`handedOver`: vault name → its recorded super session) lists none of its chats, and ONE super
 * row instead (`live` false when the Mac runs no super child right now). Every other project's
 * rows are returned untouched, so with nothing handed over the answer is exactly today's.
 */
export function phoneLiveChats<R extends LiveRow>(chats: readonly R[], handedOver: ReadonlyMap<string, string>): {
  chats: R[]; supers: Array<LiveRow & { vault: string; live: boolean }>;
} {
  if (!handedOver.size) return { chats: [...chats], supers: [] };
  const supers: Array<LiveRow & { vault: string; live: boolean }> = [];
  for (const [vault, session] of handedOver) {
    const row = chats.find((c) => c.vault === vault && c.conversationId === session);
    supers.push(row
      ? { conversationId: row.conversationId, vault, title: null, busy: row.busy, state: row.state, lastLine: row.lastLine, updatedAt: row.updatedAt, live: true }
      : { conversationId: session, vault, title: null, busy: false, state: 'idle', lastLine: null, updatedAt: null, live: false });
  }
  return { chats: chats.filter((c) => !c.vault || !handedOver.has(c.vault)), supers };
}

// ─── The agenda's digest (task hands-free-telefonda-super-agent-sohbeti-ajandayi…) ──────────

/** The digest's fields, mirrored by `dashboard/src/lib/superTypes.ts` (super-types-mirror test). */
export const SUPER_DIGEST_FIELDS = ['pad', 'waiting', 'ownerBatches', 'names', 'key'] as const;
export const DIGEST_MAX_PAD = 40;
export const DIGEST_MAX_PAD_TEXT = 160;
export const DIGEST_MAX_WAITING = 40;
export const DIGEST_MAX_OWNER_TEXT = 300;
export const DIGEST_MAX_BATCHES = 50;
export const DIGEST_MAX_NAMES = 40;
export const DIGEST_MAX_NAME = 80;

/** The slice of the super record a digest reads (`SuperState` satisfies it). */
export interface SuperDigestSource {
  pad?: ReadonlyArray<{ id: string; section: string; text: string; at: number }>;
  queue: ReadonlyArray<{ id: string; kind: string; state: string; createdAt: number; sessionId: string; ownerText?: string }>;
  ownerBatches: readonly string[];
  containers: ReadonlyArray<{ kind: string; ref: string; title?: string }>;
  children: Readonly<Record<string, { brief: string; startedAt: number }>>;
}

/**
 * What a phone mirror is told of the Super Agent's agenda: the desktop's `SuperAgenda` is drawn
 * from it (`superNotepad`), the event turns fold with its `ownerBatches` and `names`. A
 * whitelist, never the record: no prompt, worktree, branch, task, ask spec, options, request id
 * or permission content. A name is the Mac's job card title (the chat card's `title`, else the
 * child's brief), never the chat registry's title (the prompt's first 80 characters).
 */
export interface SuperDigest {
  pad: Array<{ id: string; section: string; text: string; at: number }>;
  /** What waits on the owner (`needsOwner`) and the questions queued behind an open one. `text`
   *  is the item's `ownerText` (an `owner` item's is the child's card: untrusted plain text),
   *  '' on a permission. */
  waiting: Array<{ id: string; kind: string; state: string; createdAt: number; sessionId: string; text: string }>;
  ownerBatches: string[];
  names: Record<string, string>;
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

/** The digest of `state`. Pure. */
export function superDigest(state: SuperDigestSource): SuperDigest {
  const pad = (state.pad ?? []).slice(-DIGEST_MAX_PAD)
    .map((p) => ({ id: digestText(p.id, 12), section: p.section, text: digestText(p.text, DIGEST_MAX_PAD_TEXT), at: p.at }))
    .filter((p) => p.id && p.text);
  const owes = (q: SuperDigestSource['queue'][number]) => q.state !== 'done'
    && (q.kind === 'permission' || q.kind === 'owner' || q.state === 'escalated' || (q.kind === 'question' && q.state === 'pending'));
  const waiting = state.queue.filter(owes).slice(0, DIGEST_MAX_WAITING).map((q) => ({
    id: q.id, kind: q.kind, state: q.state, createdAt: q.createdAt, sessionId: q.sessionId,
    text: q.kind === 'permission' ? '' : digestText(q.ownerText, DIGEST_MAX_OWNER_TEXT),
  }));
  const ownerBatches = state.ownerBatches.filter((b) => typeof b === 'string').slice(-DIGEST_MAX_BATCHES);
  // The children the phone may name: the ones it waits on first, then the newest.
  const sids = [...new Set([
    ...waiting.map((w) => w.sessionId).filter((sid) => state.children[sid]),
    ...Object.entries(state.children).sort((a, b) => b[1].startedAt - a[1].startedAt).map(([sid]) => sid),
  ])].slice(0, DIGEST_MAX_NAMES);
  const names: Record<string, string> = {};
  for (const sid of sids) {
    const card = state.containers.find((c) => c.kind === 'chat' && c.ref === sid);
    const name = digestText(card?.title || state.children[sid]?.brief, DIGEST_MAX_NAME);
    if (name) names[sid] = name;
  }
  const body = { pad, waiting, ownerBatches, names };
  return { ...body, key: fnv(JSON.stringify(body)) };
}

/** The `_meta` frame carrying `d` to a phone mirror. */
export function superDigestFrame(d: SuperDigest): string {
  return JSON.stringify({ type: '_meta', subtype: 'super_digest', pad: d.pad, waiting: d.waiting, ownerBatches: d.ownerBatches, names: d.names, key: d.key });
}
