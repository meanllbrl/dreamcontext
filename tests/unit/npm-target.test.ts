import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cliPackageVersion,
  npmInstallCommand,
  pathWithNode,
  resolveNpmTarget,
  targetCliEntry,
  upgradedCliCommand,
} from '../../src/lib/npm-target.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A real npm prefix on disk: `<prefix>/bin/dreamcontext` → the package's dist/index.js. */
function prefixOnDisk(opts: { npm?: 'js' | 'none'; version?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'dc-npm-target-'));
  dirs.push(root);
  const pkg = join(root, 'lib', 'node_modules', 'dreamcontext');
  mkdirSync(join(pkg, 'dist'), { recursive: true });
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(join(pkg, 'dist', 'index.js'), '');
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'dreamcontext', version: opts.version ?? '0.32.0' }));
  symlinkSync('../lib/node_modules/dreamcontext/dist/index.js', join(root, 'bin', 'dreamcontext'));
  if (opts.npm !== 'none') {
    const npmPkg = join(root, 'lib', 'node_modules', 'npm', 'bin');
    mkdirSync(npmPkg, { recursive: true });
    writeFileSync(join(npmPkg, 'npm-cli.js'), '');
    symlinkSync('../lib/node_modules/npm/bin/npm-cli.js', join(root, 'bin', 'npm'));
  }
  return root;
}

describe('resolveNpmTarget', () => {
  it('reads the prefix off the bin symlink and uses that prefix\'s own npm (nvm and brew alike)', () => {
    const prefix = prefixOnDisk();
    const t = resolveNpmTarget(join(prefix, 'bin', 'dreamcontext'), { platform: 'darwin', execPath: '/elsewhere/bin/node' });
    expect(t).not.toBeNull();
    // macOS tmp dirs live behind the /var → /private/var symlink: compare real paths.
    expect(t!.prefix.endsWith(prefix.replace(/^\/private/, ''))).toBe(true);
    expect(t!.npm.endsWith('/lib/node_modules/npm/bin/npm-cli.js')).toBe(true);
    expect(t!.npmViaNode).toBe(true);
    expect(t!.entry.endsWith('/lib/node_modules/dreamcontext/dist/index.js')).toBe(true);
  });

  it('a prefix without npm (the app\'s private Node globals) uses the npm beside node', () => {
    const t = resolveNpmTarget('/Users/me/.dreamcontext/npm-global/lib/node_modules/dreamcontext/dist/index.js', {
      platform: 'darwin',
      realpath: (p) => p,
      exists: (p) => p === '/Users/me/.dreamcontext/node/bin/npm',
      execPath: '/Users/me/.dreamcontext/node/bin/node',
    });
    expect(t).toEqual({
      prefix: '/Users/me/.dreamcontext/npm-global',
      npm: '/Users/me/.dreamcontext/node/bin/npm',
      npmViaNode: false,
      entry: '/Users/me/.dreamcontext/npm-global/lib/node_modules/dreamcontext/dist/index.js',
    });
  });

  it('no npm anywhere falls back to npm on PATH, still pinned to the prefix', () => {
    const t = resolveNpmTarget('/opt/homebrew/lib/node_modules/dreamcontext/dist/index.js', {
      platform: 'darwin', realpath: (p) => p, exists: () => false, execPath: '/x/node',
    });
    expect(t?.npm).toBe('npm');
    expect(npmInstallCommand(['install', '-g', 'dreamcontext@latest'], t)).toEqual({
      file: 'npm', args: ['install', '-g', 'dreamcontext@latest', '--prefix', '/opt/homebrew'],
    });
  });

  it('is null for anything that is not a global install: npx cache, a repo checkout, the bundled copy, Windows, nothing', () => {
    const id = (p: string) => p;
    const opts = { platform: 'darwin' as const, realpath: id, exists: () => true };
    expect(resolveNpmTarget('/Users/me/.npm/_npx/ab12/node_modules/dreamcontext/dist/index.js', opts)).toBeNull();
    expect(resolveNpmTarget('/Users/me/projects/dreamcontext/dist/index.js', opts)).toBeNull();
    expect(resolveNpmTarget('/Applications/dreamcontext-beta.app/Contents/Resources/dist/index.js', opts)).toBeNull();
    expect(resolveNpmTarget('C:/Users/me/AppData/Roaming/npm/lib/node_modules/dreamcontext/dist/index.js', { ...opts, platform: 'win32' })).toBeNull();
    expect(resolveNpmTarget(undefined, opts)).toBeNull();
  });
});

describe('commands', () => {
  const target = { prefix: '/p', npm: '/p/lib/node_modules/npm/bin/npm-cli.js', npmViaNode: true, entry: '/p/lib/node_modules/dreamcontext/dist/index.js' };

  it('runs a JS npm with node, pinned to the prefix', () => {
    expect(npmInstallCommand(['install', '-g', 'dreamcontext@latest'], target, '/n/bin/node')).toEqual({
      file: '/n/bin/node',
      args: ['/p/lib/node_modules/npm/bin/npm-cli.js', 'install', '-g', 'dreamcontext@latest', '--prefix', '/p'],
    });
    expect(npmInstallCommand(['install', '-g', 'dreamcontext@latest'], null)).toEqual({ file: 'npm', args: ['install', '-g', 'dreamcontext@latest'] });
  });

  it('runs the upgraded CLI by path, or nothing without a target', () => {
    expect(upgradedCliCommand(['update', '--yes'], target, '/n/bin/node')).toEqual({
      file: '/n/bin/node', args: ['/p/lib/node_modules/dreamcontext/dist/index.js', 'update', '--yes'],
    });
    expect(upgradedCliCommand(['update', '--yes'], null)).toBeNull();
  });

  it('the global CLI the shell found wins over the running entry', () => {
    expect(targetCliEntry({ DREAMCONTEXT_GLOBAL_CLI: '/g/bin/dreamcontext' }, '/app/Resources/dist/index.js')).toBe('/g/bin/dreamcontext');
    expect(targetCliEntry({}, '/run/dist/index.js')).toBe('/run/dist/index.js');
  });

  it('puts node\'s folder first on PATH, once', () => {
    expect(pathWithNode({ PATH: '/usr/bin:/n/bin:/bin' }, '/n/bin/node')).toBe('/n/bin:/usr/bin:/bin');
    expect(pathWithNode({}, '/n/bin/node')).toBe('/n/bin');
  });
});

describe('cliPackageVersion', () => {
  it('reads the dreamcontext version through the bin symlink; null for a bundled copy', () => {
    const prefix = prefixOnDisk({ version: '0.34.9' });
    expect(cliPackageVersion(join(prefix, 'bin', 'dreamcontext'))).toBe('0.34.9');
    const bundle = mkdtempSync(join(tmpdir(), 'dc-bundle-'));
    dirs.push(bundle);
    mkdirSync(join(bundle, 'X.app', 'Contents', 'Resources', 'dist'), { recursive: true });
    writeFileSync(join(bundle, 'X.app', 'Contents', 'Resources', 'dist', 'index.js'), '');
    expect(cliPackageVersion(join(bundle, 'X.app', 'Contents', 'Resources', 'dist', 'index.js'))).toBeNull();
    expect(cliPackageVersion(undefined)).toBeNull();
  });
});
