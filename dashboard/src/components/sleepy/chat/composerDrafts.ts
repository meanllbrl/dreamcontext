/**
 * The composer's UNSENT content, kept per conversation across restarts — Slack's draft
 * behaviour: what you typed stays in the box. Switch chats and come back, close the tab and
 * reopen it from Past chats, quit the app, hand over to the Super Agent: the text, the chips
 * and the reply quote are where you left them. Sending clears the box and, with it, this record.
 *
 * ── One slot, mirroring the box ─────────────────────────────────────────────────────
 * The box itself is unchanged: `ConversationModel.draft` (mirrored on every keystroke by
 * `syncDraft`, carried across a respawn by `AgentSurface.carryDraftInto`) plus the chips and
 * quote in `composerScratch`. Both live in memory only. This module is their PERSISTED mirror:
 * the composer writes its content here whenever it changes ({@link persistDraft}) and reads it
 * back when it mounts against an empty box ({@link readDraft}). Seeing it is "this run's".
 *
 * ── Keyed by project AND conversation ──────────────────────────────────────────────
 * The conversation part is the composer's scratch key (`scratchId || claudeId`): a respawn
 * swaps the tab id and the session object, never the conversation id. The project part exists
 * because one window holds several projects, each with its OWN roster file: a project must
 * write and seed only its own drafts, or a draft cleared by a send in project B would survive
 * in project A's file and come back from there.
 *
 * ── A seed never undoes this run ────────────────────────────────────────────────────
 * Every key this run wrote or cleared is remembered ({@link touched}); a seed skips it. A
 * re-hydrate (a 409, the end of Mac mode) reads a file that may predate the PUT that cleared
 * a sent message, and must not put that message back in the box.
 *
 * ── Persisted through the roster, not localStorage ──────────────────────────────────
 * localStorage dies with the desktop app's per-launch loopback port (see the roster's
 * `chatPermissionMode`), so it cannot keep a draft across a restart. The per-vault,
 * machine-local roster file (`state/.agent-sessions.json`) is already where this surface keeps
 * what must outlive a launch, so the drafts ride in it as one map, conversation id → draft
 * (`SavedSurface.drafts`): AgentSurface sends {@link allDrafts} with every roster PUT and
 * {@link seedAllDrafts} from the GET. A map rather than a field on each tab entry, so a draft
 * outlives its TAB — a closed chat, the Super Agent (never a tab) and a launch with "Reopen
 * past tabs" off all keep theirs. Nothing here talks to a server.
 *
 * ── What is not kept ───────────────────────────────────────────────────────────────
 * A chip still uploading (no path yet — it is written once it settles), a chip whose upload
 * failed, an image's object-URL preview (it dies with the app run; the chip comes back with a
 * glyph and its path). Content over the caps keeps the LAST version that fit rather than a
 * truncated one: an earlier whole draft is honest, a cut one is not.
 */
import { nextAttachmentId, type Attachment } from './composerScratch';
import { isTokenRef, parseRefTokens, refToken, refTokenId } from './composerRefs';

/** A chip as a draft keeps it: what a send needs, never an object URL or a data-URL picture. */
export interface DraftChip {
  kind: Attachment['kind'];
  name: string;
  path?: string;
  text?: string;
  /** An inline chip: drawn as a token in the draft's text (picture, file, element, ↩ reply, About line). */
  inline?: true;
  /** The paste token a chip carries (`Attachment.chip`). */
  chip?: string;
  /** The id of this chip's token in the saved text; a restore mints a new id and rewrites it. */
  tid?: string;
}

export interface SavedDraft {
  text: string;
  chips: DraftChip[];
  quote: string | null;
  /** Epoch ms of the last change. */
  savedAt: number;
}

/** Mirrored by the server's coercion (agent-sessions.ts; drift-tested). */
export const MAX_DRAFT_TEXT = 20000;
export const MAX_DRAFT_QUOTE = 4000;
export const MAX_DRAFT_CHIPS = 20;
export const MAX_DRAFT_CONVERSATIONS = 200;
/** All conversations together, UTF-8 — keeps the roster file well under its byte cap (the
 *  server's MAX_BYTES), which would otherwise refuse the WHOLE roster write. */
export const DRAFTS_BUDGET_BYTES = 512 * 1024;

/** vault → conversation id → kept draft. */
const store = new Map<string, Map<string, SavedDraft>>();
const listeners = new Map<string, Set<(d: SavedDraft | null) => void>>();
const anyListeners = new Set<() => void>();
/** Keys (`vault\nconvId`) this run wrote or cleared — a seed never overrides them. */
const touched = new Set<string>();

const keyOf = (vault: string | null, convId: string) => `${vault ?? ''}\n${convId}`;
function bucket(vault: string | null): Map<string, SavedDraft> {
  let b = store.get(vault ?? '');
  if (!b) { b = new Map(); store.set(vault ?? '', b); }
  return b;
}

/** This conversation's kept draft, or null. */
export function readDraft(vault: string | null, convId: string): SavedDraft | null {
  return (convId && store.get(vault ?? '')?.get(convId)) || null;
}

function notify(vault: string | null, convId: string): void {
  const d = readDraft(vault, convId);
  listeners.get(keyOf(vault, convId))?.forEach((fn) => fn(d));
  anyListeners.forEach((fn) => fn());
}

/** Subscribe to one conversation's kept draft (a roster seed landing after mount). */
export function subscribeDraft(vault: string | null, convId: string, fn: (d: SavedDraft | null) => void): () => void {
  const key = keyOf(vault, convId);
  let set = listeners.get(key);
  if (!set) { set = new Set(); listeners.set(key, set); }
  set.add(fn);
  return () => {
    const live = listeners.get(key);
    if (!live) return;
    live.delete(fn);
    if (live.size === 0) listeners.delete(key);
  };
}

/** Subscribe to ANY change (AgentSurface re-saves the roster on it). */
export function subscribeAnyDrafts(fn: () => void): () => void {
  anyListeners.add(fn);
  return () => { anyListeners.delete(fn); };
}

/** The chips a draft keeps: what a send would carry. */
export function keptChips(attachments: readonly Attachment[]): DraftChip[] {
  return attachments.filter((a) => !!a.path || ((a.kind === 'element' || a.kind === 'about') && !!a.text)).map((a) => ({
    kind: a.kind,
    name: a.name,
    ...(a.path ? { path: a.path } : {}),
    ...(a.text ? { text: a.text } : {}),
    ...(a.inline ? { inline: true as const } : {}),
    ...(a.chip ? { chip: a.chip } : {}),
    ...(isTokenRef(a) ? { tid: refTokenId(a) } : {}),
  }));
}

/**
 * A kept draft put back in the box: its chips as fresh attachments, and the text with every
 * token re-pointed at its chip's NEW id (a token's id is this run's nonce plus the chip's
 * sequence, so a saved one matches nothing after a restart). A token whose chip was not kept
 * stays as it is; the composer's own reconcile turns it into plain words.
 */
export function restoreDraftBody(d: SavedDraft): { text: string; attachments: Attachment[] } {
  const attachments: Attachment[] = [];
  const byTid = new Map<string, Attachment>();
  for (const { tid, ...c } of d.chips) {
    const att: Attachment = { id: nextAttachmentId(), ...c };
    attachments.push(att);
    if (tid) byTid.set(tid, att);
  }
  let text = d.text;
  const spans = parseRefTokens(text).filter((t) => byTid.has(t.id)).reverse();
  for (const t of spans) text = text.slice(0, t.start) + refToken(byTid.get(t.id)!) + text.slice(t.end);
  return { text, attachments };
}

function utf8Bytes(v: unknown): number {
  return new TextEncoder().encode(JSON.stringify(v)).length;
}

function sameDraft(a: SavedDraft | null, b: Omit<SavedDraft, 'savedAt'>): boolean {
  return !!a && a.text === b.text && a.quote === b.quote && JSON.stringify(a.chips) === JSON.stringify(b.chips);
}

export type PersistResult = 'kept' | 'cleared' | 'unchanged' | 'over-limit';

/**
 * Mirror the box into the kept draft. An empty box (nothing typed, nothing that would be sent,
 * no quote) CLEARS the record — which is how a send clears it. Over a cap, the previous record
 * stays (`over-limit`), never a truncated copy.
 */
export function persistDraft(
  vault: string | null,
  convId: string,
  content: { text: string; attachments: readonly Attachment[]; quote: string | null },
  now: number = Date.now(),
): PersistResult {
  if (!convId) return 'unchanged';
  const b = bucket(vault);
  const chips = keptChips(content.attachments);
  const quote = content.quote && content.quote.trim() ? content.quote : null;
  const text = content.text;
  if (!text.trim() && chips.length === 0 && !quote) {
    // Touched only when a record really goes: an empty box with nothing kept (a mount before
    // the roster GET answers, StrictMode's second effect run) must not block the late seed.
    if (!b.has(convId)) return 'unchanged';
    touched.add(keyOf(vault, convId));
    b.delete(convId);
    notify(vault, convId);
    return 'cleared';
  }
  const prev = readDraft(vault, convId);
  if (sameDraft(prev, { text, chips, quote })) return 'unchanged';
  if (text.length > MAX_DRAFT_TEXT || (quote && quote.length > MAX_DRAFT_QUOTE) || chips.length > MAX_DRAFT_CHIPS) return 'over-limit';
  if (!prev && b.size >= MAX_DRAFT_CONVERSATIONS) return 'over-limit';
  const next: SavedDraft = { text, chips, quote, savedAt: now };
  let others = 0;
  for (const [id, d] of b) if (id !== convId) others += utf8Bytes(d);
  if (others + utf8Bytes(next) > DRAFTS_BUDGET_BYTES) return 'over-limit';
  touched.add(keyOf(vault, convId));
  b.set(convId, next);
  notify(vault, convId);
  return 'kept';
}

/** Forget a conversation's kept draft — its content moved to another conversation id (an
 *  agent pick on a fresh tab mints a new one and carries the box over). */
export function clearDraft(vault: string | null, convId: string): void {
  touched.add(keyOf(vault, convId));
  if (store.get(vault ?? '')?.delete(convId)) notify(vault, convId);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every conversation's kept draft, for the roster PUT. Only real conversation ids: a host keyed
 *  by its own scratch id (the agents channel) has nothing a relaunch could reopen. */
export function allDrafts(vault: string | null): Record<string, SavedDraft> {
  const out: Record<string, SavedDraft> = {};
  for (const [id, d] of store.get(vault ?? '') ?? []) if (UUID_RE.test(id)) out[id] = d;
  return out;
}

/** Coerce one stored draft (the roster is hand-editable INPUT), or null. */
export function coerceDraft(raw: unknown): SavedDraft | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.text !== 'string' || o.text.length > MAX_DRAFT_TEXT) return null;
  const kinds: readonly string[] = ['image', 'file', 'folder', 'ref', 'element', 'about'];
  const chips = Array.isArray(o.chips)
    ? o.chips.slice(0, MAX_DRAFT_CHIPS).flatMap((c): DraftChip[] => {
      if (!c || typeof c !== 'object') return [];
      const r = c as Record<string, unknown>;
      if (typeof r.kind !== 'string' || !kinds.includes(r.kind) || typeof r.name !== 'string') return [];
      return [{
        kind: r.kind as DraftChip['kind'],
        name: r.name,
        ...(typeof r.path === 'string' && r.path ? { path: r.path } : {}),
        ...(typeof r.text === 'string' && r.text ? { text: r.text } : {}),
        ...(r.inline === true ? { inline: true as const } : {}),
        ...(typeof r.chip === 'string' && r.chip && r.chip.length <= 600 ? { chip: r.chip } : {}),
        ...(typeof r.tid === 'string' && /^\d{1,12}$/.test(r.tid) ? { tid: r.tid } : {}),
      }];
    })
    : [];
  const quote = typeof o.quote === 'string' && o.quote && o.quote.length <= MAX_DRAFT_QUOTE ? o.quote : null;
  if (!o.text.trim() && chips.length === 0 && !quote) return null;
  const savedAt = typeof o.savedAt === 'number' && Number.isFinite(o.savedAt) ? o.savedAt : 0;
  return { text: o.text, chips, quote, savedAt };
}

/**
 * Seed the kept drafts from the roster on load. A conversation this app run already holds a
 * draft for keeps it — this run's state is newer than the file it wrote.
 */
export function seedAllDrafts(vault: string | null, raw: unknown): void {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const b = bucket(vault);
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!id || b.has(id) || touched.has(keyOf(vault, id)) || b.size >= MAX_DRAFT_CONVERSATIONS) continue;
    const d = coerceDraft(v);
    if (!d) continue;
    b.set(id, d);
    notify(vault, id);
  }
}

/** Test seam. */
export function __resetDraftsForTests(): void {
  store.clear();
  listeners.clear();
  anyListeners.clear();
  touched.clear();
}
