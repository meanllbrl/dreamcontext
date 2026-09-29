/**
 * The Develop-mode run recipe, printed by `dreamcontext goal-live recipe develop`.
 *
 * The Develop chat briefing (src/server/chat-modes.ts DEVELOP_BRIEFING) carries only the
 * contract; every procedural step lives here. It ships inside the CLI on purpose: the server
 * that renders the briefing and the CLI that prints the recipe are the same install, so the
 * two can never drift the way a skill/references file in a not-yet-updated project could.
 *
 * Every rule below was paid for by a plan-review round (task
 * develop-mode-runs-like-goal-skill-…, rules R4-R11). tests/unit/develop-recipe.test.ts pins
 * the load-bearing lines: the builder env strip, the registry line shape, the snapshot
 * commands, liveness, the reopen rules and the goal-live call discipline.
 */
export const DEVELOP_RECIPE = `# Develop run recipe

You are the LEAD. Builders write the product code; one clean reviewer closes every wave; one
clean validator closes the run. Your Edit/Write tools only reach _dream_context/ and tmp/.

Every goal-live call is telemetry, never a gate: end each one with \`|| true\`, never chain
work after it with \`&&\`, and put it on its own line.

EACH BASH CALL IS A FRESH SHELL: only the working directory carries over, never a variable.
Start every block below with its own \`S=<task-slug>; ROOT="$(git rev-parse --show-toplevel
2>/dev/null || pwd)"\`, run each block as ONE call, and carry a value to a later block (the
wave's BASE, a lane's sid, pid and cfg) by pasting the literal value printed earlier, or by
reading it back from the task log (section 6).

## 0. Set up

  S=<task-slug>
  ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
  mkdir -p "$ROOT/tmp/develop/$S"      # briefs + builder logs live here, never in OS /tmp
  dreamcontext goal-live start --goal "$S" --mode develop || true

\`start\` ADOPTS this task's unfinished Develop run (this pane's, or any pane's idle 10+ min),
so a reopen or handoff keeps the map, the reviewed count and the receipt. "another chat is
running this goal" = two Develop chats on one task: stop and tell the owner.

## 1. The wave map (before any code changes)

Read the task. If it has no wave map, write one into it:

  dreamcontext tasks insert "$S" technical_details -- "WAVE MAP: W1 lanes A (owns a.ts, b.ts: AC1, AC2), B (owns c.ts: AC3) | W2 ..."

Rules: criteria grouped per wave; at most 3 lanes a wave; every lane owns DISJOINT files
(check the lists against each other before spawning); a later wave may depend on an earlier
one, never on a sibling lane. A task that arrived from Plan mode with a wave map is used
unchanged. On an adopted run whose impl.waves differs from the task's wave map, start fresh:
\`dreamcontext goal-live clear || true\` on one line, then \`start\` again on the next.

## 2. Each wave N

### 2a. Base snapshot (whole tree, per wave)

Precondition: no builder of an earlier wave is alive (\`kill -0 <pid>\` on every lane in the
registry, section 4). Then:

  IDX="$(git rev-parse --absolute-git-dir)/dc-$S-wN.idx"
  REAL="$(git rev-parse --git-path index)"
  [ -f "$REAL" ] && cp "$REAL" "$IDX"
  BASE="$(GIT_INDEX_FILE="$IDX" git add -A && GIT_INDEX_FILE="$IDX" git write-tree)"
  dreamcontext tasks log "$S" "wN base $BASE"

Seed from the real index (an empty one drops tracked files that match .gitignore). The index
file lives in the git dir and is keyed by task. Not a git repo: tell the owner once that
there is no per-wave net, and continue on the declared + reported lists. A snapshot that
takes minutes (a huge untracked file): tell the owner once.

### 2b. Spawn the builders (never write the code yourself)

  dreamcontext goal-live phase impl --wave N --waves M || true

Per lane L (ids are wave-qualified: \`wN-L\`, never a bare lane name):

  SID="$( (uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid) | tr 'A-Z' 'a-z')"
  CFG="\${CLAUDE_CONFIG_DIR:--}"      # the RAW value: - = the machine's own account
  # the brief: write it to $ROOT/tmp/develop/$S/wN-L.md (section 5)
  env -u DREAMCONTEXT_TAB_SESSION -u DREAMCONTEXT_SERVER_PID -u DREAMCONTEXT_DEVELOP_LEAD -u CLAUDE_CODE_SESSION_ID -u DREAMCONTEXT_DEFERRED_PROMPT DREAMCONTEXT_SPAWNED=develop nohup claude -p "$(cat "$ROOT/tmp/develop/$S/wN-L.md")" --session-id "$SID" --model opus --permission-mode acceptEdits --allowedTools "Read Glob Grep Write Edit MultiEdit Bash" --output-format json > "$ROOT/tmp/develop/$S/wN-L.log" 2>&1 &
  PID=$!
  dreamcontext tasks log "$S" "wN-L spawned sid $SID pid $PID cfg $CFG"
  dreamcontext goal-live actor wN-L="<what it builds>" --kind spawn --role implementer --wave N --session "$SID" || true

The env strip is REQUIRED: a nohup'd builder otherwise hijacks this pane's resume id.
DREAMCONTEXT_SPAWNED=develop is REQUIRED too: it keeps the builder's session out of sleep debt
and out of sleep directives, even before its goal-live registration below lands.
\`cfg -\` means CLAUDE_CONFIG_DIR was unset (the primary account): never record or set it to
$HOME/.claude, since any value relocates ~/.claude.json and loses the login.
Never start a builder with the Bash tool's run_in_background: it reads as finished at once,
and the nohup'd process is the real run. Builders never call goal-live themselves.
Register each builder on its own line, with literal values: never through a loop that splits
a string (zsh never word-splits one, so the id arrives as "wN-L <sid> <pid>" and is refused).
Never send goal-live's output to /dev/null: a refused call prints why on stderr, and a builder
it refused never appears in the chat.

### 2c. Wait, then gate

Wait for every lane (section 4). Each builder ends with a "files changed" list.

1. Owned files changed on disk? A lane whose owned files did not change did not build.
2. Build + test: run them, SHOW the command and its real output.
3. Take the same snapshot again as NOW (same three commands, into the same $IDX), then:

  git -c core.quotePath=false diff-tree -r -z --name-status "$BASE" "$NOW"

   Parse it NUL-separated. Classify every changed path:
   - reported by two builders, or by a builder whose lane does not own it = COLLISION: stop
     the wave, recheck both lanes' criteria.
   - changed but claimed by NO builder = "changed during this wave, unclaimed": goes in the
     reviewer's brief. The reviewer judges whether it belongs to this wave's criteria; if it
     does it is reviewed with the wave and you tell the owner once (one task-log line per
     path, never repeated); if not, log it as another session's work.
   - your own paths (this task file, the goal-live file, tmp/) are never "unclaimed".
   Wave N's scope = the lanes' declared owned files + every path a wave-N builder reported.

### 2d. One clean reviewer, scoped to the wave

  dreamcontext goal-live phase codereview --wave N || true
  dreamcontext goal-live actor wN-reviewer --kind fresh --role reviewer --wave N || true

Dispatch ONE \`reviewer\` sub-agent (Agent tool, model opus) with the reviewer brief (section
5). It fetches its own changes; never paste a diff. The LAST wave's reviewer gets the union of
every wave's scope, enumerated by name, with the wave-1 base: never a bare \`git diff\`
against a ref. Record the verdict BEFORE the next phase:

  dreamcontext goal-live state wN-reviewer=PASS --wave N || true

FAIL: re-enter the build for this wave, resume the owning builder with EXACTLY the findings
(section 4 resume), gate again, then re-enter the review and call a fresh reviewer. The phase
calls are what make the retry a round on the map and a re-review on the receipt:

  dreamcontext goal-live phase impl --wave N || true
  # section 4 resume of the owning lane, then the gate (2c)
  dreamcontext goal-live phase codereview --wave N || true
  dreamcontext goal-live actor wN-reviewer --kind fresh --role reviewer --wave N --round 2 || true

The SAME finding twice = STOP and put it to the owner.
Only after PASS: tick that wave's criteria (only what is demonstrably true), log it, and
start wave N+1.

## 3. After the last wave: validate

  dreamcontext goal-live phase validate || true
  dreamcontext goal-live actor validator --kind fresh --role validator || true

Dispatch ONE \`goal-validator\` (model opus) with the validator brief. Log every verdict:
\`dreamcontext tasks log "$S" "validator PASS"\` or \`"validator FAIL -> wM-L"\`, and record it
with \`goal-live state validator=PASS|FAIL || true\`.

FAIL: the phase STAYS validate. Never call \`phase impl\` or \`phase codereview\` after
\`phase validate\`. Resume the owning builder with the failure (section 4 resume, logged as
usual), gate, then ONE fresh reviewer, wave-less, then re-run the validator:

  dreamcontext goal-live actor wM-L --kind resume --role implementer --wave M --round 2 || true
  dreamcontext goal-live actor final-fix-reviewer --kind fresh --role reviewer || true
  dreamcontext goal-live state final-fix-reviewer=PASS || true
  dreamcontext goal-live actor validator --kind fresh --role validator --round 2 || true

PASS: \`dreamcontext goal-live phase done || true\` and \`dreamcontext tasks status "$S"
completed "<what shipped + the evidence>"\`, or \`in_review\` when a human should still eyeball
something.

## 4. The builder registry (task log lines) and liveness

Every lifecycle line carries the full identity; the NEWEST line per lane is authoritative:

  wN-L spawned sid <uuid> pid <pid> cfg <config dir>
  wN-L resumed sid <uuid> pid <pid> cfg <config dir>
  wN-L respawned sid <uuid> pid <pid> cfg <config dir>
  wN-L done | wN-L stalled

Alive = \`kill -0 $PID\` AND \`ps -p $PID -o command=\` contains the sid. A live builder is
WAITED on, never resumed (two writers on one conversation).

Progress = the mtime of the builder's TRANSCRIPT, found under the lane's RECORDED cfg (never
your current env: an account switch moves you, not the builder). \`cfg -\` looks in the
default dir:

  CFGDIR="$cfg"; [ "$CFGDIR" = "-" ] && CFGDIR="$HOME/.claude"
  find "$CFGDIR/projects" -maxdepth 2 -name "$SID.jsonl"

Newest by mtime if several; classify on empty output, never on error text. Not found yet
while the pid is alive is its own state, not a stall: measure staleness from
\`ps -p $PID -o etime=\` instead. Never judge by the .log (json output writes nothing until
exit). No transcript growth for 20 min = stalled: kill it, resume once, then stalled again =
stop and tell the owner.

Resume (always under the recorded cfg; \`cfg -\` = UNSET the variable, never set it):

  # set -- , not a string (zsh never word-splits a string variable), and "$@" right after the
  # -u flags, before DREAMCONTEXT_SPAWNED: "$@" may be -u, and env takes everything after a
  # NAME=value as the command to run
  if [ "$cfg" = "-" ]; then set -- -u CLAUDE_CONFIG_DIR; else set -- CLAUDE_CONFIG_DIR="$cfg"; fi
  env -u DREAMCONTEXT_TAB_SESSION -u DREAMCONTEXT_SERVER_PID -u DREAMCONTEXT_DEVELOP_LEAD -u CLAUDE_CODE_SESSION_ID -u DREAMCONTEXT_DEFERRED_PROMPT "$@" DREAMCONTEXT_SPAWNED=develop nohup claude -p "<exactly the findings, or: continue>" --resume "$SID" --model opus --permission-mode acceptEdits --allowedTools "Read Glob Grep Write Edit MultiEdit Bash" --output-format json >> "$ROOT/tmp/develop/$S/wN-L.log" 2>&1 &
  dreamcontext tasks log "$S" "wN-L resumed sid $SID pid $! cfg $cfg"
  dreamcontext goal-live actor wN-L --kind resume --role implementer --wave N --round <r> --session "$SID" || true

A usage-limit ending is a pause: resume the SAME sid later. Every account capped: stop and
tell the owner.

## 5. Briefs

BUILDER: "You are builder wN-L on task <slug>. Read _dream_context/state/<slug>.md. Your lane:
<criteria>. You own ONLY: <files>. Build exactly that, run the build and tests, and do not
touch other files. Never call dreamcontext goal-live. End with a line 'files changed:'
followed by every path you created, edited or deleted."

REVIEWER: "Review wave N of <slug> against criteria <list>. Base tree <BASE>, current tree
<NOW>. Scope (read these yourself with git diff <BASE> <NOW> -- <path>): <files>. Files with
status A are new: read them whole. Changed during this wave, unclaimed: <paths or none>; say
for each whether it belongs to this wave. First line PASS or FAIL."

VALIDATOR: "Validate task <slug> by its 'Validation method:' criterion. Run it yourself;
report PASS or FAIL with the exact command and output. Flaky or skipped is FAIL."

## 6. Reopen or handoff

\`start\` adopted the run. Then reconcile from the task log: the last \`wN base\` line is the
current wave's BASE. For each lane's newest registry line: alive = wait; done = gate; dead
and not done = resume once. Phase validate with a validator FAIL newer than any
final-fix-reviewer PASS = wait for the builder, then final-fix-reviewer, then the validator:
never re-validate an unreviewed fix. Builder sessions never take over this chat's own
conversation id.
`;

/** Every recipe `goal-live recipe <name>` knows. */
export const GOAL_LIVE_RECIPES: Readonly<Record<string, string>> = {
  develop: DEVELOP_RECIPE,
};
