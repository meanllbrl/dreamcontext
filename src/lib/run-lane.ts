import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

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
}

export interface LanePick {
  lane: 'light' | 'full';
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

export function pickLane(files: readonly ChangedFile[]): LanePick {
  const lines = files.filter((f) => !GENERATED_PATH.test(f.path)).reduce((n, f) => n + f.lines, 0);
  // Nothing changed yet is no verdict: a reproduction on a clean branch still needs its browser.
  const visible = files.length === 0 || files.some((f) => isVisiblePath(f.path));
  const customScripts = files.filter((f) => f.added && VERIFY_SCRIPT.test(f.path)).map((f) => f.path);
  const base = { lines, visible, customScripts };
  for (const f of files) {
    const why = f.cleared ? null : guardedReason(f.path);
    if (why) return { ...base, lane: 'full', reason: `${why} path: ${f.path}` };
  }
  if (lines >= LIGHT_LANE_MAX_LINES) return { ...base, lane: 'full', reason: `${lines} lines (light is under ${LIGHT_LANE_MAX_LINES})` };
  return { ...base, lane: 'light', reason: `${lines} lines, no guarded path` };
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
  for (const f of files) {
    if (addedNames.has(f.path)) f.added = true;
    if (f.path === PHONE_POLICY_PATH) f.cleared = onlyAddsDenyRows(git(cwd, ['diff', '-U0', '--no-color', '--no-renames', ...range, '--', f.path]));
  }
  if (!to) {
    for (const path of git(cwd, ['ls-files', '-z', '--others', '--exclude-standard']).split('\0').filter(Boolean)) {
      files.push({ path, lines: lineCount(join(cwd, path)), added: true });
    }
  }
  return files;
}

/** The lane of the change git sees here; full, with the reason, when git cannot tell. */
export function laneFromGit(cwd: string, from?: string, to?: string): LanePick {
  try {
    return pickLane(changedFiles(cwd, from, to));
  } catch (err) {
    const why = err instanceof Error ? err.message.split('\n')[0] : String(err);
    return { lane: 'full', reason: `the diff could not be read (${why})`, lines: 0, visible: true, customScripts: [] };
  }
}
