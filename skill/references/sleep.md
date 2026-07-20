# Sleep / Consolidation — full flow

Sleep (RemSleep) is how working-session changes get folded back into the durable brain. It mirrors how the brain consolidates memory during sleep. **The main agent runs the orchestration directly** — sub-agents cannot reliably fan out to other sub-agents.

## When to sleep

Sleep debt accumulates automatically via hooks (per Write/Edit tool use). Hooks inject directives — honor them.

| Debt | Level | Per-change score | Required behavior |
|------|-------|------------------|-------------------|
| 0–7 | Alert | 1–3 changes → +1 | No action |
| 8–13 | Drowsy | 4–8 changes → +2 | After completing a task: **inform user + offer** consolidation |
| 14–19 | Sleepy | 9+ changes → +3 | At session start: **inform user + recommend** consolidation before new work |
| 20+ | Must sleep | — | **Consolidate immediately**, before or right after the current task |

Also triggers an advisory: a **★★★ bookmark** exists (regardless of debt), or **5+ sessions** since last sleep.

Injected directives (SessionStart + every user message via UserPromptSubmit when debt ≥8):
- Debt ≥20 → "CONSOLIDATION REQUIRED"
- Debt ≥14 → "CONSOLIDATION RECOMMENDED"
- Debt ≥8 → offer after the current task

**MANDATORY post-task check:** after any task/major implementation, if debt ≥8 tell the user: *"Sleep debt is [N]. I can consolidate now to preserve this work. Want me to run it?"* Never silently finish.
**Auto-sleep (act without asking):** task completed with debt ≥14; major implementation finished with debt ≥8.
**Ask first:** debt 8–13 after a task; accumulated small changes; user wrapping up.

For non-file-change work (architecture discussion, a decision with no edits): `dreamcontext sleep add <score> "<reason>"`.

---

## The flow (run from the main agent context)

1. **Tell the user** you're consolidating.
2. **`dreamcontext sleep start`** — pins the epoch timestamp (safe clearing). Add `--deep` only when you intend to authorize destructive knowledge ops (merges/deletes); a normal sleep is non-destructive.
3. **Build the brief inline** (cheap CLI, no transcript content):
   - `cat _dream_context/state/.sleep.json` — session IDs, task slugs, `last_assistant_message`, `knowledge_access`
   - `git status --short` and `git log --oneline --since=$(jq -r '.sleep_started_at // .last_sleep' _dream_context/state/.sleep.json)`
   - `dreamcontext core releases active` — the planning version (create one with `dreamcontext core releases add --ver vX.Y.Z --status planning --summary "<theme>" --yes` if missing)
4. **Dispatch specialists in parallel** — one message, multiple Agent tool calls. Each owns a non-overlapping file domain (no stomping):
   - **Always fire:** `sleep-tasks`, `sleep-state`.
   - **Conditionally fire `sleep-product`** if ANY of:
     - `last_assistant_message` mentions research/analysis/decision
     - a `knowledge_access` entry is 30+ days untouched
     - a research bookmark exists
     - a task slug matches an existing feature PRD filename
     - `git status` shows changes under `_dream_context/knowledge/features/`
     - a session advanced ≥1 acceptance criterion, OR introduced a feature concept with ≥2 criteria, OR the user named something "a feature" / "we should add X", OR a task has `feature:` frontmatter pointing to a non-existent PRD
     - the user hint mentions knowledge or a feature
     - When unsure, **over-fire** `sleep-product` — it no-ops cheaply.
   - **Conditionally fire `sleep-migration`** only when `dreamcontext migrations pending` produces output. Contract: structure-only (paths/frontmatter/fences), no body prose changes; writes the ledger via `dreamcontext migrations record` on completion.
   - **Do NOT fire `sleep-federation`.** Copy-based federation is disabled; peers are read live at recall time, not synced at sleep. The specialist is retained but inert.
   - **Conditionally fire `sleep-learn`** only when `learning.enabled` is true (check `_dream_context/state/.config.json`) AND ANY of: an open/draft thesis exists with fresh evidence since the epoch (an insight synced, an objective moved, a linked task completed, a relevant changelog entry landed), OR ≥2 sleeps have passed since a thesis was last checked (minimum wake cadence — open theses must not rot). Contract: owns `_dream_context/theses/*.md` only via the `theses` CLI; never creates insights or edits knowledge/tasks/objectives directly; status flips require ≥3 evidence events AND a prediction check; instrumentation gaps and knowledge/workflow-rule promotions are decision asks, never direct writes. When `learning.enabled` is off, skip entirely — do not dispatch. When unsure whether it's due, **over-fire** — it no-ops cheaply (checks `theses list`, finds nothing due, reports and stops).
   - Pass each specialist a small text brief: epoch, session IDs, active task slugs, planning version, the signals relevant to it, optional user hint. Do **not** paste transcript content — specialists call `dreamcontext transcript distill <id>` themselves.
5. **Wait for all reports** (each returns a short structured report).
6. **`dreamcontext reflect`** — each candidate is a term seen across multiple sessions not yet in soul/user/memory/knowledge. Promote into `2.memory.md` or a knowledge file ONLY if genuinely load-bearing; most are noise — discard. Never auto-promote.
7. **Roadmap refresh** if `_dream_context/core/objectives/` is non-empty: run `dreamcontext roadmap` — a cheap deterministic call that recomputes rollups/forecasts from the reconciled tasks and rewrites the auto-generated `knowledge/roadmap/board.md`. Surface any 🔴 SLIPPING objectives (and objectives whose member tasks are now all complete — suggest the PO confirm them done) in your summary. Sleep never edits objective files themselves — they are PO-authored.
   **Insight-fed objectives:** if `_dream_context/lab/insights/` is non-empty, also run `dreamcontext lab list` — an objective fed by a bound insight (`binding.objective` in the manifest) has a *measured* KR `current` owned by `lab sync`; no specialist hand-writes it. Surface any bound insight whose cache is stale or errored ("KR for `<objective>` is fed by insight `<slug>`, last synced `<date>` — suggest `dreamcontext lab sync <slug>`"). **Sleep NEVER runs `lab sync`** — credentials, latency, non-determinism; refreshing is always an explicit user/agent action outside sleep.
8. **Marketing pass** if `_dream_context/marketing/` exists: `dreamcontext mk rem-sleep`.
9. **Council promote check:** `dreamcontext council list --unpromoted` — promote if the user engaged positively.
10. **`dreamcontext sleep done "<summary>" [--flag <key>::<label>[::<task-slug>]]...`** — clears pre-epoch state, resets debt, writes a history entry. Before running it, collect every recidivism flag the specialists reported (sleep-state's Recidivism flags block, sleep-tasks' grooming (e)) and pass each as its own `--flag` — repeatable, ONE `--flag` per flag, never comma-separated (e.g. `--flag recurring-task:fix-x::"fix-x recurred"::fix-x --flag ceiling-blocked:2.memory.md::"blocked again"`). At 3 consecutive cycles on the same `key`, `sleep done` itself surfaces an escalation ask and bumps the linked task's priority — you relay what specialists reported, you don't compute the streak. **Thesis promotion note:** when `sleep-learn` reports a thesis that flipped `validated`/`invalidated`, relay its promotion proposal to the user in your summary (it is a decision ask, not an action taken) — do not run `theses promote` yourself; that command only records a promotion that already happened in a later session. A chronic-open thesis (`sleep-learn`'s ≥3-cycle report) becomes its own `--flag chronic-open-thesis:<slug>::"<label>"::<slug>` alongside the other recidivism flags. (If a remote backend — ClickUp or GitHub — is active and any task pushes failed, this auto-retries once, then errors loudly with the failed slugs.) **Brain sync also fires here:** if a shared brain repo is active (`brainRepo.autoSync`), `sleep done` runs a foreground `brain sync` (fetch→merge→commit→push). Sync failure never fails sleep — but on a prose conflict it pauses with `awaiting-agent` and prints the `/dream-sync` prompt; run that skill, then `brain sync --continue`. Full model → [brain-sync.md](brain-sync.md).
11. **Report** the consolidated summary to the user — include the semantic dedup digest line `sleep done` printed (`Semantic dedup since epoch: X merge / Y review / Z create (N decisions).`, when non-zero) and any recidivism escalation asks or curator-task creation it surfaced.

---

## Specialist ownership (non-overlapping domains)

| Specialist | Owns | Notes |
|---|---|---|
| `sleep-tasks` | Task files (`state/*.md`) | Reconciles task bodies to truth, bumps statuses, creates tasks for untracked work, attaches to the planning version, sets the start/due range, and keeps declared custom fields current (never fabricating `ask` fields in the no-user sleep context). When objectives exist, proposes `objectives:` links for tasks with an EMPTY/absent list (multiple slugs when a task serves several outcomes) — **never overwrites a non-empty list** (that's a PO decision). May refresh a KR's observed `current` via `roadmap objective metric` — EXCEPT objectives fed by a bound Lab insight (measured by `lab sync`; hands-off, staleness surfaced instead). |
| `sleep-state` | Core identity (soul, user, memory, core 3–6), CHANGELOG, RELEASES | Records patterns/decisions/preferences, writes a changelog entry per meaningful change since the epoch, surfaces release readiness, enforces anti-bloat ceilings, flags stale knowledge for `sleep-product`. Rare standing exception: when a ceiling and a genuinely-warranted promotion collide, may archive the oldest blocked Decision to `knowledge/archive/<core>-<period>.md` (archive-before-delete: write, verify, then replace). Reports recurring problems as recidivism flags (see step 10). |
| `sleep-product` | Knowledge files + feature PRDs + patterns | Creates/reconciles `knowledge/*.md` and `knowledge/features/*.md` (typed knowledge, `type: feature`), processes staleness flags, maintains the knowledge index + taxonomy. **Owns the pattern lifecycle** (`knowledge/patterns/*.md`): creates a pattern when `sleep-state`'s recurring-practice signals warrant one (two occurrences = a pattern), updates/condenses existing patterns, retires stale ones (archive-before-delete). Patterns are also written AWAKE by the main agent — sleep consolidates, it is not the gatekeeper. Never touches `knowledge/archive/` — that's `sleep-state`'s escalation output. |
| `sleep-migration` | Structure only | Moves/renames folders, normalizes frontmatter, wraps fences. Never alters body prose. |
| `sleep-learn` | Theses (`theses/*.md`) | Re-tests open theses against fresh evidence, derives confidence, flips validated/invalidated with a prediction check (≥3 evidence events required), appends the per-cycle understanding changelog. Never creates insights; instrumentation gaps and knowledge/workflow-rule promotions are reported as decision asks, never written directly. Conditional — see dispatch rule above. |

**Consolidation discipline (remind specialists in the brief):** prefer *updating/extending* an existing entity over creating a new one. `sleep-tasks` folds a smaller slice into the task that already covers it (broaden its title + insert sub-items) rather than forking a duplicate. `sleep-product` keeps similar verticals/topics in the fewest knowledge files, splitting only on a sharp topical boundary. Duplicate tasks and fragmented near-duplicate knowledge are the top failure modes — but genuinely separate concerns still get their own task/file.

---

## Epoch safety

`sleep start` pins a timestamp epoch. `sleep done` only clears sessions/changes/bookmarks from *before* the epoch — parallel sessions that finish during consolidation are preserved for the next cycle. This is why you always `sleep start` before dispatching and `sleep done` after, never in the reverse order.

## Commands
```bash
dreamcontext sleep status              # debt level + history
dreamcontext sleep start [--deep]      # begin epoch
dreamcontext sleep done "<summary>"    # finish, reset debt
dreamcontext sleep add <score> "<why>" # manual debt for non-file work
dreamcontext sleep debt                # debt number (programmatic)
dreamcontext sleep history [-n N]      # consolidation history
dreamcontext reflect [--write]         # cross-session term candidates
```
