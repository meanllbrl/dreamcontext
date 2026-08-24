/**
 * Persistence for the chat pin shelf — the same envelope pattern `checklistStore.ts`
 * established, and for the same reason.
 *
 * THE FACT THAT SHAPES THIS FILE (see checklistStore.ts's header for the full argument): the
 * desktop app runs one server on one port for its whole lifetime, and every vault window is
 * the SAME origin. `localStorage` is therefore shared across every open project, not just
 * across one project's windows — so a key that encodes only the conversation id would let
 * two projects read each other's pins. Every export here takes BOTH `vault` and
 * `conversationId` and folds both into the key; there is no unscoped path.
 *
 * `labelPart` is imported rather than re-implemented: it is the injective hex encoder that
 * makes the composite key collision-free, and a second copy is a second thing to get wrong.
 *
 * ── Why the conversation id and not the tab id ──────────────────────────────────────────
 * A chat tab's id is swapped on every resume path (`resumeChatSession` replaces `chat-N`
 * with a fresh one); the Claude conversation UUID survives. Keying on the conversation is
 * what makes "pins survive reopening the session" true rather than approximately true.
 */
import { labelPart } from './checklistStore';
import type { ShelfEntry, ShelfFact } from './shelfModel';

const PIN_PREFIX = 'dc.chatpins.v1.';

/** How long an untouched conversation's pins are kept before a sweep drops them. */
export const PIN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** How long `writePins` waits after the last change before it actually persists. */
export const PIN_WRITE_DEBOUNCE_MS = 300;

/** What is actually stored. `vault`/`conversationId` are repeated inside the envelope even
 *  though the key already carries them — the same belt-and-braces `readEnvelope` uses, so a
 *  mismatch reads as ABSENCE rather than as someone else's pins. */
export interface PinEnvelope {
  v: 1;
  vault: string;
  conversationId: string;
  entries: ShelfEntry[];
  updatedAt: number;
}

export function pinStoreKey(vault: string, conversationId: string): string {
  return `${PIN_PREFIX}${labelPart(vault)}.${labelPart(conversationId)}`;
}

/** Both parts must be non-empty. `labelPart('')` is `''`, which would collapse two different
 *  scopes onto one key — exactly the cross-project leak this module's scoping exists to
 *  prevent. An unscoped call is treated as having no pins, never as having everyone's. */
function scoped(vault: string, conversationId: string): boolean {
  return !!vault && !!conversationId;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** One persisted fact, or null. Unknown properties are dropped rather than carried. */
function coerceFact(raw: unknown): ShelfFact | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.label !== 'string' || !raw.label) return null;
  const fact: ShelfFact = { label: raw.label };
  if (typeof raw.url === 'string' && raw.url) fact.url = raw.url;
  if (raw.marker === true) fact.marker = true;
  if (raw.icon === 'branch' || raw.icon === 'worktree' || raw.icon === 'link') fact.icon = raw.icon;
  return fact;
}

/**
 * One persisted entry, or null when it isn't one.
 *
 * `localStorage` is not our private memory: it is shared-origin, user-writable, and survives
 * every version of this app that has ever run here. So a stored entry is INPUT, and a shape
 * from a future (or hand-edited) build must not reach the renderer — the shelf would throw
 * on `entry.facts.map` and take the whole composer down with it.
 *
 * Rebuilt field-by-field rather than cast, so an unexpected extra property can't ride back in.
 */
function coerceEntry(raw: unknown): ShelfEntry | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  if (typeof raw.updatedAt !== 'number' || !Number.isFinite(raw.updatedAt)) return null;

  if (raw.kind === 'progress') {
    if (typeof raw.task !== 'string' || !raw.task) return null;
    return { kind: 'progress', id: raw.id, task: raw.task, updatedAt: raw.updatedAt };
  }
  if (raw.kind !== 'pin') return null;
  if (raw.weight !== 'tag' && raw.weight !== 'row') return null;

  const facts = Array.isArray(raw.facts)
    ? raw.facts.map(coerceFact).filter((f): f is ShelfFact => f !== null)
    : [];
  const entry: ShelfEntry = { kind: 'pin', id: raw.id, weight: raw.weight, facts, updatedAt: raw.updatedAt };
  if (typeof raw.lede === 'string' && raw.lede) entry.lede = raw.lede;
  if (typeof raw.detail === 'string' && raw.detail) entry.detail = raw.detail;
  if (raw.ledeClamped === true) entry.ledeClamped = true;
  return entry;
}

/**
 * Reads back the entries, or `[]` for anything that isn't exactly what was written.
 *
 * A MALFORMED ENTRY IS DROPPED AND THE REST STILL RENDER — the array comes back healed, not
 * all-or-nothing. Losing one bad pin is a pin the user has to re-ask for; losing the whole
 * shelf (or throwing into the render) is the composer disappearing.
 */
export function readPins(vault: string, conversationId: string): ShelfEntry[] {
  if (!scoped(vault, conversationId)) return [];
  try {
    const raw = localStorage.getItem(pinStoreKey(vault, conversationId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Partial<PinEnvelope> | null;
    if (!parsed || typeof parsed !== 'object') return [];
    if (parsed.vault !== vault) return [];
    if (parsed.conversationId !== conversationId) return [];
    if (!Array.isArray(parsed.entries)) return [];
    return parsed.entries.map(coerceEntry).filter((e): e is ShelfEntry => e !== null);
  } catch {
    return [];
  }
}

/** Writes waiting out their debounce window: the timer to cancel, and the payload the flush
 *  below needs in order to land them without waiting. */
const pendingWrites = new Map<string, { timer: ReturnType<typeof setTimeout>; envelope: PinEnvelope }>();

function commit(key: string, envelope: PinEnvelope): void {
  try { localStorage.setItem(key, JSON.stringify(envelope)); }
  catch { /* storage full/unavailable — best-effort, matches checklistStore */ }
}

/**
 * Land every pending write NOW.
 *
 * The 300ms debounce is what keeps a streaming turn from serializing the shelf on every
 * applied event — but it also means the last 300ms of a session is exactly what a close
 * throws away, and "the user pinned something and then quit" is a completely ordinary way to
 * end a session. `pagehide` is the flush point rather than `unload`, which is deprecated and
 * disqualifies the page from the back/forward cache.
 */
export function flushPendingPins(): void {
  for (const [key, { timer, envelope }] of pendingWrites) {
    clearTimeout(timer);
    commit(key, envelope);
  }
  pendingWrites.clear();
}

let flushHookInstalled = false;

/** Installed on the FIRST write, not at import: this module is imported by root vitest,
 *  which runs under plain Node where there is no `window` to listen on. */
function ensureFlushHook(): void {
  if (flushHookInstalled || typeof window === 'undefined') return;
  flushHookInstalled = true;
  window.addEventListener('pagehide', flushPendingPins);
}

/**
 * Debounced persist. A shelf changes on every applied event of a live turn, and each write
 * is a full JSON serialize — the same reason `checklistStore.writeState` debounces.
 *
 * The envelope is built as an explicitly-shaped object, never a spread of the caller's, so
 * an unexpected property on a future `ShelfEntry` shape can't ride along into storage.
 */
export function writePins(
  vault: string,
  conversationId: string,
  entries: ShelfEntry[],
  now: number = Date.now(),
): void {
  if (!scoped(vault, conversationId)) return;
  const key = pinStoreKey(vault, conversationId);
  const envelope: PinEnvelope = {
    v: 1,
    vault,
    conversationId,
    entries: [...entries],
    updatedAt: now,
  };

  ensureFlushHook();
  const pending = pendingWrites.get(key);
  if (pending) clearTimeout(pending.timer);
  const timer = setTimeout(() => {
    pendingWrites.delete(key);
    commit(key, envelope);
  }, PIN_WRITE_DEBOUNCE_MS);
  pendingWrites.set(key, { timer, envelope });
}

/** Drops a conversation's pins now (its tab was closed for good, say). */
export function clearPins(vault: string, conversationId: string): void {
  if (!scoped(vault, conversationId)) return;
  const key = pinStoreKey(vault, conversationId);
  const pending = pendingWrites.get(key);
  if (pending) { clearTimeout(pending.timer); pendingWrites.delete(key); }
  try { localStorage.removeItem(key); } catch { /* best-effort */ }
}

/** Every stored key this module owns — via the standard `Storage` iteration surface
 *  (`length` + `key(i)`), not `Object.keys(localStorage)`, which isn't guaranteed to
 *  enumerate a Storage object and doesn't work against a minimal test stub. */
function ownedKeys(): string[] {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k !== null && k.startsWith(PIN_PREFIX)) keys.push(k);
  }
  return keys;
}

/**
 * Drops any conversation's pins older than {@link PIN_TTL_MS}.
 *
 * Scoped to `PIN_PREFIX` and nothing else: this module shares `localStorage` with the
 * checklist store and with `agentSettings`, and a sweep that reached past its own prefix
 * would be deleting another module's state on a schedule nobody wrote down.
 */
export function sweepExpiredPins(now: number): void {
  let keys: string[];
  try {
    keys = ownedKeys();
  } catch {
    return;
  }
  for (const key of keys) {
    try {
      const raw = localStorage.getItem(key);
      const parsed = raw ? (JSON.parse(raw) as Partial<PinEnvelope>) : null;
      const updatedAt = typeof parsed?.updatedAt === 'number' ? parsed.updatedAt : 0;
      if (!parsed || now - updatedAt > PIN_TTL_MS) localStorage.removeItem(key);
    } catch {
      // Unparseable: it can never be read back as pins anyway, so it is dead weight.
      try { localStorage.removeItem(key); } catch { /* best-effort */ }
    }
  }
}
