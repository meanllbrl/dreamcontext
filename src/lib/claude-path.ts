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

/** Comment header above the managed Node folders' PATH line (the desktop app / install.sh layout). */
export const NODE_RC_MARKER = '# dreamcontext: Node.js on PATH';
/** Comment header above the global dreamcontext CLI folder's PATH line. */
export const CLI_RC_MARKER = '# dreamcontext: dreamcontext CLI on PATH';

/**
 * Characters that may never reach a shell startup file. The line is written as
 * `export PATH="<dir>:$PATH"`, so anything that is live inside double quotes
 * (`"`, `$`, backtick, backslash) or that ends the line (CR, LF, NUL) would let
 * a folder name run code in every future shell. Such a folder is refused, never
 * escaped: the caller falls back to the manual step.
 */
const UNSAFE_RC_CHARS = /["$`\\\n\r\0]/;

/** Result of {@link ensureDirOnShellPath}: `refused` set means nothing was written. */
export type ShellPathFix = ShellRcFix & { refused?: 'unsafe-chars' };

/**
 * Append `export PATH="<dir>:$PATH"` (fish: `set -gx PATH "<dir>" $PATH`) under
 * `marker` to the user's shell rc, so `dir` is on PATH in every future shell.
 *
 * - NFC-normalised first, so a Turkish folder name (`Öğretmen`) is written in
 *   one canonical byte form whatever form the caller got it in.
 * - Refuses a folder containing a character from {@link UNSAFE_RC_CHARS}.
 * - Idempotent: an rc that already mentions `dir` (literally or as `$HOME/…`) is
 *   left completely alone, so repeated installs never stack duplicate entries.
 * - Non-throwing: an unwritable rc comes back absent from both lists and the
 *   caller shows the manual command instead.
 */
export function ensureDirOnShellPath(
  dirIn: string,
  marker: string,
  shell: string = process.env.SHELL || '/bin/zsh',
): ShellPathFix {
  const dir = dirIn.normalize('NFC');
  if (UNSAFE_RC_CHARS.test(dir) || UNSAFE_RC_CHARS.test(marker)) {
    return { dir, line: '', wrote: [], alreadyConfigured: [], refused: 'unsafe-chars' };
  }
  const line = claudePathExportLine(dir, shell);
  const homeRef = homeRelative(dir);
  const fix: ShellPathFix = { dir, line, wrote: [], alreadyConfigured: [] };

  for (const file of rcTargets(shell)) {
    try {
      const existing = existsSync(file) ? readFileSync(file, 'utf-8') : '';
      const normalized = existing.normalize('NFC');
      if (normalized.includes(dir) || (homeRef && normalized.includes(homeRef))) {
        fix.alreadyConfigured.push(file);
        continue;
      }
      mkdirSync(dirname(file), { recursive: true }); // fish's ~/.config/fish may not exist yet
      const gap = existing && !existing.endsWith('\n') ? '\n' : '';
      appendFileSync(file, `${gap}\n${marker}\n${line}\n`, 'utf-8');
      fix.wrote.push(file);
    } catch {
      /* unwritable — reported by absence from both lists; caller falls back to the manual hint */
    }
  }
  return fix;
}

/**
 * The missing echo for Claude Code: put `dir` (where `claude` lives) on the
 * user's shell PATH. A thin wrapper over {@link ensureDirOnShellPath} under the
 * Claude marker, kept for its existing callers.
 */
export function ensureClaudeOnShellPath(
  dir: string,
  shell: string = process.env.SHELL || '/bin/zsh',
): ShellPathFix {
  return ensureDirOnShellPath(dir, RC_MARKER, shell);
}

/**
 * Finish a Claude Code install properly: find the binary in the known install
 * locations and put its folder on the user's shell PATH. Idempotent and
 * non-throwing; the message is what the caller shows the user.
 */
export function fixClaudeShellPath(): { ok: boolean; message: string } {
  const bin = findClaudeBin();
  if (!bin) {
    // Installed somewhere we don't know about, or not installed at all. Either way
    // there is no directory to add — say so rather than editing rc files blindly.
    return {
      ok: false,
      message:
        "Couldn't find the claude binary in the usual install locations, so PATH was left alone. " +
        'Add its directory to your shell profile by hand, then reopen the app.',
    };
  }
  const dir = dirname(bin);
  const fix = ensureClaudeOnShellPath(dir);
  if (fix.wrote.length) {
    return { ok: true, message: `Added ${dir} to your PATH in ${fix.wrote.join(', ')} — open a new terminal to pick it up.` };
  }
  if (fix.alreadyConfigured.length) {
    return { ok: true, message: `${dir} is already on your PATH in ${fix.alreadyConfigured.join(', ')}.` };
  }
  return {
    ok: false,
    message: `Couldn't write your shell profile. Run this once, in your terminal:\n  echo '${claudePathExportLine(dir)}' >> ~/.zshrc`,
  };
}
