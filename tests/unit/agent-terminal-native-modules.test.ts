import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cliPackageRoot, ensureNativeModulesDir, nativeModulesDir } from '../../src/server/routes/agent-terminal.js';

/**
 * `node-pty` is a native module, so it can't be bundled — it has to be INSTALLED
 * somewhere the server can resolve it from. These two helpers pick that target:
 * `cliPackageRoot()` for an npm install / dev link, and `nativeModulesDir()` when
 * the running CLI is the read-only .app bundle.
 */
describe('node-pty install target resolution', () => {
  let root: string;

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dc-native-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const writePkg = (dir: string, pkg: unknown) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg), 'utf-8');
  };

  describe('cliPackageRoot', () => {
    it('finds the dreamcontext package root above the entry module', () => {
      writePkg(root, { name: 'dreamcontext', version: '1.2.3' });
      mkdirSync(join(root, 'dist'), { recursive: true });
      expect(cliPackageRoot(join(root, 'dist', 'index.js'))).toBe(root);
    });

    it('returns null for the .app layout, which has no package root at all', () => {
      // Contents/Resources/dist/index.js — exactly what Tauri ships.
      const dist = join(root, 'Contents', 'Resources', 'dist');
      mkdirSync(dist, { recursive: true });
      expect(cliPackageRoot(join(dist, 'index.js'))).toBeNull();
    });

    it('IGNORES an unrelated package.json instead of installing into someone else\'s project', () => {
      // The bug this guards: a bare "nearest package.json" walk escapes the .app
      // bundle and adopts whatever manifest it meets first (a stray ~/package.json
      // or /tmp/package.json), silently installing a native module there.
      writePkg(root, { dependencies: { 'lz-string': '^1.5.0' } });
      const dist = join(root, 'Contents', 'Resources', 'dist');
      mkdirSync(dist, { recursive: true });
      expect(cliPackageRoot(join(dist, 'index.js'))).toBeNull();
    });

    it('walks past an unrelated manifest to reach the real dreamcontext one', () => {
      writePkg(root, { name: 'dreamcontext', version: '1.2.3' });
      writePkg(join(root, 'vendored'), { name: 'something-else' });
      mkdirSync(join(root, 'vendored', 'dist'), { recursive: true });
      expect(cliPackageRoot(join(root, 'vendored', 'dist', 'index.js'))).toBe(root);
    });

    it('keeps walking past a malformed manifest rather than throwing', () => {
      writePkg(root, { name: 'dreamcontext', version: '1.2.3' });
      const broken = join(root, 'broken');
      mkdirSync(broken, { recursive: true });
      writeFileSync(join(broken, 'package.json'), '{ not json', 'utf-8');
      expect(cliPackageRoot(join(broken, 'index.js'))).toBe(root);
    });

    it('returns null with no entry module to walk up from', () => {
      // `undefined` is not this case — it selects the default (real `process.argv[1]`).
      expect(cliPackageRoot('')).toBeNull();
    });

    it('defaults to the running entry module, which under test IS this repo', () => {
      expect(cliPackageRoot()).toBe(process.cwd());
    });
  });

  describe('ensureNativeModulesDir', () => {
    it('creates the dir with a private manifest, so npm cannot adopt $HOME', () => {
      const dir = ensureNativeModulesDir(root);
      expect(dir).toBe(nativeModulesDir(root));
      expect(dir).toBe(join(root, '.dreamcontext', 'native'));

      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as Record<string, unknown>;
      expect(pkg.private).toBe(true);
      // NOT 'dreamcontext' — cliPackageRoot must never mistake this for the CLI.
      expect(pkg.name).toBe('dreamcontext-native');
    });

    it('is idempotent and never clobbers an existing manifest', () => {
      const dir = ensureNativeModulesDir(root);
      const marked = { name: 'dreamcontext-native', version: '0.0.0', private: true, keep: 'me' };
      writeFileSync(join(dir, 'package.json'), JSON.stringify(marked), 'utf-8');

      expect(ensureNativeModulesDir(root)).toBe(dir);
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as Record<string, unknown>;
      expect(pkg.keep).toBe('me');
    });
  });
});
