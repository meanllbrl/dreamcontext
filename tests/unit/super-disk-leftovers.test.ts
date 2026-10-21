/**
 * Finished super work gives the disk back (task biten-super-isi-diski-geri-verir-…):
 *  - `super clean` removes ONLY an ended child's merged, clean worktree (branch kept) and this
 *    repo's own test temp folders older than a day; `--dry-run` only lists them with sizes;
 *  - `super state` machine shows the 5 largest leftovers, Chrome copies measured, never removed;
 *  - the test temp prefixes it trusts are exactly the ones this repo's tests use (drift test).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { TEST_TMP_PREFIXES } from '../../src/lib/super/test-tmp-prefixes.js';
import { isOurTestTmp, measureLeftovers, oldTestTmp } from '../../src/lib/super/disk-leftovers.js';
import { linkedReposFilePath } from '../../src/lib/linked-repos.js';
import { canonicalRemote } from '../../src/lib/git-sync/origin-setup.js';
import { createChildWorktree } from '../../src/lib/super/worktrees.js';

// ── the prefix list, generated from the tests themselves ─────────────────────────────

const PREFIX_FILE = resolve(__dirname, '../../src/lib/super/test-tmp-prefixes.ts');

function testPrefixes(): string[] {
  const out = new Set<string>();
  const scan = (s: string) => {
    for (const m of s.matchAll(/mkdtemp(?:Sync)?\(\s*(?:join\(\s*(?:tmpdir|os\.tmpdir)\(\)\s*,\s*|path\.join\(\s*(?:tmpdir|os\.tmpdir)\(\)\s*,\s*)?[`'"]([^`'"$]*)/g)) out.add(m[1]);
    for (const m of s.matchAll(/mkdtemp(?:Sync)?\(\s*`\$\{(?:tmpdir|os\.tmpdir)\(\)\}\/([^`$]*)/g)) out.add(m[1]);
  };
  const walk = (d: string) => {
    for (const f of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, f.name);
      if (f.isDirectory()) walk(p); else if (/\.(ts|tsx|mjs)$/.test(f.name)) scan(readFileSync(p, 'utf-8'));
    }
  };
  walk(resolve(__dirname, '..'));
  return [...out].filter(Boolean).sort();
}

describe('the test temp prefixes', () => {
  it('match every mkdtemp prefix this repo\'s tests use (UPDATE_TEST_TMP_PREFIXES=1 rewrites them)', () => {
    const want = testPrefixes();
    if (process.env.UPDATE_TEST_TMP_PREFIXES === '1') {
      const head = readFileSync(PREFIX_FILE, 'utf-8').split('export const')[0];
      writeFileSync(PREFIX_FILE, `${head}export const TEST_TMP_PREFIXES: readonly string[] = [\n${want.map((p) => `  '${p}',`).join('\n').replace(/,$/, '')}\n];\n`);
      return;
    }
    expect([...TEST_TMP_PREFIXES].sort()).toEqual(want);
  });

  it.each([
    ['super-end-home-Ab12Cd', true], ['dc-ctx-watch-zz99ZZ', true],
    ['super-end-home-', false], ['super-end-home-Ab12C', false], ['push-Ab12Cd', false],
    ['com.google.Chrome.chrome_x_Ab12Cd', false], ['someone-elses-Ab12Cd', false],
  ] as const)('%s is ours: %s', (name, want) => {
    expect(isOurTestTmp(name)).toBe(want);
  });
});

// ── measuring ────────────────────────────────────────────────────────────────────────

describe('measureLeftovers', () => {
  let base: string;
  beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'super-disk-base-')); });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const fill = (dir: string, kb: number) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'blob'), Buffer.alloc(kb * 1024, 1)); };
  const age = (dir: string, days: number) => { const t = (Date.now() - days * 86_400_000) / 1000; utimesSync(dir, t, t); };

  it('ranks worktrees, Rust targets, Chrome copies, old test temp and run logs; only ours is removable', async () => {
    const wts = join(base, 'worktrees');
    const tmp = join(base, 'tmp');
    const proj = join(base, 'proj');
    fill(join(wts, 'app-super-a', 'src'), 200);
    writeFileSync(join(wts, 'app-super-a', 'desktop-Cargo.txt'), '');
    mkdirSync(join(wts, 'app-super-a', 'desktop'), { recursive: true });
    writeFileSync(join(wts, 'app-super-a', 'desktop', 'Cargo.toml'), '');
    fill(join(wts, 'app-super-a', 'desktop', 'target'), 600);
    fill(join(wts, 'app-super-b'), 50);
    fill(join(tmp, 'com.google.Chrome.chrome_url_fetcher_.Ab12Cd'), 300);
    const oldOne = join(tmp, 'super-end-home-Zx98Yw');
    fill(oldOne, 100); age(oldOne, 2);
    const fresh = join(tmp, 'super-end-home-Qq11Ww');
    fill(fresh, 100);
    fill(join(tmp, 'someone-elses-Ab12Cd'), 400); age(join(tmp, 'someone-elses-Ab12Cd'), 5);
    fill(join(proj, 'tmp', 'develop', 'task-a'), 20);

    const rows = await measureLeftovers({ worktrees: wts, tmp, projects: [proj], removableWorktrees: new Set([join(wts, 'app-super-b')]) });
    const kinds = rows.map((r) => r.kind);
    expect(kinds).toContain('rust-target');
    expect(rows.find((r) => r.kind === 'chrome-copy')).toMatchObject({ count: 1, removable: false });
    expect(rows.find((r) => r.kind === 'test-tmp')).toMatchObject({ count: 1, removable: true });
    expect(rows.find((r) => r.kind === 'develop-logs')).toBeTruthy();
    expect(rows.find((r) => r.path === join(wts, 'app-super-b'))?.removable).toBe(true);
    expect(rows.find((r) => r.path === join(wts, 'app-super-a'))?.removable).toBe(false);
    // Largest first; the fresh test folder and someone else's are not leftovers of ours.
    expect(rows.map((r) => r.bytes)).toEqual([...rows.map((r) => r.bytes)].sort((a, b) => b - a));
    expect(await oldTestTmp(tmp)).toEqual([oldOne]);
  });
});

// ── super clean, through the route, on a real repo ─────────────────────────────────────

describe('super clean', () => {
  const URL_ = 'https://github.com/acme/product.git';
  let home: string;
  let repo: string;
  let project: string;
  let fakeTmp: string;
  const savedEnv = { ...process.env };
  const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();

  beforeEach(() => {
    Object.assign(process.env, { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.test' });
    home = mkdtempSync(join(tmpdir(), 'super-clean-home-'));
    repo = join(home, 'code', 'product');
    mkdirSync(repo, { recursive: true });
    g(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'README.md'), 'one\n');
    g(repo, 'add', '.'); g(repo, 'commit', '-q', '-m', 'init');
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    writeFileSync(linkedReposFilePath(home), JSON.stringify({ repos: { [canonicalRemote(URL_) ?? URL_]: repo } }));
    project = mkdtempSync(join(tmpdir(), 'super-clean-proj-'));
    mkdirSync(join(project, '_dream_context', 'state'), { recursive: true });
    writeFileSync(join(project, '_dream_context', 'state', '.config.json'), JSON.stringify({ platforms: [], packs: [], setupVersion: '1', linkedRepos: [{ name: 'product', gitRemoteUrl: URL_ }] }));
    fakeTmp = mkdtempSync(join(tmpdir(), 'super-clean-tmp-'));
  });
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
    Object.assign(process.env, savedEnv);
    for (const d of [home, project, fakeTmp]) rmSync(d, { recursive: true, force: true });
  });

  it('dry run lists, a real run removes only the ended, merged, clean worktree and our old test temp', { timeout: 30_000 }, async () => {
    const merged = await createChildWorktree({ projectRoot: project, repo: 'product', slug: 'done-one', home });
    const unmerged = await createChildWorktree({ projectRoot: project, repo: 'product', slug: 'open-one', home });
    writeFileSync(join(unmerged.path, 'work.txt'), 'x\n'); g(unmerged.path, 'add', '.'); g(unmerged.path, 'commit', '-q', '-m', 'work');
    const live = await createChildWorktree({ projectRoot: project, repo: 'product', slug: 'live-one', home });
    const ours = join(fakeTmp, 'super-end-home-Zx98Yw');
    mkdirSync(ours); writeFileSync(join(ours, 'f'), 'x');
    const t = (Date.now() - 3 * 86_400_000) / 1000; utimesSync(ours, t, t);
    const chrome = join(fakeTmp, 'com.google.Chrome.chrome_url_fetcher_.Ab12Cd');
    mkdirSync(chrome);

    process.env.HOME = home;
    process.env.TMPDIR = fakeTmp;
    const { handleSuperVerb } = await import('../../src/server/routes/super.js');
    const wc = await import('../../src/lib/window-control.js');
    const store = await import('../../src/lib/super/store.js');
    wc.resetWindowControl(); store.resetSuperIndex();
    const root = join(project, '_dream_context');
    const kid = (sid: string, w: { path: string; branch: string }, ended: boolean) => ({ sessionId: sid, brief: sid, adopted: false, startedAt: 1, worktree: w.path, branch: w.branch, ...(ended ? { endedAt: 2 } : {}) });
    writeFileSync(join(root, store.SUPER_STATE_REL), JSON.stringify({
      v: 1, session: 'sup-1', enabled: true, containers: [], queue: [], notes: {}, away: { since: null, events: 0 },
      children: { a: kid('a', merged, true), b: kid('b', unmerged, true), c: kid('c', live, false) },
    }));
    const token = wc.mintWindowToken({ send: () => true, vault: 'product', contextRoot: root, sessionId: 'sup-1', mode: 'super' }).token;
    const call = async (body: unknown) => {
      const r = new PassThrough() as unknown as import('node:http').IncomingMessage & PassThrough;
      Object.assign(r, { headers: { host: '127.0.0.1:4173', 'x-dreamcontext-window-token': token }, socket: { remoteAddress: '127.0.0.1' }, method: 'POST', url: '/' });
      setImmediate(() => (r as unknown as PassThrough).end(JSON.stringify(body)));
      const out = { status: 0, json: {} as Record<string, unknown> } as import('node:http').ServerResponse & { status: number; json: Record<string, unknown> };
      (out as unknown as { writeHead: (s: number) => void }).writeHead = (s) => { out.status = s; };
      (out as unknown as { end: (b?: string) => void }).end = (b) => { out.json = b ? JSON.parse(b) : {}; };
      await handleSuperVerb(r, out, { verb: 'clean' });
      return out;
    };

    const dry = await call({ dryRun: true });
    expect(dry.status).toBe(200);
    const items = (dry.json.result as { items: Array<{ path: string }> }).items.map((i) => i.path);
    expect(items.sort()).toEqual([merged.path, ours].sort());
    expect(existsSync(merged.path)).toBe(true);

    const real = await call({});
    expect((real.json.result as { removed: string[] }).removed.sort()).toEqual([merged.path, ours].sort());
    expect(existsSync(merged.path)).toBe(false);
    expect(existsSync(ours)).toBe(false);
    // Kept: the branch, unmerged work, a live child's worktree, Chrome's folder.
    expect(g(repo, 'branch', '--list', merged.branch)).toContain(merged.branch);
    for (const p of [unmerged.path, live.path, chrome]) expect(existsSync(p)).toBe(true);
    const s = await store.readSuperState(root);
    expect(s.children.a.worktree).toBeUndefined();
    expect(s.children.b.worktree).toBe(unmerged.path);
  });
});
