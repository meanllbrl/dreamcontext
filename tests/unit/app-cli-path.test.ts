/**
 * `dreamcontext` on PATH with no click on the app's own Node (npmsiz-beta, fresh-Mac gaps a, b):
 *  - on the app runtime the launcher is written for that node and entry, and its folder rides
 *    every PATH the app hands a Claude (chat and terminal); the rc gets one line, once;
 *  - anywhere else (a global npm CLI, Windows) nothing is written and PATH is unchanged.
 * Scratch HOME only.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appRuntimePath, ensureAppCliOnShellPath } from '../../src/lib/app-cli-path.js';
import { CLI_RC_MARKER } from '../../src/lib/claude-path.js';

const APP_NODE = '/Applications/dreamcontext.app/Contents/Resources/runtime/bin/node';
const ENTRY = '/Applications/dreamcontext.app/Contents/Resources/dist/index.js';
let home: string;
const saved = { HOME: process.env.HOME, SHELL: process.env.SHELL };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'app-cli-path-'));
  process.env.HOME = home;
  process.env.SHELL = '/bin/zsh';
});
afterEach(() => {
  process.env.HOME = saved.HOME;
  process.env.SHELL = saved.SHELL;
  rmSync(home, { recursive: true, force: true });
});

const shimDir = () => join(home, '.dreamcontext', 'bin', 'cli');

describe('the app runtime', () => {
  it('puts the launcher folder first on a spawn PATH, the launcher naming this node and entry', () => {
    const p = appRuntimePath('/usr/bin:/bin', { execPath: APP_NODE, entry: ENTRY, home, platform: 'darwin' });
    expect(p.split(':')[0]).toBe(shimDir());
    expect(p.split(':')).toContain('/usr/bin');
    const shim = readFileSync(join(shimDir(), 'dreamcontext'), 'utf-8');
    expect(shim).toContain(`'${APP_NODE}' '${ENTRY}'`);
  });

  it('with a global npm CLI on the machine (the bundle only newer), the rc is left alone', () => {
    const globalCli = '/opt/homebrew/lib/node_modules/dreamcontext/dist/index.js';
    expect(ensureAppCliOnShellPath({ execPath: APP_NODE, entry: ENTRY, home, platform: 'darwin', globalCli })).toBeNull();
    expect(existsSync(join(home, '.zshrc'))).toBe(false);
  });

  it('at start (no global CLI) writes the launcher and adds its folder to the rc once, under the CLI marker', () => {
    const first = ensureAppCliOnShellPath({ execPath: APP_NODE, entry: ENTRY, home, platform: 'darwin', globalCli: '' });
    expect(first?.dir).toBe(shimDir());
    expect(existsSync(join(shimDir(), 'dreamcontext'))).toBe(true);
    const again = ensureAppCliOnShellPath({ execPath: APP_NODE, entry: ENTRY, home, platform: 'darwin', globalCli: '' });
    expect(again?.wrote).toEqual([]);
    const rc = readFileSync(join(home, '.zshrc'), 'utf-8');
    expect(rc.split(CLI_RC_MARKER).length - 1).toBe(1);
    expect(rc).toContain('export PATH="$HOME/.dreamcontext/bin/cli:$PATH"');
  });
});

describe('a one-run bundle (opened from the DMG, or App Translocation)', () => {
  const runs = [
    ['the mounted DMG', '/Volumes/dreamcontext/dreamcontext.app/Contents/Resources'],
    ['App Translocation', '/private/var/folders/ab/T/AppTranslocation/1F2E/d/dreamcontext.app/Contents/Resources'],
  ] as const;
  for (const [name, res] of runs) {
    it(`${name}: no launcher naming it and no rc line; a launcher from a lasting install stays`, () => {
      const node = `${res}/runtime/bin/node`;
      const entry = `${res}/dist/index.js`;
      expect(ensureAppCliOnShellPath({ execPath: node, entry, home, platform: 'darwin', globalCli: '' })).toBeNull();
      expect(existsSync(join(shimDir(), 'dreamcontext'))).toBe(false);
      expect(existsSync(join(home, '.zshrc'))).toBe(false);
      // This run's own spawns still find the CLI, through a launcher in its run-only folder.
      const spawnPath = appRuntimePath('/usr/bin:/bin', { execPath: node, entry, home, platform: 'darwin' }).split(':');
      const runDir = join(home, '.dreamcontext', 'bin', 'run', String(process.pid));
      expect(spawnPath).not.toContain(shimDir());
      expect(spawnPath[0]).toBe(runDir);
      expect(readFileSync(join(runDir, 'dreamcontext'), 'utf-8')).toContain(`'${node}' '${entry}'`);
      expect(existsSync(join(home, '.zshrc'))).toBe(false);

      ensureAppCliOnShellPath({ execPath: APP_NODE, entry: ENTRY, home, platform: 'darwin', globalCli: '' });
      const lasting = readFileSync(join(shimDir(), 'dreamcontext'), 'utf-8');
      appRuntimePath('', { execPath: node, entry, home, platform: 'darwin' });
      ensureAppCliOnShellPath({ execPath: node, entry, home, platform: 'darwin', globalCli: '' });
      expect(readFileSync(join(shimDir(), 'dreamcontext'), 'utf-8')).toBe(lasting);
    });
  }

  it("a run folder whose process ended is removed; a live one and a symlink are kept", () => {
    const root = join(home, '.dreamcontext', 'bin', 'run');
    const dead = join(root, '999999999');
    const live = join(root, String(process.ppid));
    const outside = mkdtempSync(join(tmpdir(), 'app-cli-path-'));
    mkdirSync(dead, { recursive: true });
    mkdirSync(live, { recursive: true });
    symlinkSync(outside, join(root, '999999998'));
    appRuntimePath('', { execPath: '/Volumes/d/dreamcontext.app/Contents/Resources/runtime/bin/node', entry: '/Volumes/d/dreamcontext.app/Contents/Resources/dist/index.js', home, platform: 'darwin' });
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(outside)).toBe(true);
    rmSync(outside, { recursive: true, force: true });
  });
});

describe('anywhere else', () => {
  it('a global npm CLI: PATH unchanged, nothing written', () => {
    const node = '/opt/homebrew/bin/node';
    expect(appRuntimePath('/usr/bin', { execPath: node, entry: '/opt/homebrew/lib/node_modules/dreamcontext/dist/index.js', home, platform: 'darwin' })).toBe('/usr/bin');
    expect(ensureAppCliOnShellPath({ execPath: node, home, platform: 'darwin' })).toBeNull();
    expect(existsSync(join(home, '.dreamcontext'))).toBe(false);
    expect(existsSync(join(home, '.zshrc'))).toBe(false);
  });

  it('Windows: nothing here (its PATH has its own writer)', () => {
    expect(ensureAppCliOnShellPath({ execPath: 'C:/Program Files/dreamcontext/runtime/node.exe', home, platform: 'win32' })).toBeNull();
    expect(appRuntimePath('X', { execPath: 'C:/Program Files/dreamcontext/runtime/node.exe', home, platform: 'win32' })).toBe('X');
  });
});

describe('wiring', () => {
  it('server start, every chat spawn and the terminal spawn go through it', () => {
    const read = (f: string) => readFileSync(new URL(`../../src/${f}`, import.meta.url), 'utf-8');
    expect(read('server/index.ts')).toMatch(/ensureAppCliOnShellPath\(\)/);
    expect(read('server/routes/agent-chat.ts')).toMatch(/childEnv\.PATH = appRuntimePath\(/);
    expect(read('server/routes/agent-terminal.ts')).toMatch(/PATH: appRuntimePath\(/);
  });
});
