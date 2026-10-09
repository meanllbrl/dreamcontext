import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const executeSpy = vi.fn();
vi.mock('../../src/lib/automations/runner.js', () => ({
  executeClaudeDetached: (...args: unknown[]) => executeSpy(...args),
}));

import { accountEnvFor } from '../../src/lib/claude-accounts.js';
import { NODE_RC_MARKER } from '../../src/lib/claude-path.js';
import { DownloadError, downloadVerified } from '../../src/lib/onboarding/download.js';
import {
  CLI_INTERACTIVE, CLAUDE_INSTALLER_URL, defaultFixDeps, runFix, stripSecretsEnv,
  type FixDeps, type RunOptions, type RunSink,
} from '../../src/lib/onboarding/fixes.js';
import type { ProbeContext, ShellResult } from '../../src/lib/onboarding/types.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'dc-fix-')); executeSpy.mockReset(); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

interface Call { file: string; args: string[]; o: RunOptions }

function ctxFor(over: Partial<ProbeContext> = {}): ProbeContext {
  return {
    surface: 'desktop',
    platform: 'darwin',
    arch: 'arm64',
    home,
    execPath: join(home, 'opt', 'node', 'bin', 'node'),
    probeUrl: 'https://registry.npmjs.org/-/ping',
    runner: {
      loginShell: async () => ({ ok: true, stdout: '', stderr: '' }),
      exec: async () => ({ ok: true, stdout: '', stderr: '' }),
      fetchOk: async () => true,
    },
    ...over,
  };
}

function recordingSink() {
  const events: string[] = [];
  const sink: RunSink = {
    output: () => {},
    progress: () => {},
    awaiting: (k) => events.push(`awaiting:${k}`),
    deviceCode: (c) => events.push(`code:${c.userCode}`),
    onCancel: () => {},
  };
  return { sink, events };
}

/** Deps that do nothing real; `run` answers through `answer` and records every call. */
function fakeDeps(answer: (c: Call) => ShellResult = () => ({ ok: true, stdout: '', stderr: '' }), over: Partial<FixDeps> = {}) {
  const calls: Call[] = [];
  const shellPaths: Array<{ dir: string; marker: string }> = [];
  const deps: FixDeps = {
    ...defaultFixDeps,
    run: async (file, args, o) => { const c = { file, args, o }; calls.push(c); return answer(c); },
    ensureCliInstalled: async () => ({ status: 'installed' }),
    addToShellPath: (dir, marker) => { shellPaths.push({ dir, marker }); return { dir, line: '', wrote: ['/rc'], alreadyConfigured: [] }; },
    fixClaudeShellPath: () => ({ ok: true, message: 'ok' }),
    findClaudeBin: () => null,
    preferredConfigDir: () => home,
    claudeLogin: async () => ({ spawned: true, timedOut: false }),
    claudeLoggedIn: async () => true,
    cltInstalled: () => false,
    gitUsable: () => false,
    ptyInstallDir: async () => home,
    brewPath: () => null,
    ghPath: () => null,
    sleep: async () => {},
    env: { PATH: '/usr/bin:/bin', HOME: home, GITHUB_TOKEN: 'ghp_x', GH_TOKEN: 'gho_y', ANTHROPIC_API_KEY: 'sk', MY_SECRET: 's', NPM_TOKEN: 'n', LANG: 'tr_TR.UTF-8' },
    ...over,
  };
  return { deps, calls, shellPaths };
}

const signal = () => new AbortController().signal;

describe('CLI_INTERACTIVE and env stripping', () => {
  it('names the TTY sign-in commands', () => {
    expect(CLI_INTERACTIVE['claude-signin']).toEqual(['claude', 'auth', 'login']);
    expect(CLI_INTERACTIVE['gh-signin']).toEqual(['gh', 'auth', 'login', '--web', '--git-protocol', 'https']);
  });

  it('removes every token-, key- and secret-shaped variable', () => {
    const env = stripSecretsEnv({ GITHUB_TOKEN: '1', GH_TOKEN: '2', NPM_TOKEN: '3', ANTHROPIC_API_KEY: '4', MY_SECRET: '5', PATH: '/bin', LANG: 'tr_TR.UTF-8' });
    expect(env).toEqual({ PATH: '/bin', LANG: 'tr_TR.UTF-8' });
  });
});

describe('claude-install', () => {
  /** A download stub that writes `body` where the recipe asked and records the URL. */
  function downloadWriting(body: string, urls: string[] = []): FixDeps['download'] {
    return async (url, o) => { urls.push(url); writeFileSync(o.dest, body); return { bytes: body.length, sha256: '' }; };
  }

  it('downloads the constant URL, runs `bash -- <file>` with secrets stripped, verifies, and removes the temp folder', async () => {
    const urls: string[] = [];
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    writeFileSync(join(home, '.local', 'bin', 'claude'), '#!/bin/sh\n');
    const { deps, calls } = fakeDeps(undefined, { download: downloadWriting('#!/bin/bash\necho hi\n', urls) });
    const r = await runFix('claude-install', ctxFor(), recordingSink().sink, signal(), {}, deps);
    expect(r).toEqual({ ok: true });
    expect(urls).toEqual([CLAUDE_INSTALLER_URL]);
    const bash = calls.find((c) => c.file === '/bin/bash')!;
    expect(bash.args[0]).toBe('--');
    const env = bash.o.env!;
    for (const k of ['GITHUB_TOKEN', 'GH_TOKEN', 'ANTHROPIC_API_KEY', 'MY_SECRET', 'NPM_TOKEN']) expect(env[k]).toBeUndefined();
    expect(env.LANG).toBe('tr_TR.UTF-8');
    expect(existsSync(dirname(bash.args[1]))).toBe(false);
    expect(calls.some((c) => c.file === join(home, '.local', 'bin', 'claude') && c.args[0] === '--version')).toBe(true);
    // Nothing is ever piped into a shell.
    expect(calls.every((c) => !c.args.join(' ').includes('|'))).toBe(true);
  });

  it('checks the temp folder is private while the script runs', async () => {
    let mode = -1;
    const { deps } = fakeDeps((c) => {
      if (c.file === '/bin/bash') mode = statSync(dirname(c.args[1])).mode & 0o777;
      return { ok: false, stdout: '', stderr: 'boom' };
    }, { download: downloadWriting('#!/bin/bash\n') });
    await runFix('claude-install', ctxFor(), recordingSink().sink, signal(), {}, deps);
    expect(mode).toBe(0o700);
  });

  it('refuses a script with no #! line and never runs it', async () => {
    const { deps, calls } = fakeDeps(undefined, { download: downloadWriting('<html>not a script</html>') });
    const r = await runFix('claude-install', ctxFor(), recordingSink().sink, signal(), {}, deps);
    expect(r.reason).toBe('refused');
    expect(calls.some((c) => c.file === '/bin/bash')).toBe(false);
  });

  it('a redirect to http and an oversized body are refused (real downloader, stubbed network)', async () => {
    const redirectFetch = (async () => new Response(null, { status: 302, headers: { location: 'http://evil.example/install.sh' } })) as typeof fetch;
    const r1 = await runFix('claude-install', ctxFor(), recordingSink().sink, signal(), {},
      fakeDeps(undefined, { download: (u, o) => downloadVerified(u, { ...o, fetchImpl: redirectFetch }) }).deps);
    expect(r1.reason).toBe('refused');

    const bigFetch = (async () => new Response('#!' + 'x'.repeat(1024 * 1024 + 10))) as typeof fetch;
    const r2 = await runFix('claude-install', ctxFor(), recordingSink().sink, signal(), {},
      fakeDeps(undefined, { download: (u, o) => downloadVerified(u, { ...o, fetchImpl: bigFetch }) }).deps);
    expect(r2.reason).toBe('refused');
  });

  it('a claude that does not start after install is not ok', async () => {
    const { deps } = fakeDeps((c) => ({ ok: c.file === '/bin/bash', stdout: '', stderr: '' }), {
      download: downloadWriting('#!/bin/bash\n'),
    });
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    writeFileSync(join(home, '.local', 'bin', 'claude'), '');
    const r = await runFix('claude-install', ctxFor(), recordingSink().sink, signal(), {}, deps);
    expect(r.ok).toBe(false);
  });

  it('honours the installer seam only for http://127.0.0.1', async () => {
    const urls: string[] = [];
    const run = (seam: string) => runFix('claude-install', ctxFor(), recordingSink().sink, signal(), {},
      fakeDeps(undefined, { download: downloadWriting('nope', urls), env: { DREAMCONTEXT_CLAUDE_INSTALLER_URL: seam } }).deps);
    await run('http://127.0.0.1:4555/install.sh');
    await run('http://evil.example/install.sh');
    expect(urls).toEqual(['http://127.0.0.1:4555/install.sh', CLAUDE_INSTALLER_URL]);
  });
});

describe('claude-signin', () => {
  it('waits on the browser and is ok once the account reads signed in', async () => {
    const seen: string[] = [];
    const { deps } = fakeDeps(undefined, {
      preferredConfigDir: () => '/sandbox/acct',
      claudeLogin: async ({ configDir }) => { seen.push(configDir); return { spawned: true, timedOut: false }; },
    });
    const { sink, events } = recordingSink();
    expect(await runFix('claude-signin', ctxFor(), sink, signal(), {}, deps)).toEqual({ ok: true });
    expect(seen).toEqual(['/sandbox/acct']);
    expect(events).toEqual(['awaiting:browser', 'awaiting:null']);
  });

  it('a login that did not land is not ok', async () => {
    const { deps } = fakeDeps(undefined, { claudeLoggedIn: async () => false });
    expect((await runFix('claude-signin', ctxFor(), recordingSink().sink, signal(), {}, deps)).ok).toBe(false);
  });

  it('the real login runs from the home folder with the account env of resolveConfigDir(null)', async () => {
    executeSpy.mockResolvedValue({ spawned: true, timedOut: false });
    await defaultFixDeps.claudeLogin({ configDir: homedir(), onSpawned: () => {} });
    const [args, opts] = executeSpy.mock.calls[0] as [string[], { cwd: string; env: unknown; discardOutput: boolean }];
    expect(args).toEqual(['auth', 'login']);
    expect(opts.cwd).toBe(homedir());
    expect(opts.env).toEqual(accountEnvFor(homedir()));
    expect(opts.discardOutput).toBe(true);
  });
});

describe('git-install', () => {
  it('legacy mode is done as soon as the dialog opens', async () => {
    const { deps, calls } = fakeDeps();
    const { sink, events } = recordingSink();
    expect(await runFix('git-install', ctxFor(), sink, signal(), { waitForDialog: false }, deps)).toEqual({ ok: true });
    expect(calls.map((c) => [c.file, ...c.args])).toEqual([['xcode-select', '--install']]);
    expect(events).toEqual([]);
  });

  it('by default waits for the developer tools, as a system-dialog wait', async () => {
    let polls = 0;
    const { deps } = fakeDeps(undefined, { cltInstalled: () => ++polls >= 3 });
    const { sink, events } = recordingSink();
    expect(await runFix('git-install', ctxFor(), sink, signal(), {}, deps)).toEqual({ ok: true });
    expect(events).toEqual(['awaiting:system-dialog', 'awaiting:null']);
    expect(polls).toBe(3);
  });

  it('is refused off macOS', async () => {
    expect((await runFix('git-install', ctxFor({ platform: 'linux' }), recordingSink().sink, signal(), {}, fakeDeps().deps)).reason).toBe('refused');
  });
});

describe('gh-install (pinned archive)', () => {
  const unpackingRun = (c: Call): ShellResult => {
    if (c.file === '/usr/bin/ditto') {
      const root = c.args[3];
      mkdirSync(join(root, 'gh_2.102.0_macOS_arm64', 'bin'), { recursive: true });
      writeFileSync(join(root, 'gh_2.102.0_macOS_arm64', 'bin', 'gh'), '#!/bin/sh\n');
    }
    return { ok: true, stdout: '', stderr: '' };
  };
  const fakeDownload: FixDeps['download'] = async (_u, o) => { writeFileSync(o.dest, 'zip'); return { bytes: 3, sha256: o.sha256 ?? '' }; };

  it('downloads the pinned asset for this arch, unpacks into the version folder and links ~/.local/bin/gh', async () => {
    const asked: Array<{ url: string; sha256?: string; maxBytes: number }> = [];
    const { deps, shellPaths } = fakeDeps(unpackingRun, {
      download: async (u, o) => { asked.push({ url: u, sha256: o.sha256, maxBytes: o.maxBytes }); return fakeDownload(u, o); },
    });
    const r = await runFix('gh-install', ctxFor(), recordingSink().sink, signal(), {}, deps);
    expect(r).toEqual({ ok: true });
    const pin = deps.pins.gh.files['darwin-arm64'];
    expect(asked).toEqual([{ url: `${deps.pins.gh.base}${pin.file}`, sha256: pin.sha256, maxBytes: pin.size }]);
    const link = join(home, '.local', 'bin', 'gh');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(join(home, '.dreamcontext', 'tools', 'gh', '2.102.0', 'bin', 'gh'));
    expect(shellPaths.map((p) => p.dir)).toEqual([join(home, '.local', 'bin')]);
  });

  it('refuses when ~/.local/bin/gh already exists', async () => {
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    writeFileSync(join(home, '.local', 'bin', 'gh'), 'mine');
    const { deps, calls } = fakeDeps(unpackingRun, { download: fakeDownload });
    expect((await runFix('gh-install', ctxFor(), recordingSink().sink, signal(), {}, deps)).reason).toBe('refused');
    expect(calls).toEqual([]);
  });

  it('refuses a symlinked ~/.dreamcontext/tools', async () => {
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    mkdirSync(join(home, 'elsewhere'));
    symlinkSync(join(home, 'elsewhere'), join(home, '.dreamcontext', 'tools'));
    const { deps } = fakeDeps(unpackingRun, { download: fakeDownload });
    expect((await runFix('gh-install', ctxFor(), recordingSink().sink, signal(), {}, deps)).reason).toBe('refused');
  });

  it('a checksum failure is reported as checksum and leaves nothing behind', async () => {
    const { deps } = fakeDeps(unpackingRun, { download: async () => { throw new DownloadError('checksum', 'bad'); } });
    expect((await runFix('gh-install', ctxFor(), recordingSink().sink, signal(), {}, deps)).reason).toBe('checksum');
    expect(existsSync(join(home, '.local', 'bin', 'gh'))).toBe(false);
    expect(existsSync(join(home, '.dreamcontext', 'tools', 'gh', '2.102.0'))).toBe(false);
  });

  it('uses Homebrew when present', async () => {
    const { deps, calls } = fakeDeps(undefined, { brewPath: () => '/opt/homebrew/bin/brew' });
    expect(await runFix('gh-install', ctxFor(), recordingSink().sink, signal(), {}, deps)).toEqual({ ok: true });
    expect(calls.map((c) => [c.file, ...c.args])).toEqual([['/opt/homebrew/bin/brew', 'install', 'gh']]);
  });
});

describe('shell-path fixes', () => {
  it('node-shell-path on the private Node writes the stable current/bin and npm-global/bin folders', async () => {
    const execPath = join(home, '.dreamcontext', 'node', '24.21.0', 'bin', 'node');
    const { deps, shellPaths } = fakeDeps();
    expect(await runFix('node-shell-path', ctxFor({ execPath }), recordingSink().sink, signal(), {}, deps)).toEqual({ ok: true });
    expect(shellPaths).toEqual([
      { dir: join(home, '.dreamcontext', 'node', 'current', 'bin'), marker: NODE_RC_MARKER },
      { dir: join(home, '.dreamcontext', 'npm-global', 'bin'), marker: NODE_RC_MARKER },
    ]);
  });

  it('a refused folder name comes back refused', async () => {
    const { deps } = fakeDeps(undefined, {
      addToShellPath: (dir) => ({ dir, line: '', wrote: [], alreadyConfigured: [], refused: 'unsafe-chars' }),
    });
    expect((await runFix('node-shell-path', ctxFor(), recordingSink().sink, signal(), {}, deps)).reason).toBe('refused');
  });
});

describe('runFix', () => {
  it('never throws: a recipe that throws comes back as failed', async () => {
    const { deps } = fakeDeps(undefined, { fixClaudeShellPath: () => { throw new Error('kaput'); } });
    expect(await runFix('claude-path', ctxFor(), recordingSink().sink, signal(), {}, deps)).toEqual({ ok: false, reason: 'failed', detail: 'kaput' });
  });

  it('an already-canceled signal runs nothing', async () => {
    const ac = new AbortController();
    ac.abort();
    const { deps, calls } = fakeDeps();
    expect((await runFix('git-install', ctxFor(), recordingSink().sink, ac.signal, {}, deps)).reason).toBe('canceled');
    expect(calls).toEqual([]);
  });

  it('cli-install maps the installer result', async () => {
    const ok = fakeDeps();
    expect(await runFix('cli-install', ctxFor(), recordingSink().sink, signal(), {}, ok.deps)).toEqual({ ok: true });
    const bad = fakeDeps(undefined, { ensureCliInstalled: async () => ({ status: 'failed', message: 'npm was not found.' }) });
    expect((await runFix('cli-install', ctxFor(), recordingSink().sink, signal(), {}, bad.deps)).ok).toBe(false);
  });
});
