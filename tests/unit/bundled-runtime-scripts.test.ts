import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error — plain .mjs build scripts, no type declarations
import { fetchBundledNode, pinFor, checkArchive } from '../../scripts/fetch-bundled-node.mjs';
// @ts-expect-error — plain .mjs build script
import { buildManifest, compareWithManifest } from '../../scripts/gen-rt-manifest.mjs';
// @ts-expect-error — plain .mjs build script
import { verifyWindowsInstall } from '../../scripts/verify-windows-bundle.mjs';

/**
 * Plan npmsiz-beta W2 L2: the scripts that put the pinned Node into the bundle, record every file
 * the runtime copy takes, and gate a built bundle before it is published (criterion 8).
 */
const ROOT = join(__dirname, '..', '..');
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

describe('fetch-bundled-node: only the pinned archive, only the binary and its licence', () => {
  /** A tar.gz shaped like nodejs.org's, plus pins that name it. */
  function stage(opts: { binIsLink?: boolean } = {}) {
    const dir = tmp('dc-fetch-node-');
    const stem = 'node-v24.21.0-darwin-arm64';
    mkdirSync(join(dir, 'src', stem, 'bin'), { recursive: true });
    if (opts.binIsLink) symlinkSync('/bin/sh', join(dir, 'src', stem, 'bin', 'node'));
    else writeFileSync(join(dir, 'src', stem, 'bin', 'node'), '#!/bin/sh\necho fixture-node\n');
    writeFileSync(join(dir, 'src', stem, 'LICENSE'), 'Node.js licence (fixture)');
    writeFileSync(join(dir, 'src', stem, 'README.md'), 'not taken');
    const archive = join(dir, `${stem}.tar.gz`);
    execFileSync('tar', ['-czf', archive, '-C', join(dir, 'src'), stem]);
    const buf = readFileSync(archive);
    const pins = {
      node: { version: '24.21.0', base: 'https://nodejs.org/dist/v24.21.0/', files: { 'darwin-arm64': { file: `${stem}.tar.gz`, sha256: sha(buf), size: buf.length } } },
      nodeWindows: { files: {} },
    };
    const pinsPath = join(dir, 'pins.json');
    writeFileSync(pinsPath, JSON.stringify(pins));
    return { dir, archive, pinsPath, pins, out: join(dir, 'out') };
  }

  it('writes bin/node (0755), LICENSE-node and a runtime-pin.json naming the binary sha; nothing else', async () => {
    const s = stage();
    try {
      const r = await fetchBundledNode('darwin-arm64', { pinsPath: s.pinsPath, out: s.out, archive: s.archive });
      const bin = join(s.out, 'bin', 'node');
      expect(readFileSync(bin, 'utf-8')).toContain('fixture-node');
      expect(statSync(bin).mode & 0o777).toBe(0o755);
      expect(readFileSync(join(s.out, 'LICENSE-node'), 'utf-8')).toContain('licence');
      const rec = JSON.parse(readFileSync(join(s.out, 'runtime-pin.json'), 'utf-8'));
      expect(rec).toMatchObject({ platform: 'darwin-arm64', version: '24.21.0', binary: 'bin/node', binarySha256: sha(readFileSync(bin)) });
      expect(r.binarySha256).toBe(rec.binarySha256);
      expect(() => statSync(join(s.out, 'README.md'))).toThrow();
    } finally { rmSync(s.dir, { recursive: true, force: true }); }
  });

  it('refuses an archive whose size or sha256 differs from the pin, before unpacking anything', async () => {
    const s = stage();
    try {
      writeFileSync(s.archive, Buffer.concat([readFileSync(s.archive), Buffer.from('x')]));
      await expect(fetchBundledNode('darwin-arm64', { pinsPath: s.pinsPath, out: s.out, archive: s.archive })).rejects.toThrow(/bytes, the pin says/);
      const pin = pinFor(s.pins, 'darwin-arm64');
      expect(() => checkArchive(Buffer.alloc(pin.size), pin)).toThrow(/does not match the pin/);
      expect(() => statSync(s.out)).toThrow();
    } finally { rmSync(s.dir, { recursive: true, force: true }); }
  });

  it('refuses a binary that is a symlink in the archive', async () => {
    const s = stage({ binIsLink: true });
    try {
      await expect(fetchBundledNode('darwin-arm64', { pinsPath: s.pinsPath, out: s.out, archive: s.archive })).rejects.toThrow(/not a regular file/);
      expect(() => statSync(join(s.out, 'bin', 'node'))).toThrow();
    } finally { rmSync(s.dir, { recursive: true, force: true }); }
  });

  it('the real pins are complete for both shipped platforms and point at nodejs.org over https', () => {
    const pins = JSON.parse(readFileSync(join(ROOT, 'assets/runtime-pins.json'), 'utf-8'));
    expect(pinFor(pins, 'darwin-arm64').url).toMatch(/^https:\/\/nodejs\.org\/dist\/v24\.\d+\.\d+\/node-v24\.\d+\.\d+-darwin-arm64\.tar\.gz$/);
    expect(pinFor(pins, 'win-x64').url).toMatch(/^https:\/\/nodejs\.org\/dist\/v24\.\d+\.\d+\/node-v24\.\d+\.\d+-win-x64\.zip$/);
    expect(() => pinFor(pins, 'linux-x64')).toThrow(/unsupported platform/);
    expect(() => pinFor({ ...pins, node: { ...pins.node, base: 'http://nodejs.org/dist/v24.21.0/' } }, 'darwin-arm64')).toThrow(/https/);
  });

  it('the fetched runtime and the generated manifest are gitignored', () => {
    const gi = readFileSync(join(ROOT, '.gitignore'), 'utf-8');
    expect(gi).toContain('/desktop/src-tauri/resources/runtime/');
    expect(gi).toContain('/desktop/src-tauri/resources/rt-manifest.json');
  });
});

describe('gen-rt-manifest: every file of the copy, stable bytes, no links', () => {
  function tree() {
    const dir = tmp('dc-rt-manifest-');
    mkdirSync(join(dir, 'runtime'), { recursive: true });
    mkdirSync(join(dir, 'dist', 'sub'), { recursive: true });
    writeFileSync(join(dir, 'runtime', 'node.exe'), 'node');
    writeFileSync(join(dir, 'dist', 'index.js'), 'cli');
    writeFileSync(join(dir, 'dist', 'sub', 'a.js'), 'a');
    writeFileSync(join(dir, 'other.txt'), 'not listed');
    return dir;
  }
  it('records each regular file of the named parts by its relative path, sorted', () => {
    const dir = tree();
    try {
      const m = buildManifest(dir, ['runtime', 'dist']);
      expect(Object.keys(m.files)).toEqual(['dist/index.js', 'dist/sub/a.js', 'runtime/node.exe']);
      expect(m.files['dist/index.js']).toBe(sha('cli'));
      expect(JSON.stringify(buildManifest(dir, ['dist', 'runtime']))).toBe(JSON.stringify(m));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('refuses a symlink anywhere in a part', () => {
    const dir = tree();
    try {
      symlinkSync('/etc/hosts', join(dir, 'dist', 'link.js'));
      expect(() => buildManifest(dir, ['dist'])).toThrow(/symlink/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('compare: a changed, missing or added file is each named', () => {
    const dir = tree();
    try {
      const m = buildManifest(dir, ['runtime', 'dist']);
      expect(compareWithManifest(dir, m)).toEqual([]);
      writeFileSync(join(dir, 'dist', 'index.js'), 'tampered');
      rmSync(join(dir, 'dist', 'sub', 'a.js'));
      writeFileSync(join(dir, 'runtime', 'extra.dll'), 'x');
      expect(compareWithManifest(dir, m).sort()).toEqual(['changed: dist/index.js', 'missing: dist/sub/a.js', 'not in the manifest: runtime/extra.dll']);
      expect(compareWithManifest(dir, { version: 2, files: {} })).toEqual(['the manifest is not a version 1 manifest']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('verify-windows-bundle (criterion 8): tampered node.exe, unsigned node.exe, a changed dist file each fail', () => {
  const OPENJS = { status: 'Valid', subject: 'CN=OpenJS Foundation, O=OpenJS Foundation, L=San Francisco, S=California, C=US' };
  function install() {
    const dir = tmp('dc-win-install-');
    mkdirSync(join(dir, 'runtime'), { recursive: true });
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'runtime', 'node.exe'), 'MZ fixture node');
    writeFileSync(join(dir, 'runtime', 'runtime-pin.json'), JSON.stringify({ binarySha256: sha('MZ fixture node') }));
    writeFileSync(join(dir, 'dist', 'index.js'), 'cli');
    writeFileSync(join(dir, 'rt-manifest.json'), JSON.stringify(buildManifest(dir, ['runtime', 'dist'])));
    return dir;
  }
  const withInstall = (fn: (d: string) => void) => { const d = install(); try { fn(d); } finally { rmSync(d, { recursive: true, force: true }); } };

  it('passes a whole install signed by the OpenJS Foundation', () => withInstall((d) => {
    expect(verifyWindowsInstall(d, { signature: () => OPENJS })).toEqual([]);
  }));
  it('a tampered node.exe fails its pin and the manifest', () => withInstall((d) => {
    writeFileSync(join(d, 'runtime', 'node.exe'), 'MZ evil');
    const p = verifyWindowsInstall(d, { signature: () => OPENJS });
    expect(p).toContain('runtime/node.exe does not match its pin');
    expect(p).toContain('changed: runtime/node.exe');
  }));
  it('an unsigned node.exe or one signed by someone else fails', () => withInstall((d) => {
    expect(verifyWindowsInstall(d, { signature: () => ({ status: 'NotSigned', subject: '' }) })).toEqual(['runtime/node.exe: Authenticode status NotSigned']);
    expect(verifyWindowsInstall(d, { signature: () => ({ status: 'Valid', subject: 'CN=Example Corp, O=Example Corp' }) })[0]).toMatch(/not the OpenJS Foundation/);
    // Only the exact O= RDN: a longer organisation name or the words inside a CN do not count.
    for (const subject of ['CN=x, O=OpenJS Foundation Fake Ltd, C=US', 'CN="O=OpenJS Foundation", O=Example Corp']) {
      expect(verifyWindowsInstall(d, { signature: () => ({ status: 'Valid', subject }) })[0], subject).toMatch(/not the OpenJS Foundation/);
    }
    expect(verifyWindowsInstall(d, { signature: () => { throw new Error('no powershell'); } })[0]).toMatch(/failed to run/);
  }));
  it('a changed dist file fails', () => withInstall((d) => {
    writeFileSync(join(d, 'dist', 'index.js'), 'changed');
    expect(verifyWindowsInstall(d, { signature: () => OPENJS })).toEqual(['changed: dist/index.js']);
  }));
  it('the CLI refuses to skip the signature check unless told, and only on Windows can it run it', () => {
    const r = (() => { try { execFileSync(process.execPath, [join(ROOT, 'scripts/verify-windows-bundle.mjs'), tmpdir()], { stdio: 'pipe' }); return 0; } catch (e: any) { return e.status; } })();
    expect(r).toBe(process.platform === 'win32' ? 1 : 2);
  });
});

describe.runIf(process.platform === 'darwin')('verify-macos-bundle.sh (criterion 8): each defect fixture fails', () => {
  const SCRIPT = join(ROOT, 'scripts/verify-macos-bundle.sh');
  const NODE_ENTS = join(ROOT, 'desktop/src-tauri/entitlements-node.plist');
  /** A fake bundle of three ad-hoc-signed Mach-O files (copies of /usr/bin/true). */
  function bundle(defect?: 'unsigned-node-addon' | 'extra-entitlement' | 'get-task-allow' | 'no-runtime-flag' | 'no-runtime-node') {
    const dir = tmp('dc-mac-bundle-');
    const app = join(dir, 'X.app');
    const files = { shell: join(app, 'Contents/MacOS/shell'), node: join(app, 'Contents/Resources/runtime/bin/node'), addon: join(app, 'Contents/Resources/native/node-pty/pty.node') };
    for (const f of Object.values(files)) { mkdirSync(join(f, '..'), { recursive: true }); copyFileSync('/usr/bin/true', f); chmodSync(f, 0o755); }
    const sign = (f: string, ...extra: string[]) => execFileSync('codesign', ['-f', '-s', '-', ...extra, f], { stdio: 'pipe' });
    const ents = (xml: string) => { const p = join(dir, `e${Math.random()}.plist`); writeFileSync(p, `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>${xml}</dict></plist>`); return p; };
    sign(files.shell, '--options', defect === 'no-runtime-flag' ? 'library' : 'runtime');
    sign(files.addon, '--options', 'runtime');
    if (defect === 'extra-entitlement') sign(files.node, '--options', 'runtime', '--entitlements', ents('<key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.cs.disable-library-validation</key><true/>'));
    else if (defect === 'get-task-allow') sign(files.node, '--options', 'runtime', '--entitlements', ents('<key>com.apple.security.get-task-allow</key><true/>'));
    else sign(files.node, '--options', 'runtime', '--entitlements', NODE_ENTS);
    if (defect === 'unsigned-node-addon') execFileSync('codesign', ['--remove-signature', files.addon]);
    if (defect === 'no-runtime-node') rmSync(files.node);
    return { dir, app };
  }
  const run = (app: string, team: string) => { try { return { code: 0, out: execFileSync('bash', [SCRIPT, app, team], { encoding: 'utf-8', stdio: 'pipe' }) }; } catch (e: any) { return { code: e.status as number, out: String(e.stdout) }; } };

  it('a clean bundle passes in the test seam', () => {
    const b = bundle();
    try { expect(run(b.app, '--test-adhoc')).toMatchObject({ code: 0 }); } finally { rmSync(b.dir, { recursive: true, force: true }); }
  });
  it.each([
    ['unsigned-node-addon', /pty\.node: unsigned/],
    ['extra-entitlement', /runtime node carries entitlement com\.apple\.security\.cs\.disable-library-validation/],
    ['get-task-allow', /carries get-task-allow/],
    ['no-runtime-flag', /MacOS\/shell: no hardened runtime flag/],
    ['no-runtime-node', /runtime\/bin\/node: missing/],
  ] as const)('%s fails', (defect, why) => {
    const b = bundle(defect);
    try {
      const r = run(b.app, '--test-adhoc');
      expect(r.code).toBe(1);
      expect(r.out).toMatch(why);
    } finally { rmSync(b.dir, { recursive: true, force: true }); }
  });
  it('a node-pty spawn-helper without the execute bit fails (the bundle is read-only on a DMG)', () => {
    const b = bundle();
    try {
      const helper = join(b.app, 'Contents/Resources/native/node-pty/prebuilds/darwin-arm64/spawn-helper');
      mkdirSync(join(helper, '..'), { recursive: true });
      copyFileSync('/usr/bin/true', helper);
      execFileSync('codesign', ['-f', '-s', '-', '--options', 'runtime', helper], { stdio: 'pipe' });
      chmodSync(helper, 0o644);
      const r = run(b.app, '--test-adhoc');
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/spawn-helper is not executable/);
      chmodSync(helper, 0o755);
      expect(run(b.app, '--test-adhoc').code).toBe(0);
    } finally { rmSync(b.dir, { recursive: true, force: true }); }
  });
  it('a runtime node that is not Mach-O fails (it would otherwise skip every check)', () => {
    const b = bundle();
    try {
      writeFileSync(join(b.app, 'Contents/Resources/runtime/bin/node'), '#!/bin/sh\necho not mach-o\n');
      const r = run(b.app, '--test-adhoc');
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/runtime\/bin\/node: not a checked Mach-O binary/);
    } finally { rmSync(b.dir, { recursive: true, force: true }); }
  });
  it('outside the seam an ad-hoc (not our team) signature fails every file', () => {
    const b = bundle();
    try {
      const r = run(b.app, 'PP8PX5BB5P');
      expect(r.code).toBe(1);
      expect(r.out.match(/ad-hoc signed/g)?.length).toBe(3);
    } finally { rmSync(b.dir, { recursive: true, force: true }); }
  });
});
