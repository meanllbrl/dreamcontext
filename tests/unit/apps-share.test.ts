import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { addVault } from '../../src/lib/vaults.js';
import { appHash } from '../../src/lib/apps/bundle.js';
import { getApp, readRegistry, registerApp, registryPath, type AppRecord } from '../../src/lib/apps/registry.js';
import { readAppConfig, setAppConfig, missingRequired, newConfigId } from '../../src/lib/apps/app-config.js';
import { LocalHost } from '../../src/lib/apps/share/host.js';
import { runGate, findingId } from '../../src/lib/apps/share/gate.js';
import { buildPublishTree, publishApp, PublishError, resetUnpublishedCache, unpublishedCached, unpublishedChanges } from '../../src/lib/apps/share/publish.js';
import { appLogoDir, appLogoPath, setAppLogo } from '../../src/lib/apps/app-logo.js';
import { installApp, npmPath, listTrash, previewInstall, restoreFromTrash, uninstallApp, sourceRepo } from '../../src/lib/apps/share/install.js';
import { readConsent } from '../../src/lib/apps/data-consent.js';
import { removePullRecord, writePullRecord } from '../../src/lib/apps/data-conflicts.js';
import { teamHash } from '../../src/lib/apps/data-stage.js';
import { applyUpdate, autoUpdateOne, checkUpdate, detachApp, localEdits, setAutoUpdate, undoUpdate } from '../../src/lib/apps/share/update.js';
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

  it('sends a plain-text native source the server compiles (lib/*.m), and scans it like any text', () => {
    const server = f('server.mjs', "const src = readFileSync(new URL('./lib/sicaklik.m', import.meta.url));");
    const ok = runGate([f('dreamcontext-app.json', '{}'), server, f('lib/sicaklik.m', 'int main(void){return 0;}'), f('lib/probe.sh', 'echo hi')], { mode: 'normal' });
    expect(ok.send.map((s) => s.path)).toEqual(expect.arrayContaining(['lib/sicaklik.m', 'lib/probe.sh']));
    expect(ok.blocks).toEqual([]);
    const leak = runGate([f('dreamcontext-app.json', '{}'), f('lib/sicaklik.m', `// token ${SECRET}`)], { mode: 'normal' });
    expect(leak.ok).toBe(false);
    const bin = runGate([f('dreamcontext-app.json', '{}'), f('lib/sicaklik', 'x'), f('lib/a.o', 'x')], { mode: 'normal' });
    expect(bin.send.map((s) => s.path)).toEqual(['dreamcontext-app.json']);
  });

  it('blocks a publish whose sent code reads a committed file that stays behind', () => {
    const server = f('server.mjs', "import { join } from 'node:path'; const p = join(root, 'tools/reader.sh'); const t = './test/verdict.test.mjs';");
    const r = runGate([f('dreamcontext-app.json', '{}'), server, f('tools/reader.sh', 'puts 1'), f('test/verdict.test.mjs', 'x')], { mode: 'normal' });
    expect(r.ok).toBe(false);
    expect(r.blocks.filter((b) => b.rule === 'referenced-not-sent').map((b) => b.file).sort()).toEqual(['test/verdict.test.mjs', 'tools/reader.sh']);
    // listed through share.include: it goes out and the block is gone
    const inc = runGate([f('dreamcontext-app.json', '{}'), server, f('tools/reader.sh', 'puts 1'), f('test/verdict.test.mjs', 'x')], { mode: 'normal', include: ['tools', 'test'] });
    expect(inc.blocks.filter((b) => b.rule === 'referenced-not-sent')).toEqual([]);
    // a file nothing reads stays quietly
    const quiet = runGate([f('dreamcontext-app.json', '{}'), f('server.mjs', 'x'), f('tools/reader.sh', 'puts 1')], { mode: 'normal' });
    expect(quiet.blocks).toEqual([]);
    expect(quiet.notSent.map((n) => n.path)).toContain('tools/reader.sh');
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
    // Claude publishes now (yayinla-claude), and may pass approvals: a hard finding's own id among
    // them still passes nothing.
    const blocked = buildPublishTree(home, rec, { visibility: 'private', login: 'yayinci' }).report;
    expect(blocked.blocks.length).toBeGreaterThan(0);
    const everyId = [...blocked.blocks, ...blocked.approvable].map((f) => f.id);
    await expect(publishFirst(rec, { approvals: everyId })).rejects.toMatchObject({ code: 'gate_blocked' });
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

  it('a bad settings value fails before anything is installed, and the corrected value installs (A3)', async () => {
    await publishFirst(pubRec());
    const kur = host('kurucu');
    await kur.acceptInvitation((await kur.listInvitations())[0].id);
    const pv = await previewInstall({ home, projectRoot: instProject, ref: 'yayinci/tahmin-app', host: kur });
    const before = readRegistry(home).length;
    await expect(installApp({ home, projectRoot: instProject, vault: 'kurucu', previewId: pv.previewId, sha: pv.sha, config: { insight: 'Günlük yük' }, npm: false }))
      .rejects.toMatchObject({ code: 'bad_value', message: expect.stringContaining('Which insight takes its short name') });
    expect(readRegistry(home).length).toBe(before);
    // The preview is still there: a second try is not told "this preview is gone".
    const { rec } = await installApp({ home, projectRoot: instProject, vault: 'kurucu', previewId: pv.previewId, sha: pv.sha, config: { insight: 'gunluk-yuk' }, npm: false });
    expect(readAppConfig(home, rec.configId)).toEqual({ insight: 'gunluk-yuk' });
  });

  it("npm is looked up on node's folder, the server PATH and the login PATH (A1)", () => {
    const sep = process.platform === 'win32' ? ';' : ':';
    const p = npmPath({ PATH: ['/usr/bin', '/bin'].join(sep) } as NodeJS.ProcessEnv, ['/opt/homebrew/bin', '/usr/bin', '/Users/x/.nvm/bin'].join(sep)).split(sep);
    expect(p[0]).toBe(dirname(process.execPath));
    expect(p).toEqual(expect.arrayContaining(['/usr/bin', '/bin', '/opt/homebrew/bin', '/Users/x/.nvm/bin']));
    expect(p.filter((x) => x === '/usr/bin')).toHaveLength(1);
    expect(npmPath({ PATH: '/usr/bin' } as NodeJS.ProcessEnv, null)).toContain('/usr/bin');
  });

  it('a .DS_Store in the installed folder is not an edit (A5)', async () => {
    const { inst } = await installed();
    expect(localEdits(home, inst)).toBeNull();
    writeFileSync(join(inst.root, '.DS_Store'), 'x');
    writeFileSync(join(inst.root, 'public', '.DS_Store'), 'x');
    expect(localEdits(home, inst)).toBeNull();
    writeFileSync(join(inst.root, 'public', 'mine.js'), 'x');
    expect(localEdits(home, inst)?.files).toEqual(['public/mine.js']);
    // A copy installed before the rule existed gets it on the next look (Undo's status reads the file).
    const ex = join(sourceRepo(home, inst.installId!), 'info', 'exclude');
    writeFileSync(ex, readFileSync(ex, 'utf-8').replace('.DS_Store\n', ''));
    localEdits(home, inst);
    expect(readFileSync(ex, 'utf-8').split('\n')).toContain('.DS_Store');
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
    await expect(applyUpdate(home, inst, { sha: 'f'.repeat(40) })).rejects.toThrow(/changed since the card/);
    await applyUpdate(home, inst, { sha: (c as { sha: string }).sha });
    expect(readFileSync(join(inst.root, 'public', 'app.js'), 'utf-8')).toBe('export const x = 2;\n');
    expect(createHash('sha256').update(readFileSync(join(home, '.dreamcontext', 'apps', 'config', `${inst.configId}.json`))).digest('hex')).toBe(cfgSha);
    expect(readFileSync(join(data, 'state.json'), 'utf-8')).toBe('{"n":1}');
    await undoUpdate(home, inst);
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
    await expect(applyUpdate(home, inst, { sha: (c as { sha: string }).sha })).rejects.toThrow(/changes what the app may do/);
    // The installer (or the app's own assistant) changes the copy.
    writeFileSync(join(inst.root, 'public', 'index.html'), '<h1>mine</h1>\n');
    c = await checkUpdate(home, getApp(home, instProject, 'tahmin')!, kur);
    expect((c as { edited: { files: string[] } }).edited.files).toEqual(['public/index.html']);
    await expect(applyUpdate(home, inst, { sha: (c as { sha: string }).sha, approveManifest: true })).rejects.toThrow(/You changed this app/);
    await applyUpdate(home, inst, { sha: (c as { sha: string }).sha, approveManifest: true, how: 'merge' });
    expect(readFileSync(join(inst.root, 'public', 'index.html'), 'utf-8')).toBe('<h1>mine</h1>\n');
    expect(JSON.parse(readFileSync(join(inst.root, 'dreamcontext-app.json'), 'utf-8')).mcp).toEqual(['meta-ads']);
    // Both sides change the same line: nothing changes.
    writeFileSync(join(inst.root, 'public', 'app.js'), 'export const x = "mine";\n');
    await republish('public/app.js', 'export const x = "theirs";\n');
    c = await checkUpdate(home, getApp(home, instProject, 'tahmin')!, kur);
    expect((c as { wouldLose: string[] }).wouldLose).toEqual(['public/app.js']);
    await expect(applyUpdate(home, inst, { sha: (c as { sha: string }).sha, how: 'merge' })).rejects.toThrow(/same lines/);
    expect(readFileSync(join(inst.root, 'public', 'app.js'), 'utf-8')).toBe('export const x = "mine";\n');
    const r = await applyUpdate(home, inst, { sha: (c as { sha: string }).sha, how: 'set-aside' });
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
    // A copy of a restricted app is never published again (owner decision 6).
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
    // The owner's own logo leaves with the settings and comes back with them (app-logo.ts).
    setAppLogo(home, inst.configId!, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]));
    // The owner's team-data consent goes with the trash entry and comes back with it (app-veri-ortak K3).
    mkdirSync(join(home, '.dreamcontext', 'apps', 'share'), { recursive: true });
    writeFileSync(join(home, '.dreamcontext', 'apps', 'share', `${inst.hash}.json`), JSON.stringify({ approved: [], excluded: ['notes/'], declined: false, at: '2026-11-10T00:00:00.000Z' }), { flag: 'w' });
    const t = uninstallApp(home, getApp(home, instProject, 'tahmin')!);
    expect(readConsent(home, inst.hash)).toBeNull();
    expect(appLogoPath(home, inst.configId)).toBeNull();
    expect(getApp(home, instProject, 'tahmin')).toBeNull();
    expect(existsSync(inst.root)).toBe(false);
    expect(listTrash(home, realpathSync(instProject)).map((x) => x.id)).toEqual([t.id]);
    const back = restoreFromTrash(home, t.id);
    expect(back.hash).toBe(inst.hash);
    expect(readAppConfig(home, back.configId)).toEqual({ insight: 'benim-insight' });
    expect(readFileSync(join(back.root, 'public', 'app.js'), 'utf-8')).toBe('export const x = 1;\n');
    expect(appLogoPath(home, back.configId)).toBe(join(appLogoDir(home), `${back.configId}.jpg`));
    expect(readConsent(home, back.hash)?.excluded).toEqual(['notes/']);
  });

  it('installs onto the team\'s data folder under its slug; an open team pull of that folder refuses the install (app-veri-ortak K9)', async () => {
    // The teammate's data for `tahmin` came with the brain: tracked, on disk.
    git(instProject, 'init', '-q');
    const team = join(instProject, '_dream_context', 'apps', 'tahmin', 'notes');
    mkdirSync(team, { recursive: true });
    writeFileSync(join(team, 'a.json'), '{"note":"from the team"}');
    git(instProject, 'add', '-f', '--', '_dream_context/apps/tahmin/notes/a.json');
    // A pull of that folder is open on this Mac: its record sits under the team key.
    writePullRecord(home, { v: 1, hash: teamHash(instProject, 'tahmin'), slug: 'tahmin', preHead: null, mergeHead: null, phase: 'parked', parked: [], plan: null, at: new Date().toISOString() });
    await expect(installed()).rejects.toMatchObject({ code: 'team_pull_open' });
    expect(getApp(home, instProject, 'tahmin')).toBeNull();
    removePullRecord(home, teamHash(instProject, 'tahmin'));
    // No pull open: it installs under the same slug and the team's file is untouched.
    const kur = host('kurucu');
    const pv = await previewInstall({ home, projectRoot: instProject, ref: 'https://github.com/yayinci/tahmin-app', host: kur });
    const { rec: inst, renamed } = await installApp({ home, projectRoot: instProject, vault: 'kurucu', previewId: pv.previewId, sha: pv.sha, npm: false });
    expect(renamed).toBe(false);
    expect(inst.slug).toBe('tahmin');
    expect(readFileSync(join(team, 'a.json'), 'utf-8')).toBe('{"note":"from the team"}');
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

describe('review fixes', () => {
  async function setup(visibility: 'private' | 'public' = 'private') {
    const rec = pubRec();
    if (visibility === 'public') await publishApp(rec, { home, host: host('yayinci'), visibility: 'public', confirmName: 'Tahmin' });
    else await publishFirst(rec);
    const kur = host('kurucu');
    if (visibility === 'private') { const inv = await kur.listInvitations(); await kur.acceptInvitation(inv[0].id); }
    const pv = await previewInstall({ home, projectRoot: instProject, ref: 'yayinci/tahmin-app', host: kur });
    const { rec: inst } = await installApp({ home, projectRoot: instProject, vault: 'kurucu', previewId: pv.previewId, sha: pv.sha, config: { insight: 'x-insight' }, npm: false });
    return { kur, inst };
  }
  const commitPub = async (file: string, text: string, opts: Partial<Parameters<typeof publishApp>[1]> = {}) => {
    writeFileSync(join(appRoot, file), text);
    git(appRoot, 'add', '-A');
    git(appRoot, 'commit', '-qm', 'c');
    return publishApp(getApp(home, pubProject, 'tahmin')!, { home, host: host('yayinci'), visibility: 'private', ...opts });
  };

  it('the commit note is gated like the files', async () => {
    await expect(publishFirst(pubRec(), { note: 'fixed for ayse@ornek.co' })).rejects.toMatchObject({ code: 'gate_blocked' });
  });

  it('a private publish onto a public repo is refused', async () => {
    await publishApp(pubRec(), { home, host: host('yayinci'), visibility: 'public', confirmName: 'Tahmin' });
    await expect(commitPub('public/app.js', 'export const x = 9;\n')).rejects.toMatchObject({ code: 'already_public' });
  });

  it('A2: every refusal that needs a new repo names --fresh, and --fresh gets there (repo gone, public, foreign history)', async () => {
    const freshNamed = (e: unknown) => { expect((e as PublishError).message).toContain('--fresh'); return true; };
    // The repo is gone (deleted on the host): repo_changed, then a fresh publish makes a new one.
    await publishFirst(pubRec());
    // Deleted on github.com: the repo and its record are gone.
    rmSync(join(hostDir, 'yayinci', 'tahmin-app.git'), { recursive: true, force: true });
    rmSync(join(hostDir, 'yayinci', 'tahmin-app.json'), { force: true });
    await expect(commitPub('public/app.js', 'export const x = 4;\n')).rejects.toMatchObject({ code: 'repo_changed' });
    await commitPub('public/app.js', 'export const x = 5;\n').catch(freshNamed);
    const r1 = await publishApp(getApp(home, pubProject, 'tahmin')!, { home, host: host('yayinci'), visibility: 'private', fresh: true });
    expect(r1.fullName).toBe('yayinci/tahmin-public');
    expect(getApp(home, pubProject, 'tahmin')!.publish?.fullName).toBe('yayinci/tahmin-public');
    // The next plain update goes to the new repo.
    expect((await commitPub('public/app.js', 'export const x = 6;\n')).fullName).toBe('yayinci/tahmin-public');
    // Foreign history on the new repo: refused naming --fresh; a fresh publish with another name goes.
    const w = join(home, 'hand2');
    execFileSync('git', ['clone', '-q', join(hostDir, 'yayinci', 'tahmin-public.git'), w]);
    writeFileSync(join(w, 'README.md'), 'hand\n');
    git(w, 'commit', '-qam', 'by hand');
    git(w, 'push', '-q', 'origin', 'HEAD:main');
    await commitPub('public/app.js', 'export const x = 7;\n').then(() => { throw new Error('should refuse'); }, (e) => { expect(e).toMatchObject({ code: 'foreign_history' }); freshNamed(e); });
    await expect(publishApp(getApp(home, pubProject, 'tahmin')!, { home, host: host('yayinci'), visibility: 'private', fresh: true })).rejects.toMatchObject({ code: 'repo_exists' });
    const r2 = await publishApp(getApp(home, pubProject, 'tahmin')!, { home, host: host('yayinci'), visibility: 'private', fresh: true, repoName: 'tahmin-v2' });
    expect(r2.fullName).toBe('yayinci/tahmin-v2');
  });

  it('A2: already_public names --fresh, and a fresh private publish leaves the public repo as it is', async () => {
    await publishApp(pubRec(), { home, host: host('yayinci'), visibility: 'public', confirmName: 'Tahmin' });
    const e = await commitPub('public/app.js', 'export const x = 9;\n').catch((x) => x);
    expect(e).toMatchObject({ code: 'already_public' });
    expect((e as PublishError).message).toContain('--fresh');
    const r = await publishApp(getApp(home, pubProject, 'tahmin')!, { home, host: host('yayinci'), visibility: 'private', fresh: true, repoName: 'tahmin-team' });
    expect(r.fullName).toBe('yayinci/tahmin-team');
    expect((await host('yayinci').getRepo('yayinci/tahmin-team'))?.private).toBe(true);
    expect((await host('yayinci').getRepo('yayinci/tahmin-app'))?.private).toBe(false);
  });

  it('an update that rewrites history is refused (forward only)', async () => {
    const { kur, inst } = await setup();
    const w = join(home, 'rewrite');
    execFileSync('git', ['clone', '-q', join(hostDir, 'yayinci', 'tahmin-app.git'), w]);
    writeFileSync(join(w, 'public', 'app.js'), 'rewritten\n');
    git(w, 'commit', '-q', '--amend', '-am', 'rewritten');
    git(w, 'push', '-q', '-f', 'origin', 'HEAD:main');
    expect(await checkUpdate(home, inst, kur)).toMatchObject({ state: 'problem', code: 'not_forward' });
  });

  it('Undo refuses when the copy changed after the update, and keeps that change', async () => {
    const { kur, inst } = await setup();
    await commitPub('public/app.js', 'export const x = 2;\n');
    const c = await checkUpdate(home, getApp(home, instProject, 'tahmin')!, kur);
    await applyUpdate(home, inst, { sha: (c as { sha: string }).sha });
    writeFileSync(join(inst.root, 'public', 'index.html'), 'after the update\n');
    await expect(undoUpdate(home, inst)).rejects.toThrow(/changed after the update/);
    expect(readFileSync(join(inst.root, 'public', 'index.html'), 'utf-8')).toBe('after the update\n');
  });

  it('an install click is bound to the sha the preview showed', async () => {
    await publishFirst(pubRec());
    const kur = host('kurucu');
    await kur.acceptInvitation((await kur.listInvitations())[0].id);
    const pv = await previewInstall({ home, projectRoot: instProject, ref: 'yayinci/tahmin-app', host: kur });
    await expect(installApp({ home, projectRoot: instProject, vault: 'kurucu', previewId: pv.previewId, sha: 'a'.repeat(40), npm: false })).rejects.toMatchObject({ code: 'stale_preview' });
  });

  it('a temporary error is not stored as lost access', async () => {
    const { inst } = await setup();
    const flaky = Object.assign(Object.create(host('kurucu')), { getRepo: async () => { throw new Error('offline'); } });
    expect(await checkUpdate(home, inst, flaky)).toMatchObject({ state: 'problem', code: 'fetch_failed' });
    expect(getApp(home, instProject, 'tahmin')!.source?.problem).toBeUndefined();
  });

  it('restore never overwrites or deletes data that took the place', async () => {
    const { inst } = await setup();
    const data = join(instProject, '_dream_context', 'apps', 'tahmin');
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, 'a.json'), 'A');
    const t = uninstallApp(home, getApp(home, instProject, 'tahmin')!, { deleteData: true });
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, 'b.json'), 'B');
    expect(() => restoreFromTrash(home, t.id)).toThrow(/nothing was restored/);
    expect(readFileSync(join(home, '.dreamcontext', 'apps', 'trash', t.id, 'data', 'a.json'), 'utf-8')).toBe('A');
    expect(readFileSync(join(data, 'b.json'), 'utf-8')).toBe('B');
    expect(existsSync(inst.root)).toBe(false);
  });

  it('share.include travels and installs', async () => {
    const m = JSON.parse(readFileSync(join(appRoot, 'dreamcontext-app.json'), 'utf-8'));
    m.share = { include: ['assets'] };
    writeFileSync(join(appRoot, 'dreamcontext-app.json'), JSON.stringify(m));
    mkdirSync(join(appRoot, 'assets'), { recursive: true });
    writeFileSync(join(appRoot, 'assets', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    git(appRoot, 'add', '-A');
    git(appRoot, 'commit', '-qm', 'assets');
    const { inst } = await setup();
    expect(readFileSync(join(inst.root, 'assets', 'logo.svg'), 'utf-8')).toContain('<svg');
  });

  it('a copy of an MIT app is shared again under the new name, with the source named', async () => {
    const { kur, inst } = await setup('public');
    const own = detachApp(home, inst);
    expect(own.provenance).toEqual({ fullName: 'yayinci/tahmin-app', license: 'MIT' });
    // On one test Mac the original's login is also a vault name here: those lines are the owner's to tick.
    const approvals = buildPublishTree(home, own, { visibility: 'private', login: 'kurucu' }).report.approvable.map((a) => a.id);
    await expect(publishApp(own, { home, host: kur, visibility: 'private', approvals })).resolves.toMatchObject({ fullName: 'kurucu/tahmin-app' });
    const readme = execFileSync('git', ['--git-dir', join(hostDir, 'kurucu', 'tahmin-app.git'), 'show', 'main:README.md'], { encoding: 'utf-8' });
    expect(readme).toContain('Derived from yayinci/tahmin-app (MIT).');
    const lic = execFileSync('git', ['--git-dir', join(hostDir, 'kurucu', 'tahmin-app.git'), 'show', 'main:LICENSE'], { encoding: 'utf-8' });
    expect(lic).toMatch(/^MIT License/);
  });

  it('a dependency install that fails after an update is said, not swallowed', async () => {
    const { kur, inst } = await setup();
    writeFileSync(join(appRoot, 'package-lock.json'), JSON.stringify({ name: 'tahmin', lockfileVersion: 3, requires: true, packages: { '': { name: 'tahmin', dependencies: {} } } }));
    await commitPub('package.json', JSON.stringify({ name: 'tahmin', version: '1.0.0', dependencies: { 'left-pad': '1.3.0' } }));
    const c = await checkUpdate(home, getApp(home, instProject, 'tahmin')!, kur);
    const r = await applyUpdate(home, inst, { sha: (c as { sha: string }).sha });
    expect(r.depsFailed).toMatch(/npm ci failed/);
    expect(getApp(home, instProject, 'tahmin')!.source?.lastUpdate?.depsFailed).toMatch(/npm ci failed/);
  }, 120_000);

  it('a following copy cannot be published as its installer\'s own', async () => {
    const { kur, inst } = await setup('public');
    await expect(publishApp(inst, { home, host: kur, visibility: 'private' })).rejects.toMatchObject({ code: 'not_yours' });
  });
});

// keep the import used
void PublishError;

describe('the unpublished band (app-onay-karti end review r1)', () => {
  it('a new commit keeps the last answer while it recomputes; a new publish starts from nothing', async () => {
    resetUnpublishedCache();
    const rec = pubRec();
    setAppConfig(home, rec.configId!, [{ key: 'insight', type: 'insight', label: 'I', required: true }], { insight: 'gelir-raporu' });
    await publishFirst(rec);
    const now = () => getApp(home, pubProject, 'tahmin')!;
    const commit = (x: number) => { writeFileSync(join(appRoot, 'public', 'app.js'), `export const x = ${x};\n`); git(appRoot, 'add', '-A'); git(appRoot, 'commit', '-q', '-m', `v${x}`); };
    expect(unpublishedCached(now())).toEqual({ value: false, fresh: false });
    expect(unpublishedChanges(home, now())).toBe(false);
    expect(unpublishedCached(now())).toEqual({ value: false, fresh: true });
    commit(2);
    expect(unpublishedChanges(home, now())).toBe(true);
    // Another commit: the band stays up (stale) until the recompute, never blinks out.
    commit(3);
    expect(unpublishedCached(now())).toEqual({ value: true, fresh: false });
    expect(unpublishedChanges(home, now())).toBe(true);
    // A new publish: the last yes belonged to the old publish, so nothing shows until recomputed.
    await publishApp(now(), { home, host: host('yayinci'), visibility: 'private' });
    expect(unpublishedCached(now())).toEqual({ value: false, fresh: false });
    expect(unpublishedChanges(home, now())).toBe(false);
  });
});
