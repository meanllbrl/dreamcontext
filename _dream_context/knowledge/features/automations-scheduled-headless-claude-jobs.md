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
updated: '2026-07-28'
released_version: v0.22.0
tags:
  - 'topic:agents'
  - 'layer:backend'
  - 'domain:security'
  - 'topic:cli'
  - 'topic:desktop'
related_tasks:
  - automations-scheduled-headless-claude-jobs
  - automations-branded-audible-completion-notifications
  - >-
    automations-learn-from-every-run-show-their-session-and-say-what-happened-in-the-notification
---

## Why

The brain only works while a human is in a session. Recurring outputs—daily digest, weekly report, scheduled research, lab sync refreshes—need a human to remember to ask. A wall-clock scheduler that runs headless Claude jobs makes the brain act on a cadence without anyone at the keyboard. This is the "learning to act" direction: the agent runs autonomously on a schedule the user defines.

## User Stories

- [x] As a user, I describe an automation in plain language ("her akşam 18:00'de günün daily'sini çıkar", "cuma 17:00 weekly rapor", "salı günleri X'i araştır") and the agent captures it as an automation—no config syntax to learn.
- [x] As a user, my automations run on schedule with the app and terminal closed, and I find the outputs as dated markdown files (and a one-line status in my next session's snapshot).
- [x] As a user, nothing ever runs unless I explicitly opted in on THIS machine: installed the dispatcher and approved each automation.
- [x] As a teammate on a synced brain, I can see automation manifests and run history, but a manifest I edited never executes on someone else's machine until they re-approve it.
- [x] As a user, my automations learn from every run—a bounded pattern (playbook + lessons) lives in the manifest and improves each time, so a job doesn't repeat its mistakes forever.
- [x] As a user, I can replay the exact claude session a run actually had—turns, tool calls, failures, cost—so I understand what a headless run did, not just its conclusion.
- [x] As a user, the completion notification tells me what the run found (not just that a file exists), and clicking it opens the output document.

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
- [x] Every automation carries a bounded pattern (playbook + 20-lesson LIFO ledger) it reads before a run and appends to after one, via `automations learn <slug> --lesson|--playbook`.
- [x] The pattern reaches the run as untrusted notes ordered after the approved prompt, and never as instructions that can override it. `learning` frontmatter flag is approval-hashed in the ON direction only, so upgrading never silently blocks an existing automation.
- [x] `automations session <slug> [--run N] [--path|--json|--limit]` replays the claude session a run actually had. `GET /api/automations/:slug/session` and dashboard run-history session drill-in show turns, tool calls with arguments, failures, cost.
- [x] Completion notification body carries the run's own opening sentence (a `## Notification`/`## Bildirim` section wins if present), titled by the automation, with click-to-open the output document.
- [x] Automations nav icon (alarm clock) in dashboard. `dreamcontext upgrade` refreshes a stale notifier bundle; `automations install --check` reports notifier currency.

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

### 2026-07-28 — Dashboard zero-state joins the Lab explainer family

- **The Automations zero-state is now an explainer, not a notice.** It previously shipped "deliberately plain" (a heading, a paragraph, a CLI command) on the reasoning that density beats theatricality. That reasoning holds for a POPULATED board; it is wrong for a zero-state, where there is no density to protect and the page's whole job is to teach what it is for. Rebuilt on the same anatomy Council and Lab already use — brand mark · kicker · gradient heading · lead · animated stage · CLI scaffold · footnote — so the three Lab-chipped surfaces read as one family (`AutomationsEmptyState.tsx`, `AutomationsShowcase.tsx`, `automationsFlowSpec.ts`).
- **Its signature diagram is a pipe that feeds back into itself**, deliberately distinct in shape from its siblings (Council = round table, Lab = straight pipe): manifests → dispatcher → run → output/notify, with the pattern loop drawn as two opposed arcs under the run (`learns` / `reads`). The approval tripwire is drawn as a label ON the dispatcher→run wire rather than as its own station, because an unapproved manifest does not reach a gate and wait — it simply never crosses.
- **`agent` (flat onyx) is the wrong variant for a node that must carry a dark stage.** The run node read as a black slab in light mode and sank into the stage's own dark panel at night; `hook` (gradient fill + accent stroke + glow) holds its weight in both themes. Applies to any future FlowDiagram node placed on the gradient stage card.

### 2026-07-27 — Round 3: pattern learning, session visibility, notification content

- **Pattern learning loop.** Each automation carries a `## Pattern` section in its manifest: a curated playbook plus a newest-first, 20-entry lesson ledger (each lesson capped at 200 chars). The run READS it before starting (injected as UNTRUSTED NOTES, ordered AFTER the approved prompt, explicitly told the instructions always win) and WRITES to it via `dreamcontext automations learn <slug> --lesson "<text>" | --playbook "<text>"`. Playbook rewrites whole, lessons prepend. Both writes are byte-surgical: frontmatter never touched, content outside `## Pattern` byte-identical before and after. Caps enforced on write, not read.
- **`learning` approval-hashed asymmetrically.** The switch that admits the pattern is hashed (APPROVAL_DIFF_FIELDS bumped to seven); the pattern CONTENT is deliberately NOT hashed (it changes every run; hashing it would block daily and train reflexive approval). Hashing is ON-direction-only: `learning: true` requires approval; omitting it (or `learning: false`) hashes exactly as manifests written before the field existed, so an upgrade never silently blocks a working automation. The pattern is unreviewed input, mitigated by: bounded size, single CLI write path, untrusted-notes framing, ordered after approved prompt, and rendered inside the pre-approval review in the dashboard (because the approval moment is exactly when a human must see it).
- **Notification now carries run CONTENT to screen.** Deliberate reversal of earlier privacy choice. Body is the run's own opening sentence (`extractNotificationSummary` skips headings/tables/fences/frontmatter; `## Notification` or `## Bildirim` section wins if present), title is automation name, click target is output file. `notify: false` per automation silences it; `--no-notify` at create time writes it.
- **Session visibility.** `automations session <slug> [--run N]` (N is 1-based, newest-first; defaults to last run that had a session), `GET /api/automations/:slug/session`, and dashboard per-run drill-in all reuse `parseTranscriptHistory` (extracted to `lib/transcript-history.ts`). Shows turns, tool calls with arguments, cost, failures. `sessionId` flows from cache to filesystem path—whitelisted (alphanum + dash only) before fs, pinned with traversal regression cases.
- **CRITICAL defect found by runtime dogfooding: `upsertSection` whole-file normalization rewrote approved prompt.** `upsertSection` ended with `.replace(/\n{3,}/g, '\n\n')`, which collapsed blank lines inside `## Prompt` too. The prompt IS hashed (`normalizeText` only strips `\r` and trims), so the SECOND lesson an automation recorded (first takes append branch) rewrote its own approved prompt → failed next approval check → blocked (and blocked runs notify nobody). Exactly the failure the design claimed impossible. Fixed: `upsertSection` is now byte-surgical everywhere outside its section; pinned by 6-lesson hash-stability regression test. **Pattern candidate:** "a helper that edits one section of a hashed document must be byte-surgical everywhere else" is a recurring constraint whenever part of a file is integrity-checked (applies beyond automations: any manifest/config with approval/signature/hash where mutable content coexists with verified fields).
- **Pattern visibility in pre-approval review.** The dashboard approval dialog rendered the pattern ONLY after approval, while the review text said "every run reads the pattern below" with no pattern below—asking the reviewer to admit a self-written notes file into a `bypassPermissions` run blind. Fixed: pattern now renders inside the review dialog, labelled as not covered by the approval hash.
- **Notifier currency and self-healing upgrade.** The notifier applet is compiled only at `automations install`, so a shipped applet fix sat on npm forever while every already-installed machine kept the old one, with nothing reporting it. `inspectNotifier` now carries `scriptCurrent` (sha256 of rendered applescript stamped into `Info.plist`); `install --check` reports STALE loudly. `dreamcontext upgrade` runs `maybeRefreshNotifier()` (rebuilds only when bundle is PRESENT and NOT current; never installs for someone who skipped automations; failed rebuild reported, never thrown).

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

### Key files (4100+ lines across library)

- `src/lib/automations/types.ts` (370+ lines) — contract root, pure, zero I/O. `RUN_STATUSES`, `WEEKDAYS`, `EFFORT_LEVELS`, `Schedule`, `AutomationManifest` (now includes `learning: boolean` and `notify: boolean`), `RunEvent`, `AutomationCache`, `RunSidecar`, `ApprovalPayloadFields` (seven-tuple: prompt, outputInstructions, model, effort, timeoutMinutes, outputDir, learning), constants.
- `src/lib/automations/schedule.ts` (174 lines) — pure predicates: `parseSchedule`, `mostRecentFire`, `nextFire`, `isDue`, `formatSchedule`. Local wall-clock, DST-tested.
- `src/lib/automations/store.ts` (662 lines) — mirrors `lab/store.ts`. Lenient reads, strict writes, atomic cache. `resolveOutputDir` strict-subdirectory containment (no brain root, no escape). `readRunSidecar` validates content (`Number.isInteger(pgid) && pgid > 1`), returns `null` if corrupt/planted (inert not lethal). `recordRun` sole writer of `lastFireAt`.
- `src/lib/automations/registry.ts` (358 lines) — machine-local, never-throw reads, atomic writes, injectable home. `canonicalApprovalPayload`, `manifestHash`, `checkApproval`, `approveAutomation`. Heartbeat in own file `~/.dreamcontext/automations-tick.json` (removes lost-update race by construction).
- `src/lib/automations/sharing.ts` (255 lines, Round 2) — pure predicates `gitignoreCovers`, `assertShareOrdering`, `shouldIgnoreManifest`, `repairGitignoreSharing`. Auto-repair dangerous drift (private flag, shared gitignore) toward private.
- `src/lib/automations/launchd.ts` (511 lines) — all exec injectable. `resolveDispatcherTarget`, `renderDispatcherWrapper`, `renderDispatcherPlist`, `installDispatcher`, `uninstallDispatcher`, `inspectDispatcher`.
- `src/lib/automations/runner.ts` (823 lines) — 15-step sequence, `runAutomation`, `killRunGroup` (CLI-only, never called by runner/tick). Host discriminated union + runtime throw. Platform guard (win32 refused). `parseClaudeJson` pure. `buildPreamble` with OUTPUT CONTRACT.
- `src/lib/automations/tick.ts` (192 lines) — `tickProject`, `tickAll`. Sequential. Empty registry ⇒ silent no-op. Rotates log >1 MB. Writes both heartbeat timestamps every tick.
- `src/lib/automations/snapshot.ts` (160 lines) — pure renderer. `buildAutomationsSnapshot`, `renderAutomationsSection`. Returns `[]` when nothing to say. Plain text, no chalk. Surfaces never-approved automations (reads registry) + live-orphan lines (sidecar + signal-0 probes).
- `src/lib/automations/consumption.ts` (232 lines, Round 2) — `pendingOutputsSince`, `consumeAutomationOutputs`. Bounded: mtime ≥ `SleepState.last_consolidated_at`, ≤20 files, ≤200KB total, 50KB per file. Over-cap files skipped wholesale. Skip-by-default.
- `src/lib/automations/pattern.ts` (Round 3) — `upsertSection` (byte-surgical section editor: reads whole file, rewrites only the target section, preserves everything else byte-identical including frontmatter), `extractPattern`, `extractNotificationSummary`. Caps: playbook unlimited (but practically capped by approved-prompt context window), lessons ≤20 entries × 200 chars each.
- `src/lib/transcript-history.ts` (Round 3) — `parseTranscriptHistory` (reads `~/.claude/projects/<project>/<session>/transcript.json`, returns turns with tool calls, cost, failures), `resolveRunSession` (maps `--run N` to Nth-newest session from cache history).
- `src/cli/commands/automations.ts` — 16 verbs: create, list, show, run, tick, enable, disable, approve, share, unshare, kill, remove, install, uninstall, logs, **learn** (Round 3: `--lesson "<text>"` or `--playbook "<text>"`), **session** (Round 3: `[--run N] [--path|--json|--limit]`), **pattern** (Round 3: read-only view of an automation's pattern). `approve` diffs all **seven** hashed fields (added `learning` in Round 3), refuses without `-y`. `kill` confirms before group SIGKILL.
- `src/server/routes/automations.ts` + `src/server/automation-job.ts` (Round 1 V2, extended Round 3) — `/api/automations`, `/:slug/run`, `/:slug/approve`, **`/:slug/session`** (Round 3: returns parsed transcript with whitelisted sessionId). Job: one per contextRoot, pruned after 1h. `registerChild: (killGroup) => trackChild(killGroup)` callback form.
- `dashboard/src/hooks/useAutomations.ts` + `components/automations/**` + `pages/AutomationsPage.tsx` (Round 1 V2, extended Round 3) — card grid, failure/blocked/orphaned badges (keyed off `status`, never `error != null`), **pattern rendering in pre-approval review** (Round 3), **per-run session drill-in** (Round 3: shows turns, tool calls, failures), **alarm-clock nav icon** (Round 3).
- `skill/references/automations.md` — capture protocol + full seven-item security stance + pattern learning section + session visibility + notification content (fully updated Round 3).

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

### 2026-07-27 - Round 3 shipped and dogfooded
- Four-part extension: (1) **Pattern learning** — playbook + 20-lesson LIFO ledger in `## Pattern`, read before run as untrusted notes, written via `automations learn`; `learning` approval-hashed ON-direction-only so upgrade never blocks existing automations. (2) **Session visibility** — `automations session <slug> [--run N]`, `GET /api/automations/:slug/session`, dashboard drill-in; all reuse `parseTranscriptHistory` from new `lib/transcript-history.ts`. (3) **Notification content** — body carries run's opening sentence (`## Notification`/`## Bildirim` wins), click-to-open output. (4) **Automations nav icon** (alarm clock).
- Plus: `dreamcontext upgrade` refreshes stale notifier bundle via `maybeRefreshNotifier()`; `automations install --check` reports notifier currency via `scriptCurrent` hash in `Info.plist`.
- CRITICAL defect found by runtime dogfooding: `upsertSection` whole-file `.replace(/\n{3,}/g, '\n\n')` collapsed blank lines inside `## Prompt` → rewrote approved prompt → blocked on second lesson. Fixed: byte-surgical section editing, pinned by 6-lesson hash-stability regression. Pattern candidate flagged: "section editor on hashed doc must be byte-surgical everywhere else."
- Two other findings: (1) pattern rendered ONLY after approval (pre-approval review said "reads pattern below" with nothing below) → now renders inside review, labelled as unhashed. (2) `sessionId` flows to fs path unvalidated → whitelisted alphanum+dash, pinned with traversal cases.
- Dogfooded on live `insight-guncelle` automation: real headless run read empty pattern, hit deliberate failure, called `automations learn` itself unprompted, recorded durable lesson; run #2 read lesson back and stayed approved (would have blocked if upsertSection bug unfixed); dispatcher tick evaluates all automations cleanly; dashboard renders pattern, run history newest-first, session drill-in with failed tool calls marked red.
- 5338 tests green (CI-mode suite after review fixes).

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
