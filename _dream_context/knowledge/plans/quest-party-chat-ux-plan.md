---
name: quest-party-chat-ux-plan
type: knowledge
description: >-
  The validated goal-skill plan (planner round 7, three review lenses SOLID) for
  the quest-party Chat UX: party cards for sub-agents, a quest map for
  Plan/Develop/goal-skill runs, the transcript as a team log, and the
  orchestration R&D shown in plain language. Source of truth for the task's
  file-by-file plan, pinned contracts and acceptance criteria.
tags:
  - 'topic:agents'
  - 'topic:dashboard'
  - 'topic:design'
---

Both dreamcard phrase-map gaps and the `actionText` note are folded in; nothing else changed.

- **Y1:** I read `dreamCommand.ts:329-362`. There are 21 past-tense `VERBS` keys (create, add, insert, update, log, complete, remember, touch, move, merge, rename, index, sync, start, record, dedup, delete, remove, rm, retire, clear). They are now listed in T5 with exact running and failed wording. I also gave `set` and the read-tone keys (list, recall, show and the rest) entries. That means the `view.label` fallback really does apply only to keys outside `VERBS`, which is what Y1 asked for, even though Y1 only required the past-tense ones.
- **Y2:** the eight `ARITY_SENSITIVE` keys pick "Checking …" or "Setting …" by `view.tone`. `due` displays as "due date".

# Quest party: plan revision 6 (goal-planner, goal-skill v2, tier L)

## 1. Design concept

The owner's three complaints get three answers, and the machinery is told in plain words:
- the goal-skill status line becomes a quest map;
- the shell-log transcript becomes a team log;
- the job-monitor card becomes a party card.

The lead is **"Claude"** in every piece of copy (`LEAD_NAME`). The Sleepy face is only its visual.

**Team log.** Each step is an action line. Its tense, colour and ending carry the status:

| status | example | styling |
|---|---|---|
| running | "Reading ChatPane.tsx…" | `--color-success-ink`, plus the working loop on the stretch's visible avatar |
| done | "Read ChatPane.tsx" | ink |
| failed | "Couldn't edit ChatPane.tsx" | `--color-error-ink` |

Our own CLI calls read the same way: "Creating task…", then "Task created · quest-demo", or "Couldn't create task". An ask-or-order verb reads by what the call does: "Checking sleep status…" vs "Setting task status…".

**Stretches.** Rows group like Slack messages:
- One Claude avatar opens each run of consecutive steps by the same actor. Bare verb lines follow.
- The lead avatar, or a work beat's header avatar, carries the loop while any step in the stretch runs.
- A change of actor starts a new stretch.
- A work beat collapses a stretch: "Looked around: 4 steps · 2 files read · 1 command   15s".

**Quest-map bookkeeping never shows alone.** A pure goal-live call:
- renders nothing on its own;
- reads "Updated the quest map" (quiet) only inside a work beat;
- never counts toward the 3 steps a beat needs;
- never splits a party.

The raw tool name, command and output stay one click away.

**Party card.**
- The header is a team sentence ("Scout is mapping the code", "3 reviewers are reading the plan · 1 back") with a stage kicker ("Plan review · round 2").
- Each row is a character:
  - a 32px face plus role emblem, on a maker (blue) or judge (teal) tint;
  - the role name, what it is doing, and a verdict chip;
  - one badge, only when it is true: `fresh eyes` on judges, `memory` on builders that inherited context. Cold-started builders and scouts get none.
- No raw agent-type chip.
- One explainer per chat: "Fresh eyes: they see only the plan, never Claude's reasoning, so they can't be talked into agreeing."
- A finished party shows a seal with "cleared", or "sent back".

**Quest map.**
- Sentence-case stage nodes in the UI font. The acting characters sit still on their node.
- A round counter turns warning-ink from round 3.
- A beat line with reserved height shows the latest event.

**The machinery, in plain words.**
- "Claude briefed a Planner".
- A branch fan: "The Planner's memory was copied into 3 builders: 182k tokens each, not rebuilt". The number is measured, or absent.
- "The Planner picked up where it left off · round 2".
- "Claude called 3 reviewers with fresh eyes".

**Win beat.**
- Plan: "Plan sealed". A completed Develop or goal run: "Quest cleared". The seal stamps once.
- Develop left in_review: "Ready for your sign-off", with a hollow seal and no stamp.
- Develop and goal-skill runs offer "How this was built", a receipt family tree. It stays reachable after a goal-skill run because the done file is not deleted on success.

**Assets:** zero AI calls. **Council:** out of scope.

```
Team log                                            Party card
(◡) Read the full project snapshot       2.5s      ┌ (lens) Plan review · round 2                2:41 ◌ ┐
    Task created · quest-demo             0.8s     │ 3 reviewers are reading the plan · 1 back            │
    Looked around: 4 steps · 2 files read · 1 command 15s ▸ │ Fresh eyes: they see only the plan, never Claude's… │
    Asked you 2 questions                  53s     │ (◡lens) Critic      Reading ChatPane.tsx…  [fresh eyes]│
    Deploy the preview build…   (running, green)   │ (◡scis) Pragmatist  [✗ Needs work]         [fresh eyes]│
    Couldn't edit ChatPane.tsx  (error ink)        └──────────────────────────────────────────────────────────┘
Quest map (goal-skill, rail)
 ✓ Draft ── ● Plan review  round 2 ── ○ Task ── ○ Build ── ○ Boss gate ── ○ Final trial      12m
    (✎)          (🔍)(✂)(⑂)
 Claude called 3 reviewers with fresh eyes
Branch moment      (✎) ─┬─ (⚒) T1 Role registry    The Planner's memory was copied into 3 builders:
                        ├─ (⚒) T2 Tokens           182k tokens each, not rebuilt
                        └─ (⚒) T3 Verify
Receipt: How this was built
 Claude (lead)
 ├ Planner [memory] rounds 1-2 · Briefed by Claude · picked up where it left off · round 2
 │  ├ Builder T1 Role registry [memory] Started with the Planner's full memory · 182k tokens not rebuilt  (T2, T3)
 ├ Critic · Pragmatist · Edge hunter [fresh eyes] rounds 1-2
 ├ Reviewer [fresh eyes] round 1      └ Validator [fresh eyes] round 1       546k tokens reused (measured)
```
The emblems in the sketch stand for SVG drawings; nothing ships as emoji.

**Decisions kept from earlier rounds:**
- Plan and Develop stages are inferred from the stream.
- One party per dispatch batch.
- goal-skill lineage is written by a silent CLI whose calls chain onto real steps.
- Reuse is measured with `lastMainChainContext` (`src/lib/context-watch.ts:175`).
- Hue families: maker `--chart-2`, judge `--chart-8`, neutral `--chart-6`.

## 2. File-by-file plan

**Checkout constraint.** Another session has uncommitted edits in `chat/TranscriptItem.tsx` (T8) and `chat/SlideOver.tsx` (T9), plus an untracked `chat/MediaEmbed.tsx`.
- T8 and T9 build on top of the current working tree. They never reset, checkout or stash it, and never touch `MediaEmbed.tsx`.
- Their anchors are approximate; re-read the live file first.
- Commits, if asked, go by pathspec only.

### Wave 1

**T1 · Pure contracts**

- **CREATE `dashboard/src/lib/agentRoles.ts`.** Exports: `LEAD_NAME`, the role table (§4.1), `isJudgeRole` (hue `judge`), `resolveAgentIdentity`, `roleOf`, `QUEST_STAGE_LABELS`, `STAGE_ACTS`, `roleHueVar`.
- **Resolution order**, first match wins:
  1. `peer-*` → peer.
  2. `goal-planner` or `Plan` → planner / draft.
  3. `goal-plan-reviewer` → a lens chosen by L1, otherwise plan-reviewer. Stage: review.
  4. `goal-implementer` → implementer / build.
  5. `reviewer`, `review-coordinator`, `review-frontend`, `review-cloud-functions`, `review-router` → reviewer / boss. `review-security` → security / boss. `review-edge-cases` → edge-cases / boss.
  6. `goal-validator` → validator / trial.
  7. `Explore`, `dreamcontext-explore`, `dreamcontext-deep-research` → explorer / scout.
  8. A `local_bash` run: `--agent <x>` → recurse on x. `--fork-session` → implementer / build ("Builder"). Otherwise headless / none ("Helper").
  9. General-purpose and unknown types → L2 in order; no match → agent / none.
- **Keyword patterns.** These are TypeScript regex literals, listed here and never inside a markdown table. Every `|` below is a plain regex alternation; the `\|` escapes seen in earlier tables were markdown escaping only.
  - **L1** (lens; checked against the name plus the first 400 prompt chars):
    - `/\bcritic/i` → critic
    - `/\bpragmat/i` → pragmatist
    - `/\bedge/i` → edge-cases
    - `/\bsecurity\b/i` → security
  - **L2** (name only, in order): the four L1 patterns (stage review), then:
    - `/validat/i` → validator / trial
    - `/\breview/i` → reviewer / boss
    - `/implement|\bwave\b|\bbuild/i` → implementer / build
    - `/explor|scout|research/i` → explorer / scout
    - `/\bplan(ner|ning)?\b/i` → planner / draft
- **CREATE `dashboard/src/lib/quest.ts`** (§4.2).
  - `verdictOf`: the verdict word must lead the line, after stripping markdown and an optional `Verdict:` / `Review:` label. A line that contains both PASS and FAIL → null.
  - `goalLineage` merge rule:
    - events with the same `a` become one node;
    - `rounds` = the sorted union of their `r`;
    - `kind` = the first event's kind;
    - `ctx` = the first fork event's value;
    - if a resume exists, the note gains " · picked up where it left off · round N" (the highest resume round);
    - parent = the first event's `from`, otherwise the lead root;
    - `reusedTokens` = the sum of `ctx` over forks only, and null unless every fork has one.
  - The wave label is omitted when the wave is 0. All copy builds on `LEAD_NAME`.
- **EDIT `dashboard/src/lib/goalLive.ts`** (`:9-69`), additive:
  - new fields: fork `id` / `name` / `role` / `v`, `judges`, `history`, `lineage`, plus `normalizeGoalLive`;
  - caps: forks 12, judges 8, history 40, lineage 60;
  - an unknown `s` becomes `wait`; an event with an unknown `k` is dropped;
  - `ctx` is kept on forks only, and only as a finite integer > 0.
- **CREATE `tests/unit/agent-roles.test.ts`:**
  - every resolution row, both keyword lists, totality, the hue table, `isJudgeRole`;
  - the jargon rule, no em dash, no emoji, no "Sleepy".
- **CREATE `tests/unit/quest-view.test.ts`:**
  - `verdictOf`, including the negatives "Previously SOLID…", "## Review: PASS | FAIL" and "passes";
  - `goalQuest`: a legacy file, a v3 file, a stale beat, wave 0;
  - the merge case: planner spawn r1 + resume r2 → ONE node (`kind: 'spawn'`, `rounds: [1, 2]`, note "Briefed by Claude · picked up where it left off · round 2"), with 3 fork children and `reusedTokens === 546000`. It is null when one `ctx` is missing, and a resume's `ctx` is ignored.
  - `normalizeGoalLive` caps; the jargon rule.

**T3 · goal-live writer CLI**

- **CREATE `src/lib/goal-live.ts`** (§4.3), with the `applyGoalLiveEvent` reducer:
  - a phase change appends to `history` and resets `judges`; `iters[phase]` is 1 on first entry and +1 on each re-entry;
  - an `implementer` actor upserts into `forks`; a role in `JUDGE_ROLES` upserts into `judges`; **every other role only appends to lineage**;
  - each actor event appends one lineage event per id; `ctx` is kept on forks only;
  - also exports `goalLivePath` and `writeGoalLiveAtomic` (tmp file + rename);
  - `start` sweeps files older than 3h, which replaces the `find … -delete` at `SKILL.md:376`.
- **Session and path:**
  - every subcommand reads `process.env.CLAUDE_CODE_SESSION_ID`; unset or empty means null;
  - the file is `<contextRoot>/tmp/.goal-skill-live.${id ?? 'solo'}.json`;
  - `start` stamps `session` only when an id exists.
- **CREATE `src/cli/commands/goal-live.ts`** (`registerGoalLiveCommand`, §4.3):
  - `--context-of <sessionId>` names the inherited session (the planner), measured once via `findTranscriptBySessionId([id])` (`src/lib/transcript-locate.ts:175`) plus `lastMainChainContext`;
  - silent on success; a failure prints `✗ …`; always exits 0.
- **EDIT `src/cli/program.ts:152`:** register the command.
- **REGENERATE `dashboard/src/generated/cli-manifest.json`.**
- **CREATE `tests/unit/goal-live-writer.test.ts`:**
  - reducer sequences, list expansion, planner events append to lineage only, verdict and state words, `ctx` dropped on non-forks;
  - caps and atomic write;
  - env set → `.goal-skill-live.<id>.json` stamped with `session`; env unset → `.solo.json` with no `session`;
  - the `--context-of` fixture;
  - silent, exit 0 on an unwritable path.

**T6 · goal-skill pack writes the story**

- **EDIT `skill-packs/goal-skill/SKILL.md`**, section "Live run state" (`:356-415`). The CLI becomes the writer.
- **Rule:** a goal-live call is never its own step. It is chained with `&&` onto the Bash call it describes, or it is a parallel Bash call placed **first** in the same message as the Agent dispatches it records.
- **Snippets**, each in a fenced `bash` block:
  - **Start:** `dreamcontext goal-live start --goal <slug> && dreamcontext goal-live phase plan && dreamcontext goal-live actor planner --kind spawn && claude -p "<goal>" …`
  - **Planner revision:** `dreamcontext goal-live phase plan && dreamcontext goal-live actor planner --kind resume --round N && claude -p --resume <plannerId> …`
  - **Plan review** (first call of the dispatch message): `dreamcontext goal-live phase review && dreamcontext goal-live actor critic,pragmatist,edge-cases --kind fresh --round N`
  - **Verdicts** (chained onto the next real step): `dreamcontext goal-live state critic=NEEDS_WORK pragmatist=SOLID edge-cases=SOLID && …`
  - **Forks:** `dreamcontext goal-live phase impl --wave 1 --waves 3 && dreamcontext goal-live actor "T1=Role registry,T2=Tokens" --role implementer --kind fork --from planner --context-of <plannerId> && (claude -p --resume <plannerId> --fork-session … & … & wait)` (no space after `(`).
  - **Reviewer / validator** (first call of the dispatch message): `dreamcontext goal-live phase codereview && dreamcontext goal-live actor reviewer --kind fresh --round N`
  - **Success end:** `dreamcontext tasks status <slug> completed "…" && dreamcontext goal-live phase done`
  - **Sign-off end:** `dreamcontext tasks status <slug> in_review "…" && dreamcontext goal-live phase done`. The file stays after both ends.
  - **Escalation or abort only:** `dreamcontext tasks log <slug> "escalated: …" && dreamcontext goal-live clear`
- **Remove** "delete YOUR file", every `rm -f` of the live file, and the `find … -delete` (`:376`).
- **Also add:** a separate "Command reference" fenced block with the bare syntax, and the line "Never write a `ctx` number yourself". `.claude/` copies are regenerated by `dreamcontext update`.
- **EDIT `skill-packs/goal-skill/assets/goal-skill-demo.cjs`:** v3 beats with lineage and fictional `ctx` values under `demo-dummy-goal`, ending in `phase done` without deleting the file. **First to cut** if time runs short.
- **EDIT `tests/unit/goal-live-route.test.ts`:** a v3 file passes through verbatim. The route (`src/server/routes/agent-terminal.ts`, handler at `:1657`) is unchanged.
- **CREATE `tests/unit/goal-live-schema-lockstep.test.ts`:**
  - mirror drift between the two type files;
  - `JUDGE_ROLES` equals the `isJudgeRole` ids;
  - the schema block parses;
  - every subcommand exists in `createProgram()`;
  - **chaining** (fenced `bash` blocks, excluding "Command reference"): every `dreamcontext goal-live` line is either chained with `&&` to a non-goal-live command, or sits in a block marked `# first call of the dispatch message`;
  - **no success-path delete:** no `rm -f` of `.goal-skill-live`, no "delete YOUR file", no `find … -delete`. The escalation `clear` line is the only exception.

### Wave 2

**T4 · Tokens, brand, atoms**

- **EDIT `dashboard/src/styles/tokens.css`.** After the nav hues (`:195-198` light, `:362-365` dark), add to **both** theme blocks:
  ```
  --role-hue-maker: var(--chart-2);
  --role-hue-judge: var(--chart-8);
  --role-hue-neutral: var(--chart-6);
  --color-success-ink: hsl(…);
  --color-error-ink:   hsl(…);
  ```
  The inks are defined per theme; a dark value may be lighter than its base token.
- **Measure, don't assume.** Both inks are measured in both themes on `--color-bg`, `--color-bg-secondary` and `--color-bg-tertiary`, **explicitly including dark `--color-error-ink` on dark `--color-bg-tertiary` (#2a2f3d)**.
  - Each must reach ≥ 4.5:1. Log the ratios.
  - If the dark error ink fails on tertiary, lighten it; don't move rows off tertiary surfaces.
- **CREATE `tests/unit/role-hue-tokens.test.ts`:**
  - the 5 tokens exist in both blocks;
  - the hues are exactly `var(--chart-2|8|6)`;
  - no hue aliases chart-7, `--mood-*`, accent, warning, success or error;
  - the inks use `hsl(`.
- **EDIT `src/server/chat-modes.ts`** step 4 (`:69-76`): "Name each dispatch after its lens (`critic lens`, …)." **EDIT `tests/unit/chat-modes.test.ts`** to match.
- **EDIT `_dream_context/core/3.style_guide_and_branding.md`** (the DECIDED approach, plus the trims needed to meet the budget):
  1. `:13`: remove ", no gamification".
  2. Move `:14` (terminal font) verbatim to the archive.
  3. Trim `:16` to "- **Onboarding: one front door** (`setup`); a half-install state is a bug."
  4. **Keep `:30`.**
  5. After `:22` (★★★ kept verbatim), add: "- **Game grammar, not theatre (2026-09-25, owner)**: agents read as a team: Sleepy face + role emblem on a static maker or judge tint (chrome; never a mood hue, accent or warning). A step's tense is its status; a run is a quest map, a loop-back a round, a finish one calm win beat. Plain words, no jargon, no confetti."
  6. `summary:`: swap "sidebar-as-single-brand-lockup" for "game grammar for agent work". Bump `updated:`.
  7. Trim `:12` (logo), `:15` (Lab/Insights, keeping both maturity/badge rules) and `:35` (voice). Only the detail moves, verbatim, to `knowledge/archive/3.style-guide-2026-h2.md` (EDIT); every rule stays.
  8. Planned result ≈ 3,931 bytes. Re-measure with `wc -c`, require ≤ 3,950, and record the value.
- **EDIT `chat/atoms.tsx`:**
  - `AgentAvatar` (`:190-211`) gains `role?` and `running?`:
    - the face is drawn in `var(--color-text)` on the role tint, never `--color-ink`;
    - ≥ 30px: face plus a ≥ 12px emblem badge; below that: the emblem only;
    - `lead` is always the face; a peer logo wins;
    - with no role, or `agent`, it renders today's markup byte for byte.
  - New atoms: `RoleGlyph`; `VerdictChip` (Solid/Pass = success tint + ✓, Needs work/Fail = error tint + ✗, text in `--color-text`, never `--color-warning`); `QuestBadge` ("memory" / "fresh eyes", with the explainer in `title`).
  - `ToolGlyph`, `StatusDot` and `TOOL_GLYPHS` stay.
- **EDIT `chat/atoms.css`:**
  - disc `color-mix(in srgb, var(--role-hue, var(--role-hue-neutral)) 22%, var(--color-bg-secondary))`, border 55%;
  - `chat-a-work` on `[data-running]`;
  - the chips; reduced motion; no hex.
- **CREATE `tests/unit/quest-style.test.ts`:**
  - no hex in the new atom rules or in `quest/quest.css` (skipped until T7 lands);
  - a path for every `RoleGlyphId`;
  - reduced motion covers `chat-a-work`;
  - no `--color-warning` in `.chat-a-verdict`; no `--color-ink` in the avatar rules.
- **EDIT `tests/unit/accent-strong.test.ts`** only if a plain accent fill proves unavoidable. This lane is its only owner.
- **Throwaway preview (not committed):** `tmp/quest-roles-preview/render.tsx` via `npx vite-node` plus Playwright.
  - Renders every role at 16, 20 and 32px, a running judge row next to a Solid judge row, and a resting disc next to a running one, in both themes.
  - PNGs go to `_dream_context/tmp/quest-roles-preview/`. Check with `git check-ignore`.

**T5 · Chat logic**

- **CREATE `chat/toolAction.ts`** (§4.5): `toolAction`, `actionText`, `isQuestOnlyCommand`, `thinkingLabel`, `workBeatHeadline`, `stepStretches`.
  - A running action ends in "…"; `actionText` first strips any existing trailing "…" or "...".
  - **`actionText` joins `verb`, subject and `tail` with single spaces.** A fallback dreamcard error therefore reads "Thesis promote failed", and its aria-label reads "Thesis promote failed, Bash details".
  - `claude -p` detection strips a leading `(` / `{` and quotes.
  - `workBeatHeadline` excludes quest items.
- **CREATE `chat/questModel.ts`** (§4.4):
  - `partyBatches` treats thinking, empty text and quest-only entries as transparent;
  - headless dispatch items join by adjacency (`replace` / `after`);
  - carries: judge → fresh; a headless fork or resume → memory; otherwise null;
  - `chatLineage` is for Develop only.
- **EDIT `chat/chatEntities.ts`** (additive): `segmentToolRuns` (`:974`) gains an optional `weightless?: (item) => boolean`.
  - A run forms when the count of groupable non-weightless items ≥ `minRun`.
  - Weightless items inside a formed run stay in it.
  - No existing caller changes behaviour.
- **EDIT `chat/dreamCommand.ts`:**
  - `parseDreamActions` (`:262`) skips `goal-live` segments. Export `splitShellSegments`.
  - `DreamActionView` gains `verbKey` and `noun` (set in `describeDreamAction`, `:420`).
  - New `DREAM_VERB_FORMS: Record<string, { running: (noun: string) => string; failed: (noun: string) => string }>`. `n` is `view.noun`, lowercased.
  - **Y1: it covers every `VERBS` key in `:329-362`.** The 21 past-tense keys, with their exact running / failed forms:

    | key | running | failed |
    |---|---|---|
    | create | Creating `n` | Couldn't create `n` |
    | add | Adding `n` | Couldn't add `n` |
    | insert | Adding to `n` | Couldn't add to `n` |
    | update | Updating `n` | Couldn't update `n` |
    | log | Logging to `n` | Couldn't log to `n` |
    | complete | Completing `n` | Couldn't complete `n` |
    | remember | Saving to `n` | Couldn't save to `n` |
    | touch | Touching `n` | Couldn't touch `n` |
    | move | Moving `n` | Couldn't move `n` |
    | merge | Merging `n` | Couldn't merge `n` |
    | rename | Renaming `n` | Couldn't rename `n` |
    | index | Indexing `n` | Couldn't index `n` |
    | sync | Syncing `n` | Couldn't sync `n` |
    | start | Starting `n` | Couldn't start `n` |
    | record | Recording `n` | Couldn't record `n` |
    | dedup | Deduping `n` | Couldn't dedupe `n` |
    | delete | Deleting `n` | Couldn't delete `n` |
    | remove, rm | Removing `n` | Couldn't remove `n` |
    | retire | Retiring `n` | Couldn't retire `n` |
    | clear | Clearing `n` | Couldn't clear `n` |

    Also covered:
    - `set` → "Setting `n`" / "Couldn't set `n`" (exempt from the past-tense test, because its label reads the same in both tenses);
    - the read keys, so the fallback truly applies only outside `VERBS`:
      - list, ls → "Listing `n`" / "Couldn't list `n`"
      - recall → "Recalling `n`" / "Couldn't recall `n`"
      - search → "Searching `n`" / "Couldn't search `n`"
      - show → "Opening `n`" / "Couldn't open `n`"
      - get → "Reading `n`" / "Couldn't read `n`"
      - tags → "Listing `n` tags" / "Couldn't list `n` tags"
      - vocab → "Reading `n` vocabulary" / "Couldn't read `n` vocabulary"
      - audit → "Auditing `n`" / "Couldn't audit `n`"
      - doctor → "Checking `n`" / "Couldn't check `n`"
  - **Y2: every `ARITY_SENSITIVE` key** (`:369`: status, tag, version, field, due, objectives, feature, config) takes its form from `view.tone`. The display word `w` is the key itself, except `due` → "due date".
    - read tone → "Checking `n` `w`" / "Couldn't check `n` `w`"
    - write tone → "Setting `n` `w`" / "Couldn't set `n` `w`"
  - New `dreamActionPhrase(view, status)`:
    - done → `view.label`;
    - an arity-sensitive key → the Y2 form by tone;
    - a key in `DREAM_VERB_FORMS` → its running / failed form;
    - any other key → running `view.label`, error `{ verb: view.label, tail: 'failed' }`.
- **CREATE `tests/unit/tool-action.test.ts`:**
  - every verb in all 3 tenses;
  - the running "…", including an unknown-verb description and one that already ends in "…";
  - MCP and unknown tools, quest-only commands, chained goal-live + `tasks log`;
  - the three `claude -p` forms, plus the subshell form → "Started a builder with the Planner's memory";
  - `workBeatHeadline`, keeping the `7 steps · 3 files read · 2 commands` substring;
  - `stepStretches`: invisible items are transparent; a non-step breaks; an actor change starts a new stretch; only the lead is running; a run segment that leads while a later step runs gets `running: true`;
  - **`actionText({ verb: 'Thesis promote', tail: 'failed', … })` → "Thesis promote failed".**
- **CREATE `tests/unit/segment-weightless.test.ts`:**
  - `[Read, Read, quest]` → no run;
  - `[Read, Read, quest, Grep]` → one run;
  - with no `weightless` argument, output is unchanged.
- **CREATE `tests/unit/chat-quest-model.test.ts`:**
  - Agent, goal-live, Agent, Agent → ONE party;
  - implementers plus a headless builder → one build party (`replace`); headless-first → `after`;
  - ghosts, superseded parties, both progressions, outcomes, headlines;
  - no fresh badge on an implementer or explorer;
  - `chatLineage`; the jargon rule; `LEAD_NAME`.
- **EDIT `tests/unit/dream-command.test.ts`:**
  - goal-live segments yield no actions;
  - **Y1:** every `VERBS` key whose `text` is past tense (it ends in "ed", or is one of the irregular past forms in the map), except `set`, has a `DREAM_VERB_FORMS` entry. The test reads `VERBS` from the module; no hand-copied list.
  - `tasks create`: running "Creating task", error "Couldn't create task", done the label;
  - `tasks complete x` running → "Completing task";
  - `tasks delete x` error → "Couldn't delete task";
  - **Y2:** `sleep status` running → "Checking sleep status"; `tasks status x in_progress` running → "Setting task status"; `tasks due x 2026-10-01` error → "Couldn't set task due date";
  - an unknown key (`theses promote x`) in error → `{ verb: 'Thesis promote', tail: 'failed' }`;
  - `verbKey` and `noun` are present on every view.

**T7 · Quest components**

- **CREATE `quest/QuestMap.tsx`:** `QuestMap` (rail / strip / full), `QuestVictory`, `QuestReceipt` (a portal; Esc closes), `QuestLineage`, `useJustWon`, `useJustHappened`, and `export const WIN_HOLD_MS = 1600`.
  - `.quest-map[data-just-won]` and `.quest-branch[data-just-branched]`.
  - A still cast at 20px; a reserved-height beat with `data-stale`.
  - Victory: sealed "Plan sealed" and cleared "Quest cleared" (both stamp); awaiting-signoff "Ready for your sign-off" (hollow, no stamp).
  - A receipt only for Develop and goal runs.
- **CREATE `quest/quest.css`:**
  - nodes: done = success tint + ✓; active = accent-tinted ring with an `--color-accent-ink` label; todo = hollow;
  - heat 3 uses `--color-warning-ink`;
  - rail ≤ 64px, strip ≤ 32px;
  - a container query shows only the active label;
  - reduced motion; no hex; no plain accent fill.

### Wave 3

**T8 · Team log** (on top of the uncommitted `TranscriptItem.tsx`)

- **EDIT `chat/molecules.tsx`.** `ToolHeader` (`:39-100`) gains `action?`, `actor?`, `toolName?` and `stretchRunning?`.
  - With `action`, it renders:
    - `.chat-step-avatar` (16px, `role={actor ?? 'lead'}`, `running={stretchRunning}`);
    - an optional brand mark (dreamcontext skill and CLI rows keep `.chat-a-glyph-brand`);
    - `.chat-m-toolhead-action`, the chips, the tail, `.chat-m-toolhead-ellipsis` while running, the subtitle and meta.
  - It drops `StatusDot`, `ToolGlyph` (except the brand mark), `ToolName` and `StatusWord`.
  - `title` = the raw name. `aria-label` = `${actionText(action)}, ${raw} details` (so a tail such as "failed" is included).
  - With `action`, it keeps the `.chat-m-toolhead-hit` button and the 32px row (`dream-actions.mjs:284`, `:291`, `:296-302`).
  - Without `action`, it renders as today.
  - `ThinkingPill` (`:264-285`): lead avatar, `thinkingLabel`, tokens in the meta.
- **EDIT `chat/ToolCard.tsx`** (`:91-175`):
  - root `.chat-toolcard.chat-step[data-actor][data-tool][data-status][data-quiet][data-stretch]`;
  - props `actor?`, `stretch?`, `stretchRunning?`;
  - `.chat-toolcard-raw`;
  - the DreamActionCard early return (`:130-139`) passes those props through.
- **EDIT `chat/DreamActionCard.tsx`:**
  - It accepts `actor?`, `stretch?` and `stretchRunning?`.
  - Its root (`:71-74`) **keeps its existing attributes**: `.chat-toolcard.chat-dreamcard.chat-step[data-actor][data-tool="Bash"][data-status][data-open][data-tone][data-stretch]`. `data-tone` and `data-open` stay verbatim because three consumers need them: `dreamaction.css:43-53` (tone edges, including the destructive warning edge), `cards.css:360-361` / `:402` (open spacing), and `dream-actions.mjs:263-268`.
  - Its `ToolHeader` (`:76`) gets an `action` built from `dreamActionPhrase(view, status)`, where `status` is the outcome-aware status at `:52`: `{ verb, tail, subject, kind: tone read → 'look', else 'change', quiet: false, ellipsis: status === 'running', raw: 'Bash' }`. The done label keeps its `×N`. It also passes `actor`, `stretchRunning` and `toolName="Bash"`.
  - **Failure stated in text:** "Couldn't create task", or "<label> failed" in error ink. The aria-label says the same.
  - While running it reads in the present tense ("Creating task…", "Checking sleep status…").
  - It keeps the brand mark (`dream-actions.mjs:246` still counts 5) and drops `StatusDot` and `ToolName`. `ActionList` is unchanged.
- **EDIT `chat/ToolRunCard.tsx`** (`:24-60`):
  - root `.chat-toolrun.chat-step[data-actor][data-stretch]`;
  - props `actor?`, `stretch?`, `stretchRunning?`;
  - the header avatar runs when `stretchRunning || any row running || stillAccruing`;
  - "Working" while live (the aside shows the latest present-tense action with "…"); `workBeatHeadline` once landed;
  - rows get `stretch="follow"`.
- **EDIT `chat/molecules.css`:**
  - `.chat-step[data-stretch="follow"] .chat-step-avatar { visibility: hidden }`;
  - running → `--color-success-ink`; error → `--color-error-ink`; quiet → `--color-text-tertiary`;
  - the 32px geometry is kept.
- **EDIT `chat/TranscriptItem.tsx`:** `ItemView` (`:443`) gains `actor?`, `stretch?` and `stretchRunning?` and forwards them. The thinking root becomes `.chat-m-thinking.chat-step`. Empty thinking still renders nothing.
- **EDIT `scripts/verify/chat-toolrows.mjs`** (`:271-272`): test the row element itself with `e.matches('[data-tool="Bash"]')`. This matches both plain Bash rows and dreamcard rows.

**T9 · Party cards** (on top of the uncommitted `SlideOver.tsx`)

- **EDIT `chat/SubAgentCard.tsx`.** `SubAgentCard` gains `party?` and `explain?`.
  - Header: the lead role's glyph, `partyHeadline` as title, `partyTitle` as kicker, no retry tag.
  - Aside: tally, outcome, elapsed time, spinner.
  - `.chat-subagents-why` renders only when `explain` is set.
  - Root attributes: `data-party-id`, `data-party-stage`, `data-round`, `data-superseded`, `data-outcome`. It shows a seal with "cleared", or "sent back".
  - Rows:
    - `data-role`, and a `title` that includes `subagent_type`;
    - a 32px `AgentAvatar` with `role` and `running`;
    - the role label, what it is doing, `VerdictChip`, `QuestBadge`, and quiet meta;
    - no `TypeBadge`;
    - `headless` → "Helper"; a `--fork-session` run → "Builder"; a peer → "Other project" plus its vault chip;
    - no `ProgressTrack`.
  - Superseded parties fold their reports.
  - `SubAgentRail` gains `party?`: its summary is `partyHeadline`, with still 20px chips.
- **EDIT `chat/SubAgentReport.tsx`:** a 28px avatar; the type moves into `title`; verdict and badge.
- **EDIT `chat/SlideOver.tsx`:**
  - header: a 32px character, the role, `subagent_type` as text, the badge and the verdict;
  - the drill-in computes `stepStretches` and passes `actor`, `stretch` and `stretchRunning` to `ItemView`.
- **EDIT `chat/cards.css`** (`:823-1180`): glyphs use `--color-text-secondary` (`:834`, `:1134`); new styles for the kicker, why line, tally, doing line (running → `--color-success-ink`), outcome and reports toggle.
- **EDIT `scripts/verify/chat-subagent-report.mjs:312-313`:** re-point to the `.chat-subreport-head` `title` attributes.

**T11 · goal-live on the quest map**

- **EDIT `GoalLivePanel.tsx`:**
  - `q = goalQuest(normalizeGoalLive(st))` and `lin = goalLineage(…)`;
  - a new `variant?: 'rail' | 'strip'`, defaulting to `strip`, so Terminal (`PaneComposer.tsx:36`) is unchanged;
  - `button.goal-live-bar` renders `QuestMap`, or `QuestVictory` once the run is done;
  - popup: `QuestMap variant="full"`, `.goal-live-roster` (one explainer), `QuestLineage`, `.goal-live-timeline`;
  - the dock badge uses the sentence-case stage.
- **EDIT `GoalLivePanel.css`:** drop `#0091ff` (`:16`) and `#4dabf7` (`:32`); `--goal-live-run: var(--color-accent-ink)`; no monospace or uppercase chips; keep `--goal-live-edge`.
- **EDIT `tests/unit/agent-live-panels.test.ts`:**
  - the mount and edge assertions stay;
  - re-point the popup pins to `data-heat` on `.quest-node-round` and `data-s` on `.goal-live-member`;
  - add: no hex, `<QuestMap`, `normalizeGoalLive(`.

### Wave 4

**T10 · ChatPane wiring**

- **EDIT `ChatPane.tsx`.**
- **Memos:** `questEntries`, `parties`, `quest` (Plan and Develop; `mode` `:512`, `shelf.progress` `:557`), `lineage` (Develop only), `firstJudgePartyId`.
- **Quest-only items:**
  - In `isPlainToolCard` (`:792-808`), the `isQuestOnlyCommand` check goes **before** the `isDreamcontextCommand(...) → false` branch (about `:806`), so a quest-only item returns true: it joins runs and never breaks one.
  - A chained `goal-live && tasks log` is not quest-only; it keeps its own dreamcard row.
  - Call `segmentToolRuns(…, rendersNothing, isQuestOnlyItem)`, which makes quest items weightless.
  - `rendersNothing` (`:826-830`) is true for a quest-only item, so the card count and live tail skip a quest single.
  - `itemNode` returns `null` for a quest single. Inside a formed run, the item renders as the quiet "Updated the quest map" row.
- **Headless items:** `isPlainToolCard` is false for them.
- **Stretch probes (`stepStretches`):**
  - steps with actor `lead`: every single rendered through `ToolCard` (plain, dreamcard and headless rows), thinking singles that have text, and run segments;
  - invisible: quest singles and empty items;
  - everything else breaks a stretch;
  - pass `stretch` and `stretchRunning` to `ItemView` and `ToolRunCard`.
- **DOM rule:** single rows, dreamcard rows included, stay direct children of `.chat-scroll-inner`. The stretch work only sets props and attributes; it never wraps rows (`dream-actions.mjs:229`).
- **`itemNode`** (`:1346-1390`):
  - a `renderedParties` set replaces `subAgentCardShown`;
  - a suppressed Agent anchor renders its card in place;
  - a headless Bash anchor renders its row, then the card;
  - `explain={p.id === firstJudgePartyId}`.
- **Parties and rail:** trailing parties (`:1436-1443`); `railParty` gets `rootRef`; `jumpToSubAgent` (`:1128-1139`) is scoped to `scrollRef.current`; `SubAgentRail party={railParty}`.
- **`ChatLiveRail`** (`:190-210`): `<ChatQuestBar quest lineage />` when there is a quest and no active goal; `<GoalLivePanel claudeId={session.claudeId} enabled={live} variant="rail" />`; keep the substrings the tests pin.
- **Comments:** refresh `:106`, `:820-825`, `:922-928`, `:1337-1345`.
- **CREATE `chat/ChatQuestBar.tsx`** (a leaf with its own 1s tick) and **`chat/questBar.css`**. **EDIT `ChatPane.css`** (`:59-82`) to add the rail border.

**T12 · Docs + verify**

- **Docs:**
  - `skill/SKILL.md:100`;
  - `skill/references/integrations.md` (`:303-316`, `:328`, `:333`);
  - a `goal-live` row in `skill/references/cli-reference.md`;
  - `README.md:342`;
  - pointers in `knowledge/features/in-app-agent-terminal.md` and `context-gate-and-goal-skill.md`;
  - occurrence lines in the two patterns.
- **CREATE `scripts/verify/chat-quest.mjs`; EDIT `package.json`** (`"verify:chat-quest"` at `:44`).
- **Fixture (Plan mode):**
  - **PLAN-GO:**
    1. Bash "Read the full project snapshot".
    2. `dreamcontext tasks create "Quest demo" -w "demo"` (a dreamcard, same stretch).
    3. A failing `dreamcontext tasks status nope completed` (`✗`), in its own stretch after a text break.
    4. Thinking with text.
    5. A run: Read, Read, Grep, Bash "List the chat components", a pure goal-live Bash.
    6. A running "Deploy the preview build", held ~3s, in the dreamcard stretch.
    7. A finished AskUserQuestion with 2 questions.
    8. An MCP tool, then an unknown tool.
    9. A failed Edit.
    10. A ghost Agent.
    11. A lone `[Read, Read, pure goal-live Bash]`.
  - **PLAN-ANSWER:**
    1. The scout, held ~3s.
    2. The draft.
    3. Round 1: [goal-live first + 3 lenses]; the critic says NEEDS_WORK.
    4. "Revising".
    5. Round 2: the edge-cases lens held ~6s; all SOLID.
    6. `tasks create`, the progress view, the develop action.
  - **Develop kickoff:**
    1. goal-implementer ×2.
    2. The adjacent background headless builder: `dreamcontext goal-live actor "T3=Verify lane" --role implementer --kind fork --from planner && claude -p --resume planner-x --fork-session "T3 verify lane"`.
    3. An Edit.
    4. Reviewer FAIL, then an Edit, then reviewer PASS.
    5. Validator PASS, held ~4s.
    6. `tasks status quest-demo completed`.
  - **GOAL steps.** Each writes the whole state, stamped with the SID:
    - **GOAL-LIVE:** review phase, `iters {plan: 2, review: 2}`, 3 running judges, history `[plan, review, plan, review]`, lineage `[planner spawn r1, 3 lenses fresh r1, planner resume r2, 3 lenses fresh r2]`.
    - **GOAL-BUILD:** adds the impl phase (wave 1/1), running forks T1-T3, and 3 lineage forks `{from: 'planner', ctx: 182000}`.
    - **GOAL-DONE:** adds reviewer and validator fresh r1, judges done, phase done, the full lineage.
    - **GOAL-NOCTX:** GOAL-DONE without fork `ctx`.
    - **GOAL-CLEAR:** the fake deletes its file.
  - Seed `quest-demo.md` with 4 criteria, 2 ticked. Run in both themes; collect failures rather than fail fast.
- **After the gate:** `npm run build`, then `dreamcontext update` (check the global link first), then the Tauri rebuild for the owner's real-app gate.

## 3. Dependency map

| task | files owned | depends on | wave | contract |
|---|---|---|---|---|
| T1 lib contracts | `dashboard/src/lib/agentRoles.ts` (C), `dashboard/src/lib/quest.ts` (C), `dashboard/src/lib/goalLive.ts` (E), `tests/unit/agent-roles.test.ts` (C), `tests/unit/quest-view.test.ts` (C) | none | 1 | Freezes §4.1, §4.2, and the dashboard half of §4.3 |
| T3 goal-live CLI | `src/lib/goal-live.ts` (C), `src/cli/commands/goal-live.ts` (C), `src/cli/program.ts` (E), `dashboard/src/generated/cli-manifest.json` (regen), `tests/unit/goal-live-writer.test.ts` (C) | none | 1 | Freezes the writer half of §4.3, the CLI syntax, and the session/path rule |
| T6 goal-skill pack | `skill-packs/goal-skill/SKILL.md` (E), `skill-packs/goal-skill/assets/goal-skill-demo.cjs` (E), `tests/unit/goal-live-route.test.ts` (E), `tests/unit/goal-live-schema-lockstep.test.ts` (C) | T1, T3 (pinned, same wave) | 1 | Writes the §4.3 syntax; the chaining, success-end, sign-off-end and no-delete rules |
| T4 tokens + brand + atoms | `dashboard/src/styles/tokens.css` (E), `tests/unit/role-hue-tokens.test.ts` (C), `src/server/chat-modes.ts` (E), `tests/unit/chat-modes.test.ts` (E), `_dream_context/core/3.style_guide_and_branding.md` (E), `_dream_context/knowledge/archive/3.style-guide-2026-h2.md` (E), `chat/atoms.tsx` (E), `chat/atoms.css` (E), `tests/unit/quest-style.test.ts` (C), `tests/unit/accent-strong.test.ts` (E if needed), `tmp/quest-roles-preview/*` (throwaway) | T1 | 2 | Freezes the §4.6 atom props, the tokens (measured inks), and the size table |
| T5 chat logic | `chat/toolAction.ts` (C), `chat/questModel.ts` (C), `chat/chatEntities.ts` (E, additive `weightless`), `chat/dreamCommand.ts` (E: quiet domain, `verbKey`/`noun`, `DREAM_VERB_FORMS`, `dreamActionPhrase`), `tests/unit/tool-action.test.ts` (C), `tests/unit/segment-weightless.test.ts` (C), `tests/unit/chat-quest-model.test.ts` (C), `tests/unit/dream-command.test.ts` (E) | T1 | 2 | Freezes §4.4, §4.5 (incl. `dreamActionPhrase` and the `DREAM_VERB_FORMS` coverage), and the `segmentToolRuns` signature |
| T7 quest components | `quest/QuestMap.tsx` (C), `quest/quest.css` (C) | T1, T4 (pinned, same wave) | 2 | Freezes the §4.6 quest props, `WIN_HOLD_MS`, and the `.quest-*` DOM |
| T8 team log | `chat/molecules.tsx` (E), `chat/molecules.css` (E), `chat/ToolCard.tsx` (E), `chat/DreamActionCard.tsx` (E), `chat/ToolRunCard.tsx` (E), `chat/TranscriptItem.tsx` (E, on top of uncommitted edits), `scripts/verify/chat-toolrows.mjs` (E) | T4, T5 | 3 | Freezes the stretch props on `ItemView`, `ToolCard`, `DreamActionCard` and `ToolRunCard`, and the `.chat-step` root DOM (the dreamcard keeps `data-open` / `data-tone`) |
| T9 party cards | `chat/SubAgentCard.tsx` (E), `chat/SubAgentReport.tsx` (E), `chat/SlideOver.tsx` (E, on top of uncommitted edits), `chat/cards.css` (E), `scripts/verify/chat-subagent-report.mjs` (E) | T4, T5, T8 (pinned `ItemView` props, same wave) | 3 | Freezes `SubAgentCard party?/explain?`, `SubAgentRail party?`, and the card DOM |
| T11 goal-live reskin | `GoalLivePanel.tsx` (E), `GoalLivePanel.css` (E), `tests/unit/agent-live-panels.test.ts` (E) | T1, T4, T7 | 3 | `GoalLivePanel({claudeId, enabled, variant?})`; the roster and timeline DOM |
| T10 ChatPane wiring | `ChatPane.tsx` (E), `ChatPane.css` (E), `chat/ChatQuestBar.tsx` (C), `chat/questBar.css` (C) | T5, T7, T8, T9, T11 | 4 | Consumes §4.4-4.6; passes `variant="rail"`, `explain` and the stretch props; singles stay direct children of `.chat-scroll-inner` |
| T12 docs + verify | `skill/SKILL.md`, `skill/references/integrations.md`, `skill/references/cli-reference.md`, `README.md`, `knowledge/features/in-app-agent-terminal.md`, `knowledge/features/context-gate-and-goal-skill.md`, `knowledge/patterns/orthogonal-encoding-channels.md`, `knowledge/patterns/tinted-surface-not-filled-swatch.md`, `scripts/verify/chat-quest.mjs` (C), `package.json` (E) | T3, T6, T8, T9, T10, T11 | 4 | Asserts the §4.7 DOM; the docs describe shipped behaviour |

- **No file sits in two lanes.** `chatEntities.ts`, `dreamCommand.ts` and `DreamActionCard.tsx` each have exactly one owner.
- **Same-wave dependencies build against §4**, and the wave gate runs after the whole wave.
- **T8-T11 add no plain accent fill and no hex.**

## 4. Pinned contracts

**4.1 `dashboard/src/lib/agentRoles.ts`**
```ts
export const LEAD_NAME = 'Claude';
export type AgentRoleId = 'lead' | 'planner' | 'critic' | 'pragmatist' | 'edge-cases' | 'security' | 'plan-reviewer'
  | 'implementer' | 'reviewer' | 'validator' | 'explorer' | 'peer' | 'headless' | 'agent';
export type RoleGlyphId = 'face' | 'pencil' | 'lens' | 'scissors' | 'split' | 'shield' | 'hammer' | 'crown' | 'scales' | 'compass' | 'diamond' | 'prompt';
export type RoleHue = 'maker' | 'judge' | 'neutral';
export type QuestStageId = 'ask' | 'draft' | 'review' | 'task' | 'build' | 'boss' | 'trial';
export type PartyStageId = QuestStageId | 'scout' | 'none';
export interface AgentRole { id: AgentRoleId; label: string; blurb: string; noun: { one: string; many: string }; glyph: RoleGlyphId; hue: RoleHue }
export const AGENT_ROLES: Readonly<Record<AgentRoleId, AgentRole>>;
export function isJudgeRole(id: AgentRoleId): boolean;           // hue === 'judge'
export function roleOf(id: string | null | undefined): AgentRole;  // total; unknown → agent
export interface AgentIdentityProbe { subagentType?: string; name?: string; prompt?: string; command?: string; taskType?: string }
export interface AgentIdentity { role: AgentRoleId; stage: PartyStageId }
export function resolveAgentIdentity(p: AgentIdentityProbe): AgentIdentity;
export const QUEST_STAGE_LABELS: Readonly<Record<QuestStageId, string>>; // Ask · Draft · Plan review · Task · Build · Boss gate · Final trial
export const STAGE_ACTS: Readonly<Record<PartyStageId, { present: string; past: string }>>;
export function roleHueVar(h: RoleHue): '--role-hue-maker' | '--role-hue-judge' | '--role-hue-neutral';
```

Role table (the single source; hue `judge` defines `JUDGE_ROLES`):

| id | label | noun one / many | glyph | hue |
|---|---|---|---|---|
| lead | Claude | Claude / Claude | face | neutral |
| planner | Planner | Planner / planners | pencil | maker |
| critic | Critic | Critic / reviewers | lens | judge |
| pragmatist | Pragmatist | Pragmatist / reviewers | scissors | judge |
| edge-cases | Edge hunter | Edge hunter / reviewers | split | judge |
| security | Security | Security / reviewers | shield | judge |
| plan-reviewer | Reviewer | Reviewer / reviewers | lens | judge |
| implementer | Builder | Builder / builders | hammer | maker |
| reviewer | Reviewer | Reviewer / reviewers | crown | judge |
| validator | Validator | Validator / validators | scales | judge |
| explorer | Scout | Scout / scouts | compass | neutral |
| peer | Other project | Other project / other projects | diamond | neutral |
| headless | Helper | Helper / helpers | prompt | neutral |
| agent | Teammate | Teammate / teammates | face | neutral |

Avatar sizes:

| surface | size | shows |
|---|---|---|
| transcript step | 16 | lead face |
| quest-map cast | 20 | emblem, still |
| rail chips | 20 | emblem, still |
| receipt | 20 | emblem |
| report card | 28 | emblem |
| party rows | 32 | face + emblem badge |
| SlideOver header | 32 | face + emblem badge |

The emblem badge appears only at ≥ 30px. The face is drawn in `--color-text`.

**4.2 `dashboard/src/lib/quest.ts`**
```ts
export type QuestKind = 'plan' | 'develop' | 'goal';
export type Verdict = 'solid' | 'needs-work' | 'pass' | 'fail';
export type Carries = 'memory' | 'fresh';
export interface QuestStage { id: QuestStageId; label: string; state: 'todo' | 'active' | 'done'; rounds: number;
  wave?: { at: number; of: number | null } /* omitted when at === 0 */; meter?: { done: number; total: number } }
export interface QuestMember { key: string; role: AgentRoleId; name: string; stage: QuestStageId | null;
  state: 'wait' | 'run' | 'done' | 'fail'; verdict: Verdict | null; carries: Carries | null }
export interface QuestBranch { fromKey: string; fromRole: AgentRoleId; toKeys: string[]; ctxEach: (number | null)[]; ctxTotal: number | null }
export type QuestOutcomeKind = 'sealed' | 'cleared' | 'awaiting-signoff';
export interface QuestOutcome { kind: QuestOutcomeKind; taskSlug: string | null; rounds: number; agents: number; elapsedMs: number | null }
export interface QuestView { kind: QuestKind; title: string | null; stages: QuestStage[]; activeIndex: number;
  cast: QuestMember[]; branch: QuestBranch | null; beat: { text: string; stale: boolean } | null;
  outcome: QuestOutcome | null; startedAt: number | null; timeline: { stage: QuestStageId | 'done'; at: number }[] }
export interface QuestLineageNode { key: string; role: AgentRoleId; label: string; kind: 'lead' | 'spawn' | 'fork' | 'resume' | 'fresh';
  rounds: number[]; state: 'wait' | 'run' | 'done' | 'fail'; verdict: Verdict | null; carries: Carries | null;
  ctx: number | null; note: string; children: QuestLineageNode[] }
export interface QuestLineage { root: QuestLineageNode; copies: number; returns: number; fresh: number; reusedTokens: number | null }
// Merge rule: same `a` → one node; rounds = union of r (sorted); kind = first event's kind; ctx = first fork event's ctx;
// note = lineageNote(...) + (resume present ? " · picked up where it left off · round <max resume r>" : "");
// parent = first event's `from`, else the lead root. reusedTokens = Σ ctx over k:'fork'; null unless every fork has ctx.
// goalQuest: phase 'done' → outcome 'cleared' (goal runs do not distinguish in_review; see §6).
export const QUEST_TEMPLATES: Readonly<Record<QuestKind, readonly QuestStageId[]>>;
export const GOAL_PHASE_TO_STAGE: Readonly<Record<string, QuestStageId>>;
export const JARGON_RE: RegExp;   // /fork|session|resume|--|\b-p\b/i
export function verdictOf(text: string | null | undefined): Verdict | null;
export function goalQuest(s: GoalLiveState, now?: number): QuestView;
export function goalLineage(s: GoalLiveState): QuestLineage | null;
export function questVictoryCopy(q: QuestView): { headline: string; stats: string } | null; // "Plan sealed" | "Quest cleared" | "Ready for your sign-off"
export function lineageNote(kind: QuestLineageNode['kind'], role: AgentRoleId, parentLabel: string, ctx: number | null): string;
export function freshExplainer(stage: PartyStageId): string | null;
export function branchCaption(b: QuestBranch, fromLabel: string): string;
export function formatQuestTokens(n: number): string;   // 182000 → "182k", 546000 → "546k"
export function formatQuestElapsed(ms: number): string;
```

**4.3 goal-live v3.** The dashboard types (T1) mirror the writer types (T3), and T6's test catches drift.
```ts
type GoalForkState = 'run' | 'done' | 'wait' | 'fail';
export interface GoalLiveFork { s: GoalForkState; id?: string; name?: string; role?: string; v?: string }
export interface GoalLiveLineage { a: string; role: string; k: 'spawn' | 'fork' | 'resume' | 'fresh'; from?: string; r?: number; name?: string; at?: string; ctx?: number /* fork only, measured */ }
export interface GoalLiveState { goal?: string; session?: string; started?: string; updated?: string; phase: string;
  iters?: Record<string, number>; impl?: { wave?: number; waves?: number; forks?: GoalLiveFork[] };
  judges?: GoalLiveFork[]; history?: { p: string; at: string }[]; lineage?: GoalLiveLineage[] }
export function normalizeGoalLive(raw: unknown): GoalLiveState | null;                                  // dashboard
export type GoalLiveEvent =                                                                               // src/lib/goal-live.ts
  | { type: 'start'; goal: string; session: string | null }
  | { type: 'phase'; phase: 'plan' | 'review' | 'task' | 'impl' | 'codereview' | 'validate' | 'done'; wave?: number; waves?: number }
  | { type: 'actor'; id: string; role: string; kind: 'spawn' | 'fork' | 'resume' | 'fresh'; from?: string; round?: number; name?: string; ctx?: number }
  | { type: 'state'; id: string; state?: GoalForkState; verdict?: 'SOLID' | 'NEEDS_WORK' | 'PASS' | 'FAIL' };
export const JUDGE_ROLES: readonly string[];
export function applyGoalLiveEvent(prev: GoalLiveState | null, ev: GoalLiveEvent, nowIso: string): GoalLiveState;
export function goalLiveSessionId(env?: NodeJS.ProcessEnv): string | null;
export function goalLivePath(contextRoot: string, sessionId: string | null): string;  // <contextRoot>/tmp/.goal-skill-live.${id ?? 'solo'}.json
export function writeGoalLiveAtomic(path: string, s: GoalLiveState): void;
```

CLI syntax. Silent on success; always exits 0.
```
dreamcontext goal-live start --goal <slug>                      # stamps session only when CLAUDE_CODE_SESSION_ID is set; sweeps files >3h
dreamcontext goal-live phase <plan|review|task|impl|codereview|validate|done> [--wave N] [--waves N]
dreamcontext goal-live actor <id[=name],…> --kind <spawn|fork|resume|fresh> [--role <role>] [--from <id>] [--round N] [--context-of <sessionId>]
dreamcontext goal-live state <id=word> [<id=word> …]           # run|done|wait|fail, or SOLID|NEEDS_WORK|PASS|FAIL (sets v, s=done)
dreamcontext goal-live clear                                    # escalation/abort only
```

**4.4 `chat/questModel.ts`**
```ts
export interface QuestEntry { kind: string; id: string; toolUseId?: string; name?: string; input?: unknown; status?: string; text?: string; done?: boolean; ts?: number; startedAt?: number }
export interface Party { id: string; runs: SubAgentRun[]; stage: PartyStageId; lead: AgentRoleId; round: number;
  anchorEntryId: string | null; anchorKind: 'replace' | 'after' | 'trailing'; superseded: boolean; ghost: boolean }
// Dispatch item: tool entry whose toolUseId maps to an isDispatchedAgent run OR an isHeadlessAgentShell run.
// Transparent: thinking, empty text, quest-only tool entries. Anything else closes the batch.
export type PartyOutcome = 'running' | 'cleared' | 'sent-back' | 'ended';
export function runIdentity(run: SubAgentRun): AgentIdentity;
export function runVerdict(run: SubAgentRun): Verdict | null;
export function runCarries(run: SubAgentRun): Carries | null;
export function runDoing(run: SubAgentRun): string;
export function partyBatches(entries: readonly QuestEntry[], runs: readonly SubAgentRun[]): Party[];
export function partyTitle(p: Party): string;
export function partyHeadline(p: Party): string;
export function partyOutcome(p: Party): PartyOutcome;
export function partyBeat(p: Party): string;
export interface PartyTally { running: number; landed: number; total: number; verdicts: Record<Verdict, number> }
export function partyTally(p: Party): PartyTally;
export interface QuestProgressProbe { slug: string; state: string; done: number; total: number }
export function deriveChatQuest(i: { mode: 'plan' | 'develop'; entries: readonly QuestEntry[]; parties: readonly Party[]; progress: QuestProgressProbe | null }): QuestView | null;
export function chatLineage(parties: readonly Party[], entries: readonly QuestEntry[]): QuestLineage;
```

**4.5 `chat/toolAction.ts`, the `segmentToolRuns` extension, and the dreamCommand additions**
```ts
export type ActionKind = 'look' | 'search' | 'change' | 'run' | 'ask' | 'delegate' | 'plan' | 'web' | 'skill' | 'quest' | 'other';
export interface ToolAction { verb: string; subject: ToolSubject | null; tail?: string; kind: ActionKind; quiet: boolean; ellipsis: boolean; raw: string }
export function toolAction(name: string, input: unknown, status: 'running' | 'done' | 'error'): ToolAction;
export function actionText(a: ToolAction): string;
// = [verb, subjectText, tail].filter(Boolean).join(' '), with a trailing "…"/"..." stripped, then "…" appended iff ellipsis.
// e.g. { verb: 'Thesis promote', tail: 'failed' } → "Thesis promote failed"; the header aria-label is `${actionText(a)}, ${raw} details`.
export function isQuestOnlyCommand(command: string | undefined): boolean;
export function thinkingLabel(streaming: boolean): string;
export function workBeatHeadline(items: readonly { name: string; input?: unknown; status: 'running' | 'done' | 'error'; startedAt: number; endedAt?: number }[]): string;
export interface StretchProbe { key: string; step: boolean; invisible: boolean; actor: AgentRoleId; running: boolean }
export function stepStretches(seq: readonly StretchProbe[]): Map<string, { stretch: 'lead' | 'follow'; running: boolean }>;
// chatEntities.ts (additive):
export function segmentToolRuns<T>(items: readonly T[], isGroupable: (i: T) => boolean, minRun?: number,
  rendersNothing?: (i: T) => boolean, weightless?: (i: T) => boolean): RunSegment<T>[];
// dreamCommand.ts (additive):
export interface DreamActionView { label: string; tone: DreamTone; subject?: string; detail?: string; desc?: string;
  verbKey: string;   // action.action ('' when none)
  noun: string }     // domainNoun(...) as used in `label`
export const DREAM_VERB_FORMS: Readonly<Record<string, { running: (noun: string) => string; failed: (noun: string) => string }>>;
// covers EVERY key of VERBS (dreamCommand.ts:329-362); the 21 past-tense keys are required (tested), `set` and the read keys included too.
export function dreamActionPhrase(view: DreamActionView, status: 'running' | 'done' | 'error'): { verb: string; tail?: string };
// done → { verb: view.label }
// ARITY_SENSITIVE key (status, tag, version, field, due, objectives, feature, config), w = key ('due' → 'due date'):
//   tone 'read'  → running `Checking ${n} ${w}`, error `Couldn't check ${n} ${w}`
//   tone 'write' → running `Setting ${n} ${w}`,  error `Couldn't set ${n} ${w}`
// key in DREAM_VERB_FORMS → running .running(n), error .failed(n)
// any other key → running { verb: view.label }, error { verb: view.label, tail: 'failed' }
// (n = view.noun lowercased)
```

Verb table: done / running / failed. A running verb gets "…" appended. `claude -p` is matched after stripping a leading `(` / `{` and quotes.

| tool or command | done | running | failed |
|---|---|---|---|
| Read | Read | Reading | Couldn't read |
| Grep | Searched for | Searching for | Couldn't search for |
| Glob | Looked for files matching | (same pattern) | (same pattern) |
| LS | Listed | Listing | (same pattern) |
| Edit, MultiEdit, NotebookEdit | Edited | Editing | Couldn't edit |
| Write | Wrote | Writing | Couldn't write |
| WebFetch | Read `<host>` on the web | (same pattern) | (same pattern) |
| WebSearch | Searched the web for | (same pattern) | (same pattern) |
| Skill | Used | (same pattern) | (same pattern) |
| AskUserQuestion | Asked you `N question(s)` | Asking you | (same pattern) |
| Agent, Task | Sent the `<role>`: + description | (same pattern) | (same pattern) |
| TodoWrite | Updated the to-do list | (same pattern) | (same pattern) |
| ExitPlanMode | Proposed a plan | (same pattern) | (same pattern) |
| BashOutput, TaskOutput | Checked on a background job | (same pattern) | (same pattern) |
| KillShell, TaskStop | Stopped a background job | (same pattern) | (same pattern) |
| `mcp__*` | Used `<Server>`: `<tool>` | (same pattern) | (same pattern) |
| unknown | Used `<Name>` | (same pattern) | (same pattern) |
| quest-only command | Updated the quest map (quiet) | Updating the quest map | (same pattern) |
| `claude -p` + `--fork-session` | Started a builder with the Planner's memory | (same pattern) | (same pattern) |
| `claude -p` + `--resume` | Brought a teammate back where it left off | (same pattern) | (same pattern) |
| `claude -p`, neither flag | Briefed a new teammate | (same pattern) | (same pattern) |
| DreamActionCard rows | `view.label` | the `dreamActionPhrase` running form (e.g. "Creating task", "Checking sleep status") | "Couldn't create task", or the label + tail "failed" (keys outside `VERBS` only) |

Bash with a description: the leading verb is conjugated via this table (unknown verbs stay verbatim; a failure reads "Tried to `<description>`").

| verbs | kind |
|---|---|
| Read, List, Show, Check, Inspect, Find, Search, Count, Measure, Look, Print, Scan, Verify | look |
| Write, Create, Update, Install, Build, Add, Remove, Delete, Commit, Push, Move, Copy, Save, Seed, Sync, Set, Make, Rebuild | change |
| Run, Test, Compile, Start, Stop, Load, Open, Fetch, Get, Type-check | run |

Bash without a description: "Ran a command", with the condensed command as subtitle and goal-live segments stripped.

`stepStretches` rules:
- invisible items neither join nor break a stretch;
- a non-step breaks it;
- an actor change starts a new stretch;
- the first step is the lead, and only the lead is `running` (true when any step in the stretch runs, including when a run segment leads).

**4.6 Component props**
```ts
AgentAvatar(p: { name: string; size?: number; src?: string | null; role?: AgentRoleId; running?: boolean })
RoleGlyph(p: { glyph: RoleGlyphId; size?: number }); VerdictChip(p: { verdict: Verdict }); QuestBadge(p: { carries: Carries; title?: string })
export const WIN_HOLD_MS = 1600;
QuestMap(p: { quest: QuestView; variant: 'rail' | 'strip' | 'full' }); QuestVictory(p: { quest: QuestView; justWon: boolean; onReceipt?: () => void })
QuestReceipt(p: { lineage: QuestLineage; title: string; onClose: () => void }); QuestLineage(p: { lineage: QuestLineage })
useJustWon(won: boolean, holdMs?: number): boolean; useJustHappened(key: string | null, holdMs?: number): boolean
ToolHeader(p: { …existing; action?: ToolAction; actor?: AgentRoleId; toolName?: string; stretchRunning?: boolean })
  // with action: keeps .chat-m-toolhead-hit and the 32px row; title = raw tool name; aria-label = `${actionText(action)}, ${raw} details`
ToolCard(p: { item; onOpenFile; actor?: AgentRoleId; stretch?: 'lead' | 'follow'; stretchRunning?: boolean })
DreamActionCard(p: { …existing; actor?: AgentRoleId; stretch?: 'lead' | 'follow'; stretchRunning?: boolean })
ToolRunCard(p: { items; stillAccruing; onOpenFile; actor?: AgentRoleId; stretch?: 'lead' | 'follow'; stretchRunning?: boolean })
  // header avatar running = stretchRunning || any row running || stillAccruing
ItemView(p: { …existing; actor?: AgentRoleId; stretch?: 'lead' | 'follow'; stretchRunning?: boolean })
SubAgentCard(p: { runs; party?: Party; explain?: boolean; onDrillIn; rootRef?; highlightRunId?; peers?; conversationId? })
SubAgentRail(p: { runs; party?: Party | null; onJump; onWheel?; peers? })
ChatQuestBar(p: { quest: QuestView; lineage: QuestLineage | null })
GoalLivePanel(p: { claudeId?: string; enabled: boolean; variant?: 'rail' | 'strip' })
```

**4.7 DOM contract**

Team log:
- `.chat-toolcard.chat-step[data-actor][data-tool][data-status][data-quiet][data-stretch]` > `.chat-m-toolhead`, containing `.chat-m-toolhead-hit`, `.chat-step-avatar.chat-a-avatar`, `.chat-m-toolhead-action`, `.chat-m-toolhead-tail`, `.chat-m-toolhead-ellipsis` and `.chat-m-toolhead-sub`.
- `.chat-toolcard.chat-dreamcard.chat-step[data-actor][data-tool="Bash"][data-status][data-open][data-tone][data-stretch]` > `.chat-m-toolhead`, containing `.chat-m-toolhead-hit`, `.chat-step-avatar`, `.chat-a-glyph-brand` and `.chat-m-toolhead-action`. No `.chat-a-dot`, no `.chat-a-toolname`.
- `.chat-toolcard-raw`.
- `.chat-m-thinking.chat-step[data-actor][data-stretch]` > `.chat-m-thinking-label`.
- `.chat-toolrun.chat-step[data-actor][data-stretch]` > `.chat-m-cardhead` (with `.chat-step-avatar` and `.chat-m-cardhead-title`), then `.chat-toolrun-rows > .chat-toolcard.chat-step[data-stretch="follow"]`.
- Single rows are direct children of `.chat-scroll-inner`.

Party card:
- `.chat-subagents[data-party-id][data-party-stage][data-round][data-superseded][data-outcome]`, with `.chat-subagents-stage`, `.chat-m-cardhead-title` and `.chat-subagents-why`.
- Rows: `.chat-subagents-row[data-role][data-status][title]`, with `.chat-subagents-row-head`, `.chat-subagents-row-role`, `.chat-subagents-row-doing`, `.chat-a-verdict[data-verdict]` and `.quest-badge[data-badge]`.
- `.chat-subagents-reports-toggle`.

Quest map:
- `.quest-map[data-kind][data-variant][data-won][data-just-won]` > `.quest-node[data-stage][data-state][data-rounds]`, containing `.quest-node-label`, `.quest-node-round[data-heat]`, `.quest-node-meta` and `.quest-node-cast .chat-a-avatar`.
- `.quest-branch[data-just-branched]` > `.quest-branch-caption`.
- `.quest-beat[data-stale]`.

Victory and receipt:
- `.quest-victory[data-outcome]` > `svg.quest-seal[data-hollow]`, `.quest-victory-text`, `.quest-victory-stats`, `button.quest-receipt-toggle`.
- `.quest-receipt .quest-lineage li.quest-lineage-node[data-role]`, with `.quest-lineage-name` and `.quest-lineage-note`.

Goal-live:
- `.goal-live-roster .goal-live-member[data-role][data-s]`.
- `.goal-live-timeline .goal-live-tick .goal-live-tick-label`.

## 5. Acceptance criteria

1. **Green gates.** Keep the whole output.
   - `npm test` passes; root and dashboard `tsc` exit 0.
   - `cli-manifest`, `chat-modes`, `chat-mode-mirror`, `agent-live-panels` and `dream-command` stay green.
   - All new unit files pass, including the `DREAM_VERB_FORMS` coverage and arity-tone cases. No assertion is deleted.
2. **Existing verify suites stay green, with re-pointed pins only.**
   - `verify:chat-toolrows`: the row element matches `[data-tool="Bash"]`, for plain and dreamcard rows.
   - `verify:chat-subagent-report`: the agent type is read from `title`.
   - `verify:dream-actions`: 5 brand marks, the hit button, 32px geometry, tone edges and open spacing via the kept `data-tone` / `data-open`, and rows as direct children of `.chat-scroll-inner`.
   - `verify:chat-scroll`.
3. **Team log** (`verify:chat-quest`, both themes).
   - These action lines render: "Read the full project snapshot"; "Task created" with its brand mark and no dot; "Read" plus a file chip; "Searched for"; "Asked you 2 questions"; "Used Claude Docs: batch"; "Used FrobnicateThing"; "Sent the scout: …"; "Thought it through" with its token count; "Couldn't edit …"; and "Looked around: 4 steps · 2 files read · 1 command".
   - No visible header shows a bare tool name.
   - A stretch led by a `dreamcontext tasks create` row shows exactly one visible `.chat-step-avatar`, and that avatar animates while "Deploy the preview build" runs.
   - A failed dreamcard row's visible text contains "Couldn't" or "failed", in `--color-error-ink`, and its aria-label says the same.
   - A running dreamcard row reads in the present tense and ends in "…" ("Creating task…").
   - In any stretch of 3 steps, exactly one avatar is visible.
   - The running row ends in "…" in `--color-success-ink`; the failed row uses `--color-error-ink`.
   - Raw details are reachable: `.chat-toolcard-raw`, and the full command in `.chat-m-terminal`.
4. **Quiet bookkeeping.**
   - The lone `[Read, Read, goal-live]` shows 2 rows, no `.chat-toolrun`, and no quest row.
   - Inside a formed run, "Updated the quest map" appears with `data-quiet` and is not counted.
   - Each dispatch round yields exactly one card and no visible quest row.
   - A chained `goal-live && tasks …` keeps its own dreamcard row.
5. **Party cards.**
   - "Scout is mapping the code" → "Scout mapped the code"; "3 reviewers are reading the plan".
   - Exactly 2 review cards of 3 rows each, with tops in order: round 1 < "Revising" < round 2.
   - No "agents running" text and no ⚡.
   - No type badge in the rows; the type lives in `title`.
   - `.chat-subagents-why` appears exactly once.
6. **Verdicts and the build party.**
   - Round 1: the critic shows `needs-work` and the card is `sent-back`. Round 2: `cleared`, with a seal. Round 1 shows 0 reports until toggled.
   - Judges carry `fresh`; Agent-tool builders do not.
   - The build card, anchored at the first implementer, holds both implementers and the headless builder (`memory`, "Builder").
   - It sits before the "Started a builder with the Planner's memory" line with no other card between them. That line stays visible outside any `.chat-toolrun`.
7. **Plan quest.**
   - Stages: `ask, draft, review, task`.
   - In round 2: review is active, rounds = 2, 3 still cast avatars, and the beat reads "Claude called 3 reviewers with fresh eyes".
   - Win: "Plan sealed". `[data-just-won]` is present right after the win and gone after `WIN_HOLD_MS` + 1000ms (the constant is parsed from source).
8. **Develop quest.**
   - Stages: `build, boss, trial`. Build shows `2 of 4`.
   - Card titles: "Build · wave 1", "Boss gate · round 2", "Final trial · round 1".
   - "Quest cleared" appears, with the receipt.
9. **goal-live in the Develop chat.**
   - The rail shows a goal-kind `.quest-map` with 6 sentence-case, non-monospace nodes.
   - GOAL-LIVE: 3 cast avatars on review, and "round 2".
   - The develop map stays hidden while the goal file exists, including after GOAL-DONE, and returns after GOAL-CLEAR.
   - Writer: env set → a stamped `<id>` file; env unset → `.solo`, unstamped.
10. **Branch and receipt.**
    - GOAL-BUILD: 1 planner and 3 builders; the caption contains "memory was copied into 3 builders" and "182k"; `[data-just-branched]` fires once.
    - After GOAL-DONE, the receipt shows:
      - the root "Claude";
      - ONE Planner node (rounds 1-2, "picked up where it left off · round 2");
      - 3 builders marked `memory` with "182k tokens not rebuilt";
      - fresh judges;
      - exactly "546k tokens".
    - GOAL-NOCTX: no `/\d+(\.\d+)?k tokens/` anywhere.
    - The lockstep test passes.
11. **Plain language.**
    - None of `/fork|session|resume|--/i`, and no "Sleepy", inside: `.quest-map`, `.quest-victory`, `.quest-receipt`, `.goal-live-popup`, `.chat-subagents .chat-m-cardhead`, `.chat-subagents-stage`, `.chat-subagents-why`, `.chat-subagents-row-role`, `.chat-subagents-row-head`, `.chat-subagents-rail`, `.chat-m-toolhead-action`, `.chat-m-thinking-label`, `.chat-toolrun > .chat-m-cardhead`.
    - Instrument control: the headless row's terminal does contain `--fork-session`.
    - No em dash and no emoji in UI copy.
12. **Contrast** (both themes, after an instrument check).
    - Both `-ink` tokens reach ≥ 4.5:1 on bg, bg-secondary and bg-tertiary in both themes, explicitly including dark `--color-error-ink` on dark `--color-bg-tertiary`. Ratios are recorded.
    - All visible UI text reaches ≥ 4.5:1: action lines (running, done, failed, dreamcard), labels, beat, caption, victory, badge, lineage, kicker, role, doing, why, verdict, roster and tick.
    - Emblems and faces reach ≥ 3:1 against their disc.
13. **Layout.**
    - At 1500px and 720px there is no horizontal overflow on `.quest-map`, `.chat-subagents`, `.chat-toolrun` or `.goal-live-bar`.
    - Rail ≤ 64px, strip ≤ 32px; tool and dreamcard rows unchanged (±1px).
    - Avatar sizes match §4.1; the badge appears only at ≥ 30px.
14. **Motion** (visible avatars only).
    - With no motion preference, these animate:
      - the visible stretch lead while any step in its stretch runs, including a dreamcard-led stretch;
      - the run header when `stretchRunning`, when a row is running, or while `stillAccruing`;
      - a running party-row avatar;
      - `[data-just-branched]`;
      - the `[data-just-won]` seal.
    - Under `reducedMotion: 'reduce'`, each is motionless.
    - The cast and rail chips never animate.
15. **Brand, docs, gate.**
    - The style guide is ≤ 3,950 bytes (measured value recorded). It keeps `:30` and ★★★, has the new bullet and the "game grammar" summary, and no longer says "no gamification".
    - Docs pointers are updated.
    - The preview PNGs exist and are not committed.
    - Terminal still mounts the `GoalLivePanel` strip.
    - The task ends `in_review` with screenshots for the owner's real-app sign-off.

## 6. Risks and open questions

- **Style-guide arithmetic.** The DECIDED moves alone land at ≈ 4,258 bytes. The `:12`, `:15` and `:35` detail trims (every rule stays) bring it to ≈ 3,931, and the measured value is recorded. **Open (owner):** if those three lines must stay untouched, raise the budget rather than gut the new bullet.
- **Assets: zero AI calls.** There is a contingency, used only if the owner rejects the SVG set:
  - model `google/gemini-3.1-flash-lite-image` ($0.25/M in, $1.50/M out as of 2026-09-25; the real cost is read from `usage.cost`);
  - at most 2 calls, for a reference sheet that never ships;
  - `scripts/assets/quest-concept-sheet.mjs` reads `openRouterKey` by name and never logs it;
  - spend is logged to `_dream_context/tmp/quest-asset-spend.json`, and the script refuses a call that would push the total past $3;
  - output goes to the gitignored `tmp/`.
- **Goal runs can't tell done from awaiting sign-off.** Both ends chain `phase done`, so goal runs show "Quest cleared" even for in_review. Develop chats do distinguish the two.
- **Done files linger for up to 3h**, until they age out or the next `start` replaces them. A Develop chat shows the goal map meanwhile. This is intended.
- **The reuse number** is the planner's last main-chain context at fork time. The copy says "not rebuilt", never "free".
- **Orchestrator discipline.** The lockstep test pins the documentation. A missed chain costs one quiet line at most.
- **Dreamcard phrasing.** `DREAM_VERB_FORMS` covers every `VERBS` key and the eight arity-sensitive keys by tone. Only verbs outside `VERBS` fall back: the label while running, "<label> failed" on error. That is honest but less natural; add entries as new verbs get names in `VERBS`.
- **Verdicts are best effort.** Stages and rounds never depend on them.
- **Real CLI activity text** can contain flags. It is outside the jargon scan, and the fixtures are clean.
- **Inference limits.** Visible text between parallel dispatches splits a party. An agent that skips its questions shows Draft as done.
- **Shared checkout.** T8 and T9 build on another session's uncommitted edits, never reset them, and commit by pathspec only.
- **Open:** fold thinking into work beats? Recommendation: not in this goal.
- **Out of scope:**
  - Council
  - #agents avatars
  - a mascot win mood
  - a quest map in Basic mode
  - party cards for resumed history
  - a Plan receipt
  - the viewer `<title>`
  - a `transcript context` CLI
  - a new feature PRD
  - removing the now-unused `ProgressTrack` atom (follow-up)