import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { addVault } from '../../src/lib/vaults.js';
import { appHash } from '../../src/lib/apps/bundle.js';
import { getApp, readRegistry, registerApp, registryPath, type AppRecord } from '../../src/lib/apps/registry.js';
import { readAppConfig, setAppConfig, missingRequired, newConfigId } from '../../src/lib/apps/app-config.js';
import { LocalHost } from '../../src/lib/apps/share/host.js';
import { runGate, findingId } from '../../src/lib/apps/share/gate.js';
import { buildPublishTree, publishApp, PublishError } from '../../src/lib/apps/share/publish.js';
import { installApp, listTrash, previewInstall, restoreFromTrash, uninstallApp, sourceRepo } from '../../src/lib/apps/share/install.js';
import { applyUpdate, autoUpdateOne, checkUpdate, detachApp, setAutoUpdate, undoUpdate } from '../../src/lib/apps/share/update.js';
import { listShared, clearSharedCache } from '../../src/lib/apps/share/shared.js';
import { updateAppShare } from '../../src/lib/apps/registry.js';

/**
 * Shared apps end to end on real git and the local host (paylasilan-app-ler plan r3): publish
 * with no data and a noreply identity, the gate, install, settings, update (forward only, sha
 * bound, manifest re-approval, a changed copy never overwritten), my own copy, re-share licence,
 * uninstall to the trash and restore, a public install with no login.
 */

const SECRET = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123';
let home: string;
let pubProject: string;
let instProject: string;
let hostDir: string;
let appRoot: string;

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Ayşe Yılmaz', GIT_AUTHOR_EMAIL: 'ayse@ornek.co', GIT_COMMITTER_NAME: 'Ayşe Yılmaz', GIT_COMMITTER_EMAIL: 'ayse@ornek.co' } });

function writeApp(root: string, extra: Record<string, string> = {}): void {
  mkdirSync(join(root, 'public'), { recursive: true });
  mkdirSync(join(root, 'test'), { recursive: true });
  const files: Record<string, string> = {
    'dreamcontext-app.json': JSON.stringify({ slug: 'tahmin', name: 'Tahmin', agent: { own: true }, config: [{ key: 'insight', type: 'insight', label: 'Which insight', required: true }, { key: 'API_KEY', type: 'secret', label: 'Key' }] }, null, 2),
    'ASSISTANT.md': '# Tahmin\n\nYou help read a forecast.\n',
    'public/index.html': '<!doctype html><h1>Tahmin</h1>\n',
    'public/app.js': 'export const x = 1;\n',
    'test/app.test.js': 'test\n',
    '.gitignore': '.env\ndata/\n',
    ...extra,
  };
  for (const [p, t] of Object.entries(files)) { mkdirSync(join(root, p, '..'), { recursive: true }); writeFileSync(join(root, p), t); }
}

const host = (login: string | null) => new LocalHost(hostDir, login);

async function publishFirst(rec: AppRecord, opts: Partial<Parameters<typeof publishApp>[1]> = {}) {
  return publishApp(rec, { home, host: host('yayinci'), visibility: 'private', invite: ['kurucu'], ...opts });
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'dc-share-')));
  pubProject = join(home, 'yayinci-proje');
  instProject = join(home, 'kurucu-proje');
  hostDir = join(home, 'host');
  for (const p of [pubProject, instProject]) mkdirSync(join(p, '_dream_context', 'people'), { recursive: true });
  writeFileSync(join(pubProject, '_dream_context', 'people', 'people.json'), JSON.stringify({ version: 1, people: { a: { name: 'Ayşe Yılmaz', emails: ['ayse@ornek.co'] } } }));
  mkdirSync(join(pubProject, '_dream_context', 'lab', 'insights'), { recursive: true });
  writeFileSync(join(pubProject, '_dream_context', 'lab', 'insights', 'gelir-raporu.md'), '# x\n');
  addVault('yayinci', pubProject, home);
  addVault('kurucu', instProject, home);
  appRoot = join(`${pubProject}-apps`, 'tahmin');
  writeApp(appRoot);
  writeFileSync(join(appRoot, '.env'), `API_KEY=${SECRET}\n`);
  mkdirSync(join(appRoot, 'data'), { recursive: true });
  writeFileSync(join(appRoot, 'data', 'private.json'), '{"customer":"x"}');
  git(appRoot, 'init', '-q');
  git(appRoot, 'add', '-A');
  git(appRoot, 'commit', '-q', '-m', 'my private history: Ayşe working at home');
  clearSharedCache();
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const pubRec = () => {
  const r = registerApp(home, { projectRoot: pubProject, vault: 'yayinci', slug: 'tahmin', name: 'Tahmin', root: appRoot });
  return updateAppShare(home, r.projectRoot, r.slug, { configId: newConfigId() })!;
};

describe('the share gate', () => {
  const f = (path: string, text: string, mode = '100644') => ({ path, mode, data: Buffer.from(text) });
  it('blocks the never list, links and hard identity; lists what is not sent; never writes a hard value', () => {
    const r = runGate([
      f('dreamcontext-app.json', '{}'),
      f('.env', `KEY=${SECRET}`),
      f('data/x.json', '{}'),
      f('.mcp.json', '{}'),
      f('CLAUDE.md', 'x'),
      f('public/link.js', 'x', '120000'),
      f('public/a.js', `const mail = "ayse@ornek.co"; const tel = "+90 532 123 45 67";\nconst p = "/Users/ayse/x/";\nconst who = "Ayşe Yılmaz";\nconst k = "${SECRET}";`),
      f('test/x.js', 'x'),
    ], { mode: 'normal', terms: { hard: [{ label: "a person's name", value: 'Ayşe Yılmaz' }], approvable: [] } });
    const rules = r.blocks.map((b) => `${b.rule}:${b.file}`);
    for (const want of ['never:.env', 'never:data/x.json', 'never:.mcp.json', 'never:CLAUDE.md', 'symlink:public/link.js', 'email:public/a.js', 'phone:public/a.js', 'home-path:public/a.js', 'identity:public/a.js', 'anthropic-key:public/a.js']) expect(rules).toContain(want);
    expect(r.notSent.map((n) => n.path)).toContain('test/x.js');
    expect(r.ok).toBe(false);
    const text = JSON.stringify(r);
    for (const secret of [SECRET, 'ayse@ornek.co', 'Ayşe Yılmaz', '532 123']) expect(text).not.toContain(secret);
  });

  it('an approvable word waits for the owner, line by line, and the approval clears exactly that line', () => {
    const files = [f('dreamcontext-app.json', '{}'), f('public/a.js', 'const v = "gelir-raporu";\nconst w = "gelir-raporu";')];
    const terms = { hard: [], approvable: [{ label: 'an insight name', value: 'gelir-raporu' }] };
    const r = runGate(files, { mode: 'normal', terms });
    expect(r.approvable).toHaveLength(2);
    expect(r.ok).toBe(false);
    const one = runGate(files, { mode: 'normal', terms, approvals: new Set([r.approvable[0].id]) });
    expect(one.unapproved).toEqual([r.approvable[1].id]);
    expect(runGate(files, { mode: 'normal', terms, approvals: new Set(r.approvable.map((a) => a.id)) }).ok).toBe(true);
    expect(findingId('generic-word', 'public/a.js', 1, 'gelir-raporu')).toBe(r.approvable[0].id);
  });

  it('refuses image metadata, and at install refuses anything a published app does not hold', () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0, 0, 0, 4]), Buffer.from('tEXtAuth'), Buffer.alloc(4)]);
    const r = runGate([f('dreamcontext-app.json', '{}'), { path: 'public/a.png', mode: '100644', data: png }], { mode: 'normal' });
    expect(r.blocks.map((b) => b.rule)).toContain('image-metadata');
    const i = runGate([f('dreamcontext-app.json', '{}'), f('test/x.js', 'x'), f('.npmrc', 'x')], { mode: 'install' });
    expect(i.blocks.map((b) => `${b.rule}:${b.file}`)).toEqual(expect.arrayContaining(['not-allowed:test/x.js', 'never:.npmrc']));
    const strict = runGate([f('dreamcontext-app.json', '{}')], { mode: 'strict' });
    expect(strict.blocks.map((b) => b.rule)).toEqual(expect.arrayContaining(['no-license', 'no-readme']));
  });
});

describe('registry and settings', () => {
  it('keeps the share fields on a round trip, fails closed, and never lets an installed folder become own', () => {
    const rec = pubRec();
    expect(getApp(home, pubProject, 'tahmin')!.configId).toBe(rec.configId);
    const raw = JSON.parse(readFileSync(registryPath(home), 'utf-8'));
    raw.apps.push({ ...raw.apps[0], slug: 'sneaky', origin: 'own', installId: 'a'.repeat(32) });
    writeFileSync(registryPath(home), JSON.stringify(raw));
    expect(readRegistry(home).find((a) => a.slug === 'sneaky')!.origin).toBe('installed');
    const inst = join(`${instProject}-apps`, 'installed', 'x');
    mkdirSync(inst, { recursive: true });
    expect(() => registerApp(home, { projectRoot: instProject, vault: 'kurucu', slug: 'x', name: 'X', root: inst })).toThrow(/installed app/);
  });

  it('settings live outside the app; a secret is never a setting; required empty is reported', () => {
    const rec = pubRec();
    const fields = [{ key: 'insight', type: 'insight' as const, label: 'I', required: true }, { key: 'API_KEY', type: 'secret' as const, label: 'K', required: true }];
    expect(missingRequired(fields, {}, rec.root)).toEqual(['insight']);
    setAppConfig(home, rec.configId!, fields, { insight: 'gelir-raporu' });
    expect(readAppConfig(home, rec.configId)).toEqual({ insight: 'gelir-raporu' });
    expect(() => setAppConfig(home, rec.configId!, fields, { API_KEY: 'x' })).toThrow(/secret card/);
    expect(existsSync(join(home, '.dreamcontext', 'apps', 'config', `${rec.configId}.json`))).toBe(true);
    expect(readdirSync(rec.root)).not.toContain('config');
  });
});

describe('publish', () => {
  it('sends only committed, allowed files, one noreply UTC commit, no .env, no data, no setting value, no history', async () => {
    const rec = pubRec();
    setAppConfig(home, rec.configId!, [{ key: 'insight', type: 'insight', label: 'I', required: true }], { insight: 'gelir-raporu' });
    const out = await publishFirst(rec);
    expect(out.fullName).toBe('yayinci/tahmin-app');
    const clone = join(home, 'clone');
    execFileSync('git', ['clone', '-q', join(hostDir, 'yayinci', 'tahmin-app.git'), clone]);
    const log = execFileSync('git', ['log', '--format=%an|%ae|%cn|%ce|%cd|%s', '--date=raw'], { cwd: clone, encoding: 'utf-8' }).trim().split('\n');
    expect(log).toHaveLength(1);
    expect(log[0]).toMatch(/^yayinci\|0\+yayinci@users\.noreply\.github\.com\|yayinci\|0\+yayinci@users\.noreply\.github\.com\|\d+ \+0000\|First version$/);
    const files = execFileSync('git', ['ls-files'], { cwd: clone, encoding: 'utf-8' }).trim().split('\n').sort();
    expect(files).toEqual(['.gitignore', 'ASSISTANT.md', 'LICENSE', 'README.md', 'dreamcontext-app.json', 'public/app.js', 'public/index.html']);
    const grep = spawnSync('git', ['grep', '-I', '-i', '-l', '-e', SECRET, '-e', 'gelir-raporu', '-e', 'ayse', '-e', 'Ayşe', '-e', 'customer', 'HEAD'], { cwd: clone, encoding: 'utf-8' });
    expect(grep.stdout.trim()).toBe('');
    expect(readFileSync(join(clone, 'LICENSE'), 'utf-8')).toContain('may not publish, share or sell it');
    const meta = JSON.parse(readFileSync(join(hostDir, 'yayinci', 'tahmin-app.json'), 'utf-8'));
    expect(meta.topics).toEqual(['dreamcontext-app']);
    expect(meta.invitations.map((i: { login: string }) => i.login)).toEqual(['kurucu']);
    expect(getApp(home, pubProject, 'tahmin')!.publish?.fullName).toBe('yayinci/tahmin-app');
  });

  it('stops on an uncommitted change, on a hard match in the code, and on a commit pushed by hand', async () => {
    const rec = pubRec();
    writeFileSync(join(appRoot, 'public', 'app.js'), 'changed\n');
    await expect(publishFirst(rec)).rejects.toMatchObject({ code: 'uncommitted' });
    writeFileSync(join(appRoot, 'public', 'app.js'), 'const who = "Ayşe Yılmaz";\n');
    git(appRoot, 'commit', '-qam', 'name');
    await expect(publishFirst(rec)).rejects.toMatchObject({ code: 'gate_blocked' });
    writeFileSync(join(appRoot, 'public', 'app.js'), 'export const x = 2;\n');
    git(appRoot, 'commit', '-qam', 'clean');
    await publishFirst(rec);
    const w = join(home, 'hand');
    execFileSync('git', ['clone', '-q', join(hostDir, 'yayinci', 'tahmin-app.git'), w]);
    writeFileSync(join(w, 'README.md'), 'hand\n');
    git(w, 'commit', '-qam', 'by hand');
    git(w, 'push', '-q', 'origin', 'HEAD:main');
    writeFileSync(join(appRoot, 'public', 'app.js'), 'export const x = 3;\n');
    git(appRoot, 'commit', '-qam', 'more');
    await expect(publishFirst(getApp(home, pubProject, 'tahmin')!)).rejects.toMatchObject({ code: 'foreign_history' });
  });

  it('a public publish needs the name typed, gets MIT, and installs with no login', async () => {
    const rec = pubRec();
    await expect(publishApp(rec, { home, host: host('yayinci'), visibility: 'public' })).rejects.toMatchObject({ code: 'confirm_name' });
    await publishApp(rec, { home, host: host('yayinci'), visibility: 'public', confirmName: 'Tahmin' });
    const pv = await previewInstall({ home, projectRoot: instProject, ref: 'yayinci/tahmin-app', host: host(null) });
    expect(pv.public).toBe(true);
    expect(pv.license).toBe('MIT');
    const { rec: inst } = await installApp({ home, projectRoot: instProject, vault: 'kurucu', previewId: pv.previewId, sha: pv.sha, npm: false });
    expect(() => setAutoUpdate(home, inst, true)).toThrow(/public app never updates by itself/);
  });
});

describe('install, update, my own copy, uninstall', () => {
  async function installed() {
    const rec = pubRec();
    await publishFirst(rec);
    const kur = host('kurucu');
    const inv = await kur.listInvitations();
    expect(inv.map((i) => i.fullName)).toEqual(['yayinci/tahmin-app']);
    await kur.acceptInvitation(inv[0].id);
    const shared = await listShared(kur, { force: true });
    expect(shared.shared.map((s) => [s.fullName, s.name])).toEqual([['yayinci/tahmin-app', 'Tahmin']]);
    const pv = await previewInstall({ home, projectRoot: instProject, ref: 'https://github.com/yayinci/tahmin-app', host: kur });
    expect(pv.gate.ok).toBe(true);
    expect(pv.warning).toBe('This app was written by yayinci. It runs on your Mac with your permissions.');
    expect(pv.config.map((c) => c.key)).toEqual(['insight', 'API_KEY']);
    const { rec: inst } = await installApp({ home, projectRoot: instProject, vault: 'kurucu', previewId: pv.previewId, sha: pv.sha, config: { insight: 'benim-insight' }, npm: false });
    return { rec, inst, kur };
  }
  const republish = async (file: string, text: string, note = 'Update') => {
    writeFileSync(join(appRoot, file), text);
    git(appRoot, 'add', '-A');
    git(appRoot, 'commit', '-qm', note);
    await publishApp(getApp(home, pubProject, 'tahmin')!, { home, host: host('yayinci'), visibility: 'private', note });
  };

  it('installs outside the app folder with its own hash and settings; a private repo needs access', async () => {
    await expect(previewInstall({ home, projectRoot: instProject, ref: 'yayinci/tahmin-app', host: host('baskasi') })).rejects.toMatchObject({ code: 'not_found' });
    const { inst } = await installed();
    expect(inst.origin).toBe('installed');
    expect(inst.root).toBe(join(realpathSync(`${instProject}-apps`), 'installed', 'tahmin'));
    expect(existsSync(join(inst.root, '.git'))).toBe(false);
    expect(existsSync(sourceRepo(home, inst.installId!))).toBe(true);
    expect(inst.hash).not.toBe(appHash(instProject, 'tahmin'));
    expect(readAppConfig(home, inst.configId)).toEqual({ insight: 'benim-insight' });
    expect(readFileSync(join(inst.root, 'public', 'app.js'), 'utf-8')).toBe('export const x = 1;\n');
    // The same app again gets its own name.
    const pv = await previewInstall({ home, projectRoot: instProject, ref: 'yayinci/tahmin-app', host: host('kurucu') });
    const again = await installApp({ home, projectRoot: instProject, vault: 'kurucu', previewId: pv.previewId, sha: pv.sha, npm: false });
    expect(again.rec.slug).toBe('tahmin-2');
    expect(again.renamed).toBe(true);
  });

  it('an update is forward only, bound to the shown sha, keeps settings and data, and undoes', async () => {
    const { inst, kur } = await installed();
    const data = join(instProject, '_dream_context', 'apps', 'tahmin');
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, 'state.json'), '{"n":1}');
    const cfgSha = createHash('sha256').update(readFileSync(join(home, '.dreamcontext', 'apps', 'config', `${inst.configId}.json`))).digest('hex');
    expect((await checkUpdate(home, inst, kur)).state).toBe('none');
    await republish('public/app.js', 'export const x = 2;\n', 'Faster charts');
    const c = await checkUpdate(home, getApp(home, instProject, 'tahmin')!, kur);
    expect(c).toMatchObject({ state: 'available', manifestChanged: false, edited: null, notes: ['Faster charts'] });
    expect(() => applyUpdate(home, inst, { sha: 'f'.repeat(40) })).toThrow(/changed since the card/);
    applyUpdate(home, inst, { sha: (c as { sha: string }).sha });
    expect(readFileSync(join(inst.root, 'public', 'app.js'), 'utf-8')).toBe('export const x = 2;\n');
    expect(createHash('sha256').update(readFileSync(join(home, '.dreamcontext', 'apps', 'config', `${inst.configId}.json`))).digest('hex')).toBe(cfgSha);
    expect(readFileSync(join(data, 'state.json'), 'utf-8')).toBe('{"n":1}');
    undoUpdate(home, inst);
    expect(readFileSync(join(inst.root, 'public', 'app.js'), 'utf-8')).toBe('export const x = 1;\n');
    expect(getApp(home, instProject, 'tahmin')!.source?.available?.sha).toBe((c as { sha: string }).sha);
  });

  it('a manifest change asks again; a changed copy is never overwritten: merge, conflict, set aside', async () => {
    const { inst, kur } = await installed();
    const m = JSON.parse(readFileSync(join(appRoot, 'dreamcontext-app.json'), 'utf-8'));
    m.mcp = ['meta-ads'];
    await republish('dreamcontext-app.json', JSON.stringify(m, null, 2), 'Uses Meta');
    let c = await checkUpdate(home, getApp(home, instProject, 'tahmin')!, kur);
    expect(c).toMatchObject({ state: 'available', manifestChanged: true, manifestChanges: ['mcp'] });
    expect(() => applyUpdate(home, inst, { sha: (c as { sha: string }).sha })).toThrow(/changes what the app may do/);
    // The installer (or the app's own assistant) changes the copy.
    writeFileSync(join(inst.root, 'public', 'index.html'), '<h1>mine</h1>\n');
    c = await checkUpdate(home, getApp(home, instProject, 'tahmin')!, kur);
    expect((c as { edited: { files: string[] } }).edited.files).toEqual(['public/index.html']);
    expect(() => applyUpdate(home, inst, { sha: (c as { sha: string }).sha, approveManifest: true })).toThrow(/You changed this app/);
    applyUpdate(home, inst, { sha: (c as { sha: string }).sha, approveManifest: true, how: 'merge' });
    expect(readFileSync(join(inst.root, 'public', 'index.html'), 'utf-8')).toBe('<h1>mine</h1>\n');
    expect(JSON.parse(readFileSync(join(inst.root, 'dreamcontext-app.json'), 'utf-8')).mcp).toEqual(['meta-ads']);
    // Both sides change the same line: nothing changes.
    writeFileSync(join(inst.root, 'public', 'app.js'), 'export const x = "mine";\n');
    await republish('public/app.js', 'export const x = "theirs";\n');
    c = await checkUpdate(home, getApp(home, instProject, 'tahmin')!, kur);
    expect((c as { wouldLose: string[] }).wouldLose).toEqual(['public/app.js']);
    expect(() => applyUpdate(home, inst, { sha: (c as { sha: string }).sha, how: 'merge' })).toThrow(/same lines/);
    expect(readFileSync(join(inst.root, 'public', 'app.js'), 'utf-8')).toBe('export const x = "mine";\n');
    const r = applyUpdate(home, inst, { sha: (c as { sha: string }).sha, how: 'set-aside' });
    expect(readFileSync(join(inst.root, 'public', 'app.js'), 'utf-8')).toBe('export const x = "theirs";\n');
    expect(readFileSync(r.patch!, 'utf-8')).toContain('+export const x = "mine";');
  });

  it('auto-update applies only to a clean copy with the same manifest; my own copy stops updates; re-share follows the licence', async () => {
    const { inst, kur } = await installed();
    setAutoUpdate(home, inst, true);
    await republish('public/app.js', 'export const x = 5;\n');
    expect(await autoUpdateOne(home, getApp(home, instProject, 'tahmin')!, kur)).not.toBeNull();
    writeFileSync(join(inst.root, 'public', 'index.html'), 'edited\n');
    await republish('public/app.js', 'export const x = 6;\n');
    expect(await autoUpdateOne(home, getApp(home, instProject, 'tahmin')!, kur)).toBeNull();
    const own = detachApp(home, getApp(home, instProject, 'tahmin')!);
    expect(own.source).toBeUndefined();
    expect(own.origin).toBe('installed');
    expect(own.provenance).toEqual({ fullName: 'yayinci/tahmin-app', license: 'restricted' });
    expect((await checkUpdate(home, own, kur)).state).toBe('problem');
    git(own.root, 'init', '-q');
    git(own.root, 'add', '-A');
    git(own.root, 'commit', '-qm', 'mine');
    await expect(publishApp(own, { home, host: kur, visibility: 'private' })).rejects.toMatchObject({ code: 'license_forbids' });
  });

  it('losing access deletes nothing; uninstall goes to the trash and restores with the same hash', async () => {
    const { inst, kur } = await installed();
    const meta = join(hostDir, 'yayinci', 'tahmin-app.json');
    const j = JSON.parse(readFileSync(meta, 'utf-8'));
    j.collaborators = [];
    writeFileSync(meta, JSON.stringify(j));
    expect(await checkUpdate(home, inst, kur)).toMatchObject({ state: 'problem', code: 'no_access' });
    expect(existsSync(join(inst.root, 'public', 'app.js'))).toBe(true);
    const t = uninstallApp(home, getApp(home, instProject, 'tahmin')!);
    expect(getApp(home, instProject, 'tahmin')).toBeNull();
    expect(existsSync(inst.root)).toBe(false);
    expect(listTrash(home, realpathSync(instProject)).map((x) => x.id)).toEqual([t.id]);
    const back = restoreFromTrash(home, t.id);
    expect(back.hash).toBe(inst.hash);
    expect(readAppConfig(home, back.configId)).toEqual({ insight: 'benim-insight' });
    expect(readFileSync(join(back.root, 'public', 'app.js'), 'utf-8')).toBe('export const x = 1;\n');
  });

  it('a repo that moved to another owner gets no update', async () => {
    const { inst, kur } = await installed();
    const meta = join(hostDir, 'yayinci', 'tahmin-app.json');
    const j = JSON.parse(readFileSync(meta, 'utf-8'));
    j.ownerId = 'local-someone-else';
    writeFileSync(meta, JSON.stringify(j));
    expect(await checkUpdate(home, inst, kur)).toMatchObject({ state: 'problem', code: 'moved' });
  });
});

describe('the publish preview', () => {
  it('names the approvable words of this project and the files that stay home', () => {
    writeFileSync(join(appRoot, 'public', 'app.js'), 'const insight = "gelir-raporu";\n');
    git(appRoot, 'commit', '-qam', 'insight');
    const pv = buildPublishTree(home, pubRec(), { visibility: 'private', login: 'yayinci' });
    expect(pv.report.approvable.map((a) => [a.file, a.term])).toEqual([['public/app.js', 'gelir-raporu']]);
    expect(pv.report.notSent.map((n) => n.path)).toEqual(expect.arrayContaining(['test/app.test.js', '.gitignore']));
    expect(pv.report.ok).toBe(false);
  });
});

describe('askpass', () => {
  it('hands the token to github.com only', () => {
    const tok = join(home, 'tok');
    writeFileSync(tok, 'TOKEN123');
    const run = (prompt: string) => spawnSync(process.execPath, [resolve('src/lib/git-sync/askpass.cjs'), prompt], { env: { ...process.env, DREAMCONTEXT_ASKPASS_TOKEN_FILE: tok }, encoding: 'utf-8' });
    expect(run("Password for 'https://x-access-token@github.com': ").stdout).toBe('TOKEN123');
    const evil = run("Password for 'https://x-access-token@evil.example': ");
    expect(evil.stdout).toBe('');
    expect(evil.status).toBe(1);
  });
});

// keep the import used
void PublishError;
