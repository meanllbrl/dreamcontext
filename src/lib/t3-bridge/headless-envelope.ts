/**
 * What each unattended surface may do on Codex and on Antigravity (plan r5 §6, W4 Lane B; night
 * lane 2, 2026-11-02). One row per surface, read by the callers and pinned by
 * `permission-envelope.test.ts`: a run on another tool is never wider than the same surface on
 * Claude, and no Codex row ever reaches full access, because the owner's rule is that nothing
 * outside the vault opens up (Claude's `bypassPermissions` for an automation stays a Claude thing).
 *
 * Codex: `auto` = workspace-write on the project and its linked repos, network off, every approval
 * declined; `default` = read-only, every approval declined.
 *
 * Antigravity has no OS sandbox (policy.ts `instanceRuntimePolicy`): the agent asks before every
 * edit and command, and the bridge is what answers. `write` = the bridge says yes once the write
 * gate has proved it ran (session.ts `answeredUnattended`), and refuses what the gate leaves to the
 * owner: the same reach as Claude's `bypassPermissions` on these surfaces, never more. `read` = no
 * edit at all, and a command only when it is a plain read (`isPlainReadCommand`): Claude's
 * read-only tools.
 *
 * `null` = Claude only, with the reason. The caller refuses rather than running the row wider.
 *
 * No Effect here: the runner, the server and the tests import it.
 */
export type HeadlessSurface =
  | 'automation' | 'agent' | 'light' | 'verdict' | 'sleep' | 'super-child'
  | 'board-agent' | 'task-step' | 'approval-question' | 'builder' | 'peer' | 'ask' | 'ask-write';

export interface HeadlessEnvelope {
  /** The rule this surface has on Claude. */
  readonly claude: string;
  /** Its Codex mode (policy.ts), or null when it stays on Claude. */
  readonly codex: 'auto' | 'default' | null;
  /** Its Antigravity flavour, or null when it stays on Claude. */
  readonly antigravity: 'write' | 'read' | null;
  /** The brain's MCP write path. */
  readonly brain: boolean;
  /** No MCP from the owner's Codex config and no web search: Claude runs this surface so too. */
  readonly strict?: boolean;
  readonly why?: string;
  /** Why Antigravity cannot run it, when it cannot: the agent's own limit. */
  readonly antigravityWhy?: string;
}

export const HEADLESS_ENVELOPES: Readonly<Record<HeadlessSurface, HeadlessEnvelope>> = {
  automation: { claude: 'bypassPermissions', codex: 'auto', antigravity: 'write', brain: true },
  agent: { claude: 'bypassPermissions', codex: 'auto', antigravity: 'write', brain: true },
  light: { claude: 'read-only tools', codex: 'default', antigravity: 'read', brain: false, strict: true },
  verdict: { claude: 'bypassPermissions, resumed', codex: 'auto', antigravity: 'write', brain: true },
  sleep: { claude: 'bypassPermissions without WebFetch, WebSearch, MCP', codex: 'auto', antigravity: 'write', brain: true, strict: true },
  'super-child': { claude: 'lean MCP, the chat mode', codex: 'auto', antigravity: 'write', brain: true, strict: true },
  'board-agent': { claude: 'read denies on credential folders', codex: null, antigravity: null, brain: false, why: 'Codex proved no read-denies (S3).', antigravityWhy: 'Not built yet: the agent reads files without asking the bridge, so the read denies would have to live in its gate hook, which only guards writes today.' },
  'task-step': { claude: 'its level, a pinned session id', codex: null, antigravity: null, brain: false, why: 'A task step pins a Claude session id before its first turn.', antigravityWhy: 'A task step pins a Claude session id before its first turn.' },
  'approval-question': { claude: 'plan mode, no orchestration tools', codex: 'default', antigravity: 'read', brain: false, strict: true },
  builder: { claude: 'allowlisted tools, forked sessions', codex: null, antigravity: null, brain: false, why: 'Not built yet: Codex threads do fork (thread/fork, a real turn on 0.164.0 kept the parent\'s words), but the builder runner starts Claude sessions only. A Codex lead builds its waves itself, its reviewers as spawn_agent sub-agents.', antigravityWhy: 'Not built yet: the builder runner starts Claude sessions only, and forking an Antigravity conversation was never tried. An Antigravity lead builds its waves itself, its reviewers as invoke_subagent sub-agents.' },
  peer: { claude: 'auto, in the other project', codex: 'auto', antigravity: null, brain: true, antigravityWhy: 'Not built yet: Antigravity has no classifier-gated mode like Claude\'s auto, and its write bridge would let a peer\'s message run any command in another project.' },
  ask: { claude: 'read-only tools', codex: 'default', antigravity: 'read', brain: false, strict: true },
  'ask-write': { claude: 'acceptEdits in the project', codex: 'auto', antigravity: null, brain: true, strict: true, antigravityWhy: 'Not built yet: Antigravity has no edits-only mode, and its write bridge would run any command, wider than Claude\'s acceptEdits.' },
};

export type HeadlessTool = 'codex' | 'antigravity';

/** This surface's mode on `tool`, or null when it stays on Claude. */
export function envelopeMode(surface: HeadlessSurface, tool: HeadlessTool): string | null {
  const row = HEADLESS_ENVELOPES[surface];
  if (!row) return null;
  return tool === 'antigravity' ? row.antigravity : row.codex;
}

/** Why `surface` cannot run on `tool`, or '' when it can. */
export function envelopeRefusal(surface: HeadlessSurface, tool: HeadlessTool): string {
  const row = HEADLESS_ENVELOPES[surface];
  if (!row) return `${surface} is not a headless surface.`;
  if (envelopeMode(surface, tool)) return '';
  return (tool === 'antigravity' ? row.antigravityWhy : row.why) ?? `${surface} runs on Claude only.`;
}

/** Programs a read-only run may start: each only prints. */
/** Not `tree` (`-o` writes a file) nor `file` (`-C` writes one): every name here has no flag that writes. */
const READ_PROGRAMS = new Set(['cat', 'head', 'tail', 'ls', 'grep', 'wc', 'pwd', 'stat', 'diff', 'find', 'echo', 'printf', 'true']);
/** The only paths a program may be named by: the system's own folders. */
const SYSTEM_BIN = /^\/(?:usr\/)?bin\/([a-z]+)$/;
/** `git` and `dreamcontext` subcommands that only read. */
const READ_GIT = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'blame']);
/** Not `snapshot` (it counts trigger firings into `.sleep.json`) nor `roadmap` (it rewrites the board file). */
const READ_DC = /^(?:memory recall|knowledge (?:index|show|list|read)|tasks (?:list|show|get)|features (?:list|show)|bookmark list|changelog list|insights? (?:list|show)|lab (?:list|show)|theses list|peer list|super (?:read|jobs|status)|agents (?:list|show)|automations (?:list|show)|--version|--help)\b/;

/**
 * `c` cut at its unquoted `&&`, `||`, `;` and `|` into commands of words, quotes taken off; null
 * when anything else could run or write: an unquoted redirect, `$`, backtick, backslash, bracket
 * or newline, a `$` / backtick / backslash inside double quotes, an unclosed quote, a lone `&`.
 * Single quotes hold everything literally, as the shell does.
 */
function plainCommands(c: string): string[][] | null {
  const out: string[][] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  let q: "'" | '"' | null = null;
  const endWord = () => { if (inWord) words.push(word); word = ''; inWord = false; };
  const endCommand = (): boolean => { endWord(); if (!words.length) return false; out.push(words); words = []; return true; };
  for (let i = 0; i < c.length; i++) {
    const ch = c[i]!;
    if (q) {
      if (ch === q) { q = null; continue; }
      if (q === '"' && (ch === '$' || ch === '`' || ch === '\\')) return null;
      word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { q = ch; inWord = true; continue; }
    if (ch === ' ' || ch === '\t') { endWord(); continue; }
    if ((ch === '&' && c[i + 1] === '&') || (ch === '|' && c[i + 1] === '|')) { if (!endCommand()) return null; i++; continue; }
    if (ch === ';' || ch === '|') { if (!endCommand()) return null; continue; }
    if (/[&<>`$\\\n\r(){}]/.test(ch)) return null;
    word += ch;
    inWord = true;
  }
  if (q || !endCommand()) return null;
  return out;
}

/** One command that only reads: a reading program, and none of its flags that write or run. */
function readsOnly(words: readonly string[]): boolean {
  // `X=/bin/cat rm -rf ~` is an assignment and then `rm`: a first word with `=` is never a program
  // name, and a path is only one of the system's own (`/bin/cat`), never `./cat` or `/tmp/x/cat`.
  const first = words[0]!;
  if (first.includes('=')) return false;
  const sys = first.match(SYSTEM_BIN);
  if (first.includes('/') && !sys) return false;
  const prog = sys ? sys[1]! : first;
  if (READ_PROGRAMS.has(prog)) return !(prog === 'find' && words.some((w) => /^-(?:delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(w)));
  // `sed -n '<a>,<b>p' <files>` only prints; any other script (`w`, `e`, `-i`) is refused.
  if (prog === 'sed') return words[1] === '-n' && /^\d+(?:,\d+)?p$/.test(words[2] ?? '') && words.slice(3).every((w) => !w.startsWith('-'));
  // The flags that force a diff driver or textconv are refused; one the owner set in git config
  // still runs, and a read-only run cannot write git config.
  if (prog === 'git') return READ_GIT.has(words[1] ?? '') && !words.some((w) => /^--output\b|^-o|^--ext-diff\b|^--textconv\b/.test(w));
  if (prog === 'dreamcontext') return READ_DC.test(words.slice(1).join(' '));
  return false;
}

/**
 * True when `command` only reads: one plain reading program, or several chained with `&&`, `||`,
 * `;` or `|` (Codex chains its reads: a real turn sent `sed -n '1,240p' a && printf '\\n---\\n' &&
 * sed -n '1,80p' b`), each of them a reading program, with no redirect, no substitution and no
 * flag that writes (`find -delete`, `-exec`). Anything else is refused on a read-only run, a
 * sentence-shaped false refusal being far cheaper than a write.
 */
export function isPlainReadCommand(command: string): boolean {
  let c = command.trim();
  // Codex runs every command as `/bin/zsh -lc "<command>"`: judge the command inside. Inside the
  // double-quoted form nothing may expand: no `$` or backtick anywhere in it.
  const wrapped = c.match(/^(?:\/(?:usr\/)?bin\/)?(?:ba|z)?sh\s+-l?c\s+(?:'([^']*)'|"([^"]*)")$/);
  if (wrapped) {
    if (wrapped[2] !== undefined && /[$`]/.test(wrapped[2])) return false;
    c = (wrapped[1] ?? wrapped[2] ?? '').trim();
  }
  if (!c) return false;
  const commands = plainCommands(c);
  return !!commands && commands.length <= 8 && commands.every(readsOnly);
}

export interface CodexRunArgs {
  readonly surface: HeadlessSurface;
  readonly prompt: string;
  /** The tool the turn runs on. Absent = Codex. */
  readonly tool?: HeadlessTool;
  readonly model?: string | null;
  readonly effort?: string | null;
  readonly account?: string | null;
  /** A native thread to continue. */
  readonly resume?: string | null;
  readonly extraRoots?: readonly string[];
}

/** `dreamcontext t3-run …`, after the CLI's path. The prompt rides whole in one `=` argument, so a
 *  prompt that starts with a dash is still its value. */
export function codexRunArgs(a: CodexRunArgs): string[] {
  const out = ['t3-run', '--surface', a.surface, `--prompt=${a.prompt}`];
  if (a.tool === 'antigravity') out.push('--tool', 'antigravity');
  if (a.model) out.push('--model', a.model);
  if (a.effort) out.push('--effort', a.effort);
  if (a.account) out.push('--account', a.account);
  if (a.resume) out.push('--resume', a.resume);
  // Last: `--extra-root` takes every value after it.
  if (a.extraRoots?.length) out.push('--extra-root', ...a.extraRoots);
  return out;
}

/** The same command for either tool: what every runner calls. */
export const toolRunArgs = (a: CodexRunArgs & { tool: HeadlessTool }): string[] => codexRunArgs(a);

/** A Claude alias or id means nothing to Codex: the account's own default answers instead. */
export function codexModelOf(model: string | null | undefined): string | null {
  if (!model) return null;
  return /^(opus|sonnet|haiku|fable|claude)\b/i.test(model) ? null : model;
}

/** The same for any tool: a Claude name never reaches another vendor. */
export const toolModelOf = codexModelOf;
