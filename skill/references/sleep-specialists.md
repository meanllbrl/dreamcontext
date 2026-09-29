# Sleep specialists: rationale and long-form notes

The three large sleep agents (`sleep-tasks`, `sleep-product`, `sleep-state`) carry only their contract: domain, inputs, protocol steps, report shape and rules. This file keeps the reasoning behind those rules and the edge cases the agent files do not spell out, grouped by agent and by the protocol step they explain. Dated incidents and the history of each rule live in `_dream_context/knowledge/features/sleep-fanout-architecture.md` § "Specialist prompt history".

**The agent file is authoritative.** This file explains; it does not add rules. When it and an agent disagree, the agent wins and this file is stale. Read only the section for the agent you are, and only when a rule's edge case is unclear.

## sleep-tasks

### Inputs you'll receive

**Why hands-off tasks exist.** Those slugs belong to a session the user is working in RIGHT NOW. A file lock stops two writers corrupting one file; it cannot stop you overwriting a decision the user made thirty seconds ago with a conclusion you drew from a transcript that predates it. Not even to "just fix the status". Reporting the one line you WOULD have written lets the next cycle pick it up; everything else on the board is yours as usual.

### 1. Read what happened

**Why oldest to newest.** The brief lists sessions in `stopped_at` order for exactly this reason. A cycle often spans a conversation that changed its mind ("let's build X" in one session, "actually, drop X" in the next), and reading sessions independently makes the cycle file the first one's idea after the second one killed it. An earlier session's "done" cannot close a task a later session reopened. When the user dropped work that never had a task, an awake agent should also have recorded it, which is why `tasks declined` is read once per cycle: recognise those ideas before you re-derive them from an older transcript.

### 2. Map sessions → tasks

**Why a board map and not a recall.** A recall only surfaces what you thought to search for, which is precisely how a sub-slice of an existing task gets filed as a new one: nobody searched the phrase the existing task happens to use. Hold the map for the whole pass and re-read it rather than re-running the query per candidate.

**Why fold in by default.** Duplicate tasks, and tasks that are really just a smaller slice of one that already exists, are the #1 consolidation failure mode. A "much smaller piece" of an existing task is **never** its own task. When the scope grew, broaden the title and `## Why` so the header reflects the wider scope; don't leave a stale, too-narrow title with the new work buried only in the changelog. Renaming the slug/`name:` is usually unnecessary and breaks links. Sub-tasks (`parent_task`) exist for an epic that legitimately splits into separable deliverables, not for a slice that fits as a user story or criterion. Untracked, genuinely-separate work is invisible to future sessions, so always link it; a smaller slice belongs *inside* the task it extends.

### Lands in THIS project?

Work gets **discussed** here that does not **belong** here: a connected vault's feature, a teammate's repo, a person who is not on this roster. The conversation happened in this session, so the evidence looks local, and the cycle files a task this project will never do. That task then costs every future session snapshot tokens and makes the board something to be cleaned. Never file a local task for a connected vault's work "so we don't forget": that is the duplicate. Reporting it under "Out of scope" means nothing is silently dropped.

### The filing bar — clear ALL of it, or do not file

**Why the bar is strict.** Filing a task nobody asked for and nobody will do is the exact opposite of what consolidation is for: it makes the board something to be cleaned rather than something to be trusted. The audit that set this bar is recorded in `sleep-fanout-architecture.md`.

- **User, friction, cost.** If you cannot say who is hurt and what it costs them, you do not yet have a task. The format is not the point, the evidence is.
- **Tombstones and declined ideas.** A slug on the tombstone list was consolidated away ON PURPOSE; the CLI refuses it anyway. A topic on the DECLINED list is one a human said no to while awake; it never became a task, so there is nothing to log on.
- **CLI refusals.** Lines 1 to 4 are your judgement; two of them are also checked mechanically, so a create can come back refused even when you believe it cleared the bar. The review-band refusal means the nearest task is close enough to be worth your eyes, not close enough to decide for you. Naming the neighbor with `--neighbor-checked` is the proof you looked; guessing the flag past a real duplicate is the failure this gate exists to stop, and a duplicate filed behind either flag is worse than the refusal because it now looks reviewed. A declined-idea match prints that idea's topic, date and reason.
- **`neighbor check skipped`.** The semantic floor is off when there is no embedding index, no model, or it was disabled. Nothing was verified for you.

**Why discussion defers.** Even with every gate clear, WHEN to file is a separate question. A conversation is not a commitment, and a task filed from one is the wrong-task failure the owner reported. Deferring keeps it without committing to it: the key must be **stable across cycles** or the repetition that is supposed to build confidence never registers, and a candidate you do not re-emit is simply dropped, which is the correct outcome for a passing remark.

**Why the cap names every unfiled candidate.** Going over is not possible (`tasks create` refuses), so the decision that matters is WHICH ones. The next cycle, or the owner, should be able to pick up whatever you did not file.

**Creating.** The orchestrator should already have ensured an active planning version; verify it. The file slug derives from the task name. `--by sleep` names you as the filer, but the bar applies either way: a live sleep lock is the evidence, not the flag. The `-w` should be far longer than the 40-character floor; padding to get over it produces exactly the unreadable task the bar exists to prevent.

### 2.5. Person attribution (multi-person projects only)

The retired `.config.json` `people` key is gone since 0.23.0; do not read it. A tag naming a slug that is not on the roster resolves to nobody, so `dreamcontext people list` is the source of truth for which slugs exist (e.g. `person:kerem`, `person:ada`). Attribution uses the same signals sleep-state uses for Pass B.5, and the bot-filter list is consumed by `attributeByPerson`. `tasks create --person <name>` injects the `person:<slug>` tag automatically. A person quiet this cycle keeps their tag: they remain attributed for prior work. Derived multi-person status comes from `people.length > 1`; there is no `multiPerson` key to check.

On a **remote backend** (ClickUp/GitHub), an unmapped `person:<slug>` is NOT silently dropped: the push path records a `SyncReport.warnings[]` entry surfaced loudly in `tasks sync` / `sleep done`. Noting a doubtful slug in your report keeps that warning from being lost.

### 3. Log progress AND reconcile the body — both required

**Why the body must move.** If the user pivoted mid-session ("we're skipping phase 1", "dropping the offline requirement", "switching the auth approach"), the body must reflect the new plan, not the old one with a buried changelog note. A fresh session opening this task file should see the *current plan*.

**Override edge cases.** Custom field values sync to ClickUp/GitHub. A declared status lives UNDER a shipped status; your briefing lists each with its kind. A cancelled-kind status leaves every progress count and is never live, which is why superseded work goes there instead of the `in_review "confirm close"` fallback, which exists only for projects without one. There is no user in a sleep cycle, so an unset `ask` field stays unset and is named so the user fills it next session: inventing a value to satisfy a `required` gate corrupts the data.

**Dates.** Both fields are `YYYY-MM-DD|null`. Reaching `completed` also stamps `start_date` when the task was closed without ever being started. Moving a start past its due date reschedules that due date (the window's length is preserved), so a start>due range should never exist. Backlog and dates are mutually exclusive: don't set a date on a backlog item without removing the tag.

**Recall before reconciling.** Unsure whether a decision was already captured (memory entry, sibling task, knowledge file)? `dreamcontext memory recall "<topic>"` is cheaper than grep, deterministic, and avoids duplicating a decision that already lives in `2.memory.md` (which `sleep-state` owns).

### 4. Status — review only when genuinely needed

The `completed` vs `in_review` call is the one genuinely judgment-heavy decision in this cycle: reason through the specific task's risk, reviewability, and whether any criterion is mechanically unproven, rather than pattern-matching on surface cues. Bumping everything to `in_review` buries the few tasks that actually need the user's eyes under a pile that didn't, and leaves finished work rotting half-closed. Only the never-done categories (superseded / abandoned / obsoleted) ever go to `in_review` *for closing*: that hands the user a close decision, not a completion.

**Foreign tasks.** A foreign task comes from a SHARED remote container (a ClickUp list two projects both sync). When in doubt, leave the native task as-is. A shared list is a data hazard: surface it (`dreamcontext doctor` warns when two registered projects share one list) rather than silently trusting it. The incident behind this rule is in `sleep-fanout-architecture.md`.

### 5. Version readiness signal (no auto-release)

Run it after bumping statuses, comparing the version's task list to current statuses.

### 6. Backlog grooming — the active list must stay honest

A backlog nobody has touched in weeks, or that still describes a plan we've since pivoted away from, isn't "active": it bloats every SessionStart snapshot and buries the work that actually matters. There is no status-time version verb, which is why a moved milestone is fixed by editing `version:`. A `high` task untouched for a month is not high priority. Work done but never logged is a capture failure: fix it.

**Tags** drive recall: a well-tagged backlog is found; a poorly-tagged one is re-derived blind.

**Objectives** are the PO's OKR roadmap items, linked many-to-many. Several slugs on one task is expected when it lifts several outcomes (e.g. revenue AND retention), not double-counting. Don't force a link. Rollups and forecasts recompute when the orchestrator runs `dreamcontext roadmap` after your report.

**Recidivism.** Emitting another flag for a problem already at the threshold is the exact failure step (e) closes (`fix-releases-add-auto-discovery-scoping-bug` recurred 5× and stayed `todo`). At 3 consecutive cycles `sleep done` itself surfaces the escalation ask and bumps the linked task's priority. A `task-candidate:` flag carries no task slug and never escalates, because there is no task to bump and nobody to hand an ask to. Confidence by repetition means the streak has to be real, which is why only an independent re-observation counts.

**Key Results.** Observed values may come from the transcript, a file, or a connected system (e.g. MRR moved to $1,250, active users hit 400); the board regen at the end of sleep reflects them. An insight-fed objective is *measured*, not asserted: `lab bind` seeded, and every `lab sync` rewrites, its `metric.current`, one feeder max per objective. Your number would be overwritten at the next sync and blurs measured-vs-asserted provenance. A stale feeder shows an old `fetchedAt` or an `error` in `dreamcontext lab show <slug>`. Sleep never syncs because of credential exposure, latency and non-determinism: refreshing is always an explicit user/agent action outside sleep.

A cancelled-kind status is terminal without claiming completion; otherwise `in_review` with an explicit reason hands the close decision to the user.

### Return — short report

A filled line looks like: `Updated: fix-login-redirect (in_progress → completed, "done, validated, no review needed")`. The self-check exists because a refusal you don't report is a candidate nobody can pick up.

## sleep-product

### When you fire

The automation-output signal fires you alone because most cycles are the only chance to fold that output in before it's forgotten.

### Your domain

Insights are their own recall-indexed entity, not knowledge. The roadmap board is regenerated by the orchestrator each sleep. Automation outputs are read through `pendingOutputsSince`'s file list.

**Patterns.** Pattern *content* is not yours to change on a user correction: the prompt hook instructs the awake agent to update it in the task where it was said. `dreamcontext patterns sync` keeps the generated `/pattern-*` entries matching the vault, so a retired pattern must not keep a live `/` entry. A pattern's own filename and H1 ARE its triggers, which is why it is named after the thing a user would SAY, not after the code.

### Protocol

The features pass goes first because it research-grounds the PRD against the task files and code; the knowledge pass then captures cross-cutting findings and processes staleness flags. Don't read all sessions if only one had research. A cross-cutting finding from your own features pass is captured inline: you own both domains this cycle.

### A4. Create a new PRD from scratch

Criteria may be written down anywhere (task body, conversation summary, sleep notes). A placeholder criteria line applies especially when A4 fires on a sparse signal (the user said "we should add X" without spelling out behaviour); the next session fills it in. Look at existing PRDs for shape. `## Why` covers motivation, the problem it solves, who benefits; `## Constraints & Decisions` covers anything non-obvious that constrains the design. Never hallucinate criteria to fill the section: the PRD's value is current truth.

### A5. Multi-product awareness

Features stay in one flat directory (typed knowledge); `product: X` lets dashboard/CLI filters route them. Per-product knowledge wins when the content is product-specific; global knowledge wins for cross-cutting topics.

### B0. Organize — folders, grouping, and placement

`buildKnowledgeIndex` globs `**/*.md`, so grouping a file never hides it. Diagrams are NOT a segregated top-level dump: a canonical board lives with the context it illustrates (architecture, flows, roadmaps a future session should recall), and when you group a context that has a board, move the board too so the folder tells one story. `apply-diagrams` does flat to per-title, not context-grouping, and prints "nothing to organize" when clean. Scratch/exploratory boards in `inbox/` or `workspace/` are dark by location (not indexed): do NOT pull them into knowledge. `knowledge move` rewrites inbound `[[old-slug]]` references on the target token only (`|alias` and `#anchor` preserved). Grouping mirrors the existing `data-structures/` and `products/` subfolders and is a structural op, gated exactly like merge-with-delete; group only on a **sharp** topical boundary, the same B2 test applied to folders, and don't fragment (one folder per file).

### B1. Decide: create, update, archive, or pin

A stale-archival candidate is appended to a top-level `archive/` knowledge file or marked `archived: true`, per project convention.

### B1.5. Depth gating — what you may actually DO this cycle

Tag every action you are about to take. A flagged merge is handled by the next deep cycle or by the user via `sleep start --deep` / desktop Sleep. The dated archive copy is the recovery net; the "Dropped-but-load-bearing self-check" report line is the audit signal. Both are required for every destructive op.

### B2. Create vs. extend — the consolidation rubric

**A knowledge file is a tag-able identity, not a dumping ground.** Fragmenting one topic across many near-duplicate slugs makes tags noisy and recall worse; cramming unrelated topics into one super-file makes tags meaningless. Pick the boundary on purpose.

**Why semantic dedup first.** Keyword recall only finds files you thought to search for, the exact keyword fragility this project keeps hitting. `dreamcontext embed dedup` embeds the candidate and returns its closest existing knowledge+feature docs by meaning, with cosine similarity and a verdict; MERGE means decisively closer than the runner-up. `--if-present` never triggers a first-time model download during sleep. Semantic dedup is an ASSIST, not a replacement, especially for CREATE/REVIEW verdicts.

**Sharp vs soft.** Similar brands, similar verticals, similar topics belong together in the fewest files; a clean topical boundary earns its own slug so tagging stays valuable. Would a separate file make the tag set more discriminating, or just split one topic across two slugs? A **MERGE** verdict settles it (extend); **REVIEW** is where this rubric earns its keep. This is **not** "always make super-files": distinct topics MUST get distinct files, which is exactly what makes tags worth having.

### B3. Tags — use the taxonomy vocabulary

Bare standard tags remain valid fallbacks. New tags fragment search. The vocabulary is maintained in `core/taxonomy.json`; scaffold it with `dreamcontext taxonomy init` if missing.

### B6. Data structures (schemas / models / API contracts)

Schemas moved from `core/` to knowledge because they ARE domain knowledge: this gives them recall indexing, staleness flags, and the knowledge UI for free. Unlike most knowledge (which waits for repetition), a schema change needs no pattern repetition. The legacy dir move runs automatically on `dreamcontext sleep start`; the legacy files are left for the user to remove after confirming.

### B7. Automation output consumption

Automations write dated markdown files unattended, on their own schedule. Nobody reads them unless you do: this pass is that reading. The upstream caps skip an oversized file wholesale, never truncating it to fit, and every skip is named with a reason, so reporting `skipped` verbatim means nothing vanishes silently between the CLI and the user.

**Why SKIP by default.** A daily summary restating things the brain already has is not knowledge, and folding it in anyway is how a knowledge base drowns in noise. A daily digest running for a month must not produce thirty knowledge files: it produces zero new files most days, and an edit to one ongoing file on the days it actually finds something new.

**Why private outputs carry the marker.** `shared: false` (the default) keeps an automation's manifest and output off the team's remote, but you read the local filesystem, not git. Knowledge files ARE synced regardless of any automation's sharing flag, so private content folded into one can be published through it even though the automation never left this machine. An absent marker means `sleep done` proceeds without asking; an unwritten marker after a real private derivation lets that content publish without the review the gate exists to force. One knowledge file may absorb findings from several private automations: list them all.

### Pass C — Taxonomy maintenance

`audit --fix` resolves via `normalizeTag → resolveAlias` (aliases like `db → domain:database`, casing like `Architecture → architecture`). It never churns an already-canonical tag (`decisions` is not rewritten to `decision`), and orphans are reported as *"needs a vocab decision"*. That is what makes corpus-wide normalization safe to run every cycle: it is verified-by-construction against the vocabulary, so there is no reason to hand-edit alias tags file by file.

### Return — single combined report

A filled Knowledge line: `Extended (no new file): knowledge/competitive-analysis-ecc.md, folded the new ECC pricing finding into the existing file (soft distinction, same topic family) instead of forking a near-duplicate slug`.

### Rules

PRDs for buildable concepts are created because they will be lost otherwise. A knowledge file restating a Lab insight's numbers goes stale instantly; a knowledge or feature file may name an insight by slug, never copy its series. A long `description` is a card/index summary, not a table of contents.

## sleep-state

### Role and domain

Identity is sacred: a fresh session must immediately understand who the agent is, who the person at the keyboard is, and what's going on. The diary is exhaustive: every shipped change ends up there. The passes share inputs (transcript distills, git log), so do the reads once.

### A1. Group changes into logical entries

Sessions often end before commit, which is why uncommitted work counts. Coherent docs changes get one `docs` entry; a many-file refactor with one purpose gets one `refactor` entry.

### A2. Add entries via CLI

**Description**: mention key implementation specifics when load-bearing; no headers, no bullets. **Summary**: the CLI warns above 200 chars and never rejects; the snapshot prefers `summary` over `description` for the Recent Changelog section. **References** help future recall queries follow the trail (e.g. `knowledge:decision-mem0-vs-bm25-recall`, `feature:memory-recall-bm25`); free-form goes in `description`. **Supersedes** disambiguators only matter when multiple entries share the same date+scope, in which case fall back to the position-from-top index.

**Authors.** The CLI resolves the author itself: `DREAMCONTEXT_PERSON` → `people whoami --set` pin → git `user.email` matched against the roster → a solo vault's only person. An explicit `--authors` list always wins and is used verbatim. Omitting the key on a vault with no `people/people.json` is what keeps un-migrated vaults byte-identical. Authors are excluded from the changelog dedup fingerprint, so adding them never re-opens an already-released entry.

### A3. Releases — surface readiness, never auto-release

A released version with no What's New entry is a hole in the release history that nobody notices until much later. Authoring one needs real screenshots (and clips) captured by driving the app, which is awake work. Releasing is the user's decision.

The active planning version (the "current sprint") is persisted in `state/.active-version.json` and re-validated against `RELEASES.json` on every read, so a released or missing pointer auto-clears. New tasks without an explicit `--version` auto-attach to it; entries without one float unattached. Clear it with `--clear`, print it with no argument.

### B0a. Two-observation gate (preferences & decisions)

Only update when a pattern is recurring or load-bearing. Technical Decisions are long-lived architectural choices referenced repeatedly; Known Issues are open bugs/footguns. Recall will never surface a person constitution because `people/*.md` are deliberately NOT indexed.

### B0b. Single-observation gate (code-reality files)

These files describe code reality, not user preferences: if the diff or transcript shows the change happened, write it. If a per-product tech-stack convention emerges, revisit the single-file convention.

### B1. Signal → file routing

Priority changes are volatile user intent, not identity: `0.soul.md` describes the durable agent (who it is, its rules, its non-negotiables) and must not churn with every standup. A constitution is one human's document, and a preference guessed onto the wrong teammate is worse than an unrecorded one.

### Pass B.5 — People detection (multi-person awareness)

**The roster lives in `_dream_context/people/people.json`** (since 0.23.0). The retired `.config.json` `people` key is gone: do not read it and do not re-create it. Detection is **AI-driven**, so changelogs, tasks and memory can attribute work per person once more than one human works here. The ≥2-signal gate prevents false positives; one weak signal is never enough. The git signal uses `'%an <%ae>'`; the shared bot-filter keeps per-person attribution consistent with detection. Examples of self-identification: "I'm covering for Lina".

`people/people.json` is lock-protected and schema-validated, and `multiPerson` is derived, never a key. An email is what makes the git-email rung work on a teammate's machine; guessing an address is worse than leaving it empty. A person removed from the roster keeps their file by design: `people rm` deliberately leaves it, because a person's prose outlives their roster membership, and deciding it is garbage is the human's call. Pass A and this pass share the git-author analysis.

The cost of a false positive (spuriously attributing a solo user's work to a phantom teammate) is high: stay conservative.

### C1. Anti-bloat sweep — ~4,000 char AND ~150 line ceiling per core file *and* per person constitution

**Why characters bind.** A 69-line file of dense bullets is still 13,000 chars, and the SessionStart snapshot pays bytes, not lines, so a file can sit comfortably under 150 lines while being the sole reason the snapshot busts the harness's 20,000-char limit and arrives as a blind 2KB preview. A never-evict tier over the limit is an `error` no ladder rung can fix. The ~4,000-char ceiling binds hardest on `0.soul.md` and the active constitution: neither compresses under pressure, so every char is paid verbatim in every session. A constitution is not a junk drawer.

**Why the ceiling-collision authority exists.** Normally ceiling extraction and a gated promotion are independent. But flagging a blocked promotion for `sleep-product` lets it lose every cycle indefinitely: the exact recidivism this fixes (a promotion that clears the gate but never lands).

The line ceiling tightened as `memory recall` learned to retrieve extracted content on demand; the character ceiling came later, when measurement showed line counts miss the real cost. The snapshot pre-loads only the freshest, most-cited entries; older context lives in knowledge files and stays findable via recall. (Version history: `sleep-fanout-architecture.md`.)

### C3. Recidivism flags — recurring problems for `sleep done --flag`

The orchestrator collects one `--flag` per flag from every specialist's report.

### Return — single combined report

A filled Roster line: `detected 2 humans (signals: 2 distinct git authors + self-id in transcript) → people add "Ada" --email ada@example.com (additive; kerem preserved)`.

### Rules

These files mirror code, not opinion. Decisions over deliberation: save the conclusion and rationale, drop the back-and-forth.
