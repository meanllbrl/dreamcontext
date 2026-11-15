// The npm bridge (plan npmsiz-beta C3′, owner 15 Nov: "npm'den çıkıp direkt sürüm"). dreamcontext
// now ships as a Mac app with its own Node; this npm release is the last one, and it hands over:
//
//  - An npm global on a Mac where the app has written its record (`~/.dreamcontext/app-cli.json`,
//    src/lib/app-cli-path.ts writeAppCliRecord) runs the APP's CLI instead, with the same
//    arguments, stdin and stdout, and exits with its code. Every terminal call and every hook
//    that still finds the npm copy first therefore runs the app's (newer) CLI.
//  - An npm global on an Apple Silicon Mac with no app says, once a day and only to a person at a
//    terminal (stderr is a TTY; a hook's stderr is a pipe), where the app is.
//  - Anything else (a linked checkout, the app itself, Windows, Linux, Intel) runs as before.
//
// It runs from bin.ts BEFORE the CLI bundle is compiled, so the hand-over costs one small file.
// Never twice: the child gets DREAMCONTEXT_REEXEC=1, and every process consumes (deletes) it at
// start. Nothing here throws: any doubt runs this CLI itself.
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { classifyCli, readAppCliRecord } from '../lib/cli-precedence.js';

export const APP_DOWNLOAD_URL = 'https://github.com/meanllbrl/dreamcontext/releases/latest';
export const MOVE_NOTICE =
  `dreamcontext now comes as a Mac app, no npm needed: ${APP_DOWNLOAD_URL} (this npm copy gets no more updates)`;
const NOTICE_EVERY_MS = 24 * 60 * 60 * 1000;

export interface BridgeFacts {
  env: NodeJS.ProcessEnv;
  argv: string[];
  execPath: string;
  platform: NodeJS.Platform;
  arch: string;
  home: string;
  now: number;
  stderrIsTTY: boolean;
}

export type BridgePlan =
  | { kind: 'reexec'; node: string; entry: string; args: string[] }
  | { kind: 'self'; notice: boolean };

function real(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

function pkgNameAbove(entry: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(dirname(entry)), 'package.json'), 'utf-8')) as { name?: unknown };
    return typeof pkg.name === 'string' ? pkg.name : null;
  } catch {
    return null;
  }
}

export function noticeStampPath(home: string): string {
  return join(home, '.dreamcontext', 'move-to-app-notice');
}

function noticeDue(home: string, now: number): boolean {
  try {
    return now - statSync(noticeStampPath(home)).mtimeMs >= NOTICE_EVERY_MS;
  } catch {
    return true;
  }
}

/** What this process does. Pure apart from reading the record, realpaths and the stamp. */
export function bridgePlan(f: BridgeFacts): BridgePlan {
  if (f.env.DREAMCONTEXT_REEXEC === '1') return { kind: 'self', notice: false };
  if (f.platform !== 'darwin' || !f.argv[1]) return { kind: 'self', notice: false };
  const entry = real(f.argv[1]);
  const kind = classifyCli({
    windows: false, home: f.home, entry, exec: real(f.execPath),
    pkgName: pkgNameAbove(entry), record: null, installLocation: null,
  });
  if (kind !== 'npm-global') return { kind: 'self', notice: false };
  const rec = readAppCliRecord(f.home, false);
  if (rec && existsSync(rec.node) && existsSync(rec.entry)) {
    return { kind: 'reexec', node: rec.node, entry: rec.entry, args: f.argv.slice(2) };
  }
  // The app is Apple Silicon only: an Intel Mac is told nothing it cannot use.
  return { kind: 'self', notice: f.arch === 'arm64' && f.stderrIsTTY && noticeDue(f.home, f.now) };
}

function stampNotice(home: string): void {
  try {
    const dir = join(home, '.dreamcontext');
    mkdirSync(dir, { recursive: true });
    if (lstatSync(dir).isSymbolicLink()) return;
    writeFileSync(noticeStampPath(home), `${new Date().toISOString()}\n`);
  } catch { /* no stamp: the note shows again next time, harmless */ }
}

type Spawn = (cmd: string, args: string[], opts: { stdio: 'inherit'; env: NodeJS.ProcessEnv }) => Pick<SpawnSyncReturns<Buffer>, 'status' | 'signal' | 'error'>;

/**
 * Run the bridge for this process: returns when this CLI should go on, otherwise exits with the
 * app CLI's code. `DREAMCONTEXT_REEXEC` is consumed here, so nothing this process starts inherits it.
 */
export function runBridge(
  f: BridgeFacts = {
    env: process.env, argv: process.argv, execPath: process.execPath, platform: process.platform,
    arch: process.arch, home: homedir(), now: Date.now(), stderrIsTTY: process.stderr.isTTY === true,
  },
  io: { spawn?: Spawn; exit?: (code: number) => never; kill?: (signal: NodeJS.Signals) => void; warn?: (line: string) => void } = {},
): void {
  let plan: BridgePlan;
  try {
    plan = bridgePlan(f);
  } catch {
    plan = { kind: 'self', notice: false };
  }
  delete f.env.DREAMCONTEXT_REEXEC;
  if (plan.kind === 'self') {
    if (plan.notice) {
      (io.warn ?? ((l: string) => process.stderr.write(`${l}\n`)))(MOVE_NOTICE);
      stampNotice(f.home);
    }
    return;
  }
  const spawn = io.spawn ?? ((cmd, args, opts) => spawnSync(cmd, args, opts));
  const r = spawn(plan.node, [plan.entry, ...plan.args], { stdio: 'inherit', env: { ...f.env, DREAMCONTEXT_REEXEC: '1' } });
  if (r.error) return; // The app's CLI could not start: this one runs instead.
  const exit = io.exit ?? ((code: number) => process.exit(code));
  if (r.signal) {
    (io.kill ?? ((s) => process.kill(process.pid, s)))(r.signal);
    exit(1);
  }
  exit(r.status ?? 1);
}
