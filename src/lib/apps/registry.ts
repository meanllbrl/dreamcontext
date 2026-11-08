/**
 * `~/.dreamcontext/apps/registry.json`: which apps exist, whose project they belong to and
 * where their code lives (dreamcontext-apps plan r19, "Dosya yerleşimi"). Holds no secret.
 * 0600, temp+rename, a symlinked file refused, writes serialized with a PID lock, home
 * injectable for tests.
 *
 * An app's code lives NEXT to its project, never in the brain:
 *   <dirname(projectRoot)>/<basename(projectRoot)>-apps/<slug>/   (its own git)
 * Its data lives in the brain, `<project>/_dream_context/apps/<slug>/` (DC_DATA_DIR, data-dir.ts),
 * ignored by git: it never leaves this Mac.
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
  /**
   * Shared apps (paylasilan-app-ler plan r3). `installed`: someone else's app, installed from a
   * host. Sticky: no path turns an installed app into `own`, its own copy included. Absent = own.
   */
  origin?: 'own' | 'installed';
  /** 16 random bytes, hex: an installed app's hash, source repo and trash entry hang off it. */
  installId?: string;
  /** The app's settings file `~/.dreamcontext/apps/config/<configId>.json` (not path-bound). */
  configId?: string;
  /** sha256 of the manifest text the owner approved at install or at the last update. */
  approvedManifestSha?: string;
  source?: AppSource;
  /** Where a detached copy came from: read only by the re-share licence rule. */
  provenance?: { fullName: string; license: string };
  /** The owner's own publish of this app. */
  publish?: AppPublish;
}

export interface AppSource {
  host: 'github' | 'local';
  fullName: string;
  repoId: string;
  ownerId: string;
  owner: string;
  public: boolean;
  mode: 'following' | 'own';
  autoUpdate: boolean;
  /** The upstream commit the copy was installed or last updated from. */
  upstreamSha: string;
  lastCheck?: string;
  /** An update seen by the last check, waiting for the owner. */
  available?: { sha: string; at: string };
  /** The last check could not reach the source (gone, no access, moved to another owner). */
  problem?: 'no_access' | 'moved' | 'not_forward';
  /** The last update applied (by the owner or automatically): Undo on the card goes back from it. */
  lastUpdate?: { from: string; to: string; at: string; auto: boolean; depsFailed?: string };
}

export interface AppPublish {
  host: 'github' | 'local';
  fullName: string;
  repoId: string;
  public: boolean;
  /** Empty while a first publish is under way (the repo exists, nothing pushed yet). */
  lastSha: string;
  at: string;
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

const HEX40 = /^[0-9a-f]{40}$/;
const HEX = /^[0-9a-f]{16,64}$/;
const FULL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9._-]{1,100}$/;
const str = (v: unknown, max = 200): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

function sanitizeSource(v: unknown): AppSource | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const s = v as Record<string, unknown>;
  if ((s.host !== 'github' && s.host !== 'local') || !str(s.fullName) || !FULL_NAME_RE.test(s.fullName) || !str(s.repoId) || !str(s.ownerId) || !str(s.owner) || !str(s.upstreamSha) || !HEX40.test(s.upstreamSha)) return undefined;
  const av = s.available as Record<string, unknown> | undefined;
  const lu = s.lastUpdate as Record<string, unknown> | undefined;
  return {
    host: s.host, fullName: s.fullName, repoId: s.repoId, ownerId: s.ownerId, owner: s.owner,
    public: s.public === true,
    mode: s.mode === 'own' ? 'own' : 'following',
    autoUpdate: s.autoUpdate === true && s.public !== true,
    upstreamSha: s.upstreamSha,
    ...(str(s.lastCheck, 40) ? { lastCheck: s.lastCheck } : {}),
    ...(av && typeof av === 'object' && str(av.sha) && HEX40.test(av.sha) && str(av.at, 40) ? { available: { sha: av.sha, at: av.at } } : {}),
    ...(s.problem === 'no_access' || s.problem === 'moved' || s.problem === 'not_forward' ? { problem: s.problem } : {}),
    ...(lu && typeof lu === 'object' && str(lu.from) && HEX40.test(lu.from) && str(lu.to) && HEX40.test(lu.to) && str(lu.at, 40) ? { lastUpdate: { from: lu.from, to: lu.to, at: lu.at, auto: lu.auto === true, ...(typeof lu.depsFailed === 'string' ? { depsFailed: lu.depsFailed.slice(0, 300) } : {}) } } : {}),
  };
}

function sanitizePublish(v: unknown): AppPublish | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const p = v as Record<string, unknown>;
  if ((p.host !== 'github' && p.host !== 'local') || !str(p.fullName) || !FULL_NAME_RE.test(p.fullName) || !str(p.repoId) || typeof p.lastSha !== 'string' || (p.lastSha !== '' && !HEX40.test(p.lastSha)) || !str(p.at, 40)) return undefined;
  return { host: p.host, fullName: p.fullName, repoId: p.repoId, public: p.public === true, lastSha: p.lastSha, at: p.at };
}

/** The installed-apps folder of a project: no `own` app is ever registered under it. */
export function installedAppsDir(projectRoot: string): string {
  return join(dirname(projectRoot), `${basename(projectRoot)}-apps`, 'installed');
}

/** Is `root` inside `<project>-apps/installed/` (realpath, segment boundary)? */
export function isUnderInstalledDir(projectRoot: string, root: string): boolean {
  const dir = real(installedAppsDir(projectRoot));
  const r = real(root);
  return r === dir || r.startsWith(dir + sep);
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
    ...shareFields(r),
  };
}

/**
 * The shared-app fields. `origin` fails CLOSED: a record whose code sits under `installed/` or
 * that carries an installId is installed, whatever its `origin` says (plan r2 K5.1).
 */
function shareFields(r: Record<string, unknown>): Partial<AppRecord> {
  const installId = typeof r.installId === 'string' && HEX.test(r.installId) ? r.installId : undefined;
  const underInstalled = typeof r.root === 'string' && /[\\/]installed[\\/][^\\/]+[\\/]?$/.test(r.root) && typeof r.projectRoot === 'string' && isUnderInstalledDir(r.projectRoot, r.root);
  const installed = r.origin === 'installed' || !!installId || underInstalled;
  const source = sanitizeSource(r.source);
  const publish = sanitizePublish(r.publish);
  const prov = r.provenance as Record<string, unknown> | undefined;
  return {
    ...(installed ? { origin: 'installed' as const } : {}),
    ...(installId ? { installId } : {}),
    ...(typeof r.configId === 'string' && HEX.test(r.configId) ? { configId: r.configId } : {}),
    ...(typeof r.approvedManifestSha === 'string' && /^[0-9a-f]{64}$/.test(r.approvedManifestSha) ? { approvedManifestSha: r.approvedManifestSha } : {}),
    ...(source ? { source } : {}),
    ...(publish ? { publish } : {}),
    ...(prov && typeof prov === 'object' && str(prov.fullName) && FULL_NAME_RE.test(prov.fullName) && str(prov.license, 40) ? { provenance: { fullName: prov.fullName, license: prov.license } } : {}),
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
  // An installed app's folder is never registered as the owner's own app (plan r2 K5.1).
  if (isUnderInstalledDir(input.projectRoot, input.root)) throw new Error('that folder holds an installed app; it cannot be registered as your own');
  const projectRoot = real(input.projectRoot);
  return mutateRegistry(home, (apps) => {
    const existing = apps.find((a) => same(a, projectRoot, input.slug));
    if (existing?.origin === 'installed') throw new Error(`"${input.slug}" is an installed app; it cannot become your own`);
    const rec: AppRecord = existing
      ? { ...existing, name: input.name, root: real(input.root), vault: input.vault }
      : { slug: input.slug, vault: input.vault, projectRoot, root: real(input.root), hash: appHash(projectRoot, input.slug), name: input.name, createdAt: new Date().toISOString() };
    return { apps: [...apps.filter((a) => a !== existing), rec], result: rec };
  });
}

/** Register an app installed from a host (share/install.ts): its own hash, never another app's. */
export function registerInstalledApp(home: string, input: Omit<AppRecord, 'hash' | 'createdAt' | 'origin'> & { installId: string }): AppRecord {
  if (!APP_SLUG_RE.test(input.slug)) throw new Error(`bad app slug: ${input.slug}`);
  if (!HEX.test(input.installId)) throw new Error('bad install id');
  const projectRoot = real(input.projectRoot);
  return mutateRegistry(home, (apps) => {
    if (apps.some((a) => same(a, projectRoot, input.slug))) throw new Error(`an app "${input.slug}" already exists in this project`);
    const rec: AppRecord = { ...input, projectRoot, root: real(input.root), origin: 'installed', hash: appHash(projectRoot, input.slug, input.installId), createdAt: new Date().toISOString() };
    return { apps: [...apps, rec], result: rec };
  });
}

type SharePatch = Partial<Pick<AppRecord, 'configId' | 'approvedManifestSha' | 'source' | 'provenance' | 'publish'>>;

/** Change an app's shared-app fields. `origin` and `installId` are never in the patch. */
export function updateAppShare(home: string, projectRoot: string, slug: string, patch: SharePatch | ((rec: AppRecord) => SharePatch)): AppRecord | null {
  return mutateRegistry(home, (apps) => {
    const i = apps.findIndex((a) => same(a, projectRoot, slug));
    if (i < 0) return { apps, result: null };
    const p = typeof patch === 'function' ? patch(apps[i]) : patch;
    const next: AppRecord = { ...apps[i] };
    for (const k of ['configId', 'approvedManifestSha', 'source', 'provenance', 'publish'] as const) {
      if (!(k in p)) continue;
      const v = p[k];
      if (v === undefined) delete next[k];
      else (next as unknown as Record<string, unknown>)[k] = v;
    }
    const out = apps.slice();
    out[i] = next;
    return { apps: out, result: next };
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
