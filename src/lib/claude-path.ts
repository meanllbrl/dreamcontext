import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';

/**
 * Finding `claude` when the shell can't — and the one-line rc export that fixes
 * it for good.
 *
 * Claude Code does NOT live in npm's global bin any more: both `npm install -g
 * @anthropic-ai/claude-code` and the official `install.sh` land the real binary
 * in `~/.local/bin`, a directory that is not on a default macOS/Linux PATH. The
 * documented last step of an install is the echo:
 *
 *     echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
 *
 * Skip it and `claude` exists on disk while every `$SHELL -ilc 'exec claude …'`
 * spawn we make (capabilities probe, embedded terminal, chat, sleepy capture,
 * tab titling) reports "command not found" — the whole agent surface stays
 * greyed out behind a CLI that IS installed. That is precisely what the in-app
 * installer used to leave behind: it ran the npm install and stopped.
 *
 * Two halves live here, and both are needed:
 *  • `findClaudeBin()` / `claudeAwarePath()` — resolve the binary from the known
 *    install locations so our own spawns work IMMEDIATELY, with no rc edit and
 *    no shell restart.
 *  • `ensureClaudeOnShellPath()` — perform the missing echo, idempotently and in
 *    a marked block, so the user's OWN terminals (and the "Open in Terminal"
 *    hand-off, which we don't control the env of) find it too.
 */

/** Executable names to look for, per platform. */
const BIN_NAMES = process.platform === 'win32' ? ['claude.cmd', 'claude.exe'] : ['claude'];

/** Comment header written above the export so the block is recognisable + greppable. */
export const RC_MARKER = '# dreamcontext: Claude Code CLI on PATH';

/**
 * Directories Claude Code is known to install into, most-likely first. These are
 * probed only as a FALLBACK — a `claude` already resolvable on the user's PATH
 * always wins, so a hand-rolled/dev build is never shadowed by one of these.
 */
export function claudeBinDirs(): string[] {
  const home = homedir();
  const dirs = [
    join(home, '.local', 'bin'),    // native installer + where the npm package migrates to
    join(home, '.claude', 'local'), // legacy `claude migrate-installer` target
    join(home, '.bun', 'bin'),
    dirname(process.execPath),      // npm global bin, when we run on the user's own node
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  return [...new Set(dirs)].filter((d) => d && d !== '/' && d !== '.');
}

/**
 * Absolute path to an installed `claude`, found by scanning the known install
 * locations — or null. Deliberately uncached: an install can land at any moment
 * (the in-app installer, the CLI's own auto-updater), and a handful of
 * `existsSync` calls is far cheaper than the login-shell spawn it rescues.
 */
export function findClaudeBin(): string | null {
  for (const dir of claudeBinDirs()) {
    for (const name of BIN_NAMES) {
      const bin = join(dir, name);
      if (existsSync(bin)) return bin;
    }
  }
  return null;
}

/**
 * `base` PATH with the directory of a discovered `claude` APPENDED when it isn't
 * already there. Appended, never prepended: an existing `claude` earlier on PATH
 * keeps winning, so this can only ever rescue a missing lookup, never redirect a
 * working one. Pass this as the spawned process's PATH and `exec claude` resolves
 * even when the user's rc never got the export.
 */
export function claudeAwarePath(base: string = process.env.PATH ?? ''): string {
  const bin = findClaudeBin();
  if (!bin) return base;
  const dir = dirname(bin);
  const entries = base.split(delimiter).filter(Boolean);
  if (entries.includes(dir)) return base;
  return [...entries, dir].join(delimiter);
}

/** Result of attempting the echo. `wrote` empty + `alreadyConfigured` empty means it failed. */
export interface ShellRcFix {
  /** Directory that was put on PATH. */
  dir: string;
  /** The exact line written — also what the user should add by hand if we couldn't. */
  line: string;
  /** Rc files actually appended to. */
  wrote: string[];
  /** Rc files that already referenced `dir` (nothing to do). */
  alreadyConfigured: string[];
}

/**
 * Which rc file(s) a login shell of `shell` actually reads. We spawn with `-ilc`
 * (interactive login), so the interactive rc is what matters for US; the login
 * profile is extended too where it exists so the user's own terminal agrees.
 */
function rcTargets(shell: string): string[] {
  const home = homedir();
  const name = basename(shell || '');
  if (name === 'fish') return [join(home, '.config', 'fish', 'config.fish')];
  if (name === 'bash') {
    const files = [join(home, '.bashrc')];
    // A macOS login bash reads ~/.bash_profile and frequently does NOT source
    // ~/.bashrc. Extend it too — but only if it already exists: creating one
    // would silently shadow an existing ~/.bash_login / ~/.profile.
    const profile = join(home, '.bash_profile');
    if (existsSync(profile)) files.push(profile);
    return files;
  }
  // zsh is also the empty-$SHELL default, matching every spawn site's `|| '/bin/zsh'`.
  if (name === 'zsh' || !name) return [join(home, '.zshrc')];
  return [join(home, '.profile')]; // sh/dash/ksh/unknown — the POSIX fallback
}

/** `$HOME`-relative form of `dir`, or null when it lives outside the home directory. */
function homeRelative(dir: string): string | null {
  const home = homedir();
  return dir.startsWith(`${home}/`) ? `$HOME/${dir.slice(home.length + 1)}` : null;
}

/** The export statement, in the syntax of `shell`. */
export function claudePathExportLine(dir: string, shell: string = process.env.SHELL || '/bin/zsh'): string {
  const ref = homeRelative(dir) ?? dir;
  return basename(shell) === 'fish'
    ? `set -gx PATH "${ref}" $PATH`
    : `export PATH="${ref}:$PATH"`;
}

/**
 * The missing echo: append `export PATH="<dir>:$PATH"` to the user's shell rc so
 * `claude` is found in every future shell, theirs included.
 *
 * Idempotent — if the rc already mentions `dir` (literally or as `$HOME/…`) it is
 * left completely alone, so repeated installs never stack duplicate PATH entries.
 * Non-throwing: an unwritable rc (read-only home, odd permissions) just comes back
 * as "not written" and the caller shows the manual command instead.
 */
export function ensureClaudeOnShellPath(
  dir: string,
  shell: string = process.env.SHELL || '/bin/zsh',
): ShellRcFix {
  const line = claudePathExportLine(dir, shell);
  const homeRef = homeRelative(dir);
  const fix: ShellRcFix = { dir, line, wrote: [], alreadyConfigured: [] };

  for (const file of rcTargets(shell)) {
    try {
      const existing = existsSync(file) ? readFileSync(file, 'utf-8') : '';
      if (existing.includes(dir) || (homeRef && existing.includes(homeRef))) {
        fix.alreadyConfigured.push(file);
        continue;
      }
      mkdirSync(dirname(file), { recursive: true }); // fish's ~/.config/fish may not exist yet
      const gap = existing && !existing.endsWith('\n') ? '\n' : '';
      appendFileSync(file, `${gap}\n${RC_MARKER}\n${line}\n`, 'utf-8');
      fix.wrote.push(file);
    } catch {
      /* unwritable — reported by absence from both lists; caller falls back to the manual hint */
    }
  }
  return fix;
}
