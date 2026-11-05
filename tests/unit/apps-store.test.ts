import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyStoreEdits, parseStoreReadme, readmeSkeleton, storeReadiness, storeWarnings } from '../../src/lib/apps/store-readme.js';
import { canLines, imageDataUrl, readAppFile, scheduleText, storePage } from '../../src/lib/apps/store-facts.js';
import { cornersTransparent, decodePng, encodePng, maskToTile, pngSize } from '../../src/lib/apps/png.js';
import { iconShapeWarnings, isDefaultIconBytes, renderDefaultIcon } from '../../src/lib/apps/icon.js';
import { allowedPath, runGate } from '../../src/lib/apps/share/gate.js';
import { addVault } from '../../src/lib/vaults.js';
import { registerApp, getApp } from '../../src/lib/apps/registry.js';
import { LocalHost } from '../../src/lib/apps/share/host.js';
import { buildPublishTree, publishApp, writeBackStoreReadme } from '../../src/lib/apps/share/publish.js';
import { previewInstall } from '../../src/lib/apps/share/install.js';
import { clearSharedCache, listShared } from '../../src/lib/apps/share/shared.js';

/**
 * The store page (app-paylasim-magaza r2): the README standard, the one icon mask, and the
 * publish that writes the store words into the README. Every name here is fictional.
 */

const README = `---
tagline: Shows the weather note for the city you set.
category: Weather            # optional
---

# Hava Notu

## What it does
Every morning it writes a short note about today's weather.

## Screenshots
![Today](store/today.png)
![Outside](../secret.png)
![Tomorrow](./store/tomorrow.png)

## What's new
### 2 · 2026-11-05
- Shows tomorrow too.

### 1 · 2026-11-03
- First version.
`;

describe('the README standard', () => {
  it('reads the header block, the three sections and only store/ screenshots', () => {
    const s = parseStoreReadme(README);
    expect(s.tagline).toBe('Shows the weather note for the city you set.');
    expect(s.taglineGuessed).toBe(false);
    expect(s.category).toBe('Weather');
    expect(s.about).toBe("Every morning it writes a short note about today's weather.");
    expect(s.screenshots.map((x) => x.path)).toEqual(['store/today.png', 'store/tomorrow.png']);
    expect(s.whatsNew).toEqual([{ version: '2', date: '2026-11-05', notes: ['Shows tomorrow too.'] }, { version: '1', date: '2026-11-03', notes: ['First version.'] }]);
    expect(storeReadiness(s)).toEqual({ ready: 3, of: 3, missing: [] });
    expect(storeWarnings(README)).toEqual([]);
  });

  it('an old README still draws: its first sentence is a guessed tagline, missing parts are named', () => {
    const s = parseStoreReadme('# Sayac\n\nCounts things. It also resets.\n\n## Usage\nRun it.\n');
    expect(s.tagline).toBe('Counts things.');
    expect(s.taglineGuessed).toBe(true);
    expect(s.about).toBeNull();
    expect(storeReadiness(s).missing).toEqual(['tagline', 'about', 'whatsNew']);
    expect(storeWarnings('# Sayac\n\nCounts things.\n')).toHaveLength(3);
    expect(storeWarnings(null)[0]).toMatch(/README\.md: missing/);
  });

  it('the skeleton of a new app is valid markdown with the gaps validate names', () => {
    const t = readmeSkeleton('Hava Notu', '2026-11-06');
    const s = parseStoreReadme(t);
    expect(s.tagline).toBeNull();
    expect(s.whatsNew[0]).toEqual({ version: '1', date: '2026-11-06', notes: ['First version.'] });
    expect(storeReadiness(s).missing).toEqual(['tagline', 'about']);
  });

  it('the publish edits write the tagline and a numbered What\'s new entry, leaving the rest byte for byte', () => {
    const out = applyStoreEdits(README, { name: 'Hava Notu', tagline: 'A new line.', note: 'Shows the wind.', date: '2026-11-06' });
    const s = parseStoreReadme(out);
    expect(s.tagline).toBe('A new line.');
    expect(s.category).toBe('Weather');
    expect(s.whatsNew[0]).toEqual({ version: '3', date: '2026-11-06', notes: ['Shows the wind.'] });
    expect(s.whatsNew).toHaveLength(3);
    expect(out).toContain('## What it does\nEvery morning');
    // Nothing to change: the same text.
    expect(applyStoreEdits(README, { name: 'Hava Notu', date: '2026-11-06' })).toBe(README);
    // No header and no section yet: both are added.
    const fresh = applyStoreEdits('# Sayac\n\nCounts things.\n', { name: 'Sayac', tagline: 'Counts.', note: 'First version.', date: '2026-11-06' });
    expect(fresh.startsWith('---\ntagline: Counts.\n---\n\n# Sayac')).toBe(true);
    expect(parseStoreReadme(fresh).whatsNew[0].version).toBe('1');
  });
});

describe('the README standard, hostile and odd input', () => {
  it('a long run of spaces in a heading parses at once (no backtracking), and a huge README is read only at its head', () => {
    const evil = `## a${' '.repeat(5000)}x\n### b${' '.repeat(5000)}x\n![](${'!['.repeat(3000)}\n`;
    const t0 = Date.now();
    parseStoreReadme(evil);
    parseStoreReadme(`---\ntagline: x${' '.repeat(50_000)}#\n---\n`);
    parseStoreReadme('# T\n\n' + 'word '.repeat(2_000_000));
    // The two scans that use a regex, each fed its worst input at 500 KB: the screenshot section
    // and the opening paragraph's link strip.
    parseStoreReadme(`# T\n\n## Screenshots\n${'![](a'.repeat(100_000)}\n${'![](a\n'.repeat(50_000)}`);
    parseStoreReadme(`# T\n\n${'[]('.repeat(170_000)}\n`);
    applyStoreEdits(`# T\n\n## What's new\n${'\n'.repeat(500_000)}### 1\n- a\n`, { name: 'T', note: 'n', date: '2026-11-06' });
    applyStoreEdits(`# T\n\n## What's new\n${'\n'.repeat(500_000)}`, { name: 'T', note: 'n', date: '2026-11-06' });
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it('a tagline with a # survives, quoted on write; an unquoted trailing comment is dropped', () => {
    expect(parseStoreReadme('---\ntagline: The #1 habit tracker\n---\n').tagline).toBe('The #1 habit tracker');
    expect(parseStoreReadme('---\ntagline: "The #1 habit tracker"\n---\n').tagline).toBe('The #1 habit tracker');
    expect(parseStoreReadme('---\ncategory: Weather   # optional\n---\n').category).toBe('Weather');
    const out = applyStoreEdits('# A\n', { name: 'A', tagline: 'The #1 habit tracker', date: '2026-11-06' });
    expect(out.startsWith('---\ntagline: "The #1 habit tracker"\n---')).toBe(true);
    expect(parseStoreReadme(out).tagline).toBe('The #1 habit tracker');
  });

  it('CRLF, a BOM and a ## inside a code fence change nothing', () => {
    const s = parseStoreReadme('\uFEFF---\r\ntagline: One.\r\n---\r\n# A\r\n```\r\n## What it does\r\n```\r\n## What it does\r\nReal.\r\n');
    expect(s.tagline).toBe('One.');
    expect(s.about).toBe('Real.');
  });

  it('the next version is one more than the highest whole number, wherever it sits; dates and dotted versions do not count', () => {
    const v = (body: string) => applyStoreEdits(`# A\n\n## What's new\n${body}`, { name: 'A', note: 'n', date: '2026-11-06' });
    expect(parseStoreReadme(v('### 2026-11-01\n- x\n')).whatsNew[0].version).toBe('1');
    expect(parseStoreReadme(v('### 1 · 2026-11-01\n- a\n\n### 2 · 2026-11-02\n- b\n')).whatsNew[0].version).toBe('3');
    expect(parseStoreReadme(v('### 1.4.2\n- x\n')).whatsNew[0].version).toBe('1');
  });

  it('a What\'s new that starts past 64 KB in the publisher\'s own README still numbers on from its entries', () => {
    const big = `# A\n\n${'Long text. '.repeat(20_000)}\n\n## What's new\n\n### 7 · 2026-01-01\n- x\n`;
    expect(big.length).toBeGreaterThan(200_000);
    expect(parseStoreReadme(applyStoreEdits(big, { name: 'A', note: 'n', date: '2026-11-06' }), { full: true }).whatsNew[0].version).toBe('8');
    expect(storeWarnings(big).some((w) => w.includes("What's new"))).toBe(false);
  });

  it('the first publish replaces the skeleton\'s unshipped entry: version 1, dated the day it ships', () => {
    const out = applyStoreEdits(readmeSkeleton('A', '2026-11-01'), { name: 'A', note: 'Hello.', date: '2026-11-06', firstPublish: true });
    expect(parseStoreReadme(out).whatsNew).toEqual([{ version: '1', date: '2026-11-06', notes: ['Hello.'] }]);
    const later = applyStoreEdits(readmeSkeleton('A', '2026-11-01'), { name: 'A', note: 'Hello.', date: '2026-11-06' });
    expect(parseStoreReadme(later).whatsNew.map((e) => e.version)).toEqual(['2', '1']);
  });
});

describe('what it can do, pictures', () => {
  it('says schedules in plain words and lists actions, settings and the assistant', () => {
    expect(scheduleText({ days: 'daily', at: '08:00' }, 'x')).toBe('Every day at 08:00');
    expect(scheduleText({ days: ['mon', 'tue', 'wed', 'thu', 'fri'], at: '09:30' }, 'x')).toBe('Weekdays at 09:30');
    expect(scheduleText({ nonsense: 1 }, 'morning-note')).toBe('morning-note');
    const lines = canLines({ actions: [{ id: 'today', title: "Show today's note", method: 'GET', path: '/x' }], schedules: [{ id: 's', schedule: { days: 'daily', at: '08:00' }, call: { method: 'POST', path: '/y' } }], config: [{ key: 'city', type: 'text', label: 'Which city', required: true }], agent: { own: true, brief: '' } as never });
    expect(lines).toEqual([
      { kind: 'action', text: "Show today's note" },
      { kind: 'schedule', text: 'Every day at 08:00' },
      { kind: 'settings', text: 'Which city' },
      { kind: 'agent', text: 'Its own assistant' },
    ]);
  });

  it('a picture is a data URL only when its bytes are the raster its name says; SVG never', () => {
    const png = renderDefaultIcon('hava-notu', 'Hava Notu');
    expect(imageDataUrl('store/a.png', png, 10_000_000)).toMatch(/^data:image\/png;base64,/);
    expect(imageDataUrl('store/a.jpg', png, 10_000_000)).toBeNull();
    expect(imageDataUrl('icon.svg', Buffer.from('<svg/>'), 10_000)).toBeNull();
    expect(imageDataUrl('store/a.png', png, 10)).toBeNull();
    const page = storePage(README, { actions: [], schedules: [], config: [], agent: null }, (p) => (p === 'store/today.png' ? png : null));
    expect(page.shots).toHaveLength(1);
    expect(page.shots[0].alt).toBe('Today');
  });

  it('an app file is read only inside the app folder, never through a link', () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), 'dc-store-file-')));
    try {
      mkdirSync(join(d, 'app', 'store'), { recursive: true });
      writeFileSync(join(d, 'app', 'store', 'a.png'), 'x');
      writeFileSync(join(d, 'outside.png'), 'y');
      symlinkSync(join(d, 'outside.png'), join(d, 'app', 'store', 'b.png'));
      expect(readAppFile(join(d, 'app'), 'store/a.png', 100)?.toString()).toBe('x');
      expect(readAppFile(join(d, 'app'), 'store/b.png', 100)).toBeNull();
      expect(readAppFile(join(d, 'app'), '../outside.png', 100)).toBeNull();
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it('the gate lets store screenshots travel, nothing else in store/', () => {
    expect(allowedPath('store/today.png')).toBe(true);
    expect(allowedPath('store/today.webp')).toBe(true);
    expect(allowedPath('store/notes.md')).toBe(false);
    expect(allowedPath('store/deep/a.png')).toBe(false);
    const png = renderDefaultIcon('a', 'A');
    const r = runGate([{ path: 'dreamcontext-app.json', mode: '100644', data: Buffer.from('{}') }, { path: 'store/a.png', mode: '100644', data: png }], { mode: 'normal' });
    expect(r.send.map((s) => s.path)).toContain('store/a.png');
  });
});

describe('one icon mask', () => {
  it('reads a PNG back, keeps a drawn tile as it is, and puts a full-bleed square in the rounded tile', () => {
    const tile = decodePng(renderDefaultIcon('hava-notu', 'Hava Notu'))!;
    expect(tile.width).toBe(1024);
    expect(cornersTransparent(tile)).toBe(true);
    expect(maskToTile(tile)).toBeNull();
    const full = { width: 64, height: 64, data: Buffer.alloc(64 * 64 * 4, 200) };
    const masked = maskToTile(full)!;
    expect(pngSize(masked)).toEqual({ width: 1024, height: 1024 });
    const back = decodePng(masked)!;
    expect(cornersTransparent(back)).toBe(true);
    expect(back.data[(512 * 1024 + 512) * 4 + 3]).toBe(200);
    expect(decodePng(encodePng(full))!.data.equals(full.data)).toBe(true);
  });

  it('validate warns on a small, a non-square and a self-tiled icon; the placeholder is known by its bytes', () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), 'dc-store-icon-')));
    try {
      writeFileSync(join(d, 'small.png'), encodePng({ width: 64, height: 64, data: Buffer.alloc(64 * 64 * 4, 255) }));
      writeFileSync(join(d, 'wide.png'), encodePng({ width: 64, height: 32, data: Buffer.alloc(64 * 32 * 4, 255) }));
      writeFileSync(join(d, 'tile.png'), renderDefaultIcon('a', 'A'));
      expect(iconShapeWarnings(join(d, 'small.png'))[0]).toMatch(/smaller than 1024/);
      expect(iconShapeWarnings(join(d, 'wide.png'))[0]).toMatch(/not square/);
      expect(iconShapeWarnings(join(d, 'tile.png'))[0]).toMatch(/corners are transparent/);
      expect(isDefaultIconBytes(renderDefaultIcon('a', 'A'), 'a', 'A')).toBe(true);
      expect(isDefaultIconBytes(renderDefaultIcon('a', 'A'), 'b', 'B')).toBe(false);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

describe('the publish writes the store words, the install preview reads them', () => {
  let home: string;
  let project: string;
  let other: string;
  let root: string;
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'ornek', GIT_AUTHOR_EMAIL: 'ornek@example.com', GIT_COMMITTER_NAME: 'ornek', GIT_COMMITTER_EMAIL: 'ornek@example.com' } });

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'dc-store-')));
    project = join(home, 'ornek-proje');
    other = join(home, 'alici-proje');
    for (const p of [project, other]) mkdirSync(join(p, '_dream_context'), { recursive: true });
    addVault('ornek', project, home);
    addVault('alici', other, home);
    root = join(`${project}-apps`, 'hava-notu');
    mkdirSync(join(root, 'public'), { recursive: true });
    mkdirSync(join(root, 'store'), { recursive: true });
    writeFileSync(join(root, 'dreamcontext-app.json'), JSON.stringify({ slug: 'hava-notu', name: 'Hava Notu', icon: 'icon.png', backend: { command: 'node server.mjs', health: '/health' }, actions: [{ id: 'today', title: "Show today's note", method: 'GET', path: '/api/today' }], schedules: [{ id: 'morning', schedule: { days: 'daily', at: '08:00' }, call: { method: 'POST', path: '/api/note' } }] }));
    writeFileSync(join(root, 'public', 'index.html'), '<!doctype html><h1>Hava Notu</h1>\n');
    writeFileSync(join(root, 'server.mjs'), 'export {};\n');
    writeFileSync(join(root, 'icon.png'), encodePng({ width: 32, height: 32, data: Buffer.alloc(32 * 32 * 4, 180) }));
    writeFileSync(join(root, 'store', 'today.png'), encodePng({ width: 8, height: 5, data: Buffer.alloc(8 * 5 * 4, 90) }));
    writeFileSync(join(root, 'README.md'), '# Hava Notu\n\n## What it does\nWrites a weather note.\n\n## Screenshots\n![Today](store/today.png)\n');
    git(root, 'init', '-q');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'first');
    clearSharedCache();
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('publishes the tagline and the note into the README, writes it back and commits it, and the next note is version 2', async () => {
    const rec = registerApp(home, { projectRoot: project, vault: 'ornek', slug: 'hava-notu', name: 'Hava Notu', root });
    const pv = buildPublishTree(home, rec, { visibility: 'private', login: 'ornek-yayinci', tagline: 'Shows the weather note.' });
    expect(pv.report.ok).toBe(true);
    expect(pv.files.map((f) => f.path)).toContain('store/today.png');
    const host = new LocalHost(join(home, 'host'), 'ornek-yayinci');
    await publishApp(rec, { home, host, visibility: 'private', tagline: 'Shows the weather note.' });
    const local = parseStoreReadme(readFileSync(join(root, 'README.md'), 'utf-8'));
    expect(local.tagline).toBe('Shows the weather note.');
    expect(local.whatsNew[0].notes).toEqual(['First version.']);
    expect(git(root, 'status', '--porcelain').trim()).toBe('');
    expect(git(root, 'log', '-1', '--format=%s').trim()).toBe('Store page: README');

    await publishApp(getApp(home, project, 'hava-notu')!, { home, host, visibility: 'private', note: 'Shows tomorrow too.' });
    const two = parseStoreReadme(readFileSync(join(root, 'README.md'), 'utf-8'));
    expect(two.whatsNew.map((e) => e.version)).toEqual(['2', '1']);

    const reader = new LocalHost(join(home, 'host'), 'ornek-yayinci');
    const prev = await previewInstall({ home, projectRoot: other, ref: 'ornek-yayinci/hava-notu-app', host: reader });
    expect(prev.icon).toMatch(/^data:image\/png;base64,/);
    expect(prev.store.readme.tagline).toBe('Shows the weather note.');
    expect(prev.store.shots).toHaveLength(1);
    expect(prev.store.can.map((c) => c.kind)).toEqual(['action', 'schedule']);
    const list = await listShared(reader, { force: true });
    expect(list.mine[0].tagline).toBe('Shows the weather note.');
  });

  it('commits the README in a repo with no git identity, and puts the folder back when the commit cannot run', () => {
    const bare = join(home, 'bare-app');
    mkdirSync(bare);
    execFileSync('git', ['init', '-q'], { cwd: bare, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
    writeFileSync(join(bare, 'a.txt'), 'a\n');
    git(bare, 'add', '-A');
    git(bare, 'commit', '-qm', 'first');
    // No identity anywhere: the fallback identity commits it.
    const prevGlobal = process.env.GIT_CONFIG_GLOBAL;
    const prevNames = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'].map((k) => [k, process.env[k]] as const);
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    for (const [k] of prevNames) delete process.env[k];
    try {
      expect(writeBackStoreReadme({ root: bare, installId: undefined } as never, '# A\n', null)).toBe(true);
      expect(git(bare, 'status', '--porcelain').trim()).toBe('');
      // A held index lock: the commit fails, the README goes back to what it was, nothing staged.
      const before = readFileSync(join(bare, 'README.md'));
      writeFileSync(join(bare, '.git', 'index.lock'), '');
      expect(writeBackStoreReadme({ root: bare, installId: undefined } as never, '# B\n', before)).toBe(false);
      rmSync(join(bare, '.git', 'index.lock'));
      expect(readFileSync(join(bare, 'README.md'), 'utf-8')).toBe('# A\n');
      expect(git(bare, 'status', '--porcelain').trim()).toBe('');
    } finally {
      if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = prevGlobal;
      for (const [k, v] of prevNames) if (v !== undefined) process.env[k] = v;
    }
  });

  it('writes a copy of someone else\'s app (no git of its own) without a commit, and never through a dangling link', () => {
    const copy = join(home, 'copy-app');
    mkdirSync(copy);
    expect(writeBackStoreReadme({ root: copy, installId: 'x'.repeat(32) } as never, '# C\n', null)).toBe(true);
    expect(readFileSync(join(copy, 'README.md'), 'utf-8')).toBe('# C\n');
    const linked = join(home, 'linked-app');
    mkdirSync(linked);
    symlinkSync(join(home, 'outside-readme.md'), join(linked, 'README.md'));
    expect(writeBackStoreReadme({ root: linked, installId: 'y'.repeat(32) } as never, '# D\n', null)).toBe(false);
    expect(() => readFileSync(join(home, 'outside-readme.md'))).toThrow();
  });

  it('never overwrites a README the publisher changed and did not commit', () => {
    const before = readFileSync(join(root, 'README.md'));
    writeFileSync(join(root, 'README.md'), 'my own edit\n');
    expect(writeBackStoreReadme({ root, installId: undefined } as never, 'new\n', before)).toBe(false);
    expect(readFileSync(join(root, 'README.md'), 'utf-8')).toBe('my own edit\n');
  });
});
