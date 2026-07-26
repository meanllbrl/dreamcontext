/**
 * Automations — shared types and constants. CONTRACT ROOT for the whole
 * subsystem: every other automations module (store, registry, launchd, runner,
 * tick, CLI, server routes) compiles against the exact shapes declared here.
 *
 * Manifests live at `_dream_context/automations/<slug>.md` (flat — unlike Lab's
 * nested `insights/`), cache at `automations/cache/<slug>.json`, output at
 * `automations/output/<slug>/<date>.md`. This file has NO I/O and NO imports
 * beyond the language itself — every downstream module can depend on it
 * without pulling in fs/child_process/etc. That includes the sharing-state
 * predicates near the bottom of this file: they operate on already-read
 * `.gitignore` TEXT, never touch a filesystem themselves, so `store.ts` and
 * `sharing.ts` can both be order-aware without importing each other.
 */

/** Every terminal (and non-terminal-but-recorded) disposition a run can reach.
 *  'orphaned' = a previous run's detached child group is still alive after its
 *  runner died — the automation refuses to spawn again until an operator runs
 *  `automations kill`. */
export const RUN_STATUSES = ['ok', 'failed', 'timeout', 'blocked', 'deferred', 'orphaned'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** Lowercase 3-letter weekday keys, `Date.getDay()`-ordered (0=Sun..6=Sat). */
export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** Exactly the reasoning-effort levels `claude --effort` accepts — verified
 *  against the real CLI, do not invent others. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** Structured, self-documenting schedule — NOT a cron string (see the task's
 *  Constraints & Decisions). `at` is 24h "HH:MM", machine-local wall-clock. */
export interface Schedule {
  days: 'daily' | Weekday[];
  at: string;
}

/** A manifest read from `automations/<slug>.md`. Reads are LENIENT (the store
 *  degrades a malformed sub-block rather than throwing); this shape is always
 *  the fully-resolved, defaulted result of a read. */
export interface AutomationManifest {
  slug: string;
  id: string;
  title: string;
  enabled: boolean;
  /** null ⇒ malformed on disk ⇒ this automation is never due, flagged in `list`. */
  schedule: Schedule | null;
  /** Validated against /^[a-z0-9.-]+$/ on write; null ⇒ let `claude` pick its default. */
  model: string | null;
  /** One of EFFORT_LEVELS on write; null ⇒ omit `--effort` entirely and let
   *  `claude` pick its own default. Hashed alongside `model` — both are
   *  execution-envelope levers on an already-approved prompt. */
  effort: EffortLevel | null;
  /** Clamped 1..MAX_TIMEOUT_MINUTES on write. */
  timeoutMinutes: number;
  /** Clamped 1..MAX_CATCHUP_HOURS on write. */
  catchupHours: number;
  /** contextRoot-relative, STRICT SUBDIRECTORY (never the brain root itself,
   *  never escaping it) — enforced by the store's resolveOutputDir. null ⇒
   *  defaults to `automations/output/<slug>/`. */
  outputDir: string | null;
  /** Private by default (only `shared === true` publishes this manifest, its
   *  cache record and its outputs — anything else, including missing or
   *  malformed, reads as private, fail-safe). NOT a hashed field: it changes
   *  WHERE the manifest goes, never what the prompt does, and two machines
   *  may legitimately disagree about local publishing intent. */
  shared: boolean;
  prompt: string;
  outputInstructions: string;
  path: string;
  body: string;
}

/** One recorded attempt (or non-attempt) at a scheduled or manual run. Every
 *  field is written explicitly by whichever code path produces the event —
 *  there is no "partial" RunEvent. */
export interface RunEvent {
  /** The scheduled fire this event answers for — NEVER `now` at record time
   *  (a catch-up run still records the original fire, or watermark math breaks). */
  firedAt: string;
  startedAt: string;
  finishedAt: string;
  status: RunStatus;
  durationMs: number;
  outputPath: string | null;
  error: string | null;
  exitCode: number | null;
  sessionId: string | null;
  costUsd: number | null;
  numTurns: number | null;
  /** 0 does not mean "none occurred" on every status — see the runner's
   *  operator-kill path, where telemetry was never collected. */
  permissionDenials: number;
}

/** Cache snapshot at `automations/cache/<slug>.json` — brain-synced. */
export interface AutomationCache {
  slug: string;
  lastRunAt: string | null;
  /** THE WATERMARK. Advances iff a child process actually started for that
   *  fire — never on `blocked`/`deferred`/`orphaned`, always on `ok`/`timeout`,
   *  and on `failed` only when the spawn itself succeeded. */
  lastFireAt: string | null;
  status: RunStatus | null;
  durationMs: number | null;
  outputPath: string | null;
  error: string | null;
  exitCode: number | null;
  /** Newest first, bounded to HISTORY_LIMIT. */
  history: RunEvent[];
}

/** Machine-local record of an in-flight (or just-finished) child, written only
 *  on a successful spawn, so an orphaned process group stays findable after its
 *  runner is SIGKILLed out from under it. NEVER brain-synced — lives beside the
 *  lock file under `automations/cache/`, gitignored. */
export interface RunSidecar {
  slug: string;
  runnerPid: number;
  childPid: number;
  childPgid: number;
  fireAt: string;
  startedAt: string;
  timeoutAt: string;
}

/** The exact fields the approval sha256 is computed over — the CLI's
 *  `approve` diff and the registry's hash must both operate on precisely this
 *  shape, so neither can drift from what the other reviews. Kept in lockstep
 *  with {@link APPROVAL_DIFF_FIELDS}: every key here has a matching entry
 *  there, in the same order. */
export interface ApprovalPayloadFields {
  prompt: string;
  outputInstructions: string;
  model: string | null;
  effort: EffortLevel | null;
  timeoutMinutes: number;
  outputDir: string | null;
}

/** Domain error for the automations subsystem — thrown only by strict
 *  validation/write paths; read paths stay lenient and never throw. */
export class AutomationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AutomationError';
  }
}

export const DEFAULT_TIMEOUT_MINUTES = 15;
export const MAX_TIMEOUT_MINUTES = 60;
export const DEFAULT_CATCHUP_HOURS = 6;
export const MAX_CATCHUP_HOURS = 168;
/** Bound on `AutomationCache.history` — oldest entries drop off. */
export const HISTORY_LIMIT = 50;
/** Prompt sanitization caps at this many bytes (strip NULs, never flatten
 *  newlines — `-p` takes a genuine multi-line argument). */
export const MAX_PROMPT_BYTES = 100_000;
/** Runner stdout is bounded to this many bytes before truncation. */
export const MAX_STDOUT_BYTES = 2_000_000;
/** Stderr tail kept for a failed run's error record. */
export const STDERR_TAIL_BYTES = 4_096;
/** Grace period between SIGTERM and SIGKILL on the timeout path only — never
 *  on a server-shutdown or operator-kill path, both of which SIGKILL the
 *  process group immediately. */
export const KILL_GRACE_MS = 10_000;
export const DISPATCHER_LABEL = 'com.dreamcontext.automations';
export const TICK_INTERVAL_SECONDS = 300;
/** Dispatcher log rotates (renamed to `.log.1`) past this size. */
export const LOG_ROTATE_BYTES = 1_048_576;
/** Manifests are flat at `automations/<slug>.md`, so these sibling directory
 *  names are reserved and cannot be used as a slug. */
export const RESERVED_SLUGS = ['cache', 'output'] as const;
export const APPROVAL_PAYLOAD_VERSION = 'automation-approval/v1';
/** The exact field set `approve` must diff — kept in lockstep with
 *  ApprovalPayloadFields so the CLI's review surface can never diverge from
 *  what is actually hashed. `effort` sits between `model` and
 *  `timeoutMinutes`: all three are execution-envelope levers on an
 *  already-approved prompt. */
export const APPROVAL_DIFF_FIELDS = [
  'prompt',
  'outputInstructions',
  'model',
  'effort',
  'timeoutMinutes',
  'outputDir',
] as const;
/** Beyond this age a sidecar's recorded PGID may have been recycled by the OS —
 *  `automations kill` requires --force past this window rather than trusting
 *  process-group identity blindly. */
export const SIDECAR_PID_REUSE_WINDOW_MS = 60 * 60 * 1000;
/**
 * Machine-local artifacts under `automations/cache/` that must never sync:
 * the per-slug run lock, the in-flight-child sidecar, and the sidecar's own
 * `.tmp` write-then-rename intermediate (`writeRunSidecar` in store.ts writes
 * `<sidecar-path>.tmp` before the atomic rename — that file must be
 * uncommittable for the sub-millisecond window it exists, same as the final
 * path; the lock file has no such intermediate, since `acquireFileLock`
 * creates it directly via an O_EXCL `wx` write, never a temp+rename).
 *
 * Also the PRIVATE-BY-DEFAULT base block: every manifest, cache record and
 * output file is ignored by default; `automations share <slug>` appends three
 * negation lines (see {@link sharedSlugNegations}) that publish exactly that
 * slug. ORDER IS LOAD-BEARING — every wildcard in this array must precede
 * every negation a sharing operation appends afterwards, or git silently
 * drops the negation with no error and no warning: a negation placed above
 * the wildcard it is meant to override is simply never applied, so the user
 * sees `shared: true` and believes the file publishes while it never leaves
 * the machine. Verified empirically. See {@link negationIsEffective} and
 * {@link shareOrderingProblems}, which exist to catch exactly that.
 *
 * The output entry matches a file two path segments below `automations/output`
 * (every dated file under every slug's own output folder) rather than the
 * `automations/output` directory itself — ignoring the directory would stop
 * git from descending into it at all, and no negation could ever re-include a
 * file inside an ignored directory. Same reason the manifest entry matches
 * `*.md` files directly under `automations/`, never the bare directory.
 */
export const AUTOMATIONS_GITIGNORE_ENTRIES = [
  'automations/cache/*.lock',
  'automations/cache/*.run.json',
  'automations/cache/*.run.json.tmp',
  'automations/*.md',
  'automations/cache/*.json',
  'automations/output/*/*',
];
export const AUTOMATIONS_GITIGNORE_ENTRIES_ROOT = [
  '_dream_context/automations/cache/*.lock',
  '_dream_context/automations/cache/*.run.json',
  '_dream_context/automations/cache/*.run.json.tmp',
  '_dream_context/automations/*.md',
  '_dream_context/automations/cache/*.json',
  '_dream_context/automations/output/*/*',
];

// ─── Sharing predicates (PURE — operate on already-read .gitignore text) ────
//
// These exist so `store.ts` (shareStateFor) and `sharing.ts` (assertShareOrdering,
// listSharedSlugs) can both be order-aware about what actually publishes
// without importing each other — each reads its own `.gitignore` text and
// calls straight into these.

/** Non-blank, non-comment lines, trimmed, in file order — the only lines that
 *  participate in gitignore pattern evaluation. */
function meaningfulLines(gitignoreText: string): string[] {
  return gitignoreText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

/** The longest literal prefix shared by every string in `entries`, or '' if
 *  `entries` is empty or shares none. */
function longestCommonPrefix(entries: readonly string[]): string {
  if (entries.length === 0) return '';
  let prefix = entries[0];
  for (const s of entries.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < s.length && prefix[i] === s[i]) i++;
    prefix = prefix.slice(0, i);
    if (prefix.length === 0) break;
  }
  return prefix;
}

/** The three negation lines that publish ONE slug's manifest, cache record and
 *  output directory, brain-relative (as they appear in `_dream_context/.gitignore`).
 *  Pure templating — assumes `slug` is already validated (isSafeAutomationSlug
 *  in store.ts); no I/O, no validation here. */
export function sharedSlugNegations(slug: string): string[] {
  return [`!automations/${slug}.md`, `!automations/cache/${slug}.json`, `!automations/output/${slug}/*`];
}

/** Same three lines, project-root-relative (as they appear in the project
 *  root `.gitignore` for in-tree brain-sync mode). */
export function sharedSlugNegationsRoot(slug: string): string[] {
  return [
    `!_dream_context/automations/${slug}.md`,
    `!_dream_context/automations/cache/${slug}.json`,
    `!_dream_context/automations/output/${slug}/*`,
  ];
}

/**
 * True iff `negation` appears verbatim in `gitignoreText` AND no occurrence of
 * any entry in `baseEntries` sits at or after it. Presence of the negation
 * line alone is NOT sufficient — and must never be treated as sufficient by a
 * caller — because git evaluates patterns in file order: a negation written
 * ABOVE the wildcard it is meant to override fires against a path that isn't
 * excluded yet (so it does nothing), and the wildcard below then excludes the
 * path with no later negation to undo it. The file ends up ignored, silently,
 * with no error from git. This was proven empirically on this exact base
 * block: moving one negation above its wildcard was enough to make git commit
 * the "private" file as if it had never been ignored at all — while `shared:
 * true` in frontmatter told the user the opposite. `gitignoreCovers` (a naive
 * set-membership scan elsewhere in this codebase) answers a different, unsafe
 * question — "does this text mention the line" — and must never be used to
 * answer "is this slug actually published".
 */
export function negationIsEffective(gitignoreText: string, negation: string, baseEntries: readonly string[]): boolean {
  const lines = meaningfulLines(gitignoreText);
  const negTrimmed = negation.trim();
  const negIndex = lines.indexOf(negTrimmed);
  if (negIndex === -1) return false;
  for (const entry of baseEntries) {
    const entryTrimmed = entry.trim();
    for (let i = negIndex; i < lines.length; i++) {
      if (lines[i] === entryTrimmed) return false;
    }
  }
  return true;
}

/**
 * Every ordering fault in the automations `.gitignore` block: a negation
 * present in `gitignoreText` whose covering base wildcard(s) are not entirely
 * before it — the exact shape {@link negationIsEffective} reports as silently
 * dropped by git. Empty ⇒ every automations negation in the text is
 * well-formed. Scoped to negations whose un-negated path starts with
 * `baseEntries`' longest common prefix, so an unrelated negation elsewhere in
 * the file (a Lab credentials example, say) is never misreported as a
 * problem.
 */
export function shareOrderingProblems(gitignoreText: string, baseEntries: readonly string[]): string[] {
  const prefix = longestCommonPrefix(baseEntries);
  if (prefix.length === 0) return [];
  const problems: string[] = [];
  for (const line of meaningfulLines(gitignoreText)) {
    if (!line.startsWith('!')) continue;
    if (!line.slice(1).startsWith(prefix)) continue;
    if (!negationIsEffective(gitignoreText, line, baseEntries)) {
      problems.push(`"${line}" is positioned before its base wildcard and will be silently ignored by git.`);
    }
  }
  return problems;
}
