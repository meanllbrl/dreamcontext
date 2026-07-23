---
id: feat_u_OAkGJy
type: feature
name: proactive-learning-layer
description: >-
  First-class proactive learning layer: THESIS entity (draft → open → validated
  | invalidated → retired) with derived confidence, per-cycle understanding
  changelog, insight instrumentation, and structural relations to roadmap
  objectives, insights, and tasks. A dedicated smart sleep specialist
  (sleep-learn) forms and re-tests theses during sleep; validated/invalidated
  theses promote into knowledge. Fully disableable. Opt-in via `dreamcontext
  theses enable`.
pinned: false
date: '2026-07-20'
status: in_review
created: '2026-07-20'
updated: '2026-07-23'
released_version: 0.20.0
tags:
  - 'topic:sleep'
  - 'topic:agents'
  - 'topic:roadmap'
  - 'kind:architecture'
related_tasks:
  - proactive-learning-layer
---

## Why

The brain consolidates what happened but never learns forward: no hypotheses, no validation loop, no compounding of wins AND failures into knowledge. Sleep today is retrospective bookkeeping; this layer adds the scientific-method half — dreaming as hypothesis formation ("it seems doing X improves Y — maybe we do more of it?"), subsequent sleeps as the experiment check. Every validated OR invalidated thesis becomes durable knowledge ("we believed X; the data said no" is anti-knowledge that prevents re-deriving the same wrong idea later). Because theses, insights, objectives, and tasks become STRUCTURALLY related, the roadmap detail view can finally answer "how are we doing on this objective, what did we try, and what did we learn?" — and recall gets a learning dimension. This is the feature that makes the brain metaphor stop being a metaphor: the system gains a true learning experience over time and remembers it.

## User Stories

- [ ] As the sleep-learn specialist, when I notice a pattern with enough supporting data, I create a thesis in `draft`; I promote it to `open` ONLY when I have real experience/evidence behind it — the layer is proactive but never sprays speculative theses.
- [ ] As the sleep-learn specialist, each cycle I append a reasoning entry to every thesis I touched (the "understanding changelog"), so the next cycle's thinking inherits my chain of thought instead of starting cold.
- [ ] As the sleep-learn specialist, I re-test open theses against fresh evidence (Lab insights, roadmap/objective movement, task outcomes, changelog, later connector digests) and flip them to `validated`/`invalidated` when their pre-registered predictions are borne out or contradicted — confidence is DERIVED from the evidence ledger, never asserted.
- [ ] As the sleep-learn specialist, when a thesis needs data nobody is tracking, I emit an instrumentation request ("create an insight to watch Y") as a decision ask in the cycle report — the user approves and wires the source next session; I never create insights autonomously during sleep.
- [x] As a user, I can create a thesis in conversation ("I have a thesis: X improves Y") — the agent scaffolds it via CLI after confirming shape + predictions with me.
- [x] As the main agent (awake, outside sleep), when the user hands me source material — a meeting note, a report, a discussion — I can propose theses extracted from it (offer-and-confirm, recall-dedup first, created as `draft` unless evidence already justifies `open`), so learning capture doesn't wait for a sleep cycle.
- [x] As a user, I can connect an insight to a thesis (and a thesis to roadmap objectives), so evidence flows structurally: roadmap has insights + theses + tasks; insights connect to roadmap + theses.
- [x] As a user, I can list/search theses via CLI (`dreamcontext theses …`, recall-indexed as their own corpus type) and browse a thesis board page in the dashboard (draft/open/validated/invalidated columns with confidence + evidence trail) — plus see related theses on the roadmap objective detail page.
- [x] As a user, a validated thesis is promoted into canonical knowledge/decision — or, when it governs a procedure and its effect is significant enough, into a RULE in the matching workflow (`knowledge/workflows/`, see knowledge-workflows task) — with the thesis retired to a pointer; an invalidated one is kept as anti-knowledge — every win and every failure is a learning.
- [x] As a user, I can disable the entire layer with one config switch: no sleep-learn dispatch, no CLI/snapshot noise, dashboard page hidden.
- [x] As the agent (any session), the dreamcontext skill has an Entity Router row + reference-file section for theses, so "create a thesis" routes correctly and future sessions know the subsystem exists.

## Acceptance Criteria

- [x] Thesis entity + lifecycle designed and built: `draft → open → validated | invalidated → retired`, frontmatter shape (`status`, `kind`, `confidence`, `predictions`, `evidence`, `insights`, `objectives`, `related_tasks`, `checked_at`, `cycles_checked`, `blocked_on_instrumentation`), storage home (`_dream_context/theses/<slug>.md`), dedup rules, sprawl caps.
- [x] Derived-confidence model built: pre-registered falsifiable predictions at creation; discrete evidence events (supports / contradicts / no-signal) appended per cycle; confidence computed from the ledger by arithmetic (`(ws+0.4)/(ws+wc+0.8)` with recency weights `0.55 + 0.45·(i/(L−1))`), never LLM-asserted; status flips require prediction checks against actual data.
- [x] Understanding changelog built: bounded LIFO per-cycle reasoning log inside the thesis body (chain-of-thought inheritance across cycles); distill/condense rule (keep newest 10 entries; overflow collapses into one CONDENSED entry whose count accumulates).
- [x] Relations graph built: thesis↔objectives, thesis↔insights, thesis↔tasks (many-to-many, frontmatter-based); objective↔insight loose association distinct from the existing single-feeder KR binding; doctor checks for dangling refs; roadmap detail surfaces related theses/insights/tasks.
- [x] sleep-learn specialist built: dedicated smart sub-agent (`agents/sleep-learn.md`), conditional dispatch rules ("sometimes wakes up — we decide when"), inputs (insights, roadmap, task outcomes, changelog, connector digests when available), authority boundaries (CRUD theses; never edits knowledge/tasks directly — promotion goes through sleep-product/decision asks), no-op cheap when nothing due.
- [x] Instrumentation loop built: thesis→insight requests as offer-and-confirm decision asks (agent drafts the insight need; user approves + wires source/credentials via the existing Lab protocol); optional `blocked_on_instrumentation` signal on a thesis.
- [x] Surfaces built: CLI verb set (`dreamcontext theses` — 17 verbs: create/predict/evidence/status/link/unlink/changelog/block/unblock/promote/retire/restore/enable/disable/candidates), `thesis` recall corpus type, dashboard thesis board page ("Hypotheses" — custom interactive UI with board/detail/create modals per user design), roadmap objective detail integration (Learning section), SessionStart snapshot line (open theses count / recent flips).
- [x] Disable switch + docs built: single config flag (`learning.enabled` in `state/.config.json`, default OFF) gating dispatch, CLI surfacing, snapshot section, and dashboard page; skill docs complete (SKILL.md capability row + Entity Router row, new `references/learning.md`, cli-reference section, sleep.md conditional-dispatch row).

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

- **[2026-07-19] Proactive learning layer SHIPPED (v0.19.0, uncommitted on main, in_review status).** Built and validated via goal-skill v2: falsifiable theses with derived confidence from an evidence ledger, pre-registered predictions, understanding changelog, `theses` CLI (17 verbs), recall integration (`thesis` corpus type), doctor/snapshot support, server routes (`/api/theses`, `/api/learning/enable|disable`), dashboard "Hypotheses" board (ThesisBoard/Column/Card/Toolbar, detail/create modals, ConfidenceBar, LearningSection in ObjectiveDetailPanel), and a new `agents/sleep-learn.md` sleep specialist conditionally dispatched when `learning.enabled` AND (fresh evidence OR ≥2 sleeps cadence). Opt-in via `LearningConfig` / `dreamcontext theses enable`. Ships OFF until the PO validates the layer on this project. **Validation method:** npm test (3728 tests green) + npm run build (exit 0) + scripted CLI smoke (`scripts/smoke-theses.mjs`, 20/20 assertions: formula assert, lifecycle gates, candidates round-trip, disable gate). **User-facing label:** "Hypotheses" (code/CLI stay `theses`). **Derived-confidence formula pinned:** recency weight per evidence entry `0.55 + 0.45·(i/(L−1))`, confidence = `(ws+0.4)/(ws+wc+0.8)` (0–1, 0.5 = undecided). Manual flips must cite ≥1 evidence entry; draft→open requires ≥1 pre-registered prediction. Create modal doubles as meeting-note candidate review flow. **Shared thesis→workflow-rule threshold defined** (with knowledge-workflows task): promote iff status flipped (validated|invalidated) ∧ |confidence − 0.5| ≥ 0.25 ∧ ≥3 evidence events ∧ ≥1 quantitative evidence event ∧ the thesis governs a procedure. Encoded as ONE exported constant (`THESIS_RULE_PROMOTION_THRESHOLD`) imported by both sides. There is a `learning.md` skill reference at `.claude/skills/dreamcontext/references/learning.md`.
- **[2026-07-19] Awake thesis capture — an in-session protocol, not just a CLI verb.** Thesis creation works OUTSIDE sleep too, two ways: (a) the user states a thesis in conversation; (b) the user hands the agent source material (e.g. a meeting note) and the agent EXTRACTS candidate theses from it on the spot. Both follow the insight-capture precedent: detect → recall-dedup → offer-and-confirm (never auto-create) → scaffold via CLI, default status `draft` (promote to `open` only when predictions + evidence justify it). The skill's Entity Router has a thesis row with problem-shape triggers ("I think X improves Y", "here are meeting notes — anything worth testing?"), and the capture protocol lives in the reference file alongside insight capture.
- **[2026-07-19] Draft status is the anti-sprawl gate.** Proactive ≠ prolific. A thesis starts as `draft` (a hunch being watched) and is promoted to `open` only when the agent has enough data/experience to state falsifiable predictions. Draft theses are agent working material; open theses are "published" to the board and enter the re-test loop.
- **[2026-07-19] Theses DECOUPLED from connectors.** The thesis lifecycle is a first-class learning layer; evidence sources are pluggable: brain-internal first (Lab insights, roadmap/objectives, task outcomes, changelog, session digests), sleep-connectors later as the external feed. The learning loop shipped WITHOUT connectors being built.
- **[2026-07-19] Confidence is derived, never asserted.** An LLM nudging 0.6 → 0.65 on vibes is pseudo-precision. Predictions are pre-registered at creation; each cycle appends discrete evidence events; confidence = f(evidence ledger). The agent judges what the evidence says; arithmetic owns the score. Guards against self-confirmation bias (the authoring agent validating its own thesis).
- **[2026-07-19] Two thesis kinds: observational vs experimental.** Observational theses validate from incoming data. Experimental ones ("A/B the paywall copy to improve revenue") can't be validated by watching — they surface as SUGGESTIONS (roadmap item / task proposals), and the outcome of that work becomes the evidence. This is where "proactive" gets real: the brain proposing experiments to the user.
- **[2026-07-19] Structural relations are the memory-management win.** Roadmap has insights, theses, AND tasks; insights connect to roadmap and theses. Relations are frontmatter-structural (like `objectives:`), so recall, the roadmap detail page, and knowledge all get richer without prose duplication. Referential integrity via doctor.
- **[2026-07-19] Sleep-learn never asks the user mid-sleep.** Sleep runs autonomously; insight creation needs the user (source + credentials, offer-and-confirm per Lab protocol). So instrumentation requests ride the existing decision-ask / sleep-flags channel and get resolved in a normal session.

## Technical Details

**Concept.** A thesis = a falsifiable claim the brain is actively trying to validate or invalidate across sleep cycles. Pipeline: observation (enough data) → `draft` → predictions pre-registered → `open` → per-cycle re-test against connected evidence → evidence ledger grows → confidence derived → `validated` (promote to knowledge/decision, retire with pointer) or `invalidated` (keep as anti-knowledge, then archive).

**Entity shape** (`theses/<slug>.md` — own corpus type, recall-indexed):
- Frontmatter: `status: draft|open|validated|invalidated|retired`, `kind: observational|experimental`, `confidence` (derived, 0–1), `predictions: [...]` (pre-registered, falsifiable), `evidence: [{cycle, source, verdict: supports|contradicts|no-signal, note}]`, `insights: [slugs]`, `objectives: [slugs]`, `related_tasks: [slugs]`, `checked_at`, `cycles_checked`, `blocked_on_instrumentation: bool`.
- Body: claim prose + **Understanding changelog** (bounded LIFO — one reasoning entry per touching cycle; chain-of-thought inheritance; keep newest 10, overflow collapses into CONDENSED) + evidence log entries citing actual data (an insight series delta, a task outcome, an objective metric move).

**Relations graph (all frontmatter-structural, many-to-many):**
- objective ↔ theses, objective ↔ insights (loose association — DISTINCT from the existing one-feeder KR `lab bind`), objective ↔ tasks (exists today).
- thesis ↔ insights (evidence sources), thesis ↔ tasks (experimental theses spawn/watch tasks).
- Doctor: dangling-ref checks both directions. Roadmap objective detail page + `roadmap --json` surface related theses/insights/tasks → "what did we try, what did we learn" in one place.

**sleep-learn specialist** (`agents/sleep-learn.md`, conditionally dispatched):
- Dispatched by the main-agent sleep flow only when signals warrant (`learning.enabled` AND (open/draft theses exist AND fresh evidence arrived; or cadence due; or user hint)) — "sometimes wakes up; we decide when". No-ops cheaply otherwise.
- Reads: thesis files, Lab caches, roadmap state, task outcomes since epoch, changelog, connector digests (when that feature lands). Writes: thesis files ONLY. Promotion to knowledge goes through the existing channels (sleep-product signal or decision ask) — domain ownership preserved.
- Chronic-open escalation mirrors `RECIDIVISM_ESCALATION_CYCLES=3` (≥3 unresolved cycles → decision ask to the user).

**Surfaces:**
- CLI: `dreamcontext theses` (17 verbs: list/show/create/predict/evidence/status/link/unlink/changelog/block/unblock/promote/retire/restore/enable/disable/candidates); `thesis` corpus type in `buildCorpus`; SessionStart snapshot line (open count + recent flips), budget-demotable.
- Dashboard: "Hypotheses" page (`HypothesesPage.tsx`, hidden when disabled) — thesis board (draft/open/validated/invalidated columns via `ThesisBoard/Column/Card/Toolbar.tsx`, confidence bar `ConfidenceBar.tsx`, evidence trail, understanding changelog timeline in `ThesisDetailModal.tsx`); roadmap objective detail gains a Learning section (`LearningSection.tsx` embedded in `ObjectiveDetailPanel.tsx`). Full-page off-state with enable CTA when disabled.
- Skill: SKILL.md capabilities row + Entity Router row ("form/track a hypothesis" → thesis, NOT knowledge) + new `references/learning.md` reference file (entity, formula, awake-capture offer-and-confirm protocol).

**Disable switch:** `state/.config.json` flag (`learning.enabled`, default OFF until PO validates). Gates: sleep-flow dispatch mention, CLI discoverability output, snapshot section, dashboard nav item + routes.

**Key files:**
- `src/lib/theses/types.ts`, `confidence.ts` — `ThesisManifest`, `deriveConfidence()`, enums, `THESIS_RULE_PROMOTION_THRESHOLD`
- `src/lib/theses/store.ts` — full store implementation, all CRUD verbs, lenient reads / strict writes, gates enforced
- `src/cli/commands/theses.ts` — 17 CLI verbs
- `src/server/routes/theses.ts` — `GET /api/theses`, `POST /api/theses`, sub-routes for predictions/evidence/status/links/changelog/promote, `POST /api/learning/enable|disable`
- `dashboard/src/hooks/useTheses.ts` — `useTheses()`, `useThesis(slug)`, mutations
- `dashboard/src/components/theses/` — full board/detail/create UI tree
- `agents/sleep-learn.md` — the specialist
- `tests/unit/theses-*.test.ts` — 8 test files (store, confidence, promotion, recall, doctor, learning-config, server-theses-routes)
- `scripts/smoke-theses.mjs` — 20-assertion CLI smoke suite

## Notes

- Ships **disabled by default** (`learning.enabled: false`) until the PO validates the layer on this project, then flips to on-by-default as an explicit follow-up.
- The 4 sleep-learn user stories (first 4 in the list) tick at the first enabled sleep cycle — they describe runtime behavior that only happens when the layer is on and sleep runs.
- **For you (PO):** (1) eyeball the dashboard Hypotheses board/detail/create UIs against the design export (`Hypothesis.dc.html`), (2) decide when to run `dreamcontext theses enable` on this project, (3) confirm the autonomous validation-method default (tests + build + CLI smoke — no visual E2E).

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-07-20 - Feature shipped v0.19.0 (uncommitted, in_review)
- Proactive learning layer fully built and validated 2026-07-19 via goal-skill v2. Theses entity, derived confidence from evidence ledger, understanding changelog, CLI (17 verbs), recall integration, doctor/snapshot, server routes, dashboard "Hypotheses" board + detail/create modals, `sleep-learn` specialist, new `references/learning.md`. Ships OFF until `dreamcontext theses enable`. Validation: 3728 tests green, npm run build exit 0, CLI smoke 20/20. Status set to in_review pending PO UI eyeball + enable decision.
### 2026-07-20 - Created
- Feature PRD created.
