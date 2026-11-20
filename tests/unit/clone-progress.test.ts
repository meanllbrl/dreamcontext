import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  BIG_REPO_KB, cloneFailReason, cloneNeedsBytes, foldCloneProgress, originKey, parseCloneRepo,
  readOriginUrlFromConfig, registeredOriginKeys, type CloneProgress,
} from '../../src/lib/git-sync/github-browse.js';

// Plan ilk-acilis C10: the clone service's pure parts (progress, reasons, space, on this Mac).

describe('foldCloneProgress', () => {
  const start: CloneProgress = { phase: 'waiting-git' };

  it('reads the percent and the bytes from git\'s own Receiving line', () => {
    const p = foldCloneProgress(start, 'Receiving objects:  42% (1234/2937), 61.00 MiB | 5.20 MiB/s\r');
    expect(p).toEqual({ phase: 'receiving', percent: 42, receivedBytes: 61 * 1024 * 1024 });
  });

  it('moves through resolving and checkout, keeping the received bytes', () => {
    let p = foldCloneProgress(start, 'Receiving objects: 100% (10/10), 2.00 KiB | 1 KiB/s, done.\n');
    p = foldCloneProgress(p, 'Resolving deltas:  50% (1/2)\r');
    expect(p).toEqual({ phase: 'resolving', percent: 50, receivedBytes: 2048 });
    p = foldCloneProgress(p, 'Updating files:  12% (3/25)\r');
    expect(p).toEqual({ phase: 'checkout', percent: 12, receivedBytes: 2048 });
  });

  it('an unknown line leaves the last value (never a made-up number)', () => {
    const p = foldCloneProgress(start, 'Receiving objects:  7% (1/14)\r');
    expect(foldCloneProgress(p, 'remote: Enumerating objects: 2937, done.\nwarning: something\n')).toEqual(p);
    expect(foldCloneProgress(start, 'Cloning into \'api\'...\n')).toBe(start);
  });

  it('several updates in one chunk end on the last one', () => {
    const p = foldCloneProgress(start, 'Receiving objects:  10% (1/10)\rReceiving objects:  20% (2/10)\rReceiving objects:  30% (3/10)\r');
    expect(p.percent).toBe(30);
  });
});

describe('cloneFailReason', () => {
  it('names each end', () => {
    expect(cloneFailReason('timeout', '')).toBe('timeout');
    expect(cloneFailReason('cancelled', 'fatal: early EOF')).toBe('cancelled');
    expect(cloneFailReason('failed', 'fatal: write error: No space left on device')).toBe('no-space');
    expect(cloneFailReason('failed', 'fatal: Authentication failed for https://github.com/a/b.git')).toBe('auth');
    expect(cloneFailReason('failed', 'fatal: unable to access ...: Could not resolve host: github.com')).toBe('network');
    expect(cloneFailReason('failed', 'error: RPC failed; curl 18 transfer closed')).toBe('network');
    expect(cloneFailReason(undefined, 'something else')).toBe('unknown');
  });
});

describe('space and size', () => {
  it('needs twice GitHub\'s size, and 1 GB is the big-repo line', () => {
    expect(cloneNeedsBytes(1024)).toBe(2 * 1024 * 1024);
    expect(BIG_REPO_KB).toBe(1024 * 1024);
  });
});

describe('parseCloneRepo (S2)', () => {
  it('takes owner/name and a github.com URL', () => {
    expect(parseCloneRepo('acme/api')).toEqual({ owner: 'acme', repo: 'api' });
    expect(parseCloneRepo('https://github.com/acme/api.git')).toEqual({ owner: 'acme', repo: 'api' });
    expect(parseCloneRepo('git@github.com:acme/api.git')).toEqual({ owner: 'acme', repo: 'api' });
  });

  it('refuses option-shaped and traversal input', () => {
    for (const bad of ['--upload-pack=x/y', '-x/y', 'owner/..', '../a/b', 'ext::sh -c whoami', '', 'https://evil.example/acme/api']) {
      expect(parseCloneRepo(bad), bad).toBeNull();
    }
  });
});

describe('on this Mac (origins read from .git/config, never git)', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  function project(origin: string | null): string {
    const d = join(tmpdir(), `dc-origin-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(d, '.git'), { recursive: true });
    dirs.push(d);
    const remote = origin ? `[remote "origin"]\n\turl = ${origin}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n` : '';
    writeFileSync(join(d, '.git', 'config'), `[core]\n\tbare = false\n[remote "upstream"]\n\turl = https://github.com/other/thing.git\n${remote}`);
    return d;
  }

  it('reads only the origin remote and normalises it', () => {
    const a = project('git@github.com:Acme/API.git');
    expect(readOriginUrlFromConfig(a)).toBe('git@github.com:Acme/API.git');
    expect(originKey(readOriginUrlFromConfig(a))).toBe('acme/api');
    expect(readOriginUrlFromConfig(project(null))).toBeNull();
    expect(readOriginUrlFromConfig(join(tmpdir(), 'dc-no-such-folder'))).toBeNull();
  });

  it('maps each registered origin to its project once', () => {
    const a = project('https://github.com/acme/api.git');
    const b = project('https://github.com/ACME/api');
    const keys = registeredOriginKeys([{ name: 'api-2', path: a }, { name: 'api', path: b }]);
    expect(keys.get('acme/api')).toEqual({ vault: 'api-2', path: a });
    expect(keys.size).toBe(1);
  });
});
