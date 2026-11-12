import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { updateSetupConfig } from '../../src/lib/setup-config.js';
import { hostFileSizeNote, hostFileSizeRefusal, runBrainSync, type SyncEngineDeps, type SyncOptions, type SyncResult } from '../../src/lib/git-sync/sync-engine.js';
import * as gitLib from '../../src/lib/git-sync/git.js';
import { registerApp, type AppRecord } from '../../src/lib/apps/registry.js';
import { ensureAppDataDir, ensureAppsPrivacy } from '../../src/lib/apps/data-dir.js';
import { ensureFullRepoGitignore } from '../../src/lib/git-sync/brain-repo.js';
import { applyConsentPatch } from '../../src/lib/apps/data-consent.js';
import { addConflict, appPullHeld, listConflicts, listKeptOut, readPullRecord, resolveConflict, writePullRecord } from '../../src/lib/apps/data-conflicts.js';
import { addTombstone, approveDeletes, listTombstones } from '../../src/lib/apps/data-deletes.js';
import { listBackups } from '../../src/lib/apps/data-backup.js';
import { appDataPushRefusals, incomingAppDataRefusals } from '../../src/lib/apps/data-stage.js';
import {
  applyPullRuleForInstall, finishAppPull, largeSharedApps, recoverAppPulls, restoreTeamFiles, stageOutbound, type ExchangeCtx,
} from '../../src/lib/apps/data-exchange.js';
import { listInboxRows } from '../../src/lib/owner-inbox.js';
import type { DataDecl } from '../../src/lib/apps/data-share.js';

/**
 * app-veri-ortak plan r6, criteria 3 to 9 (git side), with REAL git: a bare remote, two clones,
 * a temp HOME each, `full-repo` + cloud sync on. The server's pause is injected (no server in a
 * unit test). Each lettered case is its own `it`.
 */

let base: string;
let bare: string;
const ORIGINAL = { HOME: process.env.HOME, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8', env: gitEnv });
/**
 * A blob of `data` in the repo's object store. The payload goes through a file in the test's
 * scratch dir, never git's stdin: a multi-MB `input` pipe can leave `hash-object --stdin` blocked
 * in read() forever.
 */
let blobSeq = 0;
const blob = (cwd: string, data: string | Buffer) => {
  const file = join(base, `.blob-${process.pid}-${++blobSeq}`);
  writeFileSync(file, data);
  try {
    return execFileSync('git', ['hash-object', '-w', '--no-filters', '--', file], { cwd, encoding: 'utf-8', env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } finally { rmSync(file, { force: true }); }
};
const SQLITE = Buffer.concat([Buffer.from('SQLite format 3\0', 'latin1'), Buffer.alloc(64)]);
const MB = 1024 * 1024;

const RAKIP: DataDecl = {
  shared: [{ path: 'favorites/', why: 'Ekibin seçtiği reklamlar ve notlar' }, { path: 'notes/', why: 'Ekibin notları' }],
  local: [{ path: 'cache/', why: 'Meta, Google, TikTok\'tan Yenile ile çekilir' }],
};

interface Vault { name: string; root: string; ctx: string; home: string; top: string }
interface App { rec: AppRecord; data: string; decl: DataDecl | null }

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'dc-xchg-')));
  bare = join(base, 'team.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', bare);
  process.env.GITHUB_TOKEN = 'unit-dummy-token';
});
afterEach(() => {
  if (ORIGINAL.HOME === undefined) delete process.env.HOME; else process.env.HOME = ORIGINAL.HOME;
  if (ORIGINAL.GITHUB_TOKEN === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = ORIGINAL.GITHUB_TOKEN;
  rmSync(base, { recursive: true, force: true });
});

function homeFor(name: string): string {
  const h = join(base, `home-${name}`);
  mkdirSync(join(h, '.dreamcontext'), { recursive: true });
  return h;
}

function identity(cwd: string): void {
  git(cwd, 'config', 'user.email', 't@example.com');
  git(cwd, 'config', 'user.name', 't');
}

/** A: the first project, one commit pushed. */
function vaultA(opts: { mode?: 'full-repo' | 'in-tree'; at?: string; projectSub?: string } = {}): Vault {
  const top = opts.at ?? join(base, 'a');
  mkdirSync(top, { recursive: true });
  git(top, 'init', '-q', '-b', 'main');
  identity(top);
  const root = opts.projectSub ? join(top, opts.projectSub) : top;
  mkdirSync(join(root, '_dream_context', 'knowledge'), { recursive: true });
  mkdirSync(join(root, '_dream_context', 'state'), { recursive: true });
  writeFileSync(join(root, '_dream_context', 'knowledge', 'k.md'), '# base\n\n## Section\nbase line\n');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'app.ts'), 'one\ntwo\nthree\n');
  updateSetupConfig(root, { brainRepo: { mode: opts.mode ?? 'full-repo', enabled: true, autoSync: true } });
  // What a first sync and a first app would write, committed up front: a clone then starts clean,
  // so a pull is a fast-forward unless a test makes it otherwise.
  if ((opts.mode ?? 'full-repo') === 'full-repo') ensureFullRepoGitignore(root);
  ensureAppsPrivacy(join(root, '_dream_context'));
  git(top, 'add', '-A');
  git(top, 'commit', '-q', '-m', 'init');
  if ((opts.mode ?? 'full-repo') === 'full-repo') {
    git(top, 'remote', 'add', 'origin', bare);
    git(top, 'push', '-q', 'origin', 'main');
    git(top, 'fetch', '-q', 'origin');
  }
  return { name: 'a', root, ctx: join(root, '_dream_context'), home: homeFor(opts.at ? 'n' : 'a'), top };
}

/** B: a clone of the team remote. */
function vaultB(name = 'b'): Vault {
  const root = join(base, name);
  git(base, 'clone', '-q', bare, root);
  identity(root);
  updateSetupConfig(root, { brainRepo: { mode: 'full-repo', enabled: true, autoSync: true } });
  return { name, root, ctx: join(root, '_dream_context'), home: homeFor(name), top: root };
}

/** Register an app in `v` with a manifest declaring `decl` (null = no `data`), approve `approve`. */
function install(v: Vault, decl: DataDecl | null = RAKIP, approve: string[] = ['favorites/', 'notes/'], slug = 'rakip'): App {
  const root = join(base, `${v.name}-code`, slug);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'dreamcontext-app.json'), JSON.stringify({ slug, name: 'Rakip İstihbaratı', ...(decl ? { data: decl } : {}) }));
  const rec = registerApp(v.home, { projectRoot: v.root, vault: v.name, slug, name: 'Rakip İstihbaratı', root });
  const data = ensureAppDataDir(v.root, slug);
  if (decl && approve.length) {
    const r = applyConsentPatch(v.home, rec.hash, decl, { approve });
    if (!r.ok) throw new Error(r.error);
  }
  return { rec, data, decl };
}

/** Write a file settled (mtime a minute back: past the 3 s "writing" window). */
function put(dir: string, rel: string, data: string | Buffer, settled = true): string {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, data);
  if (settled) { const t = new Date(Date.now() - 60_000); utimesSync(abs, t, t); }
  return abs;
}
const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf-8') : null);

const xctx = (v: Vault): ExchangeCtx => ({ gitCwd: v.root, contextRoot: v.ctx, projectRoot: v.root, home: v.home });

async function withHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const was = process.env.HOME;
  process.env.HOME = home;
  try { return await fn(); } finally { process.env.HOME = was; }
}

const calls = { pause: [] as string[], resume: [] as string[] };
function sync(v: Vault, opts: Partial<SyncOptions> = {}, deps: Partial<SyncEngineDeps> = {}): Promise<SyncResult> {
  return withHome(v.home, () => runBrainSync({ cwd: v.ctx, mode: 'auto', foreground: true, home: v.home, ...opts }, {
    pauseForSync: async (slug: string) => { calls.pause.push(slug); return 'no_server'; },
    resumeAfterSync: async (slug: string) => { calls.resume.push(slug); return true; },
    readGlobalGitHubLogin: () => null,
    ...deps,
  }));
}

/** The team remote's tree (paths). */
const remoteTree = () => git(bare, 'ls-tree', '-r', '--name-only', 'main').split('\n').filter(Boolean);
const remoteFile = (p: string) => { try { return git(bare, 'show', `main:${p}`); } catch { return null; } };
const indexed = (v: Vault, spec = '_dream_context/apps') => git(v.top, 'ls-files', '--', spec).split('\n').filter(Boolean);
const mergeOpen = (v: Vault) => gitLib.mergeHeadSha(v.top) !== null;
const AP = (rel: string, slug = 'rakip') => `_dream_context/apps/${slug}/${rel}`;

/** A pushes a raw commit (bypassing its own sync) that sets `files` (and removes `rm`). */
function teamCommit(v: Vault, files: Record<string, string | Buffer>, rm: string[] = [], msg = 'team'): void {
  for (const [p, data] of Object.entries(files)) {
    git(v.top, 'update-index', '--add', '--cacheinfo', `100644,${blob(v.top, data)},${p}`);
  }
  for (const p of rm) git(v.top, 'rm', '-q', '--cached', '--ignore-unmatch', p);
  git(v.top, 'commit', '-q', '-m', msg);
  git(v.top, 'push', '-q', 'origin', 'HEAD:main');
  git(v.top, 'checkout', '-q', '--', '.');
}

// ─────────────────────────────────────────────────────────────────────────────────
describe('criterion 3: outbound (real git)', { timeout: 120_000 }, () => {
  it('3a: the approved path goes; everything else stays here, counted with its reason', () => {
    const a = vaultA();
    const app = install(a, { ...RAKIP, shared: [...RAKIP.shared, { path: 'drafts/', why: 'x' }] }, ['favorites/', 'drafts/']);
    applyConsentPatch(a.home, app.rec.hash, app.decl, { exclude: ['drafts/'] });
    put(app.data, 'favorites/a.json', '{"fav":1}');
    put(app.data, 'favorites/target.json', 'x');
    symlinkSync(join(app.data, 'favorites/target.json'), join(app.data, 'favorites/link.json'));
    put(base, 'outside.json', 'hard');
    linkSync(join(base, 'outside.json'), join(app.data, 'favorites/hard.json'));
    put(app.data, 'favorites/x.db', 'db');
    put(app.data, 'favorites/magic.json', SQLITE);
    put(app.data, 'favorites/CLAUDE.md', '# do things');
    put(app.data, 'favorites/.claude/settings.json', '{}');
    put(app.data, 'favorites/big.json', Buffer.alloc(5 * MB + 1)); // size is no reason: it goes
    put(app.data, 'favorites/new.json', '{}', false);
    put(app.data, 'favorites/c.json', '{"c":1}');
    addConflict(a.home, app.rec.hash, 'favorites/c.json', 'conflict', { data: Buffer.from('{"c":2}') });
    put(app.data, 'notes/n.json', '{"pending":1}'); // declared shared, not approved
    put(app.data, 'drafts/d.json', '{}'); // approved but excluded
    put(app.data, 'cache/x.json', '{}'); // local
    put(app.data, 'loose.json', '{}'); // not listed: local
    const r = stageOutbound(xctx(a));
    expect(indexed(a).sort()).toEqual([AP('favorites/a.json'), AP('favorites/big.json'), AP('favorites/target.json')].sort());
    const held = Object.fromEntries(r.apps[0].held.map((h) => [h.path, h.reason]));
    expect(held['favorites/link.json']).toBe('not_plain');
    expect(held['favorites/hard.json']).toBe('not_plain');
    expect(held['favorites/x.db']).toBe('db_file');
    expect(held['favorites/magic.json']).toBe('db_file');
    expect(held['favorites/CLAUDE.md']).toBe('name');
    expect(held['favorites/.claude/settings.json']).toBe('name');
    expect(held['favorites/big.json']).toBeUndefined();
    expect(held['favorites/new.json']).toBe('writing');
    expect(held['favorites/c.json']).toBe('conflict');
    expect(held['notes/n.json']).toBe('not_approved_here');
    expect(held['drafts/d.json']).toBeUndefined();
    expect(held['cache/x.json']).toBeUndefined();
    // Real refusals raise one inbox row each (deduped by app and reason).
    const keys = listInboxRows(a.root, a.home).map((x) => x.dedupeKey);
    expect(keys).toEqual(expect.arrayContaining(['app-data:rakip:not_plain', 'app-data:rakip:db_file', 'app-data:rakip:name']));
    expect(keys).not.toContain('app-data:rakip:too_big');
    expect(keys).not.toContain('app-data:rakip:writing');
  });

  it('3b: a declared-shared path the owner has not approved is held not_approved_here', () => {
    const a = vaultA();
    const app = install(a, RAKIP, ['favorites/']);
    put(app.data, 'notes/n.json', '{}');
    const r = stageOutbound(xctx(a));
    expect(r.apps[0].held).toContainEqual({ path: 'notes/n.json', reason: 'not_approved_here' });
    expect(indexed(a)).toEqual([]);
  });

  it('3c: no app or brain total holds anything back: 27 MB in one app and 112 MB in the brain all go', () => {
    const a = vaultA();
    const big = Buffer.alloc(Math.floor(4.5 * MB));
    const apps = ['ra', 'rb', 'rc', 'rd', 're'].map((slug) => install(a, RAKIP, ['favorites/'], slug));
    for (const app of apps) for (let i = 0; i < 5; i++) put(app.data, `favorites/${i}.bin`, big); // 22.5 MB each
    put(apps[0].data, 'favorites/5.bin', big); // the first app: 27 MB
    const r = stageOutbound(xctx(a), { dryRun: true });
    for (const x of r.apps) expect(x.held, x.slug).toEqual([]);
    expect(r.add).toHaveLength(26);
    expect(largeSharedApps(xctx(a)).map((x) => x.slug)).toEqual(['ra']); // over 25 MB: the warning only
  });

  it('3d: a Mac without the app syncs and nothing is deleted; a tracked shared file missing from disk is no delete either', async () => {
    const a = vaultA();
    const app = install(a);
    put(app.data, 'favorites/a.json', '{"fav":1}');
    expect((await sync(a)).action).toBe('pushed');
    expect(remoteTree()).toContain(AP('favorites/a.json'));
    const b = vaultB();
    expect(read(join(b.ctx, 'apps/rakip/favorites/a.json'))).toBe('{"fav":1}');
    rmSync(join(b.ctx, 'apps/rakip/favorites/a.json'));
    writeFileSync(join(b.ctx, 'knowledge', 'b.md'), '# b\n');
    expect((await sync(b)).action).toBe('pushed');
    expect(remoteTree()).toContain(AP('favorites/a.json'));
    // The owner's own Mac: absence is not a delete.
    rmSync(join(app.data, 'favorites/a.json'));
    writeFileSync(join(a.ctx, 'knowledge', 'a2.md'), '# a2\n');
    expect((await sync(a)).action).toBe('pushed');
    expect(remoteTree()).toContain(AP('favorites/a.json'));
  });

  it('3e: an excluded tracked path\'s change does not go, and the general stage leaves its index entry as it was', async () => {
    const a = vaultA();
    const app = install(a);
    put(app.data, 'favorites/a.json', '{"v":1}');
    expect((await sync(a)).action).toBe('pushed');
    const before = git(a.top, 'ls-files', '-s', '--', AP('favorites/a.json'));
    applyConsentPatch(a.home, app.rec.hash, app.decl, { exclude: ['favorites/a.json'] });
    put(app.data, 'favorites/a.json', '{"v":2}');
    writeFileSync(join(a.ctx, 'knowledge', 'x.md'), '# x\n');
    expect((await sync(a)).action).toBe('pushed');
    expect(remoteFile(AP('favorites/a.json'))).toBe('{"v":1}');
    expect(git(a.top, 'ls-files', '-s', '--', AP('favorites/a.json'))).toBe(before);
    expect(read(join(app.data, 'favorites/a.json'))).toBe('{"v":2}');
  });

  it('3f: a nested `!*` .gitignore in the data folder adds nothing', async () => {
    const a = vaultA();
    const app = install(a);
    put(app.data, '.gitignore', '!*\n');
    put(app.data, 'cache/x.json', '{}');
    put(app.data, 'favorites/a.json', '{}');
    expect((await sync(a)).action).toBe('pushed');
    const t = remoteTree().filter((p) => p.includes('/apps/'));
    expect(t).toEqual([AP('favorites/a.json')]);
  });

  it('3g: an in-tree brain with an approved declaration commits nothing under apps/', async () => {
    const a = vaultA({ mode: 'in-tree' });
    const app = install(a);
    put(app.data, 'favorites/a.json', '{}');
    writeFileSync(join(a.ctx, 'knowledge', 'x.md'), '# x\n');
    const r = await sync(a);
    expect(r.action).toBe('skipped-in-tree');
    expect(git(a.top, 'ls-tree', '-r', '--name-only', 'HEAD')).not.toContain('/apps/');
    expect(stageOutbound(xctx(a)).add).toEqual([]);
  });

  it('3g-2: an in-tree brain: a file force-added by hand is taken out of the index; the in-tree commit has no apps/ path', async () => {
    const a = vaultA({ mode: 'in-tree' });
    const app = install(a);
    put(app.data, 'favorites/a.json', '{"private":1}');
    git(a.top, 'add', '-f', AP('favorites/a.json'));
    git(a.top, 'add', '-A', '--force', '_dream_context/apps');
    writeFileSync(join(a.ctx, 'knowledge', 'x.md'), '# x\n');
    expect((await sync(a)).action).toBe('skipped-in-tree');
    expect(git(a.top, 'ls-tree', '-r', '--name-only', 'HEAD')).not.toContain('/apps/');
    expect(indexed(a)).toEqual([]);
    expect(read(join(app.data, 'favorites/a.json'))).toBe('{"private":1}'); // the file stays on disk
    expect(listInboxRows(a.root, a.home).map((x) => x.dedupeKey)).toContain('app-data:rakip:staged_by_hand');
  });

  it('3h: nested under the brain git root (project in a subfolder of its repo), the same rule holds', async () => {
    const a = vaultA({ at: join(base, 'mono'), projectSub: 'pkg' });
    const app = install(a);
    put(app.data, 'favorites/a.json', '{}');
    put(app.data, 'cache/x.json', '{}');
    expect((await sync(a)).action).toBe('pushed');
    const t = remoteTree();
    expect(t).toContain('pkg/_dream_context/apps/rakip/favorites/a.json');
    expect(t.some((p) => p.includes('cache/'))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────
describe('criterion 4: dirtyPaths', { timeout: 120_000 }, () => {
  it('4a: a clean vault whose only change is an approved shared file syncs (the first share starts the sync)', async () => {
    const a = vaultA();
    const app = install(a);
    // vaultA commits the ignore lines up front: the vault is clean (nothing to send yet).
    expect((await sync(a)).action).toBe('noop');
    put(app.data, 'favorites/a.json', '{"v":1}');
    expect((await sync(a)).action).toBe('pushed');
    expect(remoteFile(AP('favorites/a.json'))).toBe('{"v":1}');
  });

  it('4b: a held, missing or unapproved tracked file never makes the tree dirty', async () => {
    const a = vaultA();
    const app = install(a);
    put(app.data, 'favorites/a.json', '{"v":1}');
    put(app.data, 'favorites/gone.json', '{}');
    expect((await sync(a)).action).toBe('pushed');
    applyConsentPatch(a.home, app.rec.hash, app.decl, { exclude: ['favorites/a.json'] });
    put(app.data, 'favorites/a.json', '{"v":2}'); // tracked, excluded now
    rmSync(join(app.data, 'favorites/gone.json')); // tracked, missing
    put(app.data, 'favorites/x.db', 'db'); // held
    put(app.data, 'favorites/fresh.json', '{}', false); // writing
    put(app.data, 'cache/c.json', '{}'); // local
    expect((await sync(a)).action).toBe('noop');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────
describe('criterion 5: the push gate (back door)', { timeout: 120_000 }, () => {
  const refusals = (v: Vault) => appDataPushRefusals(v.root, v.ctx, 'origin/main', { home: v.home });

  it('5a: a hand-committed unapproved path, a symlink blob, a DB blob, a delete with no tombstone: app_data_held; a blob over 5 MB is no reason', async () => {
    const a = vaultA();
    const app = install(a, RAKIP, ['favorites/']);
    put(app.data, 'favorites/keep.json', '{}');
    expect((await sync(a)).action).toBe('pushed');
    git(a.top, 'update-index', '--add', '--cacheinfo', `100644,${blob(a.top, '{}')},${AP('notes/n.json')}`);
    git(a.top, 'update-index', '--add', '--cacheinfo', `120000,${blob(a.top, '/etc/passwd')},${AP('favorites/l.json')}`);
    git(a.top, 'update-index', '--add', '--cacheinfo', `100644,${blob(a.top, SQLITE)},${AP('favorites/m.json')}`);
    git(a.top, 'update-index', '--add', '--cacheinfo', `100644,${blob(a.top, Buffer.alloc(5 * MB + 1))},${AP('favorites/big.json')}`);
    git(a.top, 'rm', '-q', '--cached', AP('favorites/keep.json'));
    git(a.top, 'commit', '-q', '-m', 'by hand');
    const rules = Object.fromEntries(refusals(a).map((r) => [r.path, r.rule]));
    expect(rules[AP('notes/n.json')]).toBe('not_shared_here');
    expect(rules[AP('favorites/l.json')]).toBe('not_plain');
    expect(rules[AP('favorites/m.json')]).toBe('db_file');
    expect(rules[AP('favorites/big.json')]).toBeUndefined(); // hand-committed but approved: the size alone holds nothing
    expect(rules[AP('favorites/keep.json')]).toBe('delete_without_tombstone');
    const r = await sync(a);
    expect(r.action).toBe('app-data-held');
    expect(r.note).toContain('app_data_held');
  });

  it('5b: a delete WITH a tombstone passes', async () => {
    const a = vaultA();
    const app = install(a, RAKIP, ['favorites/']);
    put(app.data, 'favorites/keep.json', '{}');
    expect((await sync(a)).action).toBe('pushed');
    git(a.top, 'rm', '-q', '--cached', AP('favorites/keep.json'));
    git(a.top, 'commit', '-q', '-m', 'by hand');
    addTombstone(a.home, app.rec.hash, 'favorites/keep.json');
    expect(refusals(a)).toEqual([]);
  });

  it('5c: added in a middle commit and deleted in the next is still held', async () => {
    const a = vaultA();
    install(a, RAKIP, ['favorites/']);
    git(a.top, 'update-index', '--add', '--cacheinfo', `100644,${blob(a.top, '{}')},${AP('cache/c.json')}`);
    git(a.top, 'commit', '-q', '-m', 'oops');
    git(a.top, 'rm', '-q', '--cached', AP('cache/c.json'));
    git(a.top, 'commit', '-q', '-m', 'undo');
    expect(refusals(a).map((r) => r.path)).toContain(AP('cache/c.json'));
  });

  it('5d: a path that arrives only in a merge resolution is held; a teammate\'s file that came in through the merge is not', async () => {
    const a = vaultA();
    install(a, RAKIP, []); // A approves nothing
    const b = vaultB();
    const bApp = install(b);
    put(bApp.data, 'favorites/t.json', '{"team":1}');
    expect((await sync(b)).action).toBe('pushed');
    // A merges the team's update by hand (a real merge: A has its own commit) and slips in data.
    writeFileSync(join(a.ctx, 'knowledge', 'own.md'), '# own\n');
    git(a.top, 'add', '-A'); git(a.top, 'commit', '-q', '-m', 'own');
    git(a.top, 'fetch', '-q', 'origin');
    git(a.top, 'merge', '-q', '--no-ff', '--no-commit', 'origin/main');
    git(a.top, 'update-index', '--add', '--cacheinfo', `100644,${blob(a.top, '{}')},${AP('cache/slipped.json')}`);
    git(a.top, 'commit', '-q', '-m', 'merge');
    const paths = refusals(a).map((r) => r.path);
    expect(paths).toContain(AP('cache/slipped.json'));
    expect(paths).not.toContain(AP('favorites/t.json'));
  });

  it('5e: a shared path committed and then taken out of the shared set before the push is held, and the note names the repair', async () => {
    const a = vaultA();
    const app = install(a, RAKIP, ['favorites/']);
    put(app.data, 'favorites/a.json', '{}');
    stageOutbound(xctx(a));
    git(a.top, 'commit', '-q', '-m', 'shared, not pushed');
    applyConsentPatch(a.home, app.rec.hash, app.decl, { exclude: ['favorites/a.json'] });
    const r = await sync(a, { mode: 'push-only' });
    expect(r.action).toBe('app-data-held');
    expect(r.note).toContain('git rm --cached');
    expect(r.note).toContain(AP('favorites/a.json'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────────
describe('criterion 6: the pull gate', { timeout: 120_000 }, () => {
  async function refusedBy(files: Record<string, string | Buffer>, mode = '100644'): Promise<string[]> {
    const a = vaultA();
    const b = vaultB();
    for (const [p, data] of Object.entries(files)) git(a.top, 'update-index', '--add', '--cacheinfo', `${mode},${blob(a.top, data)},${p}`);
    git(a.top, 'commit', '-q', '-m', 'bad'); git(a.top, 'push', '-q', 'origin', 'main');
    git(b.top, 'fetch', '-q', 'origin');
    return (incomingAppDataRefusals(b.root, b.ctx, 'origin/main') ?? ['<null>']).map((r) => (typeof r === 'string' ? r : `${r.path} ${r.rule}`));
  }

  it('6a: a symlink, a gitlink, a file where apps/ or apps/<slug> is, a dotted part, an instruction name, a DB; never a file over 5 MB', async () => {
    expect(await refusedBy({ [AP('favorites/l')]: '/etc' }, '120000')).toEqual([`${AP('favorites/l')} not_plain`]);
    rmSync(base, { recursive: true, force: true }); mkdirSync(base, { recursive: true }); git(base, 'init', '-q', '--bare', '-b', 'main', bare);
    const all = await refusedBy({
      '_dream_context/apps/x': 'file',
      [AP('favorites/.env')]: 'K=v',
      [AP('favorites/CLAUDE.md')]: '# hi',
      [AP('favorites/x.sqlite')]: 'db',
      [AP('favorites/m.json')]: SQLITE,
      [AP('favorites/big.json')]: Buffer.alloc(5 * MB + 1),
    });
    expect(all).toEqual(expect.arrayContaining([
      '_dream_context/apps/x not_folder',
      `${AP('favorites/.env')} name`,
      `${AP('favorites/CLAUDE.md')} name`,
      `${AP('favorites/x.sqlite')} db_file`,
      `${AP('favorites/m.json')} db_file`,
    ]));
    expect(all.some((x) => x.startsWith(AP('favorites/big.json')))).toBe(false);
  });

  it('6b: a gitlink and a letter-case twin', async () => {
    const a = vaultA();
    teamCommit(a, { [AP('favorites/A.json')]: '{}' });
    const b = vaultB();
    git(a.top, 'update-index', '--add', '--cacheinfo', `160000,${git(a.top, 'rev-parse', 'HEAD').trim()},${AP('favorites/sub')}`);
    git(a.top, 'update-index', '--add', '--cacheinfo', `100644,${blob(a.top, '{"twin":1}')},${AP('favorites/a.json')}`);
    git(a.top, 'commit', '-q', '-m', 'odd'); git(a.top, 'push', '-q', 'origin', 'main');
    git(b.top, 'fetch', '-q', 'origin');
    const rules = (incomingAppDataRefusals(b.root, b.ctx, 'origin/main') ?? []).map((r) => `${r.path} ${r.rule}`);
    expect(rules).toEqual(expect.arrayContaining([`${AP('favorites/sub')} not_plain`, `${AP('favorites/a.json')} case`]));
  });

  it('6c: two Macs each under 25 MB for one app push more together; every pull still goes through, all of it lands, and the app gets the LARGE warning', async () => {
    const a = vaultA();
    const aApp = install(a);
    for (let i = 0; i < 4; i++) put(aApp.data, `favorites/a${i}.bin`, Buffer.alloc(Math.floor(4.5 * MB), i)); // 18 MB
    expect((await sync(a)).action).toBe('pushed');
    const b = vaultB();
    const bApp = install(b);
    for (let i = 0; i < 4; i++) put(bApp.data, `favorites/b${i}.bin`, Buffer.alloc(Math.floor(4.5 * MB), 10 + i)); // 18 more
    const rb = await sync(b);
    expect(rb.action).toBe('pushed');
    expect(rb.appData?.large.map((x) => x.slug)).toEqual(['rakip']); // 36 MB for the team: warned, sent
    // A third Mac with nothing of the app, and A itself, both pull the whole 36 MB.
    const c = vaultB('c');
    expect(existsSync(join(c.ctx, 'apps/rakip/favorites/b3.bin'))).toBe(true);
    const ra = await sync(a, { mode: 'pull-only', foreground: true });
    expect(ra.action).toBe('pulled');
    expect(ra.note ?? '').not.toContain('over_cap');
    for (let i = 0; i < 4; i++) expect(readFileSync(join(aApp.data, `favorites/b${i}.bin`)).length).toBe(Math.floor(4.5 * MB));
    // An over-64 MB file (past the old in-memory read) goes and lands the same way.
    put(aApp.data, 'favorites/huge.bin', Buffer.alloc(70 * MB, 7));
    expect((await sync(a)).action).toBe('pushed');
    expect((await sync(b, { mode: 'pull-only', foreground: true })).action).toBe('pulled');
    expect(lstatSync(join(bApp.data, 'favorites/huge.bin')).size).toBe(70 * MB);
  });

  it('6d: a team file on a path this Mac calls local does not land in the data folder; it goes to the conflict store and is never sent back', async () => {
    const a = vaultA();
    const b = vaultB();
    const bApp = install(b, { shared: [{ path: 'notes/', why: 'x' }], local: [{ path: 'favorites/', why: 'mine only' }] }, ['notes/']);
    teamCommit(a, { [AP('favorites/t.json')]: '{"team":1}' });
    const r = await sync(b);
    expect(['pushed', 'pulled']).toContain(r.action);
    expect(existsSync(join(bApp.data, 'favorites/t.json'))).toBe(false);
    expect(listConflicts(b.home, bApp.rec.hash)).toEqual([expect.objectContaining({ path: 'favorites/t.json', kind: 'local_path' })]);
    expect(remoteFile(AP('favorites/t.json'))).toBe('{"team":1}');
    expect((await sync(b)).action).toBe('noop'); // the file taken off disk is no change to send
    expect(remoteFile(AP('favorites/t.json'))).toBe('{"team":1}');
  });

  it('6d-2: mine is what this disk held, never HEAD\'s blob: two team commits and a team delete on a `local` path leave the disk empty throughout', async () => {
    const a = vaultA();
    const b = vaultB();
    const bApp = install(b, { shared: [{ path: 'notes/', why: 'x' }], local: [{ path: 'favorites/', why: 'mine only' }] }, ['notes/']);
    const t = join(bApp.data, 'favorites/t.json');
    teamCommit(a, { [AP('favorites/t.json')]: '{"team":1}' });
    await sync(b);
    expect(read(t)).toBeNull();
    teamCommit(a, { [AP('favorites/t.json')]: '{"team":2}' });
    await sync(b);
    expect(read(t)).toBeNull(); // HEAD^1 held the team's v1: never written back as "mine"
    teamCommit(a, {}, [AP('favorites/t.json')], 'team delete');
    await sync(b);
    expect(read(t)).toBeNull();
    expect(appPullHeld(b.home, bApp.rec.hash)).toBe(false);
  });

  it('6d-3: an aborted merge does not bring the team\'s copy back on a `local` path that had no file here', async () => {
    const a = vaultA();
    const b = vaultB();
    const bApp = install(b, { shared: [{ path: 'notes/', why: 'x' }], local: [{ path: 'favorites/', why: 'mine only' }] }, ['notes/']);
    const t = join(bApp.data, 'favorites/t.json');
    teamCommit(a, { [AP('favorites/t.json')]: '{"team":1}' });
    await sync(b);
    expect(read(t)).toBeNull();
    teamCommit(a, { [AP('favorites/t.json')]: '{"team":2}', '_dream_context/knowledge/k.md': '# base\n\n## Section\nA wrote this.\n' });
    writeFileSync(join(b.ctx, 'knowledge', 'k.md'), '# base\n\n## Section\nB wrote this.\n');
    const r = await sync(b, { mode: 'pull-only', foreground: false });
    expect(r.action).toBe('awaiting-agent');
    expect(mergeOpen(b)).toBe(false);
    expect(read(t)).toBeNull(); // `merge --abort` wrote HEAD's (the team's v1) copy: taken away again
  });

  it('6e: an app with no declaration on this Mac takes nothing in either', async () => {
    const a = vaultA();
    const b = vaultB();
    const bApp = install(b, null, []);
    teamCommit(a, { [AP('favorites/t.json')]: '{"team":1}' });
    await sync(b);
    expect(existsSync(join(bApp.data, 'favorites/t.json'))).toBe(false);
    expect(listConflicts(b.home, bApp.rec.hash).map((c) => c.path)).toEqual(['favorites/t.json']);
    // B1: the app's manifest gets its `data` field and the owner approves: the next sync brings
    // the team's file shared before the approval onto this disk.
    writeFileSync(join(bApp.rec.root, 'dreamcontext-app.json'), JSON.stringify({ slug: 'rakip', name: 'Rakip İstihbaratı', data: RAKIP }));
    const ok = applyConsentPatch(b.home, bApp.rec.hash, RAKIP, { approve: ['favorites/'] });
    expect(ok.ok).toBe(true);
    const r = await sync(b);
    expect(read(join(bApp.data, 'favorites/t.json'))).toBe('{"team":1}');
    expect(r.appData?.restored).toEqual([{ slug: 'rakip', paths: ['favorites/t.json'] }]);
    expect(git(b.top, 'status', '--porcelain', '--', '_dream_context/apps')).toBe(''); // HEAD's copy: nothing to send
    expect((await sync(b)).appData?.restored ?? []).toEqual([]); // once only
  });

  it('6e-2 (B1): "Keep it local" first, Share later: every team file shared before comes to this disk; mine, deleted, unapproved and conflicted paths stay as they are', async () => {
    const a = vaultA();
    const b = vaultB();
    const bApp = install(b, RAKIP, []);
    applyConsentPatch(b.home, bApp.rec.hash, RAKIP, { decline: true });
    teamCommit(a, {
      [AP('favorites/t1.json')]: '{"team":1}', [AP('favorites/t2.json')]: '{"team":2}',
      [AP('favorites/mine.json')]: '{"team":"m"}', [AP('favorites/gone.json')]: '{"team":"g"}',
      [AP('favorites/two.json')]: '{"team":"two"}', [AP('notes/n.json')]: '{"team":"n"}',
    });
    await sync(b);
    for (const p of ['favorites/t1.json', 'favorites/t2.json', 'notes/n.json']) expect(existsSync(join(bApp.data, p)), p).toBe(false);
    // On this Mac meanwhile: its own copy of one path, a delete the app made, a two-version file.
    put(bApp.data, 'favorites/mine.json', '{"mine":1}', false);
    addTombstone(b.home, bApp.rec.hash, 'favorites/gone.json');
    addConflict(b.home, bApp.rec.hash, 'favorites/two.json', 'conflict', { data: Buffer.from('{"team":"two"}') });
    // "Ask me again" + Share, favorites/ only (notes/ stays unapproved).
    expect(applyConsentPatch(b.home, bApp.rec.hash, RAKIP, { decline: false, approve: ['favorites/'] }).ok).toBe(true);
    const back = restoreTeamFiles(xctx(b)); // what the Share click runs
    expect(back).toEqual([{ slug: 'rakip', paths: ['favorites/t1.json', 'favorites/t2.json'], twoVersions: ['favorites/mine.json'] }]);
    expect(read(join(bApp.data, 'favorites/t1.json'))).toBe('{"team":1}');
    expect(read(join(bApp.data, 'favorites/t2.json'))).toBe('{"team":2}');
    expect(read(join(bApp.data, 'favorites/mine.json'))).toBe('{"mine":1}'); // never overwritten
    expect(existsSync(join(bApp.data, 'favorites/gone.json'))).toBe(false); // a delete stays a delete
    expect(existsSync(join(bApp.data, 'favorites/two.json'))).toBe(false); // the human picks
    expect(existsSync(join(bApp.data, 'notes/n.json'))).toBe(false); // not approved here: the app deletes it with fs, that stays
    expect(listInboxRows(b.root, b.home).map((x) => x.dedupeKey)).toEqual(expect.arrayContaining(['app-data:rakip:restored', 'app-data:rakip:two_versions']));
    // The stored team copy of a path now on disk byte for byte is gone; mine.json waits as two versions.
    const kinds = Object.fromEntries(listConflicts(b.home, bApp.rec.hash).map((c) => [c.path, c.kind]));
    expect(kinds['favorites/t1.json']).toBeUndefined();
    expect(kinds['favorites/mine.json']).toBe('conflict');
    // The following sync never sends mine over the team's: held as two versions, the team keeps its copy.
    await sync(b);
    expect(remoteFile(AP('favorites/mine.json'))).toBe('{"team":"m"}');
    expect(read(join(bApp.data, 'favorites/mine.json'))).toBe('{"mine":1}');
    expect(stageOutbound(xctx(b), { dryRun: true }).apps.find((x) => x.slug === 'rakip')?.held).toEqual(expect.arrayContaining([{ path: 'favorites/mine.json', reason: 'conflict' }]));
    // The owner picks the team's: it is in place and nothing of mine went.
    expect(resolveConflict(b.home, bApp.rec.hash, bApp.data, 'favorites/mine.json', 'theirs').ok).toBe(true);
    expect(read(join(bApp.data, 'favorites/mine.json'))).toBe('{"team":"m"}');
  });

  it('6e-4 (B1): the sync brings the team\'s files back BEFORE it stages, so a late yes never sends mine over the team\'s', async () => {
    const a = vaultA();
    const b = vaultB();
    const bApp = install(b, RAKIP, []);
    applyConsentPatch(b.home, bApp.rec.hash, RAKIP, { decline: true });
    teamCommit(a, { [AP('favorites/board.json')]: '{"team":"board"}', [AP('favorites/t.json')]: '{"team":1}' });
    await sync(b);
    put(bApp.data, 'favorites/board.json', '{"mine":"board"}'); // the app made its own default while local
    expect(applyConsentPatch(b.home, bApp.rec.hash, RAKIP, { decline: false, approve: ['favorites/'] }).ok).toBe(true);
    const r = await sync(b); // no Share-click restore ran: the sync itself must hold it
    expect(r.appData?.restored).toEqual([{ slug: 'rakip', paths: ['favorites/t.json'], twoVersions: ['favorites/board.json'] }]);
    expect(remoteFile(AP('favorites/board.json'))).toBe('{"team":"board"}');
    expect(read(join(bApp.data, 'favorites/board.json'))).toBe('{"mine":"board"}');
    expect(read(join(bApp.data, 'favorites/t.json'))).toBe('{"team":1}');
  });

  it('6e-6 (B1): 21 newer team copies never push the marked copy of board.json out; mine waits as two versions', async () => {
    const a = vaultA();
    const b = vaultB();
    const bApp = install(b, RAKIP, []);
    applyConsentPatch(b.home, bApp.rec.hash, RAKIP, { decline: true });
    teamCommit(a, { [AP('favorites/board.json')]: '{"team":"board"}' });
    await sync(b);
    put(bApp.data, 'favorites/board.json', '{"mine":"board"}');
    // 21 more team files: loose copies are trimmed to 20, but board.json's is marked and stays.
    const cards: Record<string, string> = {};
    for (let i = 0; i < 21; i++) cards[AP(`favorites/c${String(i).padStart(2, '0')}.json`)] = `{"card":${i}}`;
    teamCommit(a, cards, [], 'cards');
    await sync(b);
    expect(listConflicts(b.home, bApp.rec.hash).map((c) => c.path)).toContain('favorites/board.json'); // marked: no count drops it
    expect(listKeptOut(b.home, bApp.rec.hash).has('favorites/board.json')).toBe(true);
    // Even before any restore, the shared set never sends a kept-out path.
    expect(applyConsentPatch(b.home, bApp.rec.hash, RAKIP, { decline: false, approve: ['favorites/'] }).ok).toBe(true);
    expect(stageOutbound(xctx(b), { dryRun: true }).apps.find((x) => x.slug === 'rakip')?.held).toEqual(expect.arrayContaining([{ path: 'favorites/board.json', reason: 'conflict' }]));
    const r = await sync(b);
    expect(r.appData?.restored?.[0]?.twoVersions).toEqual(['favorites/board.json']);
    expect(remoteFile(AP('favorites/board.json'))).toBe('{"team":"board"}');
    expect(read(join(bApp.data, 'favorites/board.json'))).toBe('{"mine":"board"}');
    expect(listConflicts(b.home, bApp.rec.hash).find((c) => c.path === 'favorites/board.json')?.kind).toBe('conflict');
    expect(listKeptOut(b.home, bApp.rec.hash).size).toBe(0); // every card came back, board.json is held as a conflict
    // The owner keeps mine: from then on it is an ordinary edit and goes.
    expect(resolveConflict(b.home, bApp.rec.hash, bApp.data, 'favorites/board.json', 'mine').ok).toBe(true);
    await sync(b);
    expect(remoteFile(AP('favorites/board.json'))).toBe('{"mine":"board"}');
  });

  it('6e-7 (B1): more than 20 own files differ at the late yes: every one waits as two versions, none goes over the team\'s, later store entries drop none', async () => {
    const a = vaultA();
    const b = vaultB();
    const bApp = install(b, { shared: [{ path: 'favorites/', why: 'x' }, { path: 'notes/', why: 'y' }], local: [] }, []);
    applyConsentPatch(b.home, bApp.rec.hash, { shared: [{ path: 'favorites/', why: 'x' }, { path: 'notes/', why: 'y' }], local: [] }, { decline: true });
    const team: Record<string, string> = {};
    for (let i = 0; i < 21; i++) team[AP(`favorites/d${String(i).padStart(2, '0')}.json`)] = `{"team":${i}}`;
    teamCommit(a, team);
    await sync(b);
    for (let i = 0; i < 21; i++) put(bApp.data, `favorites/d${String(i).padStart(2, '0')}.json`, `{"mine":${i}}`);
    const decl = { shared: [{ path: 'favorites/', why: 'x' }, { path: 'notes/', why: 'y' }], local: [] };
    expect(applyConsentPatch(b.home, bApp.rec.hash, decl, { decline: false, approve: ['favorites/'] }).ok).toBe(true);
    await sync(b);
    // 25 later copies of a part B still does not share (notes/, unapproved but declared: those land) and
    // of a part it never declared: store entries that once pushed the oldest out.
    const later: Record<string, string> = {};
    for (let i = 0; i < 25; i++) later[AP(`other/x${i}.json`)] = `{"x":${i}}`;
    teamCommit(a, later, [], 'later');
    await sync(b);
    await sync(b);
    for (let i = 0; i < 21; i++) {
      const rel = `favorites/d${String(i).padStart(2, '0')}.json`;
      expect(remoteFile(AP(rel)), rel).toBe(`{"team":${i}}`);
      expect(read(join(bApp.data, rel)), rel).toBe(`{"mine":${i}}`);
    }
    const kinds = listConflicts(b.home, bApp.rec.hash).filter((c) => c.kind === 'conflict').map((c) => c.path);
    expect(kinds).toHaveLength(21);
  });

  it('6e-5 (B1): the Share click brings back at most the inline budget; more waits for the sync, and a file the app wrote first is never replaced', async () => {
    const a = vaultA();
    const b = vaultB();
    const bApp = install(b, RAKIP, []);
    applyConsentPatch(b.home, bApp.rec.hash, RAKIP, { decline: true });
    teamCommit(a, { [AP('favorites/big.bin')]: Buffer.alloc(2048, 1), [AP('favorites/t.json')]: '{"team":1}' });
    await sync(b);
    applyConsentPatch(b.home, bApp.rec.hash, RAKIP, { decline: false, approve: ['favorites/'] });
    expect(restoreTeamFiles(xctx(b), { maxBytes: 1024 })).toEqual([{ slug: 'rakip', paths: [], deferred: true }]);
    expect(existsSync(join(bApp.data, 'favorites/t.json'))).toBe(false);
    expect(restoreTeamFiles(xctx(b))).toEqual([{ slug: 'rakip', paths: ['favorites/big.bin', 'favorites/t.json'] }]);
    expect(lstatSync(join(bApp.data, 'favorites/big.bin')).size).toBe(2048);
  });

  it('6e-3 (B1): nothing comes back during an open merge, with sync off, or through a link in the data folder', async () => {
    const a = vaultA();
    const b = vaultB();
    const bApp = install(b, RAKIP, []);
    applyConsentPatch(b.home, bApp.rec.hash, RAKIP, { decline: true });
    teamCommit(a, { [AP('favorites/x/t.json')]: '{"team":1}' });
    await sync(b);
    applyConsentPatch(b.home, bApp.rec.hash, RAKIP, { decline: false, approve: ['favorites/'] });
    expect(restoreTeamFiles({ ...xctx(b), mode: { fullRepo: true, cloudSyncOn: false } })).toEqual([]);
    // A link where a folder of the path goes: never followed.
    mkdirSync(join(base, 'elsewhere'), { recursive: true });
    rmSync(join(bApp.data, 'favorites/x'), { recursive: true, force: true }); // the empty folder the pull left
    mkdirSync(join(bApp.data, 'favorites'), { recursive: true });
    symlinkSync(join(base, 'elsewhere'), join(bApp.data, 'favorites/x'));
    expect(restoreTeamFiles(xctx(b))).toEqual([]);
    expect(existsSync(join(base, 'elsewhere/t.json'))).toBe(false);
    rmSync(join(bApp.data, 'favorites/x'));
    writePullRecord(b.home, { v: 1, hash: bApp.rec.hash, slug: 'rakip', preHead: null, mergeHead: null, phase: 'parked', parked: [], plan: null, at: new Date().toISOString() });
    expect(restoreTeamFiles(xctx(b))).toEqual([]); // an app's pull is open
  });
});

// ─────────────────────────────────────────────────────────────────────────────────
describe('criterion 7: deletes', { timeout: 120_000 }, () => {
  it('7a: after the app removes a file (tombstone), the delete goes; the stone stays until the delete reached the remote', async () => {
    const a = vaultA();
    const app = install(a);
    put(app.data, 'favorites/a.json', '{}');
    expect((await sync(a)).action).toBe('pushed');
    rmSync(join(app.data, 'favorites/a.json'));
    addTombstone(a.home, app.rec.hash, 'favorites/a.json');
    const staged = stageOutbound(xctx(a));
    expect(staged.remove).toEqual([AP('favorites/a.json')]);
    git(a.top, 'commit', '-q', '-m', 'delete, not pushed');
    expect(listTombstones(a.home, app.rec.hash).map((t) => t.path)).toEqual(['favorites/a.json']);
    expect((await sync(a)).action).toBe('pushed');
    expect(remoteTree()).not.toContain(AP('favorites/a.json'));
    expect(listTombstones(a.home, app.rec.hash)).toEqual([]);
  });

  it('7b: a stone for a path this Mac does not share sends nothing', async () => {
    const a = vaultA();
    const app = install(a);
    put(app.data, 'favorites/a.json', '{}');
    expect((await sync(a)).action).toBe('pushed');
    applyConsentPatch(a.home, app.rec.hash, app.decl, { exclude: ['favorites/a.json'] });
    rmSync(join(app.data, 'favorites/a.json'));
    addTombstone(a.home, app.rec.hash, 'favorites/a.json');
    expect(stageOutbound(xctx(a)).remove).toEqual([]);
  });

  it('7c: 21 deletes in one sync: none goes, the owner is asked; once approved all 21 go and clear after the push; later stones follow the cap again', async () => {
    const a = vaultA();
    const app = install(a);
    for (let i = 0; i < 42; i++) put(app.data, `favorites/${i}.json`, `{"i":${i}}`);
    expect((await sync(a)).action).toBe('pushed');
    for (let i = 0; i < 21; i++) { rmSync(join(app.data, `favorites/${i}.json`)); addTombstone(a.home, app.rec.hash, `favorites/${i}.json`); }
    const r = stageOutbound(xctx(a), { dryRun: true });
    expect(r.remove).toEqual([]);
    expect(r.apps[0].deletesAsked).toBe(true);
    expect(await sync(a)).toMatchObject({ action: 'noop' }); // the held deletes make no change to send
    const row = listInboxRows(a.root, a.home).find((x) => x.dedupeKey === 'app-data:rakip:too_many_deletes');
    // The row names the LIST command (it prints the exact `--approve <N> --confirm` line) and the
    // sync's own waiting count; a bare `--approve --confirm` would fail on the count it needs.
    expect(row?.title).toContain('(dreamcontext apps data deletes rakip)');
    expect(row?.title).not.toContain('--approve');
    expect(row?.title).toContain('21 deletes are waiting');
    expect(remoteTree()).toContain(AP('favorites/0.json'));
    // The owner's answer.
    // The approval names the count shown; a stale one is refused and approves nothing.
    expect(approveDeletes(a.home, app.rec.hash, 20)).toEqual({ ok: false, reason: 'changed', waiting: 21 });
    expect(approveDeletes(a.home, app.rec.hash, 21)).toEqual({ ok: true, approved: 21 });
    // A later batch, unapproved, follows the cap again: it waits while the approved ones go.
    for (let i = 21; i < 42; i++) { rmSync(join(app.data, `favorites/${i}.json`)); addTombstone(a.home, app.rec.hash, `favorites/${i}.json`); }
    expect((await sync(a)).action).toBe('pushed');
    const t = remoteTree();
    for (let i = 0; i < 21; i++) expect(t).not.toContain(AP(`favorites/${i}.json`));
    for (let i = 21; i < 42; i++) expect(t).toContain(AP(`favorites/${i}.json`));
    expect(listTombstones(a.home, app.rec.hash).map((x) => x.path).sort()).toEqual(Array.from({ length: 21 }, (_, i) => `favorites/${i + 21}.json`).sort());
  });

  it('7d: on the other side the data is backed up first (before-team-pull), then the delete lands', async () => {
    const a = vaultA();
    const app = install(a);
    put(app.data, 'favorites/a.json', '{}');
    put(app.data, 'favorites/b.json', '{}');
    expect((await sync(a)).action).toBe('pushed');
    const b = vaultB();
    const bApp = install(b);
    rmSync(join(app.data, 'favorites/a.json'));
    addTombstone(a.home, app.rec.hash, 'favorites/a.json');
    expect((await sync(a)).action).toBe('pushed');
    await sync(b);
    expect(listBackups(b.home, bApp.rec.hash).map((x) => x.reason)).toContain('before-team-pull');
    expect(existsSync(join(bApp.data, 'favorites/a.json'))).toBe(false);
    expect(existsSync(join(bApp.data, 'favorites/b.json'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────
describe('criterion 8: conflicts and merges', { timeout: 120_000 }, () => {
  /** A and B both have the app, both approved, a.json on both. */
  async function pair(): Promise<{ a: Vault; b: Vault; aApp: App; bApp: App }> {
    const a = vaultA();
    const aApp = install(a);
    put(aApp.data, 'favorites/a.json', '{"v":"base"}');
    expect((await sync(a)).action).toBe('pushed');
    const b = vaultB();
    const bApp = install(b);
    return { a, b, aApp, bApp };
  }

  it('8a: both change the same file: the second to sync keeps its own, the team\'s waits in the store, the path is held `conflict`; resolve --theirs puts the team\'s in place', async () => {
    const { a, b, aApp, bApp } = await pair();
    put(aApp.data, 'favorites/a.json', '{"v":"A"}');
    expect((await sync(a)).action).toBe('pushed');
    put(bApp.data, 'favorites/a.json', '{"v":"B"}');
    expect((await sync(b)).action).toBe('pushed');
    expect(read(join(bApp.data, 'favorites/a.json'))).toBe('{"v":"B"}');
    expect(remoteFile(AP('favorites/a.json'))).toBe('{"v":"A"}'); // B's never went over A's
    expect(listConflicts(b.home, bApp.rec.hash)).toEqual([expect.objectContaining({ path: 'favorites/a.json', kind: 'conflict' })]);
    expect((await sync(b)).action).toBe('noop'); // conflict: not sent
    // A hand commit putting mine over the team's copy on the conflict path is held by the gate.
    git(b.top, 'add', '-f', AP('favorites/a.json'));
    git(b.top, 'commit', '-q', '-m', 'mine over theirs');
    expect(appDataPushRefusals(b.root, b.ctx, 'origin/main', { home: b.home })).toContainEqual({ path: AP('favorites/a.json'), rule: 'conflict' });
    git(b.top, 'reset', '-q', '--soft', 'HEAD~1');
    git(b.top, 'reset', '-q', '--', AP('favorites/a.json'));
    expect(resolveConflict(b.home, bApp.rec.hash, bApp.data, 'favorites/a.json', 'theirs')).toEqual({ ok: true });
    expect(read(join(bApp.data, 'favorites/a.json'))).toBe('{"v":"A"}');
  });

  it('8b: JSON is never text-merged; the attribute line is written even where the app was never opened', async () => {
    const a = vaultA();
    const b = vaultB(); // no app here, ever
    teamCommit(a, { [AP('favorites/a.json')]: '{\n"x": 1,\n"y": 1\n}\n' });
    await sync(b);
    const attrs = readFileSync(join(b.top, '.git', 'info', 'attributes'), 'utf-8');
    expect(attrs).toContain('/_dream_context/apps/** -merge -diff');
  });

  it('8c: modify/delete: the side that was not deleted enters the index', async () => {
    const { a, b, aApp, bApp } = await pair();
    rmSync(join(aApp.data, 'favorites/a.json'));
    addTombstone(a.home, aApp.rec.hash, 'favorites/a.json');
    expect((await sync(a)).action).toBe('pushed');
    put(bApp.data, 'favorites/a.json', '{"v":"B"}');
    expect((await sync(b)).action).toBe('pushed');
    expect(git(b.top, 'ls-tree', '--name-only', 'HEAD', '--', AP('favorites/a.json')).trim()).toBe(AP('favorites/a.json'));
    expect(read(join(bApp.data, 'favorites/a.json'))).toBe('{"v":"B"}');
  });

  it('8d: add/add: the local file is not overwritten and, not approved here, never sent', async () => {
    const a = vaultA();
    const aApp = install(a);
    expect((await sync(a)).action).toBe('noop'); // a clean vault: vaultA committed the ignore lines
    const b = vaultB();
    const bApp = install(b, RAKIP, []); // B has approved nothing yet
    put(bApp.data, 'favorites/x.json', '{"mine":"B"}');
    put(aApp.data, 'favorites/x.json', '{"team":"A"}');
    expect((await sync(a)).action).toBe('pushed');
    await sync(b);
    expect(read(join(bApp.data, 'favorites/x.json'))).toBe('{"mine":"B"}');
    expect(remoteFile(AP('favorites/x.json'))).toBe('{"team":"A"}');
    expect(listConflicts(b.home, bApp.rec.hash).map((c) => c.path)).toEqual(['favorites/x.json']);
  });

  it('8e: an excluded tracked path changed here while the team changes it: the pull completes, mine in place, theirs stored, nothing sent', async () => {
    const { a, b, aApp, bApp } = await pair();
    applyConsentPatch(b.home, bApp.rec.hash, bApp.decl, { exclude: ['favorites/a.json'] });
    put(bApp.data, 'favorites/a.json', '{"v":"B-local"}');
    put(aApp.data, 'favorites/a.json', '{"v":"A"}');
    expect((await sync(a)).action).toBe('pushed');
    const r = await sync(b);
    expect(r.action).toBe('pushed');
    expect(git(b.top, 'rev-parse', 'HEAD').trim()).toBe(git(bare, 'rev-parse', 'main').trim());
    expect(read(join(bApp.data, 'favorites/a.json'))).toBe('{"v":"B-local"}');
    expect(listConflicts(b.home, bApp.rec.hash)).toEqual([expect.objectContaining({ path: 'favorites/a.json', kind: 'local_path' })]);
    expect(remoteFile(AP('favorites/a.json'))).toBe('{"v":"A"}');
  });

  it('8f: on a Mac without the app a deferred prose merge ends with --continue; the merge commit carries the team\'s app change and the teammate\'s next pull deletes nothing', async () => {
    const a = vaultA();
    const aApp = install(a);
    put(aApp.data, 'favorites/a.json', '{"v":1}');
    expect((await sync(a)).action).toBe('pushed');
    const b = vaultB();
    put(aApp.data, 'favorites/a.json', '{"v":2}');
    put(aApp.data, 'favorites/n.json', '{"new":1}');
    writeFileSync(join(a.ctx, 'knowledge', 'k.md'), '# base\n\n## Section\nA wrote this.\n');
    expect((await sync(a)).action).toBe('pushed');
    writeFileSync(join(b.ctx, 'knowledge', 'k.md'), '# base\n\n## Section\nB wrote this.\n');
    expect((await sync(b)).action).toBe('awaiting-agent');
    writeFileSync(join(b.ctx, 'knowledge', 'k.md'), '# base\n\n## Section\nA wrote this. B wrote this.\n');
    git(b.top, 'add', '_dream_context/knowledge/k.md');
    expect((await sync(b, { continue: true })).action).toBe('pushed');
    expect(remoteFile(AP('favorites/a.json'))).toBe('{"v":2}');
    expect(remoteFile(AP('favorites/n.json'))).toBe('{"new":1}');
    await sync(a);
    expect(read(join(aApp.data, 'favorites/a.json'))).toBe('{"v":2}');
    expect(read(join(aApp.data, 'favorites/n.json'))).toBe('{"new":1}');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────
describe('criterion 9: pause and the merge life cycle (git side)', { timeout: 120_000 }, () => {
  beforeEach(() => { calls.pause = []; calls.resume = []; });

  async function pair(): Promise<{ a: Vault; b: Vault; aApp: App; bApp: App }> {
    const a = vaultA();
    const aApp = install(a);
    put(aApp.data, 'favorites/a.json', '{"v":"base"}');
    expect((await sync(a)).action).toBe('pushed');
    const b = vaultB();
    const bApp = install(b);
    return { a, b, aApp, bApp };
  }
  /** B keeps a local, unsent change on a path the team is about to change (it gets parked). */
  function bLocalChange(b: Vault, bApp: App): void {
    applyConsentPatch(b.home, bApp.rec.hash, bApp.decl, { exclude: ['favorites/a.json'] });
    put(bApp.data, 'favorites/a.json', '{"v":"B-mine"}');
  }

  it('9a: the running backend is paused before the merge and resumed after; no answer in time skips the pull with nothing changed; no server lets it go on', async () => {
    const { a, b, aApp, bApp } = await pair();
    put(aApp.data, 'favorites/a.json', '{"v":"A"}');
    expect((await sync(a)).action).toBe('pushed');
    const skipped = await sync(b, {}, { pauseForSync: async () => 'unknown' });
    expect(skipped.action).toBe('noop');
    expect(skipped.note).toContain('could not be paused');
    expect(appPullHeld(b.home, bApp.rec.hash)).toBe(false);
    expect(git(b.top, 'show', `HEAD:${AP('favorites/a.json')}`)).toBe('{"v":"base"}');
    expect(read(join(bApp.data, 'favorites/a.json'))).toBe('{"v":"base"}');
    let heldDuringPause = false;
    const r = await sync(b, {}, {
      pauseForSync: async (slug) => { calls.pause.push(slug); heldDuringPause = appPullHeld(b.home, bApp.rec.hash); return 'stopped'; },
    });
    expect(r.action).toBe('pushed');
    expect(heldDuringPause).toBe(true); // the record exists before the pause: the backend cannot restart
    expect(calls.pause).toEqual(['rakip']);
    expect(calls.resume).toEqual(['rakip']);
    expect(appPullHeld(b.home, bApp.rec.hash)).toBe(false);
    expect(read(join(bApp.data, 'favorites/a.json'))).toBe('{"v":"A"}');
  });

  it('9b: a background pull with a prose conflict (abortOnDefer) and a parked app file: the merge aborts clean, no MERGE_HEAD, mine on disk', async () => {
    const { a, b, aApp, bApp } = await pair();
    bLocalChange(b, bApp);
    put(aApp.data, 'favorites/a.json', '{"v":"A"}');
    writeFileSync(join(a.ctx, 'knowledge', 'k.md'), '# base\n\n## Section\nA wrote this.\n');
    expect((await sync(a)).action).toBe('pushed');
    writeFileSync(join(b.ctx, 'knowledge', 'k.md'), '# base\n\n## Section\nB wrote this.\n');
    const r = await sync(b, { mode: 'pull-only', foreground: false });
    expect(r.action).toBe('awaiting-agent');
    expect(mergeOpen(b)).toBe(false);
    expect(read(join(bApp.data, 'favorites/a.json'))).toBe('{"v":"B-mine"}');
    expect(appPullHeld(b.home, bApp.rec.hash)).toBe(false);
  });

  it('9c: the same with a scrub block and with a headless code conflict', async () => {
    const { a, b, bApp } = await pair();
    bLocalChange(b, bApp);
    writeFileSync(join(b.ctx, 'knowledge', 'own.md'), '# own\n');
    git(b.top, 'add', '_dream_context/knowledge/own.md'); git(b.top, 'commit', '-q', '-m', 'own'); // a real merge, not a fast-forward
    teamCommit(a, { [AP('favorites/a.json')]: `{"token":"ghp_${'a'.repeat(36)}"}` });
    const r = await sync(b, { mode: 'pull-only', foreground: false });
    expect(r.action).toBe('blocked-scrub');
    expect(mergeOpen(b)).toBe(false);
    expect(read(join(bApp.data, 'favorites/a.json'))).toBe('{"v":"B-mine"}');
    expect(appPullHeld(b.home, bApp.rec.hash)).toBe(false);

    // A code conflict with no human watching aborts too.
    teamCommit(a, { 'src/app.ts': 'one\nTEAM\nthree\n', [AP('favorites/a.json')]: '{"v":"A2"}' });
    writeFileSync(join(b.root, 'src', 'app.ts'), 'one\nMINE\nthree\n');
    git(b.top, 'add', 'src/app.ts'); git(b.top, 'commit', '-q', '-m', 'mine');
    const r2 = await sync(b, { mode: 'pull-only', foreground: false });
    expect(r2.action).toBe('code-conflict');
    expect(mergeOpen(b)).toBe(false);
    expect(read(join(bApp.data, 'favorites/a.json'))).toBe('{"v":"B-mine"}');
    expect(appPullHeld(b.home, bApp.rec.hash)).toBe(false);
  });

  it('9d-1: killed between the merge and its commit: the next start recognises our own merge, aborts it, puts the park back; nothing lost', async () => {
    const { a, b, aApp, bApp } = await pair();
    bLocalChange(b, bApp);
    writeFileSync(join(b.ctx, 'knowledge', 'own.md'), '# own\n');
    git(b.top, 'add', '_dream_context/knowledge/own.md'); git(b.top, 'commit', '-q', '-m', 'own');
    put(aApp.data, 'favorites/a.json', '{"v":"A"}');
    expect((await sync(a)).action).toBe('pushed');
    const crashing = { ...gitLib, attemptMerge: (cwd: string, ref: string) => { gitLib.attemptMerge(cwd, ref); throw new Error('simulated crash'); } } as typeof gitLib;
    await expect(sync(b, {}, { git: crashing })).rejects.toThrow('simulated crash');
    expect(mergeOpen(b)).toBe(true);
    expect(readPullRecord(b.home, bApp.rec.hash)).toMatchObject({ ok: true, rec: { phase: 'merged' } });
    const rec = withHomeSync(b.home, () => recoverAppPulls(xctx(b)));
    expect(rec.skipped).toBeNull();
    expect(rec.recovered).toEqual(['rakip']);
    expect(mergeOpen(b)).toBe(false);
    expect(read(join(bApp.data, 'favorites/a.json'))).toBe('{"v":"B-mine"}');
    expect(appPullHeld(b.home, bApp.rec.hash)).toBe(false);
  });

  it('9d-2: killed after the commit: the next sync applies the plan; nothing lost', async () => {
    const { a, b, aApp, bApp } = await pair();
    bLocalChange(b, bApp);
    put(aApp.data, 'favorites/a.json', '{"v":"A"}');
    expect((await sync(a)).action).toBe('pushed');
    const noFinish = () => ({ finished: [], notes: [] });
    await sync(b, {}, { finishAppPulls: noFinish });
    expect(readPullRecord(b.home, bApp.rec.hash)).toMatchObject({ ok: true, rec: { phase: 'merged' } });
    expect(mergeOpen(b)).toBe(false);
    await sync(b);
    expect(appPullHeld(b.home, bApp.rec.hash)).toBe(false);
    expect(read(join(bApp.data, 'favorites/a.json'))).toBe('{"v":"B-mine"}');
    expect(listConflicts(b.home, bApp.rec.hash).map((c) => c.path)).toEqual(['favorites/a.json']);
  });

  it('9d-3: the user\'s own open merge is never touched', async () => {
    const { a, b, aApp } = await pair();
    put(aApp.data, 'favorites/a.json', '{"v":"A"}');
    writeFileSync(join(a.ctx, 'knowledge', 'k.md'), '# base\n\n## Section\nA\n');
    expect((await sync(a)).action).toBe('pushed');
    writeFileSync(join(b.ctx, 'knowledge', 'own.md'), '# own\n');
    git(b.top, 'add', '-A'); git(b.top, 'commit', '-q', '-m', 'own');
    git(b.top, 'fetch', '-q', 'origin');
    git(b.top, 'merge', '-q', '--no-ff', '--no-commit', 'origin/main');
    const mh = gitLib.mergeHeadSha(b.top);
    const r = await sync(b);
    expect(r.action).toBe('user-merge-in-progress');
    expect(gitLib.mergeHeadSha(b.top)).toBe(mh);
  });

  it('9d-4: while A is held between attemptMerge and the commit, another sync or a server start returns locked and touches nothing', async () => {
    const { a, b, aApp, bApp } = await pair();
    bLocalChange(b, bApp);
    writeFileSync(join(b.ctx, 'knowledge', 'own.md'), '# own\n');
    git(b.top, 'add', '_dream_context/knowledge/own.md'); git(b.top, 'commit', '-q', '-m', 'own');
    put(aApp.data, 'favorites/a.json', '{"v":"A"}');
    expect((await sync(a)).action).toBe('pushed');
    let second: Promise<SyncResult> | null = null;
    let server: ReturnType<typeof recoverAppPulls> | null = null;
    let during: unknown = null;
    const holding = {
      ...gitLib,
      attemptMerge: (cwd: string, ref: string) => {
        const out = gitLib.attemptMerge(cwd, ref);
        during = { open: mergeOpen(b), rec: readPullRecord(b.home, bApp.rec.hash) };
        // A server start well past the stale window: the holder (this live process) still owns it.
        server = recoverAppPulls({ ...xctx(b), nowMs: Date.now() + 10 * 60_000 });
        second = runBrainSync({ cwd: b.ctx, mode: 'auto', home: b.home }, { pauseForSync: async () => 'no_server', readGlobalGitHubLogin: () => null });
        expect(mergeOpen(b)).toBe(true);
        expect(readPullRecord(b.home, bApp.rec.hash)).toEqual((during as { rec: unknown }).rec);
        return out;
      },
    } as typeof gitLib;
    const r = await sync(b, {}, { git: holding });
    expect(r.action).toBe('pushed');
    expect(server).toMatchObject({ skipped: 'locked', recovered: [] });
    expect(await second!).toMatchObject({ action: 'locked' });
    expect((during as { open: boolean }).open).toBe(true);
    expect(appPullHeld(b.home, bApp.rec.hash)).toBe(false);
    expect(read(join(bApp.data, 'favorites/a.json'))).toBe('{"v":"B-mine"}');
  });

  it('9d-5: a manual `git pull` while the record is still `parked`: the plan comes from preHead..mergeHead (ls-tree) with the pull gate\'s classification; an empty plan changes nothing', async () => {
    const a = vaultA();
    const b = vaultB();
    const bApp = install(b);
    const preHead = git(b.top, 'rev-parse', 'HEAD').trim();
    teamCommit(a, { [AP('favorites/ok.json')]: '{"ok":1}', [AP('favorites/x.sqlite')]: 'db', [AP('cache/c.json')]: '{}' });
    git(b.top, 'fetch', '-q', 'origin');
    const mergeHead = git(b.top, 'rev-parse', 'origin/main').trim();
    writePullRecord(b.home, { v: 1, hash: bApp.rec.hash, slug: 'rakip', preHead, mergeHead, phase: 'parked', parked: [], plan: null, at: new Date().toISOString() });
    git(b.top, 'merge', '-q', '--ff-only', 'origin/main');
    expect(existsSync(join(bApp.data, 'favorites/x.sqlite'))).toBe(true); // git put it there
    expect(finishAppPull(xctx(b), bApp.rec.hash)).toEqual({ done: true });
    expect(read(join(bApp.data, 'favorites/ok.json'))).toBe('{"ok":1}');
    expect(existsSync(join(bApp.data, 'favorites/x.sqlite'))).toBe(false);
    expect(existsSync(join(bApp.data, 'cache/c.json'))).toBe(false);
    expect(listConflicts(b.home, bApp.rec.hash).map((c) => c.path).sort()).toEqual(['cache/c.json', 'favorites/x.sqlite']);
    // Nothing in range: nothing applied.
    const head = git(b.top, 'rev-parse', 'HEAD').trim();
    writePullRecord(b.home, { v: 1, hash: bApp.rec.hash, slug: 'rakip', preHead: head, mergeHead: head, phase: 'parked', parked: [], plan: null, at: new Date().toISOString() });
    put(bApp.data, 'favorites/ok.json', '{"ok":"mine"}');
    expect(finishAppPull(xctx(b), bApp.rec.hash)).toEqual({ done: true });
    expect(read(join(bApp.data, 'favorites/ok.json'))).toBe('{"ok":"mine"}');
  });

  it('9d-6: a `merge --abort` that cannot be verified keeps the record and the app paused', async () => {
    const { a, b, aApp, bApp } = await pair();
    bLocalChange(b, bApp);
    writeFileSync(join(b.ctx, 'knowledge', 'own.md'), '# own\n');
    git(b.top, 'add', '_dream_context/knowledge/own.md'); git(b.top, 'commit', '-q', '-m', 'own');
    put(aApp.data, 'favorites/a.json', '{"v":"A"}');
    expect((await sync(a)).action).toBe('pushed');
    const crashing = { ...gitLib, attemptMerge: (cwd: string, ref: string) => { gitLib.attemptMerge(cwd, ref); throw new Error('simulated crash'); } } as typeof gitLib;
    await expect(sync(b, {}, { git: crashing })).rejects.toThrow('simulated crash');
    const lock = join(b.top, '.git', 'index.lock');
    writeFileSync(lock, '');
    try {
      const rec = withHomeSync(b.home, () => recoverAppPulls(xctx(b)));
      expect(rec.recovered).toEqual([]);
      expect(rec.notes.join(' ')).toContain('could not be aborted');
      expect(mergeOpen(b)).toBe(true);
      expect(appPullHeld(b.home, bApp.rec.hash)).toBe(true);
    } finally { rmSync(lock, { force: true }); }
  });

  it('9d-7: the user finishes a code conflict with a plain `git commit`: the next sync applies the plan', async () => {
    const a = vaultA();
    const b = vaultB();
    const bApp = install(b, { shared: [{ path: 'notes/', why: 'x' }], local: [{ path: 'favorites/', why: 'mine' }] }, ['notes/']);
    teamCommit(a, { 'src/app.ts': 'one\nTEAM\nthree\n', [AP('favorites/t.json')]: '{"team":1}' });
    writeFileSync(join(b.root, 'src', 'app.ts'), 'one\nMINE\nthree\n');
    const r = await sync(b);
    expect(r.action).toBe('code-conflict');
    expect(mergeOpen(b)).toBe(true);
    expect(appPullHeld(b.home, bApp.rec.hash)).toBe(true);
    writeFileSync(join(b.root, 'src', 'app.ts'), 'one\nBOTH\nthree\n');
    git(b.top, 'add', 'src/app.ts');
    git(b.top, 'commit', '-q', '--no-edit');
    await sync(b);
    expect(appPullHeld(b.home, bApp.rec.hash)).toBe(false);
    expect(existsSync(join(bApp.data, 'favorites/t.json'))).toBe(false);
    expect(listConflicts(b.home, bApp.rec.hash).map((c) => c.path)).toEqual(['favorites/t.json']);
  });

  it('9d-8: a fast-forward pull with a team file on a `local` path takes it off disk', async () => {
    const a = vaultA();
    const b = vaultB();
    const bApp = install(b, { shared: [], local: [{ path: 'favorites/', why: 'mine' }] }, []);
    teamCommit(a, { [AP('favorites/t.json')]: '{"team":1}' });
    const r = await sync(b, { mode: 'pull-only' });
    expect(r.action).toBe('pulled');
    expect(git(b.top, 'rev-parse', 'HEAD').trim()).toBe(git(bare, 'rev-parse', 'main').trim());
    expect(existsSync(join(bApp.data, 'favorites/t.json'))).toBe(false);
  });

  it('9e: a merge left open for the agent keeps the app closed; after --continue it opens and the team file is not on the local path', async () => {
    const a = vaultA();
    const b = vaultB();
    const bApp = install(b, { shared: [{ path: 'notes/', why: 'x' }], local: [{ path: 'favorites/', why: 'mine' }] }, ['notes/']);
    teamCommit(a, { [AP('favorites/t.json')]: '{"team":1}', '_dream_context/knowledge/k.md': '# base\n\n## Section\nA wrote this.\n' });
    writeFileSync(join(b.ctx, 'knowledge', 'k.md'), '# base\n\n## Section\nB wrote this.\n');
    expect((await sync(b)).action).toBe('awaiting-agent');
    expect(mergeOpen(b)).toBe(true);
    expect(appPullHeld(b.home, bApp.rec.hash)).toBe(true);
    writeFileSync(join(b.ctx, 'knowledge', 'k.md'), '# base\n\n## Section\nA wrote this. B wrote this.\n');
    git(b.top, 'add', '_dream_context/knowledge/k.md');
    expect((await sync(b, { continue: true })).action).toBe('pushed');
    expect(appPullHeld(b.home, bApp.rec.hash)).toBe(false);
    expect(existsSync(join(bApp.data, 'favorites/t.json'))).toBe(false);
    expect(remoteFile(AP('favorites/t.json'))).toBe('{"team":1}');
  });

  it('9f: a path that cannot be parked puts back everything parked in that run; the pull is skipped', async () => {
    const { a, b, aApp, bApp } = await pair();
    bLocalChange(b, bApp); // favorites/a.json, parked first
    mkdirSync(join(bApp.data, 'favorites', 'z.json'), { recursive: true }); // a folder where the team adds a file
    put(bApp.data, 'favorites/z.json/.keep', 'x'); // dotted: held here, never staged
    put(aApp.data, 'favorites/a.json', '{"v":"A"}');
    put(aApp.data, 'favorites/z.json', '{"z":1}');
    expect((await sync(a)).action).toBe('pushed');
    const head = git(b.top, 'rev-parse', 'HEAD').trim();
    const r = await sync(b);
    expect(r.action).toBe('noop');
    expect(r.note).toContain('could not be set aside');
    expect(git(b.top, 'rev-parse', 'HEAD').trim()).toBe(head);
    expect(read(join(bApp.data, 'favorites/a.json'))).toBe('{"v":"B-mine"}');
    expect(appPullHeld(b.home, bApp.rec.hash)).toBe(false);
  });

  it('9g: a file committed on both sides + a prose conflict in a background pull: the merge aborts clean; committed later, the tree has theirs, the disk mine, the path `conflict`', async () => {
    const { a, b, aApp, bApp } = await pair();
    put(aApp.data, 'favorites/a.json', '{"v":"A"}');
    writeFileSync(join(a.ctx, 'knowledge', 'k.md'), '# base\n\n## Section\nA wrote this.\n');
    expect((await sync(a)).action).toBe('pushed');
    put(bApp.data, 'favorites/a.json', '{"v":"B"}');
    writeFileSync(join(b.ctx, 'knowledge', 'k.md'), '# base\n\n## Section\nB wrote this.\n');
    const r = await sync(b, { mode: 'pull-only', foreground: false });
    expect(r.action).toBe('awaiting-agent');
    expect(mergeOpen(b)).toBe(false);
    expect(read(join(bApp.data, 'favorites/a.json'))).toBe('{"v":"B"}');
    expect(appPullHeld(b.home, bApp.rec.hash)).toBe(false);
    // Attended: the merge stays open for the agent, then is committed.
    expect((await sync(b, { resume: true })).action).toBe('awaiting-agent');
    writeFileSync(join(b.ctx, 'knowledge', 'k.md'), '# base\n\n## Section\nA wrote this. B wrote this.\n');
    git(b.top, 'add', '_dream_context/knowledge/k.md');
    expect((await sync(b, { continue: true })).action).toBe('pushed');
    expect(git(b.top, 'show', `HEAD:${AP('favorites/a.json')}`)).toBe('{"v":"A"}');
    expect(read(join(bApp.data, 'favorites/a.json'))).toBe('{"v":"B"}');
    expect(listConflicts(b.home, bApp.rec.hash)).toEqual([expect.objectContaining({ path: 'favorites/a.json', kind: 'conflict' })]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────
describe('the host\'s per-file limit (GitHub GH001)', { timeout: 120_000 }, () => {
  const GH001 = [
    'remote: error: Trace: 3c1f0e',
    'remote: error: See https://gh.io/lfs for more information.',
    'remote: error: File _dream_context/apps/rakip/favorites/huge.bin is 120.00 MB; this exceeds GitHub\'s file size limit of 100.00 MB',
    'remote: error: GH001: Large files detected. You may want to try Git Large File Storage - https://git-lfs.github.com.',
    ' ! [remote rejected] HEAD -> main (pre-receive hook declined)',
  ].join('\n');

  it('recognises the refusal and names the file; any other push failure is not it', () => {
    expect(hostFileSizeRefusal(GH001)).toBe('_dream_context/apps/rakip/favorites/huge.bin');
    expect(hostFileSizeRefusal('remote: error: GH001: Large files detected.')).toBe('');
    expect(hostFileSizeRefusal(' ! [rejected] HEAD -> main (non-fast-forward)')).toBeNull();
    expect(hostFileSizeRefusal('fatal: Authentication failed')).toBeNull();
    expect(hostFileSizeRefusal('error: the file size limit of this server')).toBeNull(); // another host's words are not GitHub's
    expect(hostFileSizeNote('apps/x/a.bin', 'origin/main')).toMatch(/apps\/x\/a\.bin is over 100 MB.*git reset --soft origin\/main, then git rm --cached -- "apps\/x\/a\.bin"/);
  });

  it('a push the host refuses for size ends the sync with that file and the way out, never "non-fast-forward twice"', async () => {
    const a = vaultA();
    const aApp = install(a);
    put(aApp.data, 'favorites/t.json', '{"a":1}');
    const fail = (): never => { throw new gitLib.GitSyncError('git push main HEAD:main failed: ' + GH001, GH001); };
    const r = sync(a, {}, { git: { ...gitLib, push: fail } as typeof gitLib });
    await expect(r).rejects.toThrow(/huge\.bin is over 100 MB, and GitHub refuses/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────
describe('install onto a team folder (K9, lane B calls it)', { timeout: 120_000 }, () => {
  it('team files on paths the installed manifest does not call shared go to the store; shared ones stay', async () => {
    const a = vaultA();
    const aApp = install(a);
    put(aApp.data, 'favorites/f.json', '{"f":1}');
    put(aApp.data, 'notes/n.json', '{"n":1}');
    expect((await sync(a)).action).toBe('pushed');
    const b = vaultB();
    const bApp = install(b, { shared: [{ path: 'favorites/', why: 'x' }], local: [] }, []);
    const r = applyPullRuleForInstall(xctx(b), 'rakip', bApp.rec.hash);
    expect(r.stored).toEqual(['notes/n.json']);
    expect(existsSync(join(bApp.data, 'notes/n.json'))).toBe(false);
    expect(read(join(bApp.data, 'favorites/f.json'))).toBe('{"f":1}');
  });

  it('a file of mine on such a path stays, the team\'s copy stored beside it; a later approval holds the two as two versions', async () => {
    const a = vaultA();
    const aApp = install(a);
    put(aApp.data, 'notes/n.json', '{"team":"n"}');
    expect((await sync(a)).action).toBe('pushed');
    const b = vaultB();
    const bApp = install(b, { shared: [{ path: 'favorites/', why: 'x' }], local: [] }, []);
    put(bApp.data, 'notes/n.json', '{"mine":"n"}');
    expect(applyPullRuleForInstall(xctx(b), 'rakip', bApp.rec.hash).stored).toEqual(['notes/n.json']);
    expect(read(join(bApp.data, 'notes/n.json'))).toBe('{"mine":"n"}'); // mine stays
    expect(listConflicts(b.home, bApp.rec.hash)).toEqual([expect.objectContaining({ path: 'notes/n.json', kind: 'local_path' })]);
    // The manifest now shares notes/ and the owner approves: mine is never sent over the team's.
    writeFileSync(join(bApp.rec.root, 'dreamcontext-app.json'), JSON.stringify({ slug: 'rakip', name: 'Rakip İstihbaratı', data: RAKIP }));
    expect(applyConsentPatch(b.home, bApp.rec.hash, RAKIP, { approve: ['favorites/', 'notes/'] }).ok).toBe(true);
    const s = await sync(b);
    expect(s.appData?.restored).toEqual([{ slug: 'rakip', paths: [], twoVersions: ['notes/n.json'] }]);
    expect(remoteFile(AP('notes/n.json'))).toBe('{"team":"n"}');
    expect(listConflicts(b.home, bApp.rec.hash)).toEqual([expect.objectContaining({ path: 'notes/n.json', kind: 'conflict' })]);
  });
});

function withHomeSync<T>(home: string, fn: () => T): T {
  const was = process.env.HOME;
  process.env.HOME = home;
  try { return fn(); } finally { process.env.HOME = was; }
}
