import { MSG_REF_RE } from './types.js';

/**
 * A push, PR or deploy the owner allowed (owner, 2026-11-12: "when HIS message names a push, PR or
 * deploy, the child does exactly that"). Two sources (plan iyilesme-360 C7):
 *  - `msg`: a message of his named it. `ref` is that message, `words` its gist as the Super's
 *    record kept it when the grant was checked. A merge his message names rides as `merge` (D13).
 *  - `rule`: one of his ACTIVE standing rules covers a staging step (D5). `rule` is its id, `words`
 *    its quoted words, cut to MAX_OUTWARD when granted. Staging only, never a merge.
 * A record with no `source` is a `msg` grant (made before this build).
 *
 * A grant lives with the job that carries it, never with the ledger it was checked against: the
 * pool row keeps it, and so does the child record (a `--succeeds` hand-over passes it on). Checked
 * once, by the route; a `rule` grant is checked again when its child starts (the rule may be gone).
 */
export interface OutwardMerge { pr: number; method: 'squash' | 'merge' | 'rebase'; deleteBranch?: boolean }
export type OutwardGrant =
  | { source?: 'msg'; step: string; ref: string; words?: string; merge?: OutwardMerge }
  | { source: 'rule'; step: string; rule: string; words: string };

/** The longest `--outward` line, and the longest words kept beside it. */
export const MAX_OUTWARD = 300;

/** A rule id as the store writes it (`newRuleId`, base32 of 10). */
export const RULE_ID_RE = /^[a-z0-9]{6,16}$/;

/** No control characters (the line is one line of a child's first message). */
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** The one shape of a merge a message of his may grant (D13). */
export const MERGE_STEP_RE = /^gh pr merge (\d{1,7}) --(squash|merge|rebase)( --delete-branch)?$/;

export const isRuleGrant = (o: OutwardGrant | undefined): o is Extract<OutwardGrant, { source: 'rule' }> => o?.source === 'rule';

/** A grant as a record holds it, or undefined for anything else (the record is local, but a
 *  hand-edited or older file never widens what a child is told). */
export function sanitizeOutward(raw: unknown): OutwardGrant | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.step !== 'string') return undefined;
  const step = r.step.trim();
  if (!step || step.length > MAX_OUTWARD || CONTROL_RE.test(step)) return undefined;
  const words = typeof r.words === 'string' && r.words.trim() && r.words.length <= MAX_OUTWARD + 1 && !CONTROL_RE.test(r.words) ? r.words.trim() : undefined;
  if (r.source === 'rule') {
    if (typeof r.rule !== 'string' || !RULE_ID_RE.test(r.rule) || !words || r.merge !== undefined) return undefined;
    return { source: 'rule', step, rule: r.rule, words };
  }
  if (r.source !== undefined && r.source !== 'msg') return undefined;
  if (typeof r.ref !== 'string' || !MSG_REF_RE.test(r.ref)) return undefined;
  let merge: OutwardMerge | undefined;
  if (r.merge !== undefined) {
    const m = r.merge as Record<string, unknown> | null;
    const shape = MERGE_STEP_RE.exec(step);
    if (!m || typeof m !== 'object' || !shape || m.pr !== Number(shape[1]) || m.method !== shape[2]
      || (m.deleteBranch !== undefined && m.deleteBranch !== true) || (m.deleteBranch === true) !== !!shape[3]) return undefined;
    merge = { pr: m.pr as number, method: m.method as OutwardMerge['method'], ...(m.deleteBranch === true ? { deleteBranch: true } : {}) };
  }
  return { ...(r.source === 'msg' ? { source: 'msg' as const } : {}), step, ref: r.ref, ...(words ? { words } : {}), ...(merge ? { merge } : {}) };
}

const unquote = (s: string): string => s.replace(/[«»]/g, '"');

/** The exact merge command a `merge` grant allows. */
export function mergeCommand(m: OutwardMerge): string {
  return `gh pr merge ${m.pr} --${m.method}${m.deleteBranch ? ' --delete-branch' : ''}`;
}

/** A rule grant checked again at the child's start found its rule no longer active (C7). */
export const RULE_GONE_LINE = 'The standing rule this step came from is no longer active: do not run it; ask the Super.';

/**
 * The child's line for an outward step: what the server checked (his message, or his active
 * standing rule), the step, the limits, and a refused or failed command going to him as a run
 * card, never around the refusal. One line (team-roster's SERVER_LINE_RE strips it from the
 * owner's words).
 */
export function outwardLine(o: OutwardGrant): string {
  const cut = !!o.words && o.words.endsWith('…');
  const words = o.words ? ` His words${cut ? ' (their first 300 characters)' : ''}: «${unquote(o.words)}».` : '';
  const merge = !isRuleGrant(o) && o.merge ? o.merge : undefined;
  const head = isRuleGrant(o)
    ? `The server checked that rule ${o.rule} is his active standing rule; staging only, never production, release, publish or merge. The Super passed on this outward step from it, and you may run exactly it: «${unquote(o.step)}».`
    : `The server checked that ref ${o.ref} is the owner's own message; the Super passed on this outward step from it, and you may run exactly it: «${unquote(o.step)}».`;
  const mergeClause = merge
    ? `Never force-push (--force, --force-with-lease, -f, a +refspec) and never merge locally or push onto the default branch; you may run exactly \`${mergeCommand(merge)}\`. `
    : 'Never force-push (--force, --force-with-lease, -f, a +refspec) and never merge into the default branch (locally, by `gh pr merge` or by pushing onto it). ';
  return `${head}${words} `
    + 'Nothing wider: no other remote, branch, environment or target. If his words plainly contradict the step, do not run it: ask. '
    + mergeClause
    + 'If a permission check refuses the command, or it cannot reach the network, never work around it: leave him a `dream-view` run card with that exact command, and say so in your report.';
}

// ─── What a grant may cover (S2) ─────────────────────────────────────────────

const TR_PLAIN: Record<string, string> = { ı: 'i', ç: 'c', ş: 's', ğ: 'g', ü: 'u', ö: 'o' };
const fold = (s: string): string => s.toLocaleLowerCase('tr').replace(/[ıçşğüö]/g, (c) => TR_PLAIN[c]);

/** A rule's words name the kind of step (S2 a). */
const RULE_KIND_RE = /(?<![a-z0-9])(?:staging\w*|gonder\w*|push\w*|pr|deploy\w*|yayinla\w*)(?![a-z0-9])/;
/** Never on a rule (S2 c): whole words. */
export const OUT_OF_SCOPE_RE = /(?<![\w-])(?:production|prod|--prod|live|canli\w*|release|publish|npm publish|gh release|merge|gh pr merge|force|--force(?:-with-lease)?|-f|--admin|--auto)(?![\w-])|(?:^|\s)\+[\w./:-]+/;
/** Never in any grant: force, --admin, --auto, a local merge (a push onto the default branch: `pushesDefault`). */
const NEVER_RE = /(?<![\w-])(?:--force(?:-with-lease)?|-f|--admin|--auto|git\s+merge)(?![\w-])|(?:^|\s)\+[\w./:-]+/;
/** A merge word in a step. */
const MERGE_WORD_RE = /(?<![\w-])merge(?![\w-])/;
/** His words name merging (D13, folded). */
const MERGE_VERB_RE = /(?<![a-z0-9])(?:birlestir\w*|merge\w*|mergele\w*)(?![a-z0-9])/;
/** A merge said NOT to happen (folded): "do not merge", "merge etme", "birleştirme", "mergeleme". */
const MERGE_NEG_RE = /(?<![a-z0-9])(?:(?:do not|don't|dont|never|no)\s+merge\w*|merge\s+(?:etme|yapma)\w*|mergeleme\w*|birlestirme(?:yin|yiniz)?)(?![a-z0-9])/g;
/** A rule clause that forbids (folded). */
const RULE_NEG_RE = /(?<![a-z0-9])(?:asla|hicbir zaman|never|don't|dont|do not|etme|etmeyin|yapma|atma|gonderme|dokunma)(?![a-z0-9])/;
/** A rule's clauses: "staging'e push et, main'e asla" is an allowing clause and a forbidding one. */
const RULE_CLAUSE_SPLIT_RE = /[,.;!\n]|\s(?:ama|but|fakat|ancak|and|ve|then|sonra)\s/;
/** Production or live as a token, a hyphenated name too (`acme-prod`, `--prod`), folded. */
const PROD_TOKEN_RE = /(?<![a-z0-9])(?:production|prod|live|canli\w*)(?![a-z0-9])/;
/** The default branch in any spelling a push destination takes. */
const DEFAULT_BRANCH_RE = /^(?:refs\/heads\/|refs\/remotes\/[^/]+\/|origin\/)?(?:main|master)$/i;

// ─── Reading a step as commands (S2: the step's own targets decide, never a word in it) ──────────

/** Quoted text is one opaque word: a PR title that says "push", "live" or "main" is never a target. */
const QUOTED_RE = /'[^']*'|"(?:[^"\\]|\\.)*"|`[^`]*`/g;
/** Simple commands: joined by `&&`, `||`, `;`, `|`, `&`, a line, parentheses. */
const CMD_SPLIT_RE = /&&|\|\||[;|&\n()]/;
/** Prose pieces inside one command: ", ", ", then", " and ", " ve ", " sonra ". */
const PROSE_SPLIT_RE = /,\s+(?:(?:and|then|ve|sonra|ardindan)\s+)?|\s(?:and|then|ve|sonra|ardindan)\s/i;
/** Words that run the next one as the command (`sudo git push`, `env X=1 git push`). */
const PREFIX_WORDS: readonly string[] = ['sudo', 'command', 'exec', 'env', 'time', 'nohup', 'nice', 'npx'];
/** git's own options before its subcommand that take the next word (`git -C dir push`). */
const GIT_GLOBAL_VALUE: readonly string[] = ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'];
/** `git push` options that take a value. */
const PUSH_VALUE_FLAGS = new Set(['-o', '--push-option', '--repo', '--exec', '--receive-pack']);

/** Every command piece of a step, as words, quoted text replaced by one opaque word. */
function pieces(step: string): string[][] {
  return step.replace(QUOTED_RE, ' __q__ ').split(CMD_SPLIT_RE)
    .flatMap((seg) => seg.split(PROSE_SPLIT_RE))
    .map((seg) => seg.trim().split(/\s+/).filter(Boolean))
    .filter((t) => t.length > 0);
}

/** The binary of a piece (its base name) and the words after it, env assignments and prefixes skipped. */
function binOf(t: readonly string[]): { bin: string; rest: string[] } | null {
  let i = 0;
  while (i < t.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t[i]) || PREFIX_WORDS.includes(t[i]))) i += 1;
  const head = t[i];
  if (!head) return null;
  return { bin: head.slice(head.lastIndexOf('/') + 1).toLowerCase(), rest: t.slice(i + 1) };
}

/** A git piece's subcommand and its words, git's own options skipped; null: not git. */
function gitSub(t: readonly string[]): { sub: string; args: string[] } | null {
  const b = binOf(t);
  if (!b || b.bin !== 'git') return null;
  let i = 0;
  while (i < b.rest.length && b.rest[i].startsWith('-')) {
    if (!b.rest[i].includes('=') && GIT_GLOBAL_VALUE.includes(b.rest[i])) i += 1;
    i += 1;
  }
  return { sub: (b.rest[i] ?? '').toLowerCase(), args: b.rest.slice(i + 1) };
}

interface GitPush { flags: string[]; remote?: string; refspecs: string[] }

/** The `git push` of a piece, parsed (`git -C dir push` too), or null when it is none. */
function gitPushOf(t: readonly string[]): GitPush | null {
  const g = gitSub(t);
  if (!g || g.sub !== 'push') return null;
  const flags: string[] = [];
  const pos: string[] = [];
  for (let i = 0; i < g.args.length; i++) {
    const x = g.args[i];
    if (x.startsWith('-')) { flags.push(x); if (!x.includes('=') && PUSH_VALUE_FLAGS.has(x)) i++; continue; }
    pos.push(x);
  }
  return { flags, remote: pos[0], refspecs: pos.slice(1) };
}

/** Where a refspec lands: the part after `:` (an empty source = a delete), else the name itself. */
const refDest = (r: string): string => { const x = r.replace(/^\+/, ''); const i = x.indexOf(':'); return i >= 0 ? x.slice(i + 1) : x; };

/**
 * S2: does the step push onto (or delete, mirror, push all onto) the default branch? The push's own
 * refspecs decide, whatever git options come first; another command in the line never counts
 * (`gh pr create --base main` is no push). A piece that says "push" in prose without a git command
 * counts when it names main or master in any spelling.
 */
export function pushesDefault(step: string): boolean {
  for (const t of pieces(step)) {
    const p = gitPushOf(t);
    if (p) {
      if (p.flags.some((f) => f === '--mirror' || f === '--all')) return true;
      if (p.refspecs.some((r) => DEFAULT_BRANCH_RE.test(refDest(r)))) return true;
      continue;
    }
    if (gitSub(t)) continue;
    const c = t.join(' ').toLowerCase();
    if (/(?<![\w-])push\w*/.test(c) && !/\bgh\s+pr\b/.test(c) && /(?:^|[\s:'"(])(?:refs\/heads\/|origin\/)?(?:main|master)(?![\w/-])/.test(c)) return true;
  }
  return false;
}

/** Never in any grant: a force, --admin, --auto, a +refspec (read off the unquoted step), a local merge, a push onto the default branch. */
function neverStep(step: string): boolean {
  if (NEVER_RE.test(fold(step.replace(QUOTED_RE, ' __q__ ')))) return true;
  if (pieces(step).some((t) => gitSub(t)?.sub === 'merge')) return true;
  return pushesDefault(step);
}

/** A target value naming staging: the ops card's staging host, or a `staging` token (`acme-staging`). */
const namesStagingValue = (v: string, host: string | null): boolean => {
  const x = v.toLowerCase();
  return (!!host && (x === host || x.includes(host))) || x.split(/[^a-z0-9]+/).includes('staging');
};

const GH_PR_VALUE = new Set(['--base', '-B', '--head', '-H', '--title', '-t', '--body', '-b', '--body-file', '-F', '--label', '-l', '--reviewer', '-r', '--assignee', '-a', '--milestone', '-m', '--project', '-p', '--repo', '-R']);
const GH_PR_BOOL = new Set(['--fill', '--fill-first', '--fill-verbose', '--draft', '-d', '--no-maintainer-edit', '--dry-run']);
const DEPLOY_TARGET = new Set(['--project', '-P', '--site', '-s', '--alias', '-a', '--target', '--env', '--environment', '-e']);
const NEUTRAL_SCRIPT_RE = /^(?:build|test|lint|typecheck|check)(?::[\w-]+)?$/;

type PieceKind = 'outward' | 'neutral' | null;

/**
 * One piece of a rule-granted step, by allowlist: a staging push, a PR into staging, a deploy whose
 * every target flag names staging, or a neutral build/test/cd. Anything else (`gh api`, `curl`, a
 * push the parser cannot read, a deploy with no staging target) is null and refuses the step.
 */
function stagingPiece(t: readonly string[], host: string | null): PieceKind {
  const b = binOf(t);
  if (!b) return null;
  if (b.bin === 'git') {
    const p = gitPushOf(t);
    if (!p) return null;
    if (p.flags.some((f) => f !== '-u' && f !== '--set-upstream') || !p.remote || p.refspecs.length !== 1) return null;
    const r = p.refspecs[0];
    if (r.startsWith(':') || r.startsWith('+') || refDest(r).replace(/^refs\/heads\//, '').toLowerCase() !== 'staging') return null;
    return 'outward';
  }
  if (b.bin === 'gh') {
    if (b.rest[0] !== 'pr' || b.rest[1] !== 'create') return null;
    const bases: string[] = [];
    const a = b.rest.slice(2);
    for (let i = 0; i < a.length; i++) {
      const [flag, inline] = a[i].includes('=') ? [a[i].slice(0, a[i].indexOf('=')), a[i].slice(a[i].indexOf('=') + 1)] : [a[i], undefined];
      if (GH_PR_BOOL.has(flag) && inline === undefined) continue;
      if (!GH_PR_VALUE.has(flag)) return null;
      const v = inline ?? a[++i];
      if (v === undefined) return null;
      if (flag === '--base' || flag === '-B') bases.push(v);
    }
    return bases.length > 0 && bases.every((v) => v.toLowerCase() === 'staging') ? 'outward' : null;
  }
  if (b.rest.some((w) => w.toLowerCase() === 'deploy' || w.toLowerCase().endsWith(':deploy'))) {
    const targets: string[] = [];
    for (let i = 0; i < b.rest.length; i++) {
      const w = b.rest[i];
      const [flag, inline] = w.includes('=') ? [w.slice(0, w.indexOf('=')), w.slice(w.indexOf('=') + 1)] : [w, undefined];
      if (DEPLOY_TARGET.has(flag)) { const v = inline ?? b.rest[++i]; if (v === undefined) return null; targets.push(v); }
    }
    return targets.length > 0 && targets.every((v) => namesStagingValue(v, host)) ? 'outward' : null;
  }
  if (b.bin === 'cd' && b.rest.length === 1) return 'neutral';
  if (['npm', 'pnpm', 'yarn'].includes(b.bin)) {
    const [x, y, ...more] = b.rest;
    if (['ci', 'install', 'i'].includes(x ?? '') && y === undefined) return 'neutral';
    if (x === 'run' && y && NEUTRAL_SCRIPT_RE.test(y) && more.length === 0) return 'neutral';
    if (x && NEUTRAL_SCRIPT_RE.test(x) && y === undefined) return 'neutral';
  }
  return null;
}

/** His words with every merge said not to happen taken out. */
const withoutNegatedMerge = (s: string): string => s.replace(MERGE_NEG_RE, ' ');

export type GrantVerdict = { ok: true; merge?: OutwardMerge } | { ok: false; error: 'outward_out_of_scope'; message: string };

/** May a standing rule with these words grant this step (S2 for `rule`)? Pure. */
export function ruleCovers(step: string, ruleWords: string, stagingHost: string | null): GrantVerdict {
  const out = (why: string): GrantVerdict => ({ ok: false, error: 'outward_out_of_scope', message: `a standing rule allows only a staging push, PR or deploy: ${why}; anything else is his word in a message, or \`super ask\` him` });
  const rw = fold(ruleWords);
  if (!RULE_KIND_RE.test(rw)) return out('this rule\'s words name no push, PR, deploy or staging');
  // One clause must allow: a clause that forbids something else ("main'e asla") never cancels it.
  if (!rw.split(RULE_CLAUSE_SPLIT_RE).some((c) => RULE_KIND_RE.test(c) && !RULE_NEG_RE.test(c))) return out('this rule\'s words forbid, they do not allow');
  const f = fold(step.replace(QUOTED_RE, ' __q__ '));
  if (OUT_OF_SCOPE_RE.test(f) || PROD_TOKEN_RE.test(f) || neverStep(step)) return out('the step names production, live, a release, a publish, a merge, a force or the default branch');
  const host = stagingHost ? stagingHost.toLowerCase() : null;
  const kinds = pieces(step).map((t) => stagingPiece(t, host));
  if (kinds.includes(null) || !kinds.includes('outward')) return out('every command must be a staging push (`git push <remote> <branch>:staging`), a PR `--base staging`, a deploy whose target flag names staging, or a build/test');
  return { ok: true };
}

/** May his message with these words grant this step (S2 for `msg`, D13)? Pure. */
export function messageCovers(step: string, words: string | null): GrantVerdict {
  const out = (why: string): GrantVerdict => ({ ok: false, error: 'outward_out_of_scope', message: `${why}; the child never merges locally, never force-pushes and never pushes onto the default branch` });
  const f = fold(step);
  if (!MERGE_WORD_RE.test(withoutNegatedMerge(f))) {
    if (neverStep(step)) return out('the step forces, uses --admin or --auto, merges locally or pushes onto the default branch');
    return { ok: true };
  }
  const shape = MERGE_STEP_RE.exec(step.trim());
  if (!shape) return out('a merge is granted only as `gh pr merge <n> --squash|--merge|--rebase [--delete-branch]`');
  if (!words || !MERGE_VERB_RE.test(withoutNegatedMerge(fold(words)))) return out('his message does not name merging');
  return { ok: true, merge: { pr: Number(shape[1]), method: shape[2] as OutwardMerge['method'], ...(shape[3] ? { deleteBranch: true } : {}) } };
}
