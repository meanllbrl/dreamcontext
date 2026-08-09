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
 *  `automations kill`.
 *  'awaiting-review' = a previous run left a review card nobody has answered —
 *  the automation refuses to spawn again until a human resolves it. Unlike
 *  every other refusal here it is not a fault: it is the scheduler running at
 *  the human's speed instead of the clock's, so a week away comes back as one
 *  owed fire rather than seven identical unreviewed proposals. */
export const RUN_STATUSES = [
  'ok',
  'failed',
  'timeout',
  'blocked',
  'deferred',
  'orphaned',
  'awaiting-review',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * When does a run have to stop and ask a human before its work takes effect?
 *
 * - `off`     — today's behavior, byte for byte. The run publishes its output,
 *               notifies, and is consumed by sleep with no verdict in between.
 * - `agent`   — the RUN decides, at runtime, whether what it is about to do
 *               warrants a human. It calls `automations propose` and ends; a
 *               run that never proposes publishes exactly as under `off`. This
 *               is the flexible mode, and it matches the feature's stance that
 *               job semantics live in manifest prose, not in hardcoded types.
 * - `output`  — blanket. The runner itself proposes the run's output document
 *               before that document is allowed to become an output document.
 *
 * The distinction that matters: this gates the ARTIFACT, where the sha256
 * approval tripwire gates the CAPABILITY. Approval is answered once and holds
 * forever; a review card is answered every time and holds nothing.
 */
export const REVIEW_MODES = ['off', 'agent', 'output'] as const;
export type ReviewMode = (typeof REVIEW_MODES)[number];

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
  /** Send a desktop notification when a scheduled run finishes, success or
   *  failure. Defaults to TRUE, and reads fail-safe in the OPPOSITE direction
   *  from `shared`: only the literal `false` silences it. An unattended run
   *  nobody is told about is a silent loss, whereas an over-share is a leak, so
   *  the two flags fail toward opposite states on purpose.
   *
   *  NOT a hashed field, same reasoning as `shared`: it changes whether you are
   *  TOLD about a run, never what the run does. */
  notify: boolean;
  /**
   * Does this automation carry a PATTERN — the `## Pattern` section it reads
   * before running and appends to afterwards, so a job gets more accurate the
   * longer it runs?
   *
   * Reads STRICT-TRUE, like `shared` and unlike `notify`, and it is the one
   * flag here that IS approval-hashed. Both follow from the same fact: turning
   * this on widens what the run READS to a file the run itself rewrites, and
   * nothing re-reviews that file's contents (see the approval reference's
   * "does not follow references inside the prompt"). So it must never switch
   * itself on by accident, and a teammate's synced edit switching it on must
   * block until a human re-approves.
   *
   * `create` writes `learning: true` explicitly for new automations, which is
   * why strict-true costs nothing going forward: only a manifest written
   * BEFORE this field existed reads as false, and that is exactly right —
   * its approved hash then stays byte-identical (see canonicalApprovalPayload)
   * so an upgrade never silently blocks a working automation. Opting an old
   * one in is a manifest edit, which re-triggers approval on its own.
   */
  learning: boolean;
  /**
   * Does this automation stop and ask before its work takes effect, and who
   * decides — see {@link ReviewMode}.
   *
   * Reads leniently toward `off`: anything that is not one of REVIEW_MODES
   * (missing, a typo, a boolean) reads as `off`, which is the pre-feature
   * behavior. That is the opposite of how `shared` fails, and deliberately so:
   * `shared`'s unsafe state is "publishes", so it fails closed, whereas a
   * malformed `review` failing CLOSED would mean an automation silently
   * stopping to ask a human who does not know a card exists — for a scheduler,
   * a job that quietly never completes is worse than one that completes
   * unreviewed, and the manifest is right there in `list` to show what it says.
   *
   * IS approval-hashed, in the non-`off` direction (see
   * canonicalApprovalPayload): omitted from the payload when `off` so every
   * manifest written before this field existed keeps its exact hash, included
   * otherwise so a teammate's synced edit can never silently REMOVE the gate.
   */
  review: ReviewMode;
  prompt: string;
  outputInstructions: string;
  /** The `## Pattern` section VERBATIM — what previous runs learned. Written
   *  only by `automations learn`, never by hand-editing during a run, and
   *  injected into the prompt as UNTRUSTED NOTES, never as instructions. */
  pattern: string;
  path: string;
  body: string;
}

/** A pattern parsed into its two halves. `## Pattern` holds curated prose (the
 *  playbook) followed by an optional `### Lessons` LIFO list; both are bounded
 *  (see the PATTERN_* caps) because an unbounded pattern would grow until it
 *  crowded out the prompt itself. */
export interface AutomationPattern {
  playbook: string;
  lessons: PatternLesson[];
}

export interface PatternLesson {
  /** Local calendar date the lesson was recorded, `YYYY-MM-DD`. */
  date: string;
  text: string;
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

// ─── Review cards (human-in-the-loop) ───────────────────────────────────────
//
// A card is what a run hands a human when it needs a verdict before its work
// takes effect. The design is ported from Tilki's WhatsApp Concierge, whose
// load-bearing property is NOT the approve button — it is that the verdict
// resumes the very claude session that produced the proposal. That is why a
// card stores a `sessionId` and nothing resembling a command: approving does
// not execute a payload the card carries, it unblocks a conversation the
// approved prompt already bought. A card that carried an executable action
// would be a genuinely new capability on top of `bypassPermissions`; a card
// that says "keep going" is not.
//
// Cards are MACHINE-LOCAL and never brain-synced, for the same reason the
// approval registry is not: a card holds a resumable session id, so a synced
// card is an invitation for someone else's machine to resolve your capability.

/** What a human can do to a card. `drop` is the one people forget, and it is
 *  the one that makes review compound: it does not judge THIS proposal, it
 *  teaches the automation never to make this kind of proposal again. */
export const REVIEW_VERDICTS = ['approve', 'discard', 'drop'] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

/** `pending` until a human answers; the other three mirror the verdicts. */
export const REVIEW_CARD_STATES = ['pending', 'approved', 'discarded', 'dropped'] as const;
export type ReviewCardState = (typeof REVIEW_CARD_STATES)[number];

/** Where a verdict or steer came from. Recorded so a card can say who answered
 *  it and from where — and so the OTHER channels can re-render a card that was
 *  resolved somewhere else. */
export const REVIEW_CHANNELS = ['dashboard', 'cli', 'telegram', 'notification'] as const;
export type ReviewChannel = (typeof REVIEW_CHANNELS)[number];

/** One correction a human gave a pending card. Kept on the card (not only in
 *  the resumed transcript) so every channel can show the trail without reading
 *  a session file, and so the distilled lesson stays traceable to its steer. */
export interface ReviewSteer {
  at: string;
  via: ReviewChannel;
  /** The human's words, VERBATIM. Never rendered into the proposal body and
   *  never executed — it reaches the run only as an instruction ordered after
   *  the verdict preamble, fenced as a correction. */
  text: string;
  /** The imperative lesson this steer distilled into, once `automations learn`
   *  has recorded it. null ⇒ distillation has not run (or failed) — the steer
   *  still stands, it just taught nothing durable. */
  lesson: string | null;
}

/** A proposal awaiting (or having received) a human verdict. */
export interface ReviewCard {
  /** Filename-safe, unique per slug. */
  id: string;
  slug: string;
  /** The scheduled fire the proposing run answered for — ties the card back to
   *  its RunEvent without duplicating the event. */
  runFiredAt: string;
  /**
   * The claude conversation that produced this proposal, and the whole point
   * of the card. Every verdict and every steer `--resume`s exactly this.
   * null ⇒ the run produced no session id (a failed or degraded run); such a
   * card can still be discarded, but it can never be approved or steered,
   * because there is nothing to resume — the surfaces must say so rather than
   * offering a button that cannot work.
   */
  sessionId: string | null;
  kind: 'output' | 'agent';
  title: string;
  /** One line: what this is, for a notification banner and a list row. */
  summary: string;
  /** What the human actually judges — the proposed document, or the run's own
   *  description of what it wants to do next. */
  body: string;
  /** For `kind: 'output'`: the staged document that reaches the real output
   *  directory only on approve. contextRoot-relative. */
  stagedPath: string | null;
  state: ReviewCardState;
  /** Newest LAST — a steer trail reads as a conversation, unlike the LIFO
   *  ledgers elsewhere in the brain, which are scanned newest-first. */
  steers: ReviewSteer[];
  createdAt: string;
  resolvedAt: string | null;
  resolvedVia: ReviewChannel | null;
  /** What the agent said after the verdict resumed it — the answer to "so what
   *  actually happened when I approved that?", which a resolved card is
   *  otherwise unable to give. null until a verdict has been acted on. */
  resolutionNote: string | null;
  /**
   * Set when the verdict's resume did NOT complete cleanly.
   *
   * Load-bearing, and the reason it is a card field rather than a log line: the
   * verdict is persisted BEFORE the resume spawns (a crash in that window must
   * not replay the act), so a card whose resume then failed is `approved` on
   * disk while nothing may have been carried out. Without this field that card
   * is indistinguishable from a clean success — the one state a human must
   * never be shown as done.
   */
  resolutionError: string | null;
  /** Per-channel handles for a card already rendered somewhere (a Telegram
   *  message id, say), so a steer edits that card in place instead of posting
   *  a second copy of a proposal that is still the same proposal. */
  channelRefs: Record<string, string>;
}

/** Directory holding review cards, under `automations/`. Machine-local. */
export const REVIEW_DIR = 'review';
/** Cap on a card's steer trail — past this, the oldest steers drop off. A
 *  human who has corrected the same proposal this many times is not steering
 *  any more, and the trail is prepended to a resumed session, so it is subject
 *  to the same "never crowd out the actual job" rule as the pattern. */
export const REVIEW_STEER_LIMIT = 12;
/** Ceiling on a card's rendered body. A proposal a human cannot read on a
 *  phone is a proposal that gets rubber-stamped. */
export const REVIEW_BODY_MAX_CHARS = 8_000;
/**
 * Machine-local artifacts under `automations/review/` — cards and their staged
 * documents, neither of which may ever be committed.
 *
 * DELIBERATELY NOT part of {@link AUTOMATIONS_GITIGNORE_ENTRIES}. That array is
 * the base-wildcard set that `automations share` writes negations against, and
 * `negationIsEffective` treats ANY base entry appearing after a negation as
 * having silently killed it. Appending a new base wildcard to an existing
 * `.gitignore` that already carries share negations would therefore report
 * every one of them as broken — a false alarm, since nothing under
 * `automations/review/` can match a shared manifest, cache record or output
 * file. Review has no shareable direction at all, so it gets its own block and
 * stays out of the ordering dance entirely.
 */
export const AUTOMATIONS_REVIEW_GITIGNORE_ENTRIES = ['automations/review/'];
export const AUTOMATIONS_REVIEW_GITIGNORE_ENTRIES_ROOT = ['_dream_context/automations/review/'];

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
  /** Hashed because it widens the run's INPUT surface to a self-rewritten
   *  file. The pattern's CONTENTS are deliberately not hashed — they change
   *  every run by design — which is precisely why the switch that admits them
   *  has to be. */
  learning: boolean;
  /** Hashed because it is a GATE, and the direction that matters is removal:
   *  an approved automation whose `review` a teammate edits back to `off` must
   *  block until a human here re-approves. (The other direction costs a
   *  re-approval too — a pure manifest hash has no memory of the previous
   *  mode — but a local write verb re-approves on the spot, so turning review
   *  ON from this machine is free in practice.) */
  review: ReviewMode;
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
export const RESERVED_SLUGS = ['cache', 'output', 'review'] as const;
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
  'learning',
  'review',
] as const;

// ─── Pattern caps ────────────────────────────────────────────────────────────
//
// A count cap is not a size cap (see the Lab review lesson that produced this
// rule): a bounded list of unbounded strings still bloats without limit. Every
// pattern dimension is capped BOTH ways, and the total is capped again on top,
// because this text is prepended to every single run's prompt — an unbounded
// pattern would quietly eat the context the actual job needs.

/** Newest-first lesson ledger depth; older lessons fall off the end. */
export const PATTERN_LESSON_LIMIT = 20;
/** Per-lesson character ceiling — a lesson is one line, not an essay. */
export const PATTERN_LESSON_MAX_CHARS = 300;
/** Playbook prose ceiling. */
export const PATTERN_PLAYBOOK_MAX_CHARS = 4_000;
/** Belt-and-braces ceiling on the whole rendered `## Pattern` section. */
export const PATTERN_SECTION_MAX_CHARS = 12_000;
/** The manifest heading the pattern lives under. */
export const PATTERN_HEADING = 'Pattern';
/** The sub-heading its LIFO ledger lives under, inside `## Pattern`. */
export const PATTERN_LESSONS_HEADING = '### Lessons';

/** Ceiling on the notification body. macOS truncates a long banner itself, but
 *  it does so mid-word with no ellipsis — capping here means the user sees a
 *  deliberate end rather than a sentence cut in half. */
export const NOTIFY_BODY_MAX_CHARS = 240;
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
