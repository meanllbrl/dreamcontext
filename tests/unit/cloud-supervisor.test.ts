import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, copyFileSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeBuildFingerprint } from '../../src/server/cloud-fingerprint.js';
import { CloudStateStore, parseTripRecord } from '../../src/server/cloud-state.js';
import { seamRefusal } from '../../src/cli/commands/cloud.js';
// @ts-expect-error: a plain .mjs script (copied verbatim into the private repo), no types.
import {
  CLONE_NAME, CLI_WRAPPER, RELOCK_INTERVAL_MS, checkoutCompromised, compromisedStartRefusal, gitConfigRisks, scanCheckout, computeFingerprint, restoreLastGood, swapInBuild, writeCliWrapper, copyVerifiers, ensureInstalled, fetchVerified, installInto, INTEGRITY_RE, isPin, lockdownClones, NPM_CONFIG_ARGS, NPM_CWD, readRuntimeRequest,
  repoPin, SEMVER_RE, setShForTests, validMirrorPath,
} from '../../cloud/supervisor.mjs';
import { INTEGRITY_RE as TS_INTEGRITY_RE, SEMVER_RE as TS_SEMVER_RE } from '../../src/lib/handsfree/npm-pin.js';
import { HANDSFREE_REPO_NAME } from '../../src/lib/handsfree/codespaces.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cloud-sup-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('build fingerprint (AC18)', () => {
  it('the root supervisor and the server compute the same pinned hash', () => {
    mkdirSync(join(dir, 'dist', 'dashboard', 'assets'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'index.js'), 'console.log(1)\n');
    writeFileSync(join(dir, 'dist', 'dashboard', 'index.html'), '<html></html>');
    writeFileSync(join(dir, 'dist', 'dashboard', 'assets', 'a.js'), 'x');
    symlinkSync('index.js', join(dir, 'dist', 'link.js')); // skipped by both
    writeFileSync(join(dir, 'package.json'), '{}'); // outside dist: not part of the build
    const ts = computeBuildFingerprint(dir);
    expect(ts).toMatch(/^[0-9a-f]{64}$/);
    expect(computeFingerprint(dir)).toBe(ts);
    writeFileSync(join(dir, 'dist', 'dashboard', 'assets', 'a.js'), 'y');
    expect(computeBuildFingerprint(dir)).not.toBe(ts);
    expect(computeFingerprint(dir)).toBe(computeBuildFingerprint(dir));
  });

  it('no dist, no fingerprint', () => {
    expect(computeBuildFingerprint(dir)).toBeNull();
    expect(computeFingerprint(dir)).toBeNull();
  });
});

describe('mirror path the supervisor mounts on', () => {
  it('accepts only a plain home path', () => {
    expect(validMirrorPath('/Users/someone')).toBe(true);
    expect(validMirrorPath('/home/someone')).toBe(true);
    for (const bad of ['/etc', '/Users/../etc', '/Users/a/b', '/Users/', 'Users/a', '/opt/x', '/Users/a;b', 42]) {
      expect(validMirrorPath(bad)).toBe(false);
    }
  });
});

describe('test seams', () => {
  it('are refused inside a codespace and as root', () => {
    expect(seamRefusal({ CODESPACES: 'true' }, 1000)).toMatch(/codespace/);
    expect(seamRefusal({}, 0)).toMatch(/root/);
    expect(seamRefusal({}, 501)).toBeNull();
  });
});

describe('cloud trip state', () => {
  it('a missing or corrupt record reads as sealed (fail closed)', () => {
    expect(parseTripRecord(null).phase).toBe('sealed');
    expect(parseTripRecord({ phase: 'open' }).phase).toBe('sealed');
    writeFileSync(join(dir, 'cloud-trip.json'), '{not json');
    expect(new CloudStateStore({ dir }).phase()).toBe('sealed');
  });

  it('persists every transition before it takes effect', () => {
    const a = new CloudStateStore({ dir, now: () => 1000 });
    expect(a.startTrip({ tripId: 't1', laptopId: 'l1', go: {}, rootIds: [], takeOver: false }).ok).toBe(true);
    expect(a.activate('t1').ok).toBe(true);
    const q = a.quiesce('t1');
    expect(q.ok && q.epoch).toBe(1);
    const b = new CloudStateStore({ dir });
    expect(b.phase()).toBe('quiescing');
    expect(b.epochMatches(1)).toBe(true);
    expect(b.epochMatches(0)).toBe(false);
  });
});

// The tests are not root: "root" (and the checkout's owner) is this test's own uid.
const TRUST = { rootUid: process.getuid!(), repoOwners: [process.getuid!()] };

/** A real `npm pack`-shaped tarball (package/package.json) and npm's sha512 integrity of it. */
function makeTgz(where: string, version: string, name = 'dreamcontext', extra = '', shrinkwrap = true): { path: string; integrity: string } {
  const src = mkdtempSync(join(where, 'pkgsrc-'));
  mkdirSync(join(src, 'package', 'dist'), { recursive: true });
  writeFileSync(join(src, 'package', 'package.json'), JSON.stringify({ name, version }));
  writeFileSync(join(src, 'package', 'dist', 'index.js'), `// ${name} ${version}${extra}\n`);
  if (shrinkwrap) writeFileSync(join(src, 'package', 'npm-shrinkwrap.json'), JSON.stringify({ name, version, lockfileVersion: 3, packages: {} }));
  const path = join(where, `${name}-${version}${extra ? '-x' : ''}.tgz`);
  // COPYFILE_DISABLE: macOS tar would add AppleDouble `._package` entries (npm pack never does).
  execFileSync('tar', ['-czf', path, '-C', src, 'package'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  return { path, integrity: `sha512-${createHash('sha512').update(readFileSync(path)).digest('base64')}` };
}

describe('the pin shapes are the laptop\'s (drift)', () => {
  it('the supervisor mirrors npm-pin.ts exactly', () => {
    expect(SEMVER_RE.source).toBe(TS_SEMVER_RE.source);
    expect(INTEGRITY_RE.source).toBe(TS_INTEGRITY_RE.source);
    for (const bad of ['latest', '^0.30.0', '0.30', '0.30.x', '>=0.30.0', '0.30.0 || 1.0.0', '01.2.3', '0.30.0+build']) expect(SEMVER_RE.test(bad)).toBe(false);
    for (const ok of ['0.30.0', '1.2.3-beta.1']) expect(SEMVER_RE.test(ok)).toBe(true);
    expect(isPin({ version: '0.30.0', integrity: 'sha256-abc' })).toBe(false);
  });
});

describe('the build comes from npm at exactly the pinned version, sha512-verified (D25)', () => {
  let fetchDir: string;
  beforeEach(() => { fetchDir = join(dir, 'fetch'); mkdirSync(fetchDir); });
  /** The injected `npm pack dreamcontext@<v>`: hands back whatever "the registry" serves. */
  const serving = (tgz: string) => {
    const asked: string[] = [];
    return { asked, fetchTarball: (version: string, into: string) => { asked.push(version); const p = join(into, `dreamcontext-${version}.tgz`); copyFileSync(tgz, p); return p; } };
  };

  it('an integrity-matched tarball of the exact version is accepted', () => {
    const t = makeTgz(dir, '0.30.0');
    const r = serving(t.path);
    expect(fetchVerified({ version: '0.30.0', integrity: t.integrity }, fetchDir, { fetchTarball: r.fetchTarball })).toBe(join(fetchDir, 'dreamcontext-0.30.0.tgz'));
    expect(r.asked).toEqual(['0.30.0']);
  });

  it('a tampered tarball (sha512 differs from the pin) is refused', () => {
    const good = makeTgz(dir, '0.30.0');
    const evil = makeTgz(dir, '0.30.0', 'dreamcontext', 'planted');
    expect(() => fetchVerified({ version: '0.30.0', integrity: good.integrity }, fetchDir, serving(evil.path))).toThrow(/has sha512 .* not the pinned .*; refused/);
  });

  it('a different version (even with its own matching integrity) is refused, and so is another package', () => {
    const other = makeTgz(dir, '0.29.0');
    expect(() => fetchVerified({ version: '0.30.0', integrity: other.integrity }, fetchDir, serving(other.path))).toThrow(/tarball is dreamcontext 0\.29\.0, not 0\.30\.0/);
    const foreign = makeTgz(dir, '0.30.0', 'evil-pkg');
    expect(() => fetchVerified({ version: '0.30.0', integrity: foreign.integrity }, fetchDir, serving(foreign.path))).toThrow(/tarball is evil-pkg, not dreamcontext/);
  });

  it('a range, a tag or a non-sha512 integrity never reaches the fetch', () => {
    const t = makeTgz(dir, '0.30.0');
    for (const pin of [{ version: 'latest', integrity: t.integrity }, { version: '^0.30.0', integrity: t.integrity }, { version: '0.30.0', integrity: 'sha1-abc' }]) {
      const r = serving(t.path);
      expect(() => fetchVerified(pin, fetchDir, r)).toThrow(/not an exact version with a sha512 integrity/);
      expect(r.asked).toEqual([]);
    }
  });

  it('the runtime request dcserver writes is read no-follow, shape-checked and removed', () => {
    const t = makeTgz(dir, '0.30.0');
    const req = join(dir, 'runtime-request.json');
    writeFileSync(req, JSON.stringify({ version: '0.30.0', integrity: t.integrity }));
    expect(readRuntimeRequest(req)).toEqual({ version: '0.30.0', integrity: t.integrity });
    expect(existsSync(req)).toBe(false);
    writeFileSync(req, JSON.stringify({ version: 'latest', integrity: t.integrity }));
    expect(() => readRuntimeRequest(req)).toThrow(/not an exact version/);
    writeFileSync(join(dir, 'root-file'), JSON.stringify({ version: '0.30.0', integrity: t.integrity }));
    symlinkSync(join(dir, 'root-file'), req);
    expect(() => readRuntimeRequest(req)).toThrow(/ELOOP/);
    expect(existsSync(join(dir, 'root-file'))).toBe(true);
    expect(() => lstatSync(req)).toThrow(/ENOENT/); // the link itself is gone
    writeFileSync(req, 'x'.repeat(5000));
    expect(() => readRuntimeRequest(req)).toThrow(/not a small regular file/);
  });
});

describe('install order when /opt has no build (D25)', () => {
  let ws: string; let runtime: string; let lines: string[]; let t: { path: string; integrity: string };
  beforeEach(() => {
    ws = join(dir, 'workspaces'); runtime = join(dir, 'dc-runtime'); lines = [];
    mkdirSync(ws); mkdirSync(runtime);
    t = makeTgz(dir, '0.30.0');
  });
  /** A locked-down checkout (root-owned in real life: this uid here) holding the pin. */
  const checkout = (pin: unknown, repo = 'dreamcontext-handsfree') => {
    const b = join(ws, repo, '.devcontainer', 'bootstrap');
    mkdirSync(b, { recursive: true });
    writeFileSync(join(b, 'version.json'), JSON.stringify(pin));
  };
  const run = (o: { lastGood?: boolean; served?: string } = {}) => {
    const installed: Array<[string, string | null]> = [];
    const asked: string[] = [];
    const lastGood = join(runtime, 'last-good.tgz');
    if (o.lastGood) writeFileSync(lastGood, 'last good');
    const r = ensureInstalled({
      entry: join(dir, 'opt', 'dist', 'index.js'), lastGood,
      pin: () => repoPin({ workspaces: ws, logLine: (m: string) => lines.push(m), trust: TRUST }),
      fetch: (p: { version: string; integrity: string }) => {
        const d = mkdtempSync(join(runtime, 'fetch-'));
        const tgz = fetchVerified(p, d, { fetchTarball: (v: string, into: string) => { asked.push(v); const f = join(into, `dreamcontext-${v}.tgz`); copyFileSync(o.served ?? t.path, f); return f; } });
        return { tgz, cleanup: () => rmSync(d, { recursive: true, force: true }) };
      },
      install: (spec: string, version: string | null) => { installed.push([spec, version]); }, logLine: (m: string) => lines.push(m),
    });
    return { r, installed, asked, lastGood };
  };

  it('1: the last good build on /workspaces first (the pin is not consulted, npm is not asked)', () => {
    checkout({ version: '0.30.0', integrity: t.integrity });
    const { r, installed, asked, lastGood } = run({ lastGood: true });
    expect(r).toBe(true);
    expect(installed).toEqual([[lastGood, null]]);
    expect(asked).toEqual([]);
  });

  it('2: else exactly the pinned version from npm, sha512-checked, then promoted to LAST_GOOD; a rebuild reinstalls LAST_GOOD, never the checkout', () => {
    checkout({ version: '0.30.0', integrity: t.integrity });
    mkdirSync(join(ws, 'dc-home', '.devcontainer', 'bootstrap'), { recursive: true }); // dc-* never counts
    const first = run();
    expect(first.r).toBe(true);
    expect(first.asked).toEqual(['0.30.0']);
    expect(first.installed).toEqual([[expect.stringMatching(/dreamcontext-0\.30\.0\.tgz$/), '0.30.0']]);
    expect(readFileSync(first.lastGood).equals(readFileSync(t.path))).toBe(true);
    expect(lstatSync(first.lastGood).mode & 0o777).toBe(0o600);
    expect(lines.at(-1)).toMatch(/from dreamcontext 0\.30\.0 from npm \(the repo's version pin\)/);
    // A later pin in the checkout (stale or planted) is never read again: /opt wiped -> LAST_GOOD.
    checkout({ version: '0.31.0', integrity: t.integrity });
    const again = run();
    expect(again.installed).toEqual([[again.lastGood, null]]);
    expect(again.asked).toEqual([]);
  });

  it('3: a tampered tarball from "npm" is refused: nothing installed, no LAST_GOOD', () => {
    checkout({ version: '0.30.0', integrity: t.integrity });
    const evil = makeTgz(dir, '0.30.0', 'dreamcontext', 'planted');
    const { r, installed, lastGood } = run({ served: evil.path });
    expect(r).toBe(false);
    expect(installed).toEqual([]);
    expect(existsSync(lastGood)).toBe(false);
    expect(lines.join('\n')).toMatch(/dreamcontext 0\.30\.0 from npm not installed: .*not the pinned/);
  });

  it('4: no last good, no pin: NOTHING is installed, npm is not asked, and a clear line is logged', () => {
    const { r, installed, asked } = run();
    expect(r).toBe(false);
    expect(installed).toEqual([]);
    expect(asked).toEqual([]);
    expect(lines).toEqual([expect.stringMatching(/^no build to install: .*nothing unpinned is ever installed/)]);
    // A pin with a range or a tag is no pin.
    checkout({ version: 'latest', integrity: t.integrity });
    expect(run().installed).toEqual([]);
    expect(lines.join('\n')).toMatch(/is not an exact version with a sha512 integrity/);
    // The supervisor source names no tag or range anywhere in code.
    const src = readFileSync(join(__dirname, '..', '..', 'cloud', 'supervisor.mjs'), 'utf8');
    expect(src).not.toMatch(/@latest|['"`]dreamcontext['"`]\s*\]/);
  });

  it('5: an installed build is left alone', () => {
    mkdirSync(join(dir, 'opt', 'dist'), { recursive: true });
    writeFileSync(join(dir, 'opt', 'dist', 'index.js'), '');
    const { r, installed } = run({ lastGood: true });
    expect(r).toBe(false);
    expect(installed).toEqual([]);
    expect(lines).toEqual([]);
  });
});

describe('the repo checkout is untrusted until root locks it down (AC19)', () => {
  const PUSH = { generation: 3, passphrase: { alg: 'scrypt', hash: 'h' }, transferSha256: 'a'.repeat(64) };
  const PIN = { version: '0.30.0', integrity: `sha512-${createHash('sha512').update('x').digest('base64')}` };
  let ws: string; let lines: string[]; let repo: string;
  const log = (m: string) => lines.push(m);
  beforeEach(() => {
    ws = join(dir, 'workspaces'); lines = [];
    repo = join(ws, 'dreamcontext-handsfree');
    mkdirSync(ws);
  });
  /** The checkout as GitHub's clone leaves it under the default ACL other::rwx: everything writable by others (dcuser). */
  const writableClone = (files: Record<string, Buffer | string>) => {
    const b = join(repo, '.devcontainer', 'bootstrap');
    mkdirSync(b, { recursive: true });
    for (const [n, v] of Object.entries(files)) { writeFileSync(join(b, n), v); chmodSync(join(b, n), 0o666); }
    for (const d of [repo, join(repo, '.devcontainer'), b]) chmodSync(d, 0o777);
  };
  const pinFiles = () => ({ 'version.json': JSON.stringify(PIN) });
  const lockdown = () => lockdownClones({ workspaces: ws, chown: () => {}, reown: () => {}, owners: [process.getuid!()], stripAcl: () => {}, logLine: log, compromisedFile: join(dir, 'cc'), runtime: dir });
  const pin = () => repoPin({ workspaces: ws, logLine: log, trust: TRUST });

  it('a pin planted in a dcuser-writable checkout is refused; after the lockdown the same checkout is read', () => {
    writableClone(pinFiles());
    expect(pin()).toBeNull();
    expect(lines.join('\n')).toMatch(/version pin in .* refused \(.* is writable by group or others\)/);
    lockdown();
    for (const p of [repo, join(repo, '.devcontainer'), join(repo, '.devcontainer', 'bootstrap'), join(repo, '.devcontainer', 'bootstrap', 'version.json')]) {
      expect(statSync(p).mode & 0o022).toBe(0);
    }
    expect(pin()).toEqual(PIN);
  });

  it('a writable FILE alone (dirs locked) is refused too', () => {
    writableClone(pinFiles());
    lockdown();
    chmodSync(join(repo, '.devcontainer', 'bootstrap', 'version.json'), 0o646);
    expect(pin()).toBeNull();
    expect(lines.join('\n')).toMatch(/version\.json is writable by group or others/);
  });

  it('a writable DIRECTORY alone (files locked) is refused: dcuser could swap the files in it', () => {
    writableClone(pinFiles());
    lockdown();
    chmodSync(join(repo, '.devcontainer', 'bootstrap'), 0o757);
    expect(pin()).toBeNull();
    expect(lines.join('\n')).toMatch(/bootstrap is writable by group or others/);
    chmodSync(join(repo, '.devcontainer', 'bootstrap'), 0o755);
    chmodSync(repo, 0o775);
    expect(pin()).toBeNull();
    expect(lines.join('\n')).toMatch(/dreamcontext-handsfree is writable by group or others/);
  });

  it('a symlinked .devcontainer or bootstrap dir is refused; the lockdown leaves the link alone and never follows it', () => {
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(join(elsewhere, 'bootstrap'), { recursive: true });
    writeFileSync(join(elsewhere, 'bootstrap', 'version.json'), JSON.stringify(PIN));
    writeFileSync(join(elsewhere, 'bootstrap', 'verifiers.json'), JSON.stringify(PUSH));
    chmodSync(elsewhere, 0o777);
    mkdirSync(repo);
    symlinkSync(elsewhere, join(repo, '.devcontainer'));
    expect(pin()).toBeNull();
    expect(lines.join('\n')).toMatch(/\.devcontainer is not a plain directory/);
    const dst = join(dir, 'srv-verifiers.json');
    expect(copyVerifiers({ workspaces: ws, dst, owner: null, logLine: log, trust: TRUST })).toBe(false);
    lockdown();
    // r18: a planted link is compromise: moved (never followed) into root's quarantine, flag up.
    expect(() => lstatSync(join(repo, '.devcontainer'))).toThrow();
    expect(statSync(elsewhere).mode & 0o777).toBe(0o777); // never followed
    expect(readFileSync(elsewhere + '/bootstrap/version.json', 'utf8')).toBe(JSON.stringify(PIN));
    expect(lines.join('\n')).toMatch(/COMPROMISED checkout: quarantined \.devcontainer \(a symlink\)/);
    expect(existsSync(join(dir, 'cc'))).toBe(true);
    expect(pin()).toBeNull();

    // The bootstrap dir as a link inside a real .devcontainer.
    lines = [];
    mkdirSync(join(repo, '.devcontainer'));
    chmodSync(join(repo, '.devcontainer'), 0o755);
    symlinkSync(join(elsewhere, 'bootstrap'), join(repo, '.devcontainer', 'bootstrap'));
    expect(pin()).toBeNull();
    expect(lines.join('\n')).toMatch(/bootstrap is not a plain directory/);
    expect(copyVerifiers({ workspaces: ws, dst, owner: null, logLine: log, trust: TRUST })).toBe(false);
    // A symlinked pin file and a symlinked checkout dir are never trusted either.
    rmSync(join(repo, '.devcontainer', 'bootstrap'));
    mkdirSync(join(repo, '.devcontainer', 'bootstrap'));
    chmodSync(join(repo, '.devcontainer', 'bootstrap'), 0o755);
    symlinkSync(join(elsewhere, 'bootstrap', 'version.json'), join(repo, '.devcontainer', 'bootstrap', 'version.json'));
    expect(pin()).toBeNull();
    rmSync(repo, { recursive: true });
    symlinkSync(elsewhere, repo);
    expect(pin()).toBeNull();
  });

  it('verifiers.json from a writable checkout is refused; from a locked one it installs, only over a lower generation, never through a planted link', () => {
    const dst = join(dir, 'srv-verifiers.json');
    const cv = () => copyVerifiers({ workspaces: ws, dst, owner: null, logLine: log, trust: TRUST });
    writableClone({ 'verifiers.json': JSON.stringify(PUSH) });
    expect(cv()).toBe(false);
    expect(existsSync(dst)).toBe(false);
    expect(lines.join('\n')).toMatch(/bootstrap verifiers in .* refused \(.* is writable by group or others\)/);
    lockdown();
    expect(cv()).toBe(true);
    expect(JSON.parse(readFileSync(dst, 'utf8'))).toEqual(PUSH);
    expect(lstatSync(dst).mode & 0o777).toBe(0o600);
    expect(cv()).toBe(false); // same generation: kept
    // dcserver plants dst.tmp as a link to a root file: never written through.
    const victim = join(dir, 'victim');
    writeFileSync(victim, 'root file\n');
    symlinkSync(victim, `${dst}.tmp`);
    const b = join(repo, '.devcontainer', 'bootstrap');
    chmodSync(b, 0o755); chmodSync(join(b, 'verifiers.json'), 0o644);
    writeFileSync(join(b, 'verifiers.json'), JSON.stringify({ ...PUSH, generation: 4 }));
    expect(cv()).toBe(true);
    expect(readFileSync(victim, 'utf8')).toBe('root file\n');
    expect(JSON.parse(readFileSync(dst, 'utf8')).generation).toBe(4);
  });
});

describe('root touches ONLY the private repo\'s checkout, strips setuid, and tightens /workspaces (review r5)', () => {
  const uid = process.getuid!();
  let ws: string; let lines: string[]; let chowned: number[];
  beforeEach(() => { ws = join(dir, 'workspaces'); mkdirSync(ws); lines = []; chowned = []; });
  const lockdown = (owners = [uid]) => lockdownClones({
    workspaces: ws, chown: (fd: number) => { chowned.push(fstatSync(fd).ino); }, reown: () => {}, owners, stripAcl: () => {}, logLine: (m: string) => lines.push(m),
    compromisedFile: join(dir, 'cc'), runtime: dir,
  });
  const mode = (p: string) => lstatSync(p).mode & 0o7777;

  it('the checkout name is the laptop\'s repo name (drift)', () => {
    expect(CLONE_NAME).toBe(HANDSFREE_REPO_NAME);
  });

  it('a dcuser-made /workspaces/evil/.devcontainer with a 4755 file is never chowned or chmodded: it keeps its owner and mode', () => {
    const b = join(ws, 'evil', '.devcontainer', 'bootstrap');
    mkdirSync(b, { recursive: true });
    writeFileSync(join(b, 'tool'), '#!/bin/sh\n');
    chmodSync(join(b, 'tool'), 0o4755);
    for (const d of [join(ws, 'evil'), join(ws, 'evil', '.devcontainer'), b]) chmodSync(d, 0o777);
    const before = lstatSync(join(b, 'tool'));
    lockdown();
    const after = lstatSync(join(b, 'tool'));
    expect(after.uid).toBe(before.uid);
    expect(mode(join(b, 'tool'))).toBe(0o4755);
    for (const d of [join(ws, 'evil'), join(ws, 'evil', '.devcontainer'), b]) expect(mode(d)).toBe(0o777);
    expect(chowned).not.toContain(before.ino);
    expect(chowned).toEqual([]); // no checkout of the private repo here: nothing at all is chowned
  });

  it('the real checkout loses setuid/setgid/sticky and group/other write; its entries are chowned to root', () => {
    const repo = join(ws, CLONE_NAME);
    const b = join(repo, '.devcontainer', 'bootstrap');
    mkdirSync(b, { recursive: true });
    writeFileSync(join(b, 'tool'), '#!/bin/sh\n');
    chmodSync(join(b, 'tool'), 0o4777);
    writeFileSync(join(b, 'version.json'), '{}');
    chmodSync(join(b, 'version.json'), 0o2666);
    chmodSync(b, 0o3777);
    chmodSync(join(repo, '.devcontainer'), 0o1777);
    chmodSync(repo, 0o2777);
    lockdown();
    expect(mode(join(b, 'tool'))).toBe(0o755);
    expect(mode(join(b, 'version.json'))).toBe(0o644);
    expect(mode(b)).toBe(0o755);
    expect(mode(join(repo, '.devcontainer'))).toBe(0o755);
    expect(mode(repo)).toBe(0o700); // r18: dcuser cannot traverse into it at all
    expect(chowned.sort()).toEqual([join(repo, '.devcontainer'), b, join(b, 'tool'), join(b, 'version.json')].map((p) => lstatSync(p).ino).sort());
  });

  it('a checkout owned by anyone but root/codespace (here: an untrusted uid) is skipped and logged, never chowned or chmodded', () => {
    const repo = join(ws, CLONE_NAME);
    const b = join(repo, '.devcontainer', 'bootstrap');
    mkdirSync(b, { recursive: true });
    writeFileSync(join(b, 'tool'), 'x');
    chmodSync(join(b, 'tool'), 0o4777);
    chmodSync(repo, 0o777);
    lockdown([uid + 4242]);
    expect(mode(repo)).toBe(0o777);
    expect(mode(join(b, 'tool'))).toBe(0o4777);
    expect(chowned).toEqual([]);
    expect(lines.join('\n')).toMatch(/is not a plain directory owned by root or codespace .*; skipped/);
    // A checkout that is a link is skipped the same way, its target untouched.
    rmSync(repo, { recursive: true });
    const target = join(dir, 'target');
    mkdirSync(join(target, '.devcontainer'), { recursive: true });
    chmodSync(join(target, '.devcontainer'), 0o777);
    symlinkSync(target, repo);
    lockdown();
    expect(mode(join(target, '.devcontainer'))).toBe(0o777);
    expect(chowned).toEqual([]);
  });

  it('the readers read ONLY the private repo\'s checkout: a well-formed pin and verifiers elsewhere in /workspaces are ignored', () => {
    const PIN = { version: '0.30.0', integrity: `sha512-${createHash('sha512').update('x').digest('base64')}` };
    const other = join(ws, 'aaa-other', '.devcontainer', 'bootstrap');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'version.json'), JSON.stringify(PIN));
    writeFileSync(join(other, 'verifiers.json'), JSON.stringify({ generation: 9, passphrase: { a: 1 }, transferSha256: 'a'.repeat(64) }));
    const trust = { rootUid: uid, repoOwners: [uid] };
    expect(repoPin({ workspaces: ws, logLine: (m: string) => lines.push(m), trust })).toBeNull();
    expect(copyVerifiers({ workspaces: ws, dst: join(dir, 'v.json'), owner: null, logLine: (m: string) => lines.push(m), trust })).toBe(false);
    // The same files in the checkout itself are read.
    const mine = join(ws, CLONE_NAME, '.devcontainer', 'bootstrap');
    mkdirSync(mine, { recursive: true });
    writeFileSync(join(mine, 'version.json'), JSON.stringify(PIN));
    expect(repoPin({ workspaces: ws, logLine: (m: string) => lines.push(m), trust })).toEqual(PIN);
  });

  it('/workspaces loses other-write (dcuser can no longer create entries); the dc-* dirs keep their own modes', () => {
    chmodSync(ws, 0o757);
    mkdirSync(join(ws, 'dc-home'));
    chmodSync(join(ws, 'dc-home'), 0o2775);
    lockdown();
    expect(mode(ws)).toBe(0o755);
    expect(mode(join(ws, 'dc-home'))).toBe(0o2775);
    expect(lines.join('\n')).toMatch(/is no longer writable by others/);
  });
});

describe('root\'s npm reads no config from anywhere dcuser can write (review r5)', () => {
  interface Seen { cmd: string; args: string[]; opts: { cwd?: string; env?: Record<string, string> } }
  let seen: Seen[];
  let served: string;
  const saved: Record<string, string | undefined> = {};
  const LEAKS = ['NPM_CONFIG_REGISTRY', 'npm_config_userconfig', 'NPM_CONFIG_GLOBALCONFIG'];
  beforeEach(() => {
    seen = [];
    for (const k of LEAKS) { saved[k] = process.env[k]; process.env[k] = '/workspaces/dc-home/.npmrc'; }
    setShForTests((cmd: string, args: string[], opts: Seen['opts']) => {
      seen.push({ cmd, args, opts });
      if (cmd === 'npm' && args[0] === 'pack') {
        const dest = args[args.indexOf('--pack-destination') + 1];
        copyFileSync(served, join(dest, 'dreamcontext-0.30.0.tgz'));
        return Buffer.from(JSON.stringify([{ filename: 'dreamcontext-0.30.0.tgz' }]));
      }
      if (cmd === 'npm') return Buffer.alloc(0); // npm ci: the extracted package already holds dist/
      if (cmd === 'tar') return execFileSync(cmd, args);
      return Buffer.alloc(0); // chown/chmod: not as root here
    });
  });
  afterEach(() => {
    setShForTests(null);
    for (const k of LEAKS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });
  const isolated = (s: Seen) => {
    expect(s.opts.cwd).toBe(NPM_CWD);
    expect(NPM_CWD).toBe('/root');
    for (let i = 0; i < NPM_CONFIG_ARGS.length; i += 2) expect(s.args.slice(s.args.indexOf(NPM_CONFIG_ARGS[i]), s.args.indexOf(NPM_CONFIG_ARGS[i]) + 2)).toEqual([NPM_CONFIG_ARGS[i], NPM_CONFIG_ARGS[i + 1]]);
    expect(NPM_CONFIG_ARGS).toEqual(['--userconfig', '/dev/null', '--globalconfig', '/root/.dc-hf-npm/globalconfig', '--cache', '/root/.npm']);
    // npm refuses the same file for both ("double-loading config"): r7 found it on a real npm ci.
    const cfg = (k: string) => NPM_CONFIG_ARGS[NPM_CONFIG_ARGS.indexOf(k) + 1];
    expect(cfg('--userconfig')).not.toBe(cfg('--globalconfig'));
    for (const k of ['--globalconfig', '--cache']) expect(cfg(k).startsWith('/root/')).toBe(true);
    expect(Object.keys(s.opts.env ?? {}).sort()).toEqual(['HOME', 'PATH']);
    expect(s.opts.env!.HOME).toBe('/root');
  };

  it('npm pack of the pinned version runs from /root with no user/global npmrc, root\'s cache and a scratch env', () => {
    const t = makeTgz(dir, '0.30.0');
    served = t.path;
    const fetchDir = mkdtempSync(join(dir, 'fetch-'));
    expect(fetchVerified({ version: '0.30.0', integrity: t.integrity }, fetchDir)).toBe(join(fetchDir, 'dreamcontext-0.30.0.tgz'));
    const pack = seen.find((x) => x.cmd === 'npm')!;
    expect(pack.args.slice(0, 4)).toEqual(['pack', 'dreamcontext@0.30.0', '--pack-destination', fetchDir]);
    isolated(pack);
  });

  it('D26: the package is extracted by root into the prefix and installed with `npm ci` FROM its own shrinkwrap (never `npm i <tgz>`)', () => {
    const t = makeTgz(dir, '0.30.0');
    const prefix = join(dir, 'opt-next');
    installInto(prefix, t.path);
    const npm = seen.filter((x) => x.cmd === 'npm');
    expect(npm).toHaveLength(1);
    const pkgDir = join(prefix, 'node_modules', 'dreamcontext');
    expect(npm[0].args.slice(0, 4)).toEqual(['ci', '--omit=dev', '--omit=optional', '--ignore-scripts']);
    expect(npm[0].args.some((a) => a.endsWith('.tgz') || a === '--prefix')).toBe(false);
    expect(npm[0].opts.cwd).toBe(pkgDir); // npm ci reads the shipped npm-shrinkwrap.json there
    for (let i = 0; i < NPM_CONFIG_ARGS.length; i += 2) expect(npm[0].args).toContain(NPM_CONFIG_ARGS[i]);
    expect(npm[0].args.slice(npm[0].args.indexOf('--userconfig'), npm[0].args.indexOf('--userconfig') + 2)).toEqual(['--userconfig', '/dev/null']);
    expect(npm[0].args.slice(npm[0].args.indexOf('--globalconfig'), npm[0].args.indexOf('--globalconfig') + 2)).toEqual(['--globalconfig', '/root/.dc-hf-npm/globalconfig']);
    expect(Object.keys(npm[0].opts.env ?? {}).sort()).toEqual(['HOME', 'PATH']);
    expect(readFileSync(join(pkgDir, 'dist', 'index.js'), 'utf8')).toBe('// dreamcontext 0.30.0\n');
    expect(existsSync(join(pkgDir, 'npm-shrinkwrap.json'))).toBe(true);
  });

  it('D26: a package without npm-shrinkwrap.json is refused before anything is written or npm runs', () => {
    const t = makeTgz(dir, '0.30.0', 'dreamcontext', '', false);
    const prefix = join(dir, 'opt-next');
    expect(() => installInto(prefix, t.path)).toThrow(/ships no npm-shrinkwrap\.json; refused/);
    expect(seen.filter((x) => x.cmd === 'npm')).toEqual([]);
    expect(existsSync(prefix)).toBe(false);
  });

  it('D26: a tarball entry that escapes package/, is absolute, or is a link is refused; nothing lands outside the prefix', () => {
    /** A crafted tar.gz (python's tarfile writes exactly the headers it is told). */
    const craft = (entries: Array<[string, 'file' | 'symlink' | 'hardlink', string]>) => {
      const out = join(dir, `crafted-${Math.random().toString(36).slice(2)}.tgz`);
      execFileSync('python3', ['-c', `import io, sys, tarfile, json
out, entries = sys.argv[1], json.loads(sys.argv[2])
with tarfile.open(out, 'w:gz', format=tarfile.PAX_FORMAT) as t:
    for name, kind, data in entries:
        ti = tarfile.TarInfo(name)
        if kind == 'file':
            b = data.encode(); ti.size = len(b); t.addfile(ti, io.BytesIO(b))
        else:
            ti.type = tarfile.SYMTYPE if kind == 'symlink' else tarfile.LNKTYPE; ti.linkname = data; t.addfile(ti)
`, out, JSON.stringify(entries)]);
      return out;
    };
    const base: Array<[string, 'file', string]> = [['package/package.json', 'file', '{"name":"dreamcontext","version":"0.30.0"}'], ['package/npm-shrinkwrap.json', 'file', '{}'], ['package/dist/index.js', 'file', '//']];
    const prefix = join(dir, 'opt-next');
    const cases: Array<[Array<[string, 'file' | 'symlink' | 'hardlink', string]>, RegExp]> = [
      [[...base, ['package/../../escaped', 'file', 'x']], /escapes package\//],
      [[...base, ['package/dist/../../../escaped', 'file', 'x']], /escapes package\//],
      [[...base, ['/tmp/abs-escaped', 'file', 'x']], /absolute or malformed/],
      [[...base, ['elsewhere/x', 'file', 'x']], /escapes package\//],
      [[...base, ['package/dist/link', 'symlink', '/etc/passwd']], /not a regular file or directory \(type 2\)/],
      [[...base, ['package/dist/hard', 'hardlink', 'package/package.json']], /not a regular file or directory \(type 1\)/],
      [[...base, [`package/${'d/'.repeat(60)}../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../../escaped`, 'file', 'x']], /escapes package\//],
    ];
    for (const [entries, why] of cases) {
      expect(() => installInto(prefix, craft(entries))).toThrow(why);
      expect(existsSync(prefix)).toBe(false);
    }
    expect(existsSync(join(dir, 'escaped'))).toBe(false);
    expect(existsSync('/tmp/abs-escaped')).toBe(false);
    expect(seen.filter((x) => x.cmd === 'npm')).toEqual([]);
    // The same base alone installs (the checks refuse only the bad entry).
    installInto(prefix, craft(base));
    expect(existsSync(join(prefix, 'node_modules', 'dreamcontext', 'dist', 'index.js'))).toBe(true);
  });

});

describe('the `dreamcontext` command after EVERY install path (review: runtime update left a dangling command)', () => {
  const ENTRY_T = '/opt/dreamcontext/node_modules/dreamcontext/dist/index.js';
  const WANT = `#!/bin/sh\nexec /usr/bin/node ${ENTRY_T} "$@"\n`;
  let bin: string; let wrapper: string; let opt: string; let next: string; let prev: string;
  beforeEach(() => {
    bin = join(dir, 'usr-local-bin'); mkdirSync(bin);
    wrapper = join(bin, 'dreamcontext');
    // An old supervisor's command: a symlink into node_modules/.bin that npm ci no longer creates.
    symlinkSync(join(dir, 'opt', 'node_modules', '.bin', 'dreamcontext'), wrapper);
    opt = join(dir, 'opt'); next = join(dir, 'opt.next'); prev = join(dir, 'opt.prev');
    mkdirSync(join(opt, 'old'), { recursive: true });
    mkdirSync(join(next, 'new'), { recursive: true });
  });
  const isWrapper = () => {
    const st = lstatSync(wrapper);
    return st.isFile() && !st.isSymbolicLink() && (st.mode & 0o777) === 0o755 && readFileSync(wrapper, 'utf8') === WANT && !existsSync(`${wrapper}.tmp`);
  };

  it('the wrapper is fixed content written over whatever is there (a dangling symlink included)', () => {
    expect(CLI_WRAPPER).toBe('/usr/local/bin/dreamcontext');
    expect(existsSync(wrapper)).toBe(false); // dangling
    writeCliWrapper(wrapper, ENTRY_T);
    expect(isWrapper()).toBe(true);
    writeFileSync(`${wrapper}.tmp`, 'a leftover temp file');
    writeCliWrapper(wrapper, ENTRY_T);
    expect(isWrapper()).toBe(true);
  });

  it('a first-boot / last-good install swaps the build in and rewrites the command', () => {
    swapInBuild({ next, opt, wrapper, entry: ENTRY_T });
    expect(existsSync(join(opt, 'new'))).toBe(true);
    expect(existsSync(next)).toBe(false);
    expect(isWrapper()).toBe(true);
  });

  it('a runtime update (exit 75) keeps the old build at prev and rewrites the command', () => {
    swapInBuild({ next, opt, prev, wrapper, entry: ENTRY_T });
    expect(existsSync(join(opt, 'new'))).toBe(true);
    expect(existsSync(join(prev, 'old'))).toBe(true);
    expect(isWrapper()).toBe(true);
  });

  it('the fallback to the last good build rewrites the command too (a failed write is logged, never thrown)', () => {
    swapInBuild({ next, opt, prev, wrapper, entry: ENTRY_T });
    rmSync(wrapper);
    symlinkSync('/nowhere/dreamcontext', wrapper);
    restoreLastGood({ opt, prev, wrapper, entry: ENTRY_T });
    expect(existsSync(join(opt, 'old'))).toBe(true);
    expect(isWrapper()).toBe(true);
    const lines: string[] = [];
    mkdirSync(join(dir, 'p2', 'old'), { recursive: true });
    expect(() => restoreLastGood({ opt, prev: join(dir, 'p2'), wrapper: join(dir, 'no-such-dir', 'dreamcontext'), entry: ENTRY_T, logLine: (m: string) => lines.push(m) })).not.toThrow();
    expect(lines.join('\n')).toMatch(/dreamcontext command not rewritten/);
  });

  it('the runtime install loop goes through these helpers (no install path swaps without the wrapper)', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'cloud', 'supervisor.mjs'), 'utf8');
    const body = src.slice(src.indexOf('async function installRuntime()'), src.indexOf('function watchMirrorRequests()'));
    expect(body).toContain('swapInBuild({ prev: OPT_PREV });');
    expect(body).toContain('restoreLastGood();');
    expect(body).not.toMatch(/renameSync\(/); // every rename of a build goes through the helpers
    const build = src.slice(src.indexOf('function installBuild('), src.indexOf('// ─── the mirror'));
    expect(build).toContain('swapInBuild();');
    expect(build).not.toMatch(/renameSync\(/);
  });
});

describe('smoke #5 / r18 (Critical, AC19): dcuser can never reach the checkout; a checkout it wrote is compromised, never trusted', () => {
  const uid = process.getuid!();
  const PIN = { version: '0.30.0', integrity: `sha512-${createHash('sha512').update('x').digest('base64')}` };
  const VERIFIERS = { generation: 3, passphrase: { alg: 'scrypt', hash: 'h' }, transferSha256: 'a'.repeat(64) };
  const STOCK_CONFIG = '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n[remote "origin"]\n\turl = https://github.com/me/dreamcontext-handsfree\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch "main"]\n\tremote = origin\n\tmerge = refs/heads/main\n';
  let ws: string; let repo: string; let lines: string[]; let stripped: string[]; let stripCalls: string[][]; let flag: string; let runtime: string;
  beforeEach(() => {
    ws = join(dir, 'workspaces'); repo = join(ws, CLONE_NAME); lines = []; stripped = []; stripCalls = [];
    flag = join(dir, 'opt', 'checkout-compromised'); runtime = join(dir, 'runtime');
    mkdirSync(join(dir, 'opt')); mkdirSync(runtime);
    // A stock checkout, world-writable as Codespaces' ACL leaves it.
    mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
    mkdirSync(join(repo, '.git', 'info'), { recursive: true });
    mkdirSync(join(repo, 'src'), { recursive: true });
    mkdirSync(join(repo, '.devcontainer', 'bootstrap'), { recursive: true });
    writeFileSync(join(repo, 'README.md'), '# hf\n');
    writeFileSync(join(repo, 'src', 'run.sh'), '#!/bin/sh\n');
    writeFileSync(join(repo, '.git', 'config'), STOCK_CONFIG);
    writeFileSync(join(repo, '.git', 'info', 'exclude'), '# git ls-files --others --exclude-from=.git/info/exclude\n');
    writeFileSync(join(repo, '.git', 'hooks', 'pre-commit.sample'), '#!/bin/sh\n');
    writeFileSync(join(repo, '.devcontainer', 'bootstrap', 'version.json'), JSON.stringify(PIN));
    writeFileSync(join(repo, '.devcontainer', 'bootstrap', 'verifiers.json'), JSON.stringify(VERIFIERS));
    for (const f of ['README.md', '.git/config']) chmodSync(join(repo, f), 0o666);
    chmodSync(join(repo, 'src', 'run.sh'), 0o777);
    chmodSync(join(repo, '.git', 'hooks', 'pre-commit.sample'), 0o755);
    for (const d of ['src', '.git/hooks', '.git', '']) chmodSync(join(repo, d), 0o777);
  });
  const mode = (rel: string) => lstatSync(join(repo, rel)).mode & 0o7777;
  const lockdown = (o: { owners?: number[]; reown?: (fd: number) => void } = {}) => lockdownClones({
    workspaces: ws, chown: () => {}, owners: o.owners ?? [uid], repoOwners: [uid], reown: o.reown ?? (() => {}),
    stripAcl: (paths: string[]) => { stripCalls.push(paths); stripped.push(...paths); }, logLine: (m: string) => lines.push(m), compromisedFile: flag, runtime,
  });
  const pin = () => repoPin({ workspaces: ws, logLine: (m: string) => lines.push(m), trust: TRUST, compromisedFile: flag });
  const verifiers = (dst = join(dir, 'v.json')) => copyVerifiers({ workspaces: ws, dst, owner: null, logLine: (m: string) => lines.push(m), trust: TRUST, compromisedFile: flag });
  const quarantined = () => readdirSync(runtime).filter((n) => n.startsWith('quarantine-')).flatMap((q) => readdirSync(join(runtime, q)));
  /** The bootstrap is not read, the flag is up, the offender is gone from the checkout (moved, never followed). */
  const expectCompromised = (rel: string) => {
    lockdown();
    expect(checkoutCompromised(flag)).toBe(true);
    expect(readFileSync(flag, 'utf8')).toContain(rel);
    expect(() => lstatSync(join(repo, rel))).toThrow();
    expect(quarantined()).toContain(rel.replace(/\//g, '__'));
    expect(pin()).toBeNull();
    expect(verifiers()).toBe(false);
    expect(lines.join('\n')).toMatch(/version pin NOT read: the checkout was changed by an agent/);
    expect(lines.join('\n')).toMatch(/bootstrap verifiers NOT read/);
    expect(compromisedStartRefusal({ compromisedFile: flag, verifiers: join(dir, 'none.json') })).toMatch(/server NOT started/);
    // Verifiers installed BEFORE the compromise (the last good copy) are kept and the server starts.
    writeFileSync(join(dir, 'earlier.json'), '{}');
    expect(compromisedStartRefusal({ compromisedFile: flag, verifiers: join(dir, 'earlier.json') })).toBeNull();
  };

  it('a clean stock checkout: not compromised, read; the TOP dir is 0700 (dcuser cannot traverse) after prepare and after every re-lock', () => {
    expect(scanCheckout(repo, [uid])).toEqual([]);
    const reowned: number[] = [];
    lockdown({ reown: (fd: number) => { reowned.push(fstatSync(fd).ino); } });
    expect(checkoutCompromised(flag)).toBe(false);
    expect(mode('')).toBe(0o700);
    expect(reowned).toContain(lstatSync(repo).ino); // the codespace user's, through its fd
    expect(stripCalls[0]).toEqual([repo]); // its ACL (default too) stripped on its own, before the scan
    expect(mode('.git')).toBe(0o700);
    expect(mode('.git/config')).toBe(0o644);
    expect(mode('README.md')).toBe(0o644);
    expect(mode('src/run.sh')).toBe(0o755);
    expect(pin()).toEqual(PIN);
    expect(verifiers()).toBe(true);
    expect(compromisedStartRefusal({ compromisedFile: flag, verifiers: join(dir, 'none.json') })).toBeNull();
    // GitHub re-opens it (smoke #5): the next re-lock closes the top dir again.
    chmodSync(repo, 0o777);
    lockdown();
    expect(mode('')).toBe(0o700);
    expect(checkoutCompromised(flag)).toBe(false);
  });

  it('a symlinked hook (.git/hooks/pre-push -> /tmp/x) is compromise; the target is never touched', () => {
    const target = join(dir, 'outside');
    writeFileSync(target, 'x'); chmodSync(target, 0o777);
    symlinkSync(target, join(repo, '.git', 'hooks', 'pre-push'));
    expectCompromised('.git/hooks/pre-push');
    expect(lstatSync(target).mode & 0o777).toBe(0o777);
    expect(readFileSync(target, 'utf8')).toBe('x');
  });

  it('a symlinked .git/hooks dir, .git/config, .gitattributes or .vscode/tasks.json is compromise', () => {
    for (const rel of ['.git/hooks', '.git/config', '.gitattributes', '.vscode/tasks.json']) {
      rmSync(flag, { force: true }); rmSync(runtime, { recursive: true, force: true }); mkdirSync(runtime); lines = [];
      chmodSync(repo, 0o777);
      rmSync(join(repo, rel), { recursive: true, force: true });
      mkdirSync(join(repo, rel, '..'), { recursive: true });
      symlinkSync(join(dir, 'elsewhere'), join(repo, rel));
      expectCompromised(rel);
      if (rel === '.git/config') writeFileSync(join(repo, '.git', 'config'), STOCK_CONFIG);
    }
  });

  it('a non-sample hook file is compromise (a stock sample is not)', () => {
    writeFileSync(join(repo, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\ncurl evil\n');
    expectCompromised('.git/hooks/post-checkout');
    expect(lstatSync(join(repo, '.git', 'hooks', 'pre-commit.sample')).isFile()).toBe(true);
  });

  for (const [what, cfg] of [
    ['include.path', '[include]\n\tpath = /tmp/cfg\n'],
    ['includeIf.*.path', '[includeIf "gitdir:/workspaces/"]\n\tpath = /tmp/cfg\n'],
    ['alias !', '[alias]\n\tst = !sh -c "curl evil"\n'],
    ['filter.*.clean', '[filter "x"]\n\tclean = /tmp/x\n'],
    ['diff.*.textconv', '[diff "x"]\n\ttextconv = /tmp/x\n'],
    ['core.fsmonitor', '[core]\n\tfsmonitor = /tmp/x\n'],
  ] as const) {
    it(`a git config with ${what} is compromise`, () => {
      writeFileSync(join(repo, '.git', 'config'), STOCK_CONFIG + cfg);
      expectCompromised('.git/config');
    });
  }

  it('the other git config files count too: config.worktree, a submodule config, info/attributes, a worktree .gitattributes', () => {
    const cases: Array<[string, string]> = [
      ['.git/config.worktree', '[core]\n\thooksPath = /tmp\n'],
      ['.git/modules/sub/config', '[core]\n\tsshCommand = /tmp/x\n'],
      ['.git/info/attributes', '* filter=x\n'],
      ['.gitattributes', '*.md diff=x\n'],
      ['src/.gitattributes', '*.sh merge=x\n'],
    ];
    for (const [rel, text] of cases) {
      rmSync(flag, { force: true }); rmSync(runtime, { recursive: true, force: true }); mkdirSync(runtime); lines = [];
      chmodSync(repo, 0o777);
      mkdirSync(join(repo, rel, '..'), { recursive: true });
      writeFileSync(join(repo, rel), text);
      expectCompromised(rel);
    }
  });

  it('an entry owned by anyone but root/codespace (dcuser) is compromise: the checkout is not read', () => {
    mkdirSync(join(repo, '.vscode'));
    writeFileSync(join(repo, '.vscode', 'tasks.json'), '{"tasks":[{"runOptions":{"runOn":"folderOpen"}}]}');
    // Here every entry is "foreign" (the test cannot chown): the scan flags each top-most one.
    const found = scanCheckout(repo, [uid + 4242]);
    expect(found.map((f: { rel: string }) => f.rel)).toEqual(expect.arrayContaining(['.vscode', '.git', 'README.md']));
    expect(found.every((f: { why: string }) => /owned by uid/.test(f.why))).toBe(true);
    lockdown({ owners: [uid + 4242] });
    expect(checkoutCompromised(flag)).toBe(true);
    expect(pin()).toBeNull();
    expect(quarantined()).toEqual(expect.arrayContaining(['.vscode', '.git', 'README.md']));
  });

  it('the flag is sticky: a later clean re-lock never lowers it; nothing is re-logged for what is already quarantined', () => {
    writeFileSync(join(repo, '.git', 'hooks', 'post-checkout'), 'x');
    lockdown();
    expect(checkoutCompromised(flag)).toBe(true);
    lines = [];
    lockdown();
    expect(checkoutCompromised(flag)).toBe(true);
    expect(lines).toEqual([]);
  });

  it('the git config parser: every exec / include key class, the legacy and header-line forms; a stock config is clean', () => {
    expect(gitConfigRisks(STOCK_CONFIG)).toEqual([]);
    expect(gitConfigRisks('[core]\n\tfsmonitor = true\n[alias]\n\tst = status\n[diff]\n\talgorithm = histogram\n')).toEqual([]);
    const risky = [
      '[include]\n\tpath = x', '[includeIf "onbranch:main"]\n\tpath = x', '[alias]\n\tx = !sh', '[filter "lfs"]\n\tprocess = x', '[filter "a"]\n\tsmudge = x',
      '[diff "a"]\n\ttextconv = x', '[diff]\n\texternal = x', '[merge "a"]\n\tdriver = x', '[gpg]\n\tprogram = x', '[core]\n\thooksPath = x',
      '[core]\n\tsshCommand = x', '[core]\n\tpager = x', '[core]\n\teditor = x', '[credential]\n\thelper = x', '[pager]\n\tlog = x',
      '[sequence]\n\teditor = x', '[uploadpack]\n\tpackObjectsHook = x', '[remote "origin"]\n\tuploadpack = x', '[core]\n\tgitProxy = x',
      '[submodule "s"]\n\tupdate = !x', '[protocol "ext"]\n\tallow = always', '[filter.legacy]\n\tclean = x', '[core] hooksPath = x',
      '[core]\n\thooks\\\nPath = x', '[core]\n\tsomething that is not git syntax',
    ];
    for (const r of risky) expect(gitConfigRisks(r), r).not.toEqual([]);
  });

  it('the re-lock is cheap: the ACL strip sends the paths on stdin, never as one argv per path', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'cloud', 'supervisor.mjs'), 'utf8');
    const strip = src.slice(src.indexOf('function stripAclXattrs('), src.indexOf('function stripAclXattrs(') + 900);
    expect(strip).toMatch(/sys\.stdin\.buffer\.read\(\)/);
    expect(strip).toMatch(/input: Buffer\.from\(paths\.join\('\\0'\)/);
    expect(strip).not.toMatch(/\.\.\.paths/);
  });

  it('the supervisor re-locks it every minute and refuses to serve a compromised checkout with no earlier verifiers', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'cloud', 'supervisor.mjs'), 'utf8');
    expect(RELOCK_INTERVAL_MS).toBe(60_000);
    expect(src).toMatch(/function main\(\)[\s\S]*relockPeriodically\(\);[\s\S]*compromisedStartRefusal\(\);\n\s*if \(refusal\) \{ log\(refusal\);.*return; \}.*\n\s*start\(\);/);
  });
});

