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
export const OUT_OF_SCOPE_RE = /(?<![\w-])(?:production|prod|--prod|live|canli|release|publish|npm publish|gh release|merge|gh pr merge|force|--force(?:-with-lease)?|-f|--admin|--auto)(?![\w-])|(?:^|\s)\+[\w./:-]+/;
/** Never in any grant: force, --admin, --auto, a local merge, a push onto the default branch. */
const NEVER_RE = /(?<![\w-])(?:--force(?:-with-lease)?|-f|--admin|--auto|git\s+merge)(?![\w-])|(?:^|\s)\+[\w./:-]+|\bpush\b[^\n]*?(?:\s|:)(?:main|master)\s*$|\bpush\b[^\n]*?:(?:main|master)(?![\w/-])/;
/** A merge word in a step. */
const MERGE_WORD_RE = /(?<![\w-])merge(?![\w-])/;
/** His words name merging (D13, folded). */
const MERGE_VERB_RE = /(?<![a-z0-9])(?:birlestir\w*|merge\w*|mergele\w*)(?![a-z0-9])/;

/**
 * S2 (b): the step names staging, the ops card's staging host, or a PR into staging.
 */
function namesStaging(step: string, stagingHost: string | null): boolean {
  const s = step.toLowerCase();
  if (/(?<![\w-])staging(?![\w-])/.test(s)) return true;
  if (stagingHost && s.includes(stagingHost.toLowerCase())) return true;
  return /gh pr create\b[^\n]*--base[ =]staging(?![\w-])/.test(s);
}

export type GrantVerdict = { ok: true; merge?: OutwardMerge } | { ok: false; error: 'outward_out_of_scope'; message: string };

/** May a standing rule with these words grant this step (S2 for `rule`)? Pure. */
export function ruleCovers(step: string, ruleWords: string, stagingHost: string | null): GrantVerdict {
  const out = (why: string): GrantVerdict => ({ ok: false, error: 'outward_out_of_scope', message: `a standing rule allows only a staging push, PR or deploy: ${why}; anything else is his word in a message, or \`super ask\` him` });
  if (!RULE_KIND_RE.test(fold(ruleWords))) return out('this rule\'s words name no push, PR, deploy or staging');
  const f = fold(step);
  if (OUT_OF_SCOPE_RE.test(f) || NEVER_RE.test(f)) return out('the step names production, live, a release, a publish, a merge or a force');
  if (!namesStaging(step, stagingHost)) return out('the step does not name staging (or the ops card\'s staging host, or a PR into staging)');
  return { ok: true };
}

/** May his message with these words grant this step (S2 for `msg`, D13)? Pure. */
export function messageCovers(step: string, words: string | null): GrantVerdict {
  const out = (why: string): GrantVerdict => ({ ok: false, error: 'outward_out_of_scope', message: `${why}; the child never merges locally, never force-pushes and never pushes onto the default branch` });
  const f = fold(step);
  if (!MERGE_WORD_RE.test(f)) {
    if (NEVER_RE.test(f)) return out('the step forces, uses --admin or --auto, merges locally or pushes onto the default branch');
    return { ok: true };
  }
  const shape = MERGE_STEP_RE.exec(step.trim());
  if (!shape) return out('a merge is granted only as `gh pr merge <n> --squash|--merge|--rebase [--delete-branch]`');
  if (!words || !MERGE_VERB_RE.test(fold(words))) return out('his message does not name merging');
  return { ok: true, merge: { pr: Number(shape[1]), method: shape[2] as OutwardMerge['method'], ...(shape[3] ? { deleteBranch: true } : {}) } };
}
