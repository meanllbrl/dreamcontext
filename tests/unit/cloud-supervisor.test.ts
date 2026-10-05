import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeBuildFingerprint } from '../../src/server/cloud-fingerprint.js';
import { CloudStateStore, parseTripRecord } from '../../src/server/cloud-state.js';
import { seamRefusal } from '../../src/cli/commands/cloud.js';
// @ts-expect-error: a plain .mjs script (copied verbatim into the private repo), no types.
import {
  computeFingerprint, copyVerifiers, ensureInstalled, fetchVerified, INTEGRITY_RE, isPin, lockdownClones, readRuntimeRequest, repoPin, SEMVER_RE, validMirrorPath,
} from '../../cloud/supervisor.mjs';
import { INTEGRITY_RE as TS_INTEGRITY_RE, SEMVER_RE as TS_SEMVER_RE } from '../../src/lib/handsfree/npm-pin.js';

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
function makeTgz(where: string, version: string, name = 'dreamcontext', extra = ''): { path: string; integrity: string } {
  const src = mkdtempSync(join(where, 'pkgsrc-'));
  mkdirSync(join(src, 'package', 'dist'), { recursive: true });
  writeFileSync(join(src, 'package', 'package.json'), JSON.stringify({ name, version }));
  writeFileSync(join(src, 'package', 'dist', 'index.js'), `// ${name} ${version}${extra}\n`);
  const path = join(where, `${name}-${version}${extra ? '-x' : ''}.tgz`);
  execFileSync('tar', ['-czf', path, '-C', src, 'package']);
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
  const lockdown = () => lockdownClones({ workspaces: ws, owner: null, stripAcl: () => {}, logLine: log });
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

  it('a symlinked .devcontainer or bootstrap dir is refused, and the lockdown removes the link without touching its target', () => {
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
    expect(existsSync(join(repo, '.devcontainer'))).toBe(false);
    expect(statSync(elsewhere).mode & 0o777).toBe(0o777); // never followed

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
