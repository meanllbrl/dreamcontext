/**
 * Which Node runs a bridge child (plan r5 §2.6): the vendored T3 layer needs 22.16+, and the
 * machine's default Node may be older. Nothing here changes that default: when the server itself
 * runs on an older Node, the bridge child alone starts on a good one found beside it. No good
 * Node anywhere is a readable state (`/api/agent/tools`, the composer's Codex row), never a crash
 * inside a chat.
 *
 * Mirrors the desktop shell's search (`desktop/src-tauri/src/node_runtime.rs`).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const BRIDGE_MIN_NODE = [22, 16, 0] as const;
export const BRIDGE_MIN_NODE_TEXT = '22.16';

export type NodeVersion = readonly [number, number, number];

export function parseNodeVersion(s: string): NodeVersion | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(s.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compare(a: NodeVersion, b: NodeVersion): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

export const meetsBridgeFloor = (v: NodeVersion): boolean => compare(v, BRIDGE_MIN_NODE) >= 0;

/** Good Nodes in the version managers' folders, newest first. The folder name is the version. */
export function versionManagerNodes(home: string, nvmDir?: string): string[] {
  const roots: Array<[string, string[]]> = [
    [join(nvmDir || join(home, '.nvm'), 'versions', 'node'), ['bin', 'node']],
    [join(home, '.local', 'share', 'fnm', 'node-versions'), ['installation', 'bin', 'node']],
    [join(home, 'Library', 'Application Support', 'fnm', 'node-versions'), ['installation', 'bin', 'node']],
    [join(home, '.fnm', 'node-versions'), ['installation', 'bin', 'node']],
    [join(home, '.asdf', 'installs', 'nodejs'), ['bin', 'node']],
    [join(home, '.local', 'share', 'mise', 'installs', 'node'), ['bin', 'node']],
  ];
  const found: Array<{ version: NodeVersion; path: string }> = [];
  for (const [root, tail] of roots) {
    let names: string[] = [];
    try { names = readdirSync(root); } catch { continue; }
    for (const name of names) {
      const version = parseNodeVersion(name);
      if (version && meetsBridgeFloor(version)) found.push({ version, path: join(root, name, ...tail) });
    }
  }
  return found.sort((a, b) => compare(b.version, a.version)).map((f) => f.path);
}

export interface NodeSearch {
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** The running Node (default: this process). */
  readonly execPath?: string;
  readonly version?: string;
  /** Answers `<node> --version`; default starts it, bounded. */
  readonly probe?: (path: string) => string | null;
}

function probeVersion(path: string): string | null {
  try {
    return execFileSync(path, ['--version'], { encoding: 'utf-8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

/** A Node at the floor for a bridge child, or null. The running Node wins: no second search. */
export function findBridgeNode(o: NodeSearch = {}): string | null {
  const execPath = o.execPath ?? process.execPath;
  const running = parseNodeVersion(o.version ?? process.version);
  if (running && meetsBridgeFloor(running)) return execPath;
  const home = o.home ?? homedir();
  const env = o.env ?? process.env;
  const candidates = [
    env.DREAMCONTEXT_NODE ?? '',
    join(home, '.dreamcontext', 'node', 'current', 'bin', 'node'),
    ...versionManagerNodes(home, env.NVM_DIR),
    join(home, '.volta', 'bin', 'node'),
    '/opt/homebrew/opt/node@24/bin/node',
    '/opt/homebrew/opt/node@22/bin/node',
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
  ];
  const probe = o.probe ?? probeVersion;
  for (const path of candidates) {
    if (!path || !existsSync(path)) continue;
    const version = parseNodeVersion(probe(path) ?? '');
    if (version && meetsBridgeFloor(version)) return path;
  }
  return null;
}

let cached: { at: number; value: string | null } | null = null;
const CACHE_MS = 60_000;

/** {@link findBridgeNode} for the hot paths (a poll, every spawn): at most one search a minute. */
export function bridgeNode(now: number = Date.now()): string | null {
  if (!cached || now - cached.at > CACHE_MS) cached = { at: now, value: findBridgeNode() };
  return cached.value;
}

export function resetBridgeNodeCache(): void {
  cached = null;
}

/** What a pane says when no Node at the floor exists. */
export const nodeTooOldMessage = (tool: string): string =>
  `${tool} needs Node ${BRIDGE_MIN_NODE_TEXT} or newer here and none was found on this machine. ` +
  'Your default Node stays as it is: install a newer version beside it (for example with nvm), then open a new chat.';
