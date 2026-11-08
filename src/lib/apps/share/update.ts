/**
 * Updates of an installed app, and "my own copy" (paylasilan-app-ler plan r2 K4 + K9, r3).
 *
 * Unsigned (owner decision 4), so the guarantees are: the SAME repo and owner (repoId + ownerId),
 * forward only (the new commit descends from the one installed), the owner's click bound to the
 * sha the card showed, and any manifest change asks the owner again with the change shown.
 *
 * The copy is the installer's: the app's own assistant may change its code (r3). A changed copy is
 * never overwritten in silence: the card asks Merge / What would be lost / Make it my own copy /
 * Keep my changes aside and update. Settings and data live outside the repo and are never touched.
 * Every update first saves `refs/dc/before/<stamp>`; Undo goes back to it with local commits kept.
 *
 * Auto-update (owner decision 3): off by default, on per app from the owner's page, never for a
 * public app, applied only when the manifest is unchanged, the copy unedited and the source the same.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appsHome, getApp, updateAppShare, type AppRecord } from '../registry.js';
import { cleanText, parseManifest } from '../manifest.js';
import { resolveAppHost, type AppHost } from './host.js';
import { factsOf, installGate, InstallError, manifestSha, runNpmCi, sourceRepo } from './install.js';
import { installedGit, installedGitAsync, isAncestor, lsTree, readBlob, revParse } from './installed-git.js';

export type UpdateCheck =
  | { state: 'none'; sha: string }
  | { state: 'available'; sha: string; manifestChanged: boolean; manifestChanges: string[]; edited: Edits | null; notes: string[]; wouldLose: string[] }
  | { state: 'problem'; code: 'no_access' | 'moved' | 'not_forward' | 'not_following' | 'gate' | 'fetch_failed'; message: string };

export interface Edits {
  files: string[];
  commits: number;
}

const LOCAL_ID = { GIT_AUTHOR_NAME: 'you', GIT_AUTHOR_EMAIL: 'you@localhost', GIT_COMMITTER_NAME: 'you', GIT_COMMITTER_EMAIL: 'you@localhost' };

function gitOf(home: string, rec: AppRecord) {
  if (!rec.installId) throw new InstallError('not_installed', 'not an installed app');
  const dir = sourceRepo(home, rec.installId);
  return {
    dir,
    g: (args: string[], extra?: { env?: NodeJS.ProcessEnv; allowFile?: boolean; input?: string }) => installedGit(dir, args, { workTree: rec.root, ...extra }),
  };
}

/** What the installer changed in this copy: files (vs the installed upstream) and own commits. */
export function localEdits(home: string, rec: AppRecord): Edits | null {
  if (!rec.source) return null;
  const { g } = gitOf(home, rec);
  const files = new Set<string>();
  for (const line of g(['status', '--porcelain', '-z', '--untracked-files=all']).split('\0')) if (line.length > 3) files.add(line.slice(3));
  for (const f of g(['diff', '--name-only', '-z', rec.source.upstreamSha, 'HEAD']).split('\0')) if (f) files.add(f);
  const commits = Number(g(['rev-list', '--count', `${rec.source.upstreamSha}..HEAD`]).trim()) || 0;
  return files.size || commits ? { files: [...files].sort(), commits } : null;
}

function manifestAt(dir: string, sha: string): string | null {
  const e = lsTree(dir, sha).find((x) => x.path === 'dreamcontext-app.json');
  return e ? readBlob(dir, e.sha).toString('utf-8') : null;
}

/** The manifest fields that changed (any change asks the owner again). */
function manifestChanges(a: string | null, b: string | null): string[] {
  const pa = a ? parseManifest(a, null) : null;
  const pb = b ? parseManifest(b, null) : null;
  if (!pa?.ok || !pb?.ok) return a === b ? [] : ['(the manifest)'];
  const out: string[] = [];
  const ma = pa.manifest as unknown as Record<string, unknown>;
  const mb = pb.manifest as unknown as Record<string, unknown>;
  for (const k of new Set([...Object.keys(ma), ...Object.keys(mb)])) if (JSON.stringify(ma[k]) !== JSON.stringify(mb[k])) out.push(k);
  return out;
}

function hostFor(home: string, rec: AppRecord, host?: AppHost): AppHost {
  if (host) return host;
  const signed = resolveAppHost(home);
  return signed.signedIn || !rec.source?.public ? signed : resolveAppHost(home, { anonymous: true });
}

export async function checkUpdate(home: string, rec: AppRecord, host?: AppHost): Promise<UpdateCheck> {
  const src = rec.source;
  if (rec.origin !== 'installed' || !src || src.mode !== 'following') return { state: 'problem', code: 'not_following', message: 'This app does not follow an original (it is your own copy).' };
  const h = hostFor(home, rec, host);
  const setProblem = (code: 'no_access' | 'moved' | 'not_forward', message: string): UpdateCheck => {
    updateAppShare(home, rec.projectRoot, rec.slug, (r) => ({ source: r.source ? { ...r.source, problem: code, lastCheck: new Date().toISOString(), available: undefined } : undefined }));
    return { state: 'problem', code, message };
  };
  let repo;
  // Only a confirmed "not there / no access" is stored; offline, 5xx and rate limits are not.
  try { repo = await h.getRepo(src.fullName); } catch (e) { return { state: 'problem', code: 'fetch_failed', message: `Could not reach the original: ${(e as Error).message}` }; }
  if (!repo) return setProblem('no_access', 'You no longer reach the original: the app keeps working, updates do not come. You can make it your own copy.');
  if (repo.repoId !== src.repoId || repo.ownerId !== src.ownerId) return setProblem('moved', 'The original changed hands (another repo or owner now): no updates from it. You can make it your own copy.');
  const { dir, g } = gitOf(home, rec);
  try {
    await h.withGit((env) => installedGitAsync(dir, ['fetch', '-q', '--no-tags', h.cloneUrl(src.fullName), '+refs/heads/main:refs/dc/upstream-next'], { env, allowFile: h.allowFile, timeoutMs: 300_000 }));
  } catch (e) {
    return { state: 'problem', code: 'fetch_failed', message: `Could not reach the original: ${(e as Error).message}` };
  }
  const next = revParse(dir, 'refs/dc/upstream-next');
  if (!next || next === src.upstreamSha) {
    updateAppShare(home, rec.projectRoot, rec.slug, (r) => ({ source: r.source ? { ...r.source, lastCheck: new Date().toISOString(), available: undefined, problem: undefined } : undefined }));
    return { state: 'none', sha: src.upstreamSha };
  }
  if (!isAncestor(dir, src.upstreamSha, next)) return setProblem('not_forward', 'The original went back or rewrote its history: this update is refused.');
  const files = lsTree(dir, next).map((e) => ({ path: e.path, mode: e.mode, data: e.type === 'blob' && e.size <= 2 * 1024 * 1024 ? readBlob(dir, e.sha) : Buffer.alloc(e.size > 2 * 1024 * 1024 ? 2 * 1024 * 1024 + 1 : 0) }));
  const nextManifest = files.find((f) => f.path === 'dreamcontext-app.json')?.data.toString('utf-8') ?? null;
  const pm = nextManifest ? parseManifest(nextManifest, null) : null;
  const gate = installGate(files, pm?.ok ? pm.manifest.icon : null, pm?.ok ? pm.manifest.share.include : []);
  const npmProblem = pm?.ok ? factsOf(files, pm.manifest).npmProblem : null;
  if (npmProblem) gate.blocks.push({ id: 'npm', rule: 'npm', file: 'package.json', label: npmProblem });
  if (!pm?.ok || gate.blocks.length) return { state: 'problem', code: 'gate', message: `The new version holds something an app may not: ${gate.blocks.map((b) => `${b.file} (${b.label})`).slice(0, 5).join('; ') || 'no valid manifest'}.` };
  const changes = manifestChanges(manifestAt(dir, src.upstreamSha), nextManifest);
  const notes = g(['log', '--format=%s', '-n', '20', `${src.upstreamSha}..${next}`]).split('\n').map((s) => cleanText(s, 200)).filter(Boolean);
  const edited = localEdits(home, rec);
  const theirs = new Set(g(['diff', '--name-only', '-z', src.upstreamSha, next]).split('\0').filter(Boolean));
  const wouldLose = edited ? edited.files.filter((f) => theirs.has(f)) : [];
  updateAppShare(home, rec.projectRoot, rec.slug, (r) => ({ source: r.source ? { ...r.source, lastCheck: new Date().toISOString(), available: { sha: next, at: new Date().toISOString() }, problem: undefined } : undefined }));
  return { state: 'available', sha: next, manifestChanged: changes.length > 0, manifestChanges: changes, edited, notes, wouldLose };
}

export type ApplyHow = 'merge' | 'set-aside';

export interface ApplyOptions {
  sha: string;
  /** The owner saw the manifest change and approves it. */
  approveManifest?: boolean;
  /** A changed copy: how to bring the update in. */
  how?: ApplyHow;
}

export interface ApplyResult {
  sha: string;
  before: string;
  patch?: string;
  /** npm ci failed after the update: the app may not start until Undo or a fix. */
  depsFailed?: string;
}

/** `npm ci` when the package files changed and the app has dependencies; the failure, or null. */
async function syncDeps(root: string, changed: boolean, npm: boolean | undefined): Promise<string | null> {
  if (!changed || npm === false || !existsSync(join(root, 'package.json'))) return null;
  try {
    const deps = Object.keys((JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as { dependencies?: object }).dependencies ?? {}).length;
    if (deps) await runNpmCi(root);
    return null;
  } catch (e) {
    return cleanText((e as Error).message, 300);
  }
}

const stampNow = () => new Date().toISOString().replace(/[:.]/g, '-');

export async function applyUpdate(home: string, rec0: AppRecord, opts: ApplyOptions & { auto?: boolean; npm?: boolean }): Promise<ApplyResult> {
  const rec = getApp(home, rec0.projectRoot, rec0.slug) ?? rec0;
  const src = rec.source;
  if (rec.origin !== 'installed' || !src || src.mode !== 'following') throw new InstallError('not_following', 'This app does not follow an original.');
  // The click approves what the card showed: that sha, nothing that came after it.
  if (!src.available || src.available.sha !== opts.sha) throw new InstallError('stale_card', 'The update changed since the card was shown; check again.');
  const { dir, g } = gitOf(home, rec);
  if (revParse(dir, 'refs/dc/upstream-next') !== opts.sha) throw new InstallError('stale_card', 'The update changed since the card was shown; check again.');
  const newManifest = manifestAt(dir, opts.sha);
  const changes = manifestChanges(manifestAt(dir, src.upstreamSha), newManifest);
  if (changes.length && !opts.approveManifest) throw new InstallError('needs_approval', `This update changes what the app may do (${changes.join(', ')}): approve it on the card.`);
  const edited = localEdits(home, rec);
  if (edited && !opts.how) throw new InstallError('edited', `You changed this app (${edited.files.length} file(s)): pick Merge, Keep my changes aside, or Make it my own copy.`);

  const stamp = stampNow();
  let patch: string | undefined;
  // Local changes first become a commit on `local`, so nothing of theirs is ever only in the tree.
  if (edited && g(['status', '--porcelain']).trim()) {
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'Local changes'], { env: LOCAL_ID });
  }
  const before = g(['rev-parse', 'HEAD']).trim();
  g(['update-ref', `refs/dc/before/${stamp}`, before]);
  g(['update-ref', `refs/dc/before-upstream/${stamp}`, src.upstreamSha]);

  if (!edited) {
    g(['reset', '-q', '--hard', opts.sha]);
  } else if (opts.how === 'merge') {
    try {
      g(['merge', '-q', '--no-edit', '--no-ff', '-m', 'Update from the original', opts.sha], { env: LOCAL_ID });
    } catch {
      try { g(['merge', '--abort']); } catch { /* nothing to abort */ }
      g(['reset', '-q', '--hard', before]);
      throw new InstallError('merge_conflict', 'Your changes and the update touch the same lines: nothing changed. Ask Claude to merge them, keep your changes aside, or make it your own copy.');
    }
  } else {
    const diff = g(['diff', '--binary', src.upstreamSha, before]);
    const pdir = join(appsHome(home), 'patches');
    mkdirSync(pdir, { recursive: true, mode: 0o700 });
    patch = join(pdir, `${rec.installId}-${stamp}.patch`);
    writeFileSync(patch, diff, { mode: 0o600 });
    g(['reset', '-q', '--hard', opts.sha]);
  }
  installedGit(dir, ['update-ref', 'refs/dc/upstream', opts.sha]);
  // What Undo checks: the copy as this update left it. A change after it is never undone away.
  installedGit(dir, ['update-ref', `refs/dc/after/${stamp}`, g(['rev-parse', 'HEAD']).trim()]);
  // New or changed dependencies come in with the update; a failure is said on the card, with Undo.
  const depsFailed = await syncDeps(rec.root, g(['diff', '--name-only', before, 'HEAD', '--', 'package.json', 'package-lock.json']).trim() !== '', opts.npm);
  updateAppShare(home, rec.projectRoot, rec.slug, (r) => ({
    approvedManifestSha: newManifest ? manifestSha(newManifest) : r.approvedManifestSha,
    source: r.source ? { ...r.source, upstreamSha: opts.sha, available: undefined, problem: undefined, lastUpdate: { from: src.upstreamSha, to: opts.sha, at: new Date().toISOString(), auto: opts.auto === true, ...(depsFailed ? { depsFailed } : {}) } } : undefined,
  }));
  return { sha: opts.sha, before, ...(patch ? { patch } : {}), ...(depsFailed ? { depsFailed } : {}) };
}

/** Undo the last update: back to the saved commit, local commits kept. */
export async function undoUpdate(home: string, rec0: AppRecord, opts: { npm?: boolean } = {}): Promise<{ sha: string; depsFailed?: string }> {
  const rec = getApp(home, rec0.projectRoot, rec0.slug) ?? rec0;
  if (!rec.source) throw new InstallError('not_following', 'Nothing to undo.');
  const { dir, g } = gitOf(home, rec);
  const refs = installedGit(dir, ['for-each-ref', '--sort=-refname', '--format=%(refname)', 'refs/dc/before/']).split('\n').filter(Boolean);
  if (!refs.length) throw new InstallError('nothing_to_undo', 'No update to undo.');
  const stamp = refs[0].slice('refs/dc/before/'.length);
  const before = revParse(dir, refs[0])!;
  const upstream = revParse(dir, `refs/dc/before-upstream/${stamp}`) ?? rec.source.upstreamSha;
  const undone = rec.source.upstreamSha;
  // Undo goes back over the update only: a change made after it would be lost, so it refuses.
  const after = revParse(dir, `refs/dc/after/${stamp}`);
  if (g(['status', '--porcelain']).trim() || (after && g(['rev-parse', 'HEAD']).trim() !== after)) {
    throw new InstallError('changed_since', 'This app was changed after the update: Undo would lose that change, so nothing was undone.');
  }
  const headBefore = g(['rev-parse', 'HEAD']).trim();
  g(['reset', '-q', '--hard', before]);
  // The dependencies go back with the code.
  const depsFailed = await syncDeps(rec.root, g(['diff', '--name-only', headBefore, 'HEAD', '--', 'package.json', 'package-lock.json']).trim() !== '', opts.npm);
  for (const r of [refs[0], `refs/dc/before-upstream/${stamp}`, `refs/dc/after/${stamp}`]) { try { installedGit(dir, ['update-ref', '-d', r]); } catch { /* none */ } }
  installedGit(dir, ['update-ref', 'refs/dc/upstream', upstream]);
  const m = manifestAt(dir, upstream);
  updateAppShare(home, rec.projectRoot, rec.slug, (r) => ({
    approvedManifestSha: m ? manifestSha(m) : r.approvedManifestSha,
    // The undone version is still there to take again.
    source: r.source ? { ...r.source, upstreamSha: upstream, lastUpdate: undefined, available: undone !== upstream ? { sha: undone, at: new Date().toISOString() } : undefined } : undefined,
  }));
  if (undone !== upstream) installedGit(dir, ['update-ref', 'refs/dc/upstream-next', undone]);
  return { sha: before, ...(depsFailed ? { depsFailed } : {}) };
}

/** "Make it my own copy": no more updates, no tie to the original; origin stays `installed`. */
export function detachApp(home: string, rec: AppRecord): AppRecord {
  if (rec.origin !== 'installed') throw new InstallError('not_installed', 'This is already your own app.');
  return updateAppShare(home, rec.projectRoot, rec.slug, (r) => ({ source: undefined, provenance: r.provenance ?? (r.source ? { fullName: r.source.fullName, license: 'unknown' } : undefined) })) ?? rec;
}

export function setAutoUpdate(home: string, rec: AppRecord, on: boolean): AppRecord {
  if (!rec.source || rec.source.mode !== 'following') throw new InstallError('not_following', 'This app does not follow an original.');
  if (on && rec.source.public) throw new InstallError('public_no_auto', 'A public app never updates by itself: you apply each update.');
  return updateAppShare(home, rec.projectRoot, rec.slug, (r) => ({ source: r.source ? { ...r.source, autoUpdate: on } : undefined })) ?? rec;
}

/** One app's automatic update, when every condition holds. Null = nothing applied. */
export async function autoUpdateOne(home: string, rec: AppRecord, host?: AppHost): Promise<ApplyResult | null> {
  if (!rec.source?.autoUpdate || rec.source.public || rec.source.mode !== 'following') return null;
  const c = await checkUpdate(home, rec, host);
  if (c.state !== 'available' || c.manifestChanged || c.edited) return null;
  return applyUpdate(home, rec, { sha: c.sha, auto: true });
}

export function digestOf(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
