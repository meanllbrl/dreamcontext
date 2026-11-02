import { statSync } from 'node:fs';
import { win32 } from 'node:path';

/**
 * Starting a command on Windows that may be a batch launcher: `codex.cmd`, `npx.cmd`, `npm.cmd`
 * and every npm-installed tool. Node refuses to spawn a `.cmd`/`.bat` without a shell (EINVAL
 * since the April 2024 security releases) and never tries those names on a bare `npx`, so a plain
 * `spawn('npx', args)` fails (ENOENT, read as 127 or "did not start"). `shell: true` would join the
 * args unquoted. The ONE place this repo builds such a line: a batch file runs through
 * `cmd.exe /d /s /c "<line>"` with every part quoted and cmd's special characters escaped, the way
 * cross-spawn does; the launcher re-reads its args (`%*`), so they are escaped twice and no `&`,
 * `|`, `%VAR%` or quote in an argument reaches cmd as syntax. An `.exe`, and every other platform,
 * is spawned as written.
 */

/** cmd.exe's metacharacters: outside a quoted run each one is taken literally only behind a caret. */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** One argument for `cmd.exe /s /c "…"` that hands it on through a batch file's `%*` intact. */
export function escapeCmdShimArg(arg: string): string {
  // MSVCRT quoting first (backslashes before a quote double, the quote is escaped)...
  let a = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  a = `"${a}"`;
  // ...then cmd's own characters, twice: once for this cmd, once for the launcher's `%*`.
  return a.replace(CMD_META, '^$1').replace(CMD_META, '^$1');
}

/** cmd.exe by its full path: a bare `cmd.exe` would be looked up in the working folder first. */
export function comspecPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.ComSpec || env.COMSPEC || win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'cmd.exe');
}

export interface SpawnSpec {
  file: string;
  args: string[];
  /** Set when the line is already quoted for cmd.exe: Node must not quote it again. */
  windowsVerbatimArguments?: boolean;
}

/** What to hand `spawn` so `file args` really starts, here. `file` is a path already found. */
export function spawnSpec(file: string, args: readonly string[], platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): SpawnSpec {
  // Only a batch file found by its full path goes through cmd.exe: cmd looks for a relative name
  // in the working folder first, so a `codex.cmd` planted in a project would run instead. A
  // relative one is spawned as written, which Node refuses: nothing runs.
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(file) || !win32.isAbsolute(file)) return { file, args: [...args] };
  const line = [file.replace(CMD_META, '^$1'), ...args.map(escapeCmdShimArg)].join(' ');
  return { file: comspecPath(env), args: ['/d', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true };
}

/**
 * {@link spawnSpec} for a command that may be a bare name (`npx`): on Windows it is looked up on
 * PATH the way the shell would (`.exe`, `.cmd`, `.bat`) first. A name it cannot find is spawned as
 * written and fails as such.
 */
export function resolvedSpawnSpec(
  command: string,
  args: readonly string[],
  o: { platform?: NodeJS.Platform; path?: string; env?: NodeJS.ProcessEnv; isFile?: (p: string) => boolean } = {},
): SpawnSpec {
  const platform = o.platform ?? process.platform;
  if (platform !== 'win32') return { file: command, args: [...args] };
  const env = o.env ?? process.env;
  const named = /[\\/]/.test(command) || /\.[A-Za-z0-9]+$/.test(command);
  const resolved = named ? command : findOnWindowsPath(command, o.path ?? env.PATH ?? env.Path ?? '', o.isFile);
  return spawnSpec(resolved ?? command, args, 'win32', env);
}

/**
 * A bare name on a Windows PATH the way the shell finds it: `.exe`, then `.cmd`, then `.bat`.
 * Kept here, with no import of the git layer: this module is reached from test setup files, and
 * loading `git-sync/git.ts` that early would pin the real `child_process` under a test's mock.
 */
function findOnWindowsPath(
  cmd: string,
  pathValue: string,
  isFile: (p: string) => boolean = (p) => { try { return statSync(p).isFile(); } catch { return false; } },
): string | null {
  for (const raw of pathValue.split(win32.delimiter)) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1');
    // A relative entry (`.`, `bin`) would resolve against the working folder: never trusted.
    if (!dir || !win32.isAbsolute(dir)) continue;
    for (const name of [`${cmd}.exe`, `${cmd}.cmd`, `${cmd}.bat`]) {
      const candidate = win32.join(dir, name);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}
