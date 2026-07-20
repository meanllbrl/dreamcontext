# Proactive learning layer — theses (Hypotheses)

Opt-in subsystem (`learning.enabled`, default OFF — see [Disable switch](#disable-switch)). A **thesis** is a falsifiable claim the brain is actively trying to validate or invalidate across sleep cycles: an observation forms a hunch, predictions get pre-registered, evidence accumulates cycle over cycle, and confidence is DERIVED from that evidence by arithmetic — never asserted by an agent. The dashboard label is **"Hypotheses"**; code/CLI/storage say **theses** throughout.

---

## Entity + lifecycle

Storage: `_dream_context/theses/<slug>.md` — one markdown file per thesis, mirrors `lab/insights/`. Own recall corpus type `thesis` (`memory recall … --types thesis`).

```
draft → open → validated | invalidated → retired
```

- **`draft`** — a hunch being watched. Agent/user working material, not yet on the board's "published" columns in the way `open` is (draft still shows in the dashboard board, just earliest column). The anti-sprawl gate: proactive ≠ prolific.
- **`open`** — predictions pre-registered, entered the re-test loop. **Hard gate: `draft → open` requires ≥1 pre-registered falsifiable prediction** (enforced by the CLI, the dashboard create/detail modals, and the server route alike — no path around it).
- **`validated` / `invalidated`** — a confidence-derived flip, checked against pre-registered predictions. **A status flip requires ≥3 evidence events (`supports`+`contradicts`, `no-signal` doesn't count) AND an explicit prediction check.** A MANUAL flip (CLI without `--force`, or the dashboard) must additionally cite ≥1 evidence entry. `sleep-learn`'s agent/data-driven flips use `--force` — that bypasses the *citation* requirement because the agent has already done the harder ledger + prediction-check verification, not because the gate is weaker.
- **`retired`** — promoted into knowledge (with a pointer left behind) or archived as anti-knowledge (an invalidated thesis kept as a permanent "we tried X, it didn't work" record — every win AND every failure is a learning). Restorable back to `draft`.

Two **kinds**, set at creation, never changed:
- **`observational`** — validates from incoming data (Lab insights, objective movement, task outcomes). The default.
- **`experimental`** — can't be validated by watching; needs an intervention. Surfaces as a SUGGESTION (a roadmap item / task proposal), and the outcome of that work becomes the evidence.

### Frontmatter shape (`ThesisManifest`, `src/lib/theses/types.ts`)

```
slug, claim, status, kind, confidence (DERIVED — recomputed on every read),
created_by: user | sleep-learn,
predictions: [{ id, text, standing: untested|supported|contradicted }],
evidence: [{ date, cycle, source: insight|task|objective|changelog|external,
             ref, verdict: supports|contradicts|no-signal, note, quantitative }],
insights: [slug], objectives: [slug], related_tasks: [slug],
related_workflows: [slug]   (reserved — see Promotion rules below),
blocked_on_instrumentation, blocked_metric,
cycles_checked, checked_at, promoted_to,
created_at, updated_at
```

Body = claim prose + the `## Understanding changelog` section (see below). Evidence is stored **chronologically, oldest-first** — `evidence[0]` is the oldest event.

---

## Derived-confidence formula

Confidence is computed from the evidence ledger by arithmetic — an LLM nudging a number on vibes is pseudo-precision this subsystem exists to prevent. Implemented once in `src/lib/theses/confidence.ts` (`deriveConfidence`), unit-tested, and recomputed on every read of a thesis file so a stale/hand-edited value can never linger.

For a ledger of length `L` (chronological, oldest-first), the recency weight of entry `i` (0-indexed) is:

```
w_i = 1                              if L <= 1
w_i = 0.55 + 0.45 * (i / (L - 1))    otherwise
```

More recent evidence is weighted more heavily (up to 1.0 for the newest entry, down to 0.55 for the oldest, when `L > 1`). Sum the weights by verdict:

```
ws = Σ w_i over entries where verdict == 'supports'
wc = Σ w_i over entries where verdict == 'contradicts'
```

`no-signal` entries contribute weight 0 to both sums (they still occupy a ledger position and affect `L`/indices of their neighbors, but don't move confidence). Final confidence:

```
confidence = (ws + 0.4) / (ws + wc + 0.8)
```

Bidirectional 0–1 scale; `0.5` = undecided (matches an empty ledger: `0.4/0.8 = 0.5`). This exact formula is pinned by the PO's UI/UX design and rendered in the dashboard detail modal's "ⓘ How is this computed?" popover.

---

## Evidence ledger + pre-registered predictions

**Predictions are pre-registered** — written down before the evidence that will judge them arrives (`theses predict <slug> "<falsifiable text>"`), so a thesis can't be quietly redefined to fit whatever happened. Each carries a `standing`: `untested` until an agent explicitly checks it against real evidence and marks it `supported`/`contradicted`.

**Evidence events are discrete and cited** — never a vague "seems better." Each event names a `source` (`insight`/`task`/`objective`/`changelog`/`external`), an optional `ref` (the cited slug/path/URL), a `verdict`, and a free-text `note`. Mark `quantitative: true` when the observation is a genuine numeric series/metric-delta (an insight value move, an objective metric change) — this feeds the shared workflow-rule promotion threshold (see below).

Both live in frontmatter (arrays), append-only in spirit — there's no "undo" verb; a wrong evidence event permanently affects derived confidence until removed by hand (rare, deliberate).

---

## Understanding changelog

A bounded LIFO reasoning log embedded in the thesis **body** (`## Understanding changelog` section) — chain-of-thought inheritance across cycles, so the next cycle's thinking starts from where the last cycle left off instead of re-deriving from scratch. One entry per cycle that touched the thesis (`dreamcontext theses changelog <slug> "<reasoning>" --cycle <n>`).

Bound: **keep the newest 10 entries verbatim; older entries condense into a single `CONDENSED` summary entry** ("Condensed summary of N earlier cycles: …") so the file can't bloat — same anti-bloat discipline as the core files. The store (`appendChangelogEntry` in `src/lib/theses/store.ts`) manages this automatically; callers just append.

---

## Relations graph

All frontmatter-structural, many-to-many (same pattern as a task's `objectives:` field):

- **thesis ↔ insights** — evidence sources (`theses link <slug> --insight <slug>`).
- **thesis ↔ objectives** — which OKR this claim serves toward (`theses link <slug> --objective <slug>`); surfaces on the objective detail page's Learning section and on `roadmap --json` (`related_theses`).
- **thesis ↔ tasks** — experimental theses spawn/watch tasks whose outcome is the evidence (`theses link <slug> --task <slug>`).
- **objective ↔ insight** is a DERIVED loose association in v1 (via thesis links + the existing single-feeder KR `lab bind`) — no new frontmatter field on objectives.

`dreamcontext doctor` checks dangling refs both directions (a thesis pointing at a deleted insight/objective/task, same pattern as the existing objective↔task check) — malformation warns, never fails hard.

---

## Awake capture — offer-and-confirm, not just a CLI verb

Thesis creation works OUTSIDE sleep too, mirroring the insight-capture precedent exactly:

1. **Detect.** Two trigger shapes: (a) the user states a thesis in conversation ("I think X improves Y", "my hypothesis is…"); (b) the user hands you source material (a meeting note, a report, a discussion) and you can extract candidate falsifiable claims from it on the spot.
2. **Recall-dedup.** Before proposing to create anything, check for a near-duplicate: `dreamcontext memory recall "<claim keywords>" --types thesis`. Don't create a second thesis for a claim that's already being tracked — link new evidence to the existing one instead.
3. **Offer-and-confirm.** NEVER auto-create. Propose the claim (and, for a batch extracted from source material, propose them one at a time or as a reviewable list) and let the user confirm/edit before scaffolding.
4. **Scaffold via CLI, default `draft`.** `dreamcontext theses create "<claim>" [--prediction "<text>"]…` — only promote straight to `open` (`--open`) when the user already has ≥1 falsifiable prediction ready; otherwise `draft` is correct even for a strong hunch.

The dashboard's create/review modal doubles as the meeting-note candidate review flow (`theses candidates <file.json>` stages extracted claims; the modal walks "Candidate i/n" with confirm/skip, confirmed ones land as `draft`).

---

## sleep-learn — the dedicated specialist

One conditional sub-agent (`agents/sleep-learn.md`) re-tests open theses each cycle it's dispatched. Full contract lives in that file and in [sleep.md](sleep.md); summary:

- Dispatched only when `learning.enabled` AND (fresh evidence exists OR the minimum 2-sleep wake cadence is due) — over-fires cheaply otherwise (checks `theses list`, finds nothing due, no-ops).
- Owns `_dream_context/theses/*.md` exclusively, via the `theses` CLI — never hand-edits, never touches knowledge/tasks/insights/objectives/config.
- Appends an understanding-changelog entry to every thesis it touches (including "still watching, nothing new").
- Re-tests against Lab insight caches, roadmap/objective movement, completed tasks, and the changelog since the epoch, appending discrete evidence events.
- **Never creates insights.** An instrumentation gap becomes `theses block <slug> "<metric>"` plus a decision ask the user resolves next session by wiring an insight through the existing Lab protocol.
- Flips require ≥3 evidence events AND a prediction check; promotion to knowledge (or a workflow rule) is always proposed as a decision ask, never written directly.
- Chronic-open theses (≥3 unresolved cycles) become a recidivism `--flag` for `sleep done`, same mechanism as the rest of the recidivism system.

---

## Disable switch

Single config flag: `learning.enabled` in `_dream_context/state/.config.json` (via `SetupConfig.learning`). **Absent = OFF** (default) — nothing about this subsystem is on until explicitly enabled.

```bash
dreamcontext theses enable    # learning.enabled = true
dreamcontext theses disable   # learning.enabled = false
```

The switch is user-flippable from three places: the CLI (`theses enable|disable`), the dashboard **Settings → Memory → Learning layer** toggle, and the Enable CTA on the off-state Hypotheses page.

Gates, hard, on this flag:
- `sleep-learn` dispatch (sleep.md skips it entirely when off — no speculative dispatch).
- The SessionStart snapshot's theses section (omitted, not just demoted, when off).
- The dashboard nav item + `hypotheses` page (nav item hidden; the page itself renders a "the layer is off" state with an Enable CTA when reached directly).
- **Agent behavior (awake capture): when `learning.enabled` is off, do NOT propose, extract, or capture theses** — no offer-and-confirm prompts, no "anything worth testing?" suggestions, no candidate staging from source material. If the user explicitly asks for a thesis while the layer is off, tell them the layer is disabled and offer `dreamcontext theses enable` first; never work around the switch.

**Not** gated: the `theses` CLI verbs themselves stay callable when off (a dim `⚗ Learning layer is off — run 'dreamcontext theses enable' to turn it on.` hint prints, then the command proceeds) — this keeps CLI scripting and doctor checks simple and consistent rather than special-casing every verb. Recall indexing is likewise ungated (naturally a no-op when `theses/` is empty).

---

## CLI verb table

See [cli-reference.md](cli-reference.md#theses-hypotheses) for the full command/flag table. Quick orientation:

| Verb | Purpose |
|---|---|
| `theses list` / `theses show <slug>` | Browse the board / inspect one thesis (claim, status, derived confidence, predictions, evidence, links, changelog). |
| `theses create "<claim>"` | Scaffold a new thesis (default `draft`). |
| `theses predict <slug> "<text>"` | Pre-register a falsifiable prediction. |
| `theses evidence <slug> --verdict … --source …` | Append a discrete, cited evidence event. |
| `theses status <slug> <status>` | Flip status — `draft→open` needs ≥1 prediction; a manual flip needs `--cite`; the agent path uses `--force` + `--prediction <id>=<standing>`. |
| `theses link` / `unlink` | Connect/disconnect an insight, objective, or task. |
| `theses changelog <slug> "<text>"` | Append an understanding-changelog entry. |
| `theses block` / `unblock` | Mark/clear instrumentation-blocked. |
| `theses promote <slug> --knowledge <path>` | Record that a validated/invalidated thesis was promoted (the write to `knowledge/` happens separately, by a human/agent decision). |
| `theses retire` / `restore` | Retire a thesis (pointer or anti-knowledge) / bring a retired one back to `draft`. |
| `theses enable` / `disable` | The one-command switch. |
| `theses candidates <file.json>` | Stage meeting-note candidate claims for the dashboard review flow. |

---

## Promotion rules + shared threshold

A **validated** thesis is promoted into canonical knowledge/decision (retired with a pointer). An **invalidated** thesis is kept as anti-knowledge — "we believed X; the data said no" prevents re-deriving the same wrong idea later. Both are decision asks: `sleep-learn` (or the agent, in-session) PROPOSES the promotion; a human confirms and writes the actual knowledge doc; only then does `theses promote <slug> --knowledge <path> [--retire]` record the pointer.

When a thesis governs a procedure and its effect is significant enough, promotion can instead target a workflow RULE (the `knowledge-workflows` bridge, task_QcBUZMU1 — planning only, not yet built) rather than plain knowledge. Whether a thesis clears that bar is ONE exported constant, `THESIS_RULE_PROMOTION_THRESHOLD` (`src/lib/theses/types.ts`), checked via `qualifiesForWorkflowRulePromotion(thesis)`:

```
status ∈ {validated, invalidated}
∧ |confidence − 0.5| ≥ 0.25
∧ supports + contradicts ≥ 3
∧ ≥1 quantitative evidence event
∧ related_workflows non-empty (thesis governs a procedure)
```

`related_workflows` is reserved and unpopulated in v1 — nothing writes it yet — so this always evaluates `false` today, and every promotion routes through the plain knowledge path. This is deliberate: v1 ships the shared constant + the proposal path only; `knowledge-workflows` will later populate `related_workflows` and import the same constant, so the two subsystems can never drift on what "significant enough" means. PO confirmation is always required regardless of which path a promotion takes.
