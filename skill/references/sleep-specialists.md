# Sleep specialists: rationale and long-form notes

The three large sleep agents (`sleep-tasks`, `sleep-product`, `sleep-state`) now carry only their contract: domain, inputs, protocol steps, report shape and rules. On 2026-09-30 the reasoning behind those rules, the worked examples and the longer original wording moved here, grouped by agent and by the protocol step they explain.

**The agent file is authoritative.** This file explains; it does not add rules. When it and an agent disagree, the agent wins and this file is stale. Read only the section for the agent you are, and only when a rule's edge case is unclear.

## sleep-tasks

### Inputs you'll receive

**Hands-off tasks (background cycles only).** When the brief carries a
`Hands-off tasks:` list, those slugs belong to a session the user is working in
RIGHT NOW. Do not edit, log, insert into, or re-status any of them — not even to
"just fix the status". A file lock stops two writers corrupting one file; it
cannot stop you overwriting a decision the user made thirty seconds ago with a
conclusion you drew from a transcript that predates it. Report each one under
**"Deferred (hands-off)"** with the one line you WOULD have written, so the next
cycle can pick it up. Everything else on the board is yours as usual.

### 1. Read what happened

For each session ID in the brief, read what's relevant:

Also read `_dream_context/state/.sleep.json` directly for `sessions[].last_assistant_message` and any `bookmarks[]`. Sort bookmarks by salience (★★★ → ★★ → ★).

**Read the sessions OLDEST → NEWEST — the latest session wins.** The brief lists
them in `stopped_at` order for exactly this reason. A cycle often spans a
conversation that changed its mind — "let's build X" in one session, "actually,
drop X" in the next — and reading sessions independently makes the cycle file the
first one's idea after the second one killed it. So keep a running **current
truth per topic** as you read, and apply both halves of the rule:

- A later session that **cancels, narrows or supersedes** a topic KILLS every
  earlier candidate on it. Do not file it; report it under
  **"Killed by a later session"**, naming the session that ended it. When the
  user dropped work that never had a task, an awake agent should also have
  recorded it — so run `dreamcontext tasks declined` once per cycle and
  recognise those ideas before you re-derive them from an older transcript.

- **Never bump a status from a transcript older than the newest session that
  touched that task.** An earlier session's "done" cannot close a task a later
  session reopened. `stopped_at` decides which came first — not the order you
  happened to read them in.

### 2. Map sessions → tasks

**Build the BOARD MAP once, before you read a single session.** One call, at the
start of your pass:

That map — not a keyword recall — is what the fold-in test is made against. A
recall only surfaces what you thought to search for, which is precisely how a
sub-slice of an existing task gets filed as a new one: nobody searched the phrase
the existing task happens to use. Hold the map for the whole pass and re-read it
rather than re-running the query per candidate.

**Before creating anything, dedup against existing tasks.** Duplicate tasks — and tasks that are really just a smaller slice of one that already exists — are the #1 consolidation failure mode. A "much smaller piece" of an existing task is **never** its own task. Scan the board map first, then recall by topic for anything the map's one-liners leave ambiguous:

Then decide with this rubric — **default to folding in, not forking a new task**:

- A **smaller piece, sub-step, or follow-up** of a task that already exists (same feature/area, narrower scope) → **Do NOT create a task.** Fold it into the existing one (see below).

**Folding a smaller piece into an existing task** (the case the system keeps getting wrong):

- If the existing task's scope grew to include this work, **broaden its title/scope** — Edit the frontmatter `description:` (the one-line scope) and the `## Why` so the header reflects the now-wider scope. Don't leave a stale, too-narrow title with the new work buried only in the changelog. (Renaming the slug/`name:` is usually unnecessary and breaks links — only do it if the scope fundamentally changed identity.)

**Sub-tasks (`parent_task`) are for genuinely large decomposition only** — an epic that legitimately splits into separable deliverables. Do not spawn a child task for a slice that fits as a user story or acceptance criterion in the parent. When in doubt, fold in.

### Lands in THIS project?

Work gets **discussed** here that does not **belong** here. A connected vault's
feature, a teammate's repo, a person who is not on this roster — the conversation
happened in this session, so the evidence looks local, and the cycle files a task
this project will never do. That task then costs every future session snapshot
tokens and makes the board something to be cleaned.

- Work that belongs to a **connected vault** → **no task here.** At most, hand it
  over: `dreamcontext peer send <vault> "<the observation>"`. Never a local task,
  and never a local task "so we don't forget" — that is the duplicate.

- Either case goes in the report under **"Out of scope (other project/person)"**
  with one line of what it was, so nothing is silently dropped.

### The filing bar — clear ALL of it, or do not file

- **It names a user, a friction and a cost from THIS session's evidence.** Not
   "track X", not "consider Y", not "improve Z". If you cannot say who is hurt
   and what it costs them, you do not yet have a task. *(A GitHub-issue-shaped
   body — Scenario / Expected / Gap — satisfies this as well as a `## Why`
   paragraph does; the format is not the point, the evidence is.)*

   A slug on the tombstone list was consolidated away ON PURPOSE. Log on the
   task that absorbed it. **Never re-file it** — the CLI refuses anyway. A topic
   on the DECLINED list is one a human said no to while awake; it never became a
   task, so there is nothing to log on — do not re-file it, and if you believe
   the decision changed, say so in your report rather than filing (only an awake
   `dreamcontext tasks undecline <key>` lifts it).

**What the CLI refuses on its own — read the message, it names the rule.** Lines
1–4 are your judgement. Two of them are also checked mechanically, so a create
can come back refused even when you believe it cleared the bar:

- ``Nearest task is `<slug>` (cosine … ≥ … review)`` → The nearest task is close enough to be worth your eyes, not close enough to decide for you → **Open that task.** A slice of it → fold in. Genuinely separate → re-run with `--neighbor-checked <slug>`, naming exactly that slug. Naming it is the proof you looked; guessing the flag past a real duplicate is the failure this gate exists to stop.

- `Declined on <date>: "<topic>" — <reason>. Not re-filed.` → This candidate's slug IS a declined idea → Do not file. Report it; lifting is an awake decision.

- `Looks like a declined idea (cosine … ≥ …)` → It *resembles* a declined idea — the message prints that idea's topic, date and reason → Read the reason. Same idea → do not file. Genuinely different → re-run with `--declined-checked <key>`.

**If the CLI prints `neighbor check skipped`, the semantic floor is OFF this run**
(no embedding index, no model, or it was disabled) and the message says so — it
also tells you declined ideas were matched by **exact slug only**. Nothing was
verified for you: your board map, your recall and `dreamcontext tasks declined`
are the *only* dedup on that run. Do it by hand and say so in your report.

Even with every gate clear, WHEN to file is a separate question. File in THIS
cycle only when the evidence is **direct**:

*"It was discussed"* is INDIRECT. A conversation is not a commitment, and a task
filed from one is the wrong-task failure the owner reported. Do **not** run
`tasks create` for it — and do not drop it either. Defer it as a flag the next
cycle can confirm, in the Recidivism-flags block, with **no task slug**:

The key must be **stable across cycles** — slugify the topic the same way every
time, or the repetition that is supposed to build confidence never registers.
`sleep done` persists it, never escalates it (there is no task to escalate), and
prints one `Deferred task candidates: n` line. A candidate you do not re-emit
next cycle is simply dropped, which is the correct outcome for a passing remark.

Rank your candidates by evidence and file at most that many. Going over is not
possible — `tasks create` refuses — so the decision that matters is WHICH ones.
Every candidate you do not file goes in your report under **"Candidates NOT
filed (cap)"** with one line each. Never drop one silently; the next cycle (or
the owner) should be able to pick it up.

```
# Ensure an active planning version exists (orchestrator should have done this; verify)
```

```
# Create the task — auto-attaches to the active planning version.
# Name = a short plain sentence describing the outcome (never a slug — the file
# slug derives from the name). -w is MANDATORY: create refuses an empty why.
# `--by sleep` names you as the filer; the bar applies either way (a live sleep
# lock is the evidence, not the flag). `-w` must clear 40 characters and should
# be far longer — see the filing bar above.
```

If `tasks create` refuses, it names the rule you missed — read it and act on it.
Do not retry with padding to get over the character floor: that produces exactly
the unreadable task the bar exists to prevent.

New tasks scaffold lean — only `## Why` and `## Changelog` exist at birth. Add other sections via `tasks insert` only when there is real content for them; **never insert placeholder content to fill out a task's shape** (Lean Task Authoring Pattern).

Untracked, genuinely-separate work is invisible to future sessions — always link it. But a smaller slice of existing work belongs *inside* that task, never in a duplicate.

### 2.5. Person attribution (multi-person projects only)

When the roster in **`_dream_context/people/people.json`** has **>1 entry** (since 0.23.0 — the retired `.config.json` `people` key is gone; do not read it), the person responsible for a task's progress this cycle must be recorded as a `person:<slug>` tag in the task's frontmatter `tags` array. The slug is a roster **key** (e.g., `person:kerem`, `person:ada`) — `dreamcontext people list` is the source of truth for which slugs exist, and a tag naming a slug that is not on the roster resolves to nobody. Determine attribution from the same signals sleep-state uses for Pass B.5 (git `%an` on the commits, self-identification in the session transcript), applying the **shared bot-filter** — drop any author whose kebab-case slug contains `github-actions` or `dependabot` (the `BOT_SLUG_FRAGMENTS` list in `src/lib/attribution.ts`, consumed by `attributeByPerson`). Never tag a task `person:github-actions`.

Derived multi-person status comes from `people.length > 1`; there is no `multiPerson` key to check.


- **New task**: pass `--person <name>` to `dreamcontext tasks create` (the CLI injects a `person:<slug>` tag automatically).

When the person is already tagged on the task, no action is needed — the tag is additive. Do not remove a previously-set `person:` tag for a person who was quiet this cycle; they remain attributed for prior work.

On a **remote backend** (ClickUp/GitHub), an unmapped `person:<slug>` is NOT silently dropped — the push path records a `SyncReport.warnings[]` entry surfaced loudly in `tasks sync` / `sleep done`. If you tag a person whose slug may not match the live member roster, note it in your report so that warning isn't lost.

### 3. Log progress AND reconcile the body — both required

**(a) Append a changelog entry** — what happened this session:

> **Project override — check first.** If `_dream_context/overrides/task.md` exists, this project has a CUSTOM task shape. READ it before reconciling: follow ITS section names and `## Agent Instructions`, not the defaults below, and keep each declared `custom_fields` value current via `dreamcontext tasks field <slug> <key> <value>` (these sync to ClickUp/GitHub). The SubagentStart briefing flags when an override is active. Absent the file, use the default shape below.
>
> Two custom-field rules that bite in the **autonomous** sleep context:
> 0. **Declared statuses.** The override may declare extra statuses (`statuses:` frontmatter — your briefing lists each with its kind and the shipped status it lives UNDER; `dreamcontext tasks statuses` prints the set). Use their keys with `tasks status`. If a **cancelled-kind** status exists (e.g. `cancelled`), that is where superseded / abandoned / obsoleted work goes — it leaves every progress count and is never live — instead of the `in_review "confirm close"` fallback below, which exists only for projects without one.
> 1. **`required: true` fields hard-fail.** `dreamcontext tasks create` and any transition to a `done`- or `review`-kind status (`completed`/`in_review`) exit non-zero when a required field is unset. If you must close a task whose required field is genuinely unknowable autonomously, set it via `tasks field` first; only as a last resort pass `--allow-missing-required`, and flag the gap in your report.
> 2. **`ask: true` fields are human judgment — never fabricate them.** There is no user in a sleep cycle, so leave an unset `ask` field unset and name it in your report so the user fills it next session. Inventing a value to satisfy a `required` gate corrupts the data.

The task body (Why, User Stories, Acceptance Criteria, Constraints & Decisions, Technical Details, Notes) is *current state*. The Changelog is *history*. If the user pivoted mid-session — "we're skipping phase 1", "dropping the offline requirement", "switching the auth approach" — the body must reflect the new plan, not the old one with a buried changelog note.

- User story or criterion completed → Mark `- [x]` AND update the Mermaid `Workflow` node class (`:::done` / `:::active` / `:::blocked`).

- New edge case / open question → `dreamcontext tasks insert <slug> notes "<note>"`

- A planned schedule surfaced (start/end dates discussed) → Set them: `dreamcontext tasks start <slug> <YYYY-MM-DD>` and `dreamcontext tasks due <slug> <YYYY-MM-DD>` (start ≤ due enforced). Clear a wrong date with `tasks start <slug> clear` / `tasks due <slug> clear`.

A fresh session opening this task file should see the *current plan*.

**Dates.** Tasks carry a `start_date`/`due_date` range in frontmatter (both `YYYY-MM-DD|null`). The first transition to `in_progress` auto-stamps `start_date` with today if it was unset, and reaching `completed` stamps `due_date` with the real completion date (plus `start_date`, when the task was closed without ever being started) — all of these are correct; **do NOT strip an auto-stamped date** as "unexpected". Moving a start past its due date also reschedules that due date (the window's length is preserved), so a start>due range should never exist. A task tagged `backlog` must have no dates, and a dated task must not be `backlog` (mutual exclusion) — don't set a date on a backlog item without removing the tag.

**Tip — recall before reconciling.** If you're unsure whether a decision observed this session was already captured elsewhere (memory entry, sibling task, knowledge file), run `dreamcontext memory recall "<topic>"` to surface the top hits across the corpus before you edit. Cheaper than grep, deterministic, and helps you avoid duplicating a decision that already lives in `2.memory.md` (which `sleep-state` owns).

### 4. Status — review only when genuinely needed

**Think hard before you set each task's status here.** The `completed` vs `in_review` call is the one genuinely judgment-heavy decision in this cycle — reason through the specific task's risk, reviewability, and whether any criterion is mechanically unproven before you bump it, rather than pattern-matching on surface cues.

Pick the status that matches reality. **Do NOT reflexively bump everything to `in_review`** — that buries the few tasks that actually need the user's eyes under a pile that didn't, and leaves finished work rotting half-closed.

The single test: **would the user actually want to look at this before it's closed?** If yes → `in_review`. If it's done and there's nothing to second-guess → `completed`. When you're genuinely unsure, prefer `in_review`. Only the never-done categories below (superseded / abandoned / obsoleted) ever go to `in_review` *for closing* — that's handing the user a close decision, not a completion.

### 5. Version readiness signal (no auto-release)

After bumping statuses, check if the active planning version is now release-ready:

### 6. Backlog grooming — the active list must stay honest

A backlog that nobody has touched in weeks, or that still describes a plan we've since pivoted away from, isn't "active" — it bloats every SessionStart snapshot (each non-completed task costs snapshot tokens on every session) and buries the work that actually matters. Each cycle, groom the whole active list, not just this cycle's tasks:

```
dreamcontext tasks list          # every non-completed task, with updated dates
```

**(a) Direction changes & relevance.** If this cycle revealed a pivot — a new idea, a changed plan, a dropped direction — propagate it to the backlog, don't leave stale tasks describing the old plan:

- A task is partly obsoleted by the pivot → Reconcile its body (step 3): drop the obsolete user stories / criteria, replace stale Technical Details. Keep what's still relevant.

- A task is **wholly** made irrelevant by the pivot → Don't silently delete. With a cancelled-kind status declared: `dreamcontext tasks status <slug> cancelled "obsoleted by <pivot>"`. Otherwise `dreamcontext tasks status <slug> in_review "obsoleted by <pivot> — confirm close"` — closing someone's planned work is the user's call.

- A task now belongs to a different milestone/version → Fix its `version:` frontmatter (Edit the field directly — there's no status-time version verb) so it attaches to the right planning version.

**(b) Staleness.** For each task whose `updated` is **21+ days old** and that no session in this cycle touched, pick one:

- Work was actually done but never logged → Reconcile it now (steps 3-4) — that's a capture failure, fix it. If it's done + validated, `completed`; if it needs eyes, `in_review`.

- Superseded / absorbed by another task → Log a final entry naming the successor, then `dreamcontext tasks status <slug> cancelled "superseded by <other-slug>"` when a cancelled-kind status is declared, else `… in_review "superseded by <other-slug> — confirm close"`.

- Still genuinely planned, just not started → Leave it, but verify its priority isn't inflated — a `high` task untouched for a month is not high priority; downgrade via Edit.

- Abandoned / no longer relevant → `dreamcontext tasks status <slug> cancelled "stale 21+ days, abandoned"` when a cancelled-kind status is declared, else `… in_review "stale 21+ days, appears abandoned — confirm close"`.

**(c) Tagging.** Tags drive recall — sharpen them every cycle. Normalize every task's frontmatter `tags` to the taxonomy vocab (`dreamcontext taxonomy vocab`), and *add* missing facets (area / type / feature) where a task is under-tagged. A well-tagged backlog is found; a poorly-tagged one is re-derived blind.

**(d) Objective linking (only when `core/objectives/` is non-empty).** Objectives are the PO's OKR roadmap items; tasks link to them many-to-many via the `objectives:` frontmatter list. For each task you touched (or created) whose `objectives:` is **absent or empty**, judge which objective(s) the work genuinely serves — check `dreamcontext roadmap objective list` for the live set — and set them: `dreamcontext tasks objectives <slug> <a,b>` (multiple slugs when one task lifts several outcomes, e.g. revenue AND retention — that's expected, not double-counting). **HARD RULE: a non-empty `objectives:` list is a PO decision — NEVER change or extend it.** If no objective fits, leave the field empty; do not force a link. You only edit the task-side field; `core/objectives/*.md` prose/title/dates/structure stay PO-authored and off-limits. Rollups/forecasts recompute when the orchestrator runs `dreamcontext roadmap` after your report.

**(e) Recidivism — check before you flag again.** Read `_dream_context/state/.sleep-flags.json` (plain Read, no CLI) before grooming: if a task/problem you're about to note as "still not done" already carries `consecutive_cycles >= 3` from prior cycles, it has ALREADY been escalated — do not just emit another passive flag observation and move on. Take a real action instead: reconcile it now if it's actually done, `in_review` with an explicit "recurred N cycles — needs your decision" if it's genuinely stuck, or close it if the recurrence itself proves it's dead. Emitting another flag for a problem already at the threshold is the exact failure this closes (`fix-releases-add-auto-discovery-scoping-bug` recurred 5× and stayed `todo`).

For everything NOT yet escalated, report new/continuing recurrence as a flag spec for the orchestrator to pass at `sleep done`:

`sleep done --flag <key>::<label>[::<task-slug>]` is repeatable — one `--flag` per flag (never comma-separated). At 3 consecutive cycles on the same `key`, `sleep done` itself surfaces the escalation ask and bumps the linked task's priority — you only report the observation honestly each cycle, you don't compute the streak.

**Deferred task candidates ride the SAME store — and they are how an indirect
candidate becomes a real task.** A `task-candidate:<key>` flag carries no task
slug and never escalates (there is no task to bump, and nobody to hand an ask
to); `sleep done` prints a `Deferred task candidates: n` line for them instead.
Each cycle, read `_dream_context/state/.sleep-flags.json` and reconcile them:

- Carrying `consecutive_cycles >= 1` **and** independently re-observed by THIS cycle (fresh evidence since the epoch — not the same conversation re-read) → It has now recurred: **file it.** The filing bar still applies in full; pass `--neighbor-checked <slug>` when the review band names a neighbor you opened and judged separate. Report it as **"Filed from a recurring candidate"** with the cycle count.

- Still only discussed, with nothing new this cycle → Re-emit the SAME key with an updated label. Confidence by repetition means the streak has to be real.

- Not observed at all this cycle → Do not re-emit it. `reconcileFlags` drops it — that is the design, not a loss.

**Key Result current — you MAY update it, EXCEPT on insight-fed objectives.** When this cycle surfaced a new real observed value for an objective's Key Result metric (e.g. MRR moved to $1,250, active users hit 400) — from the transcript, a file, or a connected system — refresh it: `dreamcontext roadmap objective metric <slug> --current <n>`. This is the ONE write you may make to a `core/objectives/*.md` file, and only through this CLI verb (never hand-edit the frontmatter). Use a value you actually observed — do not invent or estimate a number. The roadmap board regen at the end of sleep will reflect the new progress.

**Insight-bound Key Results are hands-off.** Some objectives are *measured*, not asserted: a Lab insight (`_dream_context/lab/insights/<slug>.md`) may carry `binding: {objective: <slug>}`, meaning `lab bind` seeded — and every `lab sync` rewrites — that objective's `metric.current`. Before any metric write, check for a feeder: `dreamcontext lab list --json` and look for a manifest whose `binding.objective` equals the objective's slug (one feeder max per objective). If bound, do NOT write `metric.current` — your number would be overwritten at the next sync and blurs measured-vs-asserted provenance. If the feeding insight's cache looks stale or errored (`dreamcontext lab show <slug>` → old `fetchedAt` / `error` set), say so in your report so the user refreshes it. **Sleep NEVER runs `lab sync`** — that's a standing decision (credential exposure, latency, non-determinism); refreshing is always an explicit user/agent action outside sleep.

Never silently delete a task, and never `completed` a task that was never actually done — for superseded/abandoned/obsoleted work use the project's cancelled-kind status when one is declared (it is terminal without claiming completion); otherwise `in_review` with an explicit reason hands the close decision to the user. List every grooming action in your report.

### Return — short report

```
- Updated: <slug> (in_progress → completed, "<done, validated, no review needed>"), <slug> (in_progress → in_review, "<the specific thing the user must verify>"), <slug> (logged)
- Folded in (no new task): <existing-slug> — broadened scope + added 2 user stories / 1 criterion for <smaller-piece> instead of forking a duplicate
```

```
- Candidates NOT filed (cap): <one line each: what it was, and the evidence, so nobody has to re-derive it> | OR: none — every candidate cleared the bar and fitted the cap
- Did not clear the filing bar: <one line each: what it was and which line it failed — including every CLI refusal: the neighbor it named (merge/review), or the declined idea and its date> | OR: none
- Killed by a later session: <topic> — <the session that cancelled/narrowed it> | OR: none
- Out of scope (other project/person): <one line each: what it was and whose it is (connected vault / non-roster person)> | OR: none
```

```
- Body reconciled: <slug> (dropped phase 1 from User Stories; replaced Technical Details auth section)
- Person attribution: <slug> tagged person:ada (multi-person project, ada drove this cycle's work) | OR: single-person project — no person tags injected
```

```
- Backlog grooming: <slug> obsoleted by pivot → in_review ("confirm close"), <slug> re-attached v0.8.x→v0.9.0, <slug> tags normalized + facets added, <slug> priority high→medium (untouched 30d), 2 tasks left as-is (genuinely planned)
- Objective links: <slug> → [retention-20, revenue] (was empty), <slug> left unlinked (no objective fits) | OR: no objectives in this project — skipped
- KR metrics: <objective> current → <n> (observed in transcript) | <objective> SKIPPED — fed by bound insight <insight-slug> (cache stale since <date>; suggest `lab sync <insight-slug>`) | OR: no metric observations this cycle
- Recidivism flags: recurring-task:<slug>::"still todo after N cycles"::<slug> | OR: none this cycle
- Recidivism actions: <slug> was already escalated (consecutive_cycles >= 3) → set in_review "recurred N cycles — needs your decision" instead of re-flagging | OR: none escalated
- Cross-domain mentions: <slug> includes a memory-worthy decision about JWT — flagging for sleep-state
- Deferred (hands-off): <slug> — <the one line you would have logged> | OR: none (foreground cycle, or nothing in play)
```

```
Dropped-but-load-bearing self-check: <none | list any digest/auto-bookmark/task signal you saw but did NOT fold into a task changelog/body, with the reason — and every neighbor/declined refusal the CLI returned, since a refusal you don't report is a candidate nobody can pick up>
```

### Rules

- **Dedup before creating.** Recall first; fold a smaller slice into the task that already covers it — broaden its title + insert sub-items — instead of forking a duplicate or a needless sub-task. A new task is only for a genuinely separate concern.
1a. **Clear the filing bar, and never pad to get past it.** Every new task names a user, a friction and a cost from this session's evidence; has a next step; has no prior home (recall AND `tasks tombstones` AND `tasks declined`); and is not a one-liner or already-shipped work. The cap is real and `tasks create` enforces it — so report what you did NOT file rather than dropping it. A refusal from the CLI names the rule you missed; fix the task or don't file it, but do not inflate the `--why` to get over the character floor. **`--neighbor-checked <slug>` and `--declined-checked <key>` are proof that you opened the thing the CLI named, never a way to get past it** — a duplicate filed behind either flag is worse than the refusal, because now it looks reviewed.

- **Body = current truth, Changelog = history.** Don't let the body lag behind decisions.

- **Stay in your lane.** If you spot non-task work worth preserving, flag it — don't write it.

- **CLI first** for status/log/insert; **Edit** for surgical body reconciliation (including broadening `description:` / `## Why` when scope grows).

- **Normalize tags via taxonomy vocab.** When writing or updating task frontmatter tags, check `dreamcontext taxonomy vocab` and use canonical forms (faceted or bare standard tags); non-canonical tags degrade recall.

- **Objectives: propose for empty, never overwrite non-empty.** An existing `objectives:` value is a PO decision that sticks. You fill blanks with judgment; you never revise the PO's linking. Objective files themselves (`core/objectives/`) are PO-authored — never hand-edit their prose, title, dates, or structure — with the single exception that you may refresh a Key Result's `current` via `dreamcontext roadmap objective metric <slug> --current` when you observed a new real value (see grooming (d)) — and NEVER on an objective fed by a bound Lab insight (check `dreamcontext lab list --json` for `binding.objective`; measured values belong to `lab sync`, which sleep never runs).

- **Recidivism — act on escalated flags, don't just re-flag.** Read `state/.sleep-flags.json` before grooming; a problem already at `consecutive_cycles >= 3` needs a real decision (in_review / close / fix), not another passive flag line. Report new/continuing recurrence via the flag-spec block (grooming (e)) so the orchestrator can pass `sleep done --flag`.

- **Latest session wins.** Read sessions oldest → newest and hold a current truth per topic. A later session that cancelled, narrowed or superseded a topic kills every earlier candidate on it, and no status bump may come from a transcript older than the newest session that touched that task.

- **Lands in THIS project.** A task is filed here only if the work changes this repo, changes this brain, or was asked for here. A connected vault's work (`dreamcontext link ls`) or a non-roster person's work (`dreamcontext people list`) gets NO task here — report it under "Out of scope (other project/person)".

- **Direct evidence files; discussion defers.** File this cycle only on a user ask, real changes no live task covers, or a task-less bookmark. "It was discussed" becomes a `task-candidate:<key>` flag and is filed only when a later cycle independently re-observes it.

## sleep-product

### When you fire

You're optional. The main agent dispatches you when **at least one** of these signals is present:

- A bookmark tagged `research` exists.

- `sleep-state` extracted overflow from a core file (one-line reference left there).

- The user hint mentions knowledge, research, or a topic to preserve.

- The brief's `automationOutputs.outputs` is non-empty — at least one automation output file was written since the last completed cycle. See "Automation output consumption" below; this signal alone is enough to fire you even with nothing else present, since most cycles are the only chance to fold that output in before it's forgotten.

- A session advanced a feature substantially (≥1 acceptance criterion newly met, new milestone).

- A new buildable concept emerged with **≥2 acceptance criteria** named anywhere in the session.

If none apply when you start, no-op cheaply: read the brief, scan for actual signals, return a short "nothing to do" report.

### Your domain

- `_dream_context/knowledge/data-structures/<product>.md` (schemas, models, API contracts) → task files (sleep-tasks owns)

- `_dream_context/knowledge/patterns/*.md` (pattern lifecycle EXCEPT their content: create when a recurring-practice signal shows the same solution shape worked ≥2 times; condense one past the ~150-line discipline; retire stale via archive-before-delete. **Never fold a user correction into a pattern** — that belongs to the awake agent in the task where it was said, and the prompt hook instructs it accordingly. A pattern the cycle's transcript shows was contradicted and left stale is REPORTED as a missed awake rule (name the pattern + the correction), not silently rewritten. When a cycle shipped a new FEATURE, verify `feature-integration-pattern.md` was applied; flag gaps. **After any create/rename/retire, run `dreamcontext patterns sync`** so the generated `/pattern-*` entries match the vault — a retired pattern must not keep a live `/` entry. Naming: a pattern's own filename and H1 ARE its triggers, so name it after the thing a user would SAY, not after the code — and check with `dreamcontext patterns match "<phrase>"` that it fires)

- `knowledge/roadmap/board.md` (AUTO-GENERATED by `dreamcontext roadmap` — never hand-edit; the orchestrator regenerates it each sleep)

- `_dream_context/lab/**` (Lab insight manifests/cache/credentials — insights are their own recall-indexed entity, not knowledge; never edit, **never run `lab sync`**)

- `_dream_context/automations/**` (manifest/cache/output/`hitl/` questions — READ output files for material via `pendingOutputsSince`'s file list, NEVER edit or delete them; not yours to own, see "Automation output consumption" below)

### Protocol

Run two passes. The features pass usually goes first because it research-grounds the PRD against the task files and code; the knowledge pass then captures any cross-cutting findings and processes staleness flags.

### 0. Read the signals and relevant transcripts (shared)

Pull only the sessions implicated by signals — don't read all sessions if only one had research.

### A1. Map signals to features

- **Existing PRD path** (`features/<name>.md` exists): you'll update it.

- **Task slug matches PRD name**: same as above.

- **No PRD exists for a buildable concept**: you'll create one. **Research first.**

### A2. Research before writing (especially for new PRDs)

Ground the PRD in current truth before editing or creating:

```
# Read the related task file(s) — most current source of intent + scope
```

```
# Read existing PRD if updating
```

```
# Inspect the actual code that ships the feature
```

### A3. Update an existing PRD

- `## Why` → Edit only if motivation shifted; otherwise leave.

- Frontmatter `status` → Bump (e.g., `in_progress` → `in_review`) when criteria coverage justifies. Never auto-promote to `released`.

- Frontmatter `related_tasks` → Add new task slugs that ship this feature.

- Frontmatter `released_version` → Only set when the user explicitly releases (not your call).

For structured insertion the CLI handles:

### A4. Create a new PRD from scratch

- (a) the session introduced a feature concept with **≥2 acceptance criteria** written down anywhere (task body, conversation summary, sleep notes); OR

- (b) the user explicitly named something as "a feature" or "we should add X" (or equivalent intent); OR

This trigger is intentionally broad. Better to create a thin PRD that gets enriched next cycle than to leave a buildable concept undocumented.

**Slug derivation.** Derive the PRD slug from the user's naming if given; otherwise use the dominant task slug from the session. Format: kebab-case, ≤40 chars.

Then Edit the resulting file. Required sections (look at existing PRDs for shape):

- Optional frontmatter `product: <name>` — see "Multi-product awareness" below.

- `## Why` — motivation, the problem it solves, who benefits.

- `## User Stories` — `- [ ]` for not-yet-shipped, `- [x]` for already-shipped (research what's already done).

- `## Acceptance Criteria` — concrete, testable. **MAY be empty on first creation** if the session didn't produce concrete criteria — DO NOT invent criteria. Leave the section as a single placeholder line: `- [ ] _To be defined — concept-stage PRD; refine in next session._`. The next session will fill it in. This applies especially when A4 fires on a sparse signal (e.g., the user said "we should add X" without spelling out behaviour).

- `## Constraints & Decisions` — anything non-obvious that constrains the design.

**Don't write fiction.** If the feature is half-built, say so in `## Technical Details`. If acceptance criteria aren't grounded in the session, leave the placeholder line above — never hallucinate criteria to fill the section. The PRD's value is current truth.

### A5. Multi-product awareness

If the relevant task has `product: X` in frontmatter, the PRD MAY be product-scoped:

- Write the PRD to `knowledge/features/<slug>.md` (single flat directory, typed knowledge) but include `product: X` in frontmatter so dashboard/CLI filters can route it.

- Any knowledge updates that emerge from this feature go to `_dream_context/knowledge/products/X.md` (create if missing) **in addition to or instead of** the global knowledge files. Per-product knowledge wins when the content is product-specific; global knowledge wins for cross-cutting topics.

### B0. Organize — folders, grouping, and placement

Before curating content, keep the knowledge store's *structure* logical. `knowledge/**/*.md` is indexed recursively (`buildKnowledgeIndex` globs `**/*.md`), so subfolders are fully recall-safe — grouping a file never hides it.

**Diagrams → co-located in their context folder (promoted layout).** A canonical board belongs **inside the context folder it documents**, alongside that context's knowledge — `knowledge/<context>/<title>/<title>.excalidraw.md` (the board plus its dark-sibling `.board.cjs`/`.json` in its own `<title>/` wrapper). Diagrams are NOT a segregated top-level dump; they live with the context they illustrate. When you group a context (below) and that context has a board, move the board into the context folder too so the folder tells one story.

```
dreamcontext migrations apply-diagrams   # legacy/structural: folds flat boards UNDER knowledge/diagrams/ into per-title subfolders + rewrites [[wikilinks]] atomically; idempotent, prints "nothing to organize" when clean
```

`apply-diagrams` is the **legacy** mechanism for boards still under a top-level `knowledge/diagrams/` tree (it does flat→per-title, not context-grouping). Run it each cycle to keep legacy boards tidy; it's safe and idempotent. For NEW canonical boards, place them in their context folder directly. Placement judgment FIRST: only canonical boards (architecture, flows, roadmaps a future session should recall) go under `knowledge/`. Scratch/exploratory/in-progress boards belong in `inbox/` or `workspace/` (dark by location — not indexed) — leave those alone; do NOT pull them into knowledge. Never hand-edit board scene JSON or wikilinks — the command owns both.

**Knowledge → logical subfolders (grouping; moves are deep-only).** When ≥3 top-level `knowledge/*.md` files form a clear topical cluster a future session would browse together (mirroring the existing `data-structures/` and `products/` subfolders), group them under `knowledge/<group>/`. Moving files + rewriting links is a structural op — gate it exactly like merge-with-delete (B1.5):

- **light/standard:** do NOT move. **Flag the cluster in your report** (`group candidate: <group>/ ← a.md, b.md, c.md`) for the next deep cycle.

- **deep:** archive-before (the B1.5 safety net), then for each file run `dreamcontext knowledge move <slug> <group>` — it moves the file into `knowledge/<group>/` AND rewrites inbound `[[old-slug]]` references atomically (target token only; `|alias` and `#anchor` preserved). Do NOT hand-move + hand-edit links. Verify every file still lists: `dreamcontext knowledge index --plain`.

Group only on a **sharp** topical boundary — the same B2 create-vs-extend test, applied to folders. Don't fragment (one folder per file) and don't over-nest. After any group/move, re-check the moved files' tags in Pass C so the folder and the tags tell the same story.

### B1. Decide: create, update, archive, or pin

For each knowledge candidate (research finding, sleep-state flag, extracted overflow):

- New research or decision worth long-term retention → Decide create-vs-extend per **B2's consolidation rubric** first, then `dreamcontext knowledge create <slug> --tags "<tag1>,<tag2>"` and Edit body — *or* extend an existing file

- Existing knowledge file gained new findings → Edit the file; update frontmatter `summary:` if drifted

- `sleep-state` flagged stale-archival candidate → Read the file; if no longer load-bearing, append to a top-level `archive/` knowledge file or set `archived: true` in frontmatter (per project convention)

- `sleep-state` flagged frequent-access-not-pinned → Edit frontmatter: `pinned: true`

- `sleep-state` flagged pinned-never-accessed → Edit frontmatter: `pinned: false`

- Overflow extracted from core file (one-line reference left there) → `dreamcontext knowledge create <slug>` and paste the extracted content

- Cross-cutting finding from your own features pass → Capture inline (no need to flag — you own both domains this cycle)

### B1.5. Depth gating — what you may actually DO this cycle

Your orchestrator brief states a `depth: <light|standard|deep>`. **Destructive/expensive knowledge ops run ONLY at `deep`.** Tag every action you are about to take:

**At light/standard:** if you spot a merge or deletion candidate, do NOT act on it — **flag it in your report** ("merge candidates: `<a>` + `<b>`") so the next deep cycle (or the user via `sleep start --deep` / desktop Sleep) handles it. The agent MAY bump one tier with a stated reason if signals clearly warrant it (e.g. two exact-duplicate files at standard), but state the bump and reason explicitly in your report.

**Archive-before-delete safety net (deep only, MANDATORY):** before ANY deep-tier merge-with-delete or summarize-and-replace, FIRST copy the file you are about to lose to a dated archive:

The dated archive copy is the recovery net; the "Dropped-but-load-bearing self-check" report line is the audit signal. Both are required for every destructive op.

### B2. Create vs. extend — the consolidation rubric

**A knowledge file is a tag-able identity, not a dumping ground.** Aim for the *fewest* files that keep each topic cleanly findable. Fragmenting one topic across many near-duplicate slugs makes tags noisy and recall worse; cramming unrelated topics into one super-file makes tags meaningless. Pick the boundary on purpose.

**Dedup first — run the SEMANTIC nearest-neighbor check BEFORE you create anything.** Keyword recall only finds files you thought to search for; the exact keyword fragility this project keeps hitting. `dreamcontext embed dedup` embeds the candidate and returns its closest existing docs by meaning — the guesswork-free dedup gate:

It prints the nearest knowledge+feature docs with cosine similarity and a **verdict**:

- **MERGE** → A near-verbatim twin already exists (cosine ≥ 0.97, decisively closer than the runner-up) → Do **not** create. Extend the named file (or `dreamcontext knowledge merge` at deep tier).

- **REVIEW** → Same-topic candidate in the 0.91–0.97 band → Apply the sharp-vs-soft rubric below against the **named** neighbor — usually extend it.

- **CREATE** → No near-duplicate above the review threshold → Safe to create — still sanity-check the top neighbor.

`--if-present` makes it a no-op (and it prints a fallback note) when this vault has no embedding cache or the model isn't installed — so it's always safe to run and never triggers a first-time model download during sleep. When it's a no-op or reports the model is unavailable, **fall back to keyword recall.** Semantic dedup is an ASSIST, not a replacement — also recall by the topic AND its family (vertical / brand / parent domain), especially for CREATE/REVIEW verdicts:

Then decide — **default to extending an existing file**:

- The **same vertical / brand / topic family** as an existing file, or a sub-aspect / increment / follow-up of a topic already covered (a *soft* distinction) → **Extend that file** — add a section, update `summary:` if it drifted. Don't fork a near-duplicate slug. Similar brands, similar verticals, similar topics belong together in the fewest files.

- A **genuinely separate topic / domain / concern** a future session would expect to find standing alone, where its own tag set sharpens discovery (a *sharp* distinction) → **Create a new file** (below). A clean topical boundary earns its own slug so tagging stays valuable.

The test for sharp-vs-soft: *Would a future recall expect this bundled with the existing file, or standing on its own? Would a separate file make the tag set more discriminating — or just split one topic across two slugs?* If splitting wouldn't sharpen the tags, extend. A **MERGE** verdict settles it (extend); **REVIEW** is where this rubric earns its keep.

This is **not** "always make super-files." Distinct topics MUST get distinct files — that's exactly what makes tags worth having. It's the *soft* distinctions (same family, narrower slice, incremental finding) that fold into an existing file.

For surgical frontmatter or body edits to an existing knowledge file, `dreamcontext memory update <slug> [--description|--tags|--content|--append|--pin|--unpin]` is a CLI shortcut over hand-editing; use it for single-field changes (e.g., flipping `pinned`, retagging, appending a follow-up section). Prefer Edit when restructuring the file body.

- **Why this exists** (1–2 sentences)

- **The finding / decision / research summary**

- **Sources** (links, file refs, transcript IDs)

- **Last verified** date if content can go stale

### B3. Tags — use the taxonomy vocabulary

Pull tags from this list (faceted canonicals preferred: `topic:recall`, `domain:database`, etc.). Bare standard tags remain valid fallbacks. Don't invent tags freely; new tags fragment search. The project vocabulary is maintained in `core/taxonomy.json`; scaffold with `dreamcontext taxonomy init` if missing. Add new vocabulary via `dreamcontext taxonomy add <tag>` or merge aliases via `dreamcontext taxonomy alias <alias> <canonical>` — never hand-edit the JSON.

### B4. Index sanity check

After your edits, the index should reflect what changed. If a file is missing unexpectedly, it likely has malformed frontmatter — fix.

### B5. Per-product knowledge stubs

Read `_dream_context/state/.config.json` (if it exists). For each product listed in `multiProduct`, ensure `_dream_context/knowledge/products/<name>.md` exists. If missing, create a stub with frontmatter:

This is a one-time bootstrap per product; once the file exists, treat it like any other knowledge file (edit on demand, don't recreate).

### B6. Data structures (schemas / models / API contracts)

Data structures live at `knowledge/data-structures/<product>.md` (`default.md` for single-product). They moved here from `core/` because schemas ARE domain knowledge — this gives them recall indexing, staleness flags, and the knowledge UI for free. **You own these writes now** (sleep-state only flags them for you).

**Single-observation gate.** Unlike most knowledge (which waits for repetition), a schema/data-model change is reflected in the *same* cycle — no pattern repetition required. If `sleep-state` flagged a schema/table/model change, or the diff shows one, write it now.

- Active task has `product: X` → `knowledge/data-structures/X.md` (create if missing).

**Migration of the old locations** (idempotent; the dir move runs automatically on `dreamcontext sleep start`, but confirm + handle the legacy file):

- If `core/data-structures/*.md` still exists and the knowledge copy is absent, it was (or should be) moved to `knowledge/data-structures/` — the `sleep start` migration handles this. Verify it landed.

- If the even-older `core/5.data_structures.sql` exists and `knowledge/data-structures/default.md` does not, copy it there (add the data-structures frontmatter) — don't delete the legacy file.

- **Never delete** the old `core/data-structures/` dir or the legacy `.sql` yourself — leave them for the user to remove after confirming (the `doctor` command nags about both). Note any migration in your report.

### B7. Automation output consumption

Automations write dated markdown files unattended, on their own schedule. Nobody reads them unless you do — this pass is that reading. You **read** these files for material; you never edit, move, or delete them, and you never touch anything else under `_dream_context/automations/` — including `automations/hitl/`, the human-in-the-loop questions store — nor the machine-local Telegram/session-binding state it keeps outside the brain at `~/.dreamcontext/` (that subsystem owns all of it entirely — see the domain table above).

**Where the list comes from.** Your brief carries an `automationOutputs` block straight from `dreamcontext sleep start --json`: `outputs` (each `{slug, path, date, mtimeMs, sizeBytes, shared}`, newest first), `skipped` (each `{slug, path, reason}`), and `totalBytes`. This list is already bounded upstream — at most 20 files and 200 KB total, newest first, with anything over either cap **skipped wholesale, never truncated to fit**, and every skip named with a reason rather than silently dropped. You don't need to re-apply these caps; just read what's listed, and report `skipped` verbatim in your own report so nothing vanishes silently between the CLI and the user.

**Default action is SKIP.** Read each output (`cat` or the Read tool, respecting the per-file cap the brief already applied). Most digest content is already-known state — a daily summary restating things the brain already has is not knowledge, and folding it in anyway is how a knowledge base drowns in noise. Only act when an output contains something genuinely new: a fact, a decision, a research finding, something that would be lost if this were the only place it ever got written down.

**When something IS new, fold it into the RIGHT existing file — never mint one per output.** Run the same dedup-first, create-vs-extend rubric as B2 (`dreamcontext embed dedup`, then the sharp-vs-soft test) against the finding, exactly as if it came from a session transcript. **HARD RULE: never create one knowledge file per automation output file per day.** A daily digest running for a month must not produce thirty knowledge files — it produces zero new files most days, and an edit to one ongoing file on the days it actually finds something new. If you notice yourself about to `knowledge create` for a second consecutive day from the same automation slug, stop and re-check whether you should be extending yesterday's file instead.

**Private automations still count — with an obligation attached.** An automation's `shared: false` (the default) keeps its manifest and output off the team's remote; it does not stop you from reading it, because you're reading the local filesystem, not git. But knowledge files ARE synced regardless of any automation's sharing flag. So the moment you fold a `shared: false` output's content into any knowledge file, that content can be published through the knowledge file even though the automation itself never left this machine. When that happens, you MUST write the private-derivation marker before finishing this pass, so `sleep done` can gate on it:

Then Write `_dream_context/state/.sleep-private-derivation.json` with exactly this shape (merge into any existing content from earlier in the same cycle rather than overwriting it):

List every private automation you derived from and every knowledge path it touched, even if one knowledge file absorbed findings from several private automations. If nothing this cycle came from a `shared: false` output, write nothing — an absent marker means `sleep done` proceeds without asking.

### Pass C — Taxonomy maintenance

Run this pass every cycle to keep tags healthy. It is fast and always warranted.

### C1. Ensure taxonomy.json exists

This is idempotent — if `core/taxonomy.json` already exists, no change is made.

### C2. Audit the corpus, then bulk-heal the safe drift

`audit --fix` is the **safe bulk path** — it rewrites ONLY tags whose `normalizeTag → resolveAlias`
yields a *different canonical* tag (aliases like `db → domain:database`, casing like `Architecture →
architecture`). It NEVER touches already-canonical tags (so `decisions` is not churned to `decision`)
and NEVER guesses an orphan — orphans are reported as *"needs a vocab decision"* and left untouched.
This is what makes corpus-wide normalization safe to run every cycle. Then act on the buckets `--fix`
deliberately doesn't auto-resolve:

- `alias` / normalizable tags → **Run `taxonomy audit --fix`** — one shot, corpus-wide, idempotent. Don't hand-edit these file by file anymore.

- `orphan` tags (a real concept) → **Alias-then-fix:** `dreamcontext taxonomy alias <orphan> <canonical>` (or `taxonomy add <facet:value>` if it's a brand-new canonical), then re-run `taxonomy audit --fix` to apply it everywhere.

- `nearDups` in vocab → If two vocab entries are near-duplicates by accident, remove the weaker one by hand-editing `core/taxonomy.json` (surgical: remove one entry from the `facets` object) and update any files using it.

**The only bulk rewrite you may run is `taxonomy audit --fix`** (it is verified-by-construction against
the vocabulary). Any OTHER tag edit stays surgical and confirmed against the audit output.

### C3. Grow the Domain Vocabulary

If the session produced new recurring domain nouns (product names, feature areas, technical concepts) that aren't yet in the vocabulary, add them via CLI — never hand-edit `core/taxonomy.json` directly:

```
# Merge a shorthand alias into an existing canonical
```

```
# Verify a tag's classification and resolution
```

### Return — single combined report

```
- Updated: features/council-skill.md
  - Ticked 2 acceptance criteria (synthesizer + promote-to-knowledge verified in code)
  - Added 1 user story (post-debate review queue)
```

```
  - status in_progress, tags: [agents, sleep, consolidation]
```

```
- No-op feature signals: 1 (signal "feature_advanced=marketing-dashboard-v0" — but PRD exists and no criteria moved)
```

```
- Diagrams: ran `apply-diagrams` — folded knowledge/diagrams/federation.excalidraw.md (+federation.board.cjs) into diagrams/federation/ (canonical board, was flat). 0 ambiguous.
- Knowledge grouping: group candidate flagged for deep cycle — `decisions/` ← decision-mem0-vs-bm25-recall.md, decision-link-aware-vs-embedding-recall.md, decision-meta-marketing-skill-adoption.md (3 sibling `decision-*` files browse together). Not moved (standard depth).
```

```
- Created: knowledge/jwt-rotation-policy.md (tags: security, decisions; from sleep-state flag) — sharp boundary, new tag-able topic
- Extended (no new file): knowledge/competitive-analysis-ecc.md — folded the new ECC pricing finding into the existing file (soft distinction, same topic family) instead of forking a near-duplicate slug; updated `summary:`
- Pinned: knowledge/project-origin-and-prd.md (frequently accessed)
```

```
- No-op knowledge signals: 1 (`research_present` was a one-line decision already captured by sleep-state in 2.memory.md — not knowledge-worthy)
```

```
- audit: 2 nonCanonical tags fixed (knowledge/auth-design.md: auth → domain:security; state/task-slug.md: db → domain:database)
- Domain Vocabulary: added 'ripple' via `taxonomy add topic:ripple`, added alias 'bookmarking' → 'topic:sleep' via `taxonomy alias bookmarking topic:sleep`
```

```
- Read: 3 outputs (eod-digest x2, weekly-report x1), 0 skipped
- Folded: eod-digest/2026-07-25.md → extended knowledge/ci-flakiness.md with a newly-named recurring failure (soft distinction, same topic family)
- No-op: eod-digest/2026-07-24.md, weekly-report/2026-07-20.md — already-known state, nothing new to capture
- Private-derivation marker: written — eod-digest is `shared: false` and its finding landed in knowledge/ci-flakiness.md
```

### Rules

- **Research before writing PRDs.** Read the task, the code, the existing PRD. Don't guess.

- **Tick criteria only when verifiable.** Code shipped + tests pass, or user confirmed in session.

- **Never set `released_version`.** That's the user's release call.

- **Create PRDs for buildable concepts** that don't have one — they will be lost otherwise.

- **Single source of truth — feature vs knowledge vs insight.** A topic lives in exactly ONE home. A **feature** PRD documents what a capability *is* (user stories, acceptance criteria); **knowledge** holds research/decisions/rationale; a short technical decision belongs in `2.memory.md` (sleep-state's domain); a **business/product metric** lives as a Lab insight (`lab/insights/<slug>.md`, recall type `insight`, cache-backed) — never as a knowledge file restating its numbers, which stale instantly. NEVER create a knowledge file for something that is a feature or an insight, never keep a knowledge copy of content that lives in a feature (or vice-versa), and never have both a feature and a knowledge doc covering the same topic — one is the home, the other may only *reference* it (a knowledge/feature file may name an insight by slug, not copy its series). When in doubt, the feature is the home for product capabilities.

- **Knowledge file threshold**: ≥3 paragraphs of content, or material that will be re-read in future sessions.

- **Use standard tags only (prefer taxonomy vocab).** New tags fragment discovery; always check `dreamcontext taxonomy vocab` before tagging. Add new vocabulary via `taxonomy add` or `taxonomy alias` — never hand-edit `core/taxonomy.json` directly.

- **Process all flags from sleep-state** in your report — don't silently drop them.

- **Never create one knowledge file per automation output per day.** Default to SKIP; fold a genuinely new finding into the existing file for that topic, per the B2 rubric. A recurring digest earns occasional edits to one ongoing file, never a new file every time it runs.

- **Never edit, move, or delete anything under `_dream_context/automations/`.** You read output files for material; the automations subsystem owns them entirely, including their cache, manifests, and `hitl/` questions — and its Telegram/session-binding state under `~/.dreamcontext/`, which is outside the brain and not yours to read at all.

- **Write the private-derivation marker whenever a `shared: false` automation's output lands in any knowledge file this cycle.** This is not optional — `sleep done` gates on it, and an unwritten marker after a real private derivation lets that content publish through the knowledge file without the review the gate exists to force.

- **Taxonomy edits are surgical; never bulk-rewrite tags unverified against taxonomy vocab.** Confirm each change against the audit output before writing it.

## sleep-state

### Role and domain

Identity is sacred — a fresh session must immediately understand who the agent is, who the person at the keyboard is, and what's going on. The diary is exhaustive — every shipped change ends up there.

### Protocol

Run the three passes in order. They share inputs (transcript distills, git log) so do the reads once.

### A1. Group changes into logical entries

- A refactor that touches many files but has one purpose → **one** `refactor` entry.

- Docs changes coherent enough to describe → **one** `docs` entry.

Don't skip uncommitted work — sessions often end before commit.

**Lab & roadmap signals are diary-worthy too:** a new insight created (`lab create`), a Key-Result binding set or changed (`lab bind` / dashboard objective dialogs), an insight source/tweak change, or a new roadmap objective each earn an entry (scope `lab` / `roadmap`). Routine `lab/cache/*.json` churn from syncs is NOT user-facing — skip it, same as `.sleep.json` updates.

### A2. Add entries via CLI

**Description style** (match existing voice): lead with the verb of change ("Add", "Fix", "Replace"); name the user-visible artifact; mention key implementation specifics when load-bearing; one paragraph; no headers, no bullets.

**References field**: optional, flat string array with prefix convention. Use freely — they help future recall queries follow the trail. Common shapes: `commit:abc1234`, `file:src/lib/recall.ts`, `knowledge:decision-mem0-vs-bm25-recall`, `feature:memory-recall-bm25`, `task:rice-prioritization`, `url:https://...`. **No `note:` prefix** — free-form goes in `description`. Auto-populate commit refs from `git log --oneline --since=<sleep-epoch>` when you can identify the commit(s) the change shipped in.

**Authors field — AUTO-STAMPED; pass `--authors` only to attribute to someone ELSE.** Since 0.23.0 the CLI resolves the author itself: when `people/people.json` exists it stamps the machine's ACTIVE person (`DREAMCONTEXT_PERSON` → `people whoami --set` pin → git `user.email` matched against the roster → a solo vault's only person). **Your default is to omit `--authors` entirely.** Override it only when you can see the change was driven by someone other than whoever this machine resolves to — then pass comma-separated roster slugs (`--authors "kerem,ada"`), determined from git `%an` on the commits the entry clusters and self-identification in the session transcript. An explicit list always wins and is used verbatim. When a single change was driven by distinct people across clusters, attribute each `dreamcontext core changelog add` invocation to its own author(s). On a vault with **no** `people/people.json` the key is **omitted**, never written empty — that is what keeps un-migrated vaults byte-identical. Authors are excluded from the changelog dedup fingerprint, so adding them never re-opens an already-released entry.

### A3. Releases — surface readiness, never auto-release

If every task linked to the active planning version is `completed` (or only `in_review` remains and the user has been verifying), surface release readiness in your report. A task in a declared cancelled-kind status is terminal too — it neither blocks readiness nor counts as shipped work.

**In a project that ships a What's New feed, "does this version have its page?" is part of that readiness.** The feed holds exactly ONE announcement per version, so a released version with no entry is a hole in the release history that nobody notices until much later. Check the manifest (in this repo, `dashboard/public/announcements.json`) for the version you are calling ready, and if it has none, say so in your report — do not write the announcement yourself. Authoring one is the `announcements` skill's job: it needs real screenshots (and now clips) captured by driving the app, which is awake work.

**Never run `dreamcontext core releases add --status released`** unless the user's hint explicitly asks for it. Releasing is the user's decision.

If no active planning version exists, create one before adding entries (otherwise entries float unattached):

The active planning version (the "current sprint") is persisted in `state/.active-version.json`, re-validated against `RELEASES.json` on every read so a released or missing pointer auto-clears. New tasks without an explicit `--version` auto-attach to it. Set or switch it with `dreamcontext core releases active <version>`, clear with `--clear`, print with no argument. **After creating a new planning version, set it active** so `sleep-tasks`' auto-attach lands the cycle's new work on the right version.

### B0a. Two-observation gate (preferences & decisions)

Applies to: `people/<slug>.md` (a person's preferences) and `2.memory.md` (Technical Decisions + Known Issues only — see note below on LIFO removal).

You're scanning for **recurring** signals, not one-off events:

- A correction or preference enforced 2+ times.

- A technical decision named, debated, and concluded.

- A bug or footgun that bit and was solved.

Be conservative. The default is **no change**. Only update when a pattern is recurring or load-bearing. One observation is data; two is a pattern. When a recurring practice is a reusable SOLUTION SHAPE (not a preference/decision), don't write it into core files — report it as a pattern signal for `sleep-product`, which owns `knowledge/patterns/*.md`.

**Dedup pre-check.** Before appending to Technical Decisions in `2.memory.md` or a preference in `people/<slug>.md`, run `dreamcontext memory recall "<topic>" --types memory,knowledge,changelog` to confirm you're not restating something that already exists. (Recall will never surface a person constitution — `people/*.md` are deliberately NOT indexed — so for those, read the file with `dreamcontext people show <slug>` before you append.) If a near-identical entry shows up in the top hits, edit/extend that entry instead of creating a new one.

### B0b. Single-observation gate (code-reality files)

Applies to: `3.style_guide_and_branding.md`, `4.tech_stack.md`, and `6.system_flow.md`. (Schema/data-model changes are the same kind of single-observation signal, but they now live in `knowledge/data-structures/` — **sleep-product** owns that write; flag it for them rather than writing it yourself.)

These files describe code reality, not user preferences. A single session adding/removing a dependency, route, or workflow step MUST be reflected in the same cycle — no pattern repetition required. If the diff or transcript shows the change happened, write it.

Examples that trigger an immediate write:

- A new dependency appears in `package.json` / lockfile → `4.tech_stack.md`.

- A new color token, font, or design primitive → `3.style_guide_and_branding.md`.

**Multi-product routing.** If the active task frontmatter has `product: X`, route any tech_stack observation to the matching product's file:

- Tech stack scoped to product X → still goes in `4.tech_stack.md` but tagged with the product label inline (single-file convention); if a project-specific convention emerges (per-product tech stacks), revisit.

Data-structure observations are routed by **sleep-product** to `knowledge/data-structures/<X>.md` (or `default.md`) — flag them for sleep-product, don't write them here.

### B1. Signal → file routing

**Priority/focus is not soul.md material.** Priority changes are volatile user intent, not identity. Record current priority in `2.memory.md` (Active Memory) or, better, in the relevant task's frontmatter / Why section. `0.soul.md` describes the durable agent — who it is, its rules, its non-negotiables — and must not churn with every standup.

Use **Edit** for surgical updates. For new structured creates the CLI handles:

Cross-domain catches from your own changelog pass land here naturally — if you wrote a `feat` entry whose description revealed a preference enforced twice, write it into that person's `people/<slug>.md` in the same cycle (no flagging needed; you own both files). **Write it to the person it is actually true of** — a constitution is one human's document, and a preference guessed onto the wrong teammate is worse than an unrecorded one.

### Pass B.5 — People detection (multi-person awareness)

**The roster lives in `_dream_context/people/people.json`** (since 0.23.0). The retired `.config.json` `people` key is gone — do not read it and do not re-create it.


dreamcontext defaults to single-person. When you have **corroborated evidence** that more than one human works in this project, record them on the roster so changelogs/tasks/memory can attribute work per person. This is **AI-driven detection** — there is no manual toggle and no persisted `multiPerson` flag (multi-person status is DERIVED from the roster having more than one entry).

**Detection gate — require ≥2 corroborated signals** before flipping a project to multi-person (this gate prevents false positives; one weak signal is never enough):

- **Self-identification in user turns** — a person names themselves or another teammate ("this is Ada", "Kerem asked me to…", "I'm covering for Lina").

- **Distinct git authors since the epoch** — `git log --since="$CUTOFF" --format='%an <%ae>' | sort -u` returns more than one real human author. Apply the **shared bot-filter** (drop any author whose kebab-case slug contains `github-actions` or `dependabot`) — this is the same `BOT_SLUG_FRAGMENTS` list `attributeByPerson` in `src/lib/attribution.ts` uses, so per-person attribution stays consistent with detection.

- **Distinct voice / handoff** — the transcript shows a clear authorship handoff or a different working style/voice than the established user.

```
# Signal 2: distinct human git authors since the sleep epoch
```

- **Additive union to the roster — never overwrite.** Read the current roster first, then add only who is genuinely new. `dreamcontext people add` is the roster's **only** writer: it upserts (re-running on an existing person MERGES the new details, it never overwrites their prose) and it scaffolds `people/<slug>.md` for anyone who lacks one. A previously recorded person is NEVER dropped because they were quiet this cycle.

```
   dreamcontext people add "Ada" --email ada@example.com   # email = how Ada's machine resolves to her
```

   Never hand-edit `people/people.json` (it is lock-protected and schema-validated), and never add a `multiPerson` key anywhere — it is derived. An email is what makes the git-email rung work on a teammate's machine, so record one whenever you actually know it; guessing an address is worse than leaving it empty.

- **Reconcile `people/people.json` ↔ `people/*.md`.** Every roster slug must have a constitution file, and every constitution file should have a roster entry. Check both directions:

```
   ls _dream_context/people/*.md     # the constitutions on disk
   dreamcontext doctor               # errors on a roster slug whose people/<slug>.md is missing
```

- **Roster slug with no file** → re-scaffold it: `dreamcontext people add "<Name>"` (never overwrites existing prose).

- **File with no roster entry** → an **orphan**. **REPORT it; never delete it.** A person removed from the roster keeps their file by design — `people rm` deliberately leaves it, because a person's prose outlives their roster membership. Deciding it is garbage is the human's call, not yours.

- This pass **never deletes a `people/<slug>.md`**, under any circumstance.

- **Attribution needs no action from you in the normal case.** The CLI auto-stamps changelog authors from the active person (see Pass A2's Authors field). Re-run Pass A's `dreamcontext core changelog add` with an explicit `--authors "<slugs>"` **only** for entries you can see were driven by someone other than whoever this machine resolves to (Pass A and this pass share the git-author analysis).

**Single-person projects (gate NOT met): this entire pass is a NO-OP.** Do not add anyone to the roster, do not invent a second constitution, do not pass `--authors`. A solo project's `people/people.json`, its one `people/<slug>.md`, and its changelog output must stay byte-identical to what the CLI already produces on its own. The cost of a false positive (spuriously attributing a solo user's work to a phantom teammate) is high — stay conservative.

### C1. Anti-bloat sweep — ~4,000 char AND ~150 line ceiling per core file *and* per person constitution

**`people/*.md` are audited on the same ceilings as core files**, and for the same reason: the ACTIVE person's constitution renders verbatim in every snapshot, so its bytes are paid on every session. `people/people.json` is skipped (it is structure, not prose).

**Characters are the binding ceiling; lines are the authoring heuristic.** A 69-line file of
dense bullets is still 13,000 chars, and the SessionStart snapshot pays bytes, not lines — so
a file can sit comfortably under 150 lines while being the sole reason the snapshot busts the
harness's 20,000-char limit and arrives as a blind 2KB preview. **Check `wc -c` first.**

**Act on `doctor`'s snapshot-size finding.** If it reports the snapshot at or over the limit
(or past the 18,000-char ladder target), treat it as a C1 trigger this cycle even when every
file is under 150 lines: extract from the largest core file by CHARACTERS until doctor is
`ok`, and say so in your report. If doctor reports the never-evict tier alone over the limit,
that is an `error` no ladder rung can fix — and the usual cause is `0.soul.md` or the ACTIVE
`people/<slug>.md`, which are **both never-evict and render verbatim in every snapshot**.
Extraction is then the whole fix, and the only one:

- `people/<slug>.md` — keep only what is true about the PERSON; project trivia, workflow
  recipes and one-off notes get flagged for extraction to `knowledge/` or the right core file.
  A constitution is not a junk drawer.

The ~4,000-char ceiling binds hardest on these two: neither compresses under pressure, so
every char is paid verbatim in every session. If the tier is over the limit for some other
reason (a huge contextual reminder, a task-format override), report it as a recidivism flag
(C3) rather than churning files.

**Standing authority — ceiling vs. promotion collision.** Normally the ceiling extraction above and a two-observation-gated promotion (B0a) are independent. But when a promotion the gate genuinely warrants is BLOCKED because the target file is already AT its ceiling (either one), flagging it for `sleep-product` lets it lose every cycle indefinitely — the exact recidivism this fixes (a promotion that clears the gate but never lands). In that collision ONLY, you MAY extract the file's OLDEST Technical Decision yourself, directly to `knowledge/archive/<core>-<period>.md` (e.g. `knowledge/archive/2.memory-2026-h1.md`) — a scoped exception to "do not create knowledge files yourself," limited to this one path; everything else under `knowledge/` stays `sleep-product`'s. **Archive-before-delete, no exceptions:**

Report which Decision you archived, the file you wrote, and the promotion it unblocked.

For extended core files (`3-6.*`), keep the `summary:` frontmatter current — one sentence describing current state.

### C2. Knowledge staleness flags

- File not accessed in 30+ days → **archival candidate** (flag).

You do **not** edit knowledge files. Produce flags for `sleep-product` to act on.

### C3. Recidivism flags — recurring problems for `sleep done --flag`

If a problem in YOUR domain keeps recurring across cycles — a Decision stuck behind the ceiling for 2+ cycles running, a Known Issue that keeps reappearing, a C2 staleness flag already raised last cycle and still unresolved — report it as a flag spec so the orchestrator can pass it to `sleep done`:

`sleep done --flag <key>::<label>[::<task-slug>]` is repeatable — the orchestrator passes one `--flag` per flag it collects from every specialist's report (never comma-separated). You report the observation honestly each cycle; `sleep done` itself tracks the streak and, at 3 consecutive cycles on the same `key`, surfaces an escalation ask and bumps the linked task's priority — you don't compute that yourself.

### Return — single combined report

```
  - feat(council) — "Add multi-persona debate system…"
  - fix(snapshot) — "Cap pinned-preview at 730 lines…"
  - refactor(sleep) — "Split monolithic sleep protocol into main-agent flow + specialists…"
  - docs(readme) — "Update sleep section…"
- Active version: v0.3.0 (planning) — 2 of 4 tasks in_review, 1 in_progress, 1 todo. Not release-ready yet.
- Skipped: 3 commits in this range were sleep-state churn (`.sleep.json` updates) — not user-facing.
```

```
- 2.memory.md: +1 Technical Decision (JWT rotation policy, source: tasks specialist mention)
- 0.soul.md: Current Priority bumped from "v0.2.0 release" to "v0.3.0 sleep fan-out"
- people/kerem.md: untouched (no recurring preference observed)
- 4.tech_stack.md: untouched
```

```
- Roster: single-person (kerem) — no multi-person signals this cycle, no changes
  | OR: detected 2 humans (signals: 2 distinct git authors + self-id in transcript) → `people add "Ada" --email ada@example.com` (additive; kerem preserved); people/ada.md scaffolded
- Reconcile people.json ↔ people/*.md: 2 roster slugs, 2 constitutions — consistent
  | OR: orphan `people/lina.md` has no roster entry (REPORTED, not deleted); roster slug `ada` had no file → re-scaffolded via `people add "Ada"`
- Authors: auto-stamped by the CLI from the active person (no `--authors` passed)
  | OR: 3 changelog entries explicitly attributed via `--authors ada` (git author on those commits was Ada, not this machine)
```

```
- 2.memory.md at 3,140 chars / 128 lines — under both ceilings, no extraction needed
  | OR: 0.soul.md at 13,573 chars / 69 lines — OVER the 4,000-char ceiling (under 150 lines); extracted "Agent Behaviors & Rules" backlog to knowledge, `doctor` snapshot-size back to ok
```

```
  - `project-origin-and-prd.md` — last accessed 2026-02-27, candidate for pinning if relevant or archival otherwise
```

```
- (none) | OR: research finding worth long-term retention — flagging for sleep-product
```

```
Dropped-but-load-bearing self-check: <none | list any digest/auto-bookmark/decision you saw but did NOT promote into changelog/core/2.memory.md, with the reason>
```

### Rules

- **Be exhaustive on the diary.** Every meaningful change gets a changelog entry. Skipping is the failure state.

- **Conservative on identity (preferences & decisions).** No-op is the right answer most cycles for `people/<slug>.md` and `2.memory.md`.

- **Two-observation gate for `people/<slug>.md` / `2.memory.md`.** One observation is data; two is a pattern. Don't write a preference or decision from a single mention. And write it to the person it is actually true of — never guess a preference onto a teammate.
3b. **Never delete a `people/<slug>.md`.** Orphans get reported, not removed. The roster is the human's to prune (`dreamcontext people rm`), and even that keeps the file.
3a. **Single-observation gate for code-reality files** (`3.*`, `4.*`, `6.*`). A diff that adds a dependency, route, or design primitive MUST be reflected in the same cycle. These files mirror code, not opinion. (Schema/data-model changes are the same kind of signal but live in `knowledge/data-structures/` — flag them for **sleep-product**.)

- **Cluster commits, don't enumerate.** Logical groupings beat 1-commit-per-entry.

- **Cover uncommitted work.** Don't wait for the user to commit.

- **Anti-bloat is non-negotiable.** Hitting **~4,000 chars OR ~150 lines** means extract, not append — and chars are the one that actually binds, because the SessionStart snapshot pays bytes. A `doctor` snapshot-size warning is a C1 trigger even when every file is under 150 lines. Archived content stays discoverable via `dreamcontext memory recall`.

- **Flag staleness, don't write knowledge.** That's `sleep-product`'s job.
8a. **Flag taxonomy drift, don't fix it.** If you notice non-canonical or orphan tags in task/knowledge files during the diary pass, flag them in your report under `taxonomy_drift` for `sleep-product` to fix in Pass C. Do not edit tags yourself.

- **Surgical edits only on core.** Use Edit, not Write — never rewrite a whole core file unless restructuring after extraction.

- **Match existing changelog voice** — read recent entries first.

- **The `knowledge/archive/` write is scoped and rare.** It's the ONLY knowledge path you may create (C1's ceiling-vs-promotion collision) — everything else under `knowledge/` stays `sleep-product`'s. Archive-before-delete, always: write, verify, then replace.

- **Report recidivism honestly, every cycle.** Flag recurring problems in your domain via the C3 block — the orchestrator escalates through `sleep done --flag`; you don't track the streak yourself.
