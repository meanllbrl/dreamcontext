/**
 * The machine-readiness model: the one source of truth for "what is missing on this
 * machine, and how is it fixed". The dashboard server, `dreamcontext setup` and
 * `dreamcontext doctor --machine` all read it; the dashboard mirrors these ids.
 *
 * Every check is reported in {@link CHECK_IDS} order, which is also a dependency
 * order: a check only ever depends on checks listed before it.
 */

export const CHECK_IDS = ['network', 'node', 'npm', 'cli', 'claude', 'claude-auth', 'git', 'github', 'gh', 'terminal'] as const;
export type CheckId = typeof CHECK_IDS[number];

export const FIX_IDS = [
  'node-shell-path', 'cli-install', 'cli-shell-path', 'claude-install', 'claude-path', 'claude-signin',
  'git-install', 'gh-install', 'github-signin', 'gh-signin', 'pty-install',
] as const;
export type FixId = typeof FIX_IDS[number];

export type CheckTier = 'required' | 'recommended' | 'optional';
export type CheckScope = 'machine' | 'agent';
export type CheckStatus = 'ok' | 'missing' | 'needs-action' | 'blocked' | 'unknown' | 'unsupported';
export type ReasonCode =
  | 'not-installed' | 'too-old' | 'not-on-path' | 'signed-out' | 'unverifiable' | 'offline' | 'needs-dialog'
  | 'no-npm' | 'desktop-only' | 'platform' | 'symlink' | 'unsafe-path';
export type FixKind = 'auto' | 'browser' | 'device-code' | 'system-dialog' | 'manual';
export type Surface = 'desktop' | 'browser' | 'cli';

/** One finished child process. `ensure-cli.ts` re-exports this. */
export interface ShellResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code?: number | null;
}

export interface FixPlan {
  id: FixId;
  kind: FixKind;
  /** Can THIS surface run it? False on the browser surface and for manual fixes. */
  runnable: boolean;
  /** The command a person can run instead, when there is one. */
  manual?: string;
  /** The fix appends a line to the user's shell startup file. */
  editsShellProfile: boolean;
}

export interface ReadinessCheck {
  id: CheckId;
  tier: CheckTier;
  scopes: CheckScope[];
  status: CheckStatus;
  reason?: ReasonCode;
  dependsOn: CheckId[];
  blockedBy?: CheckId[];
  version?: string;
  /** Email or login of a signed-in account. Never a token. */
  account?: string;
  fix: FixPlan | null;
}

export interface ReadinessReport {
  version: 1;
  platform: NodeJS.Platform;
  arch: string;
  surface: Surface;
  generatedAt: number;
  /** Every required check is `ok` or `unknown`. */
  ready: boolean;
  online: boolean;
  /** Fixes to run, in order (see `planFixes`). */
  plan: FixId[];
  /** The first check that needs the person rather than an automatic fix. */
  next: CheckId | null;
  activeFixes: FixId[];
  checks: ReadinessCheck[];
}

/** What a fresh login shell (a new Terminal window) resolves. Absent = not found. */
export interface ShellFacts {
  shell: string;
  node?: string;
  nodeVersion?: string;
  npm?: string;
  dreamcontext?: string;
  claude?: string;
  gh?: string;
  /** Set only when `git --version` actually ran (never the macOS stub without the developer tools). */
  git?: string;
  cltInstalled?: boolean;
  brew?: string;
}

/** Everything else the checks need, gathered by `probeReadiness` outside the login shell. */
export interface ExtraFacts {
  online: boolean;
  /** `process.versions.node` of the running process (the server or the CLI). */
  runningNodeVersion: string;
  /** An `npm` sits next to the running node. */
  npmBesideExec: boolean;
  /** `findClaudeBin()`: a `claude` in a known install folder, whether or not the shell sees it. */
  claudeBin: string | null;
  /** A `dreamcontext` installed in a known global folder the shell does not resolve. */
  cliBinOffPath: string | null;
  /** `null` = not probed (no Claude here yet): the sign-in reads as still to do. */
  claudeAuth: { loggedIn: boolean | null; email?: string } | null;
  /** `null` = could not tell (gh missing, or offline). */
  ghAuthed: boolean | null;
  github: { connected: boolean; needsReconnect: boolean; login: string | null };
  /** `null` = not probed (not the desktop surface). */
  ptyPresent: boolean | null;
}

export interface ProbeRunner {
  /** `$SHELL -ilc` with PATH reset to the Finder PATH: what a new Terminal window sees. */
  loginShell(script: string, timeoutMs: number): Promise<ShellResult>;
  exec(
    file: string,
    args: string[],
    o: { timeoutMs: number; env?: NodeJS.ProcessEnv; input?: string; cwd?: string },
  ): Promise<ShellResult>;
  /** Any HTTP answer within the timeout counts as online. */
  fetchOk(url: string, timeoutMs: number): Promise<boolean>;
}

export interface ProbeContext {
  surface: Surface;
  platform: NodeJS.Platform;
  arch: string;
  home: string;
  execPath: string;
  runner: ProbeRunner;
  probeUrl: string;
  /** Injected by the server on the desktop surface only. */
  ptyPresent?: () => boolean;
}

export interface FolderState {
  path: string;
  name: string;
  exists: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
  empty: boolean;
  writable: boolean;
  brain: 'missing' | 'sparse' | 'healthy';
  isGitRepo: boolean;
  docs: { count: number; folders: string[] };
  stack: string | null;
}

export const CHECK_TIERS: Readonly<Record<CheckId, CheckTier>> = {
  network: 'required',
  node: 'required',
  npm: 'required',
  cli: 'required',
  claude: 'required',
  'claude-auth': 'required',
  git: 'recommended',
  github: 'recommended',
  gh: 'recommended',
  terminal: 'optional',
};

export const CHECK_DEPS: Readonly<Record<CheckId, readonly CheckId[]>> = {
  network: [],
  node: [],
  npm: ['node'],
  cli: ['npm', 'network'],
  claude: ['network'],
  'claude-auth': ['claude', 'network'],
  git: ['network'],
  github: ['network'],
  gh: ['network'],
  terminal: ['npm', 'network'],
};

export const CHECK_SCOPES: Readonly<Record<CheckId, readonly CheckScope[]>> = {
  network: ['machine', 'agent'],
  node: ['machine'],
  npm: ['machine'],
  cli: ['machine'],
  claude: ['machine', 'agent'],
  'claude-auth': ['machine', 'agent'],
  git: ['machine'],
  github: ['machine'],
  gh: ['machine'],
  terminal: ['agent'],
};

/** The oldest Node.js dreamcontext runs on (package.json `engines`). */
export const MIN_NODE_MAJOR = 18;
