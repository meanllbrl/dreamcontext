/**
 * The composer's SCRATCH state — the attachment chips and the reply quote — keyed by the
 * CLAUDE CONVERSATION id rather than by component or by session.
 *
 * ── Why it moved out of the component ───────────────────────────────────────────────
 * A chat pane's identity IS its session object (`ChatPaneHost` is keyed by session id and
 * portaled into that session's own container), so switching mode — or moving permission to
 * Bypass, which CLI 2.1.220 refuses to apply live — respawns the process and unmounts the
 * pane. Everything the user had STAGED BUT NOT SENT died with it: the files they had just
 * attached, and the message they were replying to. The draft survives that by being carried
 * onto the incoming session (`AgentSurface.carryDraftInto`), but a chip cannot simply be
 * copied the same way: its image preview is an object URL whose lifetime the component owned
 * and revoked on unmount, so a copy would arrive holding a dead URL.
 *
 * ── Why not the session model, where the draft and the queue live ───────────────────
 * Because an in-flight upload OUTLIVES the respawn. `uploadAgentFile` resolves into
 * {@link settleAttachment} with the path the agent will actually read, and a session-scoped
 * home would leave that resolution writing into a model nothing renders any more — a chip
 * stuck "uploading…" for as long as the tab is open. The conversation id is the one key that
 * is stable across every respawn (it is literally what `--resume` carries), so it is the
 * honest owner of anything staged AGAINST THE CONVERSATION rather than against a process.
 *
 * Which makes this module the owner of the object URLs, and {@link dropScratch} the single
 * place they are revoked — called from `closeSessionById`, beside `clearPins`, for exactly the
 * reason stated there: that is the one path that ends a conversation for good, and every path
 * that KEEPS it swaps the tab id in place without coming through.
 *
 * ── In memory only, deliberately ────────────────────────────────────────────────────
 * Unlike pins (persisted per conversation), a chip's `path` points into the vault's gitignored
 * temp dir and its preview is an object URL — both are facts about THIS app run. Restoring
 * either after a restart would show the user a chip that no longer refers to anything.
 */

export interface Attachment {
  id: string;
  kind: 'image' | 'file' | 'folder';
  name: string;
  /** Image attachments only — an object URL for the pasted `File` blob, so the chip shows
   *  the picture itself while its bytes are still on their way to disk. Revoked when the entry
   *  leaves (removal, a send that carried it, or the conversation closing) — and NOT when a
   *  pane unmounts, which is the whole point of this module. The preview is NOT what gets sent
   *  (see `path`). */
  url?: string;
  /** The absolute path the outgoing message quotes — a real path from the native picker
   *  (`pickFiles`/`pickFolders`) for a file/folder, and for a pasted image the path the
   *  vault temp dir got when its bytes were uploaded (`uploadAgentFile`). The chat protocol
   *  is text-only, so this path IS the attachment as far as the agent is concerned. */
  path?: string;
  /** Image attachments only — bytes still in flight, so there is no `path` to send yet.
   *  `submit` waits for these rather than sending a message that references nothing. */
  uploading?: boolean;
  /** Image attachments only — the upload was refused (not the desktop app, over the 25 MB
   *  cap, unwritable temp dir). The chip says so instead of pretending it will be sent. */
  failed?: boolean;
}

export interface ComposerScratch {
  attachments: Attachment[];
  /** The message the next send quotes above its own text, or null. */
  quote: string | null;
}

/** Frozen, and shared by every conversation that has nothing staged: a caller that tried to
 *  reassign a field on it instead of replacing the whole record should fail loudly, not
 *  silently give every other conversation its chips. (Only the RECORD is frozen — the array
 *  stays a plain `Attachment[]` so the exported type is not `readonly`-flavoured for every
 *  consumer; every mutator here builds a new array anyway.) */
const EMPTY: ComposerScratch = Object.freeze({ attachments: [] as Attachment[], quote: null });

const store = new Map<string, ComposerScratch>();
const listeners = new Map<string, Set<(s: ComposerScratch) => void>>();

/**
 * Attachment ids come from HERE, not from a per-component counter.
 *
 * They used to be `att-${++attSeqRef.current}` off a ref in the composer, which restarts at 1
 * on every mount — so the first chip attached after a respawn would have collided with a chip
 * carried across it, and `removeAttachment`/`settleAttachment` would have hit the wrong one.
 * One monotonic counter for the app run costs nothing and cannot collide.
 */
let seq = 0;
export function nextAttachmentId(): string {
  return `att-${++seq}`;
}

/** This conversation's staged state. Never null — an unseen conversation reads as empty. */
export function readScratch(convId: string): ComposerScratch {
  return store.get(convId) ?? EMPTY;
}

function commit(convId: string, next: ComposerScratch): void {
  // An empty conversation is DELETED rather than stored empty, so a long session that attaches
  // and sends repeatedly does not accumulate a map entry per conversation it has finished with.
  if (next.attachments.length === 0 && next.quote === null) store.delete(convId);
  else store.set(convId, next);
  const settled = readScratch(convId);
  listeners.get(convId)?.forEach((fn) => fn(settled));
}

/** Subscribe to this conversation's staged state. Returns the unsubscribe. */
export function subscribeScratch(convId: string, fn: (s: ComposerScratch) => void): () => void {
  let set = listeners.get(convId);
  if (!set) { set = new Set(); listeners.set(convId, set); }
  set.add(fn);
  return () => {
    const live = listeners.get(convId);
    if (!live) return;
    live.delete(fn);
    if (live.size === 0) listeners.delete(convId);
  };
}

export function addAttachments(convId: string, added: Attachment[]): void {
  if (!added.length) return;
  const cur = readScratch(convId);
  commit(convId, { ...cur, attachments: [...cur.attachments, ...added] });
}

/**
 * An upload finished. `path` null means it was refused — the chip stays and says so rather
 * than disappearing, because a chip that vanishes reads as "sent".
 *
 * A no-op for an id that is no longer staged: the user can remove a chip while its bytes are
 * still in flight, and the resolution must not resurrect it.
 */
export function settleAttachment(convId: string, id: string, path: string | null): void {
  const cur = readScratch(convId);
  if (!cur.attachments.some((a) => a.id === id)) return;
  commit(convId, {
    ...cur,
    attachments: cur.attachments.map((a) => (a.id === id
      ? { ...a, path: path ?? undefined, uploading: false, failed: !path }
      : a)),
  });
}

/** Drop one chip (its ✕), revoking its preview. */
export function removeAttachment(convId: string, id: string): void {
  const cur = readScratch(convId);
  const found = cur.attachments.find((a) => a.id === id);
  if (!found) return;
  revoke(found);
  commit(convId, { ...cur, attachments: cur.attachments.filter((a) => a.id !== id) });
}

/**
 * A message just went out. Every chip that HAD a path went with it, so those leave (previews
 * revoked); everything else stays.
 *
 * "Has a path" is the honest test rather than "is not failed", which is what the composer used
 * to apply. They agree for a chip whose upload has settled, and they disagree in exactly the
 * case this module exists for: a chip pasted just before a respawn is `uploading` with no path
 * and no `failed` flag, and the old rule would have dropped it as though it had been sent.
 */
export function dropSentAttachments(convId: string): void {
  const cur = readScratch(convId);
  if (!cur.attachments.length && cur.quote === null) return;
  cur.attachments.forEach((a) => { if (a.path) revoke(a); });
  commit(convId, { attachments: cur.attachments.filter((a) => !a.path), quote: null });
}

/** Set (or clear, with null) the message the next send quotes. */
export function setQuote(convId: string, quote: string | null): void {
  const cur = readScratch(convId);
  if (cur.quote === quote) return;
  commit(convId, { ...cur, quote });
}

/**
 * The conversation is over — release everything staged against it.
 *
 * Called ONLY from the one path that ends a conversation for good (`closeSessionById`). A
 * respawn must never come through here: it keeps the conversation id, which is precisely how
 * the chips and the quote survive it.
 */
export function dropScratch(convId: string): void {
  const cur = store.get(convId);
  if (!cur) return;
  cur.attachments.forEach(revoke);
  store.delete(convId);
  listeners.get(convId)?.forEach((fn) => fn(EMPTY));
}

function revoke(a: Attachment): void {
  if (a.kind !== 'image' || !a.url) return;
  try { URL.revokeObjectURL(a.url); } catch { /* already gone / no DOM */ }
}

/** Test seam: forget everything without revoking (jsdom-free unit tests own their own URLs). */
export function __resetScratchForTests(): void {
  store.clear();
  listeners.clear();
  seq = 0;
}
