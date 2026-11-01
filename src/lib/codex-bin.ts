/**
 * The one answer to "which Codex, and can it start": readiness, a chat, a headless run, the
 * terminal and account sign-in all resolve it here, so they can never disagree.
 *
 * Two different Nodes are in play and they are not the same requirement:
 *  - the `codex` launcher an npm install leaves is `#!/usr/bin/env node`, and runs on any Node
 *    (measured 18.16 to 23.7 on 0.164). A child with no `node` on PATH dies with exit 127.
 *  - our bridge child loads the vendored T3 layer, which needs 22.16 (`node-floor.ts`).
 * The install dreamcontext manages needs neither: its launcher execs the native program.
 */
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { cliAwarePath } from './automations/cli-path.js';
import { claudeAwarePath } from './claude-path.js';
import { bridgeNode } from './t3-bridge/node-floor.js';
import { compareVersions } from './version-check.js';
import { findTool, pathWithDirs, type ToolSearch } from './tool-finder.js';

/** Oldest Codex the bridge was run against. An older one is offered the update. */
export { compareVersions };
export const CODEX_MIN_VERSION = '0.164.0';

const BIN_NAMES = process.platform === 'win32' ? ['codex.cmd', 'codex.exe'] : ['codex'];

export const managedCodexRoot = (home: string = homedir()): string => join(home, '.dreamcontext', 'tools', 'codex');
export const managedCodexBinDir = (home: string = homedir()): string => join(managedCodexRoot(home), 'bin');
export const managedCodexBin = (home: string = homedir()): string => join(managedCodexBinDir(home), 'codex');

export function findCodexBin(o: ToolSearch = {}): string | null {
  return findTool(BIN_NAMES, { ...o, first: [managedCodexBinDir(o.home ?? homedir())] });
}

/** What a spawn runs: the found Codex. Not found keeps the bare name, so the failure is ENOENT. */
export function codexCommand(o: ToolSearch = {}): string {
  return findCodexBin(o) ?? (process.platform === 'win32' ? 'codex.cmd' : 'codex');
}

/**
 * PATH for anything that starts Codex: its own folder, then a Node (an npm launcher needs one by
 * name), both appended so a working lookup is never redirected.
 */
export function codexAwarePath(base: string = process.env.PATH ?? '', o: ToolSearch & { node?: string | null } = {}): string {
  const bin = findCodexBin(o);
  const node = o.node === undefined ? bridgeNode() : o.node;
  return pathWithDirs(base, [bin ? dirname(bin) : null, dirname(process.execPath), node ? dirname(node) : null]);
}

/**
 * The env of a child that runs Codex. The PATH also carries `claude` and our own CLI: Codex runs
 * `dreamcontext` hooks by name, and a hook that cannot start is a gate that silently is not there.
 */
export function codexChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, PATH: codexAwarePath(cliAwarePath(claudeAwarePath(env.PATH ?? ''))) };
}

export interface CodexHealth {
  readonly bin: string | null;
  /** `--version` answered, with the PATH a child gets here. */
  readonly runs: boolean;
  readonly version: string | null;
  /** The first line of why it did not start. */
  readonly error: string | null;
  /** The install under `~/.dreamcontext/tools/codex`. */
  readonly managed: boolean;
}

export type CodexRunner = (bin: string, env: NodeJS.ProcessEnv) => { status: number | null; stdout: string; stderr: string; error?: string };

const runVersion: CodexRunner = (bin, env) => {
  const r = spawnSync(bin, ['--version'], { env, encoding: 'utf-8', timeout: 8_000, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', ...(r.error ? { error: r.error.message } : {}) };
};

const healthMemo = new Map<string, CodexHealth>();

export function forgetCodexHealth(): void {
  healthMemo.clear();
}

const stamp = (bin: string): string => {
  try { const s = statSync(bin); return `${bin}\0${s.mtimeMs}\0${s.ino}`; } catch { return ''; }
};

/**
 * Ask Codex itself, in the environment a child really gets: a file on disk says nothing about
 * whether `env node` resolves. Remembered per file, so a 30 s poll starts no process.
 */
export function codexHealth(o: ToolSearch & { run?: CodexRunner; node?: string | null } = {}): CodexHealth {
  const home = o.home ?? homedir();
  const bin = findCodexBin(o);
  const managed = !!bin && dirname(bin) === managedCodexBinDir(home);
  if (!bin) return { bin: null, runs: false, version: null, error: null, managed: false };
  const base = o.path ?? (o.env ?? process.env).PATH ?? '';
  const key = `${stamp(bin)}\0${base}`;
  const memo = o.run ? undefined : healthMemo.get(key);
  if (memo) return memo;
  const env = { ...(o.env ?? process.env), PATH: codexAwarePath(base, o) };
  const r = (o.run ?? runVersion)(bin, env);
  const out = `${r.stdout}\n${r.stderr}`;
  const version = /(\d+\.\d+\.\d+)/.exec(r.stdout)?.[1] ?? null;
  const runs = r.status === 0 && version !== null;
  const error = runs ? null : (r.error ?? out.trim().split('\n')[0] ?? '').slice(0, 200) || `exit ${r.status}`;
  const health = { bin, runs, version, error, managed };
  if (!o.run) healthMemo.set(key, health);
  return health;
}

/** One line for a pane that cannot start Codex, or null when it can. */
export function codexStartProblem(o: ToolSearch = {}): string | null {
  const h = codexHealth(o);
  if (!h.bin) return 'Codex is not installed. Open the model menu and press Install, or run dreamcontext setup.';
  return h.runs ? null : `Codex is installed but does not start (${h.error}). Open the model menu and press Update.`;
}

/** The version the managed launcher points at, without starting it. Null when there is none. */
export function managedCodexVersion(home: string = homedir()): string | null {
  try {
    if (!lstatSync(managedCodexBin(home)).isFile()) return null;
    return /^# dreamcontext codex (\d+\.\d+\.\d+)$/m.exec(readFileSync(managedCodexBin(home), 'utf-8'))?.[1] ?? null;
  } catch {
    return null;
  }
}

