/**
 * The Bash gate of an app's own assistant (plan r9, D6). Read-only Bash needs no permission, so
 * the allow list is no wall for Bash by itself (probed: `grep -r`, `git grep`, `git show HEAD:.env`
 * and `find` ran with no card and printed an `.env` line). A PreToolUse hook classifies every
 * command with this PURE function; it answers only `{}`, `ask` or `deny`, never `allow`.
 *
 * An allowlist, not a list of dangers: outside quotes only letters, digits, space and
 * `_ . / : = , @ % + -` are plain text, `; & | > < ( )` split the command, and everything else
 * falls to `ask`, so an unforeseen shell form asks the owner rather than running. Quotes come off
 * before classifying, so `"--vault"` and `--va""ult` are flags.
 */

import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, relative } from 'node:path';
import { checkAppDataChain, scanAppData } from './data-dir.js';
import { appPullHeld } from './data-conflicts.js';
import { getApp } from './registry.js';
import { appHash } from './bundle.js';

/** What the gate knows about one chat, written at spawn under the `chats/**` write deny. */
export interface BashGateContext {
  slug: string;
  appRoot: string;
  dataDir: string;
  /** Ids of the tools that only READ (`effectOf`), the ones `apps do` runs with no card. */
  actions: string[];
  /** The owning project (real path): the data folder's chain is checked from here. */
  projectRoot?: string;
  /** The HOME the chat was prepared for: its `~/.dreamcontext/apps` is protected data too. */
  home?: string;
  /** The app record's hash (its team-pull record is keyed by it); looked up when absent. */
  hash?: string;
}

/**
 * Is a team pull landing this app's data now (app-veri-ortak K5, "tek kapı")? Then the app's
 * assistant and a bound member can neither read nor write its data folder. Read from disk every
 * call (`appPullHeld` itself fails closed). The hash: the context's, else the registry's record,
 * else an own app's `appHash(projectRoot, slug)`; with no project there is no data folder to hold.
 */
export function gatePullHeld(ctx: BashGateContext): boolean {
  const home = ctx.home ?? homedir();
  let hash = ctx.hash;
  if (!hash && ctx.projectRoot) {
    try { hash = getApp(home, ctx.projectRoot, ctx.slug)?.hash; } catch { hash = undefined; }
    if (!hash) { try { hash = appHash(ctx.projectRoot, ctx.slug); } catch { hash = undefined; } }
  }
  if (!hash) return false;
  return appPullHeld(home, hash);
}

/** The refusal while {@link gatePullHeld}. */
export const PAUSED_FOR_SYNC_REASON = 'paused_for_sync: team data is landing in this app\'s data folder right now; try again in a moment.';

export type BashGateDecision =
  | { decision: 'pass' }
  | { decision: 'ask'; reason: string }
  | { decision: 'deny'; reason: string };

export interface ListedVerb {
  /** The words after `dreamcontext`. */
  words: readonly string[];
  /** Must be followed by this app's own slug. */
  ownSlug?: true;
  /** Must then name a tool that only reads. */
  action?: true;
  /** The flags that run with no card. Every other flag of the verb is in {@link REFUSED_FLAGS}. */
  flags: readonly string[];
}

/** Each with its flag allowlist; a drift test compares them against `createProgram`. */
export const LISTED_VERBS: readonly ListedVerb[] = [
  { words: ['memory', 'recall'], flags: ['-t', '--top', '--types', '--level', '--json', '--plain'] },
  { words: ['lab', 'show'], flags: ['--select', '--json'] },
  { words: ['knowledge', 'index'], flags: ['--plain', '--tag'] },
  {
    words: ['tasks', 'list'],
    flags: ['-s', '--status', '-a', '--all', '--tag', '--any-tag', '--version', '--priority', '--feature', '--objective', '--since', '--until', '-g', '--group-by', '--long', '--tags', '--json', '--parent'],
  },
  { words: ['apps', 'tools'], flags: ['--json'] },
  { words: ['apps', 'status'], ownSlug: true, flags: [] },
  { words: ['apps', 'logs'], ownSlug: true, flags: ['-n', '--lines'] },
  { words: ['apps', 'do'], ownSlug: true, action: true, flags: ['--input', '--json'] },
  { words: ['apps', 'learn'], ownSlug: true, flags: [] },
  // Asking is free; doing needs the owner's Onayla: the server spends a grant only for the
  // stored plan of THIS app and action, so a forged or reused --grant is refused there.
  { words: ['apps', 'update'], ownSlug: true, flags: ['--check', '--ask', '--how', '--wait', '--apply', '--grant', '--json'] },
  {
    words: ['apps', 'publish'], ownSlug: true,
    flags: ['--public', '--dry-run', '--go', '--grant', '--invite', '--approve', '--note', '--ask', '--wait', '--no-catalog', '--json'],
  },
  { words: ['apps', 'logo'], ownSlug: true, flags: ['--ask', '--wait', '--grant', '--json'] },
  // The answer to its own ask. The server does not check who asks: a request id is unguessable,
  // and its answer is only a state or a command that runs the plan the owner approved.
  { words: ['apps', 'grant'], flags: ['--wait', '--json'] },
];

/** A verb's flags that reach past this chat's project: a card each. `memory recall --vault`. */
export const REFUSED_FLAGS: Readonly<Record<string, readonly string[]>> = {
  'memory recall': ['--vault', '--connected', '--all-vaults'],
  // A change the owner agreed to: the card IS his yes, and the server then lets it through.
  'apps do': ['--confirm'],
  // The repo name and the store line are the owner's (the Share sheet); a confirm is his click.
  'apps publish': ['--repo', '--tagline', '--confirm-name'],
};

const SPLITTERS = new Set([';', '&', '|', '>', '<', '(', ')']);
const PLAIN = /^[\p{L}\p{N} _./:=,@%+-]$/u;

const READ_VERB = /^\s*(?:cd\s+\S+\s*&&\s*)?(cat|head|tail|wc|sed)(?:\s|$)/;

type Parsed = { parts: string[][] } | { ask: string };

/** The command as parts of unquoted tokens, or why it is not plain enough to read. */
export function parseCommand(command: string): Parsed {
  if (/[\r\n]/.test(command)) return { ask: 'a command on several lines' };
  if (command.includes('\\')) return { ask: 'a backslash' };
  const parts: string[][] = [[]];
  let token = '';
  let inToken = false;
  let quote: '"' | "'" | null = null;
  const endToken = () => {
    if (inToken) parts[parts.length - 1].push(token);
    token = '';
    inToken = false;
  };
  for (const ch of command) {
    if (quote === "'") {
      if (ch === "'") quote = null; else token += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') { quote = null; continue; }
      if (ch === '$' || ch === '`') return { ask: 'a shell expansion in double quotes' };
      token += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; inToken = true; continue; }
    if (ch === ' ') { endToken(); continue; }
    if (SPLITTERS.has(ch)) {
      endToken();
      if (parts[parts.length - 1].length) parts.push([]);
      continue;
    }
    if (ch === '#') return { ask: 'an unquoted #' };
    if (!PLAIN.test(ch)) return { ask: `the character ${JSON.stringify(ch)}` };
    token += ch;
    inToken = true;
  }
  if (quote) return { ask: 'an unbalanced quote' };
  endToken();
  if (parts.length > 1 && !parts[parts.length - 1].length) parts.pop();
  return { parts };
}

function flagName(token: string): string {
  const eq = token.indexOf('=');
  return eq > 0 ? token.slice(0, eq) : token;
}

/** The verb this part runs, when it is a listed one for this app. Flags are not judged here. */
function listedVerb(part: readonly string[], ctx: BashGateContext): ListedVerb | null {
  if (part[0] !== 'dreamcontext') return null;
  for (const v of LISTED_VERBS) {
    if (!v.words.every((w, i) => part[i + 1] === w)) continue;
    const next = 1 + v.words.length;
    if (v.ownSlug && part[next] !== ctx.slug) return null;
    if (v.action && !ctx.actions.includes(part[next + 1] ?? '')) return null;
    return v;
  }
  return null;
}

function realInside(root: string, path: string): boolean {
  try {
    if (!isAbsolute(path) || !existsSync(path)) return false;
    const r = relative(realpathSync(root), realpathSync(path));
    return !r.startsWith('..') && !isAbsolute(r);
  } catch {
    return false;
  }
}

const ASK = (why: string): BashGateDecision => ({
  decision: 'ask',
  reason: `This runs only with the owner's yes (${why}).`,
});

/** The ways to read a file are named here so a retry costs nothing: a deny runs nothing. */
function bareForm(ctx: BashGateContext): string {
  return `Run each one bare, one per call: read a file with Read, list with \`ls ${ctx.appRoot}\` or \`ls ${ctx.dataDir}\`, and call dreamcontext verbs with no pipe, redirect or \`cd\`.`;
}

/** Decide one Bash command. First match wins. */
export function classifyBash(command: string, ctx: BashGateContext): BashGateDecision {
  // First, on the raw text, ahead of the parser: a deny runs nothing, so it costs no safety.
  const read = READ_VERB.exec(command);
  if (read) {
    return { decision: 'deny', reason: `Not run: use the Read tool for files (\`${read[1]}\` is not needed here; Read takes offset and limit for a range).` };
  }
  const parsed = parseCommand(command);
  if ('ask' in parsed) return ASK(parsed.ask);
  const parts = parsed.parts.filter((p) => p.length);
  if (!parts.length) return ASK('an empty command');
  const first = parts[0][0] === 'cd' && parts.length > 1 ? parts[1] : parts[0];
  const verb = listedVerb(first, ctx);
  const isLs = first[0] === 'ls';

  if (parts.length === 1 && verb) {
    const flags = first.filter((t) => t.startsWith('-')).map(flagName);
    const other = flags.find((f) => !verb.flags.includes(f));
    return other ? ASK(`the flag ${other}`) : { decision: 'pass' };
  }
  if (parts.length > 1 && (verb || isLs)) return { decision: 'deny', reason: `Not run. ${bareForm(ctx)}` };
  if (parts.length === 1 && isLs) {
    const paths = first.slice(1).filter((t) => !t.startsWith('-'));
    // A team pull lands this app's data: its folder is closed until it is done.
    if (paths.some((p) => realInside(ctx.dataDir, p)) && gatePullHeld(ctx)) return { decision: 'deny', reason: `Not run: ${PAUSED_FOR_SYNC_REASON}` };
    if (first.slice(1).some((t) => t.startsWith('-') && !/^-[A-Za-z0-9]+$/.test(t))) return ASK('a flag of ls');
    // A link inside the data folder could make `ls -L`/`-R` list another app's names: none allowed.
    const dataOk = (!ctx.projectRoot || checkAppDataChain(ctx.projectRoot, ctx.slug).ok) && (() => {
      const scan = scanAppData(ctx.dataDir);
      return !scan.symlink && !scan.truncated;
    })();
    if (paths.length && paths.every((p) => realInside(ctx.appRoot, p) || (dataOk && realInside(ctx.dataDir, p)))) return { decision: 'pass' };
    if (!paths.length || paths.some((p) => !isAbsolute(p))) {
      return { decision: 'deny', reason: `Not run: list with an absolute path, \`ls ${ctx.appRoot}\` or \`ls ${ctx.dataDir}\`.` };
    }
  }
  return ASK('a shell command');
}

/** The JSON a PreToolUse hook prints for a decision. `{}` leaves the verdict to the permission rules. */
export function gateHookOutput(d: BashGateDecision): Record<string, unknown> {
  if (d.decision === 'pass') return {};
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: d.decision, permissionDecisionReason: d.reason } };
}

/** The gate file's text as a context, or null for anything malformed. */
export function parseGateContext(text: string): BashGateContext | null {
  try {
    const r = JSON.parse(text) as Record<string, unknown>;
    if (typeof r.slug !== 'string' || typeof r.appRoot !== 'string' || typeof r.dataDir !== 'string' || !Array.isArray(r.actions)) return null;
    return {
      slug: r.slug, appRoot: r.appRoot, dataDir: r.dataDir, actions: r.actions.filter((a): a is string => typeof a === 'string'),
      ...(typeof r.projectRoot === 'string' ? { projectRoot: r.projectRoot } : {}),
      ...(typeof r.home === 'string' ? { home: r.home } : {}),
      ...(typeof r.hash === 'string' ? { hash: r.hash } : {}),
    };
  } catch {
    return null;
  }
}
