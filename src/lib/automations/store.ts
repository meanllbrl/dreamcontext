import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, normalize, resolve, sep } from 'node:path';
import fg from 'fast-glob';
import { readFrontmatter, writeFrontmatter, updateFrontmatterFields } from '../frontmatter.js';
import { generateId } from '../id.js';
import { ensureGitignoreEntries } from '../gitignore.js';
import { parseSchedule } from './schedule.js';
import {
  AutomationError,
  AUTOMATIONS_GITIGNORE_ENTRIES,
  AUTOMATIONS_GITIGNORE_ENTRIES_ROOT,
  DEFAULT_CATCHUP_HOURS,
  DEFAULT_TIMEOUT_MINUTES,
  EFFORT_LEVELS,
  HISTORY_LIMIT,
  MAX_CATCHUP_HOURS,
  MAX_TIMEOUT_MINUTES,
  negationIsEffective,
  RESERVED_SLUGS,
  sharedSlugNegations,
  type AutomationCache,
  type AutomationManifest,
  type EffortLevel,
  type RunEvent,
  type RunSidecar,
  type Weekday,
} from './types.js';

/**
 * Automations store — mirrors `src/lib/lab/store.ts`. Manifests are FLAT at
 * `automations/<slug>.md` (unlike Lab's nested `insights/`), cache at
 * `automations/cache/<slug>.json`, output at `automations/output/<slug>/`.
 * Reads are LENIENT (a malformed sub-block degrades rather than throwing);
 * writes are STRICT (throw `AutomationError`). Cache and sidecar writes are
 * atomic (temp file + `renameSync`).
 */

// ─── Paths ────────────────────────────────────────────────────────────────────

export function automationsDir(contextRoot: string): string {
  return join(contextRoot, 'automations');
}
export function automationCacheDir(contextRoot: string): string {
  return join(automationsDir(contextRoot), 'cache');
}
export function outputRootDir(contextRoot: string): string {
  return join(automationsDir(contextRoot), 'output');
}
export function automationPath(contextRoot: string, slug: string): string {
  return join(automationsDir(contextRoot), `${slug}.md`);
}
export function automationCachePath(contextRoot: string, slug: string): string {
  return join(automationCacheDir(contextRoot), `${slug}.json`);
}
/** Per-slug run lock (owned/acquired by `file-lock.ts`, not this module). */
export function lockPathFor(contextRoot: string, slug: string): string {
  return join(automationCacheDir(contextRoot), `.${slug}.lock`);
}
/** Machine-local in-flight-child record — never brain-synced. */
export function sidecarPathFor(contextRoot: string, slug: string): string {
  return join(automationCacheDir(contextRoot), `.${slug}.run.json`);
}

/** Kebab-case, path-safe automation slug (lab's rule, plus the reserved
 *  sibling-directory names `cache`/`output` — manifests are flat, so a slug
 *  shares a namespace with those directories). */
export function isSafeAutomationSlug(slug: string): boolean {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) return false;
  if (slug.includes('--')) return false;
  if (slug.endsWith('-')) return false;
  if ((RESERVED_SLUGS as readonly string[]).includes(slug)) return false;
  return true;
}

// ─── Internal lenient-parse helpers ─────────────────────────────────────────

function strOrNull(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' || s === 'null' ? null : s;
}

/** Lenient: anything not exactly one of `EFFORT_LEVELS` — missing, `null`,
 *  wrong type, or an unrecognized string — reads as `null`. The fail-safe
 *  direction is "omit `--effort` and let `claude` pick its own default",
 *  never "guess a level"; strict rejection of a bad value lives only in
 *  `validateAutomationForWrite`, the write-time path. */
export function parseEffort(v: unknown): EffortLevel | null {
  return typeof v === 'string' && (EFFORT_LEVELS as readonly string[]).includes(v) ? (v as EffortLevel) : null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(n), min), max);
}

/** Missing/non-finite/non-positive ⇒ `def`; otherwise clamped to [min, max]. */
function numberOrDefault(v: unknown, def: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return def;
  return clamp(n, min, max);
}

/** `true` for a plain, positive, integer PID/PGID strictly greater than 1 —
 *  1 negated is -1 (`process.kill(-1, …)` broadcasts to every process the
 *  caller may signal), and a missing/`null`/non-integer/non-finite value must
 *  never reach a negative-PID kill call. See `readRunSidecar`. */
function isSafeSignalTarget(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 1;
}

/** Looser check for a field that must be a real, finite number but carries no
 *  kill-target semantics (`childPid` — recorded for diagnostics only; the
 *  group is always signalled via `childPgid`). */
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Extract a `## <heading>` section's body text. Missing heading ⇒ `''`. */
export function extractSection(body: string, heading: string): string {
  const lines = body.split('\n');
  const target = `## ${heading}`.trim();
  const startIdx = lines.findIndex((l) => l.trim() === target);
  if (startIdx === -1) return '';
  const rest = lines.slice(startIdx + 1);
  const endIdx = rest.findIndex((l) => /^##\s/.test(l));
  const section = endIdx === -1 ? rest : rest.slice(0, endIdx);
  return section.join('\n').trim();
}

// ─── Output-directory containment ───────────────────────────────────────────

/**
 * Containment check mirroring `src/server/routes/graph.ts:45-47`, WITHOUT
 * that route's `|| abs === absRoot` allowance: an automation must write into
 * a STRICT SUBDIRECTORY of the brain, never the brain root itself (where it
 * would collide with `core/`, `state/`, `lab/`). Pure path arithmetic — no
 * I/O — so it never depends on `contextRoot` existing on disk.
 *
 * `raw === null` ⇒ the default `automations/output/<slug>/`. A non-null
 * `raw` that resolves outside `contextRoot` throws `AutomationError`; this is
 * the STRICT write-time enforcement path (called from `createAutomation`).
 */
export function resolveOutputDir(contextRoot: string, raw: string | null, slug: string): string {
  if (raw === null) return join(outputRootDir(contextRoot), slug);
  const absRoot = resolve(contextRoot);
  const abs = resolve(absRoot, normalize(raw));
  if (!abs.startsWith(absRoot + sep)) {
    throw new AutomationError(`output.dir escapes the brain: "${raw}"`);
  }
  return abs;
}

/** Fixed, non-interpolated degrade reason — see `outputDirFor`. Exported as a
 *  plain module constant only for this file's own reuse; not part of the
 *  public store contract. */
const OUTPUT_DIR_DEGRADE_REASON =
  'output.dir rejected at run time (escapes the brain) — wrote to the default location';

/**
 * Run-time resolution with defence in depth. `outputDir` is an
 * approval-hashed field, so an approved value is trusted forever — a
 * manifest that was hand-tampered after approval (or somehow got approved
 * with an escaping value) must still degrade to the default rather than
 * writing outside the brain. The reason string is a FIXED constant — it must
 * NEVER interpolate the raw or resolved path, because it lands in
 * `RunEvent.error`, a brain-synced record; leaking local directory structure
 * is the defect this prevents.
 */
export function outputDirFor(
  contextRoot: string,
  m: AutomationManifest,
): { dir: string; degradeReason: string | null } {
  try {
    return { dir: resolveOutputDir(contextRoot, m.outputDir, m.slug), degradeReason: null };
  } catch {
    return { dir: join(outputRootDir(contextRoot), m.slug), degradeReason: OUTPUT_DIR_DEGRADE_REASON };
  }
}

// ─── Manifest read ───────────────────────────────────────────────────────────

export function readAutomationFile(filePath: string): AutomationManifest {
  const { data, content } = readFrontmatter<Record<string, unknown>>(filePath);
  const slug = basename(filePath, '.md');
  const output = asRecord(data.output);
  return {
    slug,
    id: typeof data.id === 'string' && data.id.trim() ? data.id : '',
    title: typeof data.title === 'string' && data.title.trim() ? data.title : slug,
    enabled: data.enabled !== false,
    schedule: parseSchedule(data.schedule),
    model: strOrNull(data.model),
    effort: parseEffort(data.effort),
    timeoutMinutes: numberOrDefault(data.timeout_minutes, DEFAULT_TIMEOUT_MINUTES, 1, MAX_TIMEOUT_MINUTES),
    catchupHours: numberOrDefault(data.catchup_hours, DEFAULT_CATCHUP_HOURS, 1, MAX_CATCHUP_HOURS),
    outputDir: strOrNull(output?.dir),
    // Strict equality, deliberately asymmetric: only the literal boolean `true`
    // reads as shared. Missing, `"yes"`, `1`, `null`, or any other malformed
    // value reads as private — a security-relevant flag must fail toward the
    // safe state, so a manifest written before this field existed (or written
    // by hand with a typo) can never accidentally become shared.
    shared: data.shared === true,
    // Mirror image of `shared`'s strictness, pointed the other way: only the
    // literal `false` silences notifications. Missing (every manifest written
    // before this field existed), `"no"`, `0`, or any malformed value reads as
    // notify. A run nobody hears about is the failure mode worth avoiding here.
    notify: data.notify !== false,
    prompt: extractSection(content, 'Prompt'),
    outputInstructions: extractSection(content, 'Output instructions'),
    path: filePath,
    body: content.trim(),
  };
}

/** All automations, sorted by slug (stable). Missing directory ⇒ empty list. */
export function listAutomations(contextRoot: string): AutomationManifest[] {
  const dir = automationsDir(contextRoot);
  if (!existsSync(dir)) return [];
  const files = fg.sync('*.md', { cwd: dir, absolute: true }).sort();
  const out: AutomationManifest[] = [];
  for (const file of files) {
    try {
      out.push(readAutomationFile(file));
    } catch {
      // skip a manifest that won't even parse as frontmatter
    }
  }
  return out;
}

export function getAutomation(contextRoot: string, slug: string): AutomationManifest | null {
  const path = automationPath(contextRoot, slug);
  if (!isSafeAutomationSlug(slug) || !existsSync(path)) return null;
  try {
    return readAutomationFile(path);
  } catch {
    return null;
  }
}

// ─── Cache read/write (atomic) ──────────────────────────────────────────────

export function readAutomationCache(contextRoot: string, slug: string): AutomationCache | null {
  const path = automationCachePath(contextRoot, slug);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as AutomationCache;
  } catch {
    return null;
  }
}

export function writeAutomationCache(contextRoot: string, slug: string, c: AutomationCache): void {
  mkdirSync(automationCacheDir(contextRoot), { recursive: true });
  const path = automationCachePath(contextRoot, slug);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(c, null, 2) + '\n', 'utf-8');
  renameSync(tmp, path); // atomic replace
}

/**
 * Record one run attempt (or non-attempt). The SOLE writer of
 * `AutomationCache.lastFireAt` — the watermark advances to `event.firedAt`
 * only when `opts.advanceWatermark !== false` (default: advance). History is
 * newest-first, bounded to `HISTORY_LIMIT`. The top-level `status`/`error`/
 * `durationMs`/`outputPath`/`exitCode`/`lastRunAt` fields always mirror the
 * just-recorded event, independent of the watermark decision — they answer
 * "what happened most recently", which `blocked`/`deferred`/`orphaned` are.
 */
export function recordRun(
  contextRoot: string,
  slug: string,
  e: RunEvent,
  opts?: { advanceWatermark?: boolean },
): AutomationCache {
  const existing = readAutomationCache(contextRoot, slug);
  const advance = opts?.advanceWatermark !== false;
  const history = [e, ...(existing?.history ?? [])].slice(0, HISTORY_LIMIT);
  const cache: AutomationCache = {
    slug,
    lastRunAt: e.startedAt,
    lastFireAt: advance ? e.firedAt : (existing?.lastFireAt ?? null),
    status: e.status,
    durationMs: e.durationMs,
    outputPath: e.outputPath,
    error: e.error,
    exitCode: e.exitCode,
    history,
  };
  writeAutomationCache(contextRoot, slug, cache);
  return cache;
}

// ─── Run sidecar (machine-local, content-validated on read) ────────────────

export function writeRunSidecar(contextRoot: string, slug: string, s: RunSidecar): void {
  mkdirSync(automationCacheDir(contextRoot), { recursive: true });
  const path = sidecarPathFor(contextRoot, slug);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', 'utf-8');
  renameSync(tmp, path); // atomic replace
}

/**
 * Read the run sidecar, VALIDATING CONTENT — not just JSON syntax. Returns
 * `null` unless every field type-checks AND `childPgid`/`runnerPid` are each
 * a plain integer > 1.
 *
 * This is load-bearing safety, not routine leniency: on a failed spawn
 * `child.pid` is `undefined`, which `JSON.stringify` drops entirely, so a
 * naively-written sidecar's `childPgid` round-trips through JSON as `null` —
 * and `-null` is `-0`, which `process.kill(-0, …)` resolves to THE CALLER'S
 * OWN PROCESS GROUP. A `childPgid` of `1` is equally dangerous negated
 * (`-1` broadcasts to every process the caller may signal). A corrupt,
 * truncated, or planted sidecar must be INERT — never a lethal negative-PID
 * kill target — so every field is checked before a single one is trusted.
 */
export function readRunSidecar(contextRoot: string, slug: string): RunSidecar | null {
  const path = sidecarPathFor(contextRoot, slug);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const r = parsed as Record<string, unknown>;

    if (typeof r.slug !== 'string' || r.slug !== slug) return null;
    if (!isSafeSignalTarget(r.runnerPid)) return null;
    if (!isFiniteNumber(r.childPid)) return null;
    if (!isSafeSignalTarget(r.childPgid)) return null;
    if (typeof r.fireAt !== 'string' || !r.fireAt) return null;
    if (typeof r.startedAt !== 'string' || !r.startedAt) return null;
    if (typeof r.timeoutAt !== 'string' || !r.timeoutAt) return null;

    return {
      slug: r.slug,
      runnerPid: r.runnerPid,
      childPid: r.childPid,
      childPgid: r.childPgid,
      fireAt: r.fireAt,
      startedAt: r.startedAt,
      timeoutAt: r.timeoutAt,
    };
  } catch {
    return null;
  }
}

/** Idempotent — safe to call whether or not a sidecar exists. */
export function clearRunSidecar(contextRoot: string, slug: string): void {
  try {
    unlinkSync(sidecarPathFor(contextRoot, slug));
  } catch {
    // already gone
  }
}

// ─── Create / edit ──────────────────────────────────────────────────────────

export interface CreateAutomationInput {
  slug: string;
  title: string;
  days: 'daily' | Weekday[];
  at: string;
  model?: string | null;
  effort?: EffortLevel | null;
  timeoutMinutes?: number;
  catchupHours?: number;
  prompt?: string;
  outputInstructions?: string;
  enabled?: boolean;
  outputDir?: string | null;
  /** Private by default (omitted/false). NOT validated here beyond its type —
   *  a boolean has no invalid values; the store's write path never touches
   *  `.gitignore` for this flag (that is `sharing.ts`'s domain). */
  shared?: boolean;
  /** Omitted ⇒ notify. Only an explicit `false` writes `notify: false`. */
  notify?: boolean;
}

/**
 * STRICT validation for writes (throws `AutomationError`). Reads stay
 * lenient. Deliberately takes NO `contextRoot` (matches the store's public
 * contract) — schedule/slug/model/timeout/catchup are all checkable in
 * isolation. `outputDir` containment cannot be checked here for the same
 * reason (`resolveOutputDir` needs a real root to resolve against); it is
 * enforced immediately after this call, inside `createAutomation`, which
 * DOES have `contextRoot` in scope — the security property (throw before any
 * write, on an escaping `outputDir`) holds identically either way.
 */
export function validateAutomationForWrite(i: CreateAutomationInput): void {
  if (!isSafeAutomationSlug(i.slug.trim())) {
    throw new AutomationError(
      `Invalid automation slug "${i.slug}" — use kebab-case (e.g. eod-digest); "cache" and "output" are reserved.`,
    );
  }
  if (!i.title || !i.title.trim()) {
    throw new AutomationError('An automation title is required.');
  }
  if (parseSchedule({ days: i.days, at: i.at }) === null) {
    throw new AutomationError(
      'Invalid schedule — days must be "daily" or a list of weekdays (sun..sat), and at must be a 24h "HH:MM" time.',
    );
  }
  if (i.model !== undefined && i.model !== null && !/^[a-z0-9.-]+$/.test(i.model)) {
    throw new AutomationError(`Invalid model "${i.model}" — must match /^[a-z0-9.-]+$/.`);
  }
  if (i.effort !== undefined && i.effort !== null && !(EFFORT_LEVELS as readonly string[]).includes(i.effort)) {
    throw new AutomationError(`Invalid effort "${i.effort}" — must be one of: ${EFFORT_LEVELS.join(', ')}.`);
  }
  if (
    i.timeoutMinutes !== undefined &&
    (!Number.isFinite(i.timeoutMinutes) || i.timeoutMinutes < 1 || i.timeoutMinutes > MAX_TIMEOUT_MINUTES)
  ) {
    throw new AutomationError(`timeout_minutes must be between 1 and ${MAX_TIMEOUT_MINUTES}.`);
  }
  if (
    i.catchupHours !== undefined &&
    (!Number.isFinite(i.catchupHours) || i.catchupHours < 1 || i.catchupHours > MAX_CATCHUP_HOURS)
  ) {
    throw new AutomationError(`catchup_hours must be between 1 and ${MAX_CATCHUP_HOURS}.`);
  }
}

/** Idempotently ensure both governing `.gitignore` files (contextRoot- and
 *  projectRoot-relative, covering full-repo and in-tree brain-sync modes)
 *  cover the lock/sidecar artifacts BEFORE the manifest is written — the
 *  `secrets.ts` / `lab/credentials.ts` ordering guarantee: these machine-local
 *  files must never be committable, even transiently. */
function ensureAutomationsGitignore(contextRoot: string, slug: string): void {
  const projectRoot = dirname(contextRoot);
  try {
    ensureGitignoreEntries(contextRoot, AUTOMATIONS_GITIGNORE_ENTRIES, {
      comment: 'dreamcontext automations — machine-local run state (never commit)',
    });
    ensureGitignoreEntries(projectRoot, AUTOMATIONS_GITIGNORE_ENTRIES_ROOT, {
      comment: 'dreamcontext automations — machine-local run state (never commit)',
    });
  } catch (err) {
    throw new AutomationError(
      `Refusing to create automation "${slug}": a governing .gitignore could not be ensured ` +
      `(${(err as Error).message}).`,
    );
  }
}

/**
 * Scaffold a new automation manifest (lazy mkdir — no init/migration step).
 * Validates in this order, throwing before any write: field-level checks
 * (`validateAutomationForWrite`) → the manifest must not already exist →
 * `outputDir` containment (`resolveOutputDir`, defined in this file, since it
 * needs `contextRoot`) → the governing `.gitignore` entries.
 */
export function createAutomation(contextRoot: string, i: CreateAutomationInput): AutomationManifest {
  validateAutomationForWrite(i);
  const slug = i.slug.trim();
  const path = automationPath(contextRoot, slug);
  if (existsSync(path)) throw new AutomationError(`Automation already exists: ${slug}`);

  const schedule = parseSchedule({ days: i.days, at: i.at });
  if (schedule === null) {
    // Unreachable — validateAutomationForWrite already confirmed this — kept
    // explicit so this function never silently proceeds with a null schedule.
    throw new AutomationError(`Invalid schedule for "${slug}".`);
  }

  if (i.outputDir !== undefined && i.outputDir !== null) {
    resolveOutputDir(contextRoot, i.outputDir, slug); // throws AutomationError on escape
  }

  ensureAutomationsGitignore(contextRoot, slug);

  const frontmatter: Record<string, unknown> = {
    id: generateId('auto'),
    title: i.title.trim(),
    enabled: i.enabled ?? true,
    schedule,
    model: i.model ?? null,
    effort: i.effort ?? null,
    timeout_minutes: numberOrDefault(i.timeoutMinutes, DEFAULT_TIMEOUT_MINUTES, 1, MAX_TIMEOUT_MINUTES),
    catchup_hours: numberOrDefault(i.catchupHours, DEFAULT_CATCHUP_HOURS, 1, MAX_CATCHUP_HOURS),
    output: { dir: i.outputDir ?? null },
    shared: i.shared ?? false,
    notify: i.notify ?? true,
  };

  const body = [
    '## Prompt',
    '',
    i.prompt?.trim() || '(What should this automation do? Write the prompt the scheduled run will send.)',
    '',
    '## Output instructions',
    '',
    i.outputInstructions?.trim() || '(Optional — extra guidance for how the output should be formatted or where else it should go.)',
    '',
  ].join('\n');

  mkdirSync(automationsDir(contextRoot), { recursive: true });
  writeFrontmatter(path, frontmatter, body);
  return readAutomationFile(path);
}

export function setAutomationEnabled(contextRoot: string, slug: string, enabled: boolean): AutomationManifest {
  const manifest = getAutomation(contextRoot, slug);
  if (!manifest) throw new AutomationError(`No such automation: ${slug}`);
  updateFrontmatterFields(manifest.path, { enabled });
  return readAutomationFile(manifest.path);
}

/**
 * Flip the `shared` frontmatter flag. Frontmatter ONLY — deliberately never
 * touches `.gitignore`. Publishing a slug means both the flag AND its three
 * negation lines must be in place (see `sharedSlugNegations`); coordinating
 * both atomically is `sharing.ts`'s `shareAutomation`/`unshareAutomation`
 * (a same-wave sibling module this file must not import — see
 * `shareStateFor` below). Called directly only when a caller genuinely wants
 * the flag alone, e.g. a drift repair that found the flag already correct.
 */
export function setAutomationShared(contextRoot: string, slug: string, shared: boolean): AutomationManifest {
  const manifest = getAutomation(contextRoot, slug);
  if (!manifest) throw new AutomationError(`No such automation: ${slug}`);
  updateFrontmatterFields(manifest.path, { shared });
  return readAutomationFile(manifest.path);
}

/**
 * Delete the manifest and its machine-local cache/lock/sidecar. Never
 * touches the approval registry (`~/.dreamcontext/automations.json`) — that
 * is `registry.ts`'s file, a separate concern the CLI's `remove` verb
 * coordinates across both stores.
 */
export function removeAutomation(contextRoot: string, slug: string, opts?: { purgeOutput?: boolean }): void {
  const manifest = getAutomation(contextRoot, slug);
  if (!manifest) throw new AutomationError(`No such automation: ${slug}`);

  if (opts?.purgeOutput) {
    const { dir } = outputDirFor(contextRoot, manifest);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // nothing to purge
    }
  }

  unlinkSync(manifest.path);
  for (const p of [automationCachePath(contextRoot, slug), lockPathFor(contextRoot, slug), sidecarPathFor(contextRoot, slug)]) {
    try {
      unlinkSync(p);
    } catch {
      // never existed
    }
  }
}

// ─── Sharing state (defence in depth — see types.ts's sharing predicates) ───

/**
 * What actually happens to ONE automation's manifest on the next commit.
 * `private`/`shared` are the settled states; the other three are drift a
 * caller (`list`/`show`/`install --check`) must surface loudly:
 *   - `drifted-flag-only`  — flag true, negation absent/ineffective. FAILS
 *     SAFE: content stays local; the user is merely wrong about publishing.
 *   - `drifted-ignore-only` — flag false, but an effective negation is
 *     present. Does NOT fail safe: content actually leaves while the user
 *     believes it is private.
 *   - `tracked-despite-private` — the manifest is already in git's index
 *     despite `shared: false`. `.gitignore` can never untrack a path git
 *     already has (git add -f, a merge/cherry-pick from a branch where it
 *     was tracked, or a hand-written manifest on a brain where
 *     `createAutomation` never ran) — this is the loudest, most urgent state
 *     and is checked FIRST for a private-flagged manifest, ahead of the
 *     ignore-effectiveness check, since an ineffective or absent negation is
 *     moot once the file is already committed.
 */
export type ShareState =
  | 'private'
  | 'shared'
  | 'drifted-flag-only'
  | 'drifted-ignore-only'
  | 'tracked-despite-private';

/**
 * Reports the subset of `relPaths` (relative to `contextRoot`) that git
 * actually tracks. Injectable so tests need no real repo.
 */
export type GitTrackedCheck = (contextRoot: string, relPaths: string[]) => string[];

/**
 * `git ls-files` resolves the nearest enclosing repository starting from
 * `cwd` and interprets pathspecs relative to that same `cwd` — so running it
 * with `cwd: contextRoot` correctly answers "is this path tracked" whether
 * the actual repo root is `contextRoot` itself or any ancestor directory,
 * with no repo-root discovery of our own required. `git ls-files` lists only
 * the tracked subset of the given pathspecs (an untracked path is simply
 * absent from the output, never an error) — so the return value already IS
 * "the tracked subset", no separate diffing needed. Never throws: outside a
 * repo, or git itself missing, both degrade to `[]` — the same "nothing is
 * tracked" answer a fresh, ungitted brain should give.
 */
export const defaultGitTrackedCheck: GitTrackedCheck = (contextRoot, relPaths) => {
  if (relPaths.length === 0) return [];
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--', ...relPaths], {
      cwd: contextRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .toString('utf-8')
      .split('\0')
      .filter((p) => p.length > 0);
  } catch {
    return [];
  }
};

/**
 * The five-state detector `list`/`show`/`install --check` need to answer "is
 * this automation actually private/shared". Uses ONLY the pure, order-aware
 * predicates from types.ts (`sharedSlugNegations`, `negationIsEffective`)
 * plus an injectable `GitTrackedCheck` — TWO deliberate prohibitions:
 *
 *  - Does NOT import `sharing.ts`. That module lands in this SAME wave; a
 *    same-wave cross-import would be an unpinned contract between two
 *    parallel implementers, which is exactly what hoisting the ordering
 *    predicates into types.ts (wave 1) was meant to avoid.
 *  - Does NOT use `gitignoreCovers` from `../gitignore.js`. It is a naive
 *    set-membership scan with no ordering logic — using it here would
 *    reproduce the silent failure `negationIsEffective` exists to catch: a
 *    negation placed ABOVE its wildcard is dropped by git with no error, so
 *    "the line is present in the text" is not the same question as "does
 *    this actually publish".
 *
 * Scope note: the git-tracked check covers the MANIFEST path only, not its
 * cache record or output directory. Every residual path that produces
 * `tracked-despite-private` (`git add -f`, a merge/cherry-pick, a hand-
 * written manifest that never went through `createAutomation`) is about the
 * manifest specifically, and `sharing.ts` is the module responsible for
 * keeping the manifest/cache/output negations in lockstep once a slug is
 * actually shared — this detector answers "is it private/shared", not "audit
 * every synced path", which would be a materially larger surface than any
 * caller of this function has asked for.
 */
export function shareStateFor(
  contextRoot: string,
  m: AutomationManifest,
  opts?: { gitTracked?: GitTrackedCheck },
): ShareState {
  const gitTracked = opts?.gitTracked ?? defaultGitTrackedCheck;
  const gitignorePath = join(contextRoot, '.gitignore');
  const gitignoreText = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf-8') : '';

  const negations = sharedSlugNegations(m.slug);
  const allNegationsEffective = negations.every((n) =>
    negationIsEffective(gitignoreText, n, AUTOMATIONS_GITIGNORE_ENTRIES),
  );

  if (!m.shared) {
    const relManifestPath = `automations/${m.slug}.md`;
    const isTracked = gitTracked(contextRoot, [relManifestPath]).includes(relManifestPath);
    if (isTracked) return 'tracked-despite-private';
    return allNegationsEffective ? 'drifted-ignore-only' : 'private';
  }
  return allNegationsEffective ? 'shared' : 'drifted-flag-only';
}
