/**
 * Installing someone else's app (paylasilan-app-ler plan r2 K3 + K6, r3).
 *
 * Preview (anyone, the agent included): the repo is fetched into a quarantine repo
 * (`~/.dreamcontext/apps/incoming/<previewId>.git`, bare, hooks and LFS off), its tree is read
 * BEFORE any checkout and checked by the gate in install mode (no link, submodule, dotfile,
 * instruction file, key or data; nothing but what a published app holds), and the mechanical
 * facts are listed: who wrote it, what it runs, which addresses its code names, what it asks for.
 *
 * Install (the owner's click, bound to the sha the preview showed): the repo moves to
 * `~/.dreamcontext/apps/sources/<installId>.git`, OUTSIDE the app folder; the copy is checked out
 * on a `local` branch at `<project>-apps/installed/<slug>/`. Per owner decision 1 the app then
 * runs like the owner's own apps; the install screen says so in plain words.
 *
 * Uninstall moves the code, its repo and its settings to `~/.dreamcontext/apps/trash/`; nothing
 * is deleted by inference (a-delete-is-never-inferred-from-absence). Restore brings it back.
 */

import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { devNull } from 'node:os';
import { extname, join } from 'node:path';
import { appsHome, appRootFor, getApp, installedAppsDir, listApps, registerInstalledApp, unregisterApp, type AppRecord } from '../registry.js';
import { APP_SLUG_RE } from '../bundle.js';
import { cleanText, parseManifest, type ConfigField } from '../manifest.js';
import { appConfigPath, newConfigId, setAppConfig } from '../app-config.js';
import { appLogoDir, appLogoPath } from '../app-logo.js';
import { appDataDir } from '../data-dir.js';
import { allowAppDir } from '../allow-dir.js';
import { HostError, parseAppRepoRef, resolveAppHost, type AppHost } from './host.js';
import { runGate, type GateFile, type GateReport } from './gate.js';
import { initHardRepo, installedGit, installedGitAsync, lsTree, readBlob, revParse } from './installed-git.js';
import { writeEnvSecrets } from '../../env-secrets.js';
import { licenseKind } from './publish.js';
import { ICON_MAX_BYTES, imageDataUrl, storePage, type StorePage } from '../store-facts.js';
import { isDefaultIconBytes } from '../icon.js';

export class InstallError extends Error {
  constructor(public code: string, message: string, public report?: GateReport) { super(message); }
}

const ID_RE = /^[0-9a-f]{32}$/;
const SHA_RE = /^[0-9a-f]{40}$/;

export const sourcesDir = (home: string) => join(appsHome(home), 'sources');
export const incomingDir = (home: string) => join(appsHome(home), 'incoming');
export const trashDir = (home: string) => join(appsHome(home), 'trash');
export const sourceRepo = (home: string, installId: string) => join(sourcesDir(home), `${installId}.git`);

export interface InstallFacts {
  backend: string | null;
  build: string | null;
  mcp: string[];
  agent: string | null;
  schedules: number;
  actions: number;
  dangerActions: number;
  dependencies: number;
  /** Hosts its code names (http/https), at most 30. */
  urls: string[];
  npmProblem: string | null;
}

export interface InstallPreview {
  previewId: string;
  host: 'github' | 'local';
  fullName: string;
  sha: string;
  publisher: string;
  publisherSince: string | null;
  repoCreated: string | null;
  repoUpdated: string | null;
  public: boolean;
  name: string;
  slug: string;
  license: string;
  /** The words above the Install button (owner decision 1). */
  warning: string;
  facts: InstallFacts;
  config: ConfigField[];
  readme: string;
  /** The icon as a data URL (PNG/JPEG), null = the page draws the monogram. */
  icon: string | null;
  /** The store page: README words, screenshots, what the manifest says it can do. */
  store: StorePage;
  gate: { ok: boolean; blocks: GateReport['blocks'] };
}

interface PreviewMeta {
  host: 'github' | 'local';
  fullName: string;
  sha: string;
  repoId: string;
  ownerId: string;
  owner: string;
  public: boolean;
  at: string;
}

export function installWarning(publisher: string): string {
  return `This app was written by ${publisher}. It runs on your Mac with your permissions.`;
}

/** The files of `ref`, big blobs left unread (the gate refuses them by size). */
function treeFiles(gitDir: string, ref: string): GateFile[] {
  return lsTree(gitDir, ref).map((e) => ({
    path: e.path,
    mode: e.mode,
    data: e.type === 'blob' && e.size <= 2 * 1024 * 1024 ? readBlob(gitDir, e.sha) : Buffer.alloc(e.size > 2 * 1024 * 1024 ? 2 * 1024 * 1024 + 1 : 0),
  }));
}

/** The install gate: the same allow-list the publisher had, its `share.include` included. */
export function installGate(files: GateFile[], icon: string | null, include: readonly string[] = []): GateReport {
  return runGate(files, { mode: 'install', icon, include });
}

export function factsOf(files: GateFile[], manifest: NonNullable<ReturnType<typeof parseManifest> & { ok: true }>['manifest']): InstallFacts {
  const urls = new Set<string>();
  for (const f of files) {
    if (!/\.(m?js|cjs|ts|tsx|html|json)$/.test(f.path) || f.path === 'package-lock.json') continue;
    for (const m of f.data.toString('utf-8').matchAll(/https?:\/\/([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)) {
      if (urls.size < 30 && !/^(?:www\.)?(?:w3\.org|github\.com|opensource\.org|example\.com)$/.test(m[1])) urls.add(m[1].toLowerCase());
    }
  }
  let dependencies = 0;
  let npmProblem: string | null = null;
  const pkg = files.find((f) => f.path === 'package.json');
  if (pkg) {
    try {
      const j = JSON.parse(pkg.data.toString('utf-8')) as { dependencies?: Record<string, string> };
      dependencies = Object.keys(j.dependencies ?? {}).length;
      for (const [n, spec] of Object.entries(j.dependencies ?? {})) if (/^(?:file:|git|http|link:|github:)/.test(spec) || spec.includes('/')) npmProblem = `${n} comes from "${cleanText(spec, 60)}", not the npm registry`;
    } catch { npmProblem = 'package.json is not valid JSON'; }
    if (dependencies && !npmProblem) {
      const lock = files.find((f) => f.path === 'package-lock.json');
      if (!lock) npmProblem = 'dependencies without a package-lock.json';
      else {
        const text = lock.data.toString('utf-8');
        for (const m of text.matchAll(/"resolved":\s*"([^"]+)"/g)) if (!m[1].startsWith('https://registry.npmjs.org/')) { npmProblem = 'a dependency resolves outside registry.npmjs.org'; break; }
      }
    }
  }
  return {
    backend: manifest.backend?.command ?? null,
    build: manifest.build,
    mcp: manifest.mcp,
    agent: manifest.agent?.member ? `AI Team member "${manifest.agent.member}"` : manifest.agent?.own ? 'its own assistant' : null,
    schedules: manifest.schedules.length,
    actions: manifest.actions.length,
    dangerActions: manifest.actions.filter((a) => a.danger).length,
    dependencies,
    urls: [...urls],
    npmProblem,
  };
}

async function fetchInto(host: AppHost, gitDir: string, fullName: string, ref: string): Promise<void> {
  const url = host.cloneUrl(fullName);
  await host.withGit((env) => installedGitAsync(gitDir, ['fetch', '-q', '--no-tags', url, `+refs/heads/main:${ref}`], { env, allowFile: host.allowFile, timeoutMs: 300_000 }));
}

/** The host to read a repo with: signed in when possible, anonymous for a public repo otherwise. */
async function readableRepo(home: string, fullName: string, host?: AppHost): Promise<{ host: AppHost; repo: NonNullable<Awaited<ReturnType<AppHost['getRepo']>>> }> {
  const tries: AppHost[] = host ? [host] : [resolveAppHost(home), resolveAppHost(home, { anonymous: true })];
  for (const h of tries) {
    try {
      const repo = await h.getRepo(fullName);
      if (repo) return { host: h, repo };
    } catch (e) { if (!(e instanceof HostError) || e.code === 'rate_limited') throw e; }
  }
  throw new InstallError('not_found', `${fullName} was not found, or you have no access to it. A private app needs its owner's invitation first.`);
}

export async function previewInstall(opts: { home: string; projectRoot: string; ref: string; host?: AppHost }): Promise<InstallPreview> {
  const fullName = parseAppRepoRef(opts.ref);
  if (!fullName) throw new InstallError('bad_ref', 'Paste the app\'s GitHub link (https://github.com/owner/repo) or owner/repo.');
  const { host, repo } = await readableRepo(opts.home, fullName, opts.host);
  const previewId = randomBytes(16).toString('hex');
  mkdirSync(incomingDir(opts.home), { recursive: true, mode: 0o700 });
  const gitDir = join(incomingDir(opts.home), `${previewId}.git`);
  initHardRepo(gitDir, true);
  try {
    await fetchInto(host, gitDir, repo.fullName, 'refs/heads/main');
  } catch (e) {
    rmSync(gitDir, { recursive: true, force: true });
    throw new InstallError('fetch_failed', `Could not download ${repo.fullName}: ${(e as Error).message}`);
  }
  const sha = revParse(gitDir, 'refs/heads/main');
  if (!sha) { rmSync(gitDir, { recursive: true, force: true }); throw new InstallError('empty_repo', `${repo.fullName} has nothing published yet.`); }
  const files = treeFiles(gitDir, sha);
  const manifestFile = files.find((f) => f.path === 'dreamcontext-app.json');
  const parsed = manifestFile ? parseManifest(manifestFile.data.toString('utf-8'), null) : null;
  if (!parsed || !parsed.ok) { rmSync(gitDir, { recursive: true, force: true }); throw new InstallError('not_an_app', `${repo.fullName} is not a dreamcontext app (no valid dreamcontext-app.json).`); }
  const m = parsed.manifest;
  const gate = installGate(files, m.icon, m.share.include);
  const facts = factsOf(files, m);
  if (facts.npmProblem) gate.blocks.push({ id: 'npm', rule: 'npm', file: 'package.json', label: facts.npmProblem });
  gate.ok = gate.blocks.length === 0;
  const publisherUser = await host.user(repo.owner).catch(() => null);
  const meta: PreviewMeta = { host: host.kind, fullName: repo.fullName, sha, repoId: repo.repoId, ownerId: repo.ownerId, owner: repo.owner, public: !repo.private, at: new Date().toISOString() };
  writeFileSync(join(incomingDir(opts.home), `${previewId}.json`), JSON.stringify(meta), { mode: 0o600 });
  pruneIncoming(opts.home, previewId);
  const readme = files.find((f) => f.path === 'README.md')?.data.toString('utf-8') ?? '';
  const blob = (path: string) => files.find((f) => f.path === path)?.data ?? null;
  const iconPath = m.icon ? m.icon.replace(/^\.\//, '') : null;
  const icon = iconPath && !isDefaultIconBytes(blob(iconPath), m.slug, m.name) ? imageDataUrl(iconPath, blob(iconPath), ICON_MAX_BYTES) : null;
  const store = storePage(readme, m, blob);
  return {
    previewId, host: host.kind, fullName: repo.fullName, sha, publisher: repo.owner, publisherSince: publisherUser?.createdAt ?? null,
    repoCreated: repo.createdAt, repoUpdated: repo.pushedAt, public: !repo.private, name: m.name, slug: m.slug,
    license: licenseKind(files.find((f) => f.path === 'LICENSE')?.data.toString('utf-8') ?? null),
    warning: installWarning(repo.owner), facts, config: m.config,
    // eslint-disable-next-line no-control-regex
    readme: readme.replace(/[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/g, '').slice(0, 2000),
    icon, store,
    gate: { ok: gate.ok, blocks: gate.blocks },
  };
}

/** Previews older than a day, and every other preview of this process's past, go. */
function pruneIncoming(home: string, keep: string): void {
  const dir = incomingDir(home);
  try {
    for (const f of readdirSync(dir)) {
      const id = f.replace(/\.(git|json)$/, '');
      if (id === keep || !ID_RE.test(id)) continue;
      try {
        const meta = JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf-8')) as PreviewMeta;
        if (Date.now() - Date.parse(meta.at) < 24 * 3600_000) continue;
      } catch { /* no meta: stale */ }
      rmSync(join(dir, f), { recursive: true, force: true });
    }
  } catch { /* no dir */ }
}

/** A local slug no app, app folder or data folder of this project uses. */
function freeSlug(home: string, projectRoot: string, base: string): string {
  const taken = (s: string) => !!getApp(home, projectRoot, s) || existsSync(join(installedAppsDir(projectRoot), s)) || existsSync(appRootFor(projectRoot, s)) || existsSync(appDataDir(projectRoot, s));
  if (!taken(base) && base !== 'installed') return base;
  for (let i = 2; i < 100; i++) {
    const s = `${base.slice(0, 60)}-${i}`;
    if (APP_SLUG_RE.test(s) && !taken(s)) return s;
  }
  throw new InstallError('slug_taken', 'No free name for this app in this project.');
}

// Never the installer's edits: keys, data, dependencies, logs and build output.
const EXCLUDE = '.env\n.env.*\ndata/\nnode_modules/\n*.log\ndist/\nbuild/\n.next/\ntmp/\n.cache/\n';

/** `npm ci` without scripts, without the user's npmrc; never blocks the server. */
export function runNpmCi(root: string): Promise<void> {
  const win = process.platform === 'win32';
  return new Promise((resolve, reject) => {
    execFile(win ? 'npm.cmd' : 'npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--userconfig', devNull], { cwd: root, timeout: 600_000, shell: win, maxBuffer: 16 * 1024 * 1024 }, (err, _out, stderr) => {
      if (err) reject(new InstallError('npm_failed', `npm ci failed: ${String(stderr).trim().split('\n').slice(-2).join(' ') || err.message}`));
      else resolve();
    });
  });
}

export function manifestSha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export interface InstallOptions {
  home: string;
  projectRoot: string;
  vault: string;
  previewId: string;
  sha: string;
  config?: Record<string, unknown>;
  /** Run `npm ci --ignore-scripts` for an app with dependencies (tests turn it off). */
  npm?: boolean;
  /** Keys the owner typed on the install screen: written into the copy's own `.env`. */
  secrets?: Record<string, unknown>;
}

export async function installApp(opts: InstallOptions): Promise<{ rec: AppRecord; renamed: boolean }> {
  if (!ID_RE.test(opts.previewId) || !SHA_RE.test(opts.sha)) throw new InstallError('bad_request', 'bad preview');
  const dir = incomingDir(opts.home);
  let meta: PreviewMeta;
  try { meta = JSON.parse(readFileSync(join(dir, `${opts.previewId}.json`), 'utf-8')) as PreviewMeta; } catch { throw new InstallError('preview_gone', 'This preview is gone; open the app again.'); }
  const incoming = join(dir, `${opts.previewId}.git`);
  // The click approves exactly what the screen showed.
  if (meta.sha !== opts.sha || revParse(incoming, 'refs/heads/main') !== opts.sha) throw new InstallError('stale_preview', 'The app changed since you looked at it; open it again.');
  const files = treeFiles(incoming, opts.sha);
  const manifestText = files.find((f) => f.path === 'dreamcontext-app.json')!.data.toString('utf-8');
  const parsed = parseManifest(manifestText, null);
  if (!parsed.ok) throw new InstallError('not_an_app', 'not a dreamcontext app');
  const m = parsed.manifest;
  const gate = installGate(files, m.icon, m.share.include);
  if (!gate.ok) throw new InstallError('gate_blocked', 'This app holds something an app may not.', gate);
  const facts = factsOf(files, m);
  if (facts.npmProblem) throw new InstallError('npm', facts.npmProblem);

  const slug = freeSlug(opts.home, opts.projectRoot, m.slug);
  const installId = randomBytes(16).toString('hex');
  const configId = newConfigId();
  const src = sourceRepo(opts.home, installId);
  mkdirSync(sourcesDir(opts.home), { recursive: true, mode: 0o700 });
  const root = join(installedAppsDir(opts.projectRoot), slug);
  renameSync(incoming, src);
  // Until the record is written, any failure puts everything back as the preview left it.
  try {
    mkdirSync(root, { recursive: true });
    const g = (args: string[]) => installedGit(src, args, { workTree: root });
    installedGit(src, ['config', 'core.bare', 'false']);
    mkdirSync(join(src, 'info'), { recursive: true });
    writeFileSync(join(src, 'info', 'exclude'), EXCLUDE);
    installedGit(src, ['update-ref', 'refs/dc/upstream', opts.sha]);
    g(['checkout', '-q', '-f', '-B', 'local', opts.sha]);
    if (facts.dependencies && opts.npm !== false) await runNpmCi(root);
    const secrets = Object.entries(opts.secrets ?? {}).filter(([k, v]) => m.config.some((f) => f.type === 'secret' && f.key === k) && typeof v === 'string' && v.length > 0).map(([key, value]) => ({ key, value: value as string }));
    if (secrets.length) writeEnvSecrets(root, '.env', secrets);
  } catch (e) {
    rmSync(root, { recursive: true, force: true });
    try { installedGit(src, ['config', 'core.bare', 'true']); renameSync(src, incoming); } catch { rmSync(src, { recursive: true, force: true }); }
    throw e;
  }
  rmSync(join(dir, `${opts.previewId}.json`), { force: true });

  const rec = registerInstalledApp(opts.home, {
    slug, vault: opts.vault, projectRoot: opts.projectRoot, root, name: m.name, installId, configId,
    approvedManifestSha: manifestSha(manifestText),
    source: { host: meta.host, fullName: meta.fullName, repoId: meta.repoId, ownerId: meta.ownerId, owner: meta.owner, public: meta.public, mode: 'following', autoUpdate: false, upstreamSha: opts.sha },
    provenance: { fullName: meta.fullName, license: licenseKind(files.find((f) => f.path === 'LICENSE')?.data.toString('utf-8') ?? null) },
  });
  const values = Object.fromEntries(Object.entries(opts.config ?? {}).filter(([k]) => m.config.some((f) => f.key === k && f.type !== 'secret')));
  if (Object.keys(values).length) setAppConfig(opts.home, configId, m.config, values);
  try { allowAppDir(opts.projectRoot, rec.root); } catch { /* the agent asks for the folder instead */ }
  return { rec, renamed: slug !== m.slug };
}

// ─── Uninstall and the trash (K6) ───────────────────────────────────────────────────

export interface TrashEntry {
  id: string;
  name: string;
  slug: string;
  fullName: string | null;
  at: string;
}

/** rename, or copy + remove across volumes (EXDEV) and when a rename is refused. */
function move(from: string, to: string): void {
  try { renameSync(from, to); return; } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'EBUSY') throw e;
  }
  cpSync(from, to, { recursive: true, verbatimSymlinks: true });
  rmSync(from, { recursive: true, force: true });
}

/** Move an installed app to the trash. Its data stays where it is unless `deleteData`. */
export function uninstallApp(home: string, rec: AppRecord, opts: { deleteData?: boolean } = {}): TrashEntry {
  if (rec.origin !== 'installed' || !rec.installId) throw new InstallError('not_installed', 'Only an app installed from someone else goes to the trash this way.');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const id = `${rec.installId}-${stamp}`;
  const t = join(trashDir(home), id);
  mkdirSync(t, { recursive: true, mode: 0o700 });
  if (existsSync(rec.root)) move(rec.root, join(t, 'code'));
  const src = sourceRepo(home, rec.installId);
  if (existsSync(src)) move(src, join(t, 'source.git'));
  if (rec.configId) { try { move(appConfigPath(home, rec.configId), join(t, 'config.json')); } catch { /* no settings */ } }
  // The owner's logo goes with its settings, and comes back with them.
  const logo = appLogoPath(home, rec.configId);
  if (logo) { try { move(logo, join(t, `logo${extname(logo)}`)); } catch { /* the app's own icon then */ } }
  if (opts.deleteData) {
    const data = appDataDir(rec.projectRoot, rec.slug);
    if (existsSync(data)) move(data, join(t, 'data'));
  }
  // The record last: an entry without one is a move that did not finish, never a restorable app.
  writeFileSync(join(t, 'record.json'), JSON.stringify(rec, null, 2), { mode: 0o600 });
  unregisterApp(home, rec.projectRoot, rec.slug);
  return { id, name: rec.name, slug: rec.slug, fullName: rec.source?.fullName ?? rec.provenance?.fullName ?? null, at: new Date().toISOString() };
}

export function listTrash(home: string, projectRoot?: string): TrashEntry[] {
  const out: TrashEntry[] = [];
  try {
    for (const id of readdirSync(trashDir(home)).sort().reverse()) {
      try {
        const rec = JSON.parse(readFileSync(join(trashDir(home), id, 'record.json'), 'utf-8')) as AppRecord;
        if (projectRoot && rec.projectRoot !== projectRoot) continue;
        out.push({ id, name: rec.name, slug: rec.slug, fullName: rec.source?.fullName ?? rec.provenance?.fullName ?? null, at: id.slice(33) });
      } catch { /* not an entry */ }
    }
  } catch { /* empty */ }
  return out;
}

export function restoreFromTrash(home: string, id: string): AppRecord {
  if (!/^[0-9a-f]{32}-[0-9TZ-]+$/.test(id)) throw new InstallError('bad_request', 'bad trash id');
  const t = join(trashDir(home), id);
  const rec = JSON.parse(readFileSync(join(t, 'record.json'), 'utf-8')) as AppRecord;
  if (!rec.installId || !/^[0-9a-f]{32}$/.test(rec.installId)) throw new InstallError('bad_request', 'bad trash entry');
  const data = appDataDir(rec.projectRoot, rec.slug);
  // Every refusal comes before the first move: a restore either happens whole or not at all.
  if (getApp(home, rec.projectRoot, rec.slug) || existsSync(rec.root)) throw new InstallError('slug_taken', `An app "${rec.slug}" is there again; remove it first.`);
  if (existsSync(join(t, 'data')) && existsSync(data)) throw new InstallError('data_taken', `Another app's data is in "${rec.slug}"'s place now; nothing was restored.`);
  mkdirSync(join(rec.root, '..'), { recursive: true });
  if (existsSync(join(t, 'code'))) move(join(t, 'code'), rec.root);
  if (existsSync(join(t, 'source.git'))) { mkdirSync(sourcesDir(home), { recursive: true, mode: 0o700 }); move(join(t, 'source.git'), sourceRepo(home, rec.installId)); }
  if (rec.configId && existsSync(join(t, 'config.json'))) { mkdirSync(join(appConfigPath(home, rec.configId), '..'), { recursive: true, mode: 0o700 }); move(join(t, 'config.json'), appConfigPath(home, rec.configId)); }
  for (const ext of ['.png', '.jpg']) {
    const kept = join(t, `logo${ext}`);
    if (!rec.configId || !/^[0-9a-f]{16,64}$/.test(rec.configId) || !existsSync(kept) || lstatSync(kept).isSymbolicLink()) continue;
    mkdirSync(appLogoDir(home), { recursive: true, mode: 0o700 });
    move(kept, join(appLogoDir(home), `${rec.configId}${ext}`));
  }
  if (existsSync(join(t, 'data'))) { mkdirSync(join(data, '..'), { recursive: true }); move(join(t, 'data'), data); }
  const { hash: _h, createdAt: _c, origin: _o, ...rest } = rec;
  const back = registerInstalledApp(home, { ...rest, installId: rec.installId });
  rmSync(t, { recursive: true, force: true });
  return back;
}

/** Installed apps of a project (for the sweep and the list). */
export function installedApps(home: string, projectRoot?: string): AppRecord[] {
  return listApps(home, projectRoot).filter((a) => a.origin === 'installed');
}
