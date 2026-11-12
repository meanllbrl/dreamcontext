/**
 * Publishing an app (paylasilan-app-ler plan r2 K1, r3). The working repo never leaves this Mac:
 * the publish reads the app's COMMITTED files (`HEAD`, a clean tree), keeps what the allow-list
 * holds, runs the gate on exactly that, and writes ONE commit into a publish mirror
 * (`~/.dreamcontext/apps/published/<hash>.git`) whose parent is the previous publish. Only that
 * mirror is pushed. Author and committer are the account's noreply address at `+0000`, with no
 * global git config: the publisher's name, e-mail, time zone and history do not travel.
 *
 * Every commit carries `Dreamcontext-Publish: <digest of the files>`; a commit in the repo whose
 * files do not match its line (or that has none) stops the next publish: someone pushed by hand.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { basename, join } from 'node:path';
import { appsHome, updateAppShare, type AppRecord } from '../registry.js';
import { readManifest, type AppManifest, cleanText } from '../manifest.js';
import { applyStoreEdits, parseStoreReadme, TAGLINE_MAX } from '../store-readme.js';
import { readAppConfig } from '../app-config.js';
import { parseDotenv } from '../redact.js';
import { listVaults } from '../../vaults.js';
import { readLinkedRepoRegistry } from '../../linked-repos.js';
import { sdkSource } from '../../../server/apps/gateway-w3.js';
import { APP_TOPIC, HostError, type AppHost, type HostUser } from './host.js';
import { findingId, PUBLISH_TRAILER, runGate, treeDigest, type GateFile, type GateFinding, type GateMode, type GateReport, type GateTerms } from './gate.js';
import { initHardRepo, installedGit, installedGitAsync, lsTree, readBlob, revParse } from './installed-git.js';

export class PublishError extends Error {
  constructor(public code: string, message: string, public report?: GateReport) { super(message); }
}

export type Visibility = 'private' | 'public';

// ─── Licences (owner decisions 5 and 6) ─────────────────────────────────────────────

const RESTRICTED_MARK = 'dreamcontext shared app licence (restricted)';

export function restrictedLicense(owner: string, year: number): string {
  return `${RESTRICTED_MARK}

Copyright (c) ${year} ${owner}. All rights reserved.

You may install and use this app, and change your own copy of it, because its owner shared it
with you. You may not publish, share or sell it, or a changed copy of it, to anyone else.
`;
}

export function mitLicense(owner: string, year: number): string {
  return `MIT License

Copyright (c) ${year} ${owner}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
}

/** What a LICENSE text is: `restricted`, a known open licence, or `unknown` (= not re-shareable). */
export function licenseKind(text: string | null): string {
  if (!text) return 'none';
  if (text.includes(RESTRICTED_MARK)) return 'restricted';
  if (/^\s*MIT License/i.test(text) || /Permission is hereby granted, free of charge/i.test(text)) return 'MIT';
  if (/Apache License,?\s+Version 2\.0/i.test(text)) return 'Apache-2.0';
  if (/Redistribution and use in source and binary forms/i.test(text)) return 'BSD';
  if (/ISC License/i.test(text)) return 'ISC';
  return 'unknown';
}

export const RESHARE_OK = new Set(['MIT', 'Apache-2.0', 'BSD', 'ISC']);

// ─── The source: the app's committed files ──────────────────────────────────────────

function ownRepoGit(root: string, args: string[], binary = false): string | Buffer {
  const out = execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=', '-C', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  return binary ? out : out.toString('utf-8');
}

export interface SourceTree {
  head: string;
  files: GateFile[];
}

/**
 * HEAD's files of the app's repo: its own git, or for a copy of someone else's app the source
 * repo kept outside its folder. A change not committed yet stops here (it would not travel).
 */
export function readSourceTree(rec: Pick<AppRecord, 'root' | 'installId'>, home: string = homedir()): SourceTree {
  const root = rec.root;
  const files: GateFile[] = [];
  const nlinkOf = (path: string) => { try { return lstatSync(join(root, path)).nlink; } catch { return 1; } };
  if (rec.installId) {
    // A copy of someone else's app: its git is kept outside the folder, so the owner cannot commit
    // there. What travels is the copy as it is now (ignored files excluded), read through a
    // throwaway index: the copy's own branch is not touched.
    const srcRepo = join(appsHome(home), 'sources', `${rec.installId}.git`);
    const idx = mkdtempSync(join(tmpdir(), 'dc-copy-idx-'));
    try {
      const env = { GIT_INDEX_FILE: join(idx, 'index') };
      installedGit(srcRepo, ['add', '-A'], { workTree: root, env });
      for (const line of installedGit(srcRepo, ['ls-files', '-s', '-z'], { workTree: root, env }).split('\0')) {
        if (!line) continue;
        const tab = line.indexOf('\t');
        const [mode, sha] = line.slice(0, tab).split(/\s+/);
        const path = line.slice(tab + 1);
        files.push({ path, mode, data: mode === '160000' ? Buffer.alloc(0) : readBlob(srcRepo, sha), nlink: nlinkOf(path) });
      }
      const head = installedGit(srcRepo, ['rev-parse', 'HEAD'], { workTree: root }).trim();
      return { head, files };
    } finally {
      rmSync(idx, { recursive: true, force: true });
    }
  }
  let head: string;
  try { head = (ownRepoGit(root, ['rev-parse', '--verify', 'HEAD^{commit}']) as string).trim(); } catch {
    throw new PublishError('no_commits', 'The app has no commit yet: commit it first (`git add -A && git commit` in the app folder).');
  }
  const dirty = (ownRepoGit(root, ['status', '--porcelain', '--untracked-files=no']) as string).trim();
  if (dirty) throw new PublishError('uncommitted', `The app has changes not committed yet (${dirty.split('\n').length} file(s)). Commit them first: only committed files are published.`);
  const out = ownRepoGit(root, ['ls-tree', '-r', '-z', '--full-tree', 'HEAD']) as string;
  for (const line of out.split('\0')) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    const [mode, , sha] = line.slice(0, tab).split(/\s+/);
    const path = line.slice(tab + 1);
    const data = mode === '160000' ? Buffer.alloc(0) : (ownRepoGit(root, ['cat-file', 'blob', sha], true) as Buffer);
    files.push({ path, mode, data, nlink: nlinkOf(path) });
  }
  return { head, files };
}

// ─── What must never travel: the terms ─────────────────────────────────────────────

function names(dir: string, ext?: string): string[] {
  try { return readdirSync(dir).filter((f) => !f.startsWith('.') && (!ext || f.endsWith(ext))).map((f) => (ext ? f.slice(0, -ext.length) : f)); } catch { return []; }
}

/** The publisher's identity (hard) and own generic words (approvable). Values never leave here. */
export function collectTerms(home: string, rec: AppRecord): GateTerms {
  const hard: GateTerms['hard'] = [];
  const approvable: GateTerms['approvable'] = [];
  try { for (const e of parseDotenv(readFileSync(join(rec.root, '.env'), 'utf-8'))) if (e.value.length >= 6) hard.push({ label: `a value of ${e.key} from the app .env`, value: e.value }); } catch { /* no .env */ }
  for (const [k, v] of Object.entries(readAppConfig(home, rec.configId))) if (typeof v === 'string' && v.length >= 3) hard.push({ label: `the value of the setting "${k}"`, value: v });
  const ctx = join(rec.projectRoot, '_dream_context');
  try {
    const people = JSON.parse(readFileSync(join(ctx, 'people', 'people.json'), 'utf-8')) as { people?: Record<string, { name?: string; emails?: string[] }> };
    for (const p of Object.values(people.people ?? {})) {
      if (p.name) { hard.push({ label: "a person's name (people)", value: p.name }); for (const part of p.name.split(/\s+/)) if (part.length >= 4) hard.push({ label: "a person's name (people)", value: part }); }
      for (const e of p.emails ?? []) hard.push({ label: 'an e-mail (people)', value: e });
    }
  } catch { /* no people */ }
  for (const key of ['user.name', 'user.email']) {
    try { const v = execFileSync('git', ['config', '--global', key], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); if (v.length >= 3) hard.push({ label: key === 'user.name' ? 'your git name' : 'your git e-mail', value: v }); } catch { /* unset */ }
  }
  try { const u = userInfo().username; if (u.length >= 4) hard.push({ label: 'your Mac user name', value: u }); } catch { /* none */ }
  if (home !== homedir()) { const u = basename(home); if (u.length >= 4) hard.push({ label: 'your Mac user name', value: u }); }

  for (const v of listVaults(home)) approvable.push({ label: 'a project name', value: v.name });
  approvable.push({ label: 'the project folder name', value: basename(rec.projectRoot) });
  for (const n of names(join(ctx, 'lab', 'insights'), '.md')) approvable.push({ label: 'an insight name', value: n });
  for (const n of names(join(ctx, 'core', 'objectives'), '.md')) approvable.push({ label: 'an objective name', value: n });
  for (const n of names(join(ctx, 'agents'))) approvable.push({ label: 'an AI Team member', value: n.replace(/\.md$/, '') });
  try { for (const n of Object.keys((JSON.parse(readFileSync(join(rec.projectRoot, '.mcp.json'), 'utf-8')) as { mcpServers?: object }).mcpServers ?? {})) approvable.push({ label: 'an MCP server name', value: n }); } catch { /* none */ }
  try { for (const n of Object.keys(readLinkedRepoRegistry(home))) approvable.push({ label: 'a linked repo name', value: n }); } catch { /* none */ }
  return { hard, approvable };
}

// ─── The tree a publish sends ───────────────────────────────────────────────────────

export interface PublishPreview {
  manifest: AppManifest;
  visibility: Visibility;
  mode: GateMode;
  repoName: string;
  /** The repo it goes to: the earlier publish's, or the one it would create. */
  fullName: string | null;
  license: string;
  files: GateFile[];
  report: GateReport;
  digest: string;
  /** The README with the store edits, when the publish changes it (written back after the push). */
  storeReadme: string | null;
  /** The README the source holds now (HEAD, or the copy's working tree). */
  sourceReadme: Buffer | null;
}

const GITIGNORE = '.env\n.env.*\ndata/\nnode_modules/\n*.log\n';

function readmeFor(m: AppManifest): string {
  return readmeSkeletonLess(m.name);
}

/** The README edits a publish carries (app-paylasim-magaza r2): the tagline field and the note. */
export function storeReadmeFor(rec: Pick<AppRecord, 'publish'>, name: string, current: string | null, opts: { tagline?: string; note?: string; date?: string }): string | null {
  const parsed = parseStoreReadme(current ?? '', { full: true });
  const note = cleanText(opts.note ?? '', 300) || (!rec.publish?.lastSha && !parsed.whatsNew.length ? 'First version.' : '');
  const tagline = cleanText(opts.tagline ?? '', TAGLINE_MAX + 40);
  if (!note && !tagline) return null;
  const next = applyStoreEdits(current ?? readmeSkeletonLess(name), { name, tagline: tagline || null, note: note || null, date: opts.date ?? publishDate(), firstPublish: !rec.publish?.lastSha });
  return next === (current ?? '').replace(/\r\n?/g, '\n') ? null : next;
}

/** Today, as the README's What's new entry writes it. A request card stores it, so a spend after midnight matches. */
export function publishDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function readmeSkeletonLess(name: string): string {
  return `# ${name}\n\nA dreamcontext app. Install it from the Apps page in dreamcontext: Shared Apps, or "Install from a link" with this repo's link.\n`;
}

export function buildPublishTree(home: string, rec: AppRecord, opts: { visibility: Visibility; login: string; approvals?: string[]; note?: string; tagline?: string; repoName?: string; date?: string }): PublishPreview {
  const m = readManifest(rec.root);
  if (!m.ok) throw new PublishError('bad_manifest', `The manifest has problems: ${m.errors.map((e) => `${e.field}: ${e.problem}`).join('; ')}`);
  if (rec.provenance && !RESHARE_OK.has(rec.provenance.license)) throw new PublishError('license_forbids', `This app is a copy of ${rec.provenance.fullName}, whose licence (${rec.provenance.license}) does not allow sharing it again.`);
  const src = readSourceTree(rec, home);
  const mode: GateMode = opts.visibility === 'public' ? 'strict' : 'normal';
  const year = new Date().getUTCFullYear();
  const byPath = new Map(src.files.map((f) => [f.path, f]));
  const extra: GateFile[] = [];
  /** What the publish writes itself (it names the account; no identity scan). */
  const generated = new Set<string>();
  const sourceLicense = byPath.get('LICENSE')?.data.toString('utf-8') ?? null;
  let license = licenseKind(sourceLicense);

  // A copy of someone else's app (owner decision 6): only under a licence that allows it, with
  // the source named; its own LICENSE travels as it came.
  if (rec.provenance) {
    const k = rec.provenance.license;
    if (!RESHARE_OK.has(k)) throw new PublishError('license_forbids', `This app is a copy of ${rec.provenance.fullName}, whose licence (${k}) does not allow sharing it again.`);
    const readme = byPath.get('README.md')?.data.toString('utf-8') ?? readmeFor(m.manifest);
    const line = `\n\nDerived from ${rec.provenance.fullName} (${k}).\n`;
    if (!readme.includes(`Derived from ${rec.provenance.fullName}`)) extra.push({ path: 'README.md', mode: '100644', data: Buffer.from(readme.trimEnd() + line) });
    if (!sourceLicense) throw new PublishError('license_forbids', 'The original LICENSE is missing from this copy; it must travel with it.');
  } else if (!sourceLicense || license === 'restricted' || license === 'MIT') {
    // The default licence follows the visibility (owner decision 5); an own licence stays.
    const text = opts.visibility === 'public' ? mitLicense(opts.login, year) : restrictedLicense(opts.login, year);
    extra.push({ path: 'LICENSE', mode: '100644', data: Buffer.from(text) });
    generated.add('LICENSE');
    license = opts.visibility === 'public' ? 'MIT' : 'restricted';
  }
  // The store page's words (tagline, What's new) are written into the README that goes; the
  // edited README is the publisher's text again, so it is scanned like any other file.
  const baseReadme = extra.find((f) => f.path === 'README.md')?.data.toString('utf-8') ?? byPath.get('README.md')?.data.toString('utf-8') ?? null;
  const storeReadme = storeReadmeFor(rec, m.manifest.name, baseReadme, { tagline: opts.tagline, note: opts.note, date: opts.date });
  if (storeReadme !== null) {
    const at = extra.findIndex((f) => f.path === 'README.md');
    if (at >= 0) extra.splice(at, 1);
    extra.push({ path: 'README.md', mode: '100644', data: Buffer.from(storeReadme) });
  }
  if (!byPath.has('README.md') && !extra.some((f) => f.path === 'README.md')) { extra.push({ path: 'README.md', mode: '100644', data: Buffer.from(readmeFor(m.manifest)) }); generated.add('README.md'); }
  for (const f of extra) byPath.set(f.path, f);
  const all = [...byPath.values()];

  const terms = collectTerms(home, rec);
  const report = runGate(all, { mode, terms, approvals: new Set(opts.approvals ?? []), include: m.manifest.share.include, icon: m.manifest.icon ? rel(rec.root, m.manifest.icon) : null, sdk: sdkOrNull(), generated });
  // The repo name, the description and the commit message are published too.
  const repoName = opts.repoName ?? rec.publish?.fullName.split('/')[1] ?? `${m.manifest.slug}-app`;
  const META = '(repo name and message).txt';
  const meta = runGate([{ path: META, mode: '100644', data: Buffer.from(`${repoName}\n${m.manifest.name}\n${opts.note ?? ''}`) }], { mode, terms, approvals: new Set(opts.approvals ?? []), include: [META] });
  mergeMeta(report, meta);

  const sent = new Set(report.send.map((s) => s.path));
  const files = all.filter((f) => sent.has(f.path));
  files.push({ path: '.gitignore', mode: '100644', data: Buffer.from(GITIGNORE) });
  return { manifest: m.manifest, visibility: opts.visibility, mode, repoName, fullName: rec.publish?.fullName ?? null, license, files, report, digest: treeDigest(files), storeReadme, sourceReadme: src.files.find((f) => f.path === 'README.md')?.data ?? null };
}

function rel(root: string, abs: string): string {
  return abs.startsWith(root + '/') ? abs.slice(root.length + 1) : abs;
}

function sdkOrNull(): string | undefined {
  try { return sdkSource(); } catch { return undefined; }
}

function mergeMeta(report: GateReport, meta: GateReport): void {
  const content = (f: GateFinding) => f.rule !== 'never' && f.rule !== 'not-allowed' && f.rule !== 'no-manifest' && f.rule !== 'no-license' && f.rule !== 'no-readme';
  report.blocks.push(...meta.blocks.filter(content));
  report.approvable.push(...meta.approvable);
  report.unapproved.push(...meta.unapproved);
  report.ok = report.blocks.length === 0 && report.unapproved.length === 0;
}

// ─── The publish mirror and the history check ───────────────────────────────────────

/**
 * The one way to a NEW repo, named by every refusal that needs one (repo_changed,
 * foreign_history, history_not_clean, already_public): the same publish with `--fresh`, under
 * the grant of the owner's own Share click (a card's Onayla covers only the publish it showed).
 */
export const FRESH_HINT = 'Start a new repo with today\'s version only: the same publish with --fresh (dreamcontext apps publish <slug> --go --grant <id> --fresh; the default name is <slug>-public, --repo <name> picks another), under the grant of the owner\'s Share click on the app\'s page.';

export function publishMirror(home: string, rec: AppRecord): string {
  return join(appsHome(home), 'published', `${rec.hash}.git`);
}

function trailerOf(message: string): string | null {
  const m = new RegExp(`^${PUBLISH_TRAILER}: ([0-9a-f]{64})$`, 'm').exec(message);
  return m ? m[1] : null;
}

function filesAt(gitDir: string, ref: string): GateFile[] {
  return lsTree(gitDir, ref).filter((e) => e.type === 'blob' || e.type === 'commit').map((e) => ({ path: e.path, mode: e.mode, data: e.type === 'blob' ? readBlob(gitDir, e.sha) : Buffer.alloc(0) }));
}

/** Every commit on `ref` must carry a publish line that matches its files. */
export function checkPublishHistory(gitDir: string, ref: string, strictRescan?: { terms: GateTerms }): { ok: true } | { ok: false; code: string; message: string } {
  const shas = installedGit(gitDir, ['rev-list', ref]).split('\n').filter(Boolean);
  for (const sha of shas) {
    const msg = installedGit(gitDir, ['log', '-1', '--format=%B', sha]);
    const line = trailerOf(msg);
    const files = filesAt(gitDir, sha);
    if (!line || line !== treeDigest(files)) return { ok: false, code: 'foreign_history', message: `The published repo has a commit not made by a dreamcontext publish (${sha.slice(0, 7)}). ${FRESH_HINT}` };
    if (strictRescan) {
      const r = runGate(files.filter((f) => f.path !== '.gitignore'), { mode: 'strict', terms: strictRescan.terms, approvals: new Set() });
      if (r.blocks.length) return { ok: false, code: 'history_not_clean', message: `An earlier version (${sha.slice(0, 7)}) does not pass the public check, so this repo cannot go public. ${FRESH_HINT}` };
    }
  }
  return { ok: true };
}

// ─── Publish ────────────────────────────────────────────────────────────────────────

export interface PublishOptions {
  home: string;
  host: AppHost;
  visibility: Visibility;
  repoName?: string;
  invite?: string[];
  approvals?: string[];
  note?: string;
  /** The store page's one line (README `tagline:`). */
  tagline?: string;
  /** A public publish: the owner types the app's name (it is public forever). */
  confirmName?: string;
  /** The owner already confirmed a public publish another way (his "Share publicly" click). */
  confirmed?: boolean;
  /** Called the moment the push went out (the grant is spent there, whatever fails after). */
  onPushed?: (fullName: string) => void;
  /** Start a NEW repo (a public copy with today's version only). */
  fresh?: boolean;
  /** The README entry's date a request card stored (default today). */
  date?: string;
  /** A request card's bound tree: the files that go must still be exactly these (`stale_request`). */
  expectDigest?: string;
}

export interface PublishResult {
  fullName: string;
  sha: string;
  url: string;
  sent: number;
  invited: string[];
  inviteFailed: string[];
  /** The store README went back into the app folder (null: the publish did not change it). */
  readmeWrittenBack: boolean | null;
}

export async function publishApp(rec: AppRecord, opts: PublishOptions): Promise<PublishResult> {
  if (rec.origin === 'installed' && (rec.source || !rec.provenance)) throw new PublishError('not_yours', 'This app was installed from someone else. Make it your own copy first (it keeps where it came from for the licence check).');
  const user: HostUser = await opts.host.me();
  const pv = buildPublishTree(opts.home, rec, { visibility: opts.visibility, login: user.login, approvals: opts.approvals, note: opts.note, tagline: opts.tagline, date: opts.date, repoName: opts.fresh ? opts.repoName ?? `${rec.slug}-public` : opts.repoName });
  // Checked on the SAME preview that is pushed: what the owner approved is what goes.
  if (opts.expectDigest !== undefined && pv.digest !== opts.expectDigest) throw new PublishError('stale_request', 'The app changed since the owner approved this publish: nothing was sent. Ask again with the same command (--ask).');
  if (!pv.report.ok) throw new PublishError('gate_blocked', pv.report.blocks.length ? `${pv.report.blocks.length} problem(s) must be fixed before publishing.` : `${pv.report.unapproved.length} line(s) wait for your approval.`, pv.report);
  if (opts.visibility === 'public' && !opts.confirmed && (opts.confirmName ?? '').trim() !== pv.manifest.name) throw new PublishError('confirm_name', `A public app is public for good: type its name (${pv.manifest.name}) to publish.`);

  const host = opts.host;
  const prev = opts.fresh ? undefined : rec.publish;
  let repo = prev ? await host.getRepo(prev.fullName) : null;
  if (prev && (!repo || repo.repoId !== prev.repoId)) throw new PublishError('repo_changed', `The repo ${prev.fullName} is gone or is another repo now. ${FRESH_HINT}`);
  if (!repo) {
    try {
      repo = await host.createRepo(pv.repoName, { private: opts.visibility === 'private', description: cleanText(pv.manifest.name, 100) });
    } catch (e) {
      if (e instanceof HostError && e.code === 'exists') throw new PublishError('repo_exists', `${user.login}/${pv.repoName} already exists. Pick another repo name.`);
      throw e;
    }
    // Recorded at once: a push or an invite that fails after this is retried on the same repo.
    updateAppShare(opts.home, rec.projectRoot, rec.slug, { publish: { host: host.kind, fullName: repo.fullName, repoId: repo.repoId, public: !repo.private, lastSha: '', at: new Date().toISOString() } });
  }
  // Publishing "to invitees" onto a repo the world can read would be a public publish under
  // the private check: refused.
  if (!repo.private && opts.visibility === 'private') throw new PublishError('already_public', `${repo.fullName} is public: publish it as public (--public), or start a new private repo. ${FRESH_HINT}`);
  const fullName = repo.fullName;
  const url = host.cloneUrl(fullName);
  const turningPublic = opts.visibility === 'public' && repo.private;

  const mirror = opts.fresh ? join(appsHome(opts.home), 'published', `${rec.hash}-${Date.now()}.git`) : publishMirror(opts.home, rec);
  if (!existsSync(mirror)) { mkdirSync(join(mirror, '..'), { recursive: true, mode: 0o700 }); initHardRepo(mirror, true); }
  const gitOpts = { allowFile: host.allowFile };
  await host.withGit(async (env) => {
    const heads = (await installedGitAsync(mirror, ['ls-remote', '--heads', url, 'main'], { ...gitOpts, env, timeoutMs: 120_000 })).trim();
    if (heads) await installedGitAsync(mirror, ['fetch', '-q', '--no-tags', url, '+refs/heads/main:refs/heads/main'], { ...gitOpts, env, timeoutMs: 300_000 });
    else try { installedGit(mirror, ['update-ref', '-d', 'refs/heads/main']); } catch { /* none */ }
  });
  const parent = revParse(mirror, 'refs/heads/main');
  if (parent) {
    const h = checkPublishHistory(mirror, 'refs/heads/main', turningPublic ? { terms: collectTerms(opts.home, rec) } : undefined);
    if (!h.ok) throw new PublishError(h.code, h.message);
  }

  // One commit: the gated files, the noreply identity, UTC.
  const idx = mkdtempSync(join(tmpdir(), 'dc-publish-idx-'));
  let sha: string;
  try {
    const env = { GIT_INDEX_FILE: join(idx, 'index') };
    for (const f of pv.files) {
      const blob = installedGit(mirror, ['hash-object', '-w', '--stdin'], { input: f.data, env }).trim();
      installedGit(mirror, ['update-index', '--add', '--cacheinfo', `${f.mode === '100755' ? '100755' : '100644'},${blob},${f.path}`], { env });
    }
    const tree = installedGit(mirror, ['write-tree'], { env }).trim();
    const id = host.identity(user);
    const when = `${Math.floor(Date.now() / 1000)} +0000`;
    const subject = cleanText(opts.note ?? '', 200) || (parent ? 'Update' : 'First version');
    const message = `${subject}\n\n${PUBLISH_TRAILER}: ${pv.digest}\n`;
    sha = installedGit(mirror, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-F', '-'], {
      input: message,
      env: { ...env, GIT_AUTHOR_NAME: id.name, GIT_AUTHOR_EMAIL: id.email, GIT_AUTHOR_DATE: when, GIT_COMMITTER_NAME: id.name, GIT_COMMITTER_EMAIL: id.email, GIT_COMMITTER_DATE: when, TZ: 'UTC' },
    }).trim();
    installedGit(mirror, ['update-ref', 'refs/heads/main', sha]);
  } finally {
    rmSync(idx, { recursive: true, force: true });
  }
  await host.withGit((env) => installedGitAsync(mirror, ['push', '-q', url, 'refs/heads/main:refs/heads/main'], { ...gitOpts, env, timeoutMs: 300_000 }));
  opts.onPushed?.(fullName);
  updateAppShare(opts.home, rec.projectRoot, rec.slug, { publish: { host: host.kind, fullName, repoId: repo.repoId, public: opts.visibility === 'public', lastSha: sha, at: new Date().toISOString() } });

  const readmeWrittenBack = pv.storeReadme !== null ? writeBackStoreReadme(rec, pv.storeReadme, pv.sourceReadme) : null;

  await host.setTopics(fullName, [APP_TOPIC]);
  if (turningPublic) await host.setVisibility(fullName, true);
  // One invite that fails (a typo in a login) never undoes the publish: it is reported by name.
  const invited: string[] = [];
  const inviteFailed: string[] = [];
  if (opts.visibility === 'private') {
    for (const login of opts.invite ?? []) {
      const l = login.trim().replace(/^@/, '');
      if (!l || l === user.login) continue;
      try { await host.addCollaborator(fullName, l); invited.push(l); } catch { inviteFailed.push(l); }
    }
  }
  return { fullName, sha, url: host.kind === 'github' ? `https://github.com/${fullName}` : url, sent: pv.files.length, invited, inviteFailed, readmeWrittenBack };
}

/**
 * The README that went, back into the app folder, so the next publish starts from it (its
 * What's new keeps every entry). Only when the folder's README is still the one the publish read:
 * an edit the publisher has not committed is never overwritten. In the app's own git the one file
 * is committed; a copy of someone else's app has no git of its own, its folder is the source.
 */
export function writeBackStoreReadme(rec: Pick<AppRecord, 'root' | 'installId'>, text: string, read: Buffer | null): boolean {
  const path = join(rec.root, 'README.md');
  let now: Buffer | null = null;
  try {
    // lstat, never exists: a dangling link reads as absent to exists and would be written through.
    let st: ReturnType<typeof lstatSync> | null = null;
    try { st = lstatSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return false; }
    if (st && (!st.isFile() || st.isSymbolicLink())) return false;
    now = st ? readFileSync(path) : null;
    if (!(now === null ? read === null : read !== null && now.equals(read))) return false;
  } catch {
    return false;
  }
  try { writeFileSync(path, text, { flag: now === null ? 'wx' : 'w' }); } catch { return false; }
  if (rec.installId) return true;
  try {
    ownRepoGit(rec.root, ['add', '--', 'README.md']);
    const commit = (extra: string[]) => ownRepoGit(rec.root, ['-c', 'commit.gpgsign=false', ...extra, 'commit', '-q', '-m', 'Store page: README', '--', 'README.md']);
    try { commit([]); } catch { commit(['-c', 'user.name=dreamcontext', '-c', 'user.email=dreamcontext@users.noreply.github.com']); }
    return true;
  } catch {
    // The commit failed (a held index lock, say): put the folder back as the publish found it, so
    // the next publish is not refused for an uncommitted README nobody wrote by hand.
    try { ownRepoGit(rec.root, ['reset', '-q', '--', 'README.md']); } catch { /* not staged */ }
    try { if (now === null) rmSync(path, { force: true }); else writeFileSync(path, now); } catch { /* left as written */ }
    return false;
  }
}

/** The approval id of a finding, for tests and the CLI. */
export { findingId };

// ─── What the last publish sent, and what changed since (app-onay-karti D11, D12) ─────

/** The publish mirror holding `rec.publish.lastSha` (a fresh public publish has its own), or null. */
export function mirrorOfLastPublish(home: string, rec: AppRecord): string | null {
  const sha = rec.publish?.lastSha;
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) return null;
  const dir = join(appsHome(home), 'published');
  const candidates = [publishMirror(home, rec)];
  try { for (const f of readdirSync(dir)) if (f.startsWith(`${rec.hash}-`) && f.endsWith('.git')) candidates.push(join(dir, f)); } catch { /* none */ }
  for (const c of candidates) {
    if (!existsSync(c)) continue;
    try { if (installedGit(c, ['cat-file', '-t', sha]).trim() === 'commit') return c; } catch { /* not here */ }
  }
  return null;
}

/** The files of the last publish, by path (`.gitignore` left out), or null with no mirror. */
export function lastPublishedFiles(home: string, rec: AppRecord): Map<string, Buffer> | null {
  const mirror = mirrorOfLastPublish(home, rec);
  if (!mirror) return null;
  try {
    const out = new Map<string, Buffer>();
    for (const f of filesAt(mirror, rec.publish!.lastSha)) if (f.path !== '.gitignore') out.set(f.path, f.data);
    return out;
  } catch {
    return null;
  }
}

/** A generated LICENSE whose only change is the year is no new version. */
function sameButYear(a: Buffer, b: Buffer): boolean {
  const strip = (x: Buffer) => x.toString('utf-8').replace(/\b(19|20)\d{2}\b/g, 'YYYY');
  return strip(a) === strip(b);
}

/** Paths that differ between what would go now and what went last: `+ new`, `~ changed`, `- gone`. */
export function changedSincePublish(files: readonly GateFile[], last: Map<string, Buffer>): string[] {
  const now = new Map(files.filter((f) => f.path !== '.gitignore').map((f) => [f.path, f.data]));
  const out: string[] = [];
  for (const [path, data] of now) {
    const prev = last.get(path);
    if (!prev) out.push(`+ ${path}`);
    else if (!prev.equals(data) && !(path === 'LICENSE' && sameButYear(prev, data))) out.push(`~ ${path}`);
  }
  for (const path of last.keys()) if (!now.has(path)) out.push(`- ${path}`);
  return out.sort((a, b) => a.slice(2).localeCompare(b.slice(2)));
}

/** The published account's login, from the repo it went to (no network). */
export function publishLogin(rec: Pick<AppRecord, 'publish'>): string {
  return rec.publish?.fullName.split('/')[0] || 'the-publisher';
}

const unpublishedCache = new Map<string, { key: string; lastSha: string; value: boolean }>();

/** The cache key of `unpublishedChanges`: the source's HEAD (a copy: its tree as it is) and the last publish. */
function sourceKey(rec: AppRecord): string | null {
  try {
    if (rec.installId) {
      const st = lstatSync(rec.root);
      return `copy:${st.mtimeMs}:${Math.floor(Date.now() / 30_000)}`;
    }
    return (ownRepoGit(rec.root, ['rev-parse', '--verify', 'HEAD^{commit}']) as string).trim();
  } catch {
    return null;
  }
}

/** Not an own published app (or no source to read): nothing to publish, and nothing to compute. */
function unpublishedKey(rec: AppRecord): string | null {
  if (!rec.publish?.lastSha || (rec.origin === 'installed' && (rec.source || !rec.provenance))) return null;
  const head = sourceKey(rec);
  return head ? `${head}\0${rec.publish.lastSha}` : null;
}

/**
 * Does this own published app hold a version not published yet (D11)? A dry preview with no note
 * and no tagline, compared path by path with the last publish's tree. Derived from facts, no
 * record: an app published before this change answers too, and right after a publish it is false
 * (the README written back is the one that went). No mirror, uncommitted changes, a manifest
 * problem: false, never an error. Cached by the source's HEAD and the last publish's sha.
 */
export function unpublishedChanges(home: string, rec: AppRecord): boolean {
  const key = unpublishedKey(rec);
  if (!key) return false;
  const hit = unpublishedCache.get(rec.hash);
  if (hit && hit.key === key) return hit.value;
  let value = false;
  try {
    const last = lastPublishedFiles(home, rec);
    if (last) {
      const pv = buildPublishTree(home, rec, { visibility: rec.publish!.public ? 'public' : 'private', login: publishLogin(rec) });
      value = changedSincePublish(pv.files, last).length > 0;
    }
  } catch {
    value = false;
  }
  unpublishedCache.set(rec.hash, { key, lastSha: rec.publish!.lastSha!, value });
  return value;
}

/**
 * The list's hot path: the cached answer, never a computation. `fresh: false` = recompute it off
 * the request. Until then the last answer for the SAME publish stands (stale while revalidating),
 * so the band does not blink out on every new commit or a copy's 30 s bucket; a new publish has no
 * last answer and reads as nothing to publish (right after a publish there is none).
 */
export function unpublishedCached(rec: AppRecord): { value: boolean; fresh: boolean } {
  const key = unpublishedKey(rec);
  if (!key) return { value: false, fresh: true };
  const hit = unpublishedCache.get(rec.hash);
  if (hit && hit.key === key) return { value: hit.value, fresh: true };
  return { value: !!hit && hit.lastSha === rec.publish!.lastSha && hit.value, fresh: false };
}

/** Tests only. */
export function resetUnpublishedCache(): void { unpublishedCache.clear(); }

/**
 * "Ne değişti" of an update publish when the agent wrote no note (D12): the README's top What's
 * new entry when the last publish did not carry it (a draft; used as is, never added twice), else
 * the commit subjects since the last publish. `draft` true = the README already says it.
 */
export function defaultPublishNote(rec: AppRecord, sourceReadme: Buffer | null, last: Map<string, Buffer> | null): { text: string; draft: boolean } | null {
  const cur = parseStoreReadme(sourceReadme?.toString('utf-8') ?? '', { full: true }).whatsNew[0];
  if (cur && cur.notes.length) {
    const before = parseStoreReadme(last?.get('README.md')?.toString('utf-8') ?? '', { full: true }).whatsNew;
    const same = before.some((e) => e.version === cur.version && e.notes.join('\n') === cur.notes.join('\n'));
    if (!same) return { text: cleanText(cur.notes.join('; '), 300), draft: true };
  }
  if (rec.installId || !rec.publish?.at) return null;
  try {
    const subjects = (ownRepoGit(rec.root, ['log', `--since=${rec.publish.at}`, '--format=%s', '-n', '20', 'HEAD']) as string)
      .split('\n').map((x) => cleanText(x, 120)).filter((x) => x && x !== 'Store page: README');
    return subjects.length ? { text: cleanText(subjects.join('; '), 300), draft: false } : null;
  } catch {
    return null;
  }
}
