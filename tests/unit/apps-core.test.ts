import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeAppPath } from '../../src/lib/apps/safe-path.js';
import { parseManifest } from '../../src/lib/apps/manifest.js';
import { appContaining, appRootFor, getApp, listApps, registerApp, registryPath, updateApp, unregisterApp } from '../../src/lib/apps/registry.js';
import { LineLog, MASK, makeRedactor, parseDotenv } from '../../src/lib/apps/redact.js';
import { maskTarget } from '../../src/lib/mcp-project.js';
import { copyShotToProject, pruneShots, shotPath, writeShot } from '../../src/lib/apps/shots.js';
import { execFileSync } from 'node:child_process';

/** dreamcontext Apps W2 core: the path door, the manifest, the registry, the secret sink, shots. */

const dirs: string[] = [];
const tmp = (p = 'dc-apps-core-') => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('safeAppPath', () => {
  it('keeps ordinary paths, normalized, query untouched', () => {
    expect(safeAppPath('/api/campaigns/pause')).toEqual({ ok: true, path: '/api/campaigns/pause' });
    expect(safeAppPath('/a/./b/../c?x=%2F&y=1')).toEqual({ ok: true, path: '/a/c?x=%2F&y=1' });
    expect(safeAppPath('/x%20y')).toEqual({ ok: true, path: '/x%20y' });
  });
  it('refuses every escape, and no output ever starts with //', () => {
    const bad = ['//evil', '/\\evil', '/a\tb', '/x/../__dc', '/%5f%5fdc', '/.//evil.com', '/x/..//evil.com', '/x/..%2f__dc',
      '/%255f%255fdc', '/%5cevil.com', '/%09/evil.com', '/%0d%0aX:1', '/%zz', '/.%2f/evil', '/.%252f%252fevil', '/%2e//evil.com',
      '/..//evil', 'evil', '', '/__dc', '/__dc/api/x', '/ok#frag', '/literal%25'];
    for (const b of bad) {
      const r = safeAppPath(b);
      expect(r.ok, b).toBe(false);
    }
    for (const g of ['/a', '/a/b?c=//d', '/%41']) {
      const r = safeAppPath(g);
      expect(r.ok && !r.path.startsWith('//')).toBe(true);
    }
  });
});

describe('manifest', () => {
  it('parses a full manifest and names every problem with a fix', () => {
    const root = tmp();
    writeFileSync(join(root, 'icon.png'), 'x');
    const ok = parseManifest(JSON.stringify({
      slug: 'meta-ads', name: 'Meta\nAds', icon: 'icon.png',
      backend: { command: 'node s.mjs', health: '/health' },
      actions: [{ id: 'pause', title: 'Pause a campaign', method: 'post', path: '/api/pause', danger: true }],
      schedules: [{ id: 'sync', schedule: { days: 'daily', at: '09:00' }, call: { method: 'POST', path: '/api/sync' } }],
      mcp: ['21st-magic', 'foo.bar'],
    }), root);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.manifest.name).toBe('Meta Ads');
      expect(ok.manifest.actions[0]).toMatchObject({ id: 'pause', method: 'POST', danger: true });
      expect(ok.manifest.mcp).toEqual(['21st-magic', 'foo.bar']);
    }
    const bad = parseManifest(JSON.stringify({
      slug: 'Bad Slug', icon: '../outside.png', backend: { command: '', health: '//evil' },
      actions: [{ id: 'x', title: 't', method: 'TRACE', path: '/a' }, { id: 'y', title: 't', method: 'GET', path: '/__dc/api' }],
    }), root);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      const fields = bad.errors.map((e) => e.field);
      for (const f of ['slug', 'name', 'icon', 'backend.command', 'backend.health', 'actions[0].method', 'actions[1].path']) expect(fields).toContain(f);
      for (const e of bad.errors) expect(e.fix.length).toBeGreaterThan(5);
    }
  });
  it('refuses actions and schedules without a backend; warns on unguarded', () => {
    const root = tmp();
    const r = parseManifest(JSON.stringify({ slug: 'a', name: 'A', actions: [{ id: 'x', title: 'X', method: 'GET', path: '/x' }] }), root);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.field)).toContain('backend');
    const u = parseManifest(JSON.stringify({ slug: 'a', name: 'A', backend: { command: 'x', health: '/h', unguarded: true } }), root);
    expect(u.ok && u.warnings.some((w) => w.field === 'backend.unguarded')).toBe(true);
  });
  it('refuses an icon reached through a symlink out of the app', () => {
    const root = tmp();
    const outside = tmp();
    writeFileSync(join(outside, 'x.png'), 'x');
    symlinkSync(join(outside, 'x.png'), join(root, 'icon.png'));
    const r = parseManifest(JSON.stringify({ slug: 'a', name: 'A', icon: 'icon.png' }), root);
    expect(r.ok).toBe(false);
  });
});

describe('registry', () => {
  it('registers beside the project, 0600, finds apps by cwd on a segment boundary', () => {
    const home = tmp();
    const proj = join(tmp(), 'acme');
    mkdirSync(proj);
    const root = appRootFor(proj, 'a');
    expect(root).toBe(join(proj + '-apps', 'a'));
    mkdirSync(root, { recursive: true });
    mkdirSync(appRootFor(proj, 'ab'), { recursive: true });
    const rec = registerApp(home, { projectRoot: proj, vault: 'acme', slug: 'a', name: 'A', root });
    if (process.platform !== 'win32') expect(statSync(registryPath(home)).mode & 0o777).toBe(0o600); // Windows has no POSIX mode bits
    expect(getApp(home, proj, 'a')?.hash).toBe(rec.hash);
    expect(listApps(home, proj)).toHaveLength(1);
    expect(appContaining(home, join(root, 'public'))?.slug).toBe('a');
    expect(appContaining(home, appRootFor(proj, 'ab'))).toBeNull();
    expect(updateApp(home, proj, 'a', { stoppedByOwner: true, gwPort: 51000 })).toMatchObject({ stoppedByOwner: true, gwPort: 51000 });
    expect(updateApp(home, proj, 'a', { stoppedByOwner: false })?.stoppedByOwner).toBeUndefined();
    expect(JSON.parse(readFileSync(registryPath(home), 'utf-8')).apps[0].gwPort).toBe(51000);
    expect(unregisterApp(home, proj, 'a')?.slug).toBe('a');
    expect(listApps(home)).toHaveLength(0);
  });
  it('a write never replaces an unreadable registry with an empty one', () => {
    const home = tmp();
    const proj = join(tmp(), 'acme');
    mkdirSync(proj);
    const root = appRootFor(proj, 'a');
    mkdirSync(root, { recursive: true });
    registerApp(home, { projectRoot: proj, vault: 'acme', slug: 'a', name: 'A', root });
    const good = readFileSync(registryPath(home), 'utf-8');
    writeFileSync(registryPath(home), good.slice(0, 20));
    expect(listApps(home)).toEqual([]);
    expect(() => updateApp(home, proj, 'a', { stoppedByOwner: true })).toThrow();
    expect(readFileSync(registryPath(home), 'utf-8')).toBe(good.slice(0, 20));
  });
});

describe('the secret sink', () => {
  it('masks values raw, url-encoded, json-escaped and base64; short values only under secret keys', () => {
    const r = makeRedactor([
      { key: 'API_KEY', value: 'sk-live-1234/5678' },
      { key: 'PORT', value: '3000' },
      { key: 'PIN', value: '4821' },
      { key: 'MULTI', value: 'line-one-secret\nline-two-secret' },
    ]);
    expect(r('a sk-live-1234/5678 b')).toBe(`a ${MASK} b`);
    expect(r(`u=${encodeURIComponent('sk-live-1234/5678')}`)).toBe(`u=${MASK}`);
    expect(r(Buffer.from('sk-live-1234/5678').toString('base64'))).toBe(MASK);
    expect(r('port 3000 pin 4821')).toBe(`port 3000 pin ${MASK}`);
    expect(r('x line-two-secret y')).toBe(`x ${MASK} y`);
    expect(r('Authorization: Bearer abcdefghijk')).toBe(`Authorization: Bearer ${MASK}`);
    expect(r('next https://g.example/v1?after=2&access_token=EAAB123&x=1')).toBe(`next https://g.example/v1?after=2&access_token=${MASK}&x=1`);
  });
  it('joins split chunks into lines before masking (a token split across writes is still caught)', () => {
    const log = new LineLog(makeRedactor([{ key: 'DC_TOKEN', value: 'tok_ABCDEFGHIJKL' }]));
    log.write('start tok_ABCD');
    log.write('EFGHIJKL end\nnext');
    log.flush();
    expect(log.tail()).toEqual([`start ${MASK} end`, 'next']);
  });
  it('parses .env and maskTarget hides a query string', () => {
    expect(parseDotenv('export A="x y"\n# c\nB=2 # note\n')).toEqual([{ key: 'A', value: 'x y' }, { key: 'B', value: '2' }]);
    expect(maskTarget('https://mcp.example/sse?key=abc')).toBe('https://mcp.example/sse?••••');
  });
});

describe('shots', () => {
  const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('rest')]);
  it('writes 0600 under the app hash, refuses non-PNG, prunes after 30 min', () => {
    const home = tmp();
    const id = 'a'.repeat(24);
    const p = writeShot(home, '0123456789abcdef', id, PNG);
    expect(p).toBe(shotPath(home, '0123456789abcdef', id));
    if (process.platform !== 'win32') expect(statSync(p).mode & 0o777).toBe(0o600); // Windows has no POSIX mode bits
    expect(() => writeShot(home, '0123456789abcdef', 'b'.repeat(24), Buffer.from('nope'))).toThrow();
    expect(() => shotPath(home, '0123456789abcdef', '../x')).toThrow();
    pruneShots(home, Date.now() + 31 * 60_000);
    expect(() => statSync(p)).toThrow();
  });
  it('copies into a project only behind a self-ignoring dir; git stages nothing there; symlinks refuse', () => {
    const home = tmp();
    const proj = tmp();
    execFileSync('git', ['init', '-q'], { cwd: proj });
    const ctx = join(proj, '_dream_context');
    mkdirSync(ctx);
    const id = 'c'.repeat(24);
    const src = writeShot(home, '0123456789abcdef', id, PNG);
    const r = copyShotToProject(src, ctx, id);
    expect(r.ok).toBe(true);
    if (r.ok && process.platform !== 'win32') expect(statSync(r.path).mode & 0o777).toBe(0o600); // Windows has no POSIX mode bits
    execFileSync('git', ['add', '-A'], { cwd: proj });
    expect(execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: proj, encoding: 'utf-8' })).not.toMatch(/tmp\/apps/);

    const proj2 = tmp();
    const ctx2 = join(proj2, '_dream_context');
    mkdirSync(ctx2);
    symlinkSync(tmp(), join(ctx2, 'tmp'));
    expect(copyShotToProject(src, ctx2, id).ok).toBe(false);
  });
});
