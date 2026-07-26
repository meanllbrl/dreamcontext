/**
 * Persistence for the pinned checklist window (plan §1.10) — and the fix for the
 * single worst defect three independent reviewers found in the first pass of
 * this design.
 *
 * THE FACT THAT SHAPES EVERYTHING HERE: the desktop app runs one Node server on
 * one port for its whole lifetime, and every vault window is the SAME origin
 * (`${location.origin}/?vault=<name>` — see `desktop.ts`'s `openVaultWindow`).
 * Vaults are separated per-request by a header, not by port. That means
 * `localStorage` is shared across every open project, not just across a
 * checklist's two windows — so a storage key or a window label that only
 * encodes the checklist `id` (not which VAULT it belongs to) lets two unrelated
 * projects that happen to pick the same id (the plan's own worked example is
 * `"asc-api-key"`) silently read, edit, and submit into EACH OTHER's checklist,
 * including whatever secret got pasted into it. Every export below therefore
 * takes `vault` and folds it into the key/label — there is no unscoped path.
 */
import type { ChecklistViewSpec } from './chatViewSpec';
import { emptyState, MAX_NOTE_CHARS, type ChecklistState } from './checklistState';

const ENV_PREFIX = 'dc.checklist.env.v1.';
const STATE_PREFIX = 'dc.checklist.state.v1.';

/** How long an idle checklist is kept before a sweep drops it. */
export const CHECKLIST_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** How long `writeState` waits after the last edit before it actually persists. */
export const CHECKLIST_WRITE_DEBOUNCE_MS = 300;

/**
 * Every byte of the input becomes two hex digits, so no two distinct strings
 * can ever produce the same output — unlike a character-replace sanitizer
 * (`[^a-zA-Z0-9_-]` → `-`), which collapses e.g. `"a.b"` and `"a-b"` onto the
 * same string. That collision is exactly the second defect the first pass of
 * this design had: a lossy label let two DIFFERENT checklist ids alias the
 * same window. Hex output is only ever `[0-9a-f]`, so it can never contain the
 * `-`/`.` separators used to join the parts below — that is what makes the
 * composite keys and labels injective too, not just this function in isolation.
 *
 * Labels and keys built from this are never shown to a user, so verbosity here
 * costs nothing; a collision would have cost a cross-project secret leak.
 */
export function labelPart(s: string): string {
  return Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Matches the desktop capability's `"checklist-*"` window-label glob. */
export function checklistWindowLabel(vault: string, id: string): string {
  return `checklist-${labelPart(vault)}-${labelPart(id)}`;
}

export function checklistEnvelopeKey(vault: string, id: string): string {
  return `${ENV_PREFIX}${labelPart(vault)}.${labelPart(id)}`;
}

export function checklistStateKey(vault: string, id: string): string {
  return `${STATE_PREFIX}${labelPart(vault)}.${labelPart(id)}`;
}

/**
 * What actually gets persisted for a checklist a chat message asked to open.
 * The spec ALONE is not enough to act on later — by the time Submit fires, the
 * window has no idea which project or which conversation asked for it unless
 * that travelled with the spec, and `localStorage` is shared across both.
 */
export interface ChecklistEnvelope {
  spec: ChecklistViewSpec;
  /** The project this checklist belongs to. */
  vault: string;
  /** The chat session Submit must land in. */
  conversationId: string;
  createdAt: number;
}

export function writeEnvelope(env: ChecklistEnvelope): void {
  try {
    localStorage.setItem(checklistEnvelopeKey(env.vault, env.spec.id), JSON.stringify(env));
  } catch { /* storage unavailable/full — best-effort, matches agentSettings.ts */ }
}

/**
 * Reads back an envelope, or null for anything that isn't exactly what was
 * written. The storage KEY is already vault-scoped, so a mismatch between the
 * requested `vault`/`id` and the parsed envelope's own fields should never
 * happen in practice — but that mismatch is precisely the shape of bug this
 * module exists to make unrepresentable, so it is treated as absence rather
 * than trusted, not merely asserted away.
 */
export function readEnvelope(vault: string, id: string): ChecklistEnvelope | null {
  try {
    const raw = localStorage.getItem(checklistEnvelopeKey(vault, id));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ChecklistEnvelope> | null;
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.vault !== vault) return null;
    if (!parsed.spec || parsed.spec.id !== id) return null;
    if (typeof parsed.conversationId !== 'string' || !parsed.conversationId) return null;
    if (typeof parsed.createdAt !== 'number') return null;
    return parsed as ChecklistEnvelope;
  } catch {
    return null;
  }
}

export function clearChecklist(vault: string, id: string): void {
  const stateKey = checklistStateKey(vault, id);
  const pending = writeTimers.get(stateKey);
  if (pending) { clearTimeout(pending); writeTimers.delete(stateKey); }
  try {
    localStorage.removeItem(checklistEnvelopeKey(vault, id));
    localStorage.removeItem(stateKey);
  } catch { /* best-effort */ }
}

/**
 * Reconstructs a `ChecklistState` restricted to ids the CURRENT spec still
 * has. This is the "re-issuing the same checklist `id` updates it in place"
 * behaviour (plan §1.2): per-item state survives for every item whose id still
 * exists, and is dropped for the rest, rather than a stale id lingering
 * forever or a shape mismatch surfacing as a crash.
 */
function reconcile(raw: Partial<ChecklistState> | null, spec: ChecklistViewSpec): ChecklistState {
  if (!raw) return emptyState(spec);
  const checked: Record<string, boolean> = {};
  const notes: Record<string, string> = {};
  const files: Record<string, string[]> = {};
  for (const item of spec.items) {
    checked[item.id] = raw.checked?.[item.id] === true;
    const note = raw.notes?.[item.id];
    if (typeof note === 'string' && note) notes[item.id] = note.slice(0, MAX_NOTE_CHARS);
    const attached = raw.files?.[item.id];
    if (Array.isArray(attached)) {
      const clean = attached.filter((f): f is string => typeof f === 'string');
      if (clean.length) files[item.id] = clean;
    }
  }
  return {
    v: 1,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
    checked,
    notes,
    files,
  };
}

export function readState(vault: string, id: string, spec: ChecklistViewSpec): ChecklistState {
  try {
    const raw = localStorage.getItem(checklistStateKey(vault, id));
    if (raw) return reconcile(JSON.parse(raw) as Partial<ChecklistState>, spec);
  } catch { /* fall through to fresh state */ }
  return emptyState(spec);
}

const writeTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Debounced persist. A `wants:'secret'` item's note is stripped BEFORE the
 * write is scheduled, not filtered only at flush time — so the value never
 * transits the debounce window either, even for the 300ms it would otherwise
 * sit in memory waiting to be written. Every other field is copied into a
 * fresh, explicitly-shaped object (never a spread of the caller's `s`), so an
 * unexpected extra property on the state object a future caller passes in
 * can never ride along into storage.
 *
 * Only a SECRET item's note is stripped — an ordinary item's note is
 * persisted as-is. A user who pastes a key into an ordinary note field (not
 * the one the agent marked `wants:'secret'`) is a known, accepted residual
 * risk (plan §1.13.6): there is no way to tell a note apart from a secret by
 * validation, so that gap is mitigated with a UI hint, not filtered here.
 */
export function writeState(vault: string, id: string, spec: ChecklistViewSpec, s: ChecklistState): void {
  const secretIds = new Set(spec.items.filter((i) => i.wants === 'secret').map((i) => i.id));
  const notes: Record<string, string> = {};
  for (const [itemId, text] of Object.entries(s.notes)) {
    if (!secretIds.has(itemId) && text) notes[itemId] = text;
  }
  const sanitized: ChecklistState = {
    v: 1,
    updatedAt: s.updatedAt,
    checked: { ...s.checked },
    notes,
    files: Object.fromEntries(Object.entries(s.files).map(([itemId, paths]) => [itemId, [...paths]])),
  };

  const key = checklistStateKey(vault, id);
  const pending = writeTimers.get(key);
  if (pending) clearTimeout(pending);
  writeTimers.set(key, setTimeout(() => {
    writeTimers.delete(key);
    try { localStorage.setItem(key, JSON.stringify(sanitized)); } catch { /* best-effort */ }
  }, CHECKLIST_WRITE_DEBOUNCE_MS));
}

/** Every stored key this module owns, via the standard `Storage` iteration
 *  surface (`length` + `key(i)`) rather than `Object.keys(localStorage)` — the
 *  latter isn't guaranteed to enumerate a Storage object's entries, and won't
 *  work at all against a minimal test stub that only implements the real
 *  `Storage` interface. */
function ownedKeys(): string[] {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k !== null && (k.startsWith(ENV_PREFIX) || k.startsWith(STATE_PREFIX))) keys.push(k);
  }
  return keys;
}

/**
 * Drops any checklist older than `CHECKLIST_TTL_MS`, envelope and state
 * together, so an abandoned checklist doesn't sit in `localStorage` (and, for
 * the secret's sake, a pasted key doesn't either) indefinitely. A state entry
 * whose envelope is already gone (e.g. a previous sweep or `clearChecklist` was
 * interrupted) ages out by its own `updatedAt` instead of being kept forever
 * for lack of a pairing.
 */
export function sweepExpired(now: number): void {
  let keys: string[];
  try {
    keys = ownedKeys();
  } catch {
    return;
  }

  const pairedStateKeys = new Set<string>();
  for (const key of keys) {
    if (!key.startsWith(ENV_PREFIX)) continue;
    let env: Partial<ChecklistEnvelope> | null = null;
    try {
      const raw = localStorage.getItem(key);
      env = raw ? (JSON.parse(raw) as Partial<ChecklistEnvelope>) : null;
    } catch {
      env = null;
    }
    const stateKey = env?.vault && env.spec?.id ? checklistStateKey(env.vault, env.spec.id) : null;
    if (stateKey) pairedStateKeys.add(stateKey);
    const createdAt = typeof env?.createdAt === 'number' ? env.createdAt : 0;
    if (!env || now - createdAt > CHECKLIST_TTL_MS) {
      try {
        localStorage.removeItem(key);
        if (stateKey) localStorage.removeItem(stateKey);
      } catch { /* best-effort */ }
    }
  }

  for (const key of keys) {
    if (!key.startsWith(STATE_PREFIX) || pairedStateKeys.has(key)) continue;
    try {
      const raw = localStorage.getItem(key);
      const parsed = raw ? (JSON.parse(raw) as Partial<ChecklistState>) : null;
      const updatedAt = typeof parsed?.updatedAt === 'number' ? parsed.updatedAt : 0;
      if (!parsed || now - updatedAt > CHECKLIST_TTL_MS) localStorage.removeItem(key);
    } catch {
      try { localStorage.removeItem(key); } catch { /* best-effort */ }
    }
  }
}
