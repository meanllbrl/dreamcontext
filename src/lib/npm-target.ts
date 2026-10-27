import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

/**
 * WHICH global install an upgrade writes to.
 *
 * `npm install -g` lands in whatever prefix the first `npm` on PATH has. On a machine with both
 * nvm and Homebrew (or the desktop app's private Node), that is not necessarily the install the
 * running `dreamcontext` came from: the upgrade "succeeds" into the other prefix and the CLI the
 * app runs never moves. So the prefix is read off the running CLI itself —
 * `<prefix>/lib/node_modules/dreamcontext/dist/index.js` — and the install is pinned to it with
 * `--prefix`, using the npm that lives in that prefix when there is one.
 *
 * Anything else (an npx cache, a repo checkout, the app's bundled copy, Windows) resolves to
 * null and the caller keeps the plain `npm install -g` it always ran.
 */
export interface NpmTarget {
  /** The npm prefix the running CLI was installed into. */
  prefix: string;
  /** The npm to run: the prefix's own, the one beside node, or plain `npm` from PATH. */
  npm: string;
  /** `npm` is npm's JS entry (npm-cli.js), run with node rather than through its shebang. */
  npmViaNode: boolean;
  /** The CLI's real `dist/index.js`. After the install the SAME path holds the new version. */
  entry: string;
}

export interface NpmTargetDeps {
  realpath?: (p: string) => string;
  exists?: (p: string) => boolean;
  platform?: NodeJS.Platform;
  execPath?: string;
}

const GLOBAL_ENTRY_RE = /^(.+)\/lib\/node_modules\/dreamcontext\/dist\/index\.js$/;

function safeRealpath(realpath: (p: string) => string, p: string): string {
  try {
    return realpath(p);
  } catch {
    return p;
  }
}

/** The npm install a CLI entry (a bin symlink or `dist/index.js`) belongs to, or null. */
export function resolveNpmTarget(entry: string | undefined, deps: NpmTargetDeps = {}): NpmTarget | null {
  if (!entry) return null;
  const platform = deps.platform ?? process.platform;
  if (platform === 'win32') return null;
  const realpath = deps.realpath ?? realpathSync;
  const exists = deps.exists ?? existsSync;
  const real = safeRealpath(realpath, entry);
  const m = real.match(GLOBAL_ENTRY_RE);
  if (!m) return null;
  const prefix = m[1];
  // npx unpacks into <cache>/_npx/<hash>/node_modules — a cache, not an install.
  if (prefix.includes('/_npx/') || prefix.includes('/.npm/')) return null;
  const execPath = deps.execPath ?? process.execPath;
  const candidates = [join(prefix, 'bin', 'npm'), join(dirname(execPath), 'npm')];
  const found = candidates.find((c) => exists(c));
  const npm = found ? safeRealpath(realpath, found) : 'npm';
  return { prefix, npm, npmViaNode: npm.endsWith('.js'), entry: real };
}

/**
 * The CLI install the desktop self-update targets: the global CLI the shell found
 * (`DREAMCONTEXT_GLOBAL_CLI`, set even while the bundled copy runs), else the running CLI.
 */
export function targetCliEntry(env: NodeJS.ProcessEnv = process.env, argv1: string | undefined = process.argv[1]): string | undefined {
  return env.DREAMCONTEXT_GLOBAL_CLI || argv1;
}

/** `npm <args>` pinned to the target prefix, or plain `npm <args>` without one. */
export function npmInstallCommand(
  args: string[],
  target: NpmTarget | null,
  execPath: string = process.execPath,
): { file: string; args: string[] } {
  if (!target) return { file: 'npm', args };
  const pinned = [...args, '--prefix', target.prefix];
  return target.npmViaNode ? { file: execPath, args: [target.npm, ...pinned] } : { file: target.npm, args: pinned };
}

/**
 * Run a subcommand with the freshly installed CLI itself (`node <entry> …`), not `npx
 * dreamcontext`: inside a project npx prefers a local install, and from a Finder-started app it
 * may not find the global one at all. Null without a target.
 */
export function upgradedCliCommand(
  subArgs: string[],
  target: NpmTarget | null,
  execPath: string = process.execPath,
): { file: string; args: string[] } | null {
  return target ? { file: execPath, args: [target.entry, ...subArgs] } : null;
}

/** PATH with node's own folder first, so npm's scripts find the same node. */
export function pathWithNode(env: NodeJS.ProcessEnv = process.env, execPath: string = process.execPath): string {
  const dir = dirname(execPath);
  const rest = (env.PATH ?? '').split(delimiter).filter((p) => p && p !== dir);
  return [dir, ...rest].join(delimiter);
}

/** The version of the dreamcontext package a CLI entry belongs to, or null (the bundled copy has
 *  no package.json; its version is the build stamp). */
export function cliPackageVersion(entry: string | undefined, deps: Pick<NpmTargetDeps, 'realpath'> = {}): string | null {
  if (!entry) return null;
  let dir = dirname(safeRealpath(deps.realpath ?? realpathSync, entry));
  for (let i = 0; i < 4; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as { name?: unknown; version?: unknown };
      if (pkg.name === 'dreamcontext' && typeof pkg.version === 'string') return pkg.version;
    } catch { /* none here; keep walking */ }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
