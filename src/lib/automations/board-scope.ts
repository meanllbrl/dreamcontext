import { lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { checkApproval } from './registry.js';
import { outputRootDir } from './store.js';
import { resolveWhiteboardPath } from '../whiteboards/store.js';
import {
  AGENT_BOARD_ENV,
  AGENT_SCRATCH_ENV,
  AGENT_SELF_ENV,
  type AutomationManifest,
} from './types.js';

/**
 * The permission envelope of a HOME-BOARD agent: one whose manifest names a `whiteboard`.
 *
 * Every other agent runs under `bypassPermissions`. A home-board agent instead runs under
 * Claude Code's own rules (`dontAsk`, `--setting-sources project`, an exact allowlist), so
 * anything not listed is denied rather than asked about. It may read anything, act on its own
 * board through the `dreamcontext` CLI, post and learn as itself, and write files only into
 * its own output folder and a scratch folder made fresh for each spawn.
 *
 * Every spawn path (run, account-switch continue, message resume, answer resume) goes
 * through the same three steps, and any refusal means NO spawn, with the reason named:
 *
 *   1. {@link resolveSpawnScope} — approval, then which board, from the manifest and the
 *      approval entry a human here wrote (never from the caller).
 *   2. {@link prepareScopePaths} — the two writable folders, with no symlink anywhere in
 *      them and no character that could break how a permission rule is parsed.
 *   3. {@link boardScopeArgs} / {@link scopeEnv} — the argv and env, pure.
 *
 * The CLI holds a second layer (the `whiteboard` and `automations post|learn|propose` verbs
 * refuse another board or slug while the env vars are set), so a rule that matched more than
 * it should still lands on a refusal.
 */

export interface BoardScope {
  /** The home board's slug. */
  board: string;
  /** The agent's own automation slug. */
  self: string;
}

export interface ScopePaths {
  /** Real path of `<vault>/automations/output/<self>`. */
  outputSelf: string;
  /** Real path of this spawn's scratch folder. */
  scratch: string;
  /** Real path of the user's home, whose credential folders are denied to Read. */
  userHome: string;
  /** Walks the output folder again; the reason when a symlink has appeared since. */
  recheck(): string | null;
  /** Removes the scratch folder. Safe to call more than once. */
  dispose(): void;
}

export type SpawnScopeResult =
  | { ok: true; scope: BoardScope | null }
  | { ok: false; reason: string };

export type ScopePathsResult = { ok: true; paths: ScopePaths } | { ok: false; reason: string };

/**
 * Read-only `dreamcontext` verbs a scoped agent may run. Each entry is pinned to a real
 * command of `createProgram()` by a drift test, so a renamed verb fails a test instead of
 * silently dropping out of the allowlist.
 */
export const BOARD_AGENT_READ_VERBS = [
  'snapshot',
  'memory recall',
  'tasks list',
  'knowledge index',
  'lab list',
  'lab show',
  'whiteboard list',
  'whiteboard show',
  'whiteboard nav list',
  'automations list',
  'automations show',
  'automations thread',
  'automations pattern',
  'automations flow',
] as const;

/** Verbs that act on the home board; the board slug is part of each rule. */
export const BOARD_AGENT_BOARD_VERBS = [
  'whiteboard add',
  'whiteboard update',
  'whiteboard remove',
  'whiteboard draw',
  'whiteboard nav add',
  'whiteboard nav remove',
  'whiteboard nav move',
] as const;

/** Verbs that act as the agent itself; its own slug is part of each rule. */
export const BOARD_AGENT_SELF_VERBS = ['automations post', 'automations learn', 'automations propose'] as const;

/** Built-in tools allowed without a rule argument. No `Skill`: a skill's `allowed-tools`
 *  frontmatter can grant tools this list does not. */
export const BOARD_AGENT_TOOLS = [
  'Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'ToolSearch', 'BashOutput', 'TaskOutput',
] as const;

/** Orchestration tools removed outright. */
export const BOARD_AGENT_DISALLOWED_TOOLS = ['Agent', 'Task', 'Workflow'] as const;

/**
 * Characters refused in any real path that a rule embeds. Each one either has meaning inside
 * a rule (`(`, `)`, `,`, `*`, `?`, `[`, `]`, `{`, `}` and `!` as glob syntax, `"` and `\` as
 * quoting, `#` as a comment) or could end the rule early (a control character, newline
 * included). A refused spawn costs a renamed folder; a mis-parsed rule could widen the grant.
 */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_PATH_CHARS = /[,()*"?[\]{}!\\#\u0000-\u001f\u007f]/;

/** Why `path` cannot go into a rule, or null when it can. Exported for the unit test. */
export function forbiddenPathReason(label: string, path: string): string | null {
  const hit = FORBIDDEN_PATH_CHARS.exec(path);
  if (!hit) return null;
  const ch = hit[0];
  const shown = ch === '\n' ? 'a newline' : /[\u0000-\u001f\u007f]/.test(ch) ? 'a control character' : `"${ch}"`;
  return `the ${label} path contains ${shown}, which a permission rule cannot hold safely`;
}

/**
 * Which board this spawn is scoped to, re-decided at every spawn.
 *
 * `root` is the vault (`<project>/_dream_context`). `home` is the machine-local home that
 * holds the approval registry, the same one as `VerdictOptions.home`, passed straight to
 * `checkApproval`; injectable so a test never reads the developer's real one.
 *
 * Refuses an unapproved manifest (for every agent, scoped or not: a resume used to skip
 * this), a manifest whose board disagrees with the board a human here approved, a board
 * together with `outputDir`, and a board that does not exist. `scope: null` is an ordinary,
 * unscoped agent.
 */
export function resolveSpawnScope(root: string, m: AutomationManifest, home?: string): SpawnScopeResult {
  const approval = checkApproval(dirname(root), m, home);
  if (!approval.approved) {
    return {
      ok: false,
      reason: `"${m.slug}" is not approved as it stands (${approval.reason}); approve it again before talking to it`,
    };
  }
  const fromManifest = m.whiteboard ?? null;
  const fromEntry = approval.entry.whiteboard ?? null;
  if (fromManifest && fromEntry && fromManifest !== fromEntry) {
    return {
      ok: false,
      reason: `the manifest names board "${fromManifest}" but board "${fromEntry}" was approved`,
    };
  }
  const board = fromManifest ?? fromEntry;
  if (!board) return { ok: true, scope: null };
  if (m.outputDir) {
    return { ok: false, reason: 'a board agent cannot also set an output folder' };
  }
  try {
    resolveWhiteboardPath(root, board);
  } catch {
    return { ok: false, reason: `its board "${board}" does not exist or cannot be read` };
  }
  return { ok: true, scope: { board, self: m.slug } };
}

/** The first symlink found at or below `dir`, dangling ones included, as a reason. */
function symlinkBelow(dir: string): string | null {
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const p = join(current, entry.name);
      // lstat, not the dirent's type alone: it is the call that never follows the link.
      const st = lstatSync(p);
      if (st.isSymbolicLink()) return `a symlink sits in its output folder (${entry.name})`;
      if (st.isDirectory()) stack.push(p);
    }
  }
  return null;
}

/** mkdir one segment at a time, refusing a symlink or a non-folder at any step, so the
 *  creation itself can never follow a link out of the vault. */
function ensureRealDir(path: string): string | null {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    mkdirSync(path);
    st = lstatSync(path);
  }
  if (st.isSymbolicLink()) return 'a symlink sits on the path to its output folder';
  if (!st.isDirectory()) return 'something other than a folder sits on the path to its output folder';
  return null;
}

function realHome(): string {
  try {
    return realpathSync(homedir());
  } catch {
    return homedir();
  }
}

/**
 * Create and check the two writable folders for one spawn: `<vault>/automations/output/<self>`
 * (kept) and a fresh `dc-board-*` scratch folder (removed by `dispose`). Every segment from
 * the vault down to the output folder is lstat'ed, and everything below it walked, so no
 * symlink (dangling included) can turn a Write rule into a write somewhere else.
 */
export function prepareScopePaths(root: string, scope: BoardScope): ScopePathsResult {
  let scratch: string | null = null;
  const dispose = (): void => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    scratch = null;
  };
  try {
    const realRoot = realpathSync(root);
    const relOutput = outputRootDir(realRoot).slice(realRoot.length + 1).split(/[\\/]/);
    let cursor = realRoot;
    for (const segment of [...relOutput, scope.self]) {
      cursor = join(cursor, segment);
      const bad = ensureRealDir(cursor);
      if (bad) return { ok: false, reason: bad };
    }
    const outputSelf = cursor;
    const linked = symlinkBelow(outputSelf);
    if (linked) return { ok: false, reason: linked };

    const userHome = realHome();
    scratch = mkdtempSync(join(realpathSync(tmpdir()), 'dc-board-'));
    const created: string = scratch;
    const bad =
      forbiddenPathReason('output folder', outputSelf) ??
      forbiddenPathReason('scratch folder', created) ??
      forbiddenPathReason('home folder', userHome);
    if (bad) {
      dispose();
      return { ok: false, reason: bad };
    }
    return {
      ok: true,
      paths: {
        outputSelf,
        scratch: created,
        userHome,
        recheck: () => {
          try {
            return symlinkBelow(outputSelf);
          } catch (err) {
            return `its output folder could not be checked (${(err as NodeJS.ErrnoException).code ?? 'error'})`;
          }
        },
        dispose,
      },
    };
  } catch (err) {
    dispose();
    return {
      ok: false,
      reason: `its folders could not be prepared (${(err as NodeJS.ErrnoException).code ?? 'error'})`,
    };
  }
}

/**
 * Where credentials live, denied to Read (and so to Grep and Glob). A board note can carry a
 * prompt injection, and a scoped agent can still reach the network (WebFetch) and its board,
 * so anything it can read can leave. Folders under the home, whole:
 */
export const CREDENTIAL_HOME_DIRS = [
  '.ssh', '.aws', '.claude', '.dreamcontext', '.config/gh', '.config/gcloud', '.docker', '.gnupg', '.kube', '.azure',
] as const;
/** Single files under the home. */
export const CREDENTIAL_HOME_FILES = ['.claude.json', '.npmrc', '.netrc', '.git-credentials', '.pypirc'] as const;
/** Patterns denied wherever they sit, the project included. */
export const CREDENTIAL_ANYWHERE = ['**/.env*', '**/*.pem', '**/*.key', '**/id_rsa*', '**/id_ed25519*'] as const;

/** `Write(//abs/**)`: Claude Code reads a rule path starting `//` as absolute from the root. */
function absRule(tool: string, realPath: string, glob = '/**'): string {
  return `${tool}(/${realPath}${glob})`;
}

/**
 * The scoped permission argv, PURE. For a scoped agent it replaces
 * `--permission-mode bypassPermissions` wherever that sits, and nothing else changes.
 * `userHome` defaults to the real home; tests pass a fixed one so the rules are literal.
 */
export function boardScopeArgs(
  s: Pick<BoardScope, 'board' | 'self'>,
  p: Pick<ScopePaths, 'outputSelf' | 'scratch'> & { userHome?: string },
): string[] {
  const home = p.userHome ?? realHome();
  return [
    '--permission-mode', 'dontAsk',
    '--setting-sources', 'project',
    '--allowedTools',
    ...BOARD_AGENT_TOOLS,
    ...BOARD_AGENT_READ_VERBS.map((v) => `Bash(dreamcontext ${v}:*)`),
    ...BOARD_AGENT_BOARD_VERBS.map((v) => `Bash(dreamcontext ${v} ${s.board}:*)`),
    ...BOARD_AGENT_SELF_VERBS.map((v) => `Bash(dreamcontext ${v} ${s.self}:*)`),
    absRule('Write', p.outputSelf),
    absRule('Edit', p.outputSelf),
    absRule('Write', p.scratch),
    absRule('Edit', p.scratch),
    '--disallowedTools',
    ...BOARD_AGENT_DISALLOWED_TOOLS,
    // Credential reads. Read rules also govern Grep and Glob (confirmed on a real claude).
    ...CREDENTIAL_HOME_DIRS.map((d) => absRule('Read', join(home, d))),
    ...CREDENTIAL_HOME_FILES.map((f) => absRule('Read', join(home, f), '')),
    ...CREDENTIAL_ANYWHERE.map((g) => `Read(${g})`),
  ];
}

/** The three env vars a scoped child gets, built from the scope, never from a caller. */
export function scopeEnv(s: BoardScope, p: Pick<ScopePaths, 'scratch'>): Record<string, string> {
  return {
    [AGENT_BOARD_ENV]: s.board,
    [AGENT_SELF_ENV]: s.self,
    [AGENT_SCRATCH_ENV]: p.scratch,
  };
}

/** The refusal sentence a run records when the scope fails. */
export function scopeRefusal(title: string, reason: string): string {
  return `Could not limit ${title} to its board: ${reason}`;
}
