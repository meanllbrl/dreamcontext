/**
 * `~/.dreamcontext/apps/registry.json`: which apps exist, whose project they belong to and
 * where their code lives (dreamcontext-apps plan r19, "Dosya yerleşimi"). Holds no secret.
 * 0600, temp+rename, a symlinked file refused, writes serialized with a PID lock, home
 * injectable for tests.
 *
 * An app's code lives NEXT to its project, never in the brain:
 *   <dirname(projectRoot)>/<basename(projectRoot)>-apps/<slug>/   (its own git)
 * Its data lives in `~/.dreamcontext/apps/data/<hash>/` (DC_DATA_DIR).
 */

import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { acquireFileLock, releaseFileLock } from '../file-lock.js';
import { APP_SLUG_RE, appHash } from './bundle.js';

export interface AppRecord {
  slug: string;
  /** The registered vault name of the owning project. */
  vault: string;
  /** The owning project's root (realpath). */
  projectRoot: string;
  /** The app's code folder (realpath when it exists). */
  root: string;
  hash: string;
  name: string;
  createdAt: string;
  /** The gateway port, kept so the app's origin (and its localStorage) survives restarts. */
  gwPort?: number;
  /** The owner pressed Stop: nothing but the owner's Launch/Start brings the backend back. */
  stoppedByOwner?: boolean;
}

interface RegistryFile {
  schema: 1;
  apps: AppRecord[];
}

const LOCK_STALE_MS = 15_000;
const LOCK_WAIT_MS = 3_000;

export function appsHome(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'apps');
}
export function registryPath(home: string = homedir()): string {
  return join(appsHome(home), 'registry.json');
}
/** `~/.dreamcontext/apps/chats/`: one record per app conversation (chat-store.ts). */
export function appChatsDir(home: string = homedir()): string {
  return join(appsHome(home), 'chats');
}
export function appDataDir(home: string, hash: string): string {
  return join(appsHome(home), 'data', hash);
}

/** Where an app's code goes: beside the project, in `<project>-apps/<slug>/`. */
export function appRootFor(projectRoot: string, slug: string): string {
  if (!APP_SLUG_RE.test(slug)) throw new Error(`bad app slug: ${slug}`);
  return join(dirname(projectRoot), `${basename(projectRoot)}-apps`, slug);
}

/** realpath, resolving the nearest existing ancestor for a path that does not exist yet. */
export function real(p: string): string {
  try { return realpathSync(p); } catch { /* not there yet */ }
  const parent = dirname(p);
  return parent === p ? p : join(real(parent), basename(p));
}

function sanitize(raw: unknown): AppRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.slug !== 'string' || !APP_SLUG_RE.test(r.slug)) return null;
  for (const k of ['vault', 'projectRoot', 'root', 'hash', 'name', 'createdAt']) if (typeof r[k] !== 'string') return null;
  return {
    slug: r.slug,
    vault: r.vault as string,
    projectRoot: r.projectRoot as string,
    root: r.root as string,
    hash: r.hash as string,
    name: r.name as string,
    createdAt: r.createdAt as string,
    ...(typeof r.gwPort === 'number' && Number.isInteger(r.gwPort) && r.gwPort > 1023 && r.gwPort < 65536 ? { gwPort: r.gwPort } : {}),
    ...(r.stoppedByOwner === true ? { stoppedByOwner: true } : {}),
  };
}

export function readRegistry(home: string = homedir()): AppRecord[] {
  try {
    return readRegistryStrict(home);
  } catch {
    return [];
  }
}

/**
 * The registry for a WRITE: only a missing file is empty. An unreadable one (bad JSON, EACCES,
 * EMFILE, a symlink) throws, so a read-modify-write never replaces every app, gwPort and
 * stoppedByOwner with an empty list.
 */
function readRegistryStrict(home: string): AppRecord[] {
  const p = registryPath(home);
  let text: string;
  try {
    if (lstatSync(p).isSymbolicLink()) throw new Error('apps/registry.json is a symlink; refusing it');
    text = readFileSync(p, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const parsed = JSON.parse(text) as Partial<RegistryFile>;
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.apps)) throw new Error('apps/registry.json is not a registry; refusing to overwrite it');
  return parsed.apps.map(sanitize).filter((a): a is AppRecord => !!a);
}

function writeRegistry(home: string, apps: AppRecord[]): void {
  const dir = appsHome(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = registryPath(home);
  try {
    if (lstatSync(p).isSymbolicLink()) throw new Error('apps/registry.json is a symlink; refusing it');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const tmp = `${p}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ schema: 1, apps } satisfies RegistryFile, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(tmp, p);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* never written */ }
    throw err;
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Read-modify-write under the registry's PID lock. */
export function mutateRegistry<T>(home: string, fn: (apps: AppRecord[]) => { apps: AppRecord[]; result: T }): T {
  mkdirSync(appsHome(home), { recursive: true, mode: 0o700 });
  const lock = join(appsHome(home), '.registry.lock');
  const deadline = Date.now() + LOCK_WAIT_MS;
  let held = acquireFileLock(lock, Date.now(), LOCK_STALE_MS, { verifyPidLiveness: true });
  while (!held && Date.now() < deadline) {
    sleepSync(25);
    held = acquireFileLock(lock, Date.now(), LOCK_STALE_MS, { verifyPidLiveness: true });
  }
  if (!held) throw new Error('apps registry busy (another dreamcontext process is writing it); retry');
  try {
    const { apps, result } = fn(readRegistryStrict(home));
    writeRegistry(home, apps);
    return result;
  } finally {
    releaseFileLock(lock);
  }
}

const same = (a: AppRecord, projectRoot: string, slug: string) => a.slug === slug && a.projectRoot === real(projectRoot);

export function listApps(home: string = homedir(), projectRoot?: string): AppRecord[] {
  const all = readRegistry(home);
  if (!projectRoot) return all;
  const r = real(projectRoot);
  return all.filter((a) => a.projectRoot === r);
}

export function getApp(home: string, projectRoot: string, slug: string): AppRecord | null {
  return readRegistry(home).find((a) => same(a, projectRoot, slug)) ?? null;
}

/** Register a new app (or refresh the name/root of an existing one). */
export function registerApp(home: string, input: { projectRoot: string; vault: string; slug: string; name: string; root: string }): AppRecord {
  if (!APP_SLUG_RE.test(input.slug)) throw new Error(`bad app slug: ${input.slug}`);
  const projectRoot = real(input.projectRoot);
  return mutateRegistry(home, (apps) => {
    const existing = apps.find((a) => same(a, projectRoot, input.slug));
    const rec: AppRecord = existing
      ? { ...existing, name: input.name, root: real(input.root), vault: input.vault }
      : { slug: input.slug, vault: input.vault, projectRoot, root: real(input.root), hash: appHash(projectRoot, input.slug), name: input.name, createdAt: new Date().toISOString() };
    return { apps: [...apps.filter((a) => a !== existing), rec], result: rec };
  });
}

export function updateApp(home: string, projectRoot: string, slug: string, patch: Partial<Pick<AppRecord, 'gwPort' | 'stoppedByOwner' | 'name'>>): AppRecord | null {
  return mutateRegistry(home, (apps) => {
    const i = apps.findIndex((a) => same(a, projectRoot, slug));
    if (i < 0) return { apps, result: null };
    const next: AppRecord = { ...apps[i], ...patch };
    if (patch.stoppedByOwner === false) delete next.stoppedByOwner;
    const out = apps.slice();
    out[i] = next;
    return { apps: out, result: next };
  });
}

export function unregisterApp(home: string, projectRoot: string, slug: string): AppRecord | null {
  return mutateRegistry(home, (apps) => {
    const hit = apps.find((a) => same(a, projectRoot, slug)) ?? null;
    return { apps: apps.filter((a) => a !== hit), result: hit };
  });
}

/**
 * The registered app whose root contains `cwd` (both realpath'd, on a path-segment boundary:
 * `/x-apps/a` never matches `/x-apps/ab`). An agent working on an app has the app as its cwd.
 */
export function appContaining(home: string, cwd: string): AppRecord | null {
  const c = real(cwd);
  for (const a of readRegistry(home)) {
    const root = real(a.root);
    if (c === root || c.startsWith(root + sep)) return a;
  }
  return null;
}

export function appExistsOnDisk(a: AppRecord): boolean {
  return existsSync(join(a.root, 'dreamcontext-app.json'));
}
