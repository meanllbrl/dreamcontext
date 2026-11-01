import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { codexAwarePath, codexChildEnv, codexHealth, codexStartProblem, findCodexBin, forgetCodexHealth, managedCodexBin, managedCodexVersion } from '../../src/lib/codex-bin.js';
import { codexEnsureSkipped } from '../../src/cli/ensure-codex.js';
import { CODEX_PIN } from '../../src/lib/codex-pin.js';
import { codexLauncher, installManagedCodex, installPinnedNode, verifyFetched, withCodexInstallLock, type CodexInstallEnv } from '../../src/lib/onboarding/codex-install.js';
import { evaluateChecks } from '../../src/lib/onboarding/checks.js';
import { defaultFixDeps, runFix, type RunSink } from '../../src/lib/onboarding/fixes.js';
import { planFixes } from '../../src/lib/onboarding/plan.js';
import type { CodexFacts, ExtraFacts, ProbeContext, ReadinessCheck, ShellFacts } from '../../src/lib/onboarding/types.js';
import { codexInfo, listTools } from '../../src/lib/t3-bridge/registry.js';
import { resetToolFinderForTests } from '../../src/lib/tool-finder.js';

const NARROW = '/usr/bin:/bin:/usr/sbin:/sbin';
let home = '';
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'dc-codex-dep-')); resetToolFinderForTests(); forgetCodexHealth(); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const tool = (rel: string, body: string): string => {
  const p = join(home, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
  chmodSync(p, 0o755);
  return p;
};
const signIn = (): void => { mkdirSync(join(home, '.codex'), { recursive: true }); writeFileSync(join(home, '.codex', 'auth.json'), '{}'); };
const lookup = (extra: object = {}) => ({ home, path: NARROW, env: {}, loginPath: null, system: [] as string[], node: '/fake/node', ...extra });

describe('a Finder-started app on an nvm Codex', () => {
  it('REGRESSION: on a launchd PATH Codex under nvm reads ready', () => {
    tool('.nvm/versions/node/v20.19.0/bin/codex', '#!/bin/sh\necho "codex-cli 0.164.0"\n');
    signIn();
    const info = codexInfo(lookup());
    expect(info).toMatchObject({ installed: true, runs: true, signedIn: true, nodeOk: true, ready: true, version: '0.164.0' });
    expect(listTools(lookup()).find((t) => t.tool === 'codex')?.ready).toBe(true);
  });

  it('asks Codex with the PATH a child gets: `env node` resolves through the bridge Node', () => {
    tool('.nvm/versions/node/v20.19.0/bin/codex', '#!/usr/bin/env node\nconsole.log("codex-cli 0.164.0")\n');
    expect(codexHealth(lookup())).toMatchObject({ runs: true, version: '0.164.0' });
  });

  it('an installed Codex that cannot start is not ready, and says why', () => {
    tool('.volta/bin/codex', '#!/bin/sh\necho "env: node: No such file or directory" >&2\nexit 127\n');
    signIn();
    const info = codexInfo(lookup());
    expect(info).toMatchObject({ installed: true, runs: false, ready: false });
    expect(codexStartProblem(lookup())).toContain('node');
  });

  it('one stall at boot does not retire Codex', () => {
    tool('.volta/bin/codex', '#!/bin/sh\necho 0.164.0\n');
    const dead = codexHealth(lookup({ run: () => ({ status: null, stdout: '', stderr: '', error: 'ETIMEDOUT' }) }));
    expect(dead.runs).toBe(false);
    expect(codexHealth(lookup()).runs).toBe(true);
  });

  it('too old is not ready and asks for the update', () => {
    tool('.volta/bin/codex', '#!/bin/sh\necho "codex-cli 0.100.0"\n');
    signIn();
    expect(codexInfo(lookup())).toMatchObject({ installed: true, runs: true, outdated: true, ready: false });
    expect(codexStartProblem(lookup())).toMatch(/too old/);
  });

  it('a person only: update never downloads inside an unattended run', () => {
    expect(codexEnsureSkipped({}, undefined)).toBe(true);
    expect(codexEnsureSkipped({}, false)).toBe(true);
    expect(codexEnsureSkipped({ DREAMCONTEXT_SKIP_CODEX_ENSURE: '1' }, true)).toBe(true);
  });

  it('nodeOk is the bridge floor, separate from the install', () => {
    tool('.volta/bin/codex', '#!/bin/sh\necho 0.164.0\n');
    signIn();
    expect(codexInfo(lookup({ node: null }))).toMatchObject({ installed: true, runs: true, nodeOk: false, ready: false });
  });

  it('the child PATH gets Codex and a Node, appended', () => {
    const bin = tool('.volta/bin/codex', '#!/bin/sh\n');
    const p = codexAwarePath(NARROW, lookup({ node: '/brew/bin/node' }));
    expect(p.startsWith(NARROW)).toBe(true);
    expect(p.split(':')).toEqual(expect.arrayContaining([dirname(bin), '/brew/bin']));
  });

  it('codexChildEnv keeps every other variable', () => {
    expect(codexChildEnv({ PATH: NARROW, KEEP: '1' }).KEEP).toBe('1');
  });

  it('not installed is one line that says what to do', () => {
    expect(codexStartProblem(lookup())).toMatch(/not installed.*Install/);
  });
});

describe('the managed install', () => {
  const lock = (over: Record<string, unknown> = {}) => JSON.stringify({ packages: {
    [`node_modules/${CODEX_PIN.package}`]: { resolved: `${CODEX_PIN.registry}@openai/codex/-/codex-${CODEX_PIN.version}.tgz`, integrity: CODEX_PIN.integrity },
    [`node_modules/${CODEX_PIN.package}-darwin-arm64`]: { resolved: `${CODEX_PIN.registry}x.tgz`, integrity: CODEX_PIN.platforms['darwin-arm64'].integrity },
    ...over,
  } });

  it('accepts exactly what the pin names', () => {
    expect(verifyFetched(lock(), 'darwin-arm64')).toBe('');
  });
  it('REGRESSION: a nested copy cannot stand in for the package that runs', () => {
    const nested = `node_modules/${CODEX_PIN.package}-darwin-arm64/node_modules/${CODEX_PIN.package}-darwin-arm64`;
    const tampered = JSON.parse(lock());
    tampered.packages[`node_modules/${CODEX_PIN.package}-darwin-arm64`].integrity = 'sha512-HOSTILE';
    tampered.packages[nested] = { resolved: `${CODEX_PIN.registry}x.tgz`, integrity: CODEX_PIN.platforms['darwin-arm64'].integrity };
    expect(verifyFetched(JSON.stringify(tampered), 'darwin-arm64')).not.toBe('');
    const extra = JSON.parse(lock());
    extra.packages[nested] = { resolved: `${CODEX_PIN.registry}x.tgz`, integrity: 'x' };
    expect(verifyFetched(JSON.stringify(extra), 'darwin-arm64')).toMatch(/Unexpected/);
  });
  it('npm 11 lists other platforms as inert: fine while nothing landed there, refused if it did', () => {
    const text = lock({ [`node_modules/${CODEX_PIN.package}-darwin-x64`]: { ideallyInert: true } });
    expect(verifyFetched(text, 'darwin-arm64', () => false)).toBe('');
    expect(verifyFetched(text, 'darwin-arm64', () => true)).toMatch(/Unexpected/);
  });
  it('refuses a mirror', () => {
    expect(verifyFetched(lock({ [`node_modules/${CODEX_PIN.package}`]: { resolved: 'https://evil.example/codex.tgz', integrity: CODEX_PIN.integrity } }), 'darwin-arm64')).toMatch(/official/);
  });
  it('refuses a changed hash', () => {
    expect(verifyFetched(lock({ [`node_modules/${CODEX_PIN.package}`]: { resolved: `${CODEX_PIN.registry}x`, integrity: 'sha512-AAAA' } }), 'darwin-arm64')).toMatch(/hash/);
  });
  it('refuses a stowaway package', () => {
    expect(verifyFetched(lock({ 'node_modules/left-pad': { resolved: `${CODEX_PIN.registry}x`, integrity: 'x' } }), 'darwin-arm64')).toMatch(/Unexpected/);
  });

  it('the launcher needs no PATH and no Node', () => {
    const text = codexLauncher('/x/bin/codex', '/x', '0.164.0');
    expect(text.split('\n')[0]).toBe('#!/bin/sh');
    expect(text).toContain('exec "/x/bin/codex" "$@"');
    expect(text).not.toMatch(/\bnode\b/);
  });

  /** A stand-in npm: writes the tree a real install leaves. `integrity` lets a test tamper with it. */
  function fakeInstall(o: { integrity?: string; native?: boolean } = {}): CodexInstallEnv['run'] {
    return async (file, args) => {
      if (args[0] === '--version') return { ok: true, stdout: `codex-cli ${CODEX_PIN.version}\n`, stderr: '' };
      const prefix = args[args.indexOf('--prefix') + 1]!;
      const k = 'darwin-arm64';
      mkdirSync(join(prefix, 'node_modules'), { recursive: true });
      writeFileSync(join(prefix, 'node_modules', '.package-lock.json'), JSON.stringify({ packages: {
        [`node_modules/${CODEX_PIN.package}`]: { resolved: `${CODEX_PIN.registry}a.tgz`, integrity: o.integrity ?? CODEX_PIN.integrity },
        [`node_modules/${CODEX_PIN.package}-${k}`]: { resolved: `${CODEX_PIN.registry}b.tgz`, integrity: CODEX_PIN.platforms[k].integrity },
      } }));
      if (o.native !== false) {
        const n = join(prefix, 'node_modules', '@openai', `codex-${k}`, 'vendor', CODEX_PIN.platforms[k].triple, 'bin', 'codex');
        mkdirSync(dirname(n), { recursive: true });
        writeFileSync(n, '#!/bin/sh\n', { mode: 0o755 });
      }
      return { ok: true, stdout: '', stderr: '' };
    };
  }
  const env = (run: CodexInstallEnv['run']): CodexInstallEnv => ({ home, platform: 'darwin', arch: 'arm64', run, say: () => undefined, npm: '/x/npm', env: {} });

  it('lands the launcher, the finder sees it first, and no folder of the user is touched', async () => {
    const mine = tool('.nvm/versions/node/v20.19.0/bin/codex', '#!/bin/sh\necho mine\n');
    const before = readFileSync(mine, 'utf-8');
    const r = await installManagedCodex(env(fakeInstall()));
    expect(r).toEqual({ ok: true });
    expect(findCodexBin(lookup())).toBe(managedCodexBin(home));
    expect(managedCodexVersion(home)).toBe(CODEX_PIN.version);
    expect(readFileSync(mine, 'utf-8')).toBe(before);
    expect(existsSync(join(home, '.dreamcontext/tools/codex/versions', CODEX_PIN.version))).toBe(true);
  });

  it('asks npm for the exact version, the official registry, and no install scripts', async () => {
    const run = vi.fn(fakeInstall());
    await installManagedCodex(env(run));
    const args = run.mock.calls[0]![1];
    expect(args).toEqual(expect.arrayContaining([`${CODEX_PIN.package}@${CODEX_PIN.version}`, `--registry=${CODEX_PIN.registry}`, `--@openai:registry=${CODEX_PIN.registry}`, '--ignore-scripts']));
  });

  it('a tampered download lands nothing', async () => {
    const r = await installManagedCodex(env(fakeInstall({ integrity: 'sha512-BAD' })));
    expect(r).toMatchObject({ ok: false, reason: 'checksum' });
    expect(existsSync(managedCodexBin(home))).toBe(false);
  });

  it('npm failing says why, offline by name, and keeps the old install', async () => {
    await installManagedCodex(env(fakeInstall()));
    const before = readFileSync(managedCodexBin(home), 'utf-8');
    const r = await installManagedCodex(env(async () => ({ ok: false, stdout: '', stderr: 'npm ERR! code ENOTFOUND registry.npmjs.org' })));
    expect(r).toMatchObject({ ok: false, reason: 'offline', detail: expect.stringContaining('internet') });
    expect(readFileSync(managedCodexBin(home), 'utf-8')).toBe(before);
  });

  it('names the reason, not where npm put its log', async () => {
    const stderr = 'npm ERR! code E404\nnpm ERR! 404 Not Found\nnpm ERR! A complete log of this run can be found in:\nnpm ERR! /x/_logs/debug-0.log\n';
    const r = await installManagedCodex(env(async () => ({ ok: false, stdout: '', stderr })));
    expect(r.detail).toContain('404 Not Found');
    expect(r.detail).not.toContain('log');
  });

  it('a failed repair of the same version keeps the install that worked', async () => {
    await installManagedCodex(env(fakeInstall()));
    const landed = fakeInstall();
    const r = await installManagedCodex(env(async (f, a, o) => (a[0] === '--version' ? { ok: false, stdout: '', stderr: 'boom' } : landed(f, a, o))));
    expect(r.ok).toBe(false);
    expect(existsSync(join(home, '.dreamcontext/tools/codex/versions', CODEX_PIN.version, 'node_modules'))).toBe(true);
    expect(findCodexBin(lookup())).toBe(managedCodexBin(home));
  });

  it('a launcher whose program is gone does not hide a working Codex', async () => {
    await installManagedCodex(env(fakeInstall()));
    const mine = tool('.volta/bin/codex', '#!/bin/sh\n');
    rmSync(join(home, '.dreamcontext/tools/codex/versions'), { recursive: true });
    expect(findCodexBin(lookup())).toBe(mine);
  });

  it('one install at a time across processes', async () => {
    let inner: unknown = 'not run';
    const outer = await withCodexInstallLock(home, async () => { inner = await withCodexInstallLock(home, async () => 'second'); return 'first'; });
    expect(outer).toBe('first');
    expect(inner).toBeNull();
  });

  it('a lock left by a killed process frees at once', async () => {
    const lock = join(home, '.dreamcontext/tools/.codex-install.lock');
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'pid'), '999999');
    expect(await withCodexInstallLock(home, async () => 'ran')).toBe('ran');
  });

  it('a lock held by a live process stays', async () => {
    const lock = join(home, '.dreamcontext/tools/.codex-install.lock');
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'pid'), String(process.ppid));
    expect(await withCodexInstallLock(home, async () => 'ran')).toBeNull();
  });

  it('refuses a dreamcontext folder that is a link', async () => {
    mkdirSync(join(home, 'other'));
    mkdirSync(join(home, '.dreamcontext'));
    symlinkSync(join(home, 'other'), join(home, '.dreamcontext', 'tools'));
    expect(await installManagedCodex(env(fakeInstall()))).toMatchObject({ ok: false, reason: 'refused' });
    expect(existsSync(join(home, 'other', 'codex'))).toBe(false);
  });

  it('no automatic install on a system with no pin', async () => {
    expect(await installManagedCodex({ ...env(fakeInstall()), platform: 'win32', arch: 'x64' })).toMatchObject({ ok: false, reason: 'refused' });
  });

  it('a missing Node lands in the shared layout and leaves `current` alone when it exists', async () => {
    const pins = { version: '24.21.0', base: 'https://nodejs.org/dist/v24.21.0/', files: { 'darwin-arm64': { file: 'n.tar.gz', sha256: 'x', size: 10 } } };
    const download = vi.fn(async (_u: string, o: { dest: string }) => { writeFileSync(o.dest, 'x'); return undefined as never; });
    const run: CodexInstallEnv['run'] = async (_f, args) => { const d = args[args.indexOf('-C') + 1]!; mkdirSync(join(d, 'bin')); writeFileSync(join(d, 'bin', 'node'), ''); return { ok: true, stdout: '', stderr: '' }; };
    const r = await installPinnedNode({ home, platform: 'darwin', arch: 'arm64', pins, download: download as never, signal: new AbortController().signal, say: () => undefined, progress: () => undefined, run });
    expect(r).toEqual({ ok: true });
    const current = join(home, '.dreamcontext/node/current');
    expect(lstatSync(current).isSymbolicLink()).toBe(true);
    expect(readlinkSync(current)).toBe('24.21.0');
    expect(readFileSync(join(home, '.dreamcontext/node/24.21.0/etc/npmrc'), 'utf-8')).toContain('npm-global');
  });
});

describe('Sign in', () => {
  it('shows the sign-in page and nothing else of what codex login prints', async () => {
    const bin = tool('.dreamcontext/tools/codex/bin/codex', '#!/bin/sh\nexec "/bin/sh" "$@"\n');
    mkdirSync(join(home, '.codex'), { recursive: true });
    const lines: string[] = [];
    const waits: Array<string | null> = [];
    const sink: RunSink = { output: (c) => lines.push(c), progress: () => undefined, awaiting: (k) => waits.push(k), deviceCode: () => undefined, onCancel: () => undefined };
    const deps = { ...defaultFixDeps, env: { PATH: NARROW }, run: vi.fn(async (_f: string, _a: string[], _o: unknown, s: RunSink) => {
      if (_a[1] === 'status') return { ok: true, stdout: '', stderr: '', code: 0 };
      s.output('If your browser did not open, navigate to this URL to authenticate:\nhttps://auth.open');
      s.output('ai.com/oauth/authorize?state=x\nhttp://localhost:1455/auth/callback?code=SECRET\n');
      return { ok: true, stdout: '', stderr: '', code: 0 };
    }) };
    const ctx = { home, surface: 'desktop', platform: 'darwin', arch: 'arm64', execPath: process.execPath, probeUrl: '', runner: {} } as unknown as ProbeContext;
    const r = await runFix('codex-signin', ctx, sink, new AbortController().signal, {}, deps);
    expect(r).toEqual({ ok: true });
    expect(deps.run.mock.calls[0]![0]).toBe(bin);
    expect(deps.run.mock.calls[0]![1]).toEqual(['login']);
    expect(lines.join('')).toBe('https://auth.openai.com/oauth/authorize?state=x\n');
    expect(waits).toEqual(['browser', null]);
  });

  it('a login that ended with no sign-in says so', async () => {
    tool('.dreamcontext/tools/codex/bin/codex', '#!/bin/sh\nexec "/bin/sh" "$@"\n');
    const sink: RunSink = { output: () => undefined, progress: () => undefined, awaiting: () => undefined, deviceCode: () => undefined, onCancel: () => undefined };
    const deps = { ...defaultFixDeps, env: {}, run: async (_f: string, a: string[]) => ({ ok: a[1] !== 'status', stdout: '', stderr: '', code: 0 }) };
    const ctx = { home, execPath: process.execPath, platform: 'darwin', arch: 'arm64' } as unknown as ProbeContext;
    expect(await runFix('codex-signin', ctx, sink, new AbortController().signal, {}, deps)).toMatchObject({ ok: false, detail: expect.stringContaining('did not complete') });
  });
});

describe('the readiness rows', () => {
  const facts: ShellFacts = { shell: '/bin/zsh', node: '/n', nodeVersion: 'v24.0.0', npm: '/npm', dreamcontext: '/d', claude: '/c', git: 'git', gh: '/gh' };
  const extra = (codex?: CodexFacts): ExtraFacts => ({
    online: true, runningNodeVersion: '24.0.0', npmBesideExec: true, claudeBin: '/c', cliBinOffPath: null,
    claudeAuth: { loggedIn: true }, ghAuthed: true, github: { connected: true, needsReconnect: false, login: 'x' }, ptyPresent: true,
    ...(codex ? { codex } : {}),
  });
  const rows = (codex?: CodexFacts): ReadinessCheck[] => evaluateChecks(facts, extra(codex), { surface: 'desktop', platform: 'darwin' });
  const row = (cs: ReadinessCheck[], id: string) => cs.find((c) => c.id === id)!;
  const good: CodexFacts = { bin: '/b', runs: true, version: '0.164.0', outdated: false, nodeOk: true, signedIn: true };

  it('all good: installed with its version, signed in', () => {
    const cs = rows(good);
    expect(row(cs, 'codex')).toMatchObject({ status: 'ok', version: '0.164.0' });
    expect(row(cs, 'codex-auth').status).toBe('ok');
  });
  it('missing offers the install, and stays recommended: Claude chats never wait on it', () => {
    const cs = rows({ ...good, bin: null, runs: false, version: null, signedIn: false });
    expect(row(cs, 'codex')).toMatchObject({ status: 'missing', tier: 'recommended', fix: { id: 'codex-install', kind: 'auto' } });
    expect(row(cs, 'codex-auth').status).toBe('blocked');
    expect(planFixes(cs)).toContain('codex-install');
  });
  it('old, dead and no-Node all offer the update', () => {
    expect(row(rows({ ...good, outdated: true }), 'codex')).toMatchObject({ reason: 'too-old', fix: { id: 'codex-update' } });
    expect(row(rows({ ...good, runs: false, version: null }), 'codex')).toMatchObject({ reason: 'wont-start', fix: { id: 'codex-update' } });
    expect(row(rows({ ...good, nodeOk: false }), 'codex')).toMatchObject({ reason: 'needs-node', fix: { id: 'codex-update' } });
  });
  it('signed out is a browser step for a person', () => {
    expect(row(rows({ ...good, signedIn: false }), 'codex-auth')).toMatchObject({ status: 'needs-action', fix: { id: 'codex-signin', kind: 'browser' } });
  });
  it('Windows gets the command, not a button that cannot work', () => {
    const cs = evaluateChecks(facts, extra({ ...good, bin: null }), { surface: 'desktop', platform: 'win32' });
    expect(row(cs, 'codex').fix).toMatchObject({ kind: 'manual', runnable: false });
    expect(row(cs, 'codex').fix?.manual).toContain(`@openai/codex@${CODEX_PIN.version}`);
  });
});
