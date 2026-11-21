import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { foldAscii } from './fold-ascii.js';

/**
 * Which process a change gets: `dreamcontext builder lane`. Measured 2026-10-31 over 20 Develop
 * sessions: work under 400 lines ran at 7 lines a minute, larger work at 23, so the ceremony
 * lands on the small jobs. A light change gets one reviewer without the router, a browser only
 * when something visible changed, and no script of its own.
 *
 * This reads the diff itself, so a lead cannot talk a change into the light lane. Anything it
 * cannot read goes to the full lane.
 *
 * THE thresholds live here and nowhere else; the recipe and the docs name the command.
 * tests/unit/run-lane.test.ts pins every branch.
 */
export const LIGHT_LANE_MAX_LINES = 300;

/** A fast change is at most this many changed lines (generated files aside). */
export const FAST_LANE_MAX_LINES = 150;

/** The last line of a fast child's last reply, the owner's way to ask for the whole chain. */
export const FAST_DONE_LINE = "Hızlı modda doğrulandı (kısa okuma, tek ekran görüntüsü). Tam doğrulama için 'tam doğrula' yaz.";

/** Regenerated, never written: they say nothing about the size of a change. */
const GENERATED_PATH = /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|cli-manifest\.json)$|\.snap$/;

/** How a guarded family is named: whole words, and word starts that have no innocent reading. */
interface Guard { why: string; words: readonly string[]; starts: readonly string[]; path?: RegExp }

/**
 * Paths that never take the light lane, whatever their size: security, money, data migration and
 * permissions, including `.env` and this repo's own owner and origin gates. An endpoint is NOT one
 * of them by name (2026-10-31, the owner): a small change with a new server route, closed on the
 * phone, stays light and its one reviewer reads the security too. The routes at a trust boundary
 * (the Mac itself, a terminal, another project) stay guarded by file. Matched on the path's WORDS, camelCase split, so `requireAuth.ts` and `auth/` are
 * one word `auth` and `author.ts` is another. A false hit costs one fuller review; a miss would
 * cost the review that catches it, so the list leans wide. Paths only: a dangerous line in an
 * innocently named file is the reviewer's to catch.
 */
const GUARDS: readonly Guard[] = [
  {
    why: 'security',
    words: ['auth', 'authn', 'authz', 'login', 'logout', 'signin', 'signup', 'session', 'sessions', 'token', 'tokens', 'password', 'passwords', 'jwt', 'cookie', 'cookies', 'iam', 'acl', 'cors', 'security', 'sandbox', 'tunnel', 'loopback', 'owner', 'origin', 'guard', 'guards', 'gate', 'gates', 'webhook', 'webhooks', 'hmac', 'policy', 'policies', 'admin', 'keychain', 'env', 'middleware', 'mfa', 'otp', 'totp', 'sso', 'saml', 'oidc', 'key', 'keys', 'apikey', 'apikeys', 'pem', 'signature'],
    starts: ['authent', 'authoriz', 'oauth', 'secret', 'credential', 'crypto', 'encrypt', 'decrypt', 'csrf', 'saniti', 'askpass', 'signing'],
    path: /\.(?:pem|key|p12|pfx)$|(?:^|\/)(?:id_rsa|\.npmrc|\.envrc)$|^src\/server\/routes\/(?:handsfree[\w-]*|agent-terminal|agent-chat|agent-drop|vaults|connections|super-remote|peer|federation)\.ts$|^src\/lib\/handsfree\/mac\/contract\.ts$|^dashboard\/src\/lib\/phoneSurface\.ts$/i,
  },
  {
    why: 'money',
    words: ['pay', 'price', 'prices', 'pricing', 'purchase', 'purchases', 'receipt', 'receipts', 'coupon', 'coupons', 'ledger', 'revenuecat', 'entitlement', 'entitlements'],
    starts: ['payment', 'payout', 'payrail', 'paywall', 'billing', 'stripe', 'paddle', 'checkout', 'invoice', 'refund', 'subscri'],
  },
  {
    why: 'data migration',
    words: ['schema', 'schemas', 'alembic', 'backfill', 'upgrade'],
    starts: ['migrat'],
    path: /\.sql$/i,
  },
  {
    why: 'permissions',
    words: ['role', 'roles', 'rbac'],
    starts: ['permission', 'consent', 'approval', 'allowlist', 'denylist'],
    // What an agent obeys, and these gates themselves, are permissions too.
    path: /\.rules$|(?:^|\/)\.claude\/|(?:^|\/)\.github\/workflows\/|(?:^|\/)CLAUDE\.md$|(?:^|\/)skill(?:s|-[\w-]+)?\/|^agents\/|^src\/lib\/(?:run-(?:lane|budget|ledger)|heavy-(?:queue|acquire)|review-route|builder-tools)\.ts$|^src\/cli\/commands\/builder(?:-sessions)?\.ts$|^src\/cli\/commands\/hook\.ts$/i,
  },
];

/**
 * The path's words, read both ways so an acronym split can only add hits: `JWTVerifier` gives
 * jwt, and `OAuth2Client` keeps oauth2. Trailing digits go (`auth0`), and each pair of neighbours
 * is a word too, because camelCase breaks `signIn` and `allowList` apart.
 */
function pathWords(path: string): string[] {
  const split = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map((w) => w.replace(/\d+$/, ''));
  const camel = path.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  const words = split(camel.replace(/([A-Z])([A-Z][a-z])/g, '$1 $2'));
  return [...split(camel), ...words, ...words.slice(1).map((w, i) => `${words[i]}${w}`)];
}

/** What a user sees: a browser check earns its minutes only when one of these changed. */
const VISIBLE_PATH = /\.(?:tsx|jsx|vue|svelte|css|scss|html)$|(?:^|\/)(?:dashboard|desktop|web|public)\/(?!.*\.test\.)/;

/** A browser script a change added for itself (15% of all changed lines, measured). */
const VERIFY_SCRIPT = /(?:^|\/)scripts\/verify\/[^/]+\.m?[jt]s$/;

/**
 * Every registered route must have a row here (`tests/unit/route-policy.test.ts`), so a new route
 * always touches this file. Rows that only add `deny(...)` keep the route off the phone, the
 * case that stays light; anything else in this file is a security change.
 */
export const PHONE_POLICY_PATH = 'src/lib/handsfree/mac/route-policy.ts';

/** One row, one deny, nothing after it: a named reason or a plain string, and the cross-project scope. */
const DENY_ROW = /^\+\s*'(?:GET|POST|PUT|PATCH|DELETE) \/api\/[^']*':\s*deny\((?:[A-Z_]+|'(?:[^'\\]|\\.)*')(?:,\s*'cross:deny')?\),\s*$/;

/** Does this `git diff -U0` only ADD one-line deny rows? Anything else reads as no. */
export function onlyAddsDenyRows(diff: string): boolean {
  const hunks = diff.search(/^@@/m);
  if (hunks < 0) return false;
  const body = diff.slice(hunks).split('\n').filter((l) => /^[+-]/.test(l));
  return body.length > 0 && body.every((l) => DENY_ROW.test(l));
}

export interface ChangedFile {
  path: string;
  /** Added plus deleted lines; 0 for a binary. */
  lines: number;
  /** True when the file did not exist at the base. */
  added?: boolean;
  /** The guard on this path does not apply: see {@link PHONE_POLICY_PATH}. */
  cleared?: boolean;
  /** True when the change deletes the file. */
  deleted?: boolean;
  /**
   * Read only for a fast check ({@link readFastInputs}): the text after the change (null = could
   * not be read), its changed lines, and for a JSON file the text before it.
   */
  after?: string | null;
  plus?: string[];
  minus?: string[];
  before?: string | null;
}

export interface LanePick {
  lane: 'fast' | 'light' | 'full';
  reason: string;
  lines: number;
  /** A browser check is due: a visible file changed. */
  visible: boolean;
  /** Verify scripts this change added, which a light change must not. */
  customScripts: string[];
}

/** Why this path keeps a change out of the light lane, or null. */
export function guardedReason(path: string): string | null {
  // Pixels only: design tokens cannot leak a thing. Markdown stays in: an agent's or a skill's
  // .md is what it obeys.
  if (/\.(?:css|scss|svg|png|jpe?g)$/.test(path)) return null;
  const words = pathWords(path);
  const hit = GUARDS.find((g) => g.path?.test(path) || words.some((w) => g.words.includes(w) || g.starts.some((s) => w.startsWith(s))));
  return hit?.why ?? null;
}

export function isVisiblePath(path: string): boolean {
  return !/(?:^|\/)tests?\//.test(path) && VISIBLE_PATH.test(path);
}

/**
 * The lane of a change. `intent` is the worktree's recorded intent (lane-intent.ts), never a flag:
 * `full` keeps the change full whatever its diff; `fast` opens the fast lane only when
 * {@link fastRefusal} finds nothing, and otherwise the change takes light or full as before, with
 * why fast was refused.
 */
export function pickLane(files: readonly ChangedFile[], intent?: 'fast' | 'full' | null): LanePick {
  const lines = files.filter((f) => !GENERATED_PATH.test(f.path)).reduce((n, f) => n + f.lines, 0);
  // Nothing changed yet is no verdict: a reproduction on a clean branch still needs its browser.
  const visible = files.length === 0 || files.some((f) => isVisiblePath(f.path));
  const customScripts = files.filter((f) => f.added && VERIFY_SCRIPT.test(f.path)).map((f) => f.path);
  const base = { lines, visible, customScripts };
  if (intent === 'full') return { ...base, lane: 'full', reason: 'full verification was asked for this worktree (tam doğrula)' };
  const fastNo = intent === 'fast' ? fastRefusal(files) : null;
  if (intent === 'fast' && fastNo === null) {
    // What fast calls visible: the presentation set, text JSON, SVG and images included, a .md not.
    const seen = files.length === 0 || files.some((f) => !/\.md$/i.test(f.path));
    return { lines, visible: seen, customScripts, lane: 'fast', reason: `${lines} lines, look and copy only` };
  }
  const pre = fastNo ? `fast refused (${fastNo}); ` : '';
  for (const f of files) {
    const why = f.cleared ? null : guardedReason(f.path);
    if (why) return { ...base, lane: 'full', reason: `${pre}${why} path: ${f.path}` };
  }
  if (lines >= LIGHT_LANE_MAX_LINES) return { ...base, lane: 'full', reason: `${pre}${lines} lines (light is under ${LIGHT_LANE_MAX_LINES})` };
  return { ...base, lane: 'light', reason: `${pre}${lines} lines, no guarded path` };
}

// ─── the fast gate (plan sirket-yavaslik D1, contract C1) ──────────────────────────────────
//
// Fast is for a change that only alters how one screen looks or reads. Every family below lives
// here and nowhere else; the recipe and the docs name the command. Money never takes fast, in
// English or Turkish, shown, hidden or changed: a false hit costs the light lane, a miss costs a
// paywall shipped on a short read (the owner's rule). A false positive (`deneme`, `iptal`, `%20`)
// is the accepted price.

/** Pixels: no text to read. Everything else is read as text. */
const BINARY_IMAGE = /\.(?:png|jpe?g|webp)$/i;
/** What only draws or reads: styles, images, markup, copy files, plain docs. */
const PRESENTATION = /\.(?:css|scss|svg|png|jpe?g|webp|tsx|jsx|vue|svelte|html)$/i;
const COPY_JSON = /(?:^|\/)(?:locales?|i18n|messages|copy|content|strings)\/(?:.*\/)?[^/]+\.json$/i;
/** A .md an agent obeys is an instruction, never copy. */
const INSTRUCTION_MD = /(?:^|\/)(?:AGENTS|GEMINI|CLAUDE)\.md$|(?:^|\/)(?:_dream_context|\.codex|\.agents|\.cursor|\.claude)\//i;
/** The only kind of file a fast change may add. */
const ADDED_OK = /\.(?:png|jpe?g|webp|svg)$/i;

/** Money, searched in the whole text after the change, in its deleted lines and in JSON key paths. */
export const FAST_MONEY: readonly RegExp[] = [
  /price|amount|currency|cents|stripe|paddle|payrail|checkout|paywall|subscri|trial|renew|cancel|coupon|discount|upsell|refund|invoice|billing|purchase|revenuecat|entitlement|receipt|\bplans?\./i,
  // Turkish bodies, searched on the ASCII-folded text, so `ödeme` and `odeme` are one word.
  /fiyat|ucret|odeme|abonelik|deneme|yenilen|iptal|indirim|kupon|iade|fatura|satin/i,
  // A shown amount.
  /[₺$€£]\s?\d|\d[.,]\d{2}\s?(?:₺|tl|usd|eur)|\b(?:tl|usd|eur)\b|%\d+/i,
  // Who sees which price.
  /experiment|ab_?test|getvariant|variantid|assignvariant|useexperiment/i,
];
/** Behaviour and measurement, searched in changed lines only: a screen's own effect it did not touch stays. */
export const FAST_LOGIC = /fetch\(|axios|useeffect|usestate|localstorage|cookie|redirect|navigate\(|router\.|location\.|window\.open|=>|\bif\b|\bawait\b|track\(|gtag|fbq|pixel|analytics|posthog|amplitude|mixpanel/i;
/** Ways out of the page, searched in changed lines (an SVG's whole text): markup that runs or loads. */
export const FAST_SINK = /dangerouslysetinnerhtml|innerhtml|outerhtml|v-html|\{@html|<script|<iframe|<object|<embed|javascript:|http-equiv|\bon[a-z]+\s*=|\beval\(|new function|\bimport\b|require\(|(?:\b(?:src|href|action|srcset)\s*=\s*["'{]?\s*|url\(\s*["']?)(?:https?:)?\/\//i;
const URL_VALUE = /^\s*(?:(?:https?:)?\/\/|[a-z][a-z0-9+.-]*:(?!\s))/i;

function moneyIn(text: string): string | null {
  const folded = foldAscii(text);
  for (const re of FAST_MONEY) {
    const m = re.exec(folded);
    if (m) return m[0];
  }
  return null;
}

/** Every leaf of a JSON value, by its full dotted key path. */
function leaves(v: unknown, path: string, out: Map<string, unknown>): Map<string, unknown> {
  if (v && typeof v === 'object') {
    const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v as Record<string, unknown>);
    if (entries.length === 0) out.set(path, Array.isArray(v) ? '[]' : '{}');
    for (const [k, x] of entries) leaves(x, path ? `${path}.${k}` : k, out);
  } else {
    out.set(path, v);
  }
  return out;
}

/** The leaves a JSON change touched (added, removed or changed), or null when either side is no JSON. */
function changedLeaves(before: string, after: string): [string, unknown][] | null {
  let a: unknown;
  let b: unknown;
  try { a = JSON.parse(before); b = JSON.parse(after); } catch { return null; }
  const was = leaves(a, '', new Map());
  const now = leaves(b, '', new Map());
  const out: [string, unknown][] = [];
  for (const [k, v] of now) if (!was.has(k) || was.get(k) !== v) out.push([k, v]);
  for (const [k, v] of was) if (!now.has(k)) out.push([k, v]);
  return out;
}

/** Why this file keeps a change out of the fast lane, or null. */
function fastFileRefusal(f: ChangedFile): string | null {
  const p = f.path;
  // Every guard applies, pixels included: `Paywall.module.css` is no fast change.
  const words = pathWords(p);
  const guard = GUARDS.find((g) => g.path?.test(p) || words.some((w) => g.words.includes(w) || g.starts.some((s) => w.startsWith(s))));
  if (guard) return `${guard.why} path: ${p}`;
  if (f.deleted) return `deletes ${p}`;
  const md = /\.md$/i.test(p);
  if (!(PRESENTATION.test(p) || COPY_JSON.test(p) || (md && !INSTRUCTION_MD.test(p)))) return `not a look or copy file: ${p}`;
  if (f.added && !ADDED_OK.test(p)) return `adds ${p} (fast adds images only)`;
  if (BINARY_IMAGE.test(p)) return null;
  if (typeof f.after !== 'string' || !f.plus || !f.minus) return `could not read ${p}`;
  const money = moneyIn(f.after) ?? moneyIn(f.minus.join('\n'));
  if (money) return `money: ${money} in ${p}`;
  const changed = [...f.plus, ...f.minus].join('\n');
  const logic = FAST_LOGIC.exec(changed);
  if (logic) return `logic: ${logic[0]} in ${p}`;
  const sink = FAST_SINK.exec(/\.svg$/i.test(p) ? `${f.after}\n${f.minus.join('\n')}` : changed);
  if (sink) return `sink: ${sink[0]} in ${p}`;
  if (/\.json$/i.test(p)) {
    if (typeof f.before !== 'string') return `could not read ${p} before the change`;
    const touched = changedLeaves(f.before, f.after);
    if (!touched) return `not valid JSON: ${p}`;
    for (const [key, value] of touched) {
      const inKey = moneyIn(key);
      if (inKey) return `money: ${inKey} in the key ${key} of ${p}`;
      if (typeof value === 'string') {
        if (URL_VALUE.test(value)) return `a URL value at ${key} in ${p}`;
        // The decoded value: `\u003cscript` is a script tag once it is rendered.
        const s = FAST_SINK.exec(value);
        if (s) return `sink: ${s[0]} at ${key} in ${p}`;
      }
    }
  }
  return null;
}

/**
 * Why this change may not take the fast lane, or null when it may: at most
 * {@link FAST_LANE_MAX_LINES} lines, and every file passes {@link fastFileRefusal}. Anything
 * unread is a refusal.
 */
export function fastRefusal(files: readonly ChangedFile[]): string | null {
  const lines = files.filter((f) => !GENERATED_PATH.test(f.path)).reduce((n, f) => n + f.lines, 0);
  if (lines > FAST_LANE_MAX_LINES) return `${lines} lines (fast is at most ${FAST_LANE_MAX_LINES})`;
  for (const f of files) {
    const why = fastFileRefusal(f);
    if (why) return why;
  }
  return null;
}

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });

function tryGit(cwd: string, args: string[]): string | null {
  try { return git(cwd, args).trim(); } catch { return null; }
}

/** Where this branch left the default branch; on the default branch itself, HEAD. */
function defaultBase(cwd: string): string {
  const remoteHead = tryGit(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  for (const ref of [remoteHead, 'main', 'master']) {
    if (!ref) continue;
    const base = tryGit(cwd, ['merge-base', 'HEAD', ref]);
    if (base) return base;
  }
  return 'HEAD';
}

/** `git diff -z --numstat --no-renames` records: `added\tdeleted\tpath\0`. */
export function parseNumstat(out: string): ChangedFile[] {
  return out.split('\0').filter(Boolean).map((rec) => {
    const [add, del, ...rest] = rec.split('\t');
    return { path: rest.join('\t'), lines: (Number(add) || 0) + (Number(del) || 0) };
  });
}

function lineCount(path: string): number {
  try {
    if (statSync(path).size > 2_000_000) return LIGHT_LANE_MAX_LINES;
    return readFileSync(path, 'utf-8').split('\n').length;
  } catch {
    return 0;
  }
}

/**
 * The changed files between two trees, or from the branch's base to the working tree (untracked
 * files included: they are most of a young run). Throws when git cannot tell.
 */
export function changedFiles(cwd: string, from?: string, to?: string): ChangedFile[] {
  const base = from ?? defaultBase(cwd);
  const range = to ? [base, to] : [base];
  const files = parseNumstat(git(cwd, ['diff', '-z', '--numstat', '--no-renames', ...range]));
  const addedNames = new Set(git(cwd, ['diff', '-z', '--name-only', '--no-renames', '--diff-filter=A', ...range]).split('\0').filter(Boolean));
  const deletedNames = new Set(git(cwd, ['diff', '-z', '--name-only', '--no-renames', '--diff-filter=D', ...range]).split('\0').filter(Boolean));
  for (const f of files) {
    if (addedNames.has(f.path)) f.added = true;
    if (deletedNames.has(f.path)) f.deleted = true;
    if (f.path === PHONE_POLICY_PATH) f.cleared = onlyAddsDenyRows(git(cwd, ['diff', '-U0', '--no-color', '--no-renames', ...range, '--', f.path]));
  }
  if (!to) {
    for (const path of git(cwd, ['ls-files', '-z', '--others', '--exclude-standard']).split('\0').filter(Boolean)) {
      files.push({ path, lines: lineCount(join(cwd, path)), added: true });
    }
  }
  return files;
}

const MAX_FAST_FILE_BYTES = 512 * 1024;

/** A working-tree file's text: a plain file only, never through a symlink; null when it cannot be read. */
function workingText(cwd: string, path: string): string | null {
  try {
    const st = lstatSync(join(cwd, path));
    if (!st.isFile() || st.size > MAX_FAST_FILE_BYTES) return null;
    return readFileSync(join(cwd, path), 'utf-8');
  } catch {
    return null;
  }
}

/** A blob's text at `<tree>:<path>`, untrimmed; null when git cannot show it. */
function showText(cwd: string, spec: string): string | null {
  try { return git(cwd, ['show', spec]); } catch { return null; }
}

/** `git diff -U0` body lines, split into what was added and what was deleted. */
export function changedLines(diff: string): { plus: string[]; minus: string[] } {
  const plus: string[] = [];
  const minus: string[] = [];
  const at = diff.search(/^@@/m);
  if (at < 0) return { plus, minus };
  for (const l of diff.slice(at).split('\n')) {
    if (l.startsWith('+')) plus.push(l.slice(1));
    else if (l.startsWith('-')) minus.push(l.slice(1));
  }
  return { plus, minus };
}

/**
 * Fill in what the fast gate reads: each text file's content after the change, its changed lines,
 * and a JSON file's content before. Unread fields stay unset, which the gate reads as a refusal.
 * Only called when fast is asked and the size allows it.
 */
export function readFastInputs(cwd: string, files: ChangedFile[], from: string, to?: string): void {
  const range = to ? [from, to] : [from];
  for (const f of files) {
    if (f.deleted || BINARY_IMAGE.test(f.path)) continue;
    f.after = to ? showText(cwd, `${to}:${f.path}`) : workingText(cwd, f.path);
    if (f.added && !to && f.after !== null && !tryGit(cwd, ['ls-files', '--', f.path])) {
      f.plus = f.after.split('\n');
      f.minus = [];
    } else {
      try { Object.assign(f, changedLines(git(cwd, ['diff', '-U0', '--no-color', '--no-renames', ...range, '--', f.path]))); } catch { /* unread: refused */ }
    }
    if (/\.json$/i.test(f.path)) f.before = showText(cwd, `${from}:${f.path}`);
  }
}

/**
 * The lane of the change git sees here; full, with the reason, when git cannot tell. `intent` is
 * the worktree's recorded one (lane-intent.ts laneIntentAt); callers pass its `base` as `from`.
 */
export function laneFromGit(cwd: string, from?: string, to?: string, intent?: 'fast' | 'full' | null): LanePick {
  try {
    const files = changedFiles(cwd, from, to);
    // Contents are read only when fast is asked and the size could still allow it.
    if (intent === 'fast' && files.reduce((n, f) => n + (GENERATED_PATH.test(f.path) ? 0 : f.lines), 0) <= FAST_LANE_MAX_LINES) {
      readFastInputs(cwd, files, from ?? defaultBase(cwd), to);
    }
    return pickLane(files, intent);
  } catch (err) {
    const why = err instanceof Error ? err.message.split('\n')[0] : String(err);
    return { lane: 'full', reason: `the diff could not be read (${why})`, lines: 0, visible: true, customScripts: [] };
  }
}
