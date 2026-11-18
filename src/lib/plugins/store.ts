/**
 * The installed-plugin store (Mağaza D1, contract C2).
 *
 * Team data: `_dream_context/overrides/plugins/<id>.json` holds ONE owner entry per plugin,
 * `{ state: 'installed'|'removed', at, by }`, written only by a deliberate install/remove. A
 * plugin with no entry is installed iff its data exists (`PluginDef.hasData`), so an existing
 * project keeps what it uses with no migration and a new one has only core.
 *
 * This feature adds NO automatic tracked write: nothing here writes under `overrides/` except
 * `installPlugin`/`removePlugin`. Pins are personal and live in the ignored
 * `state/.brain-local.json` (`pluginPins`).
 *
 * `isPluginInstalled` is the one predicate callers use.
 */
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { splitConflictMarkers } from '../task-backend/conflict-markers.js';
import { withFileLockSync } from '../file-lock.js';
import { readBrainLocal, updateBrainLocal, updateSetupConfig } from '../setup-config.js';
import { resolveActivePerson } from '../people-resolve.js';
import { PLUGINS, getPlugin, isPluginId, type PluginDef, type PluginId } from './registry.js';

export const PLUGINS_REL_DIR = 'overrides/plugins';

export type PluginEntryState = 'installed' | 'removed';

export interface PluginEntry {
  state: PluginEntryState;
  /** ISO-8601 UTC. */
  at: string;
  /** Person slug, or `unknown`. */
  by: string;
}

export interface EntryRead {
  entry: PluginEntry | null;
  /** The file holds git conflict markers: `entry` is `pickEntry(ours, theirs)`. */
  conflict: boolean;
  /** The file exists but could not be read as an entry. */
  error?: string;
  /** Path relative to `_dream_context/`. */
  file: string;
}

export type PluginSource = 'chosen' | 'data' | 'none';

export interface PluginStatus {
  id: PluginId;
  installed: boolean;
  source: PluginSource;
  hasData: boolean;
  entry: PluginEntry | null;
  conflict: boolean;
  error?: string;
  file: string;
}

export class PluginEntryConflictError extends Error {
  readonly code = 'plugin_entry_conflict';
  constructor(readonly plugin: PluginId, readonly file: string, detail: string) {
    super(`plugin_entry_conflict: ${plugin} — ${detail} in ${file}. Edit ${file} to one side and commit.`);
  }
}

export class UnknownPluginError extends Error {
  readonly code = 'unknown_plugin';
  constructor(readonly plugin: string) {
    super(`unknown plugin: ${plugin}. Known: ${PLUGINS.map((p) => p.id).join(', ')}`);
  }
}

export function pluginEntryRel(id: string): string {
  return `${PLUGINS_REL_DIR}/${id}.json`;
}

// ─── Precedence: one function for plain git, full-repo and every reader ────

/** The later `at` wins; equal `at` → `installed` wins. */
export function pickEntry(a: PluginEntry, b: PluginEntry): PluginEntry {
  const ta = Date.parse(a.at);
  const tb = Date.parse(b.at);
  const va = Number.isFinite(ta) ? ta : -Infinity;
  const vb = Number.isFinite(tb) ? tb : -Infinity;
  if (va > vb) return a;
  if (vb > va) return b;
  if (a.state === 'installed') return a;
  return b;
}

export function parseEntry(text: string): PluginEntry | null {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (raw.state !== 'installed' && raw.state !== 'removed') return null;
    if (typeof raw.at !== 'string' || !Number.isFinite(Date.parse(raw.at))) return null;
    const by = typeof raw.by === 'string' && raw.by.length > 0 ? raw.by : 'unknown';
    return { state: raw.state, at: raw.at, by };
  } catch {
    return null;
  }
}

/**
 * Merge two sides of one entry file (full-repo `plugin-entry` class). An unparseable side
 * yields the other; both unparseable → null (the caller keeps git's conflict for the human).
 */
export function mergePluginEntry(ours: string, theirs: string): string | null {
  const a = parseEntry(ours);
  const b = parseEntry(theirs);
  const winner = a && b ? pickEntry(a, b) : (a ?? b);
  return winner ? serializeEntry(winner) : null;
}

function serializeEntry(e: PluginEntry): string {
  return JSON.stringify({ state: e.state, at: e.at, by: e.by }, null, 2) + '\n';
}

// ─── Reading ──────────────────────────────────────────────────────────────

/** `overrides/` and `overrides/plugins/` are real directories (a symlink is never read through). */
function pluginsDirState(contextRoot: string): 'absent' | 'ok' | 'symlink' {
  for (const rel of ['overrides', PLUGINS_REL_DIR]) {
    try {
      const st = lstatSync(join(contextRoot, rel));
      if (st.isSymbolicLink() || !st.isDirectory()) return 'symlink';
    } catch {
      return 'absent';
    }
  }
  return 'ok';
}

export function readEntry(contextRoot: string, id: string): EntryRead {
  const file = pluginEntryRel(id);
  const dirState = pluginsDirState(contextRoot);
  if (dirState === 'absent') return { entry: null, conflict: false, file };
  if (dirState === 'symlink') return { entry: null, conflict: false, error: `${PLUGINS_REL_DIR} is a symlink`, file };
  const abs = join(contextRoot, file);
  let text: string;
  try {
    const st = lstatSync(abs);
    if (st.isSymbolicLink() || !st.isFile()) return { entry: null, conflict: false, error: 'not a regular file', file };
    text = readFileSync(abs, 'utf-8');
  } catch {
    return { entry: null, conflict: false, file };
  }
  const sides = splitConflictMarkers(text);
  if (sides) {
    const a = parseEntry(sides.ours);
    const b = parseEntry(sides.theirs);
    const entry = a && b ? pickEntry(a, b) : (a ?? b);
    return entry
      ? { entry, conflict: true, file }
      : { entry: null, conflict: true, error: 'neither side of the git conflict parses', file };
  }
  const entry = parseEntry(text);
  return entry ? { entry, conflict: false, file } : { entry: null, conflict: false, error: 'unreadable entry', file };
}

function statusOf(contextRoot: string, def: PluginDef): PluginStatus {
  const read = readEntry(contextRoot, def.id);
  let data = false;
  try {
    data = def.hasData(contextRoot);
  } catch {
    data = false;
  }
  const chosen = read.entry !== null;
  return {
    id: def.id,
    installed: chosen ? read.entry!.state === 'installed' : data,
    source: chosen ? 'chosen' : data ? 'data' : 'none',
    hasData: data,
    entry: read.entry,
    conflict: read.conflict,
    ...(read.error ? { error: read.error } : {}),
    file: read.file,
  };
}

/** Every plugin's state, in registry order. Never throws; no cache (≤ 6 small files per read). */
export function pluginStatuses(contextRoot: string): PluginStatus[] {
  return PLUGINS.map((def) => {
    try {
      return statusOf(contextRoot, def);
    } catch {
      return { id: def.id, installed: false, source: 'none', hasData: false, entry: null, conflict: false, error: 'read failed', file: pluginEntryRel(def.id) } satisfies PluginStatus;
    }
  });
}

/** The installed ids, in registry order. */
export function installedSet(contextRoot: string): PluginId[] {
  return pluginStatuses(contextRoot).filter((s) => s.installed).map((s) => s.id);
}

/** The one predicate callers use. Unknown id → false. Never throws. */
export function isPluginInstalled(contextRoot: string, id: PluginId): boolean {
  const def = getPlugin(id);
  if (!def) return false;
  try {
    return statusOf(contextRoot, def).installed;
  } catch {
    return false;
  }
}

// ─── Writing (deliberate install / remove only) ───────────────────────────

/** The person at this keyboard, or `unknown`. */
export function actorSlug(contextRoot: string): string {
  try {
    return resolveActivePerson(contextRoot).slug ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function writeEntry(contextRoot: string, id: PluginId, state: PluginEntryState, by: string, now: Date): PluginEntry {
  const locks = join(contextRoot, 'state', '.locks');
  return withFileLockSync(join(locks, 'plugins.lock'), () => {
    const read = readEntry(contextRoot, id);
    if (read.conflict) throw new PluginEntryConflictError(id, read.file, 'the entry has an unresolved git conflict');
    if (read.error) throw new PluginEntryConflictError(id, read.file, read.error);
    const dir = join(contextRoot, PLUGINS_REL_DIR);
    for (const rel of ['overrides', PLUGINS_REL_DIR]) {
      try {
        if (lstatSync(join(contextRoot, rel)).isSymbolicLink()) {
          throw new PluginEntryConflictError(id, read.file, `${rel} is a symlink`);
        }
      } catch (err) {
        if (err instanceof PluginEntryConflictError) throw err;
      }
    }
    mkdirSync(dir, { recursive: true });
    const target = join(contextRoot, read.file);
    const entry: PluginEntry = { state, at: now.toISOString(), by };
    // The temp file sits in the ignored state/.locks (dot-prefixed, no `.json` ending), so a
    // crash never leaves one in the tracked folder; rename is atomic on one volume.
    mkdirSync(locks, { recursive: true });
    const tmp = join(locks, `.plugin-${id}.${process.pid}.${Date.now()}.tmp`);
    try {
      writeFileSync(tmp, serializeEntry(entry), 'utf-8');
      renameSync(tmp, target);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    return entry;
  });
}

export interface SwitchResult {
  entry: PluginEntry;
  /** Hypotheses only: the `learning.enabled` mirror failed (reported loudly, never rolled back). */
  mirrorError?: string;
}

function requirePlugin(id: string): PluginDef {
  if (!isPluginId(id)) throw new UnknownPluginError(id);
  return getPlugin(id)!;
}

function writeLearningMirror(contextRoot: string, id: PluginId, enabled: boolean): string | undefined {
  if (id !== 'hypotheses') return undefined;
  try {
    updateSetupConfig(dirname(contextRoot), { learning: { enabled } });
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export function installPlugin(contextRoot: string, id: string, by = actorSlug(contextRoot), now = new Date()): SwitchResult {
  const def = requirePlugin(id);
  const entry = writeEntry(contextRoot, def.id, 'installed', by, now);
  const mirrorError = writeLearningMirror(contextRoot, def.id, true);
  try {
    pinOnThisMac(contextRoot, def.id, true);
  } catch {
    /* pins are UI state: an install never fails on them */
  }
  return mirrorError ? { entry, mirrorError } : { entry };
}

export function removePlugin(contextRoot: string, id: string, by = actorSlug(contextRoot), now = new Date()): SwitchResult {
  const def = requirePlugin(id);
  const entry = writeEntry(contextRoot, def.id, 'removed', by, now);
  const mirrorError = writeLearningMirror(contextRoot, def.id, false);
  try {
    pinOnThisMac(contextRoot, def.id, false);
  } catch {
    /* pins are UI state */
  }
  return mirrorError ? { entry, mirrorError } : { entry };
}

/** Owner entry files of ids this CLI does not know (a newer CLI's plugin): left alone, listed. */
export function unknownEntryFiles(contextRoot: string): string[] {
  if (pluginsDirState(contextRoot) !== 'ok') return [];
  try {
    return readdirSync(join(contextRoot, PLUGINS_REL_DIR))
      .filter((n) => n.endsWith('.json') && !n.startsWith('.') && !isPluginId(n.slice(0, -5)))
      .map((n) => `${PLUGINS_REL_DIR}/${n}`);
  } catch {
    return [];
  }
}

// ─── Pins: machine-local, in state/.brain-local.json ──────────────────────

function projectRootOf(contextRoot: string): string {
  return dirname(contextRoot);
}

/**
 * This Mac's pinned plugin ids. Field absent → seeded once with the installed set (re-checked
 * inside the lock). Lock busy or the write failing → the computed pins, nothing written, never
 * blocks. `[]` stays empty. Written only when the value changes, never per poll.
 */
export function readPins(contextRoot: string, installed: PluginId[] = installedSet(contextRoot)): PluginId[] {
  const projectRoot = projectRootOf(contextRoot);
  const current = readBrainLocal(projectRoot).pluginPins;
  if (current !== undefined) return current.filter(isPluginId);
  try {
    const next = updateBrainLocal(projectRoot, (existing) =>
      existing.pluginPins !== undefined ? existing : { ...existing, pluginPins: [...installed] },
    );
    return (next.pluginPins ?? installed).filter(isPluginId);
  } catch {
    return [...installed];
  }
}

/** Pin or unpin one plugin on this Mac (install from here pins; remove from here unpins). */
export function pinOnThisMac(contextRoot: string, id: PluginId, pinned: boolean): PluginId[] {
  const projectRoot = projectRootOf(contextRoot);
  const seed = readPins(contextRoot);
  const has = seed.includes(id);
  if (has === pinned) return seed;
  const next = updateBrainLocal(projectRoot, (existing) => {
    const base = (existing.pluginPins ?? seed).filter((p) => p !== id);
    return { ...existing, pluginPins: pinned ? [...base, id] : base };
  });
  return (next.pluginPins ?? []).filter(isPluginId);
}

/** Replace this Mac's pins (`PUT /api/plugins/pins`). Unknown ids are dropped. */
export function setPins(contextRoot: string, pinned: string[]): PluginId[] {
  const clean = [...new Set(pinned.filter(isPluginId))];
  const next = updateBrainLocal(projectRootOf(contextRoot), (existing) => ({ ...existing, pluginPins: clean }));
  return (next.pluginPins ?? []).filter(isPluginId);
}
