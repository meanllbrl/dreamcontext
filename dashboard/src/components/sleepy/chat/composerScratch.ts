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
  /** `ref` is a pointer to a whiteboard element (an agent card's drag-to-ask), not a file:
   *  its `path` is the `dcref:wb/<board>/<id>` token the server expands into the element's
   *  content, and `name` is what the chip reads ("Note · Q3 plan"). It has no preview and no
   *  upload, so it is sendable the moment it is staged. `about` is the agenda line the next
   *  message is written about (owner 2026-10-23, the Super Agent's agenda): `text` is the block
   *  the message opens with (`agendaAboutBlock`), `name` what the chip reads. At most one per
   *  conversation (`setAbout`); it never makes a message on its own (`countsAsContent`). `page`
   *  is the page the Super dock is open on (owner 2026-10-25): `text` is the `[On page …]` block
   *  the message ENDS with, `name` what the chip reads. One per conversation
   *  (`setPageContext`), never content, and it stays after a send (the next message is written
   *  from the same page). */
  kind: 'image' | 'file' | 'folder' | 'ref' | 'element' | 'about' | 'page';
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
  /** `element`: an element the owner picked in a web card's page with Inspect (owner
   *  2026-10-22). `text` is the block the message carries (page, selector, element, text, React
   *  components, box); `url` is its picture as a data URL (the chip's thumbnail), and `path`,
   *  once uploaded, the picture the agent can open. It is sendable without a picture. */
  text?: string;
  /** Image attachments only — bytes still in flight, so there is no `path` to send yet.
   *  `submit` waits for these rather than sending a message that references nothing. */
  uploading?: boolean;
  /** Image attachments only — the upload was refused (not the desktop app, over the 25 MB
   *  cap, unwritable temp dir). The chip says so instead of pretending it will be sent. */
  failed?: boolean;
  /** What a failed chip says instead of the generic refusal (a phone photo this browser could
   *  not decode, a photo the phone's caps refused). */
  note?: string;
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
export function settleAttachment(convId: string, id: string, path: string | null, note?: string): void {
  const cur = readScratch(convId);
  if (!cur.attachments.some((a) => a.id === id)) return;
  commit(convId, {
    ...cur,
    attachments: cur.attachments.map((a) => (a.id === id
      ? { ...a, path: path ?? undefined, uploading: false, failed: !path, ...(!path && note ? { note } : {}) }
      : a)),
  });
}

/**
 * Give an image chip its preview once there is one worth showing (the hands-free phone shows
 * the small re-encoded JPEG, never the 24 MP original — decoding six of those for 44 px chips is
 * what gets a phone tab evicted). Revokes the URL it replaces. A no-op for a chip that has gone,
 * and the URL is revoked then, since nothing will.
 */
export function setAttachmentPreview(convId: string, id: string, url: string): void {
  const cur = readScratch(convId);
  const found = cur.attachments.find((a) => a.id === id);
  if (!found) { try { URL.revokeObjectURL(url); } catch { /* no DOM */ } return; }
  revoke(found);
  commit(convId, { ...cur, attachments: cur.attachments.map((a) => (a.id === id ? { ...a, url } : a)) });
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
export function dropSentAttachments(convId: string, opts: { keepAbout?: boolean } = {}): void {
  const cur = readScratch(convId);
  if (!cur.attachments.length && cur.quote === null) return;
  // A slash command never carries the About block, so its chip stays for the next message.
  // The page chip stays always: the next message is still written from that page.
  const gone = (a: Attachment) => a.kind !== 'page' && wasSent(a) && !(opts.keepAbout && a.kind === 'about');
  cur.attachments.forEach((a) => { if (gone(a)) revoke(a); });
  commit(convId, { attachments: cur.attachments.filter((a) => !gone(a)), quote: null });
}

/** A chip a send carries: one with a path, a picked element or an About line (its block is the
 *  content). */
export function wasSent(a: Attachment): boolean {
  return !!a.path || ((a.kind === 'element' || a.kind === 'about') && !!a.text);
}

/** A chip that is something to send by itself. An About line is not: it says what the message
 *  is about, and the message is still his to write. */
export function countsAsContent(a: Attachment): boolean {
  return a.kind !== 'about' && a.kind !== 'page' && wasSent(a);
}

/** Stage (or clear, with null) the agenda line the next message is written about. One per
 *  conversation: a second press on another line replaces it. */
export function setAbout(convId: string, about: Attachment | null): void {
  const cur = readScratch(convId);
  const rest = cur.attachments.filter((a) => a.kind !== 'about');
  if (!about && rest.length === cur.attachments.length) return;
  commit(convId, { ...cur, attachments: about ? [{ ...about, kind: 'about' }, ...rest] : rest });
}

/** Stage (or clear, with null) the page the next message is written from (the Super dock's page
 *  chip). One per conversation, placed last when staged. Only the dock's one effect calls it. */
export function setPageContext(convId: string, page: Attachment | null): void {
  const cur = readScratch(convId);
  const rest = cur.attachments.filter((a) => a.kind !== 'page');
  const was = cur.attachments.find((a) => a.kind === 'page');
  if (!page && !was) return;
  if (page && was && was.text === page.text && was.name === page.name) return;
  commit(convId, { ...cur, attachments: page ? [...rest, { ...page, kind: 'page' }] : rest });
}

/**
 * The message a send writes, from what is in the box. The About block opens it, then the reply
 * quote, then the typed text with its chips (`foldAttachments`), then the page block as the whole
 * last paragraph. A slash command is sent as typed: no block (`slash`, and the chips stay
 * staged). `quoted` is the message without the blocks: what must have something in it for a
 * send to happen at all.
 */
export function composeOutgoing(
  text: string, attachments: readonly Attachment[], quote: string | null, quotePath: (p: string) => string,
): { message: string; quoted: string; slash: boolean } {
  const bodyText = foldAttachments(text, attachments, quotePath);
  const quoted = quote ? `> ${quote}\n\n${bodyText}` : bodyText;
  const slash = text.trimStart().startsWith('/');
  const about = slash ? undefined : attachments.find((a) => a.kind === 'about' && !!a.text);
  const page = slash ? undefined : attachments.find((a) => a.kind === 'page' && !!a.text);
  const head = about?.text ? `${about.text}\n\n${quoted}` : quoted;
  return { message: page?.text && quoted.trim() ? `${head.trimEnd()}\n\n${page.text}` : head, quoted, slash };
}

/**
 * The message a send builds: the typed text, then the chips. A file is its quoted path on the
 * same line; a `ref` its token as written; a picked element its block on lines of its own, the
 * picture's path last. `quote` quotes a path the way the composer always has (agentComposer).
 */
export function foldAttachments(text: string, attachments: readonly Attachment[], quote: (p: string) => string): string {
  const paths = attachments.filter((a) => a.kind !== 'element' && a.kind !== 'about' && a.kind !== 'page' && !!a.path)
    .map((a) => (a.kind === 'ref' ? a.path ?? '' : quote(a.path ?? ''))).join(' ');
  const body = paths ? (text.trim() ? `${text.trim()} ${paths}` : paths) : text.trim();
  const blocks = attachments.filter((a) => a.kind === 'element' && !!a.text)
    .map((a) => (a.path ? `${a.text}\npicture: ${quote(a.path)}` : a.text ?? ''));
  return [body, ...blocks].filter(Boolean).join('\n\n');
}

const uploads = new Map<string, Set<Promise<unknown>>>();

/** An upload staged from OUTSIDE the composer (a picked element's picture, AgentSurface): a send
 *  waits for it like it waits for a pasted image, so the message carries the picture's path. */
export function trackUpload(convId: string, job: Promise<unknown>): void {
  let set = uploads.get(convId);
  if (!set) { set = new Set(); uploads.set(convId, set); }
  set.add(job);
  const done = () => {
    const live = uploads.get(convId);
    if (!live) return;
    live.delete(job);
    if (!live.size) uploads.delete(convId);
  };
  job.then(done, done);
}

/** The uploads a send to this conversation must wait for. */
export function pendingUploads(convId: string): Promise<unknown>[] {
  return [...(uploads.get(convId) ?? [])];
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
  uploads.clear();
  seq = 0;
}
