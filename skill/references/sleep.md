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
   - Pass each specialist a small text brief: epoch, session IDs, active task slugs, planning version, the signals relevant to it, optional user hint. Do **not** paste transcript content — specialists call `dreamcontext transcript distill <id>` themselves.
5. **Wait for all reports** (each returns a short structured report).
6. **`dreamcontext reflect`** — each candidate is a term seen across multiple sessions not yet in soul/user/memory/knowledge. Promote into `2.memory.md` or a knowledge file ONLY if genuinely load-bearing; most are noise — discard. Never auto-promote.
7. **Roadmap refresh** if `_dream_context/core/objectives/` is non-empty: run `dreamcontext roadmap` — a cheap deterministic call that recomputes rollups/forecasts from the reconciled tasks and rewrites the auto-generated `knowledge/roadmap/board.md`. Surface any 🔴 SLIPPING objectives (and objectives whose member tasks are now all complete — suggest the PO confirm them done) in your summary. Sleep never edits objective files themselves — they are PO-authored.
8. **Marketing pass** if `_dream_context/marketing/` exists: `dreamcontext mk rem-sleep`.
9. **Council promote check:** `dreamcontext council list --unpromoted` — promote if the user engaged positively.
10. **`dreamcontext sleep done "<one-paragraph summary stitched from specialist reports>"`** — clears pre-epoch state, resets debt, writes a history entry. (If a remote backend — ClickUp or GitHub — is active and any task pushes failed, this auto-retries once, then errors loudly with the failed slugs.)
11. **Report** the consolidated summary to the user.

---

## Specialist ownership (non-overlapping domains)

| Specialist | Owns | Notes |
|---|---|---|
| `sleep-tasks` | Task files (`state/*.md`) | Reconciles task bodies to truth, bumps statuses, creates tasks for untracked work, attaches to the planning version, sets the start/due range, and keeps declared custom fields current (never fabricating `ask` fields in the no-user sleep context). When objectives exist, proposes `objectives:` links for tasks with an EMPTY/absent list (multiple slugs when a task serves several outcomes) — **never overwrites a non-empty list** (that's a PO decision). |
| `sleep-state` | Core identity (soul, user, memory, core 3–6), CHANGELOG, RELEASES | Records patterns/decisions/preferences, writes a changelog entry per meaningful change since the epoch, surfaces release readiness, enforces anti-bloat ceilings, flags stale knowledge for `sleep-product`. |
| `sleep-product` | Knowledge files + feature PRDs | Creates/reconciles `knowledge/*.md` and `knowledge/features/*.md` (typed knowledge, `type: feature`), processes staleness flags, maintains the knowledge index + taxonomy. |
| `sleep-migration` | Structure only | Moves/renames folders, normalizes frontmatter, wraps fences. Never alters body prose. |

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
