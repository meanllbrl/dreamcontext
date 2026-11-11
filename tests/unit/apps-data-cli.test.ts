/**
 * `dreamcontext apps data` and its friends (app-veri-ortak r6, K2, K7, K8, K10; criterion 11).
 *
 *  - `apps data <slug>` lists every file (size, last change, DB and name flags, "one refresh"
 *    batches) and the sharedSet dry run.
 *  - `dc.data.status()` (through `appDataStatus`) answers each of the five modes.
 *  - `dc.data.read(path, validate)` drops a record the app's schema refuses, never throws it.
 *  - `apps validate` warns `data_html_sink` on `innerHTML` in an app that shares data, and is silent
 *    on `textContent` (and for an app that shares nothing).
 *  - `apps data resolve` refuses the Super, its children, a spawned session and a scheduled run.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataFileRows, dataFolderWithoutSlash, dataHtmlSinks, resolveRefusal, runDataDeletes } from '../../src/cli/commands/apps.js';
import { addTombstone } from '../../src/lib/apps/data-deletes.js';
import { registerApp, type AppRecord } from '../../src/lib/apps/registry.js';
import { appDataStatus, listDataFiles } from '../../src/lib/apps/others.js';
import { ensureAppDataDir } from '../../src/lib/apps/data-dir.js';
import { applyConsentPatch } from '../../src/lib/apps/data-consent.js';
import type { DataDecl } from '../../src/lib/apps/data-share.js';

const dirs: string[] = [];
const tmp = (p = 'dc-data-cli-') => { const d = realpathSync(mkdtempSync(join(tmpdir(), p))); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
afterEach(() => { vi.unstubAllGlobals(); });

const DECL: DataDecl = {
  shared: [{ path: 'favorites/', why: 'Picked by the team' }],
  local: [{ path: 'cache/', why: 'Re-fetched' }, { path: 'stats.json', why: 'Computed' }],
};

function app(home: string, data: unknown, files: Record<string, string> = {}): { rec: AppRecord; dir: string; root: string } {
  const project = join(tmp(), 'acme');
  mkdirSync(join(project, '_dream_context'), { recursive: true });
  const root = join(`${project}-apps`, 'rakip');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'dreamcontext-app.json'), JSON.stringify({ slug: 'rakip', name: 'Rakip', ...(data === undefined ? {} : { data }) }));
  const rec = registerApp(home, { projectRoot: project, vault: 'acme', slug: 'rakip', name: 'Rakip', root });
  const dir = ensureAppDataDir(project, 'rakip');
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  return { rec, dir, root };
}

const ON = { fullRepo: true, cloudSyncOn: true };
const OLD = Date.now() - 60_000;

describe('dc.data.status() in the five modes (criterion 11)', () => {
  it('sync_off: not full-repo or cloud sync off, nothing goes', () => {
    const home = tmp();
    const { rec } = app(home, DECL, { 'favorites/a.json': '{}' });
    applyConsentPatch(home, rec.hash, DECL, { approve: ['favorites/'] });
    const s = appDataStatus(home, rec, { mode: { fullRepo: false, cloudSyncOn: true } });
    expect(s.mode).toBe('sync_off');
    expect(s.shared).toEqual([]);
  });

  it('undecided: no data field', () => {
    const home = tmp();
    const { rec } = app(home, undefined, { 'favorites/a.json': '{}' });
    expect(appDataStatus(home, rec, { mode: ON })).toMatchObject({ mode: 'undecided', shared: [], decl: null });
  });

  it('pending: declared, the owner has not approved; the file is held not_approved_here', () => {
    const home = tmp();
    const { rec } = app(home, DECL, { 'favorites/a.json': '{}' });
    const s = appDataStatus(home, rec, { mode: ON });
    expect(s.mode).toBe('pending');
    expect(s.pending).toEqual(['favorites/']);
    expect(s.held).toEqual([{ path: 'favorites/a.json', reason: 'not_approved_here' }]);
  });

  it('local: `shared: []` is a decision', () => {
    const home = tmp();
    const { rec } = app(home, { shared: [], local: DECL.local }, { 'cache/x.json': '{}' });
    expect(appDataStatus(home, rec, { mode: ON })).toMatchObject({ mode: 'local', shared: [], pending: [] });
  });

  it('shared: approved, the settled files go and the rest is held with its reason', () => {
    const home = tmp();
    const { rec, dir } = app(home, DECL, { 'favorites/a.json': '{"id":"a"}', 'favorites/b.sqlite': 'x', 'cache/c.json': '{}' });
    for (const f of ['favorites/a.json', 'favorites/b.sqlite']) utimesSync(join(dir, f), OLD / 1000, OLD / 1000);
    applyConsentPatch(home, rec.hash, DECL, { approve: ['favorites/'] });
    const s = appDataStatus(home, rec, { mode: ON });
    expect(s.mode).toBe('shared');
    expect(s.shared).toEqual(['favorites/a.json']);
    expect(s.held).toEqual([{ path: 'favorites/b.sqlite', reason: 'db_file' }]);
    expect(s.sharedPaths[0]).toMatchObject({ path: 'favorites/', files: 2, state: 'approved' });
  });
});

describe('apps data <slug>: every file and its flags', () => {
  it('lists every path with its declaration, DB and name flags, and one-refresh batches', () => {
    const t = 1_700_000_000_000;
    const files = [
      { rel: 'favorites/a.json', size: 10, mtimeMs: t },
      { rel: 'stats.json', size: 5, mtimeMs: t + 5000 },
      { rel: 'library.db', size: 9, mtimeMs: t + 9000 },
      { rel: 'favorites/CLAUDE.md', size: 1, mtimeMs: t + 12_000 },
      ...Array.from({ length: 21 }, (_, i) => ({ rel: `thumbs/${i}.jpg`, size: 100, mtimeMs: t + 20_000 + i })),
    ];
    const rows = dataFileRows(files, DECL, [], ['favorites/a.json']);
    expect(rows.find((r) => r.path === 'favorites/a.json')).toMatchObject({ decl: 'shared', tracked: true, batch: false, db: false, badName: false });
    expect(rows.find((r) => r.path === 'stats.json')).toMatchObject({ decl: 'local' });
    expect(rows.find((r) => r.path === 'library.db')).toMatchObject({ decl: 'unlisted', db: true });
    expect(rows.find((r) => r.path === 'favorites/CLAUDE.md')).toMatchObject({ badName: true });
    expect(rows.filter((r) => r.batch)).toHaveLength(21);
    expect(dataFileRows(files, DECL, ['favorites/'], [])[0].decl).toBe('excluded');
  });

  it('the walk lists files under folders and never follows into a link', () => {
    const home = tmp();
    const { dir } = app(home, DECL, { 'favorites/a.json': '{}', 'cache/deep/b.json': '{}' });
    expect(listDataFiles(dir).map((f) => f.rel)).toEqual(['cache/deep/b.json', 'favorites/a.json']);
  });
});

describe('apps validate: data_html_sink', () => {
  it('catches innerHTML, dangerouslySetInnerHTML and v-html in an app that shares; silent on textContent', () => {
    const root = tmp();
    mkdirSync(join(root, 'public'), { recursive: true });
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'lib'), { recursive: true });
    writeFileSync(join(root, 'public', 'app.js'), 'const el = document.querySelector("#n");\nel.innerHTML = fav.note;\n');
    writeFileSync(join(root, 'src', 'Card.tsx'), 'export const C = ({ n }) => <p dangerouslySetInnerHTML={{ __html: n }} />;\n');
    writeFileSync(join(root, 'src', 'Note.vue'), '<template><p v-html="note"></p></template>\n');
    writeFileSync(join(root, 'lib', 'dc.mjs'), '// dreamcontext App SDK\nx.innerHTML = y;\n');
    writeFileSync(join(root, 'server.mjs'), 'res.end(html);\n');
    const hits = dataHtmlSinks(root, DECL);
    expect(hits).toEqual([
      { file: 'public/app.js', line: 2, sink: 'innerHTML' },
      { file: 'src/Card.tsx', line: 1, sink: 'dangerouslySetInnerHTML' },
      { file: 'src/Note.vue', line: 1, sink: 'v-html' },
    ]);
    expect(dataHtmlSinks(root, { shared: [], local: [] })).toEqual([]);
    expect(dataHtmlSinks(root, null)).toEqual([]);

    const safe = tmp();
    mkdirSync(join(safe, 'public'), { recursive: true });
    writeFileSync(join(safe, 'public', 'app.js'), 'el.textContent = fav.note;\nif (el.innerHTML === "") {}\n');
    expect(dataHtmlSinks(safe, DECL)).toEqual([]);
  });
});

describe('apps data resolve: the owner picks, never the Super or a run', () => {
  it('needs_owner for the Super crew, a member crew, a spawned session and a scheduled run', () => {
    expect(resolveRefusal({ DREAMCONTEXT_SUPER_CREW: '1' })).toBe('crew');
    expect(resolveRefusal({ DREAMCONTEXT_MEMBER_CREW: 'ua' })).toBe('crew');
    expect(resolveRefusal({ DREAMCONTEXT_SPAWNED: '1' })).toBe('spawned');
    expect(resolveRefusal({ DREAMCONTEXT_AUTOMATION_RUN: 'r1', DREAMCONTEXT_AUTOMATION_SLUG: 'daily' })).toBe('run');
    expect(resolveRefusal({})).toBeNull();
    expect(resolveRefusal({ DREAMCONTEXT_AGENT_CHAT: 'app-rakip' })).toBeNull();
  });
});

describe('dc.data in the SDK', () => {
  it('read drops a record the schema refuses (and a .json that does not parse), never throws it into the page', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', {});
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (u: string) => {
      seen.push(u);
      // The folder itself (`favorites/`), never a file under it (`favorites/b.json` holds the same prefix).
      if (u.endsWith('path=favorites%2F')) {
        return new Response(JSON.stringify({ path: 'favorites/', records: [
          { path: 'favorites/a.json', text: '{"id":"a","note":"ok"}' },
          { path: 'favorites/b.json', text: '{"id":5}' },
          { path: 'favorites/c.json', text: '{"id":' },
        ] }), { status: 200 });
      }
      return new Response(JSON.stringify({ path: 'favorites/b.json', text: '{"id":5}' }), { status: 200 });
    });
    vi.resetModules();
    const { dc } = await import('../../src/lib/apps/sdk/dc.mjs?data');
    const valid = (v: { id?: unknown }) => typeof v?.id === 'string';
    expect(await dc.data.read('favorites/', valid)).toEqual([{ id: 'a', note: 'ok' }]);
    expect(await dc.data.read('favorites/b.json', valid)).toBeNull();
    expect(await dc.data.read('favorites/b.json', () => { throw new Error('bad'); })).toBeNull();
    expect(seen[0]).toBe('/__dc/data/read?path=favorites%2F');
    expect(() => dc.data.write('x.json', '{}')).toThrowError(expect.objectContaining({ code: 'backend_only' }));
    expect(() => dc.data.remove('x.json')).toThrowError(expect.objectContaining({ code: 'backend_only' }));
  });
});

describe('apps data deletes: an approval covers exactly what was shown', () => {
  const HASH = 'abc123';
  it('lists the waiting deletes with the exact command carrying their count; only the owner approves', () => {
    const home = tmp();
    addTombstone(home, HASH, 'favorites/a.json');
    addTombstone(home, HASH, 'favorites/b.json');
    const list = runDataDeletes({ home, hash: HASH, slug: 'rakip' });
    expect(list.code).toBe(0);
    expect(list.lines[0]).toMatch(/^2 deletes of shared files waiting for the owner/);
    expect(list.lines.slice(1, 3).map((l) => l.split(' · ')[0].trim())).toEqual(['favorites/a.json', 'favorites/b.json']);
    expect(list.lines.at(-1)).toContain('dreamcontext apps data deletes rakip --approve 2 --confirm');

    const calls: Array<[string, string, number]> = [];
    const approve = (h: string, hash: string, expect: number) => { calls.push([h, hash, expect]); return { ok: true as const, approved: expect }; };
    for (const env of [{ DREAMCONTEXT_SUPER_CREW: '1' }, { DREAMCONTEXT_MEMBER_CREW: 'ua' }, { DREAMCONTEXT_AUTOMATION_RUN: 'r1' }, { DREAMCONTEXT_SPAWNED: '1' }]) {
      const r = runDataDeletes({ home, hash: HASH, slug: 'rakip', approve: '2', confirm: true, env }, { approve });
      expect(r.code).toBe(1);
      expect(r.lines[0]).toMatch(/^needs_owner:/);
    }
    const noConfirm = runDataDeletes({ home, hash: HASH, slug: 'rakip', approve: '2', env: {} }, { approve });
    expect(noConfirm.code).toBe(1);
    expect(noConfirm.lines.at(-1)).toMatch(/^needs_confirm:.*--approve 2 --confirm/);
    expect(runDataDeletes({ home, hash: HASH, slug: 'rakip', approve: 'all', confirm: true, env: {} }, { approve }).lines[0]).toMatch(/^bad_count:/);
    expect(calls).toEqual([]);
    const ok = runDataDeletes({ home, hash: HASH, slug: 'rakip', approve: '2', confirm: true, env: {} }, { approve });
    expect(ok).toEqual({ code: 0, lines: ['rakip: 2 deletes approved; the next sync sends them'] });
    expect(calls).toEqual([[home, HASH, 2]]);
  });

  it('the set grew since the owner looked: nothing approved, the fresh list and its new command come back', () => {
    const home = tmp();
    addTombstone(home, HASH, 'favorites/a.json');
    addTombstone(home, HASH, 'favorites/b.json');
    // The app kept deleting after the list was shown: the real approveDeletes refuses the old count.
    addTombstone(home, HASH, 'favorites/c.json');
    const r = runDataDeletes({ home, hash: HASH, slug: 'rakip', approve: '2', confirm: true, env: {} });
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/^deletes_changed: the owner approved 2, but 3 wait now; nothing was approved/);
    expect(r.lines.at(-1)).toContain('--approve 3 --confirm');
    expect(runDataDeletes({ home, hash: HASH, slug: 'rakip' }).lines[0]).toMatch(/^3 deletes of shared files waiting/);
  });
});

describe('dc.data.read on what is not there yet, and while a pull lands', () => {
  it('a missing folder is [], a missing file null; paused_for_sync throws a catchable DcError', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', {});
    let paused = false;
    vi.stubGlobal('fetch', async () => (paused
      ? new Response(JSON.stringify({ error: 'paused_for_sync', message: 'Team data is landing' }), { status: 503 })
      : new Response(JSON.stringify({ error: 'not_found' }), { status: 404 })));
    vi.resetModules();
    const { dc, DcError } = await import('../../src/lib/apps/sdk/dc.mjs?missing');
    expect(await dc.data.read('favorites/', () => true)).toEqual([]);
    expect(await dc.data.read('favorites/a.json', () => true)).toBeNull();
    paused = true;
    await expect(dc.data.read('favorites/', () => true)).rejects.toSatisfy((e: unknown) => e instanceof DcError && (e as { code: string }).code === 'paused_for_sync');
  });
});

describe('apps validate: data_path_is_folder (B7)', () => {
  it('names a shared path that is a folder but has no trailing slash; a slash, a glob or a file is silent', () => {
    const home = tmp();
    const { dir } = app(home, undefined, { 'favorites/a.json': '{}', 'one.json': '{}' });
    const d = (...paths: string[]): DataDecl => ({ shared: paths.map((path) => ({ path, why: 'x' })), local: [] });
    expect(dataFolderWithoutSlash(dir, d('favorites'))).toEqual(['favorites']);
    expect(dataFolderWithoutSlash(dir, d('favorites/', 'favorites/*', 'one.json', 'missing'))).toEqual([]);
    expect(dataFolderWithoutSlash(dir, null)).toEqual([]);
  });
});
