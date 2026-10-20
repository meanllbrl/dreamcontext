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
 *     effort switch, a rewind or any `*_command_result` is dropped here, so the phone can talk to
 *     the Super Agent and never drive it. Its text joins the SAME path the desktop's does, so the
 *     inbox's hold (D8) orders both surfaces' messages as one queue.
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
  on(event: 'message', fn: (raw: Buffer | string) => void): unknown;
  on(event: 'close' | 'error', fn: () => void): unknown;
}

/** Closed: the device behind the mirror signed out, or Mac mode returned. */
export const MIRROR_CLOSE_REVOKED = 4401;
/** Closed: the super child this mirror watched ended (a respawn, a take-back). The client
 *  reconnects and lands on the successor, or is refused once the mode is off. */
export const MIRROR_CLOSE_ENDED = 4410;
/** A phone message longer than this is not chat: dropped. */
export const MIRROR_MAX_TEXT = 100_000;
/** At most this many phone mirrors on one super child. */
export const MAX_MIRRORS = 4;

export interface MirrorOpts<D> {
  /** Is this device still signed in? Asked on every frame the mirror sends up. */
  valid: (device: D) => boolean;
  /** The owner's text from the phone, handed to the chat's own owner path (a raw `user` frame). */
  onOwnerFrame: (raw: string) => void;
  /** The socket holding the child right now (the desktop window), or null while detached. */
  holder: () => MirrorSocket | null;
}

interface Mirror<D> { ws: MirrorSocket; device: D }

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

export class MirrorSet<D> {
  private readonly mirrors = new Set<Mirror<D>>();

  constructor(private readonly opts: MirrorOpts<D>) {}

  get size(): number { return this.mirrors.size; }

  /** Join `ws` as a mirror owned by `device`. False when the set is full (the caller refuses). */
  add(ws: MirrorSocket, device: D): boolean {
    if (this.mirrors.size >= MAX_MIRRORS) return false;
    const m: Mirror<D> = { ws, device };
    this.mirrors.add(m);
    const gone = (): void => { this.mirrors.delete(m); };
    ws.on('close', gone);
    ws.on('error', gone);
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
 *     the desktop's, D4), or ANY open naming the handed-over super session that cannot mirror (no
 *     live child, a plain-chat resume or reattach that would supersede or evict the window's).
 *   • `pass` — nothing to do with the Super Agent: the open goes on as before. A vault that is
 *     not handed over is always `pass` unless `mode=super` (today's behaviour, unchanged).
 */
export function phoneSuperOpen(o: {
  mode: string; resumeId: string; sessionId: string;
  index: { session: string | null; enabled: boolean };
  liveSuper: boolean;
}): 'mirror' | 'refuse' | 'pass' {
  const session = o.index.enabled ? o.index.session : null;
  const names = !!session && (o.resumeId === session || o.sessionId === session);
  if (names) return o.liveSuper ? 'mirror' : 'refuse';
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
