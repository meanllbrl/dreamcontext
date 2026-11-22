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
/** Production or live as a token, a hyphenated name too (`acme-prod`, `--prod`), folded. */
const PROD_TOKEN_RE = /(?<![a-z0-9])(?:production|prod|live|canli\w*)(?![a-z0-9])/;
/** The default branch in any spelling a push destination takes. */
const DEFAULT_BRANCH_RE = /^(?:refs\/heads\/|heads\/|refs\/remotes\/[^/]+\/|origin\/)?(?:main|master)$/i;
/** Shell substitution, which runs a command inside any argument, even a double-quoted one; a
 *  backslash or a brace, which the shell rewrites (`ma\\in`, `{main,x}`). */
const SUBST_RE = /[`$\\{]|<\(|>\(/;
/** A git alias set on the line (`git -c alias.x=push x …`), which hides the real subcommand. */
const GIT_ALIAS_RE = /(?:^|\s)(?:-c\s*|--config-env[=\s]+)alias\./i;

// ─── Reading a step as commands, for the default-branch and local-merge checks ──────────────────

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

/** Every command piece of a step, as words. Quotes are removed, as the shell removes them, so
 *  `git push origin "main"` reads as the push onto main it is. */
function pieces(step: string): string[][] {
  return step.replace(/["']/g, '').split(CMD_SPLIT_RE)
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
 * (`gh pr create --base main` is no push). A piece that says "push" without a git command (prose,
 * `sh -c git push …`) counts when it names main or master in any spelling.
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
    if (/(?<![\w-])push\w*/.test(c) && !/\bgh\s+pr\b/.test(c) && /(?:^|[\s:(])(?:refs\/heads\/|origin\/)?(?:main|master)(?![\w/-])/.test(c)) return true;
  }
  return false;
}

/** Never in any grant: shell substitution or escapes, a git alias, a force (`-f` inside `-uf` too), --admin, --auto, a +refspec, a local merge, a push onto the default branch. */
function neverStep(step: string): boolean {
  if (SUBST_RE.test(step)) return true;
  if (NEVER_RE.test(fold(step.replace(/["']/g, '')))) return true;
  if (GIT_ALIAS_RE.test(step.replace(/["']/g, ''))) return true;
  if (pieces(step).some((t) => gitSub(t)?.sub === 'merge' || (gitPushOf(t)?.flags ?? []).some((f) => /^-[a-z]*f[a-z]*$/i.test(f)))) return true;
  return pushesDefault(step);
}

// ─── A rule grant: exact shapes only (owner, 22 Nov: "sabit kalıpla") ───────────────────────────

/** A name a shape may hold: letters, digits, `.`, `_`, `/`, `-`, never starting with `-`. */
const NAME = String.raw`[A-Za-z0-9._][A-Za-z0-9._/-]*`;
/** The commands a standing rule may grant, whole (plan iyilesme-360 D5, r3 owner pick): a staging
 *  push, a PR into staging, a deploy to a staging project or the ops card's staging site, and a
 *  build before it. No quotes, no substitution, no other flag: anything else is his message. */
const RULE_PUSH_RE = new RegExp(String.raw`^git push (?:-u |--set-upstream )?([A-Za-z][A-Za-z0-9_-]*) (${NAME}):(?:refs/heads/)?staging$`);
const RULE_PR_RE = new RegExp(String.raw`^gh pr create --base staging(?: --fill| --draft| --head ${NAME})*$`);
const RULE_DEPLOY_RE = /^(?:npx )?firebase deploy(?: --only [A-Za-z0-9,:_-]+)? (?:-P|--project) ([A-Za-z0-9-]+)(?: --only [A-Za-z0-9,:_-]+)?$/;
const RULE_CHANNEL_RE = /^(?:npx )?firebase hosting:channel:deploy [A-Za-z0-9_-]+ (?:--site|-s) ([A-Za-z0-9-]+)$/;
const RULE_NEUTRAL_RE = new RegExp(String.raw`^(?:(?:npm|pnpm|yarn) (?:ci|install|run (?:build|test|lint|typecheck)(?::[A-Za-z0-9_-]+)?)|cd ${NAME})$`);

type RuleKind = 'push' | 'pr' | 'deploy';

/** One command of a rule step: its kind, 'neutral', or null (not an allowed shape). */
function rulePiece(cmd: string, host: string | null): RuleKind | 'neutral' | null {
  if (RULE_PUSH_RE.test(cmd)) return 'push';
  if (RULE_PR_RE.test(cmd)) return 'pr';
  const d = RULE_DEPLOY_RE.exec(cmd) ?? RULE_CHANNEL_RE.exec(cmd);
  if (d) {
    const target = d[1].toLowerCase();
    return (host && target === host) || target.split('-').includes('staging') ? 'deploy' : null;
  }
  return RULE_NEUTRAL_RE.test(cmd) ? 'neutral' : null;
}

/** The words of each kind in his rule (folded). */
const KIND_WORDS: Record<RuleKind, RegExp> = {
  push: /(?<![a-z0-9])(?:push\w*|gonder\w*)/,
  pr: /(?<![a-z0-9])(?:pr|pull request)(?![a-z0-9])/,
  deploy: /(?<![a-z0-9])(?:deploy\w*|yayinla\w*)/,
};
/** A clause that forbids (folded): a "no/never/not" word, or a verb stem with its negative suffix
 *  whatever follows ("etmesin", "etmemelisin", "etmeyeceksin", "yapmasın", "açma", "push'lama",
 *  "yayınlamasın"). "etmeden" (before), "etmek" (to do) and "etmeli" (must) are no negative. */
const RULE_NEG_RE = /(?<![a-z0-9])(?:asla|hicbir|never|not|cannot|dont|do not|no|yasak\w*|olmaz|yok|degil\w*|dokunma\w*)(?![a-z0-9])|n't(?![a-z0-9])|(?<![a-z0-9])(?:et|yap|ac|at|ver|gonder|yayinla|push'?la|deploy'?la)m[ae](?!k|d[ae]n|li)/;
/** A clause that permits (folded): a may/can/free/yourself word, an "-ebilir" or "-meli" verb, or a
 *  bare imperative ("push et", "PR aç", "yayınla"). The kind's own noun is no permission. */
const RULE_POS_RE = /(?<![a-z0-9])(?:serbest\w*|izin\w*|kendin\w*|her zaman|always|can|may|allowed|yourself|go ahead|\w+[ae]bilir\w*|\w+m[ae]li\w*|et|at|ac|yap|gonder|yayinla|push'?la|deploy'?la)(?![a-z0-9])/;
/** Another target a forbidding clause may name instead of staging ("main'e asla push etme"). */
const OTHER_TARGET_RE = /(?<![a-z0-9])(?:main|master|canli\w*|prod\w*|production|live)/;
/** A rule's clauses. "ve"/"and" between two nouns ("staging ve main'e asla") is no boundary. */
const RULE_CLAUSE_SPLIT_RE = /[,.;!\n]|\s(?:ama|but|fakat|ancak|sonra|then|yalniz|sadece|only)\s/;

/**
 * May his rule's words grant this kind? Fail-safe (r4 redesign): one clause must name the kind, carry
 * a permitting word and no forbidding one; a clause with neither ("push etmeden önce testleri koş")
 * grants nothing. A clause that names the kind and forbids it cancels the grant unless it names
 * another target and not staging ("main'e asla push etme" leaves "staging'e push edebilirsin"
 * standing). Unsure is a refusal: the Super asks him on a card instead.
 */
function ruleAllowsKind(words: string, kind: RuleKind): boolean {
  const cs = words.replace(/[\u2018\u2019`]/g, "'").split(RULE_CLAUSE_SPLIT_RE);
  const names = (c: string) => KIND_WORDS[kind].test(c);
  const cancels = cs.some((c) => names(c) && RULE_NEG_RE.test(c) && (/staging/.test(c) || !OTHER_TARGET_RE.test(c)));
  return !cancels && cs.some((c) => names(c) && !RULE_NEG_RE.test(c) && RULE_POS_RE.test(c));
}

/** His words with every merge said not to happen taken out. */
const withoutNegatedMerge = (s: string): string => s.replace(MERGE_NEG_RE, ' ');

export type GrantVerdict = { ok: true; merge?: OutwardMerge } | { ok: false; error: 'outward_out_of_scope'; message: string };

/** May a standing rule with these words grant this step (S2 for `rule`)? Pure. */
export function ruleCovers(step: string, ruleWords: string, stagingHost: string | null): GrantVerdict {
  const out = (why: string): GrantVerdict => ({ ok: false, error: 'outward_out_of_scope', message: `a standing rule allows only a staging push, PR or deploy: ${why}; anything else is his word in a message, or \`super ask\` him` });
  const rw = fold(ruleWords);
  if (!RULE_KIND_RE.test(rw)) return out('this rule\'s words name no push, PR, deploy or staging');
  const f = fold(step);
  if (OUT_OF_SCOPE_RE.test(f) || PROD_TOKEN_RE.test(f) || neverStep(step)) return out('the step names production, live, a release, a publish, a merge, a force, the default branch or a shell substitution');
  const host = stagingHost ? stagingHost.toLowerCase() : null;
  const kinds = step.trim().split(/ && /).map((c) => rulePiece(c.trim(), host));
  const used = kinds.filter((k): k is RuleKind => k !== 'neutral' && k !== null);
  if (kinds.includes(null) || used.length === 0) return out('a rule grants only these exact commands, joined by ` && `: `git push [-u] <remote> <branch>:staging`, `gh pr create --base staging [--fill] [--draft]`, `firebase deploy [--only <x>] -P <staging project>`, a build');
  const forbidden = [...new Set(used)].find((k) => !ruleAllowsKind(rw, k));
  if (forbidden) return out(`this rule's words do not allow a ${forbidden === 'pr' ? 'PR' : forbidden} (or forbid it)`);
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
