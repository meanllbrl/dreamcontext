import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bundledPtyRoot } from '../../src/server/routes/agent-terminal.js';
import { isAppRuntimeNode } from '../../src/lib/onboarding/platform.js';

// Plan npmsiz-beta C1 (L3): the app bundle and its copy ship node-pty at <dist>/../native/node-pty.
describe('the node-pty the app ships beside its dist', () => {
  let root = '';
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = ''; });

  const layout = () => {
    root = mkdtempSync(join(tmpdir(), 'dc-rt-'));
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist', 'index.js'), '');
    return join(root, 'dist', 'index.js');
  };

  it('is found for the bundle and copy layout', () => {
    const dist = layout();
    mkdirSync(join(root, 'native', 'node-pty'), { recursive: true });
    writeFileSync(join(root, 'native', 'node-pty', 'package.json'), '{}');
    expect(bundledPtyRoot(dist)).toBe(join(root, 'native', 'node-pty'));
  });

  it('is null for a CLI that ships none (npm install, dev)', () => {
    expect(bundledPtyRoot(layout())).toBeNull();
  });

  it('never follows a linked node-pty folder', () => {
    const dist = layout();
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'package.json'), '{}');
    mkdirSync(join(root, 'native'));
    symlinkSync(elsewhere, join(root, 'native', 'node-pty'));
    expect(bundledPtyRoot(dist)).toBeNull();
  });
});

describe('the node the desktop app ships', () => {
  it('is the bundle runtime or the copy under ~/.dreamcontext/bin/rt, nothing else', () => {
    expect(isAppRuntimeNode('/Applications/dreamcontext-beta.app/Contents/Resources/runtime/bin/node', '/Users/u')).toBe(true);
    expect(isAppRuntimeNode('/Users/u/.dreamcontext/bin/rt/0.41.21/runtime/bin/node', '/Users/u')).toBe(true);
    expect(isAppRuntimeNode('C:\\Users\\u\\AppData\\Local\\dreamcontext-beta\\runtime\\node.exe', 'C:\\Users\\u')).toBe(true);
    expect(isAppRuntimeNode('/opt/homebrew/bin/node', '/Users/u')).toBe(false);
    expect(isAppRuntimeNode('/Users/u/.dreamcontext/node/current/bin/node', '/Users/u')).toBe(false);
  });
});

describe('stage-bundled-pty.mjs', () => {
  let dir = '';
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });

  const fakePkg = () => {
    dir = mkdtempSync(join(tmpdir(), 'dc-pty-stage-'));
    const src = join(dir, 'node-pty');
    for (const f of ['package.json', 'LICENSE', 'lib/index.js', 'lib/index.js.map', 'lib/a.test.js', 'prebuilds/darwin-arm64/pty.node', 'prebuilds/darwin-arm64/spawn-helper', 'prebuilds/win32-x64/pty.node']) {
      mkdirSync(join(src, f, '..'), { recursive: true });
      writeFileSync(join(src, f), 'x');
    }
    chmodSync(join(src, 'prebuilds/darwin-arm64/spawn-helper'), 0o644);
    return src;
  };

  it('ships only what loading needs, for one platform, with spawn-helper executable', async () => {
    const { stageBundledPty } = await import('../../scripts/stage-bundled-pty.mjs');
    const src = fakePkg();
    const out = join(dir, 'out', 'node-pty');
    expect(stageBundledPty('darwin-arm64', { src, out })).toEqual([
      'LICENSE', 'lib/index.js', 'package.json', 'prebuilds/darwin-arm64/pty.node', 'prebuilds/darwin-arm64/spawn-helper',
    ]);
    expect(statSync(join(out, 'prebuilds/darwin-arm64/spawn-helper')).mode & 0o777).toBe(0o755);
  });

  it('stops on a link anywhere in the package', async () => {
    const { stageBundledPty } = await import('../../scripts/stage-bundled-pty.mjs');
    const src = fakePkg();
    symlinkSync('/etc/hosts', join(src, 'lib', 'evil.js'));
    expect(() => stageBundledPty('darwin-arm64', { src, out: join(dir, 'out2') })).toThrow(/link is not allowed/);
  });
});
