/**
 * Per-project localStorage, for the keys whose MEANING changes per project.
 *
 * `localStorage` is one store shared by every window on this origin — and, now that one
 * window holds several live projects, by every mounted instance inside it too. A key like
 * "which page was I on" written by two instances is last-writer-wins; a key like
 * "auto-commit on open" read by the wrong project flips real git behaviour against a repo
 * the user never opted in for. Those keys go through here; chrome/habit preferences (zoom,
 * theme, "I've read the About page") stay global and must NOT be routed through this module.
 *
 * A null vault means launcher / plain browser: the key is used VERBATIM and nothing is
 * migrated, so those surfaces behave byte-identically to before.
 */

export const SCOPE_PREFIX = 'dreamcontext:';

export interface ScopeOpts {
  /**
   * Copy the legacy value into the scoped key WITHOUT deleting the legacy key, so EVERY
   * vault seeds from it instead of only the first one to read it.
   *
   * Required for any key whose UNSET fallback is the unsafe direction. The worked example is
   * `autoCheckpointOnOpen`, which reads `getItem(KEY) !== '0'` — i.e. absent means ON. Under
   * the default policy a user who deliberately turned auto-commit OFF would keep that intent
   * for exactly one vault, and every other vault would find no scoped key, fall back to ON,
   * and start auto-committing their work.
   */
  keepLegacy?: boolean;
}

/**
 * `dreamcontext:<vault>:<key>` for a real project; the bare legacy `key` when there is no
 * vault. An empty-string vault counts as "no vault" — that is what `?vault=` with no value
 * yields, and `App.tsx` already treats it as launcher mode.
 */
export function scopedKey(vault: string | null, key: string): string {
  return vault ? `${SCOPE_PREFIX}${vault}:${key}` : key;
}

/**
 * `vault|key` pairs already considered for migration in this page's lifetime. The latch is
 * what makes migration run at most once per pair no matter how many components read the key,
 * and it is why a `removeScoped` cannot be undone by the legacy value coming back on the
 * next read.
 */
const migrated = new Set<string>();

/**
 * Move a pre-scoping value into its scoped home, once.
 *
 * Lives in the RAW layer on purpose: it moves the stored string unchanged, so one code path
 * serves both the JSON-encoded keys and the `'1'`/`'0'` string keys.
 *
 * DOCUMENTED CONSEQUENCE of the default (no `keepLegacy`): the legacy value goes to whichever
 * project reads it FIRST and the legacy key is then deleted, so a second vault reading the
 * same key gets the fallback. Copy-without-delete would re-seed every future project from a
 * value that belonged to whatever project happened to be open last. This mirrors
 * `hooks/usePersistedState.ts`'s one-time migration. Opt out with `keepLegacy` only for the
 * keys documented on {@link ScopeOpts}.
 */
function migrateLegacyOnce(vault: string, key: string, keepLegacy: boolean): void {
  const pair = `${vault}|${key}`;
  if (migrated.has(pair)) return;
  // Latch BEFORE touching storage: a private-mode throw is not transient, and retrying it on
  // every read would just repeat the same failure at a cost.
  migrated.add(pair);
  try {
    const scoped = scopedKey(vault, key);
    if (localStorage.getItem(scoped) !== null) return; // already scoped — nothing to move
    const legacy = localStorage.getItem(key);
    if (legacy === null) return;
    localStorage.setItem(scoped, legacy);
    if (!keepLegacy) localStorage.removeItem(key);
  } catch { /* storage unavailable (private mode / quota) — the read below falls back */ }
}

/** The stored string for a scoped key, migrating a legacy value in on first read. */
export function readScopedRaw(vault: string | null, key: string, opts: ScopeOpts = {}): string | null {
  if (vault) migrateLegacyOnce(vault, key, opts.keepLegacy === true);
  try {
    return localStorage.getItem(scopedKey(vault, key));
  } catch {
    return null; // storage unavailable — indistinguishable from "never set", and both mean fallback
  }
}

export function writeScopedRaw(vault: string | null, key: string, value: string): void {
  try {
    localStorage.setItem(scopedKey(vault, key), value);
  } catch { /* quota exceeded or storage disabled — a lost preference must never break a render */ }
}

/**
 * JSON layer over {@link readScopedRaw}. Corrupt JSON reads as unset.
 *
 * No `ScopeOpts`: `keepLegacy` exists for keys whose unset-fallback is unsafe, and every one
 * of those is a bare `'1'`/`'0'` flag on the raw layer. Add it here only when that stops
 * being true.
 */
export function readScoped<T>(vault: string | null, key: string, fallback: T): T {
  const raw = readScopedRaw(vault, key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeScoped<T>(vault: string | null, key: string, value: T): void {
  try {
    writeScopedRaw(vault, key, JSON.stringify(value));
  } catch { /* unserialisable value (cycle) — nothing sane to store */ }
}

/**
 * Forget a scoped value. Runs the migration first so the legacy key is consumed exactly as a
 * read would have consumed it — otherwise a remove on a never-yet-read key would leave the
 * legacy value behind and the NEXT read would resurrect what the caller just deleted.
 */
export function removeScoped(vault: string | null, key: string): void {
  if (vault) migrateLegacyOnce(vault, key, false);
  try {
    localStorage.removeItem(scopedKey(vault, key));
  } catch { /* storage unavailable — nothing was readable anyway */ }
}
