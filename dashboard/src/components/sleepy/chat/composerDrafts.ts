/**
 * SAVED DRAFTS — the Slack-style "keep this for later" shelf above a chat's composer.
 *
 * The composer has ONE slot: `ConversationModel.draft`, mirrored on every keystroke
 * (`syncDraft`) and carried across a respawn (`AgentSurface.carryDraftInto`). A user holding
 * a note there ("when the agent finishes, tell it X") had to delete it, or copy it somewhere,
 * to send anything else in the meantime. A saved draft is that slot's content — the text,
 * the chips that would have gone with it, and the reply quote — moved aside: ⌘S (or "Save as
 * draft" in the `+` menu) empties the box, and a click on the draft brings it back.
 *
 * ── Keyed like the scratch, for the same reason ─────────────────────────────────────
 * By the composer's scratch key (`scratchId || claudeId`), exactly as `composerScratch` keys
 * the chips: a respawn swaps the tab id and the session object, never the conversation id, so
 * drafts survive every mode switch and permission respawn with nothing to carry.
 *
 * ── Persisted through the roster, not localStorage ──────────────────────────────────
 * localStorage dies with the desktop app's per-launch loopback port (see the roster's
 * `chatPermissionMode`), so it cannot keep a draft across a restart. The per-vault,
 * machine-local roster file (`state/.agent-sessions.json`) is already where this surface keeps
 * what must outlive a launch, so the drafts ride in it as one map, conversation id → drafts
 * (`SavedSurface.drafts`): AgentSurface sends {@link allDrafts} with every roster PUT and
 * {@link seedAllDrafts} from the GET. A map rather than a field on each tab entry, so a draft
 * outlives its TAB — a closed chat reopened from Past chats, the Super Agent (never a tab) and
 * a launch with "Reopen past tabs" off all keep theirs. Nothing here talks to a server.
 *
 * ── Refuse before the caller cleans up ──────────────────────────────────────────────
 * {@link saveDraft} answers whether the draft was KEPT, and the composer empties the box only
 * on `ok`. Everything that can refuse (a chip still uploading, a draft over the caps, the
 * conversation's shelf full) refuses here, before a single character has left the box.
 */
import type { Attachment } from './composerScratch';

/** A chip as a draft keeps it: what a send needs, never an object URL or a data-URL picture
 *  (the first dies with the app run, the second would bloat the roster file). */
export interface DraftChip {
  kind: Attachment['kind'];
  name: string;
  path?: string;
  text?: string;
}

export interface SavedDraft {
  id: string;
  text: string;
  chips: DraftChip[];
  quote: string | null;
  /** Epoch ms — ordering and the chip's tooltip. */
  savedAt: number;
}

/** Per conversation. Mirrored by the server's `coerceMeta` (agent-sessions.ts). */
export const MAX_DRAFTS = 10;
export const MAX_DRAFT_TEXT = 8000;
export const MAX_DRAFT_QUOTE = 4000;
export const MAX_DRAFT_CHIPS = 20;
/** Conversations holding drafts at once — the server keeps no more (MAX_DRAFT_CONVERSATIONS
 *  in agent-sessions.ts), so a save past it is refused HERE rather than kept in memory only. */
export const MAX_DRAFT_CONVERSATIONS = 200;
/** All conversations together, serialized — keeps the roster file well under its byte cap
 *  (the server's MAX_BYTES), which would otherwise refuse the WHOLE roster write. */
export const DRAFTS_BUDGET_BYTES = 512 * 1024;

export type SaveResult = { ok: true; draft: SavedDraft } | { ok: false; reason: string };

const EMPTY: readonly SavedDraft[] = Object.freeze([]);
const store = new Map<string, SavedDraft[]>();
const listeners = new Map<string, Set<(d: readonly SavedDraft[]) => void>>();
const anyListeners = new Set<() => void>();
let seq = 0;

function nextId(): string {
  return `draft-${Date.now().toString(36)}-${++seq}`;
}

/** This conversation's saved drafts, oldest first. Never null. */
export function readDrafts(convId: string): readonly SavedDraft[] {
  return (convId && store.get(convId)) || EMPTY;
}

function commit(convId: string, next: SavedDraft[]): void {
  if (next.length === 0) store.delete(convId);
  else store.set(convId, next);
  const settled = readDrafts(convId);
  listeners.get(convId)?.forEach((fn) => fn(settled));
  anyListeners.forEach((fn) => fn());
}

/** Subscribe to one conversation's drafts. Returns the unsubscribe. */
export function subscribeDrafts(convId: string, fn: (d: readonly SavedDraft[]) => void): () => void {
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

/** Subscribe to ANY change (AgentSurface re-saves the roster on it). */
export function subscribeAnyDrafts(fn: () => void): () => void {
  anyListeners.add(fn);
  return () => { anyListeners.delete(fn); };
}

/** The chips a draft can keep: everything a send would carry. */
function keepChip(a: Attachment): DraftChip {
  return {
    kind: a.kind,
    name: a.name,
    ...(a.path ? { path: a.path } : {}),
    ...(a.text ? { text: a.text } : {}),
  };
}

/** UTF-8 bytes, as the server's roster cap counts them (a Turkish or emoji draft is 2-4x its
 *  `.length`). */
function utf8Bytes(v: unknown): number {
  return new TextEncoder().encode(JSON.stringify(v)).length;
}

function totalBytes(): number {
  let n = 0;
  for (const list of store.values()) n += utf8Bytes(list);
  return n;
}

/**
 * Keep the composer's content as a draft. Answers whether it was KEPT — the caller clears
 * the box only on `ok` (refuse-before-the-caller-cleans-up).
 *
 * `attachments` are the conversation's staged chips. A chip still uploading refuses the save
 * (it has no path yet, so the draft would hold a chip that refers to nothing); a chip that
 * failed is not part of the draft — it stays in the composer, saying "not sent", which is
 * exactly what `dropSentAttachments` leaves behind.
 */
export function saveDraft(
  convId: string,
  content: { text: string; attachments: readonly Attachment[]; quote: string | null },
  now: number = Date.now(),
): SaveResult {
  if (!convId) return { ok: false, reason: 'This composer has no conversation to keep a draft in.' };
  if (content.attachments.some((a) => a.uploading)) return { ok: false, reason: 'Wait for the attachment to finish uploading, then save the draft.' };
  const chips = content.attachments.filter((a) => !!a.path || (a.kind === 'element' && !!a.text)).map(keepChip);
  const text = content.text.replace(/\s+$/, '');
  const quote = content.quote && content.quote.trim() ? content.quote : null;
  if (!text.trim() && chips.length === 0 && !quote) return { ok: false, reason: 'Nothing to save.' };
  if (text.length > MAX_DRAFT_TEXT) return { ok: false, reason: `A draft can hold ${MAX_DRAFT_TEXT.toLocaleString()} characters; this one has ${text.length.toLocaleString()}.` };
  if (quote && quote.length > MAX_DRAFT_QUOTE) return { ok: false, reason: 'The reply quote is too long to keep in a draft.' };
  if (chips.length > MAX_DRAFT_CHIPS) return { ok: false, reason: `A draft can keep ${MAX_DRAFT_CHIPS} attachments.` };
  const cur = readDrafts(convId);
  if (!store.has(convId) && store.size >= MAX_DRAFT_CONVERSATIONS) {
    return { ok: false, reason: `Drafts are kept in ${MAX_DRAFT_CONVERSATIONS} chats at most — send or delete drafts in another chat first.` };
  }
  if (cur.length >= MAX_DRAFTS) return { ok: false, reason: `This chat already keeps ${MAX_DRAFTS} drafts — send or delete one first.` };
  const draft: SavedDraft = { id: nextId(), text, chips, quote, savedAt: now };
  if (totalBytes() + utf8Bytes(draft) > DRAFTS_BUDGET_BYTES) {
    return { ok: false, reason: 'Saved drafts are full across your chats — send or delete some first.' };
  }
  commit(convId, [...cur, draft]);
  return { ok: true, draft };
}

/** Delete one draft. */
export function deleteDraft(convId: string, id: string): void {
  const cur = readDrafts(convId);
  if (!cur.some((d) => d.id === id)) return;
  commit(convId, cur.filter((d) => d.id !== id));
}

/**
 * Take a draft OUT to put it back in the composer. When the box is not empty, its content is
 * kept as a draft IN THE SAME PLACE first (a swap), so opening a draft never costs what was
 * typed — and if that keep is refused, nothing is taken and the refusal comes back.
 *
 * Swap rather than merge: two half-messages glued together is a third message nobody wrote,
 * and the user would have to un-glue it by hand. A swap loses nothing and is undone by
 * clicking the other draft.
 */
export function takeDraft(
  convId: string,
  id: string,
  current: { text: string; attachments: readonly Attachment[]; quote: string | null },
  now: number = Date.now(),
): { ok: true; draft: SavedDraft } | { ok: false; reason: string } {
  const cur = readDrafts(convId);
  const idx = cur.findIndex((d) => d.id === id);
  if (idx < 0) return { ok: false, reason: 'That draft is gone.' };
  const taken = cur[idx];
  const hasContent = !!current.text.trim() || !!current.quote
    || current.attachments.some((a) => !!a.path || a.uploading || (a.kind === 'element' && !!a.text));
  if (!hasContent) {
    commit(convId, cur.filter((d) => d.id !== id));
    return { ok: true, draft: taken };
  }
  // Swap: the box's content takes the opened draft's slot. Measured against the shelf WITHOUT
  // the opened draft, so a full shelf can still swap.
  const without = cur.filter((d) => d.id !== id);
  store.set(convId, without);
  const kept = saveDraft(convId, current, now);
  if (!kept.ok) {
    store.set(convId, [...cur]);  // restore untouched — nothing was announced yet
    return kept;
  }
  const placed = [...without];
  placed.splice(idx, 0, kept.draft);
  commit(convId, placed);
  return { ok: true, draft: taken };
}

/** Coerce one stored draft (the roster is hand-editable INPUT), or null. */
export function coerceDraft(raw: unknown): SavedDraft | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id || typeof o.text !== 'string') return null;
  const chips = Array.isArray(o.chips)
    ? o.chips.slice(0, MAX_DRAFT_CHIPS).flatMap((c): DraftChip[] => {
      if (!c || typeof c !== 'object') return [];
      const r = c as Record<string, unknown>;
      const kinds: readonly string[] = ['image', 'file', 'folder', 'ref', 'element'];
      if (typeof r.kind !== 'string' || !kinds.includes(r.kind) || typeof r.name !== 'string') return [];
      return [{
        kind: r.kind as DraftChip['kind'],
        name: r.name,
        ...(typeof r.path === 'string' && r.path ? { path: r.path } : {}),
        ...(typeof r.text === 'string' && r.text ? { text: r.text } : {}),
      }];
    })
    : [];
  const quote = typeof o.quote === 'string' && o.quote ? o.quote.slice(0, MAX_DRAFT_QUOTE) : null;
  const text = o.text.slice(0, MAX_DRAFT_TEXT);
  if (!text.trim() && chips.length === 0 && !quote) return null;
  const savedAt = typeof o.savedAt === 'number' && Number.isFinite(o.savedAt) ? o.savedAt : 0;
  return { id: o.id, text, chips, quote, savedAt };
}

/**
 * Seed a conversation's drafts from the roster on load. A conversation that already has
 * drafts in memory keeps them — this app run's state is newer than the file it wrote.
 */
export function seedDrafts(convId: string, raw: unknown): void {
  if (!convId || store.has(convId) || !Array.isArray(raw)) return;
  const seen = new Set<string>();
  const list = raw.map(coerceDraft).filter((d): d is SavedDraft => {
    if (!d || seen.has(d.id)) return false;
    seen.add(d.id);
    return true;
  }).slice(0, MAX_DRAFTS);
  if (list.length) commit(convId, list);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every conversation's drafts, for the roster PUT. Only real conversation ids: a host keyed
 *  by its own scratch id (the agents channel) has nothing a relaunch could reopen. */
export function allDrafts(): Record<string, SavedDraft[]> {
  const out: Record<string, SavedDraft[]> = {};
  for (const [id, list] of store) if (UUID_RE.test(id) && list.length) out[id] = [...list];
  return out;
}

/** Seed every conversation in the roster's `drafts` map (see {@link seedDrafts}). */
export function seedAllDrafts(raw: unknown): void {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  for (const [id, list] of Object.entries(raw as Record<string, unknown>)) seedDrafts(id, list);
}

/** One line for the shelf: the first non-empty line of the text, else what it carries. */
export function draftLabel(d: SavedDraft, max = 48): string {
  const line = d.text.split('\n').map((l) => l.trim()).find(Boolean)
    ?? (d.chips.length ? d.chips.map((c) => c.name).join(', ') : d.quote ? `↩ ${d.quote}` : '');
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Test seam. */
export function __resetDraftsForTests(): void {
  store.clear();
  listeners.clear();
  anyListeners.clear();
  seq = 0;
}
