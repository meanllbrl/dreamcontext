import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bridgePlan, runBridge, noticeStampPath, MOVE_NOTICE, type BridgeFacts } from '../../src/cli/bridge.js';

/**
 * The last npm release hands over to the Mac app (plan npmsiz-beta C3′, criterion 26): an npm
 * global with the app's record runs the app's CLI; without the app it says where the app is,
 * once a day, to a terminal only; nothing else changes.
 */
let root: string;
let home: string;
let npmEntry: string;
let app: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'dc-bridge-')));
  home = join(root, 'home');
  mkdirSync(join(home, '.dreamcontext'), { recursive: true });
  // An npm global install: <prefix>/lib/node_modules/dreamcontext/dist/index.js
  const pkg = join(root, 'prefix', 'lib', 'node_modules', 'dreamcontext');
  mkdirSync(join(pkg, 'dist'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'dreamcontext', version: '0.41.21' }));
  npmEntry = join(pkg, 'dist', 'index.js');
  writeFileSync(npmEntry, '');
  // A lasting app bundle.
  app = join(home, 'Applications', 'dreamcontext-beta.app');
  mkdirSync(join(app, 'Contents', 'Resources', 'runtime', 'bin'), { recursive: true });
  mkdirSync(join(app, 'Contents', 'Resources', 'dist'), { recursive: true });
  writeFileSync(join(app, 'Contents', 'Resources', 'runtime', 'bin', 'node'), '');
  writeFileSync(join(app, 'Contents', 'Resources', 'dist', 'index.js'), '');
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const appNode = () => join(app, 'Contents', 'Resources', 'runtime', 'bin', 'node');
const appEntry = () => join(app, 'Contents', 'Resources', 'dist', 'index.js');
function writeRecord(): void {
  writeFileSync(join(home, '.dreamcontext', 'app-cli.json'), JSON.stringify({ version: '0.42.0', node: appNode(), entry: appEntry(), appPath: app }));
}
function facts(over: Partial<BridgeFacts> = {}): BridgeFacts {
  return {
    env: {}, argv: ['/usr/local/bin/node', npmEntry, 'hook', 'session-start'], execPath: '/usr/local/bin/node',
    platform: 'darwin', arch: 'arm64', home, now: Date.now(), stderrIsTTY: true, ...over,
  };
}

describe('bridgePlan', () => {
  it('an npm global with the app record runs the app CLI with the same arguments', () => {
    writeRecord();
    expect(bridgePlan(facts())).toEqual({ kind: 'reexec', node: appNode(), entry: appEntry(), args: ['hook', 'session-start'] });
  });

  it('never twice: a re-exec\'d process runs itself', () => {
    writeRecord();
    expect(bridgePlan(facts({ env: { DREAMCONTEXT_REEXEC: '1' } }))).toEqual({ kind: 'self', notice: false });
  });

  it('a record whose app was removed: runs itself and shows the note', () => {
    writeRecord();
    rmSync(app, { recursive: true, force: true });
    expect(bridgePlan(facts())).toEqual({ kind: 'self', notice: true });
  });

  it('no app: the note only to a terminal, only on Apple Silicon, only once a day', () => {
    expect(bridgePlan(facts())).toEqual({ kind: 'self', notice: true });
    expect(bridgePlan(facts({ stderrIsTTY: false }))).toEqual({ kind: 'self', notice: false });
    expect(bridgePlan(facts({ arch: 'x64' }))).toEqual({ kind: 'self', notice: false });
    writeFileSync(noticeStampPath(home), 'x');
    expect(bridgePlan(facts())).toEqual({ kind: 'self', notice: false });
    const old = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
    utimesSync(noticeStampPath(home), old, old);
    expect(bridgePlan(facts())).toEqual({ kind: 'self', notice: true });
  });

  it('Windows and Linux npm copies are left exactly as they were', () => {
    writeRecord();
    expect(bridgePlan(facts({ platform: 'win32' }))).toEqual({ kind: 'self', notice: false });
    expect(bridgePlan(facts({ platform: 'linux' }))).toEqual({ kind: 'self', notice: false });
  });

  it('a linked checkout and the app bundle itself run as themselves', () => {
    writeRecord();
    const checkout = join(root, 'code', 'dreamcontext');
    mkdirSync(join(checkout, 'dist'), { recursive: true });
    writeFileSync(join(checkout, 'package.json'), JSON.stringify({ name: 'dreamcontext' }));
    writeFileSync(join(checkout, 'dist', 'index.js'), '');
    expect(bridgePlan(facts({ argv: ['node', join(checkout, 'dist', 'index.js')] }))).toEqual({ kind: 'self', notice: false });
    expect(bridgePlan(facts({ argv: [appNode(), appEntry()], execPath: appNode() }))).toEqual({ kind: 'self', notice: false });
  });

  it('a record naming the DMG is not used', () => {
    writeFileSync(join(home, '.dreamcontext', 'app-cli.json'), JSON.stringify({
      version: '0.42.0', node: '/Volumes/d/x.app/Contents/Resources/runtime/bin/node', entry: '/Volumes/d/x.app/Contents/Resources/dist/index.js',
    }));
    expect(bridgePlan(facts()).kind).toBe('self');
  });
});

describe('runBridge', () => {
  it('hands over: spawns the app CLI with DREAMCONTEXT_REEXEC=1 and exits with its code', () => {
    writeRecord();
    const env: NodeJS.ProcessEnv = { DREAMCONTEXT_REEXEC: '0', PATH: '/usr/bin' };
    const calls: Array<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    let code: number | null = null;
    runBridge(facts({ env }), {
      spawn: (cmd, args, opts) => { calls.push({ cmd, args, env: opts.env }); return { status: 3, signal: null, error: undefined }; },
      exit: ((c: number) => { code = c; }) as unknown as (c: number) => never,
    });
    expect(calls).toEqual([{ cmd: appNode(), args: [appEntry(), 'hook', 'session-start'], env: { PATH: '/usr/bin', DREAMCONTEXT_REEXEC: '1' } }]);
    expect(code).toBe(3);
    expect(env.DREAMCONTEXT_REEXEC).toBeUndefined();
  });

  it('the app CLI failing to start: this CLI runs instead, no exit', () => {
    writeRecord();
    let exited = false;
    runBridge(facts(), {
      spawn: () => ({ status: null, signal: null, error: new Error('ENOENT') }),
      exit: (() => { exited = true; }) as unknown as (c: number) => never,
    });
    expect(exited).toBe(false);
  });

  it('a re-exec\'d child consumes the flag, so nothing it starts inherits it', () => {
    const env: NodeJS.ProcessEnv = { DREAMCONTEXT_REEXEC: '1' };
    runBridge(facts({ env }), { spawn: () => { throw new Error('no spawn'); } });
    expect(env.DREAMCONTEXT_REEXEC).toBeUndefined();
  });

  it('no app: prints the note once and stamps it', () => {
    const lines: string[] = [];
    runBridge(facts(), { warn: (l) => lines.push(l) });
    runBridge(facts(), { warn: (l) => lines.push(l) });
    expect(lines).toEqual([MOVE_NOTICE]);
    expect(existsSync(noticeStampPath(home))).toBe(true);
  });
});
