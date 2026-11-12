import { BUILDER_BRIEF, NO_CHECK_BUILDER_RULES } from './builder-brief.js';
import { BUILDER_NO_BACKGROUND_ENV } from './builder-tools.js';
import { PLANNER_BRIEF } from './planner-brief.js';

/**
 * No tick without evidence (2026-10-13). tests/unit/develop-recipe.test.ts pins these. A mobile-to-web run closed with every check green and
 * a reviewer PASS, and the owner opened an app full of errors that was not responsive: a
 * criterion about what the owner SEES had been ticked from unit tests, by inference. The
 * 2026-10-10 validator experiment had promised to fold "was each criterion OBSERVED, not
 * inferred" into the reviewer's brief when the validator went; it was cancelled before it did.
 * These three lines are that promise, shared by both recipes.
 */
const EVIDENCE_TICK_RULE = `A tick needs its evidence in the same log line: the check's summary line, or, for a
   criterion about what the owner sees, the screenshot paths and the console output from the
   observed check (section 3). No evidence = no tick, and a run with an unticked criterion
   does not close.`;

const OBSERVED_CHECK = `- The observed check, ONCE, after the code PASS and on its build, when a criterion is about
  what the owner sees: open the result in the
  real app or a headless browser at a phone (390 px) and a desktop (1440 px) width, record the
  console errors and failed requests, take a screenshot of each, and READ the screenshots
  yourself. Log their paths and the console output, and tick those criteria here, with that
  evidence, never earlier. Errors, overflow or a broken layout = red. No script of your own and
  no build when the repo has the shared one (\`scripts/verify/lib/app.mjs\` for a longer flow):
  \`dreamcontext builder heavy -- node scripts/verify/look.mjs '<path>' --expect '<text>'\`.
  It runs on the Vite dev server against a scratch vault, as a short check that does not wait
  for a long run. Every browser run goes through \`builder heavy\`.`;

/**
 * The repeat limit in the words a lead needs (2026-10-31): `builder heavy` counts browser runs,
 * builds and full suites (lib/run-budget.ts), so a rule that lived here as prose and did not hold
 * is now the command's. The numbers live there, never here. Since 2026-11-12 (audit OR-8) it
 * counts per code tree, so the fix after a review needs no `--because`; and a red keeps its log
 * (OR-3: 81% of red checks were re-run only to read their output).
 */
const REPEAT_LIMIT = `A red check prints where its whole output is kept and its first failures: READ that log, never
re-run a check to see more of its output, and never pipe it through \`tail\`/\`grep\`.
\`builder heavy\` counts browser runs, builds and full test suites per code tree: a run on code
that changed is new proof and always runs; the same check on the same code is refused (a red
browser run or build earns one more there, for load or a flaky harness).
A red full suite earns none: while its record is red, a second full run exits 77 and prints
\`dreamcontext builder test --failed\`, which reruns only its files. Exit 77 = NOTHING ran: read the result you have, or
change the code. \`--because "<why>"\` is not part of a normal run: only a repeat on unchanged
code needs it, once per run and command, recorded in \`builder budget\`; past it you stop and ask the owner.
A check that already passed on the same code does not run again: \`builder heavy\` and \`builder test\`
print its receipt (when, the command, its log) and exit 0 at once, and a type check also reuses one across
Markdown and version-only changes. \`--fresh\` runs it anyway. Give \`builder heavy\` the check alone: a
pipe (\`| tail\`) or \`;\` hides its exit code, so it keeps no receipt; \`--tail N\` shows the last lines.`;

/**
 * Light work gets a light process (2026-10-31): under the threshold in lib/run-lane.ts and on no
 * guarded path, measured at 7 lines a minute against 23 for larger work. The command reads the
 * diff, so the lead cannot pick its own lane.
 */
const LANE_STEP = `Then read the lane off the diff:

  dreamcontext builder lane --from "$START" --to "$NOW"

It prints \`light: <why>\` or \`full: <why>\`; log the line, you never override it. Light: ONE
\`reviewer\`, who reads the security too, no router and no \`review-pick\`, a browser only when it says something visible
changed or a criterion is about what the owner sees (\`--because\` names that criterion), and no
verify script of your own. Full: the pick below.`;

const END_FINAL_CHECK = `- The final check, ONCE, after the last PASS: \`dreamcontext builder load --reap\` first; \`busy\` = check again every
  ~60 s, for at most 15 min; still busy = run anyway, with at most 2 test workers, and record
  the load line. Then, each through \`dreamcontext builder heavy --\`, the task's Validation
  method when it is a command, the builds and generator scripts the change needs, and the
  observed check below on that build. Nothing of this runs before the code PASS: measured over
  72 reviewed runs, a build or browser pass before the review was redone after its fixes in 83%
  of them. A fix after this check changed the code, so its re-run needs no \`--because\`. A run's own
  proof is the tests of its whole diff, the type checks and the build; the full suite is not
  a run's check. It runs once per release cut, after its build, started with
  \`builder heavy --detach\` and followed with \`--wait <id>\`; a red full run is never run
  again: its red files are kept, and \`dreamcontext builder test --failed\` (no task needed)
  reruns only them plus the tests related to what changed since.`;

/**
 * The end review is picked by the diff, not by the lead (owner, 2026-10-14). One generalist
 * reviewer passed the mobile-to-web port; the multi-review team is what found 2 Critical + 6
 * Major on the Jarvis change. It costs 2-4x one reviewer's tokens (in parallel, so about the
 * same wall time), so it runs where the diff calls for it: the review-router classifies, and
 * `dreamcontext builder review-pick` (src/lib/review-route.ts) decides. The lead synthesizes
 * the team's reports, so it may dedupe but never drop or downgrade a blocking finding: in
 * plain multi-review the synthesizer is a neutral party; here it is the author.
 * Every judge names its effort (owner, 2026-10-24): Opus `high` whatever the lead runs at (an
 * unnamed one inherited it, so a medium lead had medium judges), the router Sonnet `low`.
 */
const END_REVIEW_PICK = `Pick the end review first, in its own step: ONE \`review-router\` sub-agent (Agent tool, model sonnet, effort low) told
to classify \`git diff <START> <NOW> -- <the review's paths, by name>\`. Write its reply to
$ROOT/tmp/develop/$S/route.md, then:

  dreamcontext builder review-pick "$ROOT/tmp/develop/$S/route.md"

It prints \`reviewer: <why>\`, or \`multi-review: <why>; team: <agents>\`: one reviewer for a
small or one-area diff; the team for a Full tier, a hot path, UI plus another area, or areas it
cannot read. Log the line to the task; you never override it. Exit 2 = no plan in the reply:
run the router once more; exit 2 again = the team without a plan: \`review-edge-cases\` and the
\`reviewer\` on every path, plus \`review-frontend\` on the UI files and \`review-security\` on
any auth, secret, env or endpoint file. No \`review-*\` agents in this project? Use
general-purpose agents with the router's and each specialist's mandate.`;

const END_REVIEW_TEAM = `- For \`multi-review\`, instead of that one reviewer: exactly the team the line names, one
  sub-agent each (model opus, effort high, not in the background), the loop opened with
  \`--lenses <the team>\` and each member given its own packet (\`--paths\` = its scope from the
  plan, every changed path when the plan names none for it).
  \`review-edge-cases\` is always on it and also gets the REVIEWER brief's sentence on ticked
  criteria (the packet's rules carry it); a \`reviewer\` on it gets the whole REVIEWER brief.
  Record each member's raw review on its own, never one merged report:
  never drop or downgrade a Critical or Major, since you are the author and their severity is theirs.
  Any Critical or Major = FAIL.`;

/**
 * The review loop (2026-11-08, task develop-inceleme-dongusu-…). Measured over 390 Develop runs:
 * 41 ran 3+ failing reviews in a row; of 180 blocking findings in those loops 42% were holes the
 * previous fix opened, 32% another site of the same class, 17% the same finding unfixed; 39% of
 * the "Major"s were small; the re-reviewer got the previous findings by hand (in 17 of 34 long
 * loops not word for word); "the SAME finding twice = stop" caught none of it, since two thirds
 * of the repeats were the same class in other words. So every round goes through the plan's
 * ledger in code mode (`builder review`, cli/commands/review-loop.ts): the packet is the CLI's,
 * the fix is by class, a Major needs its harm, and a class in its 3rd round is the owner's card.
 */
const REVIEW_LOOP = `Every review round runs through the run's review loop, so the packet, the rounds and the
stops are the CLI's, never your memory or a prompt you write:

  dreamcontext builder review open "$S" --lenses <reviewer, or the team> --start "$START"
  dreamcontext builder review packet "$S" --lens <reviewer> --tree "$NOW" --paths <every path, by name>

Dispatch each reviewer with only "Read <the packet path> and follow it.", save its reply
verbatim to a file, then \`dreamcontext builder review record "$S" --lens <reviewer> --file
<it>\`; \`dreamcontext builder review status "$S"\` prints the ONE next action. No brain in this
checkout: \`open\` takes \`--criteria-file <the task's criteria>\`.

A FAIL is fixed by CLASS, never by the finding's sentence: search every sibling path of the
class (each entry point, field, caller), fix it in ONE place, and read and verify any code a
reviewer suggests before you use it. Then write changes.md in the loop folder, one
\`sweep: <class> | <sibling paths checked> | <the one place fixed>\` line per open class: the
next packet refuses without it. A Major counts only with a concrete harm written out; one
without is recorded as Minor and opens no round. A class in its 2nd counted round asks for a
redesign (a \`redesign:\` line); in its 3rd the loop stops and \`builder review status\` prints
the owner's stop card: ask it as an owner card (a Super Agent never answers it), then record
his pick with \`builder review decide\`. Rounds are never capped.`;

/**
 * After a judge (2026-10-31): 13 minutes an hour went to re-running everything, more than the
 * judges' own 8.5, so a fix runs only the tests it touched and the full check waits for the end.
 * Later rounds read the fix alone at medium effort. Their number stays open: 6 of 10 later rounds
 * found a real bug, so never cap them.
 */
const END_REVIEW_ROUND = `Take the snapshot as FIX (the same three commands), then a fresh reviewer (model opus, effort
medium, not in the background) re-checks only the previous findings and the fix, from its
packet: \`dreamcontext builder review packet "$S" --lens <it> --tree <FIX> --paths <the files
the fix changed>\` hands it \`git diff <the tree it reviewed> <FIX>\` per file, the previous
findings word for word, every reviewer's raw review and your changes.md. It does not re-read
the run. Rounds have no cap; each reads only the newest fix.`;

const END_REVIEW_REROUND = `After a team FAIL, the fresh re-check is one specialist for each that raised a blocking
finding (effort medium), fed only its previous findings word for word and the fix's diff (the
next packet opens the round for exactly them); the router does not run again.

A PARTIAL verdict (reviewer or specialist) means it ran out of turns, not that the change
failed: record it (the loop keeps its text), then dispatch a fresh copy of that agent on the
same packet, which now carries the partial review: it re-states those findings and reads the
\`Not reviewed:\` paths only. The review is done when nothing is left unread; a PARTIAL is never a PASS.`;

const REVIEWER_EVIDENCE = `For each ticked criterion say whether its evidence OBSERVED it or inferred it; a criterion about
what the owner sees, ticked with no screenshot, is FAIL.`;

/**
 * The Develop-mode run recipes, printed by `dreamcontext goal-live recipe develop|fan-out`.
 *
 * The Develop chat briefing (src/server/chat-modes.ts DEVELOP_BRIEFING) carries only the
 * contract; every procedural step lives here. It ships inside the CLI on purpose: the server
 * that renders the briefing and the CLI that prints the recipe are the same install, so the
 * two can never drift the way a skill/references file in a not-yet-updated project could.
 *
 * ── 2026-10-11: the lead builds (owner decision on a measured report) ─────────────────
 * Task every-piece-of-work-gets-the-lightest-process-…, assets/measurement-report-r3.md: on
 * two real tasks, blind-graded, the lead building the plan alone scored the same as builder
 * fan-out (t4 7 vs 6-7, tk2 6 vs 6) for 0.7-1.0 fewer units a task, and fan-out missed every
 * speed and parallelism gate. So `develop` is now the lead-builds recipe: the lead implements
 * each wave, checks it with `builder test`, and ONE clean end reviewer judges the whole change.
 * The v2 fan-out recipe (base + forks, builders run no checks, per-wave review on contract and
 * hot-path waves) is kept unchanged as `fan-out`, opt-in for work that cannot fit one lead
 * session. The lead-edit guard that enforced "the lead writes no product code" is retired.
 *
 * v2 (2026-10-11, harness-plan-v2.md), now FAN_OUT_RECIPE: the lead no longer hand-writes
 * `claude -p` lines. `dreamcontext builder base|fork|spawn|resume|wait|test|status`
 * (src/cli/commands/builder-sessions.ts) start every builder with one argv, keep the registry
 * and do liveness, so the recipe shrinks to WHEN to call them. The per-wave tree snapshot and
 * the diff-tree classification are kept from v1 (plan-review rules R4-R11).
 * tests/unit/develop-recipe.test.ts pins the load-bearing lines of both.
 */
/**
 * Waves live inside the task (owner, 2026-11-09). From 2026-10-23 a map of two or more waves
 * opened one sub-task per wave; agents then filed 39 tasks a day, 17 of them waves, each waiting
 * on the owner's sign-off. Now the waves are logged on the ONE task and a wave sub-task opens
 * only when the owner asks. Runs whose wave sub-tasks already exist keep using them
 * (task-parent.ts waveChildren is still the definition), so the WAVE_ON_SUBTASK, WAVE_CLOSE_409
 * and WAVE_REOPEN branches below stay for them.
 */
const WAVE_SUBTASKS = `**Waves live inside the task.** Each wave's progress, ticks and \`wN green\` line are logged
on "$S"; never open a sub-task per wave (owner, 2026-11-09: a task only for big work, its
waves inside it). Wave sub-tasks open only when the owner asked for them. Check once:

  dreamcontext tasks list --parent "$S" --json     # each child's \`wave\` (null = not a wave)

Wave sub-tasks already exist (an older plan, or the owner asked): use them, as the "With wave
sub-tasks" lines below say. Children that are not waves (filed by sleep, the owner or an
agent) are not yours to build, but they keep "$S" from closing.`;

/** Where a wave's progress goes when it is a sub-task. */
const WAVE_ON_SUBTASK = `With wave sub-tasks: \`dreamcontext tasks status <wave-N> in_progress\` when the wave starts;
   the ticks and the \`wN green\` line go on the WAVE (\`dreamcontext tasks log <wave-N> "wN green: …"\`);
   \`builder test\` (and goal-live, in a fan-out) keeps "$S" (\`--waves M\` = the W parts of the newest map). Green:
   \`dreamcontext tasks complete <wave-N> "<the check's summary line>"\`. A wave never closes
   without a green check.`;

/** The parent's close when a child is still open. */
const WAVE_CLOSE_409 = `A parent with an open child cannot close: the status call is refused and names the open
sub-tasks (409 \`parent_has_open_children\` on the board). Open WAVES mean the run is not done.
An open child that is NOT a wave: move "$S" to \`in_review\` instead and name those sub-tasks.`;

/** Which wave a reopen resumes. */
const WAVE_REOPEN = `With wave sub-tasks, the wave to resume is the open child with the smallest \`wave\` in
\`dreamcontext tasks list --parent "$S" --json\` (closed waves are hidden; the numbers do not
shift), and \`--wave\` always comes from that field. Without them, the \`wN green\` lines.`;

/**
 * No task = small work (owner, 2026-11-09; audit TK-1, 2026-11-12): 88% of the Super's Develop
 * delegations carried no task, and a recipe that presupposed one made the child file it, so the
 * board grew ~7 tasks a day after the rule. Every step below works without one: \`builder open\`,
 * \`builder test\` and \`builder ledger\` take any run name, and the review loop opens with \`--goal\`.
 */
const NO_TASK_PATH = `NO TASK IN YOUR BRIEF = small work (owner, 2026-11-09): create none, and never a sub-task.
S is then a short run name (a-z0-9-, the branch's without its prefix), and every
\`dreamcontext tasks ...\` line below is skipped: the start tree, the wave map, each \`wN green\`
line and every verdict go to $ROOT/tmp/develop/$S/run.md and into your last reply, which the
release note carries. The review loop opens with \`--goal "<what the brief asks>"\` instead of
the task's criteria. Close = your last reply, with no status call. It turns out big (needs a
plan, several lanes, builders): STOP and tell the Super; only the Super or the owner opens the
ONE task.`;

export const DEVELOP_RECIPE = `# Develop run recipe

You are the LEAD and you write the code: build each wave yourself, check it yourself, then
hand the whole change to ONE clean reviewer. Measured on two real tasks (blind-graded): the
lead building the plan alone matched builder fan-out on quality for about 60% of its cost.
Builders are opt-in, for work that cannot fit this session (section 5).

ABOVE EVERY OTHER RULE: never end your turn while a judge you started is still running, and
never stop between waves to ask whether to go on: the owner is not your scheduler.

EACH BASH CALL IS A FRESH SHELL: only the working directory carries over, never a variable.
Start every block below with its own \`S=<task-slug>; ROOT="$(git rev-parse --show-toplevel
2>/dev/null || pwd)"\`, run each block as ONE call, and carry a value to a later block (the
run's START tree) by pasting the literal value printed earlier, or by reading it back from the
task log. Give every \`dreamcontext builder\` call the Bash tool's \`timeout: 600000\`: a check
blocks for up to 9 minutes. Never start anything with the Bash tool's run_in_background.

${NO_TASK_PATH}

## 0. Set up

  S=<task-slug>
  ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
  mkdir -p "$ROOT/tmp/develop/$S"      # check logs and failure state live here, never in OS /tmp
  dreamcontext builder open "$S"

Then the run's start snapshot, so the end reviewer reads exactly this run's changes even in a
checkout other sessions share:

  IDX="$(git rev-parse --absolute-git-dir)/dc-$S.idx"
  REAL="$(git rev-parse --git-path index)"
  [ -f "$REAL" ] && cp "$REAL" "$IDX"
  START="$(GIT_INDEX_FILE="$IDX" git add -A && GIT_INDEX_FILE="$IDX" git write-tree)"
  dreamcontext tasks log "$S" "run start tree $START"

Seed from the real index (an empty one drops tracked files that match .gitignore). Not a git
repo: tell the owner once that there is no net, and keep your own list of changed paths.

## 1. The wave map is your order of work

The plan decides how the run goes, and a map from Plan mode is used unchanged. Its first line
is \`EXECUTION: lead\` (or there is none): this recipe, its lanes built one after another.
\`EXECUTION: fan-out\`: section 5. No map in the task: write one before any code, lead unless
the work cannot fit one session:

  dreamcontext tasks insert "$S" technical_details -- "WAVE MAP: EXECUTION: lead | W1 (a.ts, b.ts: AC1, AC2) | W2 ... | also run: <tests>"

A wave ends where a check can prove something, so the map has as FEW waves as the
dependencies allow, and one wave is fine. A wave is a level of the dependency graph: each names
the waves it waits for (\`W3 (after W1)\`), and a wave that uses only names a contract pins waits
for the wave that pins them, never for the one that implements them. Waves of one level are
independent: the Super runs them as separate sessions at once. Tests are written with the code they test, never in
a test wave. "also run": test files that read a changed file by path (fixtures, manifests,
docs checks), which a related-tests run cannot find.

${WAVE_SUBTASKS}

## 2. Each wave N

1. Build the wave yourself, its tests with it. Stay inside the task's criteria; a plan that
   turns out to be wrong = STOP and say so.
2. Check it ONCE, through the heavy lock (it never fights another session's tests):

  dreamcontext builder test "$S" --wave N --related <every path you changed> --also <also-run tests>

   It type-checks each touched package and runs the tests that import your changes; SHOW its
   output. Exit 0 = GREEN, except a "NOT GREEN: no test covers" line: add that test with
   --also, or record that it is untested. 1 = failures (\`FAIL: <key>\`): fix them, then re-run
   only what failed plus what the fix changed:

  dreamcontext builder test "$S" --wave N --failed --related <files the fix changed>

   75 = a check did not run, and your place in line is KEPT: read who is ahead, do other work,
   then run the same command (\`builder queue\` shows the line). A red that is a timeout under load is the machine:
   record the load line and re-run it before you change code. A key marked \`FAILED 2x\` after
   a second fix = STOP and put it to the owner.
3. Tick that wave's criteria (only what is demonstrably true) and log it:

  dreamcontext tasks log "$S" "wN green: <what landed>; <the check's summary line>"

   ${EVIDENCE_TICK_RULE}
   ${WAVE_ON_SUBTASK}

## 3. After the last wave: the end review first, then the final check ONCE, then close

The code is reviewed first; the build and the observed check run once, after its PASS. Take
the snapshot again as NOW (the same three commands, into the same $IDX), then list the
run's paths:

  git -c core.quotePath=false diff-tree -r -z --name-status "$START" "$NOW"

Parse it NUL-separated. A path you did not change is another session's work in this
checkout: leave it out of the review and log it once.

${LANE_STEP}

${END_REVIEW_PICK}

${REVIEW_LOOP}

Then the end review:

  dreamcontext builder mark review-start || true

- ONE \`reviewer\` sub-agent (Agent tool, model opus, effort high, not in the background) with the reviewer
  brief (section 4, carried by its packet): every path you changed, enumerated by name, with START and NOW, never a
  bare \`git diff\` against a ref. It fetches its own changes; never paste a diff.
${END_REVIEW_TEAM}

Record the verdict BEFORE anything else: \`dreamcontext builder mark review-end || true\`, then
a task-log line with PASS or FAIL.

${END_FINAL_CHECK}
${OBSERVED_CHECK}

A reviewer FAIL or a red final check takes the same path: fix exactly the findings, each across its whole class,
or the failure and nothing else, and check the fix with \`builder test "$S" --wave final --related
<files the fix changed>\`, naming a central file's tests with \`--also\` instead of the file.
Only what the fix touched runs: no build, no browser and no Validation command here, those wait
for the one final check. ${END_REVIEW_ROUND} After a red final check, the fix's reviewer also
reads the ticks and their evidence, then re-run only what was red. Nothing closes on a fix no reviewer has read:

  dreamcontext builder mark review-start || true   # and review-end with its verdict

${END_REVIEW_REROUND}

A class in its 3rd counted round = STOP: the loop prints the owner's card. You never sign off on your own work.

${REPEAT_LIMIT}

${WAVE_CLOSE_409}

Stop the run's clock and carry its one line, from the records, into the status message and
your last message: \`dreamcontext builder ledger "$S" --close\` (code / queue / checks / review).

Close by the task's Validation method (no task: your last reply, as the top of this recipe says):
- A command that passed: \`dreamcontext tasks status "$S" completed "<what shipped + the
  command and its result>"\`.
- A manual or browser check: \`dreamcontext tasks status "$S" in_review "<what to look at>"\`
  and offer the validator. It runs ONLY when the owner asks for it: a clean
  \`goal-validator\` that drives the real app and proves the result with screenshots and a video.

When the owner asks, dispatch ONE \`goal-validator\` (model opus, effort high) with the
validator brief. Log every verdict: \`dreamcontext tasks log "$S" "validator PASS"\` or
\`"validator FAIL: <what>"\`. FAIL: fix the failure, check it, then ONE fresh reviewer of the
fix (log \`"final-fix-reviewer PASS"\`), then the validator again.

PASS: \`dreamcontext tasks status "$S" completed "<what shipped + the evidence>"\`.

## 4. Briefs

The review loop's packet carries the REVIEWER brief for you (criteria, START and NOW, the
scope by name, the evidence sentence, the review rules): the dispatch prompt is only "Read
<the packet path> and follow it."

REVIEWER: "Review the run of <slug> against criteria <list>. Start tree <START>, current tree
<NOW>. Scope (read these yourself with git diff <START> <NOW> -- <path>): <files>. Files with
status A are new: read them whole. ${REVIEWER_EVIDENCE} First line PASS or FAIL."

VALIDATOR: "Validate task <slug> by its 'Validation method:' criterion, in the real app.
Prove it with screenshots and a video of the flow (give their paths). Report PASS or FAIL with
the exact commands and output. Flaky or skipped is FAIL."

## 5. When builders pay: the fan-out recipe

Builders cost more than you building and wrote no better code when measured. They run when
the plan's map says \`EXECUTION: fan-out\` (work that cannot fit one session: many waves of
large, independent lanes), or when the owner asks for builders. Then tell the owner once,
run \`dreamcontext goal-live recipe fan-out\`, and follow it from its section 0, which opens
the run builders hang off. You do not switch on your own mid-run: a lead plan that turns out too big for this session is a
wrong plan, so STOP and say so.

## 6. Reopen or handoff

A run that used builders is NOT reopened by this recipe: when \`dreamcontext builder status "$S"\`
lists sessions, or the task log has \`wN start tree\` lines (a fan-out run, or a run started
before builders became opt-in), follow section 6 of \`dreamcontext goal-live recipe fan-out\`
instead, since a builder may still be writing its files.

The last \`run start tree\` line in the task log is START; ticked
criteria and \`wN green\` lines say which waves are done. A review in progress is the loop's:
\`dreamcontext builder review status "$S"\` prints its round, open classes and next action.
A \`test-wN.json\` in tmp/develop/$S/
holds the failures still open: \`builder test "$S" --wave N --failed\`. A validator FAIL newer
than any final-fix-reviewer PASS = fix it, then final-fix-reviewer, then the validator: never
re-validate an unreviewed fix.

${WAVE_REOPEN}
`;

/**
 * The v2 builder fan-out (2026-10-11), opt-in since the same day: the default recipe sends the
 * lead here only when the plan's map says `EXECUTION: fan-out` (work that cannot fit one lead
 * session), or when the owner asks for builders. Lanes have no fixed count since the same
 * evening: the old cap of 3 protected a machine on which every builder ran its own tests.
 */
export const FAN_OUT_RECIPE = `# Develop fan-out recipe (opt-in)

Follow this only when the default recipe (\`dreamcontext goal-live recipe develop\`, section 5)
sent you here: the plan's map says \`EXECUTION: fan-out\`, or the owner asked for builders.

You are the LEAD. Builders write the product code and its tests; you run the checks, route
failures and dispatch the judges. In a fan-out run you write no product code: every file
belongs to a lane.

ABOVE EVERY OTHER RULE: never end your turn while a builder or judge you started is still
running. Block on \`dreamcontext builder wait\` (2d): the owner is not your scheduler.

Every goal-live call is telemetry, never a gate: end each one with \`|| true\`, never chain
work after it with \`&&\`, and put it on its own line.

EACH BASH CALL IS A FRESH SHELL: only the working directory carries over, never a variable.
Start every block below with its own \`S=<task-slug>; ROOT="$(git rev-parse --show-toplevel
2>/dev/null || pwd)"\`, run each block as ONE call, and carry a value to a later block (a
wave's START tree) by pasting the literal value printed earlier, or by reading it back from
the task log (section 6). Give every \`dreamcontext builder\` call the Bash tool's
\`timeout: 600000\`: base, wait and test block for up to 9 minutes.

## 0. Set up

  S=<task-slug>
  ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
  mkdir -p "$ROOT/tmp/develop/$S"      # briefs, logs and the builder registry live here, never in OS /tmp
  dreamcontext goal-live start --goal "$S" --mode develop || true
  dreamcontext builder open "$S"

\`start\` ADOPTS this task's unfinished Develop run (this pane's, or any pane's idle 10+ min),
so a reopen or handoff keeps the map, the reviewed count and the receipt. "another chat is
running this goal" = two Develop chats on one task: stop and tell the owner.

Every builder session is started by \`dreamcontext builder\`, never by a \`claude -p\` line you
write. It runs each one as a detached \`claude -p\` (\`--resume\` for a fork or a fix) with
DREAMCONTEXT_SPAWNED=develop, ${BUILDER_NO_BACKGROUND_ENV}, \`--permission-mode acceptEdits\`,
a scoped \`--allowedTools\` list, a pinned model and effort, and this pane's identity stripped;
it keeps the registry in tmp/develop/<slug>/builders.json, writes the task-log lines and puts
each builder on the live map. Builders never call goal-live.
Never start anything with the Bash tool's run_in_background.

## 1. The wave map (before any code changes)

Read the task. If it has no wave map, write one into it:

  dreamcontext tasks insert "$S" technical_details -- "WAVE MAP: W1 lanes A (owns a.ts, b.ts: AC1, AC2), B (owns c.ts: AC3) | W2 ... | also run: <tests>"

Rules: criteria grouped per wave; a wave's lanes are its truly disjoint file groups, with no
fixed count (each is one parallel builder); every lane owns DISJOINT files; a later wave may
depend on an earlier one, never on a sibling lane. A task that arrived from Plan mode with a
wave map is used unchanged. On an adopted run whose impl.waves differs from
the task's wave map, start fresh: \`dreamcontext goal-live clear || true\` on one line, then
\`start\` again on the next.

Every wave costs a snapshot, the slowest lane and a check, in series, so the map has as FEW
waves as the dependencies allow:
- Wave count = the longest dependency chain. A criterion goes in the EARLIEST wave whose
  inputs exist; each wave after W1 names what it consumes from an earlier one, or merges back.
  A wave that uses only names a contract pins (a route, a type, a field) waits for the wave
  that pins them, never for the one that implements them: a chain they do not force is a wrong map.
- Criteria that share a file share a lane. A file clash is never a reason for a new wave.
- Tests are written in the lane that writes their code, never a test wave.
- Verify scripts and docs join the earliest wave that fits (against the task's stated
  contract), never a closing wave of their own.
- A topic split (server, then client, then docs) is not a dependency.

Mark a wave REVIEWED when it is a contract wave (a later wave consumes its API, schema or
types) or touches a hot path (money, auth, secrets, migrations, outbound messages): it gets
its own reviewer (2f). Every other wave is reviewed once, at the end of the run (section 3).
"also run": test files that read a changed file by path (fixtures, manifests, docs checks),
which a related-tests run cannot find.

${WAVE_SUBTASKS}

## 2. Each wave N

### 2a. Start snapshot (whole tree, per wave)

Precondition: no builder of an earlier wave is running (\`dreamcontext builder status "$S"\`).
Then:

  IDX="$(git rev-parse --absolute-git-dir)/dc-$S-wN.idx"
  REAL="$(git rev-parse --git-path index)"
  [ -f "$REAL" ] && cp "$REAL" "$IDX"
  START="$(GIT_INDEX_FILE="$IDX" git add -A && GIT_INDEX_FILE="$IDX" git write-tree)"
  dreamcontext tasks log "$S" "wN start tree $START"

Seed from the real index (an empty one drops tracked files that match .gitignore). The index
file lives in the git dir and is keyed by task. Not a git repo: tell the owner once that
there is no per-wave net, and continue on the declared + reported lists. A snapshot that
takes minutes (a huge untracked file): tell the owner once.

### 2b. The builder base (once per run, before the first fork)

A run with 2+ lanes in total forks every builder from ONE base session that reads what the
lanes share, once; each fork reads it back from the prompt cache instead of exploring again.
A run that is a single lane has no base: it uses \`builder spawn\` (2c).

Write $ROOT/tmp/develop/$S/base.md (section 5, BASE) and mint it:

  dreamcontext builder base "$S" --prompt-file "$ROOT/tmp/develop/$S/base.md"

It blocks until the base is ready (exit 4 = still minting: \`dreamcontext builder wait "$S"\`)
and prints its size. Over 150k tokens every fork re-reads too much on every turn: narrow the
reading list and mint again with \`--remint\`.

### 2c. Start the builders (never write the code yourself)

  dreamcontext goal-live phase impl --wave N --waves M || true
  dreamcontext builder load --reap

\`quiet\` = start every lane of the wave at once (builders run no checks, so a lane costs the
machine little). \`busy\` (1-min load above the core count) = 2 lanes at a time this wave; the
rest start as those finish. Every builder shares one machine with whatever else is running.

Per lane L (ids are wave-qualified: \`wN-L\`, never a bare lane name), write its brief to
$ROOT/tmp/develop/$S/wN-L.md (section 5, BUILDER), then:

  dreamcontext builder fork "$S" wN-A --owns <files...> --prompt-file "$ROOT/tmp/develop/$S/wN-A.md" --name "<what it builds>"
  dreamcontext builder fork "$S" wN-B --owns <files...> --prompt-file "$ROOT/tmp/develop/$S/wN-B.md" --name "<what it builds>"

Fork every lane of the wave at once: forks of one base read it from the cache side by side.
A fork's first turn can take minutes (it plans its whole lane from what it inherited), so
never wait for one fork before starting the next. \`builder wait\` and \`builder status\` show
each fork's first-call cache read; a line marked CACHE MISS = start the next waves' lanes
with \`dreamcontext builder spawn\` (same flags) and tell the owner once, since a fork that
misses costs more than a fresh builder. A single-lane run: \`dreamcontext builder spawn "$S" w1-A --owns ...
--prompt-file ... --name ...\`. Builders run at medium effort (measured: xhigh took 2.4x the
time for no better code); \`--effort high\` on \`base\` or \`spawn\` only for a lane whose
design is still open.

The CLI refuses a lane whose files overlap another lane of its wave, a second run of a lane
id (resume it instead) and a fork without a ready base. Read the message; never work around it.

### 2d. Work in parallel, then wait

While the lanes run, do what does not need their output: the next wave's briefs, the base
delta, the owner's questions. Then block on ONE command:

  dreamcontext builder wait "$S"

Exit 0 = every lane returned. 4 = the 9-minute slice ended with lanes still running: run it
again. 5 = one needs you: \`unfinished\` (no report) = resume it ONCE with "Write your final
report now: '## wN-L report', then 'files changed:'"; \`paused\` (usage limit) = resume the
same lane later; \`crashed\` or \`stalled\` = resume once, a second time = stop and tell the
owner. Each result is printed once.

### 2e. Wave end: the net, then ONE check

1. Owned files changed on disk? A lane whose owned files did not change did not build.
2. Take the same snapshot again as NOW (same three commands, into the same $IDX), then:

  git -c core.quotePath=false diff-tree -r -z --name-status "$START" "$NOW"

   Parse it NUL-separated. Classify every changed path:
   - reported by two builders, or by a builder whose lane does not own it = COLLISION: stop
     the wave, recheck both lanes' criteria.
   - changed but claimed by NO builder = "changed during this wave, unclaimed": it goes to
     the reviewer, who judges whether it belongs to this wave's criteria; if it does it is
     reviewed with the wave and you tell the owner once (one task-log line per path, never
     repeated); if not, log it as another session's work.
   - your own paths (this task file, the goal-live file, tmp/) are never "unclaimed".
   Wave N's scope = the lanes' declared owned files + every path a wave-N builder reported.
   An "outside my files" item in a report goes to the lane that owns that file, by resume.
3. The check, once, for the whole wave: every path the wave changed plus the map's also-run list:

  dreamcontext builder test "$S" --wave N --related <every changed path> --also <also-run tests>

   It type-checks each touched package and runs the tests that import the changes, through
   the heavy lock; SHOW its output. Exit 0 = GREEN, except a "NOT GREEN: no test covers"
   line: add that test with --also, or record that it is untested. 1 = failures, each printed
   as \`FAIL <owning lane>: <key>\`. 75 = a check did not run, its place in line is kept: run it again. A REVIEWED wave
   dispatches its reviewer (2f) in the SAME message as this call, so both run at once.
4. Failures: per owning lane, write exactly its FAIL lines and the relevant log lines to
   $ROOT/tmp/develop/$S/wN-L-fix.md and resume it (a failure no lane owns goes to the lane
   whose change caused it, the producer of a contract before its consumer):

  dreamcontext builder resume "$S" wN-L --message-file "$ROOT/tmp/develop/$S/wN-L-fix.md"

   then \`dreamcontext builder wait "$S"\`, then re-run only what failed plus what the fix changed:

  dreamcontext builder test "$S" --wave N --failed --related <files the fix changed>

   A key marked \`FAILED 2x\`, or the CLI refusing a 4th resume = STOP and put it to the owner.
   A red that is a timeout under load is the machine: record the load line and re-run it
   before you resume anyone.

### 2f. The reviewer of a REVIEWED wave

  dreamcontext goal-live phase codereview --wave N || true
  dreamcontext goal-live actor wN-reviewer --kind fresh --role reviewer --wave N || true
  dreamcontext builder mark review-start || true

Dispatch ONE \`reviewer\` sub-agent (Agent tool, model opus, effort high, not in the background; a later round: effort medium, only the fix) with the
reviewer brief (section 5), in the same message as the wave's \`builder test\` call. Its
rounds are the wave's own review loop (section 3's loop with \`--loop wN\` on every
\`builder review\` call and the wave's START): its packet is the brief. It
fetches its own changes; never paste a diff. Record the verdict BEFORE the next phase:

  dreamcontext builder mark review-end || true
  dreamcontext goal-live state wN-reviewer=PASS --wave N || true

FAIL: re-enter the build for this wave, resume the owning builder with EXACTLY the findings
and the class rule (fix each class on every sibling path, in one place; verify any suggested
code first; report the paths checked) (2e step 4), check again, write changes.md from its
report, then re-enter the review and call a fresh reviewer that re-checks
only the previous findings and the fix. The phase calls make the retry a round on the map:

  dreamcontext goal-live phase impl --wave N || true
  dreamcontext goal-live phase codereview --wave N || true
  dreamcontext goal-live actor wN-reviewer --kind fresh --role reviewer --wave N --round 2 || true
  dreamcontext builder mark review-start || true   # and review-end with its verdict

A class in its 3rd counted round = STOP: the loop prints the owner's card.

Reviewing only REVIEWED waves REVERSES the owner's 2026-09-26 call that a reviewer closes
every wave (owner, 2026-10-11): the wave-end check catches what a lane breaks, the plan
catches a hot path's design faults, and one end review reads the rest for a fraction of the
wall time.

### 2g. Close the wave

Only when its check is GREEN and its reviewer (if any) passed: tick that wave's criteria
(only what is demonstrably true) and log it.
   ${EVIDENCE_TICK_RULE}
   ${WAVE_ON_SUBTASK}
Before the next wave, update the base with what
landed: write $ROOT/tmp/develop/$S/base-delta-wN.md (the files each lane changed, the
contracts they export, the decisions taken), then

  dreamcontext builder base "$S" --update "$ROOT/tmp/develop/$S/base-delta-wN.md" --wave N

The delta is in the task log before the base reads it. Refused over 150k tokens: mint a
fresh base from the task doc with \`--remint --prompt-file\`. No update after the last wave.

## 3. After the last wave: one end review, the final check, then close

${END_REVIEW_PICK}
The review's paths are the scope below: a run whose end review is skipped skips the pick too,
and a review of the ticks alone is always one reviewer.

${REVIEW_LOOP} In a fan-out run the owning lane makes the fix: its resume message carries
the class rule, and you write changes.md from its report.

Then the end review:

  dreamcontext builder open "$S" --phase end
  dreamcontext goal-live phase codereview || true
  dreamcontext goal-live actor end-reviewer --kind fresh --role reviewer || true

When it runs, \`dreamcontext builder mark review-start || true\` first; a skipped review writes no mark.

- ONE \`reviewer\` (model opus, effort high, not in the background) over the union of every wave's scope
  no wave reviewer read, enumerated by name, with the wave-1 START tree: never a bare
  \`git diff\` against a ref. A run whose every wave was REVIEWED skips it, unless a criterion
  is about what the owner sees: then this reviewer still runs, after the final check, over the
  task's ticks and their evidence alone, since no wave reviewer saw a tick.
${END_REVIEW_TEAM}
  The map keeps one seat for the team: \`goal-live actor end-reviewer=multi-review\`, with the
  merged verdict.
${END_FINAL_CHECK}
${OBSERVED_CHECK}

${REPEAT_LIMIT}

Record \`dreamcontext goal-live state end-reviewer=PASS || true\`, with \`dreamcontext builder mark review-end || true\` when a review ran. A finding or a red resumes
the owning lane (2e step 4, re-checked with \`--wave final\` on the files the fix changed, a
central file's tests named with \`--also\`, no build and no browser; an end-review round passes \`--force\` to \`builder resume\`, since rounds
are not capped). ${END_REVIEW_ROUND}

  dreamcontext goal-live actor end-reviewer --kind fresh --role reviewer --round 2 || true
  dreamcontext builder mark review-start || true   # and review-end with its verdict

${END_REVIEW_REROUND}

${WAVE_CLOSE_409}

Stop the run's clock and carry its one line, from the records, into the status message and
your last message: \`dreamcontext builder ledger "$S" --close\` (code / queue / checks / review).

Close by the task's Validation method:
- A command that passed: \`dreamcontext goal-live phase done || true\`, then \`dreamcontext
  tasks status "$S" completed "<what shipped + the command and its result>"\`.
- A manual or browser check: \`dreamcontext tasks status "$S" in_review "<what to look at>"\`
  and offer the validator. It runs ONLY when the owner asks for it: a clean
  \`goal-validator\` that drives the real app and proves the result with screenshots and a video.

When the owner asks:

  dreamcontext goal-live phase validate || true
  dreamcontext goal-live actor validator --kind fresh --role validator || true

Dispatch ONE \`goal-validator\` (model opus, effort high) with the validator brief. Log every verdict:
\`dreamcontext tasks log "$S" "validator PASS"\` or \`"validator FAIL -> wM-L"\`, and record it
with \`goal-live state validator=PASS|FAIL || true\`. FAIL: the phase STAYS validate. Never
call \`phase impl\` or \`phase codereview\` after \`phase validate\`. Resume the owning
builder with the failure, check it, then ONE fresh reviewer, wave-less, then the validator again:

  dreamcontext goal-live actor final-fix-reviewer --kind fresh --role reviewer || true
  dreamcontext goal-live state final-fix-reviewer=PASS || true
  dreamcontext goal-live actor validator --kind fresh --role validator --round 2 || true

PASS: \`dreamcontext goal-live phase done || true\` and \`dreamcontext tasks status "$S"
completed "<what shipped + the evidence>"\`.

## 4. Sessions

\`dreamcontext builder status "$S"\` lists every session of the task without blocking: the
base (state, size, the wave it absorbed) and each lane (state, round, effort, and a fork's
first-call cache read). A running builder is WAITED on, never resumed: the CLI refuses to
resume a live session (two writers on one conversation). A resume reuses the lane's own
model, effort and account. A usage-limit ending is a pause: resume the SAME lane later.
Every account capped: stop and tell the owner.

## 5. Briefs

BASE: "Read _dream_context/state/<slug>.md, then read in full the files the lanes will change
or call: <files by name, never whole directories>. Do not edit, run or test anything. Reply
'BASE READY' and, in at most ten lines, the contracts the lanes share."

BUILDER: "Your lane: <criteria>. You own ONLY: <files>. <What you consume from an earlier
wave or produce for a later one: exact names and shapes>. Build exactly that.
<A spawned builder, not a fork, also gets: Read _dream_context/state/<slug>.md first.>
Never call dreamcontext goal-live.
${NO_CHECK_BUILDER_RULES}
Your final message starts with the exact heading '## wN-L report', then a line 'files changed:'
followed by every path you created, edited or deleted, then 'outside my files:' (what you
found broken or missing elsewhere, or none), then your assumptions."

REVIEWER: "Review <wave N | the run> of <slug> against criteria <list>. Start tree <START>,
current tree <NOW>. Scope (read these yourself with git diff <START> <NOW> -- <path>):
<files>. Files with status A are new: read them whole. Changed during this wave, unclaimed:
<paths or none>; say for each whether it belongs to it. ${REVIEWER_EVIDENCE} First line PASS or
FAIL."

VALIDATOR: "Validate task <slug> by its 'Validation method:' criterion, in the real app.
Prove it with screenshots and a video of the flow (give their paths). Report PASS or FAIL with
the exact commands and output. Flaky or skipped is FAIL."

## 6. Reopen or handoff

First adopt the run, which keeps its builders on this pane:

  dreamcontext goal-live start --goal "$S" --mode develop || true

Then reconcile: \`dreamcontext builder status "$S"\` says where
every session is, and the last \`wN start tree\` line in the task log is the current wave's
START. Running = wait; reported but not checked = 2e; unfinished or crashed = resume once.
A review in progress: \`dreamcontext builder review status "$S" [--loop wN]\`. A
\`test-wN.json\` in tmp/develop/$S/ holds the failures still open: \`builder test "$S" --wave N
--failed\`. A validator FAIL newer than any final-fix-reviewer PASS = wait for the builder,
then final-fix-reviewer, then the validator: never re-validate an unreviewed fix. Builder
sessions never take over this chat's own conversation id.

${WAVE_REOPEN}
`;

/** Every recipe `goal-live recipe <name>` knows. */
export const GOAL_LIVE_RECIPES: Readonly<Record<string, string>> = {
  develop: DEVELOP_RECIPE,
  'fan-out': FAN_OUT_RECIPE,
  'builder-brief': BUILDER_BRIEF,
  'planner-brief': PLANNER_BRIEF,
};
