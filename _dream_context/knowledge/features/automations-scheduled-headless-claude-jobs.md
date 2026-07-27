---
id: feat_iixpNXAm
type: feature
name: automations-scheduled-headless-claude-jobs
description: >-
  User-defined, launchd-scheduled jobs that run headless Claude sessions
  (bypassPermissions) to produce recurring outputs—daily digests, weekly
  reports, research runs—driven by markdown manifests, gated by machine-local
  SHA256 approval tripwire, ships fully disabled until explicitly installed and
  approved.
pinned: false
date: '2026-07-26'
status: in_review
created: '2026-07-26'
updated: '2026-07-27'
released_version: null
tags:
  - 'topic:agents'
  - 'layer:backend'
  - 'domain:security'
  - 'topic:cli'
  - 'topic:desktop'
related_tasks:
  - automations-scheduled-headless-claude-jobs
  - automations-branded-audible-completion-notifications
---

## Why

The brain only works while a human is in a session. Recurring outputs—daily digest, weekly report, scheduled research, lab sync refreshes—need a human to remember to ask. A wall-clock scheduler that runs headless Claude jobs makes the brain act on a cadence without anyone at the keyboard. This is the "learning to act" direction: the agent runs autonomously on a schedule the user defines.

## User Stories

- [x] As a user, I describe an automation in plain language ("her akşam 18:00'de günün daily'sini çıkar", "cuma 17:00 weekly rapor", "salı günleri X'i araştır") and the agent captures it as an automation—no config syntax to learn.
- [x] As a user, my automations run on schedule with the app and terminal closed, and I find the outputs as dated markdown files (and a one-line status in my next session's snapshot).
- [x] As a user, nothing ever runs unless I explicitly opted in on THIS machine: installed the dispatcher and approved each automation.
- [x] As a teammate on a synced brain, I can see automation manifests and run history, but a manifest I edited never executes on someone else's machine until they re-approve it.

## Acceptance Criteria

- [x] Manifest entity at `_dream_context/automations/<slug>.md` with frontmatter (id, title, enabled, `schedule: {days, at}`, model, effort, timeout_minutes, catchup_hours, output.dir, shared) and `## Prompt` / `## Output instructions` / `## Changelog` body. Lenient reads, strict writes.
- [x] Structured schedule (`days: daily | [mon, wed]`, `at: "HH:MM"` local) with pure `mostRecentFire` + `isDue` predicates—injected `now`, unit-tested including midnight/week wrap and DST.
- [x] ONE global launchd dispatcher: `~/Library/LaunchAgents/com.dreamcontext.automations.plist`, runs every 5 minutes, no baked node/CLI paths. Reads machine-local project registry `~/.dreamcontext/automations.json`.
- [x] Runner composes preamble + manifest prose → `spawn(shell, ['-ilc', 'exec claude -p --permission-mode bypassPermissions --model "$1" "$0"', prompt, model])` with positionals, no interpolation. Timeout (default 15m, cap 60), stdout→`automations/output/<slug>/<date>.md`, run record in `automations/cache/<slug>.json`.
- [x] Security tripwire: machine-local SHA256 approval per manifest (six fields: prompt, outputInstructions, model, effort, timeoutMinutes, outputDir); tick/run recompute and on mismatch/missing SKIPS with `status: blocked` until `automations approve <slug>`. Local write verbs re-approve; synced teammate edits never auto-approve.
- [x] Locks: per-slug file lock (no self-overlap); defer while sleep lock is held fresh; orphan guard (previous run's child group still alive) refuses to spawn.
- [x] CLI: `automations create|list|show|run|tick|enable|disable|approve|kill|remove|install|uninstall|logs` registered in `src/cli/index.ts`.
- [x] Fully disabled by default: fresh projects have no automations dir, no registry entry, no plist; `tick --all` with empty registry is silent no-op; nothing executes until user runs `automations install` AND approves an automation.
- [x] SessionStart snapshot `## Automations` section (only when there's something to say): last-24h runs, failures, blocked-pending-approval with the approve command, orphaned runs with the kill command.
- [x] Docs lockstep: skill/SKILL.md Entity Router row, new skill/references/automations.md (capture protocol + security stance), skill/references/cli-reference.md, README.md.
- [x] Tests green: schedule, store, registry/approval, launchd (mocked ExecRunner—never real launchd in tests), runner (fake spawn + one real process-group test), CLI integration (tmp dir + fake HOME).
- [x] V2 surfaces: server routes (`/api/automations`, `/:slug/run`, `/:slug/approve`), dashboard Automations page with failure/blocked/orphaned badges, private-by-default manifests with `shared` flag + gitignore negation, sleep consumes automation output (bounded: mtime ≥ boundary, ≤20 files, ≤200KB total, skip-by-default with hard rule against one knowledge file per output per day).

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

### 2026-07-26 — Round 2: effort, sharing, sleep consumption
- **Per-automation effort** (`low|medium|high|xhigh|max`). Effort IS hashed (same class as model and timeoutMinutes) since it changes cost and execution envelope by ~10× for an already-approved prompt. Approval surface became SIX fields. `APPROVAL_PAYLOAD_VERSION` stayed `v1` (no approvals exist in the wild, so no migration).
- **Manifests PRIVATE BY DEFAULT**, sharing opt-in per automation. Frontmatter `shared` flag (read asymmetric: `shared === true` exactly, anything else reads private—fail-safe). Output AND cache visibility follow the manifest flag (a private prompt whose digest publishes is worse than no privacy). CLI-managed gitignore negation (FILE-level patterns: `output/*/*` not `output/`; negation above wildcard is silently dropped by git). Unsharing NOT retroactive, CLI warns at the moment it happens.
- **Sleep READS automation output** (reconciles with "sleep never executes an automation" via three-part rule: never executes, never owns artifacts, but DOES read new output and distill it). Bounded: mtime ≥ boundary, ≤20 files, ≤200KB total, 50KB per file; over-cap files skipped wholesale. SKIP-by-default with hard rule against one knowledge file per output per day. New persistent field `SleepState.last_consolidated_at` stamped by `finalizeSleepState` (injected nowISO), back-filled null means consume-nothing. **`sleep done` REFUSES until `--ack-private-derivation`** when sleep-product writes private-output marker—folding a disclosure decision under a general 'yes' is the reflexive-approval pattern the design argues against.
- **Dangerous drift direction** (flag private, gitignore shared) AUTO-REPAIRS toward private with removal printed, never in runner/tick so scheduled path stays cheap. Safe direction stays warning. Injectable `GitTrackedCheck` surfaces `tracked-despite-private` state, never auto-repairs (untracking is destructive).

### 2026-07-25 — Round 1: validated plan, 7 waves
- **Ships COMPLETELY DISABLED—opt-in only.** No auto-install anywhere (not in `setup`, not in `update`). Dispatcher plist exists only after explicit `automations install`; every automation additionally needs machine-local approve. Uninstall one command and total.
- Product feature for all users (not personal setup); macOS launchd v1 backend; Linux cron later behind same `installDispatcher()` seam.
- **Lego-flexible, Lab-Insights-modeled**: all job semantics live in manifest prose the agent writes from conversation; CLI carries only schedule/model/effort/timeout. No hardcoded job types, no built-in "digest" command.
- **Headless runs use `bypassPermissions`—exactly WHY the SHA256 approval tripwire is non-negotiable**: brain-synced manifests are RCE-equivalent input.
- Structured `{days, at}` schedule, NOT cron strings (self-documenting in synced brain; no NL→cron error class). Future `cron:` key may coexist; not in v1.
- One dispatcher plist, never per-automation plists (synced manifest edits arrive with no local CLI action → per-automation plists would drift; dispatcher re-reads manifests every tick and owns catch-up policy explicitly).
- Do NOT reuse `sanitizePrompt()` from agent-terminal.ts (it collapses newlines for readline auto-submit; `-p` takes multi-line args). Strip NULs + cap ~100KB instead.
- Cache + output are brain-synced (visibility); approvals/registry are machine-local (opt-in + duplicate-run guard across machines).
- No secrets in manifests ever; credentials stay in Lab credentials layer, used via CLI during the run.
- Compatible-but-separate from sleep-connectors (every-N-sleeps cadence) and knowledge-workflows (automation's prompt MAY reference a workflow doc—pure prose, zero coupling).

### 2026-07-25 — Dispatcher wrapper indirection (§1.1 final design)
- **Generated wrapper script** (`~/.dreamcontext/bin/automations-dispatch.sh`) baked at install: fast path via resolved absolute bin + `--version` preflight (not just `[ -x ]`, which misses broken shebang/sandbox refusal), then `-ilc` self-healing fallback. Plist runs `/bin/sh <wrapper>`. **Why not `-lc`?** Measured 2026-07-25: `zsh -lc` resolves `/opt/homebrew/bin/dreamcontext` (different install) vs `zsh -ilc` resolves `~/.nvm/.../dreamcontext` (the npm-linked one). nvm and `~/.local/bin` come from `~/.zshrc`, which only `-i` sources. A launchd job's default PATH is only `/usr/bin:/bin:/usr/sbin:/sbin`—wrapper indirection is NOT belt-and-braces, it's what makes the scheduler work at all.
- `install --check` read-only, writes nothing, renders heartbeat timestamps. Refuses unresolvable CLI; warns on mismatch vs running binary unless `--force`.
- **Preflight hang-watchdog** declined for v1 (documented deferred hardening). macOS launchd has NO runtime watchdog (`TimeOut` never implemented), no `timeout(1)` on macOS. Exposure is NOT new—exec'ing a hung binary hangs identically with no preflight. A wedge freezes both heartbeat timestamps, diagnosable when human looks but not auto-detected.

### 2026-07-25 — Runner output format (§1.2)
- `claude -p <prompt> --permission-mode bypassPermissions --output-format json [--model <m>] [--effort <e>]`, stdin `'ignore'`.
- Output file receives **`result` verbatim, nothing else**—exactly what preamble's OUTPUT CONTRACT promises. Same-day re-run suffixes `-2`, `-3`; never clobbers.
- Cache record receives telemetry: `sessionId`, `isError`, `permissionDenials`, `costUsd`, `numTurns`, CLI `durationMs`, `subtype`, `exitCode`.
- **Why:** with raw stdout a failed run still writes plausible markdown and reports `ok`—scheduler lies. `is_error` is only real success signal; `permission_denials[]` is observability half of bypassPermissions bargain; cost is what unattended recurring job most needs to expose.
- Graceful degradation (mandatory): unparseable stdout or no string `result` ⇒ `status:'failed'`, `error:'unparseable CLI output'`, **and raw stdout tail is still written to output file**. `parseClaudeJson` pure and never throws.

### 2026-07-25 — Approval tripwire scope (§1.3)
- **Hash input:** `APPROVAL_PAYLOAD_VERSION + '\n' + JSON.stringify({prompt: norm(m.prompt), outputInstructions: norm(m.outputInstructions), model: m.model, effort: m.effort, timeoutMinutes: m.timeoutMinutes, outputDir: m.outputDir})`. Fixed key order; JSON escaping makes hash-preserving re-split impossible by construction. `norm(s)`: `\r\n → \n`, trim, collapse trailing blank lines.
- **Not hashed:** title, description, enabled, schedule, catchup_hours, id, timestamps, `## Changelog`, YAML key order, surrounding whitespace. Hashing whole file would false-block on `updated_at` bump, YAML re-order, Changelog append, checkout newline normalization—training reflexive approval, which destroys tripwire.
- `approve` renders field-by-field diff over ALL SIX hashed fields, refuses non-interactively without `-y`.
- **Enforcement:** `tick` and `run` both call `checkApproval`. `run --force` bypasses dueness only—**no flag anywhere runs unapproved manifest.**

### 2026-07-25 — Detached-child lifecycle + orphan handling (§1.4, rev-5 fix)
- Non-detached spawn leaves child in parent's process group; killing child PID leaves grandchildren running. For this feature timeout is **only** safety bound on unattended `bypassPermissions` agent.
- `detached:true` ⇒ `pgid == pid`. Kill via `killImpl(-pid, 'SIGTERM')` → +`KILL_GRACE_MS` → `killImpl(-pid, 'SIGKILL')` (timeout path, parent alive). Server shutdown / foreground Ctrl-C: `killImpl(-pid, 'SIGKILL')` immediately (no escalation—server's 5s hard exit). Operator `automations kill`: `killImpl(-pgid, 'SIGKILL')`.
- **No automatic reaper.** Orphan guard (step 4, BEFORE lock): read existing sidecar, if validates AND `killImpl(childPgid, 0)` succeeds AND `killImpl(runnerPid, 0)` throws ESRCH ⇒ `status:'orphaned'`, **no spawn**, watermark not advanced, error = *"previous run's child group (pgid N) is still alive—run `dreamcontext automations kill <slug>` first"*. Tick reports it every 5 min, snapshot surfaces it, `show` renders orphan-liveness line. Sidecar cleared in `finally` only when `runnerPid === process.pid`, never unconditionally (or spawn-failure path would erase live orphan's record). `killRunGroup` reads exact childPgid from sidecar, cross-checks lock.pid === sidecar.runnerPid, refuses if over `SIDECAR_PID_REUSE_WINDOW_MS` without `--force`, records complete 12-field `RunEvent` with `firedAt === sidecar.fireAt`, `outputPath === null`, `exitCode/sessionId/costUsd/numTurns === null`, watermark advanced.

### 2026-07-25 — What approval does NOT cover (seven items, documented verbatim)
1. **Anything the run does once started.** `bypassPermissions` = read/write any file you can, run any command, reach network. Approving means "I read this prompt and would run it myself."
2. **Second-order content.** Prompt saying "read `knowledge/x.md` and follow it" makes `x.md` un-hashed instruction source. **Protocol rule: automation prompt must not delegate instructions to teammate-editable file.**
3. **Binaries and model.**
4. **Registry itself**—`~/.dreamcontext/automations.json` machine-local, unsynced; write access to home directory forges approvals. Same boundary as shell rc.
5. **Timing, not behavior.** `schedule`, `enabled`, `catchup_hours` unhashed: synced edit can **retime** approved job but never change what it does. Teammate can convert weekly job to daily, re-enable disabled one with week of catch-up. Same capability, amplified frequency and cost.
6. **Non-credential-shaped sensitive output.** Outputs inherit mandatory pre-commit/pre-push scrub (`src/lib/git-sync/scrub.ts`) blocking 11 structured credential shapes (GitHub PAT/fine-grained/OAuth, AWS `AKIA`, Google `AIza`, Slack `xox*`, `sk-ant-*`, `sk_live_*`, `sk-*`, PRIVATE KEY, 3-part JWTs). Matches shapes only—internal hostnames, customer PII, private URLs, bespoke token formats pass; `home-path`/`windows-home-path` warn-only. Since `sleep done` auto-commits+pushes when autoSync on, approved prompt like "summarize CI logs" can publish non-credential-shaped sensitive material to team remote without review.
7. **Stopping a running automation.** Automation runs in own process group, detached from tick. `SIGKILL`ing tick/run process does NOT stop it—removes only time bound. **Use `dreamcontext automations kill <slug>`**, which reads exact process-group id and signals only that group. **No automatic reaper:** orphaned group survives until you run that command. While one exists, automation **refuses to spawn again** (`status: orphaned`), says so every tick, in snapshot, and in `show`. Never guess target with `pgrep`/`pkill`—on machine running other `claude` sessions you'll kill wrong one.

## Technical Details

### Architecture

**Dispatcher:** ONE global launchd job (`com.dreamcontext.automations`), `StartInterval 300`, runs generated wrapper script (`~/.dreamcontext/bin/automations-dispatch.sh`) which invokes `dreamcontext automations tick --all`. Wrapper has baked absolute bin fast-path + `-ilc` fallback for self-healing. Plist never bakes CLI path directly (npm upgrade needs no plist change).

**Tick flow:** `tickAll` reads machine-local registry (`~/.dreamcontext/automations.json`) → per project sequentially `tickProject` → list manifests → `isDue` per slug → runs due automations sequentially. Empty registry ⇒ silent no-op. No shell spawns when nothing due (load-bearing: long tick eats next `StartInterval` fire).

**Runner (15-step sequence):**
1. `getAutomation` → null ⇒ `failed`, no cache write, no spawn.
2. `checkApproval` → not approved ⇒ `blocked`, cache written, watermark not advanced, no spawn.
3. Sleep deference: `inspectSleepLock` → locked && !stale ⇒ `deferred`, cache written, watermark not advanced.
4. **Orphan guard (before lock):** `readRunSidecar` → validates && `killImpl(childPgid, 0)` succeeds && `killImpl(runnerPid, 0)` ESRCH ⇒ `orphaned`, cache written, watermark not advanced, no spawn.
5. `acquireFileLock` → false ⇒ `deferred` (self-overlap), cache written, watermark not advanced.
6. `ensureGitignoreEntries` + mkdir output dir.
7. Spawn `claude -p <prompt> --permission-mode bypassPermissions --output-format json [--model <m>] [--effort <e>]` via `findClaudeBin()` direct or `$SHELL -ilc` fallback, `stdio: ['ignore','pipe','pipe']`, `detached: true`, **never `unref()`**.
8. `child.pid == null` ⇒ spawn failure: no sidecar, record `failed` with `error:'spawn failed'`, no watermark advance, release lock.
9. Success: `writeRunSidecar({slug, runnerPid: process.pid, childPid: child.pid, childPgid: child.pid, fireAt, startedAt, timeoutAt})` synchronously.
10. Host wiring—`'cli'`: SIGINT/SIGTERM handlers group-kill and release lock, removed in `finally`. `'server'`: no handlers; `registerChild(() => killImpl(-child.pid,'SIGKILL'))` callback form, `untrack()` on settle.
11. Bound stdout `MAX_STDOUT_BYTES`, keep `STDERR_TAIL_BYTES` stderr tail. Timeout ⇒ SIGTERM → +`KILL_GRACE_MS` → SIGKILL (parent alive); immediate SIGKILL (server shutdown / foreground Ctrl-C).
12. `parseClaudeJson` ⇒ graceful degradation (unparseable ⇒ `failed` + raw tail preserved).
13. `recordRun` with `firedAt = fireAt` (not `now`—catch-up records original fire) and `advanceWatermark: true` (child started).
14. Failure ⇒ best-effort `osascript` notification.
15. `finally`: `untrack()`/remove handlers, `releaseFileLock`, clear sidecar only when `sidecar.runnerPid === process.pid`.

**Watermark invariant:** advances **iff child process actually started**. `ok`/`timeout` always; `failed` only when spawn succeeded; `blocked`/`deferred`/`orphaned` never.

### Key files (3704 lines across library)

- `src/lib/automations/types.ts` (337 lines) — contract root, pure, zero I/O. `RUN_STATUSES`, `WEEKDAYS`, `EFFORT_LEVELS`, `Schedule`, `AutomationManifest`, `RunEvent`, `AutomationCache`, `RunSidecar`, `ApprovalPayloadFields`, constants.
- `src/lib/automations/schedule.ts` (174 lines) — pure predicates: `parseSchedule`, `mostRecentFire`, `nextFire`, `isDue`, `formatSchedule`. Local wall-clock, DST-tested.
- `src/lib/automations/store.ts` (662 lines) — mirrors `lab/store.ts`. Lenient reads, strict writes, atomic cache. `resolveOutputDir` strict-subdirectory containment (no brain root, no escape). `readRunSidecar` validates content (`Number.isInteger(pgid) && pgid > 1`), returns `null` if corrupt/planted (inert not lethal). `recordRun` sole writer of `lastFireAt`.
- `src/lib/automations/registry.ts` (358 lines) — machine-local, never-throw reads, atomic writes, injectable home. `canonicalApprovalPayload`, `manifestHash`, `checkApproval`, `approveAutomation`. Heartbeat in own file `~/.dreamcontext/automations-tick.json` (removes lost-update race by construction).
- `src/lib/automations/sharing.ts` (255 lines, Round 2) — pure predicates `gitignoreCovers`, `assertShareOrdering`, `shouldIgnoreManifest`, `repairGitignoreSharing`. Auto-repair dangerous drift (private flag, shared gitignore) toward private.
- `src/lib/automations/launchd.ts` (511 lines) — all exec injectable. `resolveDispatcherTarget`, `renderDispatcherWrapper`, `renderDispatcherPlist`, `installDispatcher`, `uninstallDispatcher`, `inspectDispatcher`.
- `src/lib/automations/runner.ts` (823 lines) — 15-step sequence, `runAutomation`, `killRunGroup` (CLI-only, never called by runner/tick). Host discriminated union + runtime throw. Platform guard (win32 refused). `parseClaudeJson` pure. `buildPreamble` with OUTPUT CONTRACT.
- `src/lib/automations/tick.ts` (192 lines) — `tickProject`, `tickAll`. Sequential. Empty registry ⇒ silent no-op. Rotates log >1 MB. Writes both heartbeat timestamps every tick.
- `src/lib/automations/snapshot.ts` (160 lines) — pure renderer. `buildAutomationsSnapshot`, `renderAutomationsSection`. Returns `[]` when nothing to say. Plain text, no chalk. Surfaces never-approved automations (reads registry) + live-orphan lines (sidecar + signal-0 probes).
- `src/lib/automations/consumption.ts` (232 lines, Round 2) — `pendingOutputsSince`, `consumeAutomationOutputs`. Bounded: mtime ≥ `SleepState.last_consolidated_at`, ≤20 files, ≤200KB total, 50KB per file. Over-cap files skipped wholesale. Skip-by-default.
- `src/cli/commands/automations.ts` — 13 verbs: create, list, show, run, tick, enable, disable, approve, kill, remove, install, uninstall, logs. `approve` diffs all six hashed fields, refuses without `-y`. `kill` confirms before group SIGKILL.
- `src/server/routes/automations.ts` + `src/server/automation-job.ts` (Round 1 V2) — `/api/automations`, `/:slug/run`, `/:slug/approve`. Job: one per contextRoot, pruned after 1h. `registerChild: (killGroup) => trackChild(killGroup)` callback form.
- `dashboard/src/hooks/useAutomations.ts` + `components/automations/**` + `pages/AutomationsPage.tsx` (Round 1 V2) — card grid, failure/blocked/orphaned badges (keyed off `status`, never `error != null`).
- `skill/references/automations.md` — capture protocol + full seven-item security stance verbatim.

### Validation results

**Round 1 (7 waves, 4727 tests, validated 2026-07-25):**
- Wave 1: types + schedule pure (DST spring-forward + fall-back), ensure-cli probe fix (optional).
- Wave 2: store (lenient/strict, atomic cache, strict-subdirectory containment, sidecar validation), registry (heartbeat own file, payload stability), launchd (real `/bin/sh` execution against broken bin proves fallback reachable).
- Wave 3: runner (15-step sequence, orphan guard before lock, sidecar retention, 12-field `RunEvent` pinned, real-process test proves group-kill works, source-scan proves no auto-reaper).
- Wave 4: tick (empty registry silent no-op, zero spawns when nothing due), snapshot wiring, server route + job (callback form).
- Wave 5: CLI (13 verbs, approve diffs all six fields, kill confirms).
- Wave 6: dashboard + docs.
- Wave 7: feature integration (entity count healed, marker test).
- **CLI e2e PASS:** create → run --force → output+cache ok; tamper → blocked, zero spawns; cosmetic edit (title/changelog) → still approved; approve → unblocks; disable kill switch.
- **Real launchd lifecycle PASS:** install via bootstrap (not legacy load), two observed scheduled fires, fix propagated with no plist change, clean uninstall.
- **MOST SERIOUS DEFECT:** found only by real install. `tick --all` called `ensureContextRoot()` unconditionally → exits 1 when no `_dream_context/` in CWD → dispatcher would exit 1 every 5 min forever, no automation would ever run. Fixed by moving `--all` branch to run BEFORE any `ensureContextRoot()` call. **Why everything else missed it:** unit tests call `tickAll()` directly (bypass CLI), integration test invokes CLI from scratch project WITH brain. Nothing ran real CLI's `tick --all` from brainless CWD. Four review rounds, 4727 tests, two clean-context reviewers didn't catch it. Owner's insistence on real launchd install caught it.

**Round 2 (waves 1-2 gated at 4821 tests, in-flight 2026-07-26):**
- Wave 1 (TA1 contract root + TA2 sharing predicates): `APPROVAL_DIFF_FIELDS` six-tuple with effort correctly between model and timeoutMinutes; four PURE order-aware predicates in types.ts with readonly signatures; new base gitignore entries include load-bearing `automations/output/*/*` (not `output/`, git won't descend into ignored dir). Both same-wave import prohibitions verified (store.ts mentions sharing/gitignoreCovers only in comments; sharing.ts has no store.ts import).
- Wave 2 (TB1 store extensions + TC1 sleep surfaces): `SleepState.last_consolidated_at` stamped by `finalizeSleepState` (injected nowISO, back-filled null). Three call sites closed same wave. `sleep done` refuses until `--ack-private-derivation` when private-output marker exists.

## Notes

### Open questions (proceeding on stated defaults)
- **Q1** — `remove` keeps synced outputs by default; `--purge-output` opts in.
- **Q2** — Two machines sharing brain, both approved ⇒ two same-day outputs. Machine-local registry is by design; mitigation is output suffixing + both runs in history. "Primary machine" flag deliberately not v1.
- **Q3** — Dashboard "run now" spawns `bypassPermissions` from browser page. Loopback-gated, CSRF-blocked, approval-gated, accepts no prompt from request—but new trigger surface. Explicitly acked before W6.

### Known residuals (documented, not defended)
- ~Microsecond window between `spawn()` returning and sidecar write.
- `killRunGroup`'s lock-pid cross-check skipped when lock absent but sidecar present (runner died between releasing lock and clearing sidecar)—inherent, covered by human confirmation.
- `permissionDenials: 0` on operator-killed run means "not collected", never "none occurred".
- No automatic orphan reaper: orphan blocks further runs of that slug (reported every tick, in snapshot, in `show`) until operator runs `automations kill`.
- Heartbeat/staleness warning declined for v1: `recordTickCompleted` fires once after all due automations run sequentially; with `MAX_TIMEOUT_MINUTES = 60` + multiple same-fire-time automations, healthy tick can legitimately run for hours, so flat threshold would false-alarm during busiest correct operation. Laptop asleep at fire time is expected miss, not dead dispatcher. Raw timestamps shown by `install --check`.

### Future
- Linux cron backend behind same `installDispatcher()` seam.
- `cron:` key coexisting with structured schedule.
- UTC schedule option (v1 is machine-local only).
- Heartbeat/staleness warning (needs multi-hour safe threshold, or per-automation last-fire tracking).

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-07-26 - Round 2 waves 1-2 gated
- TA1 (contract root extended): `APPROVAL_DIFF_FIELDS` six-tuple, four PURE order-aware sharing predicates in types.ts.
- TA2 (sharing predicates): `gitignoreCovers`, `assertShareOrdering`, auto-repair dangerous drift toward private.
- TB1 (store extensions): sharing-state paths, `repairGitignoreSharing`, gitignore injection.
- TC1 (sleep surfaces): `SleepState.last_consolidated_at`, `consumeAutomationOutputs`, `--ack-private-derivation` gate in `sleep done`.
- 4821 tests passing (documented environmental delegate-agent pair only).

### 2026-07-25 - Round 1 validated, status → in_review
- Built and validated end-to-end: 7 waves, 4727 tests green, code review + security review clean after fixes.
- CLI e2e PASS (create, run, tripwire, cosmetic-edit-must-not-block, approve, disable kill switch, ships-disabled).
- Real launchd lifecycle PASS (install, two scheduled fires, fix propagated with no plist change, uninstall).
- Most serious defect found by real install: `tick --all` required brain in CWD → would exit 1 every 5 min forever. Fixed.
- Left `in_review` not `completed`: nothing committed (owner rule), dashboard page never visually verified by human.

### 2026-07-23 - Created
- Feature PRD created for sleep consolidation of automations build (uncommitted, worktree branch `worktree-automations`).
