import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { restorePtyHelpers } from '../../src/server/routes/agent-terminal.js';

/**
 * Field 2026-11-13/14 ("terminal çalışmıyor"): `npm i -g <tarball>` over the running app wrote a
 * fresh node-pty `spawn-helper` with no execute bit, at the path the already loaded node-pty
 * spawns through. The +x fix had run once at boot, so every run card died with
 * `posix_spawnp failed` until the app restarted. The fix now runs on every load.
 */
describe('a spawn-helper rewritten by an install gets its execute bit back', () => {
  let root = '';
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = ''; });

  it('restores +x on the prebuilt and the locally built helper, again after a second install', () => {
    root = mkdtempSync(join(tmpdir(), 'dc-pty-'));
    const pre = join(root, 'prebuilds', 'darwin-arm64', 'spawn-helper');
    const built = join(root, 'build', 'Release', 'spawn-helper');
    for (const p of [pre, built]) {
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, 'x');
      chmodSync(p, 0o644);
    }
    restorePtyHelpers(root);
    expect(statSync(pre).mode & 0o777).toBe(0o755);
    expect(statSync(built).mode & 0o777).toBe(0o755);
    // A second install over the same running process: the same path loses +x again.
    chmodSync(pre, 0o644);
    restorePtyHelpers(root);
    expect(statSync(pre).mode & 0o777).toBe(0o755);
  });

  it('a package with no helpers is not an error', () => {
    root = mkdtempSync(join(tmpdir(), 'dc-pty-'));
    expect(() => restorePtyHelpers(root)).not.toThrow();
  });

  it('the memoized load re-checks the helper instead of trusting the boot-time fix', () => {
    const src = readFileSync(new URL('../../src/server/routes/agent-terminal.ts', import.meta.url), 'utf-8');
    const load = src.slice(src.indexOf('export function loadNodePty('));
    const memo = load.slice(0, load.indexOf('for (const base'));
    expect(memo).toMatch(/if \(ptyModule\) ensurePtyHelperExecutable\(\);/);
  });
});
