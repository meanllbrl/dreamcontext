---
id: "feat_WBfWsxgS"
status: "in_review"
created: "2026-07-02"
updated: "2026-07-02"
released_version: null
tags:
  - "topic:roadmap"
  - "topic:pm"
  - architecture
related_tasks:
  - feat-roadmap-live-po-authored-roadmap-items-dependencies-forecast-vs-target
---

## Why

Every review at the company now runs over a visible board — "ezbere iş yapmayı bırakalım" (stop working from memory), per Anıl Koman's 2026-06-25 directive (`knowledge/visual-first-board-ritual.md`). A prior task-derived, read-only roadmap plan was reviewer-vetted but then rejected by the product owner: a roadmap should show WHAT the PO is trying to achieve (outcomes), not WHEN tasks happen to land.

The roadmap is therefore a **PO-authored board of Objectives** (OKR-style outcomes — "increase retention by 20%", "ship v0.2.3", "launch mobile app"), not a derived shadow of the task list. Tasks link to objectives many-to-many because a single shipped task frequently serves multiple outcomes at once (e.g. one task lifts both revenue and retention) — modeling that link is where the product-management value lives and is invisible in a flat task list. Objectives can depend on each other, so a slip cascades along the dependency graph, and each objective carries a target date (PO commits) versus a computed forecast date, giving a live on-track/slipping signal before the deadline arrives. The PO owns the structure; the system keeps the math honest underneath.

## User Stories

- [x] As a product owner, I can create/edit/delete an Objective (title, optional target date, optional dependencies) that exists independently of any task, so the roadmap reflects outcomes I define, not tasks the system infers.
- [x] As a product owner, I can link a task to one or more objectives it serves, and see that reflected on both the task and the objective, so I can see which work contributes to which outcome.
- [x] As a product owner, I can declare that one objective depends on another and get a live forecast that cascades slips along the dependency chain, so I know before a deadline whether an upstream dependency is going to make me miss a downstream one.
- [x] As a product owner, I can see target date vs. computed forecast date per objective with a slip flag, so I can spot risk without manually recomputing dates.
- [x] As an agent, I propose which objective(s) an unlabeled task serves, but I never overwrite a PO's existing choice, so automation assists without silently overriding a human decision.
- [x] As any session agent, I see active (and recently finished) objectives in my session snapshot and sub-agent briefing, so I weigh my work against the outcomes the project is actually driving toward, not just the task queue.
- [x] As a developer or script, I can query the roadmap model as JSON (`roadmap --json`, `objective list/show --json`) for tooling or future dashboard rendering, without needing to scrape the text board.

## Acceptance Criteria

- [x] A PO can create/list/edit/delete an objective (slug + title + optional target + `depends_on`) via CLI; it persists in `core/objectives/<slug>.md` independent of any task.
- [x] A task can declare `objectives: [a, b]` and appears under both; an objective lists all its member tasks. Many-to-many verified both directions. The field is local-only — never pushed/pulled by the ClickUp or GitHub sync backends.
- [x] Progress % and rollup status of an objective are computed from member task status (real enum: `todo/in_progress/in_review/completed`); no hand-entered objective state required, though a PO `status` override is still possible.
- [x] `depends_on` drives a full transitive forecast cascade (topologically sorted DAG, not single-level): a slip in an upstream objective moves the forecast of all transitive dependents, including diamond-shaped dependency graphs. A circular dependency is rejected at write time (DFS check in `objective depend <A> <B>`) with a descriptive error — `buildRoadmapModel` therefore always receives an acyclic graph.
- [x] An objective with no dated member tasks forecasts as null / "unforecastable" and does not constrain its dependents (non-blocking, not treated as "now"); an objective with dated tasks shows target vs. forecast and flags slipping when `forecast > target`.
- [x] The agent proposes objective membership for tasks with an empty `objectives:` list; the PO can override, and the override sticks because agents only ever fill empty lists — a non-empty list is never overwritten.
- [x] `dreamcontext roadmap` renders the objective board to text and writes `knowledge/roadmap/board.md` (auto-generated, never hand-edited); `roadmap --json` emits the typed model verbatim; the model builder is pure with no render side effects; every bar carries version + start/due so a future calendar axis needs no model change.
- [x] Active + recently-finished (≤14 days) objectives render in the SessionStart snapshot with progress/target/forecast/slip, budget-aware (demotes full → active-only → count line as space tightens); active task lines carry their `objectives:` inline.
- [x] A lean objectives list (active first, capped at 10) is injected into every sub-agent's SubagentStart briefing.
- [x] `objective` is a first-class recall corpus type — included in `buildCorpus` defaults (so per-prompt recall surfaces objectives) and queryable via `memory recall --types objective`.
- [x] `sleep-tasks` proposes `objectives:` links only for tasks with an empty list (never overwrites a PO's choice); the sleep flow regenerates the board via a deterministic `dreamcontext roadmap` call; sleep never hand-edits `core/objectives/*.md` (PO-authored only).
- [x] `dreamcontext doctor` validates objective slugs, target dates, status overrides, dependency resolution/acyclicity, and task→objective reference integrity — silent when the feature is unused (no objectives defined).
- [x] 25 unit tests cover the store (CRUD, write-time cycle guard, delete self-healing) and the model builder (topo sort, full-DAG cascade including diamond shape, null-forecast rule, rollups, transitive dependents); full suite green (2512+ tests) and the CLI surface was exercised end-to-end in a sandbox (every verb, cascade, snapshot section, briefing, recall, doctor, delete-healing, status override).

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

- **2026-07-02 — Storage stays markdown; JSON is a query layer, not the store.** `core/objectives/<slug>.md` remains the canonical, PO-editable, recallable, wikilinkable store (mirrors features/tasks). `roadmap --json` / `objective list --json` / `objective show --json` emit the typed model on demand — a JSON store would have lost recall indexing, wikilinks, and sleep-editability, and broken consistency with how tasks and features are stored.
- **2026-07-02 — Relations are stored one-way; the reverse is always computed.** Tasks store `objectives: [slug…]`; objectives store `depends_on: [slug…]`. The reverse directions (which tasks serve an objective; which objectives depend on this one) are computed by `buildRoadmapModel`, never dual-written — this eliminates a whole class of drift bugs.
- **2026-07-02 — PO-override persistence rule.** Enforced as: agents only ever populate an EMPTY `objectives:` list on a task. A non-empty list is a PO decision and is never overwritten by an agent (including `sleep-tasks`).
- **2026-07-02 — Full-DAG transitive cascade, not single-level.** `buildRoadmapModel` topologically sorts objectives by `depends_on` and propagates forecast_start/forecast_end through the entire dependency chain, so a slip anywhere reaches every transitive dependent (verified against a diamond-shaped dependency case, A→B, A→C, B→D, C→D).
- **2026-07-02 — Null-forecast rule.** An objective with no dated member tasks forecasts as `null` ("unforecastable") and is treated as non-constraining by its dependents — never coerced to "now."
- **2026-07-02 — Circular dependencies rejected at write time.** `objective depend <A> <B>` runs a DFS from B before persisting; if B can already reach A, the write is rejected with an error, so the model builder is guaranteed an acyclic graph and never needs runtime cycle detection.
- **2026-07-02 — `objectives` field is local-only for MVP.** Not read or written by the ClickUp or GitHub sync backends — declared out of scope to avoid a `string[]` field being mangled into a single remote label/field.
- **2026-07-02 — Objectives are orthogonal to the time-box.** The sprint/cycle concept (displayed as "cycle", stored as `version`) is a separate, existing field on tasks. The roadmap does not consume or replace `version`; "ship v0.2.3" is simply an objective that happens to represent a release.
- **2026-07-02 — Scope promotion (owner decision).** Four items originally slated for v2 were pulled into MVP because agents needed to *know* the objectives, not just compute them: the snapshot section, the sub-agent briefing injection, the `objective` recall corpus type, and the sleep-cycle integration (propose-into-empty + deterministic `roadmap` regen).
- **2026-06-29 — Pivot from task-derived to PO-authored.** An earlier, fully reviewer-vetted "derived read-only roadmap" plan (locked 2026-06-29) was rejected by the owner same-day in favor of this PO-authored OKR model. A subsequent 3-parallel-mandate adversarial review (critic FAIL / pragmatist TRIM / data-integrity NEEDS HARDENING) was run against the new plan; the owner kept full MVP scope and all blocking findings (cascade definition, null-forecast fallback, objective store, sync scoping, write-time cycle guard) were folded before implementation began.

## Technical Details

- **Store:** `src/lib/objectives-store.ts` — CRUD over `core/objectives/<slug>.md`, write-time DFS cycle guard on `depends_on`, delete self-healing (removes the deleted slug from any task's `objectives:` list and any other objective's `depends_on:`).
- **Model builder:** `src/lib/roadmap-model.ts` — `buildRoadmapModel(contextRoot) → RoadmapModel`. Pure and render-agnostic: reads `core/objectives/*.md` + every task's `objectives:`, joins them, topologically sorts by `depends_on`, computes rollup progress/status, runs the full-DAG forecast cascade (including `transitiveDependents`), and applies the null-forecast rule. Renderers (currently text/markdown; excalidraw or dashboard later) consume this model without touching the build logic.
- **CLI surface:** `src/cli/commands/roadmap.ts` — `dreamcontext roadmap` (renders text board + writes `knowledge/roadmap/board.md`, both auto-generated), `roadmap --json`, `roadmap objective create|list|edit|delete <slug>`, `roadmap objective depend <A> <B>` (write-time cycle check before persisting).
- **`objectives` task field wired across 6 surfaces:** `TaskFrontmatter` and `TaskData` (`src/lib/task-backend/types.ts`), `CreateTaskInput` (same file), `TaskRecord` and `toTaskRecord()`/`readTaskFile` (`src/lib/task-query.ts`), and the PATCH `allowedFields` list (`src/server/routes/tasks.ts`). CLI: `tasks create --objectives`, `tasks objectives <task> <a,b>`, `tasks list --objective <slug>`. None of the ClickUp/GitHub sync backend code paths touch this field (local-only, per Constraints).
- **Recall:** `objective` added to `CorpusType` (`src/lib/recall.ts`) and to the default type set built by `buildCorpus`, loading `core/objectives/*.md` as `type: 'objective'` docs; queryable via `memory recall --types objective`.
- **Snapshot + briefing:** the SessionStart snapshot renders a budget-aware Objectives section (active objectives in full, recently-finished ≤14 days summarized, demoting to active-only then a count line under context pressure) and appends `objectives:` inline to each active task line; the SubagentStart briefing injects a lean, active-first objectives list capped at 10.
- **Doctor:** `checkObjectives()` in `src/cli/commands/doctor.ts` validates slugs, target date formats, status overrides, `depends_on` resolution and acyclicity, and task→objective reference integrity; no-ops silently when `core/objectives/` is empty.
- **Sleep integration:** `sleep-tasks` proposes `objectives:` values only for tasks whose list is empty (never overwrites); the main sleep flow calls `dreamcontext roadmap` as a deterministic, non-agentic step to regenerate `knowledge/roadmap/board.md` from the reconciled task set; no sleep specialist writes to `core/objectives/*.md`.
- **v2 (not yet built):** `GET /api/roadmap` in `buildRouter()` (`src/server/index.ts`) returning the model as JSON for the dashboard; an Excalidraw/Mermaid render of the board; RemSleep auto-regen triggers beyond the deterministic sleep-flow call; slip-diff ("what slipped since last review").
- **v3 (not yet built):** velocity-based forecasting/capacity hints; federation roll-up of objectives across peer vaults; an explicit Key Results layer if the implicit tasks-roll-straight-up model proves insufficient.
- **Companion, orthogonal task:** `version → cycle` presentation rename (`task_Gjb49LnG`) — cosmetic only, does not touch this data model.

## Notes

- **Open question — Key Results layer:** should objectives get an explicit Objective → KRs → tasks layer, or stay implicit (tasks roll straight up)? Current lean is implicit for MVP, explicit KRs deferred to v3 if needed.
- **Open question — objective/feature namespace:** should an objective and a backing feature PRD share a slug namespace, or should the objective carry an explicit `feature:` link? Current lean is a `feature:` link on the objective (objective stays the outcome; feature stays the capability doc).
- As of this writing `core/objectives/` is empty — no objectives have been PO-authored yet. The MVP is implemented and validated (25 unit tests, full suite green, e2e sandbox pass) but not yet published to npm (publish checklist requires owner login/2FA), and the PO has not yet reviewed the board UX. `status` stays `in_review` until that review lands; do not set `released_version` until the user releases it.
- 3 reference GitHub issues track adjacent rendering/refresh gaps that could affect a future v2 dashboard render of this board: #81 (excalidraw card overflow + connector routing), #82 (dashboard doesn't live-refresh excalidraw boards).

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-07-02 - MVP implemented and validated
- Full PO-authored OKR roadmap shipped in the working tree: objectives store + CRUD + write-time cycle guard, pure roadmap model builder with full-DAG cascade and null-forecast rule, `dreamcontext roadmap` CLI surface (text board + `board.md` + `--json` + objective CRUD/depend verbs), `objectives` task field wired across 6 TypeScript surfaces (local-only, not synced), `objective` recall corpus type, budget-aware snapshot section + sub-agent briefing injection, `doctor` validation, and sleep-cycle integration (propose-into-empty + deterministic board regen). 25 new unit tests; full suite (2512+ tests) green; CLI surface e2e-validated in a sandbox. Not yet published to npm; PO has not yet reviewed the board UX — status held at `in_review`.

### 2026-07-02 - Created
- Feature PRD created; backfilled from `feat-roadmap-live-po-authored-roadmap-items-dependencies-forecast-vs-target` (task_uO60nZRt), which carries the full spec history, 3-parallel-mandate review resolutions, and the 2026-06-29 pivot from a task-derived read-only plan to this PO-authored model.
