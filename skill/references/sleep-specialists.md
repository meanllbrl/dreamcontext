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

**Why fold in by default.** Duplicate tasks, and tasks that are really just a smaller slice of one that already exists, are the #1 consolidation failure mode. A "much smaller piece" of an existing task is **never** its own task. When the scope grew, broaden the title and `## Why` so the header reflects the wider scope; don't leave a stale, too-narrow title with the new work buried only in the changelog. (Renaming the slug/`name:` is usually unnecessary and breaks links — only do it if the scope fundamentally changed identity.) Sub-tasks (`parent_task`) exist for an epic that legitimately splits into separable deliverables, not for a slice that fits as a user story or criterion. Untracked, genuinely-separate work is invisible to future sessions, so always link it; a smaller slice belongs *inside* the task it extends.

### Lands in THIS project?

Work gets **discussed** here that does not **belong** here: a connected vault's feature, a teammate's repo, a person who is not on this roster. The conversation happened in this session, so the evidence looks local, and the cycle files a task this project will never do. That task then costs every future session snapshot tokens and makes the board something to be cleaned. Never file a local task for a connected vault's work "so we don't forget": that is the duplicate. Reporting it under "Out of scope" means nothing is silently dropped.

### The filing bar — clear ALL of it, or do not file

**Why the bar is strict.** Filing a task nobody asked for and nobody will do is the exact opposite of what consolidation is for: it makes the board something to be cleaned rather than something to be trusted. The audit that set this bar is recorded in `sleep-fanout-architecture.md`.

- **User, friction, cost.** If you cannot say who is hurt and what it costs them, you do not yet have a task. The format is not the point, the evidence is.
- **Tombstones and declined ideas.** A slug on the tombstone list was consolidated away ON PURPOSE; the CLI refuses it anyway. A topic on the DECLINED list is one a human said no to while awake; it never became a task, so there is nothing to log on — do not re-file it, and if you believe the decision changed, say so in your report rather than filing (only an awake `dreamcontext tasks undecline <key>` lifts it).
- **CLI refusals.** Lines 1 to 4 are your judgement; two of them are also checked mechanically, so a create can come back refused even when you believe it cleared the bar. The review-band refusal means the nearest task is close enough to be worth your eyes, not close enough to decide for you. Naming the neighbor with `--neighbor-checked` is the proof you looked; guessing the flag past a real duplicate is the failure this gate exists to stop, and a duplicate filed behind either flag is worse than the refusal because it now looks reviewed. It *resembles* a declined idea — the message prints that idea's topic, date and reason.
- **If the CLI prints `neighbor check skipped`, the semantic floor is OFF this run** (no embedding index, no model, or it was disabled) and the message says so — it also tells you declined ideas were matched by **exact slug only**. Nothing was verified for you.

**Why discussion defers.** Even with every gate clear, WHEN to file is a separate question. A conversation is not a commitment, and a task filed from one is the wrong-task failure the owner reported. Deferring keeps it without committing to it: the key must be **stable across cycles** or the repetition that is supposed to build confidence never registers, and a candidate you do not re-emit is simply dropped, which is the correct outcome for a passing remark. `sleep done` persists it, never escalates it (there is no task to escalate), and prints one `Deferred task candidates: n` line.

**Why the cap names every unfiled candidate.** Going over is not possible (`tasks create` refuses), so the decision that matters is WHICH ones. The next cycle, or the owner, should be able to pick up whatever you did not file.

**Creating.** The orchestrator should already have ensured an active planning version; verify it. The file slug derives from the task name. `--by sleep` names you as the filer, but the bar applies either way: a live sleep lock is the evidence, not the flag. The `-w` should be far longer than the 40-character floor; padding to get over it produces exactly the unreadable task the bar exists to prevent.

### 2.5. Person attribution (multi-person projects only)

The retired `.config.json` `people` key is gone since 0.23.0; do not read it. A tag naming a slug that is not on the roster resolves to nobody, so `dreamcontext people list` is the source of truth for which slugs exist (e.g. `person:kerem`, `person:ada`). Determine attribution from the same signals sleep-state uses for Pass B.5 (git `%an` on the commits, self-identification in the session transcript), applying the **shared bot-filter** — drop any author whose kebab-case slug contains `github-actions` or `dependabot` (the `BOT_SLUG_FRAGMENTS` list in `src/lib/attribution.ts`, consumed by `attributeByPerson`). `tasks create --person <name>` injects the `person:<slug>` tag automatically. A person quiet this cycle keeps their tag: they remain attributed for prior work. Derived multi-person status comes from `people.length > 1`; there is no `multiPerson` key to check.

On a **remote backend** (ClickUp/GitHub), an unmapped `person:<slug>` is NOT silently dropped: the push path records a `SyncReport.warnings[]` entry surfaced loudly in `tasks sync` / `sleep done`. Noting a doubtful slug in your report keeps that warning from being lost.

### 3. Log progress AND reconcile the body — both required

**Why the body must move.** If the user pivoted mid-session ("we're skipping phase 1", "dropping the offline requirement", "switching the auth approach"), the body must reflect the new plan, not the old one with a buried changelog note. A fresh session opening this task file should see the *current plan*.

**Override edge cases.** Custom field values sync to ClickUp/GitHub. The override may declare extra statuses (`statuses:` frontmatter — your briefing lists each with its kind and the shipped status it lives UNDER; `dreamcontext tasks statuses` prints the set). A cancelled-kind status leaves every progress count and is never live, which is why superseded work goes there instead of the `in_review "confirm close"` fallback, which exists only for projects without one. There is no user in a sleep cycle, so leave an unset `ask` field unset and name it in your report so the user fills it next session. Inventing a value to satisfy a `required` gate corrupts the data.

**Dates.** Tasks carry a `start_date`/`due_date` range in frontmatter (both `YYYY-MM-DD|null`). Reaching `completed` also stamps `start_date` when the task was closed without ever being started. Moving a start past its due date reschedules that due date (the window's length is preserved), so a start>due range should never exist. A task tagged `backlog` must have no dates, and a dated task must not be `backlog` (mutual exclusion) — don't set a date on a backlog item without removing the tag.

**Recall before reconciling.** If you're unsure whether a decision observed this session was already captured elsewhere (memory entry, sibling task, knowledge file), run `dreamcontext memory recall "<topic>"` to surface the top hits across the corpus before you edit. Recall is cheaper than grep, deterministic, and avoids duplicating a decision that already lives in `2.memory.md` (which `sleep-state` owns).

### 4. Status — review only when genuinely needed

The `completed` vs `in_review` call is the one genuinely judgment-heavy decision in this cycle: reason through the specific task's risk, reviewability, and whether any criterion is mechanically unproven, rather than pattern-matching on surface cues. Bumping everything to `in_review` buries the few tasks that actually need the user's eyes under a pile that didn't, and leaves finished work rotting half-closed. Only the never-done categories (superseded / abandoned / obsoleted) ever go to `in_review` *for closing*: that hands the user a close decision, not a completion.

**Foreign tasks.** A foreign task comes from a SHARED remote container (a ClickUp list two projects both sync). When in doubt, leave the native task as-is. A shared list is a data hazard: surface it (`dreamcontext doctor` warns when two registered projects share one list) rather than silently trusting it. The incident behind this rule is in `sleep-fanout-architecture.md`.

### 5. Version readiness signal (no auto-release)

Run it after bumping statuses, comparing the version's task list to current statuses.

### 6. Backlog grooming — the active list must stay honest

A backlog nobody has touched in weeks, or that still describes a plan we've since pivoted away from, isn't "active": it bloats every SessionStart snapshot and buries the work that actually matters. There is no status-time version verb, which is why a moved milestone is fixed by editing `version:`. A `high` task untouched for a month is not high priority. Work done but never logged: Reconcile it now (steps 3-4) — that's a capture failure, fix it.

**Tags** drive recall: a well-tagged backlog is found; a poorly-tagged one is re-derived blind.

**Objectives.** Objectives are the PO's OKR roadmap items; tasks link to them many-to-many via the `objectives:` frontmatter list. Several slugs on one task is expected when it lifts several outcomes (e.g. revenue AND retention), not double-counting. Don't force a link. Rollups and forecasts recompute when the orchestrator runs `dreamcontext roadmap` after your report.

**Recidivism.** Emitting another flag for a problem already at the threshold is the exact failure step (e) closes (`fix-releases-add-auto-discovery-scoping-bug` recurred 5× and stayed `todo`). At 3 consecutive cycles on the same `key`, `sleep done` itself surfaces the escalation ask and bumps the linked task's priority — you only report the observation honestly each cycle, you don't compute the streak. A `task-candidate:<key>` flag carries no task slug and never escalates (there is no task to bump, and nobody to hand an ask to); `sleep done` prints a `Deferred task candidates: n` line for them instead. Confidence by repetition means the streak has to be real, which is why only an independent re-observation counts.

**Key Results.** Observed values may come from the transcript, a file, or a connected system (e.g. MRR moved to $1,250, active users hit 400); the board regen at the end of sleep reflects them. An insight-fed objective is *measured*, not asserted: `lab bind` seeded, and every `lab sync` rewrites, its `metric.current`, one feeder max per objective. Your number would be overwritten at the next sync and blurs measured-vs-asserted provenance. If the feeding insight's cache looks stale or errored (`dreamcontext lab show <slug>` → old `fetchedAt` / `error` set), say so in your report so the user refreshes it. **Sleep NEVER runs `lab sync`** — that's a standing decision (credential exposure, latency, non-determinism); refreshing is always an explicit user/agent action outside sleep.

Never silently delete a task, and never `completed` a task that was never actually done — for superseded/abandoned/obsoleted work use the project's cancelled-kind status when one is declared (it is terminal without claiming completion); otherwise `in_review` with an explicit reason hands the close decision to the user.

### Return — short report

A filled line looks like: `Updated: fix-login-redirect (in_progress → completed, "done, validated, no review needed")`. The self-check exists because a refusal you don't report is a candidate nobody can pick up.

## sleep-product

### When you fire

The automation-output signal fires you alone because most cycles are the only chance to fold that output in before it's forgotten.

### Your domain

Insights are their own recall-indexed entity, not knowledge. The roadmap board is regenerated by the orchestrator each sleep. Automation outputs are read through `pendingOutputsSince`'s file list.

**Patterns.** Pattern *content* is not yours to change on a user correction: the prompt hook instructs the awake agent to update it in the task where it was said. **After any create/rename/retire, run `dreamcontext patterns sync`** so the generated `/pattern-*` entries match the vault — a retired pattern must not keep a live `/` entry. Naming: a pattern's own filename and H1 ARE its triggers, so name it after the thing a user would SAY, not after the code — and check with `dreamcontext patterns match "<phrase>"` that it fires.

### Protocol

The features pass goes first because it research-grounds the PRD against the task files and code; the knowledge pass then captures cross-cutting findings and processes staleness flags. Don't read all sessions if only one had research. A cross-cutting finding from your own features pass is captured inline: you own both domains this cycle.

### A4. Create a new PRD from scratch

Criteria may be written down anywhere (task body, conversation summary, sleep notes). A placeholder criteria line applies especially when A4 fires on a sparse signal (the user said "we should add X" without spelling out behaviour); the next session fills it in. Look at existing PRDs for shape. `## Why` covers motivation, the problem it solves, who benefits; `## Constraints & Decisions` covers anything non-obvious that constrains the design. If acceptance criteria aren't grounded in the session, leave the placeholder line above — never hallucinate criteria to fill the section. The PRD's value is current truth.

### A5. Multi-product awareness

Write the PRD to `knowledge/features/<slug>.md` (single flat directory, typed knowledge) but include `product: X` in frontmatter so dashboard/CLI filters can route it. Per-product knowledge wins when the content is product-specific; global knowledge wins for cross-cutting topics.

### B0. Organize — folders, grouping, and placement

`knowledge/**/*.md` is indexed recursively (`buildKnowledgeIndex` globs `**/*.md`), so subfolders are fully recall-safe — grouping a file never hides it. Diagrams are NOT a segregated top-level dump; they live with the context they illustrate. Placement judgment FIRST: only canonical boards (architecture, flows, roadmaps a future session should recall) go under `knowledge/`. When you group a context that has a board, move the board too so the folder tells one story. `apply-diagrams` is the **legacy** mechanism for boards still under a top-level `knowledge/diagrams/` tree (it does flat→per-title, not context-grouping). It prints "nothing to organize" when clean. Scratch/exploratory/in-progress boards belong in `inbox/` or `workspace/` (dark by location — not indexed) — leave those alone; do NOT pull them into knowledge. `knowledge move` rewrites inbound `[[old-slug]]` references on the target token only (`|alias` and `#anchor` preserved). When ≥3 top-level `knowledge/*.md` files form a clear topical cluster a future session would browse together (mirroring the existing `data-structures/` and `products/` subfolders), group them under `knowledge/<group>/`. Moving files + rewriting links is a structural op — gate it exactly like merge-with-delete (B1.5). Group only on a **sharp** topical boundary, the same B2 test applied to folders. Don't fragment (one folder per file) and don't over-nest.

### B1. Decide: create, update, archive, or pin

A stale-archival candidate is appended to a top-level `archive/` knowledge file or marked `archived: true`, per project convention.

### B1.5. Depth gating — what you may actually DO this cycle

Tag every action you are about to take. A flagged merge is handled by the next deep cycle or by the user via `sleep start --deep` / desktop Sleep. The dated archive copy is the recovery net; the "Dropped-but-load-bearing self-check" report line is the audit signal. Both are required for every destructive op.

### B2. Create vs. extend — the consolidation rubric

**A knowledge file is a tag-able identity, not a dumping ground.** Aim for the *fewest* files that keep each topic cleanly findable. Fragmenting one topic across many near-duplicate slugs makes tags noisy and recall worse; cramming unrelated topics into one super-file makes tags meaningless. Pick the boundary on purpose.

**Why semantic dedup first.** Keyword recall only finds files you thought to search for, the exact keyword fragility this project keeps hitting. `dreamcontext embed dedup` embeds the candidate and returns its closest existing docs by meaning — the guesswork-free dedup gate. It prints the nearest knowledge+feature docs with cosine similarity and a **verdict**. MERGE: A near-verbatim twin already exists (cosine ≥ 0.97, decisively closer than the runner-up). `--if-present` never triggers a first-time model download during sleep. Semantic dedup is an ASSIST, not a replacement — also recall by the topic AND its family (vertical / brand / parent domain), especially for CREATE/REVIEW verdicts.

**Sharp vs soft.** Don't fork a near-duplicate slug. Similar brands, similar verticals, similar topics belong together in the fewest files; a clean topical boundary earns its own slug so tagging stays valuable. Would a separate file make the tag set more discriminating, or just split one topic across two slugs? A **MERGE** verdict settles it (extend); **REVIEW** is where this rubric earns its keep. This is **not** "always make super-files": distinct topics MUST get distinct files, which is exactly what makes tags worth having. It's the *soft* distinctions (same family, narrower slice, incremental finding) that fold into an existing file.

### B3. Tags — use the taxonomy vocabulary

Bare standard tags remain valid fallbacks. Don't invent tags freely; new tags fragment search. The vocabulary is maintained in `core/taxonomy.json`; scaffold it with `dreamcontext taxonomy init` if missing.

### B6. Data structures (schemas / models / API contracts)

Schemas moved from `core/` to knowledge because they ARE domain knowledge: this gives them recall indexing, staleness flags, and the knowledge UI for free. Unlike most knowledge (which waits for repetition), a schema/data-model change is reflected in the *same* cycle — no pattern repetition required. **Migration of the old locations** (idempotent; the dir move runs automatically on `dreamcontext sleep start`, but confirm + handle the legacy file). The legacy files are left for the user to remove after confirming.

### B7. Automation output consumption

Automations write dated markdown files unattended, on their own schedule. Nobody reads them unless you do: this pass is that reading. The upstream caps skip an oversized file wholesale, never truncating it to fit, and every skip is named with a reason, so reporting `skipped` verbatim means nothing vanishes silently between the CLI and the user.

**Why SKIP by default.** A daily summary restating things the brain already has is not knowledge, and folding it in anyway is how a knowledge base drowns in noise. A daily digest running for a month must not produce thirty knowledge files: it produces zero new files most days, and an edit to one ongoing file on the days it actually finds something new.

**Why private outputs carry the marker.** An automation's `shared: false` (the default) keeps its manifest and output off the team's remote; it does not stop you from reading it, because you're reading the local filesystem, not git. Knowledge files ARE synced regardless of any automation's sharing flag, so private content folded into one can be published through it even though the automation never left this machine. If nothing this cycle came from a `shared: false` output, write nothing — an absent marker means `sleep done` proceeds without asking; an unwritten marker after a real private derivation lets that content publish without the review the gate exists to force. One knowledge file may absorb findings from several private automations: list them all.

### Pass C — Taxonomy maintenance

`audit --fix` is the **safe bulk path** — it rewrites ONLY tags whose `normalizeTag → resolveAlias` yields a *different canonical* tag (aliases like `db → domain:database`, casing like `Architecture → architecture`). It NEVER touches already-canonical tags (so `decisions` is not churned to `decision`) and NEVER guesses an orphan — orphans are reported as *"needs a vocab decision"* and left untouched. That is what makes corpus-wide normalization safe to run every cycle. **The only bulk rewrite you may run is `taxonomy audit --fix`** (it is verified-by-construction against the vocabulary). For alias/normalizable tags: Don't hand-edit these file by file anymore.

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

**Description**: mention key implementation specifics when load-bearing; no headers, no bullets. **Summary**: the CLI warns above 200 chars and never rejects; the snapshot prefers `summary` over `description` for the Recent Changelog section. **References**: Use freely — they help future recall queries follow the trail. Examples: `knowledge:decision-mem0-vs-bm25-recall`, `feature:memory-recall-bm25`. **No `note:` prefix** — free-form goes in `description`. **Supersedes** disambiguators only matter when multiple entries share the same date+scope, in which case fall back to the position-from-top index.

**Authors.** Since 0.23.0 the CLI resolves the author itself: when `people/people.json` exists it stamps the machine's ACTIVE person (`DREAMCONTEXT_PERSON` → `people whoami --set` pin → git `user.email` matched against the roster → a solo vault's only person). An explicit `--authors` list always wins and is used verbatim. On a vault with **no** `people/people.json` the key is **omitted**, never written empty — that is what keeps un-migrated vaults byte-identical. Authors are excluded from the changelog dedup fingerprint, so adding them never re-opens an already-released entry.

### A3. Releases — surface readiness, never auto-release

The feed holds exactly ONE announcement per version, so a released version with no entry is a hole in the release history that nobody notices until much later. Authoring one needs real screenshots (and clips) captured by driving the app, which is awake work. Releasing is the user's decision.

The active planning version (the "current sprint") is persisted in `state/.active-version.json` and re-validated against `RELEASES.json` on every read, so a released or missing pointer auto-clears. New tasks without an explicit `--version` auto-attach to it; entries without one float unattached. Set or switch it with `dreamcontext core releases active <version>`, clear with `--clear`, print with no argument.

### B0a. Two-observation gate (preferences & decisions)

Only update when a pattern is recurring or load-bearing. Technical Decisions are long-lived architectural choices referenced repeatedly; Known Issues are open bugs/footguns. (Recall will never surface a person constitution — `people/*.md` are deliberately NOT indexed — so for those, read the file with `dreamcontext people show <slug>` before you append.) If a near-identical entry shows up in the top hits, edit/extend that entry instead of creating a new one.

### B0b. Single-observation gate (code-reality files)

These files describe code reality, not user preferences: if the diff or transcript shows the change happened, write it. If a per-product tech-stack convention emerges, revisit the single-file convention.

### B1. Signal → file routing

Priority changes are volatile user intent, not identity: `0.soul.md` describes the durable agent (who it is, its rules, its non-negotiables) and must not churn with every standup. A constitution is one human's document, and a preference guessed onto the wrong teammate is worse than an unrecorded one.

### Pass B.5 — People detection (multi-person awareness)

**The roster lives in `_dream_context/people/people.json`** (since 0.23.0). The retired `.config.json` `people` key is gone: do not read it and do not re-create it. When you have **corroborated evidence** that more than one human works in this project, record them on the roster so changelogs/tasks/memory can attribute work per person. Detection is **AI-driven**. **Detection gate — require ≥2 corroborated signals** before flipping a project to multi-person (this gate prevents false positives; one weak signal is never enough). The git signal uses `'%an <%ae>'`; the shared bot-filter keeps per-person attribution consistent with detection. Examples of self-identification: "I'm covering for Lina".

Never hand-edit `people/people.json` (it is lock-protected and schema-validated), and never add a `multiPerson` key anywhere — it is derived. An email is what makes the git-email rung work on a teammate's machine, so record one whenever you actually know it; guessing an address is worse than leaving it empty. A person removed from the roster keeps their file by design: `people rm` deliberately leaves it, because a person's prose outlives their roster membership, and deciding it is garbage is the human's call. Pass A and this pass share the git-author analysis.

A solo project's `people/people.json`, its one `people/<slug>.md`, and its changelog output must stay byte-identical to what the CLI already produces on its own. The cost of a false positive (spuriously attributing a solo user's work to a phantom teammate) is high: stay conservative.

### C1. Anti-bloat sweep — ~4,000 char AND ~150 line ceiling per core file *and* per person constitution

**Why characters bind.** A 69-line file of dense bullets is still 13,000 chars, and the SessionStart snapshot pays bytes, not lines, so a file can sit comfortably under 150 lines while being the sole reason the snapshot busts the harness's 20,000-char limit and arrives as a blind 2KB preview. If doctor reports the never-evict tier alone over the limit, that is an `error` no ladder rung can fix — and the usual cause is `0.soul.md` or the ACTIVE `people/<slug>.md`, which are **both never-evict and render verbatim in every snapshot**. The ~4,000-char ceiling binds hardest on `0.soul.md` and the active constitution: neither compresses under pressure, so every char is paid verbatim in every session. A constitution is not a junk drawer.

**Why the ceiling-collision authority exists.** Normally ceiling extraction and a gated promotion are independent. But flagging a blocked promotion for `sleep-product` lets it lose every cycle indefinitely: the exact recidivism this fixes (a promotion that clears the gate but never lands).

The line ceiling tightened as `memory recall` learned to retrieve extracted content on demand; the character ceiling came later, when measurement showed line counts miss the real cost. The snapshot pre-loads only the freshest, most-cited entries; older context lives in knowledge files and stays findable via recall. (Version history: `sleep-fanout-architecture.md`.)

### C3. Recidivism flags — recurring problems for `sleep done --flag`

The orchestrator collects one `--flag` per flag from every specialist's report.

### Return — single combined report

A filled Roster line: `detected 2 humans (signals: 2 distinct git authors + self-id in transcript) → people add "Ada" --email ada@example.com (additive; kerem preserved)`.

### Rules

Hitting **~4,000 chars OR ~150 lines** means extract, not append — and chars are the one that actually binds, because the SessionStart snapshot pays bytes. The roster is the human's to prune (`dreamcontext people rm`), and even that keeps the file. These files mirror code, not opinion. Decisions over deliberation: save the conclusion and rationale, drop the back-and-forth.
