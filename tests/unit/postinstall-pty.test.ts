import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// @ts-expect-error plain .mjs install script, no types
import { fixSpawnHelpers } from '../../scripts/postinstall-pty.mjs';

/**
 * 2026-11-23 cut: `npm i -g <tarball>` left node-pty's spawn-helper at 0644 (the registry tarball
 * ships it so, and node-pty's own postinstall skips prebuilds/), so every user's fresh install
 * hit `posix_spawnp failed`. The package now fixes it at install time.
 */
describe('postinstall gives the node-pty spawn-helper its execute bit', () => {
  let root = '';
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = ''; });

  it('fixes every prebuilt and built helper, leaves executable ones alone', () => {
    root = mkdtempSync(join(tmpdir(), 'dc-postinst-'));
    const files = ['prebuilds/darwin-arm64/spawn-helper', 'prebuilds/darwin-x64/spawn-helper', 'build/Release/spawn-helper'];
    for (const f of files) {
      mkdirSync(join(root, f, '..'), { recursive: true });
      writeFileSync(join(root, f), 'x');
      chmodSync(join(root, f), 0o644);
    }
    chmodSync(join(root, files[1]), 0o755);
    expect(fixSpawnHelpers(root)).toBe(2);
    for (const f of files) expect(statSync(join(root, f)).mode & 0o111).toBe(0o111);
  });

  it('a root with no helpers is not an error', () => {
    root = mkdtempSync(join(tmpdir(), 'dc-postinst-'));
    expect(fixSpawnHelpers(root)).toBe(0);
  });

  it('is wired as the package postinstall and ships in the tarball', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'));
    expect(pkg.scripts.postinstall).toBe('node scripts/postinstall-pty.mjs');
    expect(pkg.files).toContain('scripts/postinstall-pty.mjs');
  });
});
