import { lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { boardHoldIn, checkApproval, getAgentEntry, type ApprovalEntry } from './registry.js';
import { ownerLabel } from '../agents/owner.js';
import { placement } from '../agents/active.js';
import { outputRootDir } from './store.js';
import { resolveWhiteboardPath } from '../whiteboards/store.js';
import { identityOnly } from '../agents/compose.js';
import {
  AGENT_BOARD_ENV,
  AGENT_SCRATCH_ENV,
  AGENT_SELF_ENV,
  type ApprovalUse,
  type AutomationManifest,
} from './types.js';

/**
 * The permission envelope of a BOARD-ONLY agent: one whose manifest names a `whiteboard` AND says
 * `scope: board` (or an old board agent the owner has not yet answered about, see
 * {@link boardLimited}).
 *
 * A home board alone is a presentation surface, never a permission scope (owner 2026-11-07): an
 * agent with a board and no `scope: board` gets exactly the envelope of a member without one (its
 * runs `bypassPermissions` with `.env*` closed to Read, its conversations its autonomy level), and
 * its board only shows its work and hosts its card conversation.
 *
 * Every other agent runs under `bypassPermissions`. A board-only agent instead runs under
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
  /** `scope`: the board-only envelope, or null. `homeBoard`: the agent's home board whatever its
   *  envelope (what its turns show and where its card lives), or null. `held`: board-only only
   *  because the owner has not answered the old-agent question yet. */
  | { ok: true; scope: BoardScope | null; homeBoard: string | null; held: boolean }
  | { ok: false; reason: string };

/**
 * Whether a home-board agent is limited to its board: its manifest says `scope: board`, or an
 * approval entry here holds it (`boardHoldIn`: an old board agent the owner has not yet answered
 * about) or marks it `board`. The entry that approved this target and the agent's own entry both
 * count, so a routine follows its agent. Fails closed: any doubt keeps the limit.
 */
export function boardLimited(
  projectRoot: string,
  m: Pick<AutomationManifest, 'boardOnly' | 'agent' | 'slug'>,
  entry: ApprovalEntry | null,
  home?: string,
): { limited: boolean; held: boolean } {
  if (m.boardOnly === true) return { limited: true, held: false };
  const own = entry ?? null;
  const agentEntry = getAgentEntry(projectRoot, m.agent || m.slug, home);
  const held = boardHoldIn(own) || boardHoldIn(agentEntry);
  const marked = own?.boardScope === 'board' || agentEntry?.boardScope === 'board';
  return { limited: held || marked, held };
}

/** The env deny every home-board agent that is NOT board-only carries: it may run scripts that
 *  load a `.env` themselves, never read one with the Read tool (owner 2026-11-07, item 5). */
export const OPEN_BOARD_READ_DENIES = ['Read(**/.env*)'] as const;

/** The run and resume envelope of a home-board agent that is not board-only: a board-less
 *  member's own (`bypassPermissions`), with `.env*` closed to Read. */
export function openBoardArgs(): string[] {
  return ['--permission-mode', 'bypassPermissions', '--disallowedTools', ...OPEN_BOARD_READ_DENIES];
}

/** `args` (a task step's level argv) with `.env*` closed to Read as well: joined into its own
 *  `--disallowedTools` value when it has one (one flag, never two), else appended. */
export function withOpenBoardDenies(args: readonly string[]): string[] {
  const out = [...args];
  const i = out.indexOf('--disallowedTools');
  if (i >= 0 && i + 1 < out.length) out[i + 1] = `${out[i + 1]} ${OPEN_BOARD_READ_DENIES.join(' ')}`;
  else out.push('--disallowedTools', ...OPEN_BOARD_READ_DENIES);
  return out;
}

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
  // Read-only: a free spot for --size; the write itself re-checks under the board lock.
  'whiteboard place',
  // The drawing kit's reference: how a skill-less agent learns `draw --spec`.
  'whiteboard kit',
  'whiteboard nav list',
  'whiteboard group list',
  'automations list',
  'automations show',
  'automations thread',
  'automations pattern',
  'automations flow',
  // An agent card's read hint (`board-refs.ts`) names `agents show`.
  'agents list',
  'agents show',
  // An app's board agent reads the app and its tool list. `apps do|call` never join this list: reading only.
  'apps list',
  'apps tools',
  'apps status',
] as const;

/** Verbs that act on the home board; the board slug is part of each rule. */
export const BOARD_AGENT_BOARD_VERBS = [
  'whiteboard add',
  'whiteboard update',
  'whiteboard remove',
  'whiteboard draw',
  // Writes a PNG, and the CLI keeps `--out` inside the scratch or output folder.
  'whiteboard render',
  'whiteboard nav add',
  'whiteboard nav remove',
  'whiteboard nav move',
  // Its own board's explorer group; `group rename` (every board) is not a scoped verb.
  'whiteboard group set',
  'whiteboard group clear',
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

/**
 * A real path as a Claude Code permission rule spells it. On Windows Claude Code turns a path into
 * POSIX form before it matches (`C:\Users\x` is `/c/Users/x`, the conversion its Git Bash layer
 * uses; its own absolute rules read `//c/...`), so a rule written with the native spelling matches
 * nothing, and a deny that matches nothing is no deny. Everywhere else the path is unchanged: on
 * macOS and Linux a backslash is a character of the name, and `forbiddenPathReason` refuses it.
 * Pure (`platform` is injectable), so a Mac test pins the Windows spelling with `path.win32`.
 */
export function rulePath(p: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return p;
  const drive = /^([A-Za-z]):[\\/]+/.exec(p);
  const rest = (drive ? p.slice(drive[0].length) : p).replace(/\\/g, '/');
  return drive ? `/${drive[1].toLowerCase()}${rest ? `/${rest}` : ''}` : rest;
}

/** Why `path` cannot go into a rule, or null when it can. Exported for the unit test. */
export function forbiddenPathReason(label: string, path: string, platform: NodeJS.Platform = process.platform): string | null {
  // A Windows network path (`\\server\share`) has no drive to anchor a rule on: refused, not guessed.
  if (platform === 'win32' && /^[\\/]{2}/.test(path)) return `the ${label} path is a network path, which a permission rule cannot hold safely`;
  const hit = FORBIDDEN_PATH_CHARS.exec(rulePath(path, platform));
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
 *
 * `use` is passed straight to `checkApproval`, and defaults to the strict `'run'`. A
 * conversation (`'identity'`: Chat, card chat) is approved on the full target but scoped
 * from {@link identityOnly}, so an agent's call settings — a synced `output_dir` above all —
 * can never widen what a conversation may write.
 */
export function resolveSpawnScope(
  root: string,
  m: AutomationManifest,
  home?: string,
  use: ApprovalUse = 'run',
): SpawnScopeResult {
  const approval = checkApproval(dirname(root), m, home, use);
  if (!approval.approved && approval.reason === 'not_owner') {
    return { ok: false, reason: `"${m.slug}" belongs to ${ownerLabel(approval.owner)}, so it is read-only here: only its owner talks to it or runs it` };
  }
  if (!approval.approved) {
    return {
      ok: false,
      reason: `"${m.slug}" is not approved as it stands (${approval.reason}); approve it again before talking to it`,
    };
  }
  // Same login, several machines: only the machine the owner brought it to runs it (B1-7).
  const where = placement(root, m.agent || m.slug, m.owner ?? null, home);
  if (!where.here) {
    return { ok: false, reason: `"${m.slug}" runs on ${where.name}; bring it here on the AI Team page to run it on this machine` };
  }
  const scoped = use === 'identity' ? identityOnly(m) : m;
  const fromManifest = scoped.whiteboard ?? null;
  const fromEntry = approval.entry.whiteboard ?? null;
  const board = fromManifest ?? fromEntry;
  if (!board) return { ok: true, scope: null, homeBoard: null, held: false };
  const { limited, held } = boardLimited(dirname(root), scoped, approval.entry, home);
  // A home board that does not limit: the agent runs as any member does, and the board is only
  // where its work shows. Nothing about the board can refuse the spawn then.
  if (!limited) return { ok: true, scope: null, homeBoard: board, held: false };
  if (fromManifest && fromEntry && fromManifest !== fromEntry) {
    return {
      ok: false,
      reason: `the manifest names board "${fromManifest}" but board "${fromEntry}" was approved`,
    };
  }
  if (scoped.outputDir) {
    return { ok: false, reason: 'a board agent cannot also set an output folder' };
  }
  try {
    resolveWhiteboardPath(root, board);
  } catch {
    return { ok: false, reason: `its board "${board}" does not exist or cannot be read` };
  }
  return { ok: true, scope: { board, self: m.slug }, homeBoard: board, held };
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
/**
 * The credential folders of a home on this platform. Windows keeps gh's token and gcloud's
 * credentials under the roaming profile, not `~/.config`, so a deny list of the POSIX folders
 * alone would leave both readable there.
 */
export function credentialHomeDirs(platform: NodeJS.Platform = process.platform): readonly string[] {
  if (platform !== 'win32') return CREDENTIAL_HOME_DIRS;
  return [...CREDENTIAL_HOME_DIRS, 'AppData/Roaming/GitHub CLI', 'AppData/Roaming/gcloud'];
}
/** Single files under the home. */
export const CREDENTIAL_HOME_FILES = ['.claude.json', '.npmrc', '.netrc', '.git-credentials', '.pypirc'] as const;
/** Patterns denied wherever they sit, the project included. */
export const CREDENTIAL_ANYWHERE = ['**/.env*', '**/*.pem', '**/*.key', '**/id_rsa*', '**/id_ed25519*'] as const;

/** `Write(//abs/**)`: Claude Code reads a rule path starting `//` as absolute from the root
 *  (`//c/Users/...` on Windows, see {@link rulePath}). */
export function absRule(tool: string, realPath: string, glob = '/**'): string {
  return `${tool}(/${rulePath(realPath)}${glob})`;
}

/** The credential folders and files of a home, as deny rules. */
export function credentialReadDenies(userHome?: string, platform: NodeJS.Platform = process.platform): string[] {
  const home = userHome ?? realHome();
  return [
    ...credentialHomeDirs(platform).map((d) => absRule('Read', join(home, d))),
    ...CREDENTIAL_HOME_FILES.map((f) => absRule('Read', join(home, f), '')),
  ];
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
    ...credentialReadDenies(home),
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

/**
 * The named reason a board-only run or turn records when Claude Code denied it a step (the
 * `dontAsk` envelope): what is off, and how the owner lifts it. `held` names the old-agent
 * question instead of the checkbox, since such an agent has no `scope: board` to untick.
 */
export function boardLimitReason(title: string, slug: string, held: boolean): string {
  const lift = held
    ? `answer "Should ${title} still be limited to its board?" on its AI Team page, or run \`dreamcontext agents board-scope ${slug} lift\``
    : `untick "Limit to its board" in its Edit dialog, or run \`dreamcontext agents edit ${slug} --no-board-only\``;
  return `${title} is limited to its board: Bash, node, MCP tools and .env are off, and it writes only to its board and its output folder. To lift it: ${lift}.`;
}

/** Marks a board-limit reason inside a longer line (a thread entry, a run error). */
export const BOARD_LIMIT_MARK = 'is limited to its board:';

/** How a target's board decides its envelope, for a surface that shows it (`agents show`, the AI
 *  Team): its home board, whether it is limited, whether only by the old-agent hold, and whether
 *  the owner owes the one question about it (approved, held, no `scope: board` of its own). */
export interface BoardEnvelopeView {
  board: string | null;
  limited: boolean;
  held: boolean;
  question: boolean;
}

/** Read-only: never prepares folders, never refuses. `projectRoot` holds the approvals. */
export function boardEnvelopeView(projectRoot: string, m: AutomationManifest, home?: string): BoardEnvelopeView {
  const board = m.whiteboard ?? null;
  if (!board) return { board: null, limited: false, held: false, question: false };
  const verdict = checkApproval(projectRoot, m, home, 'run');
  const { limited, held } = boardLimited(projectRoot, m, verdict.approved ? verdict.entry : null, home);
  return { board, limited, held, question: verdict.approved && held && m.boardOnly !== true };
}

/** The one `effective:` line `agents show` prints. `chatMode` is the autonomy level's chat mode. */
export function effectiveEnvelopeLine(view: BoardEnvelopeView, chatMode: string): string {
  if (view.limited) {
    return view.held
      ? 'effective: dontAsk (board-scoped, kept from before boards stopped limiting; the owner is asked once whether it stays)'
      : 'effective: dontAsk (board-scoped)';
  }
  const shows = view.board ? `; its board "${view.board}" shows its work, .env closed to Read` : '';
  return `effective: chat ${chatMode}, runs bypassPermissions${shows}`;
}
