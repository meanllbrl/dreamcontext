import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import type { FixId } from './types.js';

/** A Linux package manager we can name a command for. */
export type LinuxPackageManager = 'apt' | 'dnf' | 'pacman' | 'apk' | 'zypper';

const PM_BY_DISTRO: ReadonlyArray<[RegExp, LinuxPackageManager]> = [
  [/\b(debian|ubuntu)\b/, 'apt'],
  [/\b(fedora|rhel|centos)\b/, 'dnf'],
  [/\b(arch)\b/, 'pacman'],
  [/\b(alpine)\b/, 'apk'],
  [/\b(suse|opensuse)\b/, 'zypper'],
];

/**
 * Which package manager this Linux uses, from `/etc/os-release` (`ID` then `ID_LIKE`).
 * Null when it cannot tell; the caller then shows a generic line.
 */
export function detectLinuxPackageManager(
  readOsRelease: () => string = () => readFileSync('/etc/os-release', 'utf-8'),
): LinuxPackageManager | null {
  let text: string;
  try {
    text = readOsRelease();
  } catch {
    return null;
  }
  const field = (key: string): string => {
    const m = new RegExp(`^${key}=(.*)$`, 'm').exec(text);
    return m ? m[1].replace(/^["']|["']$/g, '').toLowerCase() : '';
  };
  for (const value of [field('ID'), field('ID_LIKE')]) {
    for (const [re, pm] of PM_BY_DISTRO) if (re.test(value)) return pm;
  }
  return null;
}

const GIT_BY_PM: Readonly<Record<LinuxPackageManager, string>> = {
  apt: 'sudo apt install git',
  dnf: 'sudo dnf install git',
  pacman: 'sudo pacman -S git',
  apk: 'sudo apk add git',
  zypper: 'sudo zypper install git',
};

const GH_BY_PM: Readonly<Record<LinuxPackageManager, string>> = {
  apt: 'sudo apt install gh',
  dnf: 'sudo dnf install gh',
  pacman: 'sudo pacman -S github-cli',
  apk: 'sudo apk add github-cli',
  zypper: 'sudo zypper install gh',
};

/**
 * The command a person can run themselves for `fix` on this platform, or undefined when
 * there is no sensible one-line command (the fix is in-app only, or needs a folder the
 * caller knows and this function does not).
 */
export function manualCommand(
  fix: FixId,
  platform: NodeJS.Platform,
  pm: LinuxPackageManager | null = null,
): string | undefined {
  switch (fix) {
    case 'git-install':
      if (platform === 'darwin') return 'xcode-select --install';
      if (platform === 'win32') return 'winget install Git.Git';
      return pm ? GIT_BY_PM[pm] : 'Install git with your package manager';
    case 'gh-install':
      if (platform === 'darwin') return 'brew install gh';
      if (platform === 'win32') return 'winget install GitHub.cli';
      return pm ? GH_BY_PM[pm] : 'See https://github.com/cli/cli#installation';
    case 'claude-install':
      return platform === 'win32'
        ? 'irm https://claude.ai/install.ps1 | iex'
        : 'curl -fsSL https://claude.ai/install.sh | bash';
    case 'cli-install':
      return 'npm install -g dreamcontext@latest';
    case 'claude-signin':
      return 'claude auth login';
    case 'gh-signin':
      return 'gh auth login';
    case 'pty-install':
      return 'npm install node-pty';
    default:
      return undefined;
  }
}

/** Where the desktop app and install.sh keep their private Node: `~/.dreamcontext/node`. */
export function managedNodeRoot(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'node');
}

/** The global npm prefix of the private Node: `~/.dreamcontext/npm-global`. */
export function managedNpmGlobal(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'npm-global');
}

/**
 * A node path that survives a version bump. Node reports its real path
 * (`~/.dreamcontext/node/24.9.0/bin/node`), and that version folder is pruned when the
 * pin moves on; anything written to disk (a CLI shim, a PATH line) must name the
 * `current` link instead. Paths outside the managed root are returned unchanged.
 */
export function stableNodeExecPath(execPath: string, home: string = homedir()): string {
  const root = managedNodeRoot(home);
  if (!execPath.startsWith(root + sep)) return execPath;
  return join(root, 'current', 'bin', 'node');
}
