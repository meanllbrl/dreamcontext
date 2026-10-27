import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeSync,
  chmodSync, statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { listClaudeAccounts } from './claude-accounts.js';
import { FORBIDDEN_KEYS } from './super/lean-mcp.js';
import type { McpOutsideServer } from './mcp-wire.js';

/**
 * Where dreamcontext keeps the MCP servers every Claude account on this computer uses
 * (task mcp-management, owner decision 2026-10-27).
 *
 * ── Why ──────────────────────────────────────────────────────────────────────────────────
 * Claude Code keeps MCP servers per config directory. With several accounts each one forked
 * its own list: a server added on one account was missing on the next, and a sandbox only saw
 * a mirror of the real `~/.claude.json` top level. So the app keeps its OWN two files, on this
 * computer, and every spawn on every account (account #0 included) is handed them with
 * `--mcp-config`:
 *
 *   • computer: `~/.dreamcontext/mcp.json`                                — every project
 *   • project:  `~/.dreamcontext/mcp/projects/<sha256(realpath)[:16]>.json` — one project
 *
 * The project file is HOME-side on purpose (security review r1 #3): a repo can never ship a
 * file the app would load unapproved, and Docker contexts, `npm pack` and folder sync never
 * see a project's secrets. The team's `.mcp.json` stays where it is, under Claude Code's own
 * approval gate (`mcp-project.ts`).
 *
 * ── Copy, never move ─────────────────────────────────────────────────────────────────────
 * Existing servers are COPIED in from `~/.claude.json`, every sandbox's `.claude.json` and
 * their `projects[<root>]` maps, and those files are never written (byte-identical, tested).
 * A ledger remembers where each copy came from: an unedited copy FOLLOWS its source (a key
 * rotated with `claude mcp add` reaches every account, as the old mirror did), an entry saved
 * from Settings is frozen and flagged when the source differs, a removed one is not re-imported.
 *
 * ── Trust ────────────────────────────────────────────────────────────────────────────────
 * A store file is only read or handed to a spawn when it is a regular file (not a symlink),
 * owned by this user, mode 0600. Anything else is reported to Settings and skipped: these
 * files name commands that run on every spawn.
 */

export type McpDefinition = Record<string, unknown>;

export interface McpLedgerEntry {
  /** `user` | `sandbox:<id>` | `local:<source id>` | `app` (created in Settings). */
  source: string;
  /** `defHash` of the definition as last copied; '' for an app-created entry. */
  importedHash: string;
  /** Saved from Settings: never overwritten by a sync again. */
  editedInApp: boolean;
  /** Removed from Settings: never re-imported. */
  removedInApp?: boolean;
  /** An edited copy whose source no longer has the name. */
  goneAtSource?: boolean;
}

export interface McpStoreBody {
  version: 1;
  mcpServers: Record<string, McpDefinition>;
  ledger: Record<string, McpLedgerEntry>;
  /** Project stores only: the root, for display. */
  projectRoot?: string;
}

export type McpScope = 'computer' | 'project';

export interface StoreProblem { scope: McpScope; reason: string }

/** A name a server may be imported under. Anything else is listed as "rename to import". */
export const IMPORT_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

// ─── Paths ────────────────────────────────────────────────────────────────────

export function computerStorePath(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'mcp.json');
}

export function projectStoresDir(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'mcp', 'projects');
}

/** The real path of a project root, falling back to its resolved form when it does not exist. */
export function realProjectRoot(projectRoot: string): string {
  try { return realpathSync(projectRoot); } catch { return resolve(projectRoot); }
}

export function projectStorePath(projectRoot: string, home: string = homedir()): string {
  const id = createHash('sha256').update(realProjectRoot(projectRoot)).digest('hex').slice(0, 16);
  return join(projectStoresDir(home), `${id}.json`);
}

/** The retired sandbox mirror: a stale copy of every top-level secret. Deleted on first sync. */
export function legacyMirrorPath(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'claude-accounts', 'mcp-config.json');
}

// ─── Small helpers ────────────────────────────────────────────────────────────

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const nullMap = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

export function isForbiddenName(name: string): boolean {
  return FORBIDDEN_KEYS.has(name);
}

export function isImportableName(name: string): boolean {
  return IMPORT_NAME_RE.test(name) && !isForbiddenName(name);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  const rec = asRecord(value);
  if (!rec) return value;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(rec).sort()) out[k] = canonical(rec[k]);
  return out;
}

/** A definition's identity: sha256 of its canonical JSON (key order does not matter), 16 hex. */
export function defHash(def: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(def) ?? null)).digest('hex').slice(0, 16);
}

/** Own, non-forbidden keys of a server map, each value an object. */
function serverMap(raw: unknown): Record<string, McpDefinition> {
  const out = nullMap<McpDefinition>();
  const m = asRecord(raw);
  if (!m) return out;
  for (const name of Object.keys(m)) {
    if (!Object.hasOwn(m, name) || isForbiddenName(name)) continue;
    const def = asRecord(m[name]);
    if (def) out[name] = def;
  }
  return out;
}

// ─── Trust + read + write ─────────────────────────────────────────────────────

/**
 * Why a store file must not be used, or null when it is fine (or absent). Regular file, not a
 * symlink, owned by this user, mode 0600.
 */
export function storeFileProblem(path: string): string | null {
  let st: ReturnType<typeof lstatSync>;
  try { st = lstatSync(path); } catch { return null; }
  if (st.isSymbolicLink()) return 'it is a symlink';
  if (!st.isFile()) return 'it is not a regular file';
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid !== null && st.uid !== uid) return 'it is owned by another user';
  if ((st.mode & 0o777) !== 0o600) return 'its permissions are not 0600';
  return null;
}

function exists(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

/** The store at `path`: an empty body when absent, null when it is unreadable. */
export function readStore(path: string): McpStoreBody | null {
  let text: string;
  try { text = readFileSync(path, 'utf-8'); } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? emptyStore() : null;
  }
  return parseStore(text);
}

function emptyStore(): McpStoreBody {
  return { version: 1, mcpServers: nullMap(), ledger: nullMap() };
}

function parseStore(text: string): McpStoreBody | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  const rec = asRecord(parsed);
  if (!rec) return null;
  const body = emptyStore();
  body.mcpServers = serverMap(rec.mcpServers);
  const ledger = asRecord(rec.ledger);
  if (ledger) {
    for (const name of Object.keys(ledger)) {
      if (!Object.hasOwn(ledger, name) || isForbiddenName(name)) continue;
      const e = asRecord(ledger[name]);
      if (!e || typeof e.source !== 'string') continue;
      body.ledger[name] = {
        source: e.source,
        importedHash: typeof e.importedHash === 'string' ? e.importedHash : '',
        editedInApp: e.editedInApp === true,
        ...(e.removedInApp === true ? { removedInApp: true } : {}),
        ...(e.goneAtSource === true ? { goneAtSource: true } : {}),
      };
    }
  }
  if (typeof rec.projectRoot === 'string') body.projectRoot = rec.projectRoot;
  return body;
}

function serialize(body: McpStoreBody): string {
  const sorted = (m: Record<string, unknown>) => Object.fromEntries(Object.keys(m).sort().map((k) => [k, m[k]]));
  return `${JSON.stringify({
    version: 1,
    ...(body.projectRoot ? { projectRoot: body.projectRoot } : {}),
    mcpServers: sorted(body.mcpServers),
    ledger: sorted(body.ledger),
  }, null, 2)}\n`;
}

function ensureDir(dir: string, mode: number | null): void {
  mkdirSync(dir, { recursive: true, ...(mode ? { mode } : {}) });
  if (mode) {
    try { if ((statSync(dir).mode & 0o777) !== mode) chmodSync(dir, mode); } catch { /* best effort */ }
  }
}

/**
 * Atomic 0600 write: a random temp name opened `O_EXCL` with mode 0600 at creation, then a
 * rename. A reader never sees a half file; a planted temp name is never followed.
 */
export function writeStoreFile(path: string, body: McpStoreBody, scope: McpScope, home: string): void {
  if (scope === 'project') {
    ensureDir(join(home, '.dreamcontext', 'mcp'), 0o700);
    ensureDir(projectStoresDir(home), 0o700);
  } else {
    ensureDir(join(home, '.dreamcontext'), null);
  }
  const tmp = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try { writeSync(fd, serialize(body)); } finally { closeSync(fd); }
  try { renameSync(tmp, path); } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* gone */ }
    throw err;
  }
}

// ─── Sources: Claude Code's own config files (read only, never written) ───────

interface ClaudeSource {
  /** `user` or `sandbox:<account id>`. */
  id: string;
  path: string;
}

function claudeSources(home: string): ClaudeSource[] {
  const out: ClaudeSource[] = [{ id: 'user', path: join(home, '.claude.json') }];
  for (const acc of listClaudeAccounts(home)) {
    if (acc.configDir) out.push({ id: `sandbox:${acc.id}`, path: join(acc.configDir, '.claude.json') });
  }
  return out;
}

interface SourceServers {
  /** Source id as recorded in the ledger. */
  id: string;
  /** False when the file could not be parsed (mid-write, missing): nothing it lacks is "removed". */
  readable: boolean;
  servers: Record<string, McpDefinition>;
}

function readSources(home: string, projectRoot: string | null): { top: SourceServers[]; local: SourceServers[] } {
  const top: SourceServers[] = [];
  const local: SourceServers[] = [];
  const keys = projectRoot ? [...new Set([resolve(projectRoot), realProjectRoot(projectRoot)])] : [];
  for (const src of claudeSources(home)) {
    let blob: Record<string, unknown> | null = null;
    try { blob = asRecord(JSON.parse(readFileSync(src.path, 'utf-8'))); } catch { blob = null; }
    top.push({ id: src.id, readable: !!blob, servers: serverMap(blob?.mcpServers) });
    if (projectRoot) {
      const projects = asRecord(blob?.projects);
      const merged = nullMap<McpDefinition>();
      for (const key of keys) {
        if (projects && Object.hasOwn(projects, key)) {
          const m = serverMap(asRecord(projects[key])?.mcpServers);
          for (const n of Object.keys(m)) if (!(n in merged)) merged[n] = m[n];
        }
      }
      local.push({ id: `local:${src.id}`, readable: !!blob, servers: merged });
    }
  }
  return { top, local };
}

// ─── Sync ─────────────────────────────────────────────────────────────────────

export interface SyncResult {
  outside: McpOutsideServer[];
  problems: StoreProblem[];
}

/**
 * Bring one store up to date with its sources. Pure over the body: returns the new body and
 * what the owner should see as "found outside". The rules are the plan's, in order.
 */
export function reconcileStore(
  body: McpStoreBody,
  sources: SourceServers[],
): { body: McpStoreBody; outside: McpOutsideServer[] } {
  const next: McpStoreBody = {
    version: 1,
    mcpServers: Object.assign(nullMap<McpDefinition>(), body.mcpServers),
    ledger: Object.assign(nullMap<McpLedgerEntry>(), body.ledger),
    ...(body.projectRoot ? { projectRoot: body.projectRoot } : {}),
  };
  const outside: McpOutsideServer[] = [];
  const names = new Set<string>();
  for (const s of sources) for (const n of Object.keys(s.servers)) names.add(n);

  for (const name of [...names].sort()) {
    const having = sources.filter((s) => name in s.servers);
    if (!isImportableName(name)) {
      for (const s of having) outside.push({ name, source: s.id, reason: 'bad-name' });
      continue;
    }
    const led = next.ledger[name];
    // The governing source: the one the ledger names when it still has the name, else the first.
    const gov = (led && having.find((s) => s.id === led.source)) || having[0];
    const def = gov.servers[name];
    const hash = defHash(def);
    for (const s of having) {
      if (s !== gov && defHash(s.servers[name]) !== hash) outside.push({ name, source: s.id, reason: 'conflict' });
    }
    if (!led) {
      if (name in next.mcpServers) {
        if (defHash(next.mcpServers[name]) !== hash) outside.push({ name, source: gov.id, reason: 'differs' });
        continue;
      }
      next.mcpServers[name] = def;
      next.ledger[name] = { source: gov.id, importedHash: hash, editedInApp: false };
      continue;
    }
    if (led.removedInApp) {
      outside.push({ name, source: gov.id, reason: 'removed-in-app' });
      continue;
    }
    if (led.editedInApp) {
      const flagged: McpLedgerEntry = { ...led };
      delete flagged.goneAtSource;
      next.ledger[name] = flagged;
      if (!(name in next.mcpServers) || defHash(next.mcpServers[name]) !== hash) {
        outside.push({ name, source: gov.id, reason: 'differs' });
      }
      continue;
    }
    if (!(name in next.mcpServers) || led.importedHash !== hash || led.source !== gov.id) {
      next.mcpServers[name] = def;
      next.ledger[name] = { source: gov.id, importedHash: hash, editedInApp: false };
    }
  }

  // Names the ledger copied from a source that, read cleanly, no longer has them.
  for (const name of Object.keys(next.ledger)) {
    if (names.has(name)) continue;
    const led = next.ledger[name];
    if (led.source === 'app' || led.removedInApp) continue;
    const src = sources.find((s) => s.id === led.source);
    if (!src || !src.readable) continue;
    if (led.editedInApp) {
      if (!led.goneAtSource) next.ledger[name] = { ...led, goneAtSource: true };
      continue;
    }
    delete next.mcpServers[name];
    delete next.ledger[name];
  }
  return { body: next, outside };
}

/**
 * Copy what Claude Code's configs have into the stores, following unedited copies. Reads every
 * source, compares, writes a store only when it changed and only when nobody else rewrote it
 * in between (optimistic: the next sync catches up). Never writes a Claude config file. Deletes
 * the retired sandbox mirror.
 */
export function syncImports(home: string = homedir(), projectRoot: string | null = null): SyncResult {
  try { rmSync(legacyMirrorPath(home), { force: true }); } catch { /* next time */ }
  const { top, local } = readSources(home, projectRoot);
  const outside: McpOutsideServer[] = [];
  const problems: StoreProblem[] = [];
  const targets: Array<{ scope: McpScope; path: string; sources: SourceServers[] }> = [
    { scope: 'computer', path: computerStorePath(home), sources: top },
  ];
  if (projectRoot) targets.push({ scope: 'project', path: projectStorePath(projectRoot, home), sources: local });

  for (const t of targets) {
    const problem = storeFileProblem(t.path);
    if (problem) { problems.push({ scope: t.scope, reason: problem }); continue; }
    let before = '';
    try { before = readFileSync(t.path, 'utf-8'); } catch { before = ''; }
    const body = before ? parseStore(before) : emptyStore();
    if (!body) { problems.push({ scope: t.scope, reason: 'it is not valid JSON' }); continue; }
    if (t.scope === 'project' && projectRoot) body.projectRoot = realProjectRoot(projectRoot);
    const result = reconcileStore(body, t.sources);
    outside.push(...result.outside);
    const text = serialize(result.body);
    const hasAnything = Object.keys(result.body.mcpServers).length > 0 || Object.keys(result.body.ledger).length > 0;
    if ((before && text === before) || (!before && !hasAnything)) continue;
    let now = '';
    try { now = readFileSync(t.path, 'utf-8'); } catch { now = ''; }
    if (now !== before) continue;
    try { writeStoreFile(t.path, result.body, t.scope, home); } catch { problems.push({ scope: t.scope, reason: 'it could not be written' }); }
  }
  return { outside, problems };
}

// ─── What a spawn carries ─────────────────────────────────────────────────────

export interface StoreFiles {
  /** The store files to hand a spawn, computer first, project second (the later one wins). */
  files: string[];
  problems: StoreProblem[];
}

/**
 * The store files a spawn passes with `--mcp-config`, after a sync. Only regular, non-symlink
 * files owned by this user with mode 0600; anything else is skipped and reported.
 */
export function mcpStoreFiles(o: { home?: string; projectRoot?: string | null; sync?: boolean } = {}): StoreFiles {
  const home = o.home ?? homedir();
  const projectRoot = o.projectRoot ?? null;
  const problems: StoreProblem[] = [];
  if (o.sync !== false) {
    try { problems.push(...syncImports(home, projectRoot).problems); } catch { /* the stores as they are */ }
  }
  const files: string[] = [];
  const candidates: Array<{ scope: McpScope; path: string }> = [{ scope: 'computer', path: computerStorePath(home) }];
  if (projectRoot) candidates.push({ scope: 'project', path: projectStorePath(projectRoot, home) });
  for (const c of candidates) {
    if (!exists(c.path)) continue;
    const problem = storeFileProblem(c.path);
    if (problem) {
      if (!problems.some((p) => p.scope === c.scope)) problems.push({ scope: c.scope, reason: problem });
      continue;
    }
    files.push(c.path);
  }
  return { files, problems };
}

/**
 * Every server the stores give this project, by name: the computer store, then the project
 * store winning a clash (it is the later `--mcp-config` file). Trusted files only.
 */
export function storeServers(projectRoot: string | null, home: string = homedir()): Map<string, McpDefinition> {
  const out = new Map<string, McpDefinition>();
  const paths = [computerStorePath(home), ...(projectRoot ? [projectStorePath(projectRoot, home)] : [])];
  for (const p of paths) {
    if (!exists(p) || storeFileProblem(p)) continue;
    const body = readStore(p);
    if (!body) continue;
    for (const n of Object.keys(body.mcpServers)) out.set(n, body.mcpServers[n]);
  }
  return out;
}

/** One scope's store, read for Settings. Null when it is untrusted or unreadable. */
export function readScope(scope: McpScope, projectRoot: string | null, home: string = homedir()): McpStoreBody | null {
  if (scope === 'project' && !projectRoot) return null;
  const path = scope === 'computer' ? computerStorePath(home) : projectStorePath(projectRoot as string, home);
  if (storeFileProblem(path)) return null;
  return readStore(path);
}

// ─── Settings edits ───────────────────────────────────────────────────────────

export class McpStoreError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'McpStoreError';
  }
}

function editScope(
  scope: McpScope, projectRoot: string | null, home: string,
  edit: (body: McpStoreBody) => void,
): void {
  if (scope === 'project' && !projectRoot) throw new McpStoreError('no_project', 'This needs a project.');
  const path = scope === 'computer' ? computerStorePath(home) : projectStorePath(projectRoot as string, home);
  const problem = storeFileProblem(path);
  if (problem) throw new McpStoreError('store_untrusted', `The ${scope} MCP file cannot be used: ${problem}.`);
  const body = readStore(path);
  if (!body) throw new McpStoreError('store_unreadable', `The ${scope} MCP file is not valid JSON.`);
  if (scope === 'project' && projectRoot) body.projectRoot = realProjectRoot(projectRoot);
  edit(body);
  writeStoreFile(path, body, scope, home);
}

/**
 * Save one server from Settings. The entry is frozen against its source from now on
 * (`editedInApp`). `keep` names `headers`/`env` keys whose stored value stays as it is (the form
 * never receives values, so a blank field means "unchanged").
 */
export function saveStoreServer(
  scope: McpScope, name: string, def: McpDefinition, o: { projectRoot?: string | null; home?: string; keep?: string[] } = {},
): void {
  if (isForbiddenName(name)) throw new McpStoreError('bad_name', 'That name is not allowed.');
  const home = o.home ?? homedir();
  editScope(scope, o.projectRoot ?? null, home, (body) => {
    const prev = body.mcpServers[name];
    const next: McpDefinition = { ...def };
    for (const field of ['headers', 'env'] as const) {
      const wanted = asRecord(next[field]);
      const old = asRecord(prev?.[field]);
      if (!wanted && !old) continue;
      const merged: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(wanted ?? {})) {
        if (isForbiddenName(k)) continue;
        merged[k] = (o.keep ?? []).includes(`${field}.${k}`) && old && Object.hasOwn(old, k) ? old[k] : v;
      }
      if (Object.keys(merged).length) next[field] = merged;
      else delete next[field];
    }
    body.mcpServers[name] = next;
    const led = body.ledger[name];
    body.ledger[name] = led && !led.removedInApp
      ? { source: led.source, importedHash: led.importedHash, editedInApp: true }
      : { source: 'app', importedHash: '', editedInApp: true };
  });
}

/** Remove one server from a store. An imported one is remembered so a sync never brings it back. */
export function removeStoreServer(scope: McpScope, name: string, o: { projectRoot?: string | null; home?: string } = {}): boolean {
  const home = o.home ?? homedir();
  let removed = false;
  editScope(scope, o.projectRoot ?? null, home, (body) => {
    removed = name in body.mcpServers;
    delete body.mcpServers[name];
    const led = body.ledger[name];
    if (!led || led.source === 'app') delete body.ledger[name];
    else body.ledger[name] = { source: led.source, importedHash: led.importedHash, editedInApp: false, removedInApp: true };
  });
  return removed;
}

/** The raw definition of one stored server (server-side only: it carries secrets). */
export function storedDefinition(scope: McpScope, name: string, o: { projectRoot?: string | null; home?: string } = {}): McpDefinition | null {
  const body = readScope(scope, o.projectRoot ?? null, o.home ?? homedir());
  return body && Object.hasOwn(body.mcpServers, name) ? body.mcpServers[name] : null;
}

/** Bring back an import the owner removed, or import a renamed/conflicting one as-is. */
export function restoreImport(scope: McpScope, name: string, o: { projectRoot?: string | null; home?: string } = {}): void {
  const home = o.home ?? homedir();
  editScope(scope, o.projectRoot ?? null, home, (body) => {
    const led = body.ledger[name];
    if (led?.removedInApp) delete body.ledger[name];
  });
  syncImports(home, o.projectRoot ?? null);
}

// ─── Store paths inside a shell string ────────────────────────────────────────

/** The env vars a login-shell spawn carries the store paths in, computer then project. */
export const MCP_CFG_ENV = ['DREAMCONTEXT_MCP_CFG_0', 'DREAMCONTEXT_MCP_CFG_1'] as const;

/**
 * Store paths never enter a shell string (a HOME with a space or `$(` would be re-parsed):
 * they ride in env vars and the string names the variable, double-quoted by the caller
 * (`"$DREAMCONTEXT_MCP_CFG_0"`, the same in fish). Only the files that exist.
 */
export function storeFileRefs(files: readonly string[]): { refs: string[]; env: Record<string, string> } {
  const refs: string[] = [];
  const env: Record<string, string> = {};
  files.slice(0, MCP_CFG_ENV.length).forEach((file, i) => {
    refs.push(`$${MCP_CFG_ENV[i]}`);
    env[MCP_CFG_ENV[i]] = file;
  });
  return { refs, env };
}
