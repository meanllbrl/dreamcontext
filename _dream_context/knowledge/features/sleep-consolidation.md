---
id: feat_9qLM-gY_
status: active
created: '2026-02-25'
updated: '2026-09-11'
released_version: 0.1.0
tags:
  - architecture
  - backend
  - decisions
  - 'topic:sleep'
related_tasks:
  - enforce-mutual-exclusion-on-sleep-consolidation-lock
  - improve-sleep-quality
  - sleep-umbrella-tunable-settings-a-bar-against-junk-tasks-and-background-auto-sleep-with-two-writer-safety
  - sleep-settings-become-tunable-debt-thresholds-and-per-specialist-models
  - sleep-stops-filing-junk-tasks-a-bar-for-what-deserves-a-task-and-the-right-model-per-specialist
  - sleep-runs-itself-in-the-background-when-debt-is-high-instead-of-nagging
  - sleep-folds-work-into-existing-tasks-by-default-and-files-a-new-task-only-as-a-high-confidence-exception
type: feature
name: sleep-consolidation
description: >-
  REM-sleep-style consolidation: debt is scored per session, tunable thresholds
  ladder the nags, and a fan-out of specialists folds the cycle's work back into
  the brain. Background auto sleep runs it unattended; a filing bar (cap, why-length,
  tombstone, declined and semantic-neighbour gates) keeps the cycle from filing junk tasks.
pinned: false
date: '2026-02-25'
---

## Why

Agents accumulate knowledge and make decisions across many sessions, but that knowledge degrades or gets lost without a structured consolidation process. Sleep consolidation — modeled on REM sleep — automatically tracks how much work has accumulated and triggers a dedicated sub-agent to fold learnings into the core context files before the brain gets overloaded.

## User Stories

- [x] As an AI agent, I want sleep debt tracked automatically so I don't have to manually decide when to consolidate.
- [x] As an AI agent, I want to see the current sleep debt level at session start so I know whether to consolidate before doing more work.
- [x] As an AI agent, I want graduated awareness thresholds (Alert / Drowsy / Sleepy / Must Sleep) so the urgency of consolidation is unambiguous.
- [x] As an AI agent, I want the Stop hook to record each session's transcript path and last assistant message so the consolidation agent has the raw material it needs.
- [x] As an AI agent, I want the SessionStart hook to auto-analyze any unanalyzed sessions so debt scoring happens even if the Stop hook missed a session.
- [x] As a developer, I want to manually add debt for non-file-change work (architecture discussions, decisions) so the debt meter reflects cognitive load accurately.
- [x] As a developer, I want to reset debt after consolidation with a summary so the system knows when the last sleep happened.
- [x] As an AI agent, I want consolidation done by dedicated specialists so the main agent stays focused. Currently implemented as main-agent fan-out to 3 domain specialists (`sleep-tasks`, `sleep-state`, `sleep-product`). `dreamcontext-rem-sleep` was removed — one authoritative path only. See [sleep-fanout-architecture](sleep-fanout-architecture.md) for the orchestration design.
- [x] As an AI agent, I want persistent sleep debt reminders on every user message so consolidation urgency cannot be forgotten across a session.
- [x] As an AI agent, I want high-signal moments from each session (corrections, error→fix, decisions) automatically bookmarked so the brain's "awake-ripple tagging" works without manual bookmarks.
- [x] As an AI agent, I want auto-digested session transcripts indexed into recall so decisions from session N are searchable in N+1 before any sleep consolidation runs.
- [x] As a developer, I want concurrent sleep consolidation attempts to fail fast with an explicit error so that two parallel sessions cannot corrupt consolidation state.
- [x] **[v0.19.0]** As the main agent, I see un-analyzed session count and provisional debt in directives, so consolidation nudges track reality instead of lagging hours behind transcript flush.
- [x] **[v0.19.0]** As the sleep orchestrator, chronic flags escalate automatically after ≥3 consecutive cycles, so the same problem cannot ride along unactioned.
- [x] **[v0.19.0]** As the user, consolidated brain output is committed or loudly flagged with a ready command, so a stray `git checkout` cannot erase what sleep just learned.
- [x] **[v0.19.0]** As sleep-tasks, I receive real session→task links and sub-agent findings, so I reconcile the right task docs without guessing from `last_assistant_message`.
- [x] **[v0.19.0]** As the catch-up hook, I assign a floor score to transcript-less sessions with non-empty `last_assistant_message`, so evidenced work isn't silently dropped from the debt ledger.
- [x] **[v0.19.0]** As the sleep CLI, bulk catch-up debt never auto-authorizes deep consolidation, so the cycle with the MOST piled-up material doesn't get the MOST destructive authority.

- [x] **[v0.27.0]** As a brain owner, I set this project's debt thresholds (Drowsy / Sleepy / Must Sleep) in Settings › Sleep or `dreamcontext sleep config`, so the ladder calibrated against THIS repo's transcripts is a default rather than a law imposed on every other brain.
- [x] **[v0.27.0]** As a brain owner, I pick the model and reasoning effort each of the six sleep specialists runs on, and my choice survives `install-skill` / `setup` / `update` instead of being overwritten by the next install.
- [x] **[v0.27.0]** As a board owner, sleep stops filing junk: a task born of a sleep cycle needs real justification prose, and work that was merged away or deleted is never re-filed.
- [x] **[v0.27.0]** As a board owner, a cycle files at most N new tasks and REPORTS the candidates it did not file, so a capped candidate is never silently dropped.
- [x] **[v0.27.0]** As a user tired of "I'm sleepy", I turn on background auto sleep for this machine (default OFF) and the brain consolidates itself from a Stop hook — no debt directive reaches any agent while it is on.
- [x] **[v0.27.0]** As a user, I see a running background cycle in the dashboard and can cancel it; a finished one leaves a changelog entry and a notification carrying the summary.
- [x] **[v0.27.0]** As a user who keeps working while a background cycle runs, my task edits and the cycle's writes both survive — per-file locks on the CLI write path plus a hands-off task set the cycle defers.
- [x] **[v0.27.0]** As a user, auto sleep pauses itself with one visible line when the configuration I approved it against changes (consent fingerprint), rather than running under settings I never saw.

- [ ] **[unreleased]** As a board owner, sleep folds work into the task that already covers it: a filing whose nearest task-corpus neighbour is a near-verbatim twin is refused naming that slug and the fold-in command, and a merely-close neighbour is refused until the specialist names it back.
- [ ] **[unreleased]** As a user who dropped a piece of work that never became a task, I record it once with `tasks decline` and no later cycle re-files it — unconditionally by exact slug, and as a read-the-reason ask when it merely resembles one.
- [ ] **[unreleased]** As a board owner, a candidate that was only *discussed* is neither filed nor lost: it rides `.sleep-flags.json` as a `task-candidate:` flag and is filed only when a later cycle independently re-observes it.
- [ ] **[unreleased]** As a board owner, work belonging to a connected vault or to a person not on the roster never becomes a task here, and a candidate a later session cancelled dies with it — the cycle reports both instead of filing them.

## Acceptance Criteria

- `hook stop` reads session_id, transcript_path, and last_assistant_message from stdin JSON; analyzes transcript for Write/Edit tool uses; stores session record in `state/.sleep.json`.
- `hook session-start` finds all sessions with `score: null` and analyzes their transcripts; adds computed scores to debt total.
- Debt scoring: session score = `scoreSession(analysis)` — a log-compressed WEIGHTED SUM over four axes, rounded to an integer in 0..`SESSION_SCORE_MAX` (10). Axes and weights: novel tokens 4 · file changes 3 · tool calls 1.5 · substance 1.5.
- Debt levels: 0-23 = Alert, 24-39 = Drowsy, 40-59 = Sleepy, 60+ = Must Sleep. Thresholds are named constants (`DEBT_DROWSY`/`DEBT_SLEEPY`/`DEBT_MUST_SLEEP`) in `sleep-consolidation.ts` — the single source of truth every directive/level derives from. Calibrated against measured DAILY volume so the busiest real day demands at most 3 consolidations.
- `DEBT_DEEP_AUTHORITY` (90) is a SEPARATE constant gating `deep` (destructive knowledge ops) — reaching Must Sleep does NOT authorize destruction.
- Post-consolidation cooldown: for `SLEEP_COOLDOWN_MS` (3h) after `last_consolidated_at`, `getConsolidationDirective` and `userPromptReminder` emit a "Cooling down" line instead of asking again. Bypassed by a hand-tagged ★★★ bookmark or debt ≥ `DEBT_COOLDOWN_OVERRIDE` (2× Must Sleep). Never blocks a user-requested sleep — it governs what the agent PROPOSES.
- `hook session-start` prepends a CRITICAL consolidation directive to the snapshot output when debt >= DEBT_MUST_SLEEP.
- `hook session-start` prepends a softer advisory note when debt >= DEBT_SLEEPY.
- `sleep status` shows current debt, level, last sleep date, and per-session history.
- `sleep add <score> <description>` manually records a debt entry (scores 1..SESSION_SCORE_MAX).
- `sleep done <summary>` resets debt to 0, records last_sleep date, clears sessions array.
- `sleep debt` outputs the raw debt number for programmatic use.
- If the same session_id stops twice, the old score is subtracted before the new score is added (no double-counting).
- Transcripts over 50MB are skipped (safety cap).
- `hook user-prompt-submit` fires on every user message, outputs a one-line reminder when debt >= DEBT_DROWSY or critical bookmarks exist, unless the post-consolidation cooldown is active. Silent below it. Read-only (no state writes).
- `hook session-start` catch-up path runs `detectSalience()` on any undigested sessions and writes auto-bookmarks to `.sleep.json`; then runs `session-digest.ts` to index bounded (≤8KB) transcript digests into the recall corpus.
- Auto-salience detectors fire on: user-correction (`no/actually/wrong/instead/hayır/yanlış/değil`, salience 2), error→fix (any error + any code change present, salience 1), decision keyword (`decided/chose/switched to/will use/karar/seçtik`, salience 2). Max 5 moments per session.
- Auto-captured digests and bookmarks indexed with `capture: true`; `CAPTURE_RANK_PENALTY = 0.5` applied in `rankScore` only (never raw `score`) so captures never crowd out curated knowledge.
- `sleep start` acquires an O_EXCL atomic stamp lock (via `src/lib/file-lock.ts`) before pinning the epoch; a concurrent caller that loses the race receives `SleepLockStatus.HELD`. `inspectSleepLock(state, nowMs)` returns the lock status with a 30-minute stale TTL — stale locks are auto-broken and re-raced. The launcher returns HTTP 409 "Sleep already running" when a live lock is detected, so callers receive an explicit signal rather than silent state corruption.

**v0.19.0 quality improvements (improve-sleep-quality task, AC1–AC9):**
- **AC1 — Pending-session awareness**: `getConsolidationDirective` and `userPromptReminder` compute effective debt = `debt + min(PENDING_PROVISIONAL_CAP, PENDING_SESSION_PROVISIONAL × pendingCount)` (pending = `score === null`; `PENDING_SESSION_PROVISIONAL=4`, `PENDING_PROVISIONAL_CAP=28` — rescaled 2026-07-29), directive output includes "N session(s) awaiting analysis", snapshot sleep section shows pending count, rhythm counter includes pending sessions. Provisional debt NEVER persisted into `state.debt`.
- **AC2 — Transcript-less salience**: when Stop fires with no transcript on disk, `detectSalience()` runs over `last_assistant_message` and writes capped auto-bookmarks (`capture: true`); 7-day finalization assigns a non-zero floor score when `last_assistant_message` is non-empty (`NEVER_FLUSHED_FLOOR_SCORE=2` since the 2026-07-29 rescale, `floorScoreForNeverFlushed()`).
- **AC3 — Transcript layout fallback**: one shared resolver (`src/lib/transcript-locate.ts`: `resolveTranscript()`, `listSubagentTranscripts()`) used by catch-up, `transcript distill`, and session-digest probes `<projectDir>/<sessionId>.jsonl` first, then directory layout (`<projectDir>/<sessionId>/` containing `subagents/`, `tool-results/`), so future location changes degrade gracefully.
- **AC4 — Depth decoupling**: catch-up finalization marks bulk-arrived debt (`SessionRecord.catchup_finalized`); `sleep start` depth resolution caps base depth at `standard` when ≥50% of current debt arrived via catch-up (`CATCHUP_DEEP_CAP_RATIO=0.5`, `catchupDebtSplit()`, `consolidationDepth({catchup?})`), unless user passes `--deep`. Cap is one-way: prevents auto-deep, never lowers below organic-debt floor, `--deep` always wins.
- **AC5 — Post-sleep durability**: after `sleep done`, when brain sync is OFF, print loud warning listing uncommitted `_dream_context/**` files with ready command `git add -A -- _dream_context && git commit -m "chore(brain): consolidate <date> sleep output"` (`collectBrainDirty()`, `renderBrainDirtyWarning()` in `src/lib/brain-dirty.ts`). `collectBrainDirty()` verifies projectRoot is its own git top-level (nested-repo guard) before trusting git status.
- **AC6 — Recidivism escalation**: per-flag recurrence persisted in `state/.sleep-flags.json` (`src/lib/sleep-flags.ts`: `reconcileFlags()`, `RECIDIVISM_ESCALATION_CYCLES=3`); at ≥3 consecutive cycles, sleep report surfaces decision ask and linked task priority is bumped (`bumpPriority()`). sleep-state gains standing authority to extract oldest Decisions to `knowledge/archive/` when core file at ceiling AND promotion blocked. Orphan-tag count ≥150 auto-creates/refreshes curator task (`ORPHAN_TAG_CURATOR_THRESHOLD=150`, `planCuratorTask()`).
- **AC7 — Measurement**: Layer-2 live-LLM run executed, `eval/sleep-quality/RESULTS.md` filled for dedup(4) + capture-promote(6); sleep orchestration includes dedup-log digest in cycle summary ("X merge / Y review / Z create since epoch" from `.embeddings/dedup-log.jsonl` via `summarizeDedupLog()`, `renderDedupDigest()` in `src/lib/embeddings/dedup-log.ts`). Fixture gap identified: no duplicate-knowledge pair exists in the test corpus, so the dedup-review verdict half of the metric is untestable in the current eval harness.
- **AC8 — Sub-agent harvest + session→task links**: `transcript distill --subagents` ingests `<session>/subagents/agent-*.jsonl` findings (`mergeDistilled()`, `distillSubagents()` in `src/cli/commands/transcript.ts`); session records' `task_slugs` populated from `--task` bookmarks AND `state/*.md` edit detection during transcript analysis.
- **AC9 — Operational hygiene**: (a) `.session-digests/` GC at `sleep done` — keep newest K=50 + digests of still-pending sessions (`planDigestGc()`, `scanDigests()`, `runDigestGc()` in `src/lib/session-digest.ts`; `DIGEST_GC_KEEP = MAX_INDEXED_DIGESTS`); (b) GitHub task-backend content-creation calls during sleep get write-spacing to avoid secondary rate limits (`ApiAdapterOptions.minWriteIntervalMs`, `GITHUB_MIN_WRITE_INTERVAL_MS=1000` in `src/lib/task-backend/github.ts`).

**v0.27.0 — tunable settings, the filing bar, background auto sleep (umbrella task, 18 ACs):**
- **Thresholds are configuration, not constants**: `DEBT_DROWSY/DEBT_SLEEPY/DEBT_MUST_SLEEP` become `DEFAULT_SLEEP_THRESHOLDS`; `resolveSleepThresholds(cfg)` reads `.config.json` `sleep.thresholds`, validates the ladder monotonically (`drowsy < sleepy < mustSleep`, a violation resolving to the DEFAULTS wholesale, never half-applied) and DERIVES `deepAuthority = round(mustSleep × 1.5)` and `cooldownOverride = mustSleep × 2` from the OVERRIDDEN base.
- **One source for every surface**: hook directives, `sleep` CLI, the `/api/sleep` payload (`thresholds`) and the dashboard (`dashboard/src/hooks/sleepLevels.ts`, `SleepDebtTracker`, `SleepPage`, `SleepFlowSection`) read the same ladder; the drift test gained a DYNAMIC case proving a custom payload changes `getSleepLevel`'s answer.
- **Per-specialist model + effort**: each of the six specialists takes a `model` / `effort` override; injected into `.claude/agents/sleep-*.md` frontmatter by `installAgentForPlatform` (the single copy site), so it survives install-skill/setup/update. A changed setting touches ONLY that specialist, and a customized agent body is never overwritten — customization is decided against a stored `baselineSha` (canonical form: LF, YAML re-serialised with `model`/`effort` removed and keys sorted), so a CRLF checkout, reordered keys, or our own injection never read as a customization, and malformed YAML falls to the SAFE answer (customized) without throwing.
- **Unknown models are refused** by `sleep config set` and `PATCH /api/config` (`--allow-unknown` on the CLI only); `dreamcontext doctor` warns while a non-monotonic ladder or an unknown specialist model is configured; a specialist that fails at run time surfaces as a `failed` sidecar + notification.
- **Zero-config parity**: a brain with no `sleep: {}` block behaves byte-for-byte as before. Scoring (`scoreSession`, `SESSION_SCORE_MAX`) is deliberately UNCHANGED — thresholds are tunable, scoring is not.
- **The filing bar is one choke point**: `assertTaskFilingBar()` (`src/lib/task-filing-bar.ts`) is called by BOTH `tasks create` and `POST /api/tasks`. It engages under a LIVE sleep lock (stale locks do not count) or `DREAMCONTEXT_AUTO_SLEEP=1`, and `--by human` is always exempt with the escape hatch named in the refusal. Under the bar: ≥`MIN_SLEEP_WHY_CHARS` (40) of justification, the per-cycle cap (`maxNewTasksPerCycle`, default 5, curator chore exempt) tracked in `.sleep.json` `cycle_tasks_filed`, and a refusal for any slug with an open tombstone.
- **Tombstones**: `state/.task-tombstones.json` (cap 500) written by `delete` and `rename`; `tasks delete --into <slug>` records `absorbedBy`; `resolveTombstone` follows the chain transitively (cycle-safe, `MAX_TOMBSTONE_HOPS=10`); `planCuratorTask` returns `refresh-absorbing` when the absorber is still open and allows a fresh create only when the chain dead-ends or the absorber shipped. The curator chore is now born WITH its Why.
- **Background auto sleep is default OFF and machine-local**: `shouldStartAutoSleep()` (`src/lib/auto-sleep.ts`) starts only when `.brain-local.json` `autoSleep.enabled === true` — seven named refusals otherwise (`nested`, `disabled`, `below-trigger`, `cooldown`, `sleep-in-progress`, `already-running`, `consent-stale`), each with a sentence a human can read.
- **The Stop hook is the only trigger** (no timer/server tick in v1): after the state write it evaluates the decision and detach-spawns `dreamcontext sleep auto-run`; `DREAMCONTEXT_AUTO_SLEEP=1` and `isNestedClaudeHook()` make a cycle chaining another cycle impossible.
- **The runner REUSES the automations core** — `executeClaudeDetached` + `sanitizeAutomationPrompt` + `killRunGroup`, not a second spawn implementation: 40-minute timeout, `--disallowedTools WebFetch,WebSearch,mcp__*` (Agent stays ON — fan-out IS the flow), an untrusted-content preamble, and a sidecar written SYNCHRONOUSLY at spawn.
- **Consent is a fingerprint, not a boolean**: `currentAutoSleepFingerprint()` covers the specialists model/effort map, the cap, the trigger and the six per-agent customization digests — and deliberately NOT the shipped version, so a routine `dreamcontext update` does not pause the brain. Drift pauses auto sleep and is the ONE exception to nag silence (a single SessionStart line).
- **Nag silence**: while auto sleep is on, every debt- and rhythm-driven directive (including the ★★★ bookmark notice) is replaced by one line — "Auto sleep is ON for this machine — never run, offer, or recommend a sleep cycle".
- **Liveness-aware lock**: `inspectSleepLockLive()` refuses to call a lock stale while a background sidecar's PID is alive — `SLEEP_LOCK_STALE_MS` (30 min) is SHORTER than a real six-specialist cycle, so without this a live cycle was reclaimable at minute 31 and the filing bar switched off mid-cycle. The dispatcher re-verifies ownership after any wall-clock gap > 5 min (a suspended machine) and aborts itself if it lost the run.
- **Two writers, one brain**: `withTaskFileLock()` (`state/.locks/<slug>.lock`, 3 s bounded wait, then a LOUD `TaskFileBusyError`) wraps `create`/`updateFields`/`insertSection`/`addChangelog`/`delete`/`rename`; `withSleepStateLock()` wraps the WHOLE read-modify-write of `.sleep.json` at every mutation site and fails OPEN for hooks (a hook must never hang a turn) while `sleep start/done/add` fail loudly. Lock and sidecar paths are in both gitignore builders; `.task-tombstones.json` deliberately syncs.
- **Hands-off set**: `activeTaskSet()` = `.active-task` + `task_slugs` of sessions live in the last 30 minutes; injected into the background prompt, and `sleep-tasks` reports those slugs as "Deferred (hands-off)" instead of touching them.
- **Verified by a REAL cycle on this brain, not by reasoning** (D7 checklist, 2026-09-05): model proof read from the background run's own subagent transcripts (`sleep-tasks` = claude-opus-5 override, `sleep-product` = claude-opus-5, `sleep-state` = claude-sonnet-5); an override survived a real `update --core-only`; a Stop hook actually spawned a detached cycle (~13 min, debt 61 → 14) whose nag output was the single "Auto sleep is ON" line; a foreground changelog write made DURING the cycle survived it.
- [ ] KNOWN VERIFICATION GAP (carried, not closed): `sleep-tasks`' "Candidates NOT filed (cap)" report line is prompt-driven — only the mechanical cap is unit-tested; the wording is checked by hand in a manual cycle.

**[unreleased] Fold by default, file by exception — two more gates on the filing bar plus three prose rules (task `sleep-folds-work-into-existing-tasks-by-default-and-files-a-new-task-only-as-a-high-confidence-exception`):**
- **Gate order is cost-ordered**: cap → ≥40-char why → tombstone → **declined-exact (pure file read)** → **semantic neighbour** → **declined-semantic**. A capped / thin / tombstoned / exactly-declined candidate never pays the ~1 s embedder load. `--by human` still short-circuits before any I/O, so the dashboard form never loads a model.
- **Neighbour gate** (`dedupCandidate(…, {types:['task'], excludeCapture:true})`): merge band (≥0.97 + 0.02 margin) refuses naming the slug and the `tasks insert` fold-in command, with no escape but `--by human`; review band (≥0.91) refuses unless `--neighbor-checked <slug>` names exactly that slug. Archived tasks (`state/archive/`) are valid neighbours; session digests are excluded before the verdict is computed, because the `task` corpus folds them in.
- **Three preconditions or it fails open**: `isEmbedModelDownloaded()` ∧ `embeddingCacheUsable()` ∧ **`embeddingCacheCoversType(root,'task')`** (new, `TYPE_COVERAGE_MIN = 0.8`). Any false → PASS with `neighbor: {state:'unavailable', why:'disabled'|'no-index'|'model-unavailable'}` and a printed notice — silence is never mistaken for a clean check. `DREAMCONTEXT_FILING_BAR_SEMANTIC=0` is the kill switch.
- **Declined store**: `state/.task-declined.json` — BRAIN CONTENT, synced (never on the brain-sync deny-list), newest-first, cap 500, corrupt → `[]`. `tasks decline "<topic>" --reason` (reason ≥20 chars), `tasks declined`, `tasks undecline <key>`; key = `slugify(topic)`. Exact-slug match refuses unconditionally with the date and reason; a semantic match at `DECLINED_MATCH_THRESHOLD = 0.82` refuses unless `--declined-checked <key>` names it.
- **Every task filed under the bar writes its neighbour verdict to the dedup log**, so `sleep done`'s "Semantic dedup since epoch" digest covers task creates. The log WRITER moved out of `embed.ts` into `dedup-log.ts` — one writer per format.
- **Prose rules the bar cannot check** (`agents/sleep-tasks.md`): sessions read oldest→newest with **latest-session-wins** (a candidate a later session cancelled/narrowed dies, and no status bump may come from a transcript older than the newest session on that task); **lands-in-THIS-project** (a connected vault's or a non-roster person's work is reported under "Out of scope", never filed); **direct-evidence rubric** (user ask / file changes no live task covers / a task-less bookmark file now — "it was discussed" defers).
- **Deferred candidates are flags, not tasks**: indirect candidates are emitted as `task-candidate:<key>::"<label + evidence>"` into `.sleep-flags.json`; `escalations()` excludes the `task-candidate:` family (a never-filed idea has no task to bump and gets no "escalate?" ask) and `sleep done` prints `Deferred task candidates: n` instead. A candidate is filed only when a later cycle independently re-observes it; one not re-observed is dropped by `reconcileFlags`.
- Validation: `tests/unit/{task-filing-bar,task-declined,sleep-flags,task-filing-markers}.test.ts` + `tests/integration/task-filing-bar-end-to-end.test.ts` (32/32, 6 model-gated cases proven non-vacuous under `DREAMCONTEXT_FILING_BAR_SEMANTIC=0`); full suite 497 files / 9419 tests green. **W4 manual checklist on a real cycle is IN FLIGHT — this increment is uncommitted and unreleased.**

## Constraints & Decisions

- **[2026-09-11]** **A gate whose bands overlap becomes a proof-of-looking gate, not a refusal.** Measured on 14 real tasks of this brain (e5-small q8, short-vs-short, `passage:` both sides), same-idea declined similarity bottoms at 0.8256 while distinct pairs top out at 0.8984 — the bands OVERLAP, so no cosine separates "the idea the user dropped" from "an adjacent task". A hard refusal would silently block legitimate tasks with no exit the specialist could reach. Both semantic gates therefore refuse *unless the caller names the match back* (`--neighbor-checked <slug>`, `--declined-checked <key>`); naming is the proof it read the neighbour/reason, and a false alarm costs one flag, never a lost task. Only the exact-slug declined match is unconditional. Generalised as `knowledge/patterns/proof-of-looking-gate.md`.
- **[2026-09-11]** **Availability had to be checked per-CORPUS, not just per-model.** `embeddingCacheUsable()` only proves the cache matches the current model/version — every hybrid recall path refreshes type-scoped and additively, so a legitimately knowledge+feature-only cache is "usable" with ZERO task vectors. The gate would then cold-build the task index inline: 3,501 chunk slots × 89.2 ms ≈ **310 s inside one `tasks create`**, past a sleep sub-agent's Bash timeout. `embeddingCacheCoversType()` makes that path unreachable; the warm path is an additive re-embed of only what the cycle rewrote (≈12 s on the first create, ~1–2 s after). No timeout wrapper: `dedupCandidate` is not cancellable, so a `Promise.race` would return early while a WASM inference kept the process alive.
- **[2026-09-11]** **Sleep MAY still file tasks — the fix is precision, not a ban, and nothing is interactive.** Owner decision: no proposal inbox, no approval UI, no human step anywhere. Confidence comes from deterministic gates plus repetition across cycles (`task-candidate:` flags). The per-cycle cap stays as is. Scoring, the curator chore's cap exemption, and `sleep-state` / `sleep-product` / `sleep-learn` behaviour were explicitly out of scope.
- **[2026-09-11]** **`state/.task-declined.json` is brain content, synced like tombstones.** A teammate's cycle must not re-file what you declined here. Declined is ONLY for ideas that never became a task — `tasks status <slug> cancelled` and `tasks delete` already tombstone. FOLLOW-UP carried, not filed: on a task corpus this homogeneous, review-band hits may approach universal and degrade `--neighbor-checked` into a reflex; measure with `embed dedup --types task --json --no-log` after a few real cycles and tune via `DREAMCONTEXT_DEDUP_REVIEW` — no code change required.
- **[2026-09-06]** **Background auto sleep ships DEFAULT OFF, machine-local, Stop-hook-only.** An autonomous job that burns tokens without the user watching must be switched on deliberately, so the on/off flag, the trigger choice (`must-sleep` default, `sleepy` the second option) and the consent fingerprint live in `state/.brain-local.json` (gitignored, never synced) while thresholds, models and the cap live in the SYNCED `.config.json`. No timer and no server tick in v1 — `knowledge/macos-launchd-scheduler-constraints.md` (no watchdog, a sleeping machine misses fires, minimal PATH) pushed that to v2. RECORDED RISK, unfixed: on a TEAM brain, lowering `mustSleep` in the synced config can make several machines each start a cycle at their next Stop hook before the epoch lock syncs — a synced threshold change alone does not move the fingerprint. A cross-machine lock is v2.
- **[2026-09-06]** **The idle guard was REMOVED, and two-writer safety became its precondition.** The 2026-08-09 constraint "never run while an active session exists, non-negotiable" was overturned by the owner on 2026-09-04: the background cycle runs WHILE the user keeps working. What replaced it is not a weaker guard but a stronger one — per-file locks on the CLI task-write path plus a hands-off set the cycle defers. The lock's error policies are deliberately OPPOSITE: `withTaskFileLock` fails LOUD (silently writing unlocked would defeat the point), `withSleepStateLock` fails OPEN for hooks (a hook must never suspend a user's turn) but prints a visible one-line notice when it writes unlocked with a live background cycle present.
- **[2026-09-06]** **Consent is a fingerprint, not a boolean** (mirroring the automations approval hash). It covers what a USER or a TEAMMATE controls — the specialists model/effort map, the cap, the trigger, and a per-agent customization digest for the six installed agents — and deliberately EXCLUDES anything dreamcontext itself ships (prompt text, agent bodies, version), because the user already delegated that trust to `dreamcontext update` and hashing it would pause the brain silently after every routine refresh. A customization digest is `'none'` while the installed agent matches its stored `baselineSha`, so a package refresh does not pause; a stray or teammate edit does. Nag silence has exactly ONE exception: a paused brain that says nothing is worse than a nag, so `consent-stale` still injects a single SessionStart line.
- **[2026-09-06]** **`SLEEP_LOCK_STALE_MS` had to become liveness-aware.** 30 minutes is SHORTER than a real six-specialist cycle, so a live background sleep was declared stale at minute 31 — `sleep start` would take it over and, worse, the task-filing bar (which keys off "is a cycle live?") would switch off mid-cycle. `inspectSleepLockLive()` treats a lock as fresh while the sidecar's PID is alive. Liveness is the PID, not a timer: a laptop suspended for two hours resumes with the pid intact and nothing was reclaimed meanwhile, and a hung-but-alive run is bounded by the dispatcher's own 40-minute kill matrix. No automatic reaper and no `ps`-based pid-reuse probe — this codebase deliberately prefers human-confirmed `sleep auto cancel`, exactly like `automations kill`.
- **[2026-09-06]** **The junk-task bar is a FLOOR against the template, not a quality judgment — and the diagnosis rewrote the plan.** B0 was run against real data (the planned `git log --diff-filter=A -- _dream_context/state/` method is IMPOSSIBLE in this repo: `state/` is gitignored, so task files are not in git history; the diagnosis was done from the files' own metadata instead). Findings over n=116 tasks filed since 2026-08-01: justification length min 0, p10 460, median 2532 characters; the thinnest REAL task is 146 characters; and exactly ONE task had zero justification — `curator-pass-orphan-tags`, i.e. the known re-filed chore itself. Three consequences: (1) the deterministic 40-character bar catches the empty template and nothing else — raising it to the observed floor would reject real tasks, so the "is this task worth filing?" judgment stays with the PROMPT (`agents/sleep-tasks.md`), (2) the bar CANNOT require a `## Why` heading — 11 tasks are GitHub-issue-shaped (Scenario / Expected / Gap), this brain's documented task format, and carry MORE evidence than a Why paragraph, so the bar looks for justification PROSE, (3) the owner's "sleep keeps filing junk" complaint was REPETITION, not volume — 115 of 116 were justified; the real defect was one merged-away chore resurrecting every cycle. That is why the weight of the fix is the tombstone, not the character count.
- **[2026-09-06]** **Per-specialist models re-decided with rationale** (D3): `sleep-tasks` and `sleep-product` run `claude-opus-5` at `effort: medium` — they make judgment calls (what deserves a task, whether a finding is new), and their output IS the brain's prose; `sleep-state`, `sleep-migration`, `sleep-federation` and `sleep-learn` run `claude-sonnet-5` at `effort: low` — largely mechanical reconcile. These are the SHIPPED DEFAULTS in `agents/sleep-*.md`, overridable per brain. Proven from a real cycle's subagent transcripts, not from an agent's own report.
- **[2026-09-06]** **The lesson the green suite did not teach.** 283 new tests were ALL GREEN while two genuine lost-write races were live — a stale read inside the lock in the hook's knowledge-access bump, and `create()`'s `already_exists` check sitting OUTSIDE the lock. A lost write throws nothing, so only a genuinely concurrent test or a human reading the lock boundaries makes it visible; a clean reviewer gate and a REAL run are not substitutable by a green suite. The real background cycle then found a third-class bug no test caught: the auto-sleep changelog entry was never written, because the runner read the epoch BEFORE spawning while the cycle stamps it seconds later — the heartbeat now learns the epoch on first sight.
- **[2026-08-13]** PR #295: consolidated work stops re-booking itself, so debt can reach 0; brain-dirty reports inconclusive on un-rebasable paths. Two fixes: (1) A session spanning a consolidation re-booked its whole history at its next Stop because sleep deletes the session RECORD but the transcript file stays, so the re-stop scored the file from scratch and debt could never settle at 0. `analyzeTranscript` (`src/lib/sleep-consolidation.ts`) now takes the last-consolidation timestamp (`lastConsolidatedAt`) and skips records at or before it — the session still contributes to rhythm and provisional counters, but its score is zeroed. Sleep fan-out sessions stop charging themselves ~10 debt per cycle for the same reason. (2) `collectBrainDirty` (`src/lib/brain-dirty.ts`) dropped any git status entry that failed to resolve under projectRoot (case-folding, exotic symlink) and came back as `{ paths: [], unavailable: false }` — read as "clean" by the renderer. A non-rebasable entry means the assumption broke; now reports `unavailable: true` (inconclusive: "I can't tell if the brain is dirty") rather than falsely clean. The brain-dirty warning's entire job is to stop a stray `git checkout .` from erasing a sleep's output; a false negative here is the worst possible failure mode.
- **[2026-07-20]** sleep-learn specialist added (v0.19.0, proactive learning layer). Fourth conditional specialist (`agents/sleep-learn.md`) joins the roster, dispatched only when `learning.enabled` AND (open/draft theses have fresh evidence OR ≥2 sleeps cadence due). Owns `_dream_context/theses/*.md` exclusively — re-tests theses, derives confidence, flips validated/invalidated, appends understanding changelog. No-op cheap when nothing is due. See [proactive-learning-layer](proactive-learning-layer.md) and [sleep-fanout-architecture](sleep-fanout-architecture.md) PRDs.
- **[2026-07-29]** **Consolidation cadence capped at ~3/day — thresholds re-derived from DAILY volume, plus a 3-hour cooldown.** The first pass of this rescale set Must Sleep so the SESSION count between sleeps matched the observed history. That was the wrong invariant to preserve: the history was already consolidating 2–3× a day, sometimes twice within an hour, which is what the user was actually complaining about. Re-measured the real thing — accrued debt PER DAY over 30 days under the weighted scorer: p25 12 · p50 42 · p75 107 · p90 168 · max 185. At Must Sleep 30 the busiest day demanded **six** consolidations. Thresholds are now Alert 0–23 · Drowsy 24–39 · Sleepy 40–59 · **Must Sleep 60+** (deep authority 90), read straight off that distribution: median day 0 required sleeps (Sleepy advisory only — the user decides), p75 day 1, p90 day 2, busiest day 3. `RHYTHM_SESSIONS` 5 → 12 for the same reason: active days run 24–40 sessions, so at 5 the rhythm advisory alone fired half a dozen times a day; the weighted scorer already prices small sessions honestly (12 light sessions ≈ 24 debt = Drowsy), so rhythm can be a backstop rather than the primary nag. `PENDING_PROVISIONAL_CAP` 16 → 28, holding its `DEBT_DROWSY + 4` relationship.
- **[2026-07-29]** **`SLEEP_COOLDOWN_MS` (3h) — the time floor.** A threshold bounds how much work one sleep is worth; it cannot bound how close two sleeps land, so a heavy afternoon can still stack three consolidations into three hours with perfectly correct debt arithmetic. `inspectSleepCooldown(state, nowMs, debt)` reads `last_consolidated_at` (millisecond ISO — deliberately NOT `last_sleep`, a bare date, nor `sleep_started_at`, which is a LOCK cleared every cycle) and suppresses both `getConsolidationDirective` and `userPromptReminder` for 3 hours, printing a "Cooling down" line instead. Three hours because a full active day then admits ~3 consolidations, which is what the debt thresholds independently target — the two mechanisms agree on the ceiling instead of one silently overriding the other. Two bypasses: a **★★★ bookmark** (salience 3 is only ever set by hand — the auto-detectors top out at 2 — so it is a deliberate "this matters now"), and `DEBT_COOLDOWN_OVERRIDE` = 2× Must Sleep, an escape hatch that needs ~120 debt inside 3h when the busiest day ever measured accrued ~18/hour, i.e. it should essentially never fire. Every degenerate stamp (null / unparseable / in the FUTURE from clock skew) resolves to "no cooldown", so a bad timestamp can only ever make the brain nag as before — never silence it indefinitely. The in-progress LOCK still takes precedence, and a user-requested sleep is never blocked: the cooldown governs what the agent PROPOSES.
- **[2026-07-29]** **Per-session scoring replaced: weighted sum 0–10, and token volume finally counts.** The old scorer was `max(scoreFromChangeCount, scoreFromToolCount, scoreFromSubstance)`, three saturating 0–3 buckets. Measured over **395 real transcripts in this project's own history, 77% of sessions scored exactly 3** — the MEDIAN session sat at the ceiling (observed medians: 6 changes, 47 tools, against bucket ceilings of 9 and 41; observed maxima 188 and 691). A 42-change/155-tool session and a 13-change/103-tool one were indistinguishable, and total debt degenerated into `3 × session count`. Token volume was not an input in any form, so burning 100k extra tokens in an already-scored session moved debt by exactly zero — the reported bug. Replacement: `scoreSession()`, a log-compressed weighted SUM over novel tokens (weight 4, k=100k, full=3.5M) · file changes (3, k=2, full=40) · tool calls (1.5, k=10, full=200) · substance (1.5, stepped), rounded to an integer 0..`SESSION_SCORE_MAX=10`. Same corpus now spreads p10=1 · p50=5 · p90=9 with 1.5% at the ceiling; dynamic range p10→p90 went 3.0× → 6.2×. Log rather than linear because the underlying quantities are log-normal (novel tokens span 105k at p10 to 15.6M at p100) — linear would let one outlier swamp every threshold, a hard cap alone throws away the top decile. **`cache_read_input_tokens` is deliberately EXCLUDED** from the token axis: it is the same prefix re-read every turn, running 20–40× the novel total (one real session: 341M cache-read vs 15.6M novel), so counting it would measure `turns × context size` rather than work. Sub-agent transcripts are now folded in via `analyzeSession()` — a fan-out session previously contributed ONE `Task` call while ten agents burned millions of tokens invisibly. The three legacy scorers are RETAINED and exported unchanged because `eval/sleep-quality/scorer.ts` pins its frozen before/after profiles to them.
- **[2026-07-29]** **Debt thresholds rescaled and `deep` decoupled from Must Sleep.** Levels are now Alert 0–11 · Drowsy 12–19 · Sleepy 20–29 · **Must Sleep 30+**, calibrated so the CADENCE matches the observed history (113 cycles, mean 5.37 sessions/cycle, mean session score 5.38) while becoming responsive to session weight: a typical session reaches Must Sleep in ~6, a heavy one in ~4, a light one in ~9. Under the old scale all three were identical. Derived constants moved with the scale: `PENDING_SESSION_PROVISIONAL` 2→4 (same 69% ratio to the mean it always held), `PENDING_PROVISIONAL_CAP` 12→16 (still `DEBT_DROWSY + 4`, still strictly below Must Sleep so provisional debt alone can never demand consolidation), `NEVER_FLUSHED_FLOOR_SCORE` 1→2, `sleep add` range 1..3 → 1..10. **New `DEBT_DEEP_AUTHORITY = 45`** now gates `depthFromDebt`'s `deep` tier instead of `DEBT_MUST_SLEEP`: destructive knowledge ops (merge-with-delete, archive/delete) required only "consolidation is overdue" before, so the cycle carrying the most unconsolidated material automatically received the most destructive authority — 16/89 cycles started at Must Sleep and the three sleeps before this change (32/21/21) were all auto-deep. AC4's catch-up cap treated a symptom; this removes the coupling. 1.5× Must Sleep is deliberate: "consolidate soon" and "you may delete things" are different claims needing different evidence. `--deep` still overrides.
- **[2026-07-29]** Migration `0.23.0` (`rescale-legacy-sleep-debt`) multiplies existing session scores by `LEGACY_SCORE_RESCALE=3` and recomputes debt. Shipping the higher thresholds WITHOUT it would be a silent regression in the dangerous direction: a project at debt 19 ("Sleepy, consolidate soon") would read as "Drowsy" after upgrade and defer an already-overdue consolidation, with nothing reporting an error. Idempotent — only records lacking `scoring_version` are touched, and each is stamped. PENDING sessions (`score === null`) are deliberately left alone so the SessionStart catch-up scores them from their transcripts with the new scorer rather than rescaling a guess.
- **[2026-07-18]** v0.19.0 quality improvements (improve-sleep-quality task). End-to-end sleep audit surfaced 9 gaps: Claude Code's lazy transcript flush broke capture (auto-salience yield Jun 1.85 → Jul 0.44 bm/session; 16/89 cycles started at Must-Sleep with auto-deep authority from bulk catch-up debt); late debt = automatic destructive authority; recidivism never escalated (208 orphan tags carried "for a future curator pass" for months); uncommitted brain output fragile. Fixes: AC1 pending-session provisional debt (estimate gap, never persisted); AC2 transcript-less salience floor (detect over `last_assistant_message` + 7-day floor score 1); AC3 layout fallback resolver (`transcript-locate.ts`); AC4 catch-up depth cap (≥50% catch-up debt caps auto-deep to standard, one-way); AC5 loud brain-dirty warning post-sleep; AC6 recidivism escalation (≥3 cycles → decision ask + priority bump; sleep-state archive authority; ≥150 orphan curator); AC7 Layer-2 eval run + dedup digest in cycle report; AC8 subagent harvest + session→task links; AC9 digest GC + GitHub write-spacing. Provisional debt lives in directive/display layer only (state.debt untouched, frozen eval regression guard preserved). AC5 default = loud warning only (no auto-commit — user decision). Agent prose contracts edited in canonical locations (`agents/`, `skill/references/`) then propagated via `npm run build`. Related prior: `fix-transcript-lazy-flush`, memory-engine-360 Wave 3.3, sleep-360-quality eval harness.
- **[2026-06-29]** Mutual-exclusion lock for sleep consolidation. `sleep start` acquires an O_EXCL atomic stamp lock via `src/lib/file-lock.ts`; a concurrent caller loses the race and receives `SleepLockStatus.HELD`. The launcher returns HTTP 409 "Sleep already running" when a live lock is held. `inspectSleepLock(state, nowMs)` exposes lock status with a 30-minute stale TTL (auto-broken and re-raced after expiry). `sleep_started_at` in `SleepState` serves as both the epoch stamp (`markSleepStart()`) and the lock's on-state timestamp. Reuses the O_EXCL pattern from `SyncLedger.acquireSyncLock`, generalized into a shared primitive. Rationale: an advisory check-then-write on a JSON field cannot prevent two processes from both passing the check before either writes.
- **[2026-06-29]** Debt scale rescaled ×2 and centralized. Levels are now Alert 0–7 · Drowsy 8–13 · Sleepy 14–19 · **Must Sleep 20+** (was 10+); directives fire at debt ≥8 (offer) / ≥14 (recommended) / ≥20 (required), and the rhythm reminder at **5** sessions-since-last-sleep (was 3). Per-session scoring is unchanged (max +3), so the consolidation cadence roughly doubles. All thresholds now live as named constants (`DEBT_DROWSY=8`, `DEBT_SLEEPY=14`, `DEBT_MUST_SLEEP=20`, `RHYTHM_SESSIONS=5`) in `sleep-consolidation.ts` — `sleepinessLevel`/`sleepinessRange`/`depthFromDebt` and every hook directive derive from them, so the scale can't drift across files again. Supersedes the 2026-03-01 tightening below.
- **[2026-06-15]** Task-status lifecycle refined: `sleep-tasks` now marks `completed` for tasks that are demonstrably done, low-risk, and already validated (chores, docs, mechanical fixes, well-covered tests) instead of reflexively bumping everything to `in_review`. `in_review` is reserved for tasks where a human must genuinely verify something (user-facing behaviour changes, design/architecture decisions, risky changes) or for handing the user a close decision on superseded/abandoned/obsoleted tasks. Backlog grooming formalized as a mandatory per-cycle step: pivot-relevance propagation, version re-attachment, tag normalization to taxonomy vocab. Old "max `in_review`" rule retired — it buried finished work and left rotting tasks half-closed.
- **[2026-06-04]** Dedup hardening shipped in specialist agent prompts. The top consolidation failure mode was fragmented near-duplicate tasks and knowledge files. `sleep-tasks` Step 2 now mandates recall-before-create + fold-in for smaller slices. `sleep-product` B2 adds a "sharp vs soft distinction" rubric — same family/vertical → extend existing file; genuinely separate topical concern → new file. See `sleep-fanout-architecture` PRD for specifics.
- **[2026-06-02]** Continuous capture (auto-digest + auto-salience) shipped in `memory-uplift` PR. SessionStart catch-up path now produces auto-bookmarks via `detectSalience()` (structural pattern matching, no AI) and auto-digest corpus docs via `session-digest.ts`. Captures are rank-penalized (`CAPTURE_RANK_PENALTY = 0.5` on `rankScore` only) and capped (K=50 most-recent digests) to prevent corpus pollution. Previously 30/32 consolidations had zero bookmarks — this closes the awake-ripple tagging gap without requiring manual bookmark discipline.
- **[2026-05-23]** Anti-bloat cap on core files tightened from 300 → **150 lines**. Sleep specialists (especially `sleep-state`) enforce this during consolidation: when a core file approaches the cap, content gets promoted to knowledge, archived, or condensed rather than appended.
- **[2026-05-23]** `2.memory.md` LIFO section removed. The file now contains **Decisions** and **Known Issues** only. Quick captures that used to land in the LIFO section now flow through `dreamcontext memory remember`, which writes a CHANGELOG entry (`type=note`, `scope=quick` by default) instead. CHANGELOG entries are indexed in the recall corpus, so the quick-capture data is more discoverable than under the old LIFO scheme.
- **[2026-05-10]** 5→3 specialist collapse. Always-fire domain merges: `sleep-state` = old sleep-core + sleep-changelog (soul/user/memory + CHANGELOG/RELEASES). Conditional domain merge: `sleep-product` = old sleep-knowledge + sleep-features (knowledge/ + core/features/). Rationale: parallel agents reduce wall-clock only to the slowest specialist; collapsing always-fire pairs reduces launch overhead without slowing the consolidation floor. See `sleep-fanout-architecture` PRD.
- **[2026-05-09]** Consolidation is orchestrated by the **main agent** via `skill/SKILL.md`'s "Sleep" section, fanning out to 3 domain specialists in parallel. An earlier design used a thin `dreamcontext-rem-sleep` orchestrator that dispatched specialists, but sub-agent → sub-agent dispatch did not fan out reliably in Claude Code. `dreamcontext-rem-sleep` was subsequently removed entirely — the main-agent SKILL.md flow is the only consolidation path. See `sleep-fanout-architecture` PRD for full design.
- **[2026-05-09]** Each specialist owns a non-overlapping file domain. `sleep-tasks` → `state/*.md`; `sleep-state` → `0.soul.md`/`1.user.md`/`2.memory.md` + `CHANGELOG.json`/`RELEASES.json`; `sleep-product` → `knowledge/` + `core/features/`. Specialists never edit outside their domain.
- **[2026-05-09]** No shared digest file. Each specialist calls the `dreamcontext` CLI directly to fetch its context. The orchestrator passes only a small text brief (epoch, session IDs, task slugs, planning version, signals, optional user hint).
- **[2026-02-27]** Bookmarks (awake ripples) are now the primary consolidation signal. Critical (salience 3) bookmarks trigger the consolidation advisory regardless of debt level. The rem-sleep agent processes bookmarks first.
- **[2026-02-27]** `freshDefaults()` replaces `DEFAULT_SLEEP_STATE` spread everywhere. Spreading a const with arrays shares references across calls -- this caused test pollution. Always call `freshDefaults()` when initializing an empty SleepState.
- **[2026-02-27]** Trigger `fired_count` is persisted by `writeSleepState()` inside `generateSnapshot()`. Triggers expire (removed from state) in `sleep done` after hitting `max_fires`. This is intentional -- persistent triggers that always fire become noise.
- **[2026-02-28]** `SleepHistoryEntry` extended with `consolidated_at: string` (ISO timestamp) and `session_ids: string[]`. `transcript distill` uses these to auto-filter: only shows content after `consolidated_at` for sessions that have already been consolidated. `--full` shows entire transcript; `--since <iso>` for manual cutoff.
- **[2026-03-02]** PreCompact hook added as 7th hook. Saves `CompactionRecord` (timestamp, trigger, debt, session_count, bookmark_count) to `compaction_log[]` in `.sleep.json` before context compaction. LIFO, capped at 20 entries. Prevents silent loss of sleep state context during compaction. `CompactionRecord` interface in `sleep.ts`.
- **[2026-03-02]** Pattern extraction (Step 1c) added to rem-sleep agent between Task Linkage Check and Step 2. Agent scans distilled transcripts for repeated preferences (2+), workflow patterns (3+), recurring errors (2+), bookmark themes (3+). Prompt-level only.
- **[2026-03-01]** Debt thresholds tightened: debt >= 4 now triggers directives (was >= 7). Rhythm check is 3+ sessions (was 5+). SKILL.md updated to mandate consolidation offers at Drowsy level. UserPromptSubmit hook added as 5th hook — fires on every user message with compact one-line reminder. Read-only. PostToolUse was considered and rejected (fires mid-work, wrong timing). 415 tests.
- **[2026-02-28]** Transcript distillation output quality improved: includes thinking blocks, subagent I/O (input+output, internal tool calls filtered), full content without truncation, byte deltas on Edit changes, line counts on Write. Trivial response filter removed.
- **[2026-02-27]** Transcript distillation is pure Node.js structural filtering, no AI. Keeps user messages, agent text, Write/Edit calls, modifying Bash, bookmark calls, errors. Discards Read/Glob/Grep/WebFetch results, tool metadata.
- **[2026-02-25]** Debt is tracked in `state/.sleep.json` (dot-prefixed to separate it from user task files in `state/`).
- **[2026-02-25]** Transcript analysis is regex-based (`/"name"\s*:\s*"(?:Write|Edit)"/g`), not a full JSON parse, for performance on large JSONL files.
- **[2026-02-25]** The consolidation itself is done by the `dreamcontext-rem-sleep` sub-agent, not by the CLI. The CLI only tracks debt; the agent dispatches the sub-agent when needed.
- **[2026-02-25]** Sessions array is LIFO (newest first) -- the most recent session is at index 0.

## Technical Details

**Sleep state file**: `_dream_context/state/.sleep.json`

**Schema** (see also `_dream_context/core/6.system_flow.md` for full annotated schema):```json
{
  "debt": 4,
  "sleep_started_at": null,
  "last_sleep": "2026-02-24",
  "last_sleep_summary": "Consolidated auth implementation and API design decisions",
  "sessions_since_last_sleep": 2,
  "sessions": [
    {
      "session_id": "abc123",
      "transcript_path": "/path/to/transcript.jsonl",
      "stopped_at": "2026-02-24T18:30:00.000Z",
      "last_assistant_message": "Implemented JWT middleware...",
      "change_count": 7,
      "tool_count": 35,
      "score": 2,
      "bookmarks": ["bookmark-id-1"]
    }
  ],
  "bookmarks": [
    {
      "id": "bk_abc",
      "text": "Decided to use freshDefaults() instead of DEFAULT_SLEEP_STATE spread",
      "salience": 3,
      "session_id": "abc123",
      "created_at": "2026-02-27T10:00:00.000Z"
    }
  ],
  "triggers": [
    {
      "id": "tr_abc",
      "pattern": "auth",
      "reminder": "JWT tokens expire after 24h -- always refresh before API calls",
      "tags": ["security"],
      "fired_count": 1,
      "max_fires": 5,
      "created_at": "2026-02-27T10:00:00.000Z"
    }
  ],
  "knowledge_access": {
    "jwt-auth-flow": "2026-02-27T10:00:00.000Z"
  },
  "sleep_history": [
    {
      "date": "2026-02-27",
      "summary": "Consolidated neuroscience session",
      "debt_before": 6,
      "debt_after": 0,
      "sessions_processed": 2,
      "bookmarks_processed": 3
    }
  ],
  "dashboard_changes": [],
  "compaction_log": [
    {
      "timestamp": "2026-03-02T10:00:00.000Z",
      "trigger": "manual",
      "debt": 6,
      "session_count": 2,
      "bookmark_count": 1
    }
  ]
}```
**Hook flow**:
1. Session ends → Claude Code fires Stop hook → `hook stop` reads stdin JSON, analyzes transcript, prepends session record to `sessions[]`, adds score to `debt`, writes state.
2. Next session starts → Claude Code fires SessionStart hook → `hook session-start` finds sessions with `score: null`, analyzes their transcripts, updates scores and debt. Then generates and outputs the snapshot with any consolidation directive prepended.

**Scoring function** (`src/cli/commands/hook.ts`): `scoreSession(analysis)` — weighted sum, 0..10 integer.

Each axis contributes `logPoints(x, k, full, weight)` = `weight × log2(1+x/k) / log2(1+full/k)`, clamped at `weight`. `k` is the curve's knee ("one unit of meaningful work"); `full` is pinned to ≈p95 of measured real sessions, so roughly the top 5% max out any one axis.

| axis | k | full | weight |
|---|---|---|---|
| novel tokens (`output + cache_creation + input`) | 100k | 3.5M | 4.0 |
| file changes (Write/Edit) | 2 | 40 | 3.0 |
| tool calls (all) | 10 | 200 | 1.5 |
| substance (stepped: ≥8 user turns, ≥25k assistant chars, ≥4 decision markers, ≥2 task slugs) | — | — | 1.5 |

`cache_read_input_tokens` is DELIBERATELY EXCLUDED from the token axis — it is the same conversation prefix re-read every turn, running 20–40× the novel total on real transcripts, so counting it would measure `turns × context size` instead of work.

Sub-agent transcripts (`<sessionDir>/subagents/agent-*.jsonl`) are folded in by `analyzeSession()`: their tokens, edits and tool calls sum into the session's analysis (no double counting — the main transcript records only the one `Task` call). `userTurns` is taken from the main transcript only.

The legacy `scoreFromChangeCount` / `scoreFromToolCount` / `scoreFromSubstance` functions are RETAINED and exported unchanged: `eval/sleep-quality/scorer.ts` pins its frozen before/after profiles to them.

**Key files**:
- `src/cli/commands/hook.ts` — hook stop, hook session-start, hook user-prompt-submit, hook post-tool-use, hook pre-compact, transcript analysis, debt scoring, bookmark linking, rhythm counter, findProjectConfig(), resolveLocalBin(). **[v0.19.0]** `getConsolidationDirective` + `userPromptReminder` compute `effectiveDebt()`, Stop-hook transcript-less `detectSalienceFromMessage()`, catch-up finalization with `floorScoreForNeverFlushed()` + `resolveTranscript()` + `catchup_finalized` stamp
- `src/cli/commands/sleep.ts` — sleep status, sleep add, sleep done, sleep debt, sleep history, SleepState type (Bookmark, Trigger, SleepHistoryEntry, KnowledgeAccessRecord), readSleepState/writeSleepState, freshDefaults(). **[v0.19.0]** `sleep start` passes `catchupDebtSplit()` to `consolidationDepth()`, `sleep done` repeatable `--flag <key>::<label>[::<slug>]`, 5 best-effort hygiene blocks (flags→escalation, curator task, dedup digest, digest GC, brain-dirty warning)
- `src/lib/sleep-consolidation.ts` — `SESSION_SCORE_MAX=10`/`DEBT_DROWSY=24`/`DEBT_SLEEPY=40`/`DEBT_MUST_SLEEP=60`/`DEBT_DEEP_AUTHORITY=90`/`RHYTHM_SESSIONS=12`/`SLEEP_COOLDOWN_MS`/`DEBT_COOLDOWN_OVERRIDE`/`inspectSleepCooldown()`/`formatCooldownRemaining()` constants; `SCORING_VERSION`/`LEGACY_SCORE_RESCALE`/`rescaleLegacySessions()`; `sleepinessLevel`/`sleepinessRange`/`depthFromDebt`; `markSleepStart()`/`inspectSleepLock(state, nowMs)`/`SleepLockStatus`; `clearSleepLock()`. **[v0.19.0]** `PENDING_SESSION_PROVISIONAL=4`/`PENDING_PROVISIONAL_CAP=28` (16 → 28 with the 2026-07-29 rescale, holding `DEBT_DROWSY + 4`), `effectiveDebt()`/`effectiveRhythm()`, `NEVER_FLUSHED_FINALIZE_MS`/`NEVER_FLUSHED_FLOOR_SCORE=2`/`floorScoreForNeverFlushed()`, `CATCHUP_DEEP_CAP_RATIO=0.5`/`catchupDebtSplit()`/`consolidationDepth({catchup?})`/`DepthDecision.cappedByCatchup`, `SessionRecord.catchup_finalized`/`Bookmark.capture`
- `src/lib/file-lock.ts` — `acquireFileLock(lockPath, nowMs, staleMs)`: O_EXCL atomic stamp lock via `wx` flag; stale-TTL break + re-race; cross-process mutex reused by both sleep and sync paths
- **[2026-08-01] The display layer** — `src/server/routes/sleep.ts` decorates GET/PATCH `/api/sleep` with `effective_debt`/`provisional_debt`/`pending_sessions` via `withEffectiveDebt()`, so the dashboard thresholds on the same value `getConsolidationDirective` does; `debt` stays the exact persisted ledger (what PATCH writes, what `sleep done` resets) and the provisional estimate is never written to disk. `dashboard/src/hooks/useSleep.ts` HAND-MIRRORS `DEBT_DROWSY`/`DEBT_SLEEPY`/`DEBT_MUST_SLEEP` (the dashboard is a separate Vite package with no import path into `src/`) and exposes `displayDebt()` = `effective_debt ?? debt`, consumed by `SleepDebtTracker.tsx` + `SleepPage.tsx`; `components/about/SleepFlowSection.tsx` renders the level table. That mirror silently drifted through BOTH rescales — the app read "Must Sleep 33/20" with a full bar and a sleeping mascot while the CLI said Drowsy 33/60 — so `tests/unit/dashboard-sleep-thresholds.test.ts` now parses both dashboard files as text and fails the build if they disagree with `sleep-consolidation.ts`.
- **[v0.19.0]** `src/lib/transcript-locate.ts` — `resolveTranscript()` (flat→dir layout fallback), `listSubagentTranscripts()` (cap 20, newest-first), `subagentIdFromPath()`
- **[v0.19.0]** `src/lib/sleep-flags.ts` — `reconcileFlags()`, `RECIDIVISM_ESCALATION_CYCLES=3`, `bumpPriority()`, `parseFlagOption()`, `ORPHAN_TAG_CURATOR_THRESHOLD=150`, `planCuratorTask()`, storage `state/.sleep-flags.json`
- **[v0.19.0]** `src/lib/brain-dirty.ts` — `collectBrainDirty()` (filtered to `_dream_context/`), `renderBrainDirtyWarning()` (≤15 listed; ready command, NO auto-commit)
- **[v0.19.0]** `src/lib/embeddings/dedup-log.ts` — `summarizeDedupLog()` (ts > since strict), `readDedupDigest()`, `renderDedupDigest()`, path `<contextRoot>/.embeddings/dedup-log.jsonl`
- **[v0.19.0]** `src/lib/session-digest.ts` — bounded ≤8KB digests, `capture: true`, K=50 cap. `DIGEST_GC_KEEP = MAX_INDEXED_DIGESTS`, `planDigestGc()`, `scanDigests()`, `runDigestGc()`
- **[v0.19.0]** `src/lib/task-backend/api-adapter.ts` + `github.ts` — `ApiAdapterOptions.minWriteIntervalMs`, `GITHUB_MIN_WRITE_INTERVAL_MS=1000` (spacing on POST/PATCH/PUT/DELETE only, applied before rate-window throttle)
- `src/cli/commands/bookmark.ts` — bookmark add/list/clear
- `src/cli/commands/trigger.ts` — trigger add/list/remove
- `src/cli/commands/transcript.ts` — transcript distill (structural JSONL filter). **[v0.19.0]** `mergeDistilled()`, `distillSubagents()`, `--subagents` option
- `src/cli/commands/snapshot.ts` — bookmarks section, warm knowledge tier, contextual reminders, sleep history in output, extractFirstParagraph(), trigger matching + fired_count persistence. **[v0.19.0]** pending-count line gated `pendingCount>0`
- `skill/SKILL.md` — "Sleep" section defines the main-agent orchestration flow (parallel fan-out to specialists)
- `agents/sleep-tasks.md` — domain: `_dream_context/state/*.md`. Logs progress, reconciles task bodies, updates Mermaid Workflow nodes. Status lifecycle: `completed` for demonstrably done + low-risk + already-validated tasks; `in_review` only when the user genuinely must verify something or for superseded/abandoned/obsoleted work (close decision handed to user). Also performs backlog grooming each cycle: pivot-relevance check, version re-attachment, tag normalization. Always fire.
- `agents/sleep-state.md` — domain: `_dream_context/core/0.soul.md`, `1.user.md`, `2.memory.md`, `CHANGELOG.json`, `RELEASES.json`. Surgical core-file updates, anti-bloat sweep, changelog entries, planning-version readiness. Merged from old sleep-core + sleep-changelog. Always fire.
- `agents/sleep-product.md` — domain: `_dream_context/knowledge/` + `_dream_context/core/features/*.md`. Creates/updates knowledge files, staleness sweep, updates and creates feature PRDs. Merged from old sleep-knowledge + sleep-features. Conditional dispatch.
- `.codex/agents/prompts/` + `.codex/agents/*.toml` — mirror of the 3 specialist agent files for the codex harness. All 5 old specialist files removed.
- `_dream_context/core/6.system_flow.md` — complete system lifecycle and data flow documentation

**[v0.27.0] Tunable settings, filing bar, background auto sleep** — key files as they exist today:
- `src/lib/setup-config.ts` — `SleepConfig` (`thresholds` / `specialists` / `maxNewTasksPerCycle`) under `.config.json` `sleep: {}`, `sanitizeSleep()` (drops every invalid field, never throws), `KNOWN_SLEEP_MODELS`, `SleepSpecialist`; `BrainLocalState.autoSleep { enabled, trigger, approvedAt, approvedFingerprint }` in the gitignored `state/.brain-local.json`
- `src/lib/sleep-consolidation.ts` — `SleepThresholds`, `DEFAULT_SLEEP_THRESHOLDS` (the old `DEBT_*` constants are now the DEFAULTS), `resolveSleepThresholds()`, `hasInvalidSleepThresholds()`; `sleepinessLevel`/`sleepinessRange`/`depthFromDebt`/`consolidationDepth`/`inspectSleepCooldown` all take a trailing optional thresholds param
- `src/lib/sleep-settings.ts` — the WRITE path (`sleep config set|reset`): ladder validation, `isKnownSleepModel()`, `DEFAULT_MAX_NEW_TASKS_PER_CYCLE=5`, `MAX_NEW_TASKS_CEILING=50`, `THRESHOLD_MIN/MAX`. Unlike the read path it is NOT silent — it names the rule it refused on
- `src/lib/sleep-specialist-frontmatter.ts` + `src/lib/install-packs.ts` — `applySpecialistFrontmatter()` / `applySleepSpecialistOverrides()`; `installAgentForPlatform` returns `{ relPath, baselineSha }` and the manifest carries `baselineSha`, so `isCustomizedAgent()` compares against a stored baseline rather than the live package
- `src/lib/claude-args.ts` — `sanitizeModel()` moved here so the CLI, the config route and every claude spawn share ONE regex
- `src/lib/task-filing-bar.ts` — `assertTaskFilingBar()`, `isSleepCycleLive()`, `cycleTasksFiled()`, `recordCycleTaskFiled()`, `MIN_SLEEP_WHY_CHARS=40`; called by `cli/commands/tasks.ts create` AND `server/routes/tasks.ts` `POST /api/tasks`
- `src/lib/task-tombstones.ts` — `state/.task-tombstones.json`, `MAX_TOMBSTONES=500`, `MAX_TOMBSTONE_HOPS=10`, `appendTombstone()`, `findTombstone()`, `resolveTombstone()`; `tasks tombstones` lists them, `tasks delete --into <slug>` records the absorber
- `src/lib/task-file-lock.ts` — `withTaskFileLock()`, `taskLockPath()`, `TASK_LOCK_STALE_MS=30_000`, `LOCK_WAIT_MS=3_000`, loud `TaskFileBusyError`
- `src/lib/sleep-state-lock.ts` — `withSleepStateLock()` (wraps the whole read-modify-write of `.sleep.json`), `autoSleepSidecarRunning()`; fails open for hooks with a visible notice
- `src/lib/auto-sleep.ts` — `shouldStartAutoSleep()` (seven named refusals), `activeTaskSet()` + `HANDS_OFF_WINDOW_MS` (30 min), `currentAutoSleepFingerprint()`, `readAutoSleepSidecar()`/`liveAutoSleepJob()`/`isPidAlive()`, `inspectSleepLockLive()`, `AUTO_SLEEP_SIDECAR_REL`/`AUTO_SLEEP_LOCK_REL`
- `src/lib/auto-sleep-runner.ts` — `runAutoSleep()`, `cancelAutoSleep()`, `recordAutoSleepChangelog()` (idempotent per epoch), `AUTO_SLEEP_TIMEOUT_MS` (40 min), `HEARTBEAT_MS` (60 s), `SUSPEND_GAP_MS` (5 min), `AUTO_SLEEP_DISALLOWED_TOOLS='WebFetch,WebSearch,mcp__*'`; reuses `executeClaudeDetached` + `sanitizeAutomationPrompt` from the automations runner and `notifyViaBundle` from its notifier
- `src/lib/sleep-prompt.ts` — `SLEEP_AGENT_PROMPT` (the same flow text the dashboard Sleep button submits, shared with `server/routes/launcher.ts` `buildSleepPrompt`), `buildAutoSleepPreamble(handsOffSlugs)`, `buildAutoSleepPrompt()`
- `src/cli/commands/sleep.ts` — `sleep config [set|reset]`, `sleep auto on|off|status|cancel`, hidden `sleep auto-run` (the detached dispatcher entry point — deliberately ONE entry point, not two)
- `src/cli/commands/hook.ts` — `autoSleepNagLine()` + `AutoSleepNagState`: while auto sleep is on, every debt/rhythm directive in `getConsolidationDirective` and `userPromptReminder` collapses to one line; the Stop hook evaluates `shouldStartAutoSleep` AFTER the state write and detach-spawns `sleep auto-run`
- `src/server/routes/sleep.ts` — `thresholds` on the `/api/sleep` payload; `GET/PUT /api/sleep/auto`, `POST /api/sleep/auto/cancel`, `GET /api/sleep/specialists` (registered through the standard router so the cross-site write guard applies)
- `src/server/routes/config.ts` — `PATCH /api/config` accepts a `sleep` block through the SAME functions the CLI uses (merge semantics; `null` = back to default) and calls `applySleepSpecialistOverrides` on a model/effort change
- `dashboard/src/components/settings/SleepSettings.tsx` (+ `.css`) — Settings › Sleep: three threshold fields with live derived deep/cooldown values and inline monotonic errors, the six-row specialist model/effort table showing what the package default IS, the cap, and the machine-local Auto sleep block; `dashboard/src/hooks/sleepLevels.ts` replaced the hardcoded dashboard copy of the ladder
- `src/cli/commands/doctor.ts` — warns on a non-monotonic configured ladder and on an unknown specialist model (both are otherwise silent no-ops)
- Agent defaults: `sleep-tasks` / `sleep-product` → `model: claude-opus-5`, `effort: medium`; `sleep-state` / `sleep-migration` / `sleep-federation` / `sleep-learn` → `model: claude-sonnet-5`, `effort: low`
- NOT shipped in v1 (recorded): server-tick/timer trigger, Telegram notification, Windows support for background sleep, scoring changes, cross-machine lock for team brains

**[unreleased] Fold by default, file by exception** — the filing bar's two semantic gates and the declined store:
- `src/lib/task-filing-bar.ts` — `assertTaskFilingBar()` is now **async** (both callers already sit in async handlers: `cli/commands/tasks.ts` `create` and `server/routes/tasks.ts` `handleTasksCreate`). `FilingBarInput` gains `name` / `description` / `neighborChecked` / `declinedChecked`; `FilingBarVerdict` gains `neighbor` and `notices[]`. `semanticGatesReady()` is the one availability decision (model downloaded ∧ cache usable ∧ `embeddingCacheCoversType(root,'task')` ∧ not `DREAMCONTEXT_FILING_BAR_SEMANTIC=0`). Gate order: cap → why-length → tombstone → declined-exact → neighbour → declined-semantic.
- `src/lib/task-declined.ts` **(new)** — mirrors `task-tombstones.ts` (raw `fs`, corrupt → `[]`, never throws, newest-first, cap on write). `DECLINED_REL_PATH='state/.task-declined.json'`, `MAX_DECLINED=500`, `MIN_DECLINE_REASON_CHARS=20`, `DECLINED_SEMANTIC_LIMIT=100`, `DECLINED_MATCH_THRESHOLD=0.82` (`DREAMCONTEXT_DECLINED_MATCH` override, read at call time). `matchDeclinedSemantically()` makes ONE `embedPassages` call over the candidate plus the newest 100 declined entries — no cache, no index, no corpus, ~200–400 ms worst case.
- `src/lib/embeddings/dedup.ts` — `DedupOptions.excludeCapture` drops session digests from the neighbour set BEFORE the verdict/top/margin are computed (the `task` corpus folds digests in at `recall.ts:875`, so a candidate would otherwise near-match its own digest and be unfoldable).
- `src/lib/embeddings/store.ts` — `embeddingCacheCoversType(root, type, minCoverage?)` + `TYPE_COVERAGE_MIN=0.8`, memoised by cache mtime. Deliberately optimistic (additive refreshes never prune, so stale docKeys over-report) — it can only fail to block a warm vault, never block a cold one wrongly. Returns `false` for any type but `'task'`.
- `src/lib/embeddings/dedup-log.ts` — now owns the log WRITER (extracted from `embed.ts`, which imports it back); the filing bar appends `{source:'filing-bar', verdict, topDocKey}` per create.
- `src/lib/sleep-flags.ts` + `src/cli/commands/sleep.ts` — `escalations()` excludes the `task-candidate:` key family; `sleep done` prints `Deferred task candidates: n` instead of an escalation ask. `reconcileFlags` semantics unchanged.
- `src/cli/commands/tasks.ts` — `tasks decline|declined|undecline`; `create --neighbor-checked <slug> --declined-checked <key>`. `src/server/routes/tasks.ts` forwards both (actor default stays `human`, so the dashboard form never reaches a gate — and it drops `verdict.notices`, a known one-line gap for an in-app `by:'sleep'` caller).
- `dashboard/src/generated/cli-manifest.json` regenerated (`npm run gen:cli-manifest`) — `tests/unit/cli-manifest.test.ts` asserts `tasks create`'s value flags.
- Prose surfaces: `agents/sleep-tasks.md` (latest-session-wins, board map, lands-in-THIS-project, direct-evidence rubric, refusal-message table, new report lines), `skill/SKILL.md` rule 5 + the bookmark checkpoint row, `skill/references/tasks-and-features.md` § Create, `skill/references/sleep.md` step 3 (chronological brief, `sort_by(.stopped_at)`) and step 10 (`task-candidate:` flag family).

**Consolidation flow** (main-agent orchestration, primary path):

1. Main agent calls `dreamcontext sleep start` to pin the epoch.
2. Main agent builds a small text brief from `cat _dream_context/state/.sleep.json`, `git status --short`, `git log --since=...`, and `dreamcontext core releases active`.
3. Main agent dispatches in **parallel** from a single message:
   - **Always**: `sleep-tasks`, `sleep-state`.
   - **Conditional** based on signals: `sleep-product` fires when any of these are true: research/decision in `last_assistant_message`, `knowledge_access` ≥30 days stale, research bookmark exists, task slug matches a PRD filename, git changes under `core/features/` or `knowledge/`, user hint names a feature or mentions knowledge, criterion advanced or buildable concept lacks a PRD.
   - When unsure, **over-fire** `sleep-product` — it no-ops cheaply.
4. Each specialist returns a short structured report. The main agent waits for all of them.
5. Marketing pass if `_dream_context/marketing/` exists; council promote check.
6. Main agent calls `dreamcontext sleep done "<summary>"` with a one-paragraph summary stitched from specialist reports. This clears pre-epoch state and resets debt.

**No fallback**: `dreamcontext-rem-sleep` was removed (2026-05-09 cleanup). If fan-out is impossible, specialists may be invoked manually in sequence. The main-agent SKILL.md flow is the only supported path.

**Specialist context**: each specialist receives only the small text brief in its prompt — never transcript content. Specialists call `dreamcontext transcript distill <id>` themselves if they need session detail. The `dreamcontext` CLI is the single source of truth; there is no shared digest file.

## Notes

- The Stop hook does not block the session from ending — it has a 5-second timeout. If it fails silently, the SessionStart hook catches up by re-analyzing the transcript.
- The `last_assistant_message` field from the Stop hook is the single most valuable piece of data for the REM sleep agent — it contains Claude's summary of what was accomplished, making transcript reads optional in most cases.
- Manual debt entries (`sleep add`) use a `manual-<timestamp>` session_id and `transcript_path: null`. They will never be re-analyzed by the SessionStart hook.
- The **main agent** calls `dreamcontext sleep done "<summary>"` after all specialist reports return — not any specialist sub-agent. Specialists return reports; the main agent stitches and finalizes.

## Changelog

### 2026-09-11 - [unreleased] Fold by default, file by exception
- Reconciled from task `sleep-folds-work-into-existing-tasks-by-default-and-files-a-new-task-only-as-a-high-confidence-exception` (PLAN v2, 12 tasks / 4 waves, 4 review rounds). The filing bar gained a semantic neighbour gate and a declined-idea gate; `tasks decline|declined|undecline` and `--neighbor-checked` / `--declined-checked` shipped; `task-candidate:` flags defer indirect candidates; `agents/sleep-tasks.md` gained latest-session-wins, lands-in-THIS-project and the direct-evidence rubric.
- **UNCOMMITTED and UNRELEASED at the time of writing** — the automated half passed (497 files / 9419 tests, e2e 32/32 with 6 model-gated cases proven non-vacuous), the W4 manual checklist was running on this very cycle. Four user stories and the AC block are unticked on purpose.
<!-- LIFO: newest entry at top -->

### 2026-09-07 - v0.27.0 — the brain consolidates itself, on thresholds you set
- Consolidates four completed tasks: `sleep-umbrella-tunable-settings-a-bar-against-junk-tasks-and-background-auto-sleep-with-two-writer-safety` (umbrella, 18 ACs), `sleep-settings-become-tunable-debt-thresholds-and-per-specialist-models` (A), `sleep-stops-filing-junk-tasks-a-bar-for-what-deserves-a-task-and-the-right-model-per-specialist` (B), `sleep-runs-itself-in-the-background-when-debt-is-high-instead-of-nagging` (C+D). Landed on main as ff7aa67 (70 files, +15,737) + 8f84cbb (the verification cycle's own consolidation output); released 2026-09-06.
- **A — Settings**: `sleep: {}` in `.config.json` (thresholds / per-specialist model+effort / cap); `resolveSleepThresholds()` with derived deepAuthority (×1.5) and cooldownOverride (×2) off the OVERRIDDEN base; one ladder for hooks, CLI, `/api/sleep` and the dashboard (`sleepLevels.ts` replaced the hand-mirrored copy); `sleep config` CLI + `PATCH /api/config` + Settings › Sleep UI; model/effort injected at install via `installAgentForPlatform` with `baselineSha` customization detection; unknown models refused; `doctor` warns on a bad ladder or unknown model. Zero-config parity preserved; scoring untouched.
- **B — Filing bar + tombstones**: `assertTaskFilingBar()` as ONE choke point for `tasks create` and `POST /api/tasks` (live-lock or `DREAMCONTEXT_AUTO_SLEEP` engages it, `--by human` exempt, ≥40-char justification, per-cycle cap tracked in `cycle_tasks_filed`); `state/.task-tombstones.json` with transitive `absorbedBy` resolution so a merged-away chore is never re-filed; the curator chore is born with its Why. Diagnosis (n=116) drove the wording: the bar is a floor against the template, not a quality judgment, and it cannot require a `## Why` heading.
- **C — Background auto sleep**: default OFF, machine-local (`.brain-local.json`), Stop-hook-only; `shouldStartAutoSleep()` with seven named refusals; the runner reuses `executeClaudeDetached` / `sanitizeAutomationPrompt` / `killRunGroup` (40-min timeout, `--disallowedTools WebFetch,WebSearch,mcp__*` with Agent ON); consent = fingerprint over settings + per-agent customization digests, excluding shipped version; nag silence with `consent-stale` as the single exception; `sleep auto on|off|status|cancel` + `/api/sleep/auto` routes + dashboard job banner; idempotent per-epoch changelog entry and a notification carrying the summary.
- **D — Two writers**: `withTaskFileLock()` (loud) and `withSleepStateLock()` (fails open for hooks, with a visible notice) around every task-file and `.sleep.json` read-modify-write; `activeTaskSet()` hands-off list injected into the background prompt and honoured by `sleep-tasks` as "Deferred (hands-off)"; lock/sidecar paths added to both gitignore builders, tombstones deliberately synced.
- **C0 spike (evidence, not assumption)**: a headless `claude -p --permission-mode bypassPermissions` run in a scratch vault really did fan out through the Agent tool — proven from the transcript's `subagents/` folder, and the per-specialist model override survived a real `install-skill` there.
- **Real-cycle verification on this brain (D7)**: a Stop hook actually spawned a detached ~13-minute cycle (debt 61 → 14) whose only nag output was the one-line "Auto sleep is ON"; models read from the subagent transcripts; a foreground changelog write survived the cycle; the run found the changelog-epoch bug the 283 new tests could not. Two lost-write races were found by a clean reviewer while the whole suite was green — a green suite does not substitute for a reviewer gate or a real run. Final: 485 files / 8886 tests green.
- Known verification gap carried: the "Candidates NOT filed (cap)" report line is prompt-driven and only hand-checked. Recorded risk carried: on a shared brain, a synced `mustSleep` drop can let several auto-sleep machines start a cycle at once — the fingerprint does not cover thresholds; a cross-machine lock is v2.

### 2026-07-18 - v0.19.0 quality improvements (AC1–AC9)
- **AC1 — Pending-session awareness**: effective debt = persisted + min(12, 2 × pending count); directives/reminders threshold on effective; snapshot shows pending count; rhythm includes pending. Provisional NEVER persisted to `state.debt`. New: `PENDING_SESSION_PROVISIONAL=2`, `PENDING_PROVISIONAL_CAP=12`, `effectiveDebt()`, `effectiveRhythm()`, `countPendingSessions()` in `sleep-consolidation.ts`; hook.ts + snapshot.ts read effective debt.
- **AC2 — Transcript-less salience**: Stop hook runs `detectSalienceFromMessage()` over `last_assistant_message` when transcript missing; 7-day catch-up finalization assigns floor score 1 (not 0) for non-empty message. New: `NEVER_FLUSHED_FINALIZE_MS`, `NEVER_FLUSHED_FLOOR_SCORE=1`, `floorScoreForNeverFlushed()` in `sleep-consolidation.ts`; `detectSalienceFromMessage()` + `MESSAGE_ONLY_MOMENT_CAP=2` in `salience.ts`.
- **AC3 — Transcript layout fallback**: `transcript-locate.ts` resolver probes flat first, then dir layout (`<sid>/subagents/`, `<sid>/tool-results/`). Shared by catch-up, `transcript distill`, session-digest. New: `resolveTranscript()`, `listSubagentTranscripts()`, `subagentIdFromPath()`.
- **AC4 — Depth decoupling**: catch-up finalization stamps `catchup_finalized: true` on session records; `sleep start` caps auto-deep to standard when ≥50% of debt arrived via catch-up (one-way: never lowers below organic-debt floor, `--deep` wins). New: `CATCHUP_DEEP_CAP_RATIO=0.5`, `catchupDebtSplit()`, `consolidationDepth({catchup?})`, `DepthDecision.cappedByCatchup`, `SessionRecord.catchup_finalized` in `sleep-consolidation.ts`.
- **AC5 — Post-sleep durability**: `sleep done` prints loud warning listing uncommitted `_dream_context/**` with ready command when brain sync off (no auto-commit). New: `brain-dirty.ts` (`collectBrainDirty()`, `renderBrainDirtyWarning()`).
- **AC6 — Recidivism escalation**: flags in `state/.sleep-flags.json`; ≥3 consecutive cycles → decision ask + priority bump; sleep-state authority to archive ceiling-blocked Decisions to `knowledge/archive/`; ≥150 orphan tags auto-creates curator task. New: `sleep-flags.ts` (`reconcileFlags()`, `RECIDIVISM_ESCALATION_CYCLES=3`, `bumpPriority()`, `parseFlagOption()`, `ORPHAN_TAG_CURATOR_THRESHOLD=150`, `planCuratorTask()`); `sleep done --flag` repeatable option.
- **AC7 — Measurement**: Layer-2 live-LLM eval run executed, `eval/sleep-quality/RESULTS.md` dedup(4) + capture-promote(6) rows filled; sleep orchestration includes dedup-log digest ("X merge / Y review / Z create since epoch"). New: `dedup-log.ts` (`summarizeDedupLog()`, `readDedupDigest()`, `renderDedupDigest()`).
- **AC8 — Sub-agent harvest + session→task links**: `transcript distill --subagents` merges `<session>/subagents/agent-*.jsonl` findings; session `task_slugs` populated from bookmarks + `state/*.md` edit detection. New: `mergeDistilled()`, `distillSubagents()` in `transcript.ts`; catch-up merges task_slugs (never replaces).
- **AC9 — Operational hygiene**: (a) digest GC at `sleep done` — keep newest K=50 + pending-session digests; (b) GitHub write-spacing (`GITHUB_MIN_WRITE_INTERVAL_MS=1000`) on POST/PATCH/PUT/DELETE to avoid secondary rate limits. New: `planDigestGc()`, `scanDigests()`, `runDigestGc()` in `session-digest.ts`; `ApiAdapterOptions.minWriteIntervalMs` in `api-adapter.ts`/`github.ts`.
- Evidence: monthly auto-salience yield Feb–May 0.00–0.14 → Jun 1.85 → Jul 0.44 bm/session; 16/89 cycles started Must-Sleep (auto-deep from catch-up); 208 orphan tags carried for months; uncommitted brain output routine. Goal-skill v2 validated plan, 10-task dependency map, wave-parallel implementation (T1–T9), plan-review 2 lenses both SOLID round 1. Full test suite green.

### 2026-06-29 - Atomic mutual-exclusion lock for `sleep start`
- `src/lib/file-lock.ts`: O_EXCL atomic stamp lock (`acquireFileLock`); stale-TTL break + re-race (30-min TTL). Shared primitive reused by SyncLedger.
- `sleep start` acquires the lock before pinning the epoch; concurrent caller receives `SleepLockStatus.HELD`.
- `inspectSleepLock(state, nowMs)` in `sleep-consolidation.ts`: exposes lock status with stale-TTL check; `clearSleepLock()` releases on `sleep done`.
- Launcher route: HTTP 409 "Sleep already running" when a live lock is detected — explicit signal instead of silent corruption.
- `sleep_started_at` in `SleepState` serves as both the epoch stamp and the lock's on-state indicator.

### 2026-06-29 - Debt scale rescaled ×2 (Must Sleep = 20) + centralized into constants
- Levels: Alert 0–7 · Drowsy 8–13 · Sleepy 14–19 · Must Sleep 20+ (was 0-3/4-6/7-9/10+). Directives at ≥8/≥14/≥20; rhythm reminder at 5 sessions (was 3). Per-session scoring unchanged (max +3).
- New named constants `DEBT_DROWSY`/`DEBT_SLEEPY`/`DEBT_MUST_SLEEP`/`RHYTHM_SESSIONS` in `sleep-consolidation.ts`; `sleepinessLevel`/`sleepinessRange`/`depthFromDebt` + hook directives/reminders + `sleep status` all derive from them (single source of truth). `sleepinessRange` now returns a computed `string`.
- Tests updated to the new boundaries (sleep-consolidation, sleep-system-360, hook + sleep integration) and the eval scorer's depth fixtures. Verified end-to-end via the CLI: debt 19 → Sleepy, debt 20 → Must Sleep/REQUIRED.

### 2026-06-15 - Task-status lifecycle updated; sleep-tasks backlog grooming formalized
- sleep-tasks "max `in_review`" rule replaced with judgement-based lifecycle: `completed` for done+low-risk+validated; `in_review` for genuine user verification or close decisions on superseded/obsoleted work.
- Backlog grooming documented as mandatory per-cycle step: pivot-relevance, version re-attachment, tag normalization.
- Technical Details updated: sleep-tasks description now reflects current behaviour.

### 2026-06-04 - Dedup hardening: specialist prompts updated with recall-before-create + consolidation rubric
- Root cause: create-paths in both sleep-tasks and sleep-product lacked strong dedup gates.
- sleep-tasks Step 2: mandatory recall+scan before create; decision table for fold-in vs new task.
- sleep-product B2: "Create vs. extend — the consolidation rubric" replaces one-line dedup note.
- SKILL.md orchestrator brief: "Consolidation discipline" note added to parallel dispatch step.

### 2026-06-02 - Continuous capture: auto-digest + auto-salience shipped
- `detectSalience()` (salience.ts): structural pattern detectors (user-correction, error→fix, decision-keyword; EN+TR) run on undigested sessions in the SessionStart catch-up path; auto-bookmarks written to `.sleep.json`.
- `session-digest.ts`: bounded (≤8KB) transcript digests indexed into recall corpus; 30/32 consolidations previously had zero bookmarks — awake-ripple tagging now fires automatically.
- Capture guard: `CAPTURE_RANK_PENALTY = 0.5` on `rankScore` only + K=50 digest cap; guard proof (`recall-capture-stress.test.ts`) verifies zero gold-target displacement under worst-case flood.
- Acceptance criteria + user stories updated.

### 2026-05-23 - Anti-bloat tightened + memory.md LIFO removed
- Core-file anti-bloat cap lowered from 300 → 150 lines. Specialists enforce during consolidation (promote / archive / condense rather than append).
- `2.memory.md` LIFO section removed. File now holds Decisions + Known Issues only.
- Quick captures route through `dreamcontext memory remember`, which writes a CHANGELOG entry (`type=note`, `scope=quick`). CHANGELOG indexed in the recall corpus, so quick captures are searchable via `memory recall --types changelog`.

### 2026-05-10 - PRD reconciled to 3-specialist design
- Updated User Stories, Constraints, Technical Details to reflect 5→3 collapse.
- sleep-state = merged sleep-core + sleep-changelog. sleep-product = merged sleep-knowledge + sleep-features.
- Fixed stale Note: main agent (not a sub-agent) calls sleep done.

### 2026-03-02 - PostToolUse hook, PreCompact hook, pattern extraction
- PostToolUse hook: auto-format (Biome/Prettier walk-up) + tsc --noEmit --incremental on JS/TS edits. execFileSync (no shell injection). resolveLocalBin() (npx fallback). findProjectConfig() merges walk-up. 30s timeout. 7th hook registered.
- PreCompact hook: saves CompactionRecord to compaction_log[] (LIFO, cap 20). CompactionRecord interface + compaction_log field added to SleepState. 5s timeout.
- rem-sleep Step 1c: pattern extraction from distilled transcripts (preferences 2+, workflows 3+, errors 2+, bookmark themes 3+)
- ensureHooks() refactored: 160-line boilerplate -> data-driven HOOK_SPECS table
- 451 tests (450 passing, 1 pre-existing flaky nanoid)

### 2026-03-01 - UserPromptSubmit hook + tightened thresholds
- hook user-prompt-submit added: fires on every user message, one-line debt reminder when debt >= 4. Critical bookmarks override. Read-only. 6 new tests.
- Thresholds tightened: debt >= 4 triggers directives (was >= 7), rhythm check 3+ sessions (was 5+)
- SKILL.md: Drowsy (4-6) mandatory consolidation offer language added
- PostToolUse considered and rejected (fires mid-work)
- 415 tests total, all passing

### 2026-02-28 - transcript distill: timestamp filter + SleepHistoryEntry fields + output quality
- SleepHistoryEntry: added consolidated_at (ISO timestamp) and session_ids (string[]) fields
- transcript distill auto-filters by consolidated_at: only shows content after last consolidation for previously-processed sessions
- transcript distill output: full content, thinking blocks, subagent I/O, byte deltas on edits, trivial response filter removed
- 7 new tests, 394 total (all passing)

### 2026-02-27 - Neuroscience-Inspired Memory System (8 phases)
- Phase 1: Bookmarks (awake ripples) -- salience-scored tagging during active work, critical bookmarks trigger consolidation advisory
- Phase 2: Knowledge decay tracking -- knowledge_access map in SleepState, staleness indicators at 30+ days
- Phase 3: Consolidation rhythm -- sessions_since_last_sleep counter, rhythm advisory at 5+ sessions
- Phase 4: Warm knowledge tier -- extractFirstParagraph() helper, warm knowledge section in snapshot (7-day recency + tag overlap)
- Phase 5: Contextual triggers -- pattern-matched reminders surfaced in snapshot, auto-expire after max_fires
- Phase 6: Transcript distillation -- pure Node.js structural JSONL filter, no AI required
- Phase 7: Sleep history -- SleepHistoryEntry, sleep_history[] LIFO, sleep history subcommand, snapshot shows last 3
- Phase 8: System flow documentation -- core/6.system_flow.md with lifecycle, schema, neuroscience mapping
- Fixed freshDefaults() shared-reference mutation bug in readSleepState
- 48 new tests (384 total, 383 passing)

### 2026-02-27 - Tool Count Scoring
- Added `tool_count` to `SessionRecord` schema (counts all tool calls, not just Write/Edit)
- Session score now `Math.max(scoreFromChangeCount, scoreFromToolCount)` to avoid under-scoring Bash-heavy sessions
- Snapshot display updated: `(+2) 0 changes, 35 tools`
- 336 tests passing

### 2026-02-25 - Created
- Feature PRD created.
