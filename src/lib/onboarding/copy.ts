import type { CheckId, FixId, ReasonCode } from './types.js';

/**
 * The plain-language copy of the readiness model. The CLI prints it directly; the
 * dashboard carries the same English strings as i18n keys (a mirror test keeps the two
 * equal).
 *
 * Rules for every string here: no em dashes, the agent is "Claude", and titles and
 * why-lines never name a tool or mechanism (npm, PATH, node-pty, xcode, brew, shell).
 */

export interface CheckCopy {
  title: string;
  why: string;
}

export const CHECK_COPY: Readonly<Record<CheckId, CheckCopy>> = {
  network: { title: 'Internet connection', why: 'Needed to download what is missing and to sign in.' },
  node: { title: 'Node.js', why: 'Runs dreamcontext on this Mac.' },
  npm: { title: 'Node package manager', why: 'Installs the pieces dreamcontext needs.' },
  cli: { title: 'dreamcontext in Terminal', why: 'Lets Claude save what it learns in every project.' },
  claude: { title: 'Claude', why: 'The agent that works in your project.' },
  'claude-auth': { title: 'Claude sign-in', why: 'Connects Claude to your account.' },
  git: { title: 'Git', why: "Keeps your project's history and syncs your brain." },
  github: { title: 'GitHub', why: 'Clone your repositories and sync with your team.' },
  gh: { title: 'GitHub tools for Claude', why: 'Lets Claude open pull requests for you.' },
  terminal: { title: 'Built-in terminal', why: 'Runs commands inside the app when Claude needs you.' },
};

export const REASON_COPY: Readonly<Record<ReasonCode, string>> = {
  'not-installed': 'Not installed yet.',
  'too-old': 'This version is too old.',
  'not-on-path': "Installed, but Terminal can't find it yet.",
  'signed-out': 'Not signed in.',
  unverifiable: "Couldn't check the sign-in. It may be fine.",
  offline: "You're offline. Connect to the internet and try again.",
  'needs-dialog': 'Needs a quick install from macOS.',
  'no-npm': 'The Node package manager is missing.',
  'desktop-only': 'Only available in the desktop app.',
  platform: 'Not available on this system yet.',
  symlink: 'That folder points somewhere else. Pick the real folder.',
  'unsafe-path': "That folder's name can't be added automatically.",
};

export interface FixCopy {
  action: string;
  working: string;
  done: string;
  /** Shown while the fix waits on the person (browser, code, macOS window). */
  waiting?: string;
  /** github-signin only: the action when an existing GitHub command line sign-in is reused. */
  actionFromGh?: string;
  /** Shown under the action when the GitHub command line tool is present. */
  scopesNote?: string;
}

const GITHUB_SCOPES_NOTE =
  'GitHub will ask to allow access to your repositories, read access to your organizations, and your gists.';

export const FIX_COPY: Readonly<Record<FixId, FixCopy>> = {
  'node-shell-path': { action: 'Make it available in Terminal', working: 'Updating your Terminal setup', done: 'Available in Terminal' },
  'cli-install': { action: 'Install', working: 'Installing dreamcontext', done: 'Installed' },
  'cli-shell-path': { action: 'Make it available in Terminal', working: 'Updating your Terminal setup', done: 'Available in Terminal' },
  'claude-install': { action: 'Install Claude', working: 'Installing Claude', done: 'Claude is installed' },
  'claude-path': { action: 'Make it available in Terminal', working: 'Updating your Terminal setup', done: 'Available in Terminal' },
  'claude-signin': {
    action: 'Sign in',
    working: 'Opening your browser',
    done: 'Signed in',
    waiting: 'Finish signing in in your browser.',
  },
  'git-install': {
    action: 'Install Git',
    working: 'Opening the macOS installer',
    done: 'Git is installed',
    waiting: 'Installing in the background',
  },
  'gh-install': { action: 'Install', working: 'Installing GitHub tools', done: 'Installed' },
  'github-signin': {
    action: 'Connect GitHub',
    working: 'Getting a sign-in code',
    done: 'Connected',
    waiting: 'Enter this code on GitHub to finish.',
    actionFromGh: "Use the account you're signed in to in GitHub's command line tool",
    scopesNote: GITHUB_SCOPES_NOTE,
  },
  'gh-signin': {
    action: 'Sign in GitHub tools',
    working: 'Getting a sign-in code',
    done: 'Signed in',
    waiting: 'Enter this code on GitHub to finish.',
    scopesNote: GITHUB_SCOPES_NOTE,
  },
  'pty-install': { action: 'Install', working: 'Installing the built-in terminal', done: 'Installed' },
};

/** Lines the CLI prints around the pending `git init` (see `awaitGitForInit`). */
export const CLI_COPY = {
  gitWaiting: 'Waiting for the macOS developer tools to finish (press Enter to skip)',
  gitLater: 'Git will be set up the next time you run dreamcontext setup or dreamcontext doctor --machine.',
} as const;

/**
 * The first message of the chat the hand-off starts. Plain language naming the skill,
 * so it routes the same in the chat view and the terminal view.
 */
export const INITIALIZER_KICKOFF_PROMPT =
  "Use the initializer skill to set up this project's brain from what is already here: the code and any " +
  'documents in this folder. If the folder is empty, ask me what the project is about first. Ask only ' +
  'what you cannot find out yourself, then recommend the skill packs that fit and install the ones I pick. ' +
  'No placeholders.';
