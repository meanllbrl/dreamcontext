import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

/**
 * `dreamcontext` on a headless run's PATH — the same CLI that started the run.
 *
 * WHY THIS EXISTS. Every run's preamble tells the agent to talk through the CLI
 * (`dreamcontext automations post …`, `propose`, recall). A run the SCHEDULER fires
 * inherits the login-shell PATH baked into the launchd wrapper, so that works. A run
 * started from the APP — an @mention, "run now" — inherits the desktop app's
 * environment instead, and a Finder-launched app has `/usr/bin:/bin` and little else.
 * Observed on a real ask: the agent tried `dreamcontext automations post`, got
 * "command not found", tried `npx -y dreamcontext`, got "npx not found", and said
 * so in its document. The thread stayed empty for every run started by hand.
 *
 * THE FIX IS A SHIM, NOT A GUESS. Which directory holds the user's `dreamcontext`
 * is exactly what the app cannot know without a login shell, and a guessed
 * directory can hold a DIFFERENT install. The running process knows the one answer
 * that is always right — `process.execPath` + its own entry script — so a two-line
 * script under `~/.dreamcontext/bin/cli/` execs precisely that, and its directory
 * goes on the run's PATH. Node's own directory is appended too, so `node`/`npx`
 * resolve for an agent that reaches for them.
 *
 * PREPENDED only when no `dreamcontext` is resolvable already: a PATH that finds one
 * keeps it (a developer's linked checkout must not be shadowed), and the shim only
 * ever rescues a lookup that would otherwise fail.
 */

/** The shim's directory — its own, so nothing else on PATH rides in with it. */
export function cliShimDir(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'bin', 'cli');
}

/** POSIX single-quote, so a path with spaces or quotes survives the shim verbatim. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function renderCliShim(execPath: string, entry: string): string {
  return `#!/bin/sh\n# Written by dreamcontext for headless runs. Rewritten when the CLI moves.\nexec ${shq(execPath)} ${shq(entry)} "$@"\n`;
}

function isExecutableFile(path: string): boolean {
  try {
    const st = statSync(path);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** Is `dreamcontext` resolvable on `entries`? */
function hasCli(entries: string[]): boolean {
  return entries.some((dir) => isExecutableFile(join(dir, 'dreamcontext')));
}

/**
 * `base` PATH, made to resolve `dreamcontext` and `node`. Never throws — a shim that
 * cannot be written degrades to the PATH as it was, which is the old behaviour.
 */
export function cliAwarePath(
  base: string = process.env.PATH ?? '',
  opts: { execPath?: string; entry?: string | undefined; home?: string } = {},
): string {
  const execPath = opts.execPath ?? process.execPath;
  const entry = 'entry' in opts ? opts.entry : process.argv[1];
  let entries = base.split(delimiter).filter(Boolean);

  const nodeDir = dirname(execPath);
  if (!entries.includes(nodeDir)) entries = [...entries, nodeDir];

  if (!hasCli(entries) && entry && process.platform !== 'win32') {
    try {
      const dir = cliShimDir(opts.home);
      const shim = join(dir, 'dreamcontext');
      const body = renderCliShim(execPath, entry);
      mkdirSync(dir, { recursive: true });
      const current = existsSync(shim) ? readFileSync(shim, 'utf-8') : null;
      if (current !== body) writeFileSync(shim, body, 'utf-8');
      chmodSync(shim, 0o755);
      entries = [dir, ...entries.filter((d) => d !== dir)];
    } catch {
      // Unwritable home: the run keeps the PATH it would have had.
    }
  }
  return entries.join(delimiter);
}
