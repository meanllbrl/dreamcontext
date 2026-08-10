/**
 * Which OS window currently holds which projects.
 *
 * WHY THIS EXISTS: `vaultWindowLabel(name)` (`desktop.ts`) mints a window label from ONE
 * vault name, which was a complete answer to "where does project X live?" only while a
 * window held exactly one project. A window now holds several, so a label derived from a
 * vault name no longer identifies a window at all — it names a window that may not exist,
 * while the window that DOES have that project answers to some other label entirely. Every
 * cross-window decision needs a real lookup instead: this registry.
 *
 * TRANSPORT: `localStorage` on the one shared origin. That is not a convenience — it is the
 * same property `checklistStore.ts`'s header establishes and depends on: the desktop app
 * serves every window from one Node server on one port, so `localStorage` is shared across
 * every open project. Storage is therefore the one channel a window can use to publish to
 * windows it holds no handle on.
 *
 * WHY A HEARTBEAT WHEN `WebviewWindow.getAll()` EXISTS (it is already used at
 * `desktop.ts:90-91`): on the desktop that call answers "is this window still alive?"
 * instantly and authoritatively. But the plain BROWSER dashboard is served from the same
 * origin and shares this same storage, and there `thisWindowLabel()` is `''` and there is no
 * Tauri window list to ask at all. The heartbeat is the one liveness mechanism that covers
 * both surfaces: on desktop it is belt-and-braces, in the browser it is the only belt. Rows
 * older than {@link STALE_MS} are ignored by every reader, so a window that crashed without
 * ever running `beforeunload` cannot haunt the registry for longer than three missed beats.
 *
 * TWO LOOKUPS, DELIBERATELY NOT ONE. {@link findWindowForVault} is a registry read and may
 * return a stale label; it is for the cheap "add a chip here or focus another window?"
 * decision, whose worst case is a focus call at a dead label. {@link resolveLiveWindowForVault}
 * corroborates that answer against the live window list and returns null when it cannot —
 * it is the only form allowed for a payload that can carry a secret. Picking the wrong one
 * on the checklist submit path is how a pasted API key reaches an unrelated project.
 */
import { isDesktop } from './desktop';

export const WINDOW_REGISTRY_KEY = 'dc.windows.v1';

/** How often a window should re-publish its row. Owned by the caller (WindowChrome). */
export const HEARTBEAT_MS = 5_000;

/** A row older than this is treated as a dead window — three missed heartbeats. */
export const STALE_MS = 15_000;

export interface WindowRegistryEntry {
  /** The window's REAL Tauri label (`getCurrentWindow().label`) — never a derived one. */
  label: string;
  /** The projects live in that window right now. */
  vaults: string[];
  /** When the row was last published (`Date.now()`). */
  ts: number;
}

/**
 * This window's label once resolved: a Tauri label on the desktop, `''` in a browser tab or
 * when the ACL refuses. `null` means "not resolved yet" — distinct from `''`, because an
 * unresolved window must not be mistaken for an untargetable one.
 */
let cachedLabel: string | null = null;
let labelPromise: Promise<string> | null = null;

async function readWindowLabel(): Promise<string> {
  if (!isDesktop()) return '';
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    return getCurrentWindow().label;
  } catch {
    // No Tauri runtime / ACL denial. An unlabelled window can't be an `emitTo` target, which
    // is exactly what `''` means here — the same answer as a browser tab.
    return '';
  }
}

/**
 * This window's real Tauri label, cached after the first resolution. `''` off-desktop.
 * A window's label never changes for the lifetime of the window, so caching is total.
 */
export function thisWindowLabel(): Promise<string> {
  if (cachedLabel !== null) return Promise.resolve(cachedLabel);
  if (!labelPromise) {
    labelPromise = readWindowLabel().then((label) => {
      cachedLabel = label;
      return label;
    });
  }
  return labelPromise;
}

function isEntry(value: unknown): value is WindowRegistryEntry {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Partial<WindowRegistryEntry>;
  return typeof row.label === 'string'
    && typeof row.ts === 'number'
    && Number.isFinite(row.ts)
    && Array.isArray(row.vaults)
    && row.vaults.every((v) => typeof v === 'string');
}

/**
 * Every well-formed row. A blob that is missing, unparseable, not an array, or holds rows of
 * the wrong shape reads as `[]` and the malformed rows are dropped on the next write — a
 * corrupt registry degrades to "nobody has anything open", never to a throw. That matters
 * because a throw here would propagate into a submit or a chip click.
 */
function readRows(): WindowRegistryEntry[] {
  try {
    const raw = window.localStorage.getItem(WINDOW_REGISTRY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntry);
  } catch {
    return []; // storage disabled (private mode) or corrupt JSON
  }
}

/** Rows from windows that have beaten within {@link STALE_MS}. */
function readFreshRows(now: number): WindowRegistryEntry[] {
  return readRows().filter((row) => now - row.ts < STALE_MS);
}

function writeRows(rows: WindowRegistryEntry[]): void {
  try {
    window.localStorage.setItem(WINDOW_REGISTRY_KEY, JSON.stringify(rows));
  } catch {
    // Quota / disabled storage. The heartbeat is idempotent, so a dropped write costs one
    // beat and the next one repairs it.
  }
}

/** Drop dead rows, writing only when something actually went away. */
function pruneStaleRows(): void {
  const now = Date.now();
  const all = readRows();
  const fresh = all.filter((row) => now - row.ts < STALE_MS);
  if (fresh.length !== all.length) writeRows(fresh);
}

/**
 * Publish the projects open in THIS window and refresh its timestamp. Call on every change
 * and every {@link HEARTBEAT_MS} tick.
 *
 * The read-modify-write is unlocked, so two windows publishing in the same instant can lose
 * one of the two rows. That is the designed-for failure: `setItem` is atomic per key so the
 * blob can never tear, and the loser re-publishes within one beat — a third of the way to
 * {@link STALE_MS}. Readers tolerate a missing row (they fall back to "not open anywhere");
 * nothing in this module tolerates a torn one, which is why the loss is the cheaper mode.
 */
export function publishOpenVaults(vaults: string[]): void {
  if (cachedLabel === null) {
    // First call: the Tauri label only comes back async. Start that, and let the next
    // heartbeat publish — one missed beat is invisible at three beats of staleness.
    void thisWindowLabel();
    pruneStaleRows();
    return;
  }
  if (!cachedLabel) {
    // A browser tab. It has no label, so no window could ever address it — claiming a row
    // would only put an untargetable label in front of readers. It still GCs, because it
    // shares the blob with every desktop window on this origin.
    pruneStaleRows();
    return;
  }
  const now = Date.now();
  const rows = readFreshRows(now).filter((row) => row.label !== cachedLabel);
  rows.push({ label: cachedLabel, vaults: [...vaults], ts: now });
  writeRows(rows);
}

/**
 * Withdraw this window's row. Call from `beforeunload` — a clean exit removes itself
 * immediately instead of leaving a lookup pointing at a closing window for up to
 * {@link STALE_MS}. Staleness GC is the backstop for the unclean exits this cannot cover.
 */
export function releaseWindow(): void {
  if (!cachedLabel) return; // never published — nothing to withdraw
  writeRows(readFreshRows(Date.now()).filter((row) => row.label !== cachedLabel));
}

/**
 * The window holding `vault`, or null.
 *
 * REGISTRY ONLY — the answer may name a window that has since closed, because the registry
 * is eventually consistent. Use this for decisions whose worst case is harmless: "is this
 * project already open somewhere, or do I add a chip for it?" — a focus call at a dead label
 * resolves to `false` and the caller falls through. **Never use it to address a payload**;
 * {@link resolveLiveWindowForVault} exists for that.
 */
export function findWindowForVault(vault: string): string | null {
  if (!vault) return null;
  const now = Date.now();
  for (const row of readFreshRows(now)) {
    // An empty label is a browser tab's row (see publishOpenVaults) — unaddressable. Our own
    // label is never an answer: "which OTHER window has this?" is the only question asked
    // here, and the caller has already checked its own instances.
    if (!row.label || row.label === cachedLabel) continue;
    if (row.vaults.includes(vault)) return row.label;
  }
  return null;
}

/**
 * The window holding `vault`, corroborated against the live window list — or null.
 *
 * THE ONLY FORM ALLOWED FOR A PAYLOAD THAT CAN CARRY A SECRET, and it FAILS CLOSED: there is
 * no optimistic fallback anywhere in this function. The registry alone is not good enough for
 * that job because it is eventually consistent (heartbeat interval, staleness GC, unlocked
 * read-modify-write), so a stale row can name the wrong window — and a wrong window now hosts
 * SEVERAL unrelated live projects, each with its own listener, so a mis-addressed payload
 * lands in all of their callbacks before any of them checks which project it belongs to.
 * Receiver-side filtering is not isolation.
 *
 * Off-desktop there is no window list to corroborate against and no `emitTo` to use the
 * answer, so this is null by construction.
 */
export async function resolveLiveWindowForVault(vault: string): Promise<string | null> {
  if (!isDesktop()) return null;
  const label = findWindowForVault(vault);
  if (!label) return null;
  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const live = await WebviewWindow.getAll();
    return live.some((win) => win.label === label) ? label : null;
  } catch {
    // Could not enumerate windows (ACL / no runtime) — an uncorroborated label is exactly
    // what this function refuses to hand back.
    return null;
  }
}
