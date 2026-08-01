# Sleep / Consolidation — full flow

Sleep (RemSleep) is how working-session changes get folded back into the durable brain. It mirrors how the brain consolidates memory during sleep. **The main agent runs the orchestration directly** — sub-agents cannot reliably fan out to other sub-agents, so the dispatch has to come from the top-level session. The specialist passes themselves are **always** sub-agents: a sleep request is itself the user requesting them, which satisfies any standing "don't call the Agent tool unless asked" instruction (Claude Code appends one to every Opus 5 system prompt). Never fold a specialist's work into the orchestrator's context because the cycle looks small — the disjoint file domains are what make the no-stomp guarantee hold, and they only hold across separate agents.

## When to sleep

Sleep debt accumulates automatically via hooks. Each finished session is scored **0–10** by a weighted sum over four axes — novel tokens consumed, file changes, tool calls, and substance (decisions, task breadth, exchange length) — so a heavy session costs several times a light one. A typical session scores ~5. Hooks inject directives — honor them.

Thresholds are calibrated against measured DAILY work volume (30 real days: median 42 debt/day, busiest 185), targeting **at most ~3 consolidations on the heaviest day and none required on a typical one**.

| Debt | Level | Required behavior |
|------|-------|-------------------|
| 0–23 | Alert | No action |
| 24–39 | Drowsy | After completing a task: **inform user + offer** consolidation |
| 40–59 | Sleepy | At session start: **inform user + recommend** consolidation before new work |
| 60+ | Must sleep | **Consolidate**, before or right after the current task |

Also triggers an advisory: a **★★★ bookmark** exists (regardless of debt), or **12+ sessions** since last sleep.

Injected directives (SessionStart + every user message via UserPromptSubmit when debt ≥24):
- Debt ≥60 → "CONSOLIDATION REQUIRED"
- Debt ≥40 → "CONSOLIDATION RECOMMENDED"
- Debt ≥24 → offer after the current task

**Cooldown — sleep is not supposed to be constant.** For **3 hours** after a completed consolidation the hooks stop asking, even as debt climbs; directives print a "Cooling down" line instead. Thresholds bound how much work one sleep is worth but not how close two land, so this is the time floor that stops "consolidate now" from returning half an hour later. Two things still pass through: a hand-tagged **★★★ bookmark**, and debt reaching **120** (2× Must Sleep — an escape hatch for a genuinely enormous burst, not a normal path). **If the user asks for a sleep, run it** — the cooldown governs what the AGENT proposes, never what the user requests.

**MANDATORY post-task check:** after any task/major implementation, if debt ≥24 **and no cooldown is active**, tell the user: *"Sleep debt is [N]. I can consolidate now to preserve this work. Want me to run it?"* Never silently finish.
**Auto-sleep (act without asking):** task completed with debt ≥60. Otherwise ask.
**Ask first:** debt 24–59 after a task; accumulated small changes; user wrapping up.

**Depth is NOT the same as level.** Destructive knowledge ops (merge-with-delete, summarize-and-replace, archive/delete) are authorized only at `deep`, which starts at debt **45** — not at Must Sleep. Being overdue to consolidate does not by itself license deleting things; `--deep` remains the explicit override.

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
6. **`dreamcontext reflect`** — each candidate is a term seen across multiple sessions not yet in the soul, any `people/*.md` constitution, memory, or knowledge. Promote into `2.memory.md` or a knowledge file ONLY if genuinely load-bearing; most are noise — discard. Never auto-promote.
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
| `sleep-state` | Core identity (soul, memory, core 3–6), **`people/people.json` + `people/*.md`**, CHANGELOG, RELEASES | Records patterns/decisions/preferences, writes a changelog entry per meaningful change since the epoch, surfaces release readiness, enforces anti-bloat ceilings (**~4,000 chars AND ~150 lines per core file *and* per person constitution — chars are what bind the SessionStart snapshot, and `dreamcontext doctor` reports both**), flags stale knowledge for `sleep-product`. **Owns the people layer**: a person's preferences go in `people/<slug>.md` (never a core file), and it reconciles `people.json` ↔ `people/*.md` — every roster slug has a file, every file has a roster entry, orphans reported, **a person file is never deleted**. Rare standing exception: when a ceiling and a genuinely-warranted promotion collide, may archive the oldest blocked Decision to `knowledge/archive/<core>-<period>.md` (archive-before-delete: write, verify, then replace). Reports recurring problems as recidivism flags (see step 10). |
| `sleep-product` | Knowledge files + feature PRDs + patterns | Creates/reconciles `knowledge/*.md` and `knowledge/features/*.md` (typed knowledge, `type: feature`), processes staleness flags, maintains the knowledge index + taxonomy. **Owns the pattern lifecycle** (`knowledge/patterns/*.md`): creates a pattern when `sleep-state`'s recurring-practice signals warrant one (two occurrences = a pattern), updates/condenses existing patterns, retires stale ones (archive-before-delete). Patterns are also written AWAKE by the main agent — sleep consolidates, it is not the gatekeeper. Never touches `knowledge/archive/` — that's `sleep-state`'s escalation output. **Also reads new automation output** (never edits or owns it) and folds anything genuinely new into the right knowledge file — see "Automations" below. |
| `sleep-migration` | Structure only | Moves/renames folders, normalizes frontmatter, wraps fences. Never alters body prose. |
| `sleep-learn` | Theses (`theses/*.md`) | Re-tests open theses against fresh evidence, derives confidence, flips validated/invalidated with a prediction check (≥3 evidence events required), appends the per-cycle understanding changelog. Never creates insights; instrumentation gaps and knowledge/workflow-rule promotions are reported as decision asks, never written directly. Conditional — see dispatch rule above. |

**Consolidation discipline (remind specialists in the brief):** prefer *updating/extending* an existing entity over creating a new one. `sleep-tasks` folds a smaller slice into the task that already covers it (broaden its title + insert sub-items) rather than forking a duplicate. `sleep-product` keeps similar verticals/topics in the fewest knowledge files, splitting only on a sharp topical boundary. Duplicate tasks and fragmented near-duplicate knowledge are the top failure modes — but genuinely separate concerns still get their own task/file.

---

## Automations: sleep reads their output, but never runs or owns them

Three things are true at once here, and none of them contradicts the others:

1. **Sleep never EXECUTES an automation.** No specialist spawns a run or ticks the dispatcher, for the same reasons sleep never runs `lab sync`: credentials, latency, and non-determinism have no place in an unattended consolidation pass.
2. **Sleep never OWNS an automation's files.** No specialist creates, edits, or retires `_dream_context/automations/*.md`, its cache, the machine-local registry, or the dispatcher plist. An automation manifest is authored directly by a user or an agent in-session (`automations create`, then a live-tested `run --force`), and its cache and output files are written deterministically by the runner and the dispatcher tick, never by an LLM reconciling "current truth" the way `sleep-tasks` reconciles a task body. This mirrors Lab insights, which are likewise not owned by any sleep specialist.
3. **Sleep DOES read an automation's output and distil it.** This is new, and it is reading, not owning: output is *material* to `sleep-product`, the same way a git diff or a session transcript is material. An automation that produces a daily digest is generating real content; if nothing ever reads it, it just sits on disk. `sleep-product` picks up output files written since the consolidation boundary (below), bounded and skip-by-default, and folds anything genuinely new into the right knowledge file rather than the automation's own artifacts. Full contract → `agents/sleep-product.md`.

**The consumption boundary.** `sleep-product` only looks at output written since `last_consolidated_at`, a timestamp `sleep done` stamps on every successful cycle. A brain that has never completed a cycle has this as `null`, which means **consume nothing** — that first cycle is a deliberate no-op bootstrap, not a bug. Nothing is lost: the very next `sleep done` stamps the boundary, and every output written after that is picked up normally on the following cycle.

**Private automations still feed the local brain, and that has a consequence worth knowing.** An automation's `shared` flag (see [automations.md](automations.md)) controls what leaves this machine over git; it says nothing about what this machine's own sleep agent can read. So a private automation's output is fully available to `sleep-product` — but knowledge files ARE synced regardless of any automation's sharing flag, so folding private output into a knowledge file republishes that content through a different door. `sleep-product` records that provenance whenever it happens, and `sleep done` **refuses to finish** while any such derivation is pending, listing every knowledge file and its private source, until you pass `--ack-private-derivation`. There is deliberately no shorter alias for that flag and no way to discard the disclosure without acknowledging it — see `agents/sleep-product.md` and [automations.md](automations.md) for the full mechanism.

The other place sleep and automations touch is deference, not ownership: a due automation checks the sleep lock (`inspectSleepLock`) before it spawns, and defers to the next tick rather than racing a consolidation in progress, exactly as a fresh sleep lock holds off other file-touching work. If `sleep-state`'s changelog pass notices an automation shipped or changed during the epoch, record it there like any other meaningful change. A blocked, failed, or orphaned automation is a signal for the user to act on directly (`automations show`, `automations approve`, `automations kill`), surfaced in the session snapshot, not something a sleep specialist fixes. Full protocol → [automations.md](automations.md).

---

## Epoch safety

`sleep start` pins a timestamp epoch. `sleep done` only clears sessions/changes/bookmarks from *before* the epoch — parallel sessions that finish during consolidation are preserved for the next cycle. This is why you always `sleep start` before dispatching and `sleep done` after, never in the reverse order.

## Commands
```bash
dreamcontext sleep status              # debt level + history
dreamcontext sleep start [--deep]      # begin epoch
dreamcontext sleep done "<summary>"    # finish, reset debt
dreamcontext sleep add <score> "<why>" # manual debt for non-file work (score 1-10)
dreamcontext sleep debt                # debt number (programmatic)
dreamcontext sleep history [-n N]      # consolidation history
dreamcontext reflect [--write]         # cross-session term candidates
```
