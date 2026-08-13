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
 *  owed fire rather than seven identical unreviewed proposals.
 *  'awaiting-approval' = the EXACT TWIN of 'awaiting-review', for the other
 *  gate. The manifest changed since it was last approved, so the run asked the
 *  human about the diff in its own session and exited rather than running an
 *  unapproved prompt. Also not a fault — the human is the bottleneck again —
 *  and it shares the twin's whole discipline: the watermark is NOT advanced, so
 *  the fire is OWED and comes back ONCE when the question is answered, not once
 *  per tick for as long as it goes unanswered.
 *
 *  A run event recorded under this status carries `sessionId: null` ALWAYS. The
 *  approval-question conversation must never become resumable: `resumeWithAnswer`
 *  hardcodes `bypassPermissions`, and at that moment the manifest is by
 *  definition still unapproved — binding that session would let an unapproved
 *  manifest bootstrap its own elevated execution. Null by construction, never
 *  by an omission a future edit could quietly undo. */
export const RUN_STATUSES = [
  'ok',
  'failed',
  'timeout',
  'blocked',
  'deferred',
  'orphaned',
  'awaiting-review',
  'awaiting-approval',
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

// ─── The flow graph (the `## Flow` manifest section) ────────────────────────
//
// An automation's ordered graph of `trigger → agent(+connectors) → hitl →
// report`, stored as fenced JSON under `## Flow` in the manifest. One shape,
// three readers: the runner EXECUTES it, the dashboard DRAWS it, and the
// creation-chat agent WRITES it.
//
// "Executes" needs its precise meaning stated here, because the whole security
// story rests on it: a node NEVER spawns a process. A node's registry entry
// contributes a text/state fragment, and those fragments are folded into the
// ONE prompt sent by the ONE existing spawn in `runner.ts`. So the graph is
// DESCRIPTIVE OF ORCHESTRATION, NOT OF AUTHORITY — it decides what the prompt
// says, never what the run is permitted to do. That is what makes an unknown
// node kind safe to pass through instead of fatal (see `kind` below), and it
// is why `config` needs no "UNTRUSTED NOTES" framing the way `## Pattern` does:
// once `flow` is inside the approval hash, a `config` value is exactly as
// reviewed as `prompt` itself. Both are gated by the same human, at the same
// moment, over the same sha256.

/** One node. `config` is opaque to the graph layer and interpreted only by the
 *  node kind's registry entry. */
export interface FlowGraphNode {
  /** `/^[a-z0-9][a-z0-9_-]{0,39}$/`, unique within the graph. */
  id: string;
  /**
   * DELIBERATELY a plain `string`, NOT a closed union — and this is a design
   * decision, not an oversight waiting to be "fixed".
   *
   * The owner's requirement is lego: adding a new MCP-tool / API / chat
   * connector must never require editing a union in this file and recompiling
   * the world. {@link KNOWN_NODE_KINDS} documents what the shipped registry
   * recognises; anything else is LEGAL and renders as an explicitly-unknown
   * node rather than being dropped or rejected.
   *
   * Contrast `dashboard/src/components/lab/chartRegistry.ts`, whose
   * `Record<Render, …>` deliberately will NOT compile without an entry. That is
   * right for charts (a fixed, curated set the dashboard must draw) and wrong
   * here (an open set the user extends).
   */
  kind: string;
  /** ≤80 chars. Absent ⇒ renderers fall back to `kind`. */
  label?: string;
  /** NEVER executed as instruction. See the section comment above. */
  config?: Record<string, unknown>;
}

/** A directed edge. `from`/`to` must reference an existing node id; a dangling
 *  reference drops the edge (lenient read, never a throw). */
export interface FlowGraphEdge {
  from: string;
  to: string;
  /** ≤24 chars, drawn on the wire. */
  label?: string;
}

/** The parsed `## Flow` block. A `version` other than the literal below makes
 *  the whole block read as ABSENT (`null`), never as a partial graph — the same
 *  lenient-degradation contract every other manifest sub-block follows. */
export interface FlowGraph {
  version: 'automation-flow/v1';
  nodes: FlowGraphNode[];
  edges: FlowGraphEdge[];
}

/** The literal `version` a v1 flow block must carry. */
export const FLOW_GRAPH_VERSION = 'automation-flow/v1';

/** The manifest heading the graph lives under, as fenced JSON. Here beside
 *  {@link PATTERN_HEADING} and for the same reason: the store parses and writes
 *  this section, and the CLI names it too, so neither may hold its own copy of
 *  the string. */
export const FLOW_HEADING = 'Flow';

/** `FlowGraphNode.id` — path-safe-ish and short, because it is an anchor a human
 *  writes by hand in `edges[]` and a renderer prints when a label is missing. */
export const FLOW_NODE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/**
 * The node kinds the shipped registry recognises — DOCUMENTATION, not a
 * constraint. `FlowGraphNode.kind` is `string` on purpose (see above), so an
 * unknown kind is a legal, first-class value: it renders as a visibly
 * unrecognised node and passes through the runner untouched.
 *
 * Both halves of that matter. Dropping an unknown node would make the diagram
 * LIE about what the automation does — the exact failure this redesign exists
 * to fix. Failing the run instead would make every manifest written by a newer
 * dreamcontext dead on arrival on an older one.
 */
export const KNOWN_NODE_KINDS = ['trigger', 'agent', 'hitl', 'report', 'connector', 'branch'] as const;
export type KnownNodeKind = (typeof KNOWN_NODE_KINDS)[number];

/** Bound on `FlowGraph.nodes` — past this the block reads as absent. */
export const FLOW_MAX_NODES = 24;
/** Bound on `FlowGraph.edges`. */
export const FLOW_MAX_EDGES = 48;
/** `FlowGraphNode.label` ceiling; longer labels are truncated on read. */
export const FLOW_LABEL_MAX_CHARS = 80;
/** `FlowGraphEdge.label` ceiling — it is drawn on a wire, not in a paragraph. */
export const FLOW_EDGE_LABEL_MAX_CHARS = 24;

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
  /**
   * The parsed `## Flow` graph, or null when the manifest has none.
   *
   * `null`, NEVER `undefined`, ON EVERY READ PATH. This is not style — it is
   * the byte-identity guarantee, and getting it wrong is a silent mass-outage:
   * `canonicalApprovalPayload` omits this field from the hashed literal via
   * `m.flow !== null`, and that expression is TRUE for `undefined`. An
   * `undefined` slipping through would therefore serialize a `flow` key for a
   * manifest that has no flow at all, changing the hash of every automation
   * written before this field existed, blocking all of them at once — and a
   * blocked run notifies nobody, by design. Every construction site must state
   * `flow: null` explicitly rather than leaving the property off.
   *
   * A manifest with no `## Flow` section keeps its existing approval untouched
   * and renders a DERIVED graph instead (`deriveFlowFromManifest`), so the
   * upgrade costs no re-approval anywhere.
   */
  flow: FlowGraph | null;
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

// ─── Answer channels + steers ───────────────────────────────────────────────
//
// The review CARD is gone (`review.ts`/`card-registry.ts` deleted in wave 9);
// `AutomationQuestion` below is its successor. These two survive it because a
// question needs them just as much: where an answer arrived from, and the trail
// of corrections a human gave before answering.
//
// The `REVIEW_` prefix is kept deliberately. Renaming these constants would be
// a rename with no behaviour behind it, and their VALUES appear in on-disk
// records written by earlier versions — a question's `answeredVia` reads the
// same strings a card's `resolvedVia` did.

/** Where a verdict or steer came from. Recorded so a card can say who answered
 *  it and from where — and so the OTHER channels can re-render a card that was
 *  resolved somewhere else. */
export const REVIEW_CHANNELS = ['dashboard', 'cli', 'telegram', 'notification'] as const;
export type ReviewChannel = (typeof REVIEW_CHANNELS)[number];

/** One correction a human gave a pending question (or, on the legacy surface, a
 *  pending card). Kept on the record itself — not only in the resumed
 *  transcript — so every channel can show the trail without reading a session
 *  file, and so the distilled lesson stays traceable to its steer. */
export interface QuestionSteer {
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

// ─── Questions (the human-in-the-loop successor to review cards) ────────────
//
// A question is what a run hands a human when it must ask before going on. It
// inherits the review card's one load-bearing property — THE ANSWER RESUMES THE
// SESSION THAT ASKED — and drops the queue around it: the question is delivered
// where the human already is (their own chat, or Telegram), not onto a board
// nobody is standing in front of at 18:00.
//
// That property is why a question stores a `sessionId` and NOTHING RESEMBLING A
// COMMAND. Answering does not execute a payload the question carries; it
// unblocks a conversation the approved prompt already bought. A question that
// carried an executable action would be a genuinely new capability on top of
// `bypassPermissions`; one that says "keep going" is not.
//
// Questions are MACHINE-LOCAL and never brain-synced, for the same reason the
// approval registry is not: a resumable session id is a capability, so a synced
// question invites someone else's machine to resolve yours.

/** Where a question was asked, and therefore where its answer comes back. */
export const HITL_CHANNELS = ['chat', 'telegram'] as const;
export type HitlChannel = (typeof HITL_CHANNELS)[number];

/**
 * WHICH GATE this question belongs to. A SECURITY DISCRIMINATOR, not ergonomics
 * — read this before touching any code that answers a question.
 *
 * - `flow-hitl` — the run is already approved and mid-flight; it stopped to ask.
 *   This is the ONLY kind that may be answered through the verdict machinery
 *   (`resumeWithAnswer` → `buildResumeArgs`), because resuming it continues a
 *   conversation a human already granted `bypassPermissions` to.
 *
 * - `approval` — the manifest CHANGED since it was last approved, and the run
 *   is asking about the diff. It must NEVER reach `resumeWithAnswer`.
 *   `buildResumeArgs` hardcodes `--permission-mode bypassPermissions`, and at
 *   the moment this question exists the manifest is BY DEFINITION unapproved —
 *   resuming it would let an unapproved manifest bootstrap its own elevated
 *   execution, which is precisely the attack the sha256 tripwire exists to
 *   prevent, arriving through a door the tripwire does not watch. Answering
 *   "yes" instead calls `approveAutomation` and starts a FRESH run; the
 *   question's own session is discarded, never continued.
 *
 * The two are one field rather than two stores because every surface renders
 * and routes them identically right up to the answer, and a branch the router
 * must take is safer as a value it cannot forget to read than as a convention.
 */
export const QUESTION_KINDS = ['approval', 'flow-hitl'] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

/** `pending` until a human answers. `expired` is reserved and is NOT written by
 *  any current path: a question deliberately never times out (D-J). An expiry
 *  would silently convert an unanswered question into a resumed run, which is
 *  the exact opposite of what the gate is for. It exists so a future opt-in
 *  expiry has a state to write, and so a lenient read has somewhere to put an
 *  unrecognised value it must not treat as `pending`. */
export const QUESTION_STATES = ['pending', 'answered', 'expired'] as const;
export type QuestionState = (typeof QUESTION_STATES)[number];

/** A question awaiting (or having received) a human's answer. */
export interface AutomationQuestion {
  /** Filename-safe, unique per slug. */
  id: string;
  slug: string;
  /** The scheduled fire the asking run answered for — ties the question back to
   *  its RunEvent without duplicating the event. */
  runFiredAt: string;
  /**
   * The claude conversation that asked, and the whole point of the record: an
   * answer `--resume`s exactly this. null ⇒ the run produced no session id, so
   * the question can be closed but never resumed — surfaces must say so rather
   * than offering a control that cannot work.
   *
   * ALWAYS null when `kind === 'approval'`. That is not incidental: see
   * {@link QUESTION_KINDS}. The authority on what may actually be resumed is
   * never this field anyway — it is the machine-local session binding, which
   * only the runner writes.
   */
  sessionId: string | null;
  /** WHICH GATE — see {@link QUESTION_KINDS}. Security-load-bearing. */
  kind: QuestionKind;
  channel: HitlChannel;
  /** What the human is being asked, in the run's own words. */
  question: string;
  /** The answers offered. Empty ⇒ free text. Never a command — a choice is a
   *  label the asking session interprets, not something a surface executes. */
  choices: string[];
  state: QuestionState;
  answeredAt: string | null;
  answeredVia: ReviewChannel | null;
  /** What the human chose or typed, VERBATIM. */
  answer: string | null;
  /** What the agent said after the answer resumed it — the answer to "so what
   *  actually happened?", which a resolved question is otherwise unable to
   *  give. null until an answer has been acted on. */
  resolutionNote: string | null;
  /**
   * Set when the answer's resume did NOT complete cleanly.
   *
   * Load-bearing, and the reason it is a field rather than a log line: the
   * answer is persisted BEFORE the resume spawns (a crash in that window must
   * not replay the act), so a question whose resume then failed reads
   * `answered` on disk while nothing may have been carried out. Without this
   * field that record is indistinguishable from a clean success — the one state
   * a human must never be shown as done.
   */
  resolutionError: string | null;
  /** Newest LAST — a steer trail reads as a conversation, unlike the LIFO
   *  ledgers elsewhere in the brain, which are scanned newest-first. */
  steers: QuestionSteer[];
  /** Per-channel handles for a question already rendered somewhere (a Telegram
   *  message id, say), so a steer edits it in place instead of posting a second
   *  copy of a question that is still the same question. */
  channelRefs: Record<string, string>;
  createdAt: string;
}

/** Directory holding questions, under `automations/`. Machine-local, never
 *  brain-synced — covered by {@link AUTOMATIONS_REVIEW_GITIGNORE_ENTRIES}. */
export const HITL_DIR = 'hitl';

/** Directory holding review cards, under `automations/`. Machine-local.
 *  LEGACY — superseded by {@link HITL_DIR}. Deliberately still `'review'`: the
 *  review surface is alive until the last of its six importers is migrated, and
 *  repointing this constant early would make the old code read and write the
 *  new directory, colliding with the question store mid-migration. */
export const REVIEW_DIR = 'review';
/** Cap on a steer trail — past this, the oldest steers drop off. A human who
 *  has corrected the same thing this many times is not steering any more, and
 *  the trail is prepended to a resumed session, so it is subject to the same
 *  "never crowd out the actual job" rule as the pattern. Applies to
 *  {@link AutomationQuestion.steers} and, until it is retired, the legacy
 *  card's trail — one cap, because it bounds one prompt. */
export const REVIEW_STEER_LIMIT = 12;
/** Ceiling on a rendered question or card body. Something a human cannot read
 *  on a phone is something that gets rubber-stamped. */
export const REVIEW_BODY_MAX_CHARS = 8_000;
/**
 * Machine-local human-in-the-loop artifacts under `automations/` — questions,
 * none of which may ever be committed. Each holds a live, resumable session
 * id, and `sleep done` auto-commits, so a miss here publishes a
 * `bypassPermissions` capability to every teammate who pulls.
 *
 * THE NAME IS THE CONTRACT. `runner.ts` step 6 and `store.ts` both import this
 * BY NAME and re-ensure it on every run, so extending the VALUE covers a new
 * directory with zero code edit anywhere else — which is exactly why the
 * question directory was added here rather than as a new constant nothing
 * calls.
 *
 * The legacy `automations/review/` line lived here for the duration of the
 * review→question migration and is gone now that the review surface is: T12
 * deleted `review.ts`/`card-registry.ts`, so nothing under `automations/`
 * writes a card any more, and `runner.ts` calls `removeGitignoreEntries` once
 * to strip the stale line from a `.gitignore` written before this migration
 * (never repeats it — `removeGitignoreEntries` is itself idempotent).
 *
 * DELIBERATELY NOT part of {@link AUTOMATIONS_GITIGNORE_ENTRIES}. That array is
 * the base-wildcard set that `automations share` writes negations against, and
 * `negationIsEffective` treats ANY base entry appearing after a negation as
 * having silently killed it. Appending a new base wildcard to an existing
 * `.gitignore` that already carries share negations would therefore report
 * every one of them as broken — a false alarm, since nothing under this
 * directory can match a shared manifest, cache record or output file. It has
 * no shareable direction at all, so it gets its own block and stays out of the
 * ordering dance entirely.
 */
export const AUTOMATIONS_REVIEW_GITIGNORE_ENTRIES = ['automations/hitl/'];
export const AUTOMATIONS_REVIEW_GITIGNORE_ENTRIES_ROOT = ['_dream_context/automations/hitl/'];

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
  /**
   * WHAT this child actually is, so `automations kill` can tell the operator
   * what they are about to kill: the job itself, or the short restricted
   * session that is only asking whether a changed manifest may run.
   *
   * OPTIONAL, and absent reads as `'run'` — the same "a field added later reads
   * as its pre-feature default" discipline `learning`, `review` and `notify`
   * follow on the manifest. A sidecar written before this field existed
   * describes a real run, which is what `'run'` means, so callers read
   * `sidecar.kind ?? 'run'` and no writer is forced to change. There is no
   * hash or byte-identity concern here (a sidecar is machine-local and lives
   * for one run), which is exactly why this may be optional where
   * {@link AutomationManifest.flow} may not.
   */
  kind?: 'run' | 'question';
}

/**
 * A fire that was DUE but could not start, held until the next tick can drain
 * it. Machine-local, never brain-synced: a synced queue would be a remote-write
 * primitive — a teammate pushing an entry would make YOUR machine execute an
 * automation at a time you did not schedule, spending your `bypassPermissions`
 * grant. Same threat class as a synced review card.
 *
 * At most ONE entry per slug, BY CONSTRUCTION (an object key), which IS the
 * "a second enqueue drops the older waiting entry" rule rather than a check
 * that could be forgotten.
 */
export interface QueuedFire {
  slug: string;
  /** The ORIGINAL scheduled fire this entry owes — never the moment it was
   *  enqueued, or draining would advance the watermark to drain time and the
   *  catch-up bound would be measured from the wrong instant. */
  firedAt: string;
  /** When it was parked. Diagnostics only; never used for watermark math. */
  enqueuedAt: string;
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
  /** Hashed because the graph decides what the run's prompt SAYS — which nodes
   *  contribute instructions, whether it must stop and ask before publishing,
   *  and where the report goes. A teammate's synced edit that deletes a `hitl`
   *  node has removed a human gate, exactly like editing `review` back to
   *  `off`, and must block until someone here re-approves.
   *
   *  Always present here (as `null` when the manifest has no flow), unlike the
   *  hash payload, which OMITS it entirely when null — this shape is for
   *  DISPLAY, so there is no byte-identity constraint to preserve and a
   *  reviewer must be able to see that a flow exists at all. */
  flow: FlowGraph | null;
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
 *  names are reserved and cannot be used as a slug.
 *
 *  `'review'` STAYS alongside `'hitl'` even after questions replace cards: the
 *  reservation is about a name colliding with a directory that exists ON DISK,
 *  and `automations/review/` outlives the code that wrote it on any brain that
 *  ever staged a card. Freeing the name would let a new automation called
 *  `review` collide with that directory. Reserving one extra word costs
 *  nothing; un-reserving one is unrecoverable for whoever hits it. */
export const RESERVED_SLUGS = ['cache', 'output', 'review', 'hitl'] as const;
export const APPROVAL_PAYLOAD_VERSION = 'automation-approval/v1';
/** The exact field set `approve` must diff — kept in lockstep with
 *  ApprovalPayloadFields so the CLI's review surface can never diverge from
 *  what is actually hashed. `effort` sits between `model` and
 *  `timeoutMinutes`: all three are execution-envelope levers on an
 *  already-approved prompt. `flow` is LAST, mirroring its position in
 *  `canonicalApprovalPayload`'s literal — the two orders must not drift, or the
 *  surface a human reviews stops matching the bytes that were hashed. */
export const APPROVAL_DIFF_FIELDS = [
  'prompt',
  'outputInstructions',
  'model',
  'effort',
  'timeoutMinutes',
  'outputDir',
  'learning',
  'review',
  'flow',
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
