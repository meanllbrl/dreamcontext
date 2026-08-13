# PLAN — Redesign the Automations subsystem end to end

Repo: `/Users/mehmetnuraydin/projects/dreamcontext`, branch `main` @ `8b4eed4`.
Tier L (cross-cutting + hot-path: sha256 approval hash, Telegram bot token, resumable
`bypassPermissions` session ids).

---

## 0. THE GOAL AND ITS FIXED DECISIONS (owner-set, NOT open for relitigation)

The owner is unhappy with Automations: it explains itself with prose and badges instead
of showing what a job DOES, and its human-in-the-loop gate lives on a board nobody is
standing in front of when a job fires at 18:00.

**D1 — Review queue removed; approval tripwire survives but leaves the UI.**
`AutomationsReviewQueue.tsx` + its board surface are deleted. The sha256 tripwire in
`src/lib/automations/registry.ts` is KEPT — it is the only thing stopping a manifest
edited elsewhere (brain sync, a teammate) from running `bypassPermissions` here. But
`blocked — needs approval` stops being a badge + full-field review screen. When the hash
does not match, the automation asks in its own chat session: "these fields changed since
you last approved — here is the diff — should I go ahead?" Yes records approval exactly
as `approveAutomation` does today.

**D2 — HITL is ask-and-exit, two channels only** (dreamcontext chat default, Telegram).
The run writes its question and the process EXITS. When the human answers, the same
claude session is `--resume`d. NO long-lived blocked process. Reuse `verdict.ts`'s
`resumeWithVerdict`/`applySteer`, do not invent a second resume path. In the chat pane
the question must READ like Claude asking a question — inline question card, not a
foreign "review card" widget.

**D3 — Creating an automation opens a chat.** "New automation" opens a chat session
whose agent interviews the user then writes the manifest (frontmatter + `## Prompt` +
`## Flow`). Follow the window-event bridge convention (`delegateAgent.ts` /
`automationRunChat.ts`: event name, detail interface with `accepted?: boolean`,
synchronous ACK read).

**D4 — The node graph IS the manifest, and it executes.** A new `## Flow` section holds
JSON: an ordered graph of `trigger → agent(+connectors) → hitl → report`. The runner
READS and executes it; the dashboard DRAWS it; the D3 creation agent WRITES it. Node
types live in a registry modelled on `dashboard/src/components/lab/chartRegistry.ts` —
BUT `chartRegistry` is a CLOSED `Record<Render, …>` that will not compile without an
entry, whereas the owner explicitly wants "lego": adding a new MCP-tool / API / chat
connector must NOT require editing a hardcoded union. Known-kinds registry WITH a
generic fallback (the way `chartEntry()` degrades unknown → `number`). The n8n-style
flow diagram becomes the PRIMARY visual of the detail screen; the prompt recedes.
HARD CONSTRAINT: `dashboard/src/components/about/FlowDiagram.tsx` is data-driven
(`FlowSpec { viewBox, nodes[], edges[], ariaLabel }`) but **there is no auto-layout
anywhere in this repo** — every existing spec hand-authors x/y/w/h and bows its wires by
hand (`automationsFlowSpec.ts`). A per-automation graph is generated at runtime, so a
deterministic layout function (manifest graph → `FlowSpec`) must be planned.

**D5 — Cards and detail screen.** A card must make what the automation DOES and what its
LAST RUN did unmistakable: last fire time, last status, and a short summary of the last
report. Detail screen follows the `design` skill's hierarchy rules. One click opens that
automation's session as a chat tab.

**D6 — Automation chat tabs are visually distinct.** `SessionKind` is
`'agent' | 'shell' | 'chat'` (`agentSession.ts:68`) rendered `◇ / >_ / ◆`
(`AgentTabs.tsx:173`). Add a fourth kind with its own glyph; enumerate EVERY switch site
(recon: `AgentSurface.tsx` ~112, 352, 358, 420, 509, 626, 1066, 1140, 1710;
`AgentTabs.tsx` 138/163/166–173; `AgentDock.tsx`; `agentStatus.ts`; CSS
`data-session-kind` selectors).

**D7 — On app open, every run since the last open opens as a chat tab.** Tab title =
automation name + run date. Restore path exists: `AgentSurface.tsx:321–373` hydrates from
`GET /api/agent/sessions` (roster `state/.agent-sessions.json`) and auto-resumes entries
carrying a `sessionId`. Re-open of the same run must focus the existing tab, not spawn a
duplicate (`openAutomationRunChat` already dedupes by `claudeId`). Telegram-channel
automations do not need a chat tab.

**D8 — Telegram is per-automation.** Today ONE global `~/.dreamcontext/telegram.json`.
Becomes `~/.dreamcontext/telegram/<slug>.json`, mode 0600, machine-local, NEVER in the
brain. A bot token + authorized chat id is the ability to resume a `bypassPermissions`
session on this machine — a capability, not a preference (`card-registry.ts` documents
this exact threat model). Set-token UX mirrors Lab credentials
(`LabCredentialsBanner.tsx` + `GET/POST /api/lab/credentials` + `writeCredential`'s
gitignore-FIRST ordering) but on the automation's own detail screen; storage location
differs on purpose (HOME, not the brain). The Telegram conversation is always that
automation's LATEST run session. Polling today happens inside the dispatcher tick
(`tick.ts:178`) with one global config — plan the multi-bot version incl. per-bot
`offset`.

**D9 — The run queue holds at most one waiting job per automation.** Recon: **there is no
queue today at all.** `tick.ts:150–157` checks `isDue()` and `await`s each due automation
sequentially; `server/automation-job.ts:47` allows one run-now job per project. Nothing
remembers a fire that could not run. Required: at most ONE waiting entry per automation;
a second enqueue of the same slug drops the OLDER waiting entry.

**Explicitly OUT OF SCOPE:** editing the flow graph by dragging on the canvas (the canvas
RENDERS; the creation chat and the manifest AUTHOR). Any change to Lab, Council,
Insights, or the in-flight `project-tabs` work.

**VALIDATION METHOD (agreed with the owner — the definition of done):** `npm test` green
+ `npm run build` green + a new runtime verify script `scripts/verify/automations.mjs` in
the style of the repo's existing `scripts/verify/*.mjs` and the `verify` skill (drive the
real dashboard server + UI against an isolated scratch vault with a fake HOME, so no user
state is touched). It must demonstrably exercise: creating an automation through the chat
flow, the flow graph rendering from manifest data, answering a HITL question in chat, and
a run opening as a chat tab.

---

## 1. GROUND TRUTH FROM RECONNAISSANCE (verified reads marked ✅)

✅ = read in full this session, line numbers verified. ⚠️ = from the recon brief, line
numbers NOT independently verified — the implementer must re-verify before editing.

### Backend `src/lib/automations/` (7329 lines total)

- ✅ **`types.ts` (608)** — contract root, no I/O, no imports beyond the language.
  `RUN_STATUSES` (25–33) incl. `'awaiting-review'`; `REVIEW_MODES` (53);
  `AutomationManifest` (75–159); `RunEvent` (179–196); `AutomationCache` (199–213) with
  THE WATERMARK `lastFireAt` (advances iff a child actually started);
  `ReviewCard` (264–316); `REVIEW_DIR` (319); `AUTOMATIONS_REVIEW_GITIGNORE_ENTRIES`
  (342) + `_ROOT` (343) — **deliberately NOT part of `AUTOMATIONS_GITIGNORE_ENTRIES`**,
  with a long comment (328–341) explaining that adding a base wildcard after a negation
  would report every share negation as broken; `ApprovalPayloadFields` (364–383);
  `AUTOMATIONS_GITIGNORE_ENTRIES` (491–498) with the ORDER-IS-LOAD-BEARING doc (464–490);
  pure sharing predicates `negationIsEffective` (572–584) and `shareOrderingProblems`
  (596–608); `APPROVAL_DIFF_FIELDS` (424–433).
- ✅ **`registry.ts` (441)** — machine-local approval tripwire.
  `canonicalApprovalPayload` (246–280) builds the hashed payload with **OMIT-WHEN-DEFAULT**
  (`effort` at 251, `learning` at 264, `review` at 277) so manifests written before a
  field existed keep a byte-identical hash; `manifestHash` (283–285); `approvalFields`
  (294–313, always-present for DISPLAY); `checkApproval` (333–344) returning
  `never-approved | manifest-changed | payload-format-changed`; `approveAutomation`
  (349–364); `findProjectKey` (183–191, lookup-only symlink resolution);
  heartbeat in a SEPARATE file (385–441) to avoid a lost-update race.
- ✅ **`card-registry.ts` (127)** — THE capability isolation. Module doc (1–27) states the
  threat precisely: the card lives in the PROJECT directory, so anything able to write
  there could plant a card with a chosen session id and wait for a human to approve —
  the approval tripwire defeated through a door it does not watch. So the
  capability-bearing field moves to the HOME boundary. `recordCardSession` (90–102,
  RUNNER-ONLY writer); `readCardSession` (111–118) is THE AUTHORITY, returns null on
  slug mismatch (116); `forgetCardSession` (122–127). 0600 (83), 90-day TTL (36).
- ✅ **`session.ts` (122)** — `resolveRunSession` (50–78). `runNumber` is 1-based
  newest-first and indexes history AS STORED because `recordRun` prepends; the doc
  (41–49) warns that reversing silently makes `--run 1` the OLDEST. With no explicit run
  it picks **the most recent one that HAS a session, not simply the most recent** (63–68).
  `digestTranscript` (91–108) is PURE.
- ✅ **`verdict.ts` (832)** — `defaultPgidProbe` (79–90); `proposeFromRun` (119–163) with
  the process-group guard that FAILS CLOSED on an unverifiable caller (131–136);
  `buildApprovePreamble` (179), `buildDiscardPreamble` (191), `buildDropPreamble` (210),
  `buildSteerPreamble` (249); `acquireRunLock` (323–327); `spawnResume` (343–379) writing
  the sidecar synchronously in `onSpawned`; **`buildResumeArgs` (381–397)** producing
  exactly `--resume <sid> -p <prompt> --permission-mode bypassPermissions --output-format
  json [--model m] [--effort e]`; `publishStagedDocument` (413–431, rename with
  copy+unlink EXDEV fallback); **`authoritativeSession` (443–450)** — reads the
  machine-local binding, and refuses when the card FILE disagrees with the binding (448);
  `resumeWithVerdict` (467–687) — claim BEFORE spawn (606), reopen ONLY on `not-spawned`
  (614–629), lock BEFORE claim (593–600), binding retired in `finally` (683–685);
  `applySteer` (697–796) distils a lesson AT STEER TIME; `distillLesson` (809–832)
  VERIFIES the ledger grew rather than trusting the ask.
- ✅ **`runner.ts` (1241)** — the ONLY code that spawns `claude`.
  `buildPreamble` (58–78); `buildPatternBlock` (89–99, pattern framed as UNTRUSTED NOTES —
  the security boundary, doc at 80–88); `buildLearningDirective` (105–127);
  `sanitizeAutomationPrompt` (133–138); `composePrompt` (147–157, ORDER IS LOAD-BEARING:
  preamble → approved prompt → output instructions → pattern → learning);
  `extractNotificationSummary` (187–220, PURE and total); `outputPathFor` (233–243,
  same-day `-2`/`-3` suffixes); `parseClaudeJson` (275–299); `buildClaudeArgs` (301–309);
  `executeClaudeDetached` (455–508) — the ONE detached spawn core, `onSpawned` called
  SYNCHRONOUSLY before any await (doc 421–428);
  **`runAutomation` (566–1090) lifecycle in order**: getAutomation (590) → **approval
  (741–747)** → sleep-lock (750–755) → **orphan guard (763–784, BEFORE the file lock — the
  single most-reviewed invariant, doc 757–762)** → **REVIEW GATE (800–806, doc 786–799:
  the only refusal that is not a fault; watermark NOT advanced so the fire is OWED)** →
  per-slug lock (808–813) → gitignore + mkdir (826–852, re-ensures the REVIEW block too,
  doc 834–841: a card holds a live resumable session id and `sleep done` auto-commits) →
  composePrompt/spawn/sidecar (854–916) → spawn-failure gate (923–939) → parse + card
  decision (960–1041) with `backfillCardSession` + `recordCardSession` (980–986) →
  finalize (1053–1073) → `finally` (1074–1089) releasing lock + clearing ONLY its own
  sidecar. `killRunGroup` (1113) is CLI-only; `automations-no-auto-reap.test.ts` enforces
  that `tick.ts` never imports it.
- ⚠️ **`review.ts` (535)** — cards at `automations/review/<slug>/<id>.json`, staged docs
  alongside, O_EXCL claim lock, `pendingReviewCard()` is what the runner's serial gate
  reads.
- ⚠️ **`telegram.ts` (440)** — global config, Layer-1 auth gate drops any update whose chat
  id is not the authorized one, `offset` persisted so no update is processed twice.
- ⚠️ **`tick.ts` (233)** + **`schedule.ts` (174)** — `isDue()` compares `now` against
  `mostRecentFire` and `lastFireAt`, rejecting with `already-ran` / `not-yet` /
  `outside-catchup`. **No queue.** Telegram polled at `tick.ts:178`.
- ⚠️ **`store.ts` (883)** — `extractSection(content, heading)` parses `## X` blocks;
  `upsertSection` is surgical and preserves every byte outside its target. Reads are
  LENIENT and never throw. A new `## Flow` fenced-JSON section is safe to add here.
- ⚠️ Others: `launchd.ts` (511), `notifier.ts` (447), `sharing.ts` (255),
  `snapshot.ts` (248), `consumption.ts` (232).

### Server ⚠️
`src/server/routes/automations.ts` (681): `GET /api/automations`, `/runs`, `/:slug`,
`/:slug/session?run=N`, `POST /:slug/run`, `/:slug/approve`, `/:slug/enable`,
`/:slug/disable`, `GET /review`, `POST /review/:id`, `GET /dispatcher`,
`POST /dispatcher/install`, `/dispatcher/uninstall`. **Route registration ORDER is
load-bearing** (literal sub-paths before `:slug`); two tests guard it
(`automations-route.test.ts`, `automations-dispatcher-route.test.ts`).
`src/server/automation-job.ts` (86) holds the single run-now job per contextRoot (:47).

### CLI ⚠️
`src/cli/commands/automations.ts` (1488): create, list, show, pattern, learn, propose,
review, telegram (setup/test/off), session, run, tick, enable, disable, share, unshare,
approve, kill, remove, install, uninstall, logs.

### Dashboard ⚠️
`components/automations/`: `AutomationsBoard.tsx` (157), `AutomationCard.tsx` (200),
`AutomationDetailPanel.tsx` (523), `AutomationsReviewQueue.tsx` (162, to be deleted),
`AutomationsDispatcherBar.tsx` (165), `AutomationsEmptyState.tsx` (52),
`AutomationsShowcase.tsx` (16), `automationsFlowSpec.ts` (135, hand-authored) + CSS.
`hooks/useAutomations.ts` (471) exports `useAutomations`, `useAutomation`,
`useAutomationSession`, `useAutomationRunJob`, `useRunAutomation`,
`useAutomationDispatcher`, `useInstallDispatcher`, `useUninstallDispatcher`,
`useSetAutomationEnabled`, `useApproveAutomation`, `useReviewQueue` (5s poll),
`useAnswerReviewCard` + the full TS type surface.

### Chat surface ⚠️
`AgentSurface.tsx` (2170) mounted ONCE in `App.tsx` outside the page router. `spawn()` at
419 (`kind: SessionKind`, `resume` flag); `resumeSession()` at 502; hydration 321–373;
`automationRuns: Record<sessionId, AutomationRunRef>` at 937; `openAutomationRunChat()`
at 939 (focuses an existing tab by `claudeId`, else `spawn(bypass, sessionId, true,
claudeKind)` at 971); `AUTOMATION_RUN_CHAT_EVENT` listener at 998–1004 sets
`detail.accepted = true`. `SessionMeta { id, title, kind, bypass, claudeId, dormant? }`
at 78–85. Roster round-trips through `GET/PUT /api/agent/sessions`
(`src/server/routes/agent-sessions.ts`, desktop-only, `state/.agent-sessions.json`,
`SavedMeta { title, bypass, minimized, size, sessionId? }`). `ChatPane.tsx` (1485) takes
an optional `automation?: AutomationRunRef` prop (278) and renders `AutomationRunHeader`
at 1329–1335, passed down through `ChatPaneHost.tsx`.

### Flow rendering ⚠️
`components/about/FlowDiagram.tsx`: `FlowSpec { viewBox, nodes: FlowNode[], edges:
FlowEdge[], ariaLabel }`; `FlowNode { id, x, y, w, h, title, sub?, glyph?, variant?,
breathe?, breatheDelay? }` with variants `hook | region | agent | rem | accent | plain`;
`FlowEdge { id, d, comet?, dashed?, arrow?, thin?, delay?, dur?, travel?, label? }`.
`flow-geometry.ts` exports `Box { cx, cy, w, h }` and `makeLink(nodes)` computing
edge-to-edge quadratic Bézier paths with arrowhead clearance and a hand-tuned `bow`.
Per-instance gradient ids via `useId()`. **No auto-layout exists.**

### Lab precedents ⚠️
`components/lab/chartRegistry.ts`: `ChartRegistryEntry { CardBody, DetailBody?,
defaultSpan, supportsWindow, emptyHint, routed?, openHint }`, `CHART_REGISTRY:
Record<Render, ChartRegistryEntry>`, `chartEntry(render)` degrades unknown → `number`;
`tests/unit/lab-render-registry.test.ts` guards drift. `src/lib/lab/credentials.ts`
`writeCredential()` enforces gitignore-FIRST ordering so a secret never touches disk
without a governing ignore entry.

### Tests ⚠️ (23 files — these encode behaviour being changed; update deliberately, never
delete for convenience)
`automations-review-gate.test.ts` (unanswered card blocks the next fire),
`automations-review-store.test.ts`, `automations-verdict.test.ts` (propose guard checks
process-group membership), `automations-card-registry.test.ts`,
`automations-telegram.test.ts` (token is a machine-local capability),
`automations-tick.test.ts`, `automations-schedule.test.ts`, `automations-route.test.ts`,
`automations-dispatcher-route.test.ts`, `automations-no-auto-reap.test.ts`,
`automations-store.test.ts`, `automations-registry.test.ts`,
`automations-sharing.test.ts`, `automations-skill.test.ts` (Entity Router count),
`automations-snapshot-section.test.ts`, `automations-consumption.test.ts`,
`automations-pattern.test.ts`, `automations-process-group.test.ts`,
`automations-runner.test.ts`, `automations-notifier.test.ts`,
`automations-launchd.test.ts`, `automations-session-summary.test.ts`, and the integration
`automations-cli.test.ts`.

### Working tree
Branch `main` @ `8b4eed4`, clean except untracked `_dream_context/workspace/project-tabs/`
(unrelated in-flight design work — DO NOT TOUCH). **ZERO automation manifests on this
machine** (`_dream_context/automations/` holds only `cache/` and `output/`), so migration
burden is minimal — but the plan must still say what happens to a manifest written before
`## Flow` existed.

---

## 2. DESIGN DECISIONS

### D-A — First approval when there is no session to ask in (resolves D1's consequence)

Approval acquires **three** paths, in strict precedence. The review-card surface is not
one of them.

1. **Local authorship (unchanged).** `createAutomation` already calls `approveAutomation`
   — the human who just authored it is the approver. The D3 creation chat writes the
   manifest **through the CLI verb**, so it inherits this for free. This is the host for
   first approval, exactly as D1 anticipated.
2. **In-session re-approval (new, D1's core).** When `checkApproval` returns
   `manifest-changed` (or `payload-format-changed`) **and** the slug has a prior approval
   entry, the run does not short-circuit to `blocked`. It spawns in a question-only
   envelope (D-B), asks the diff question in its own session, and exits. Answering yes
   calls `approveAutomation` and the normal run starts.
3. **Never-approved manifests (brain sync / teammate).** `reason: 'never-approved'`
   **keeps today's hard `blocked` short-circuit.** No spawn, no ask, no chat tab. It
   surfaces as a first-class row on the board ("arrived from the brain, never run here")
   whose only affordance opens a local review + approve screen that is not a run.

**Why.** Path 2 is safe because a prior approval proves a human on THIS machine already
granted `bypassPermissions` for this slug; resuming the conversation is a delta question
about a capability already held. Path 3 is categorically different: a never-approved
manifest has no session, no prior grant, and arrived over a channel an attacker can
write to. Letting it spawn to "ask nicely" would let a synced manifest bootstrap its own
`bypassPermissions` execution — the exact attack `card-registry.ts`'s header describes,
moved one door over. So: **a manifest that arrives over brain sync and has never run here
runs nothing, ever, until a human approves it from a surface the manifest cannot reach.**

**DEVIATION FLAG — LOUD.** D1 says the tripwire "leaves the UI". It leaves the UI for the
*changed-manifest* case only. The *never-approved* case keeps a UI surface, because
removing it entirely leaves a synced manifest with no approval path at all. This is one
screen (a diff + an Approve button on the detail panel), not the review queue.

### D-B — How the run asks its approval question without granting itself the capability

The `manifest-changed` question runs in a **restricted envelope**:
`claude -p <question-prompt> --permission-mode default --output-format json` — NOT
`bypassPermissions`, no `--model`/`--effort` drawn from the unapproved manifest, hard
2-minute timeout. **The runner pre-renders the field-by-field diff** (it has both the
stored hash's fields and the current manifest via `approvalFields`) and passes it as
QUOTED DATA inside a prompt the runner constructs — the manifest's prose is never passed
as instruction. Its only job is to emit the question and exit. On yes,
`approveAutomation` records the hash and the **normal** run path starts fresh from step
2; the question session is NOT resumed with elevated permissions.

**Why.** The question session must not be able to do the work it is asking permission
for. Reusing `resumeWithVerdict` here would hand the unapproved manifest a
`bypassPermissions` resume (`buildResumeArgs`, verdict.ts:381–397, hardcodes it), which
inverts the tripwire. So the approval question is a separate, weaker spawn; only the HITL
questions of D2 reuse the verdict machinery, because those belong to an already-approved
run.

### D-C — Unknown node kinds (D4's "lego" requirement)

`nodeEntry(kind)` mirrors `chartEntry(render)`'s degradation shape but over an **open**
map plus a generic fallback:

- **Registry**: `NODE_REGISTRY: Record<string, FlowNodeEntry>` — a plain open record,
  NOT `Record<NodeKind, …>`. Adding a connector is adding a key; no union edit, no
  compile break. The module doc must state this difference from `chartRegistry`
  explicitly, or a future reader will "fix" it back to a closed record.
- **Unknown kind renders** as a `variant: 'unknown'` FlowDiagram node, glyph `◇`,
  title = the node's `label` (or the raw `kind` when absent), sub = `kind`, dashed
  border. Visibly present and unrecognised — never dropped, never rendered as something
  it isn't.
- **The runner treats an unknown kind as pass-through**: logs
  `unknown node kind "<kind>" — passing through`, executes nothing for it, continues.
  Does NOT fail the run; does NOT guess.

**Why.** Dropping an unknown node would make a flow lie about what it does — the exact
failure this redesign exists to fix. Failing the run would make every manifest from a
newer dreamcontext dead on arrival.

**Consequence, stated explicitly:** the flow graph is **descriptive of orchestration, not
of authority**. A node cannot grant a capability; the prompt + approval hash still decide
what the run may do. An unknown node therefore cannot be a privilege-escalation vector,
which is what makes pass-through safe.

### D-D — Where the run queue lives (D9)

`~/.dreamcontext/automations-queue.json`, mode 0600, machine-local, **never in the
brain**. Shape `Record<projectRoot, Record<slug, QueuedFire>>` — at most one entry per
slug **by construction** (an object key; the newer enqueue overwrites the older, which IS
D9's "the older waiting entry is dropped").

**Why not the brain.** A synced queue is a remote-write primitive: a teammate pushing a
queue entry would cause YOUR machine to execute an automation at a time you did not
schedule, using your `bypassPermissions` grant. Same class of defect as a synced review
card; `card-registry.ts` already documents that threat model.

**Why not `automations/cache/`.** That directory is already gitignored for run state —
but the gitignore is best-effort (`runner.ts:826–850` re-ensures it precisely because it
can be missing), and "the queue is safe as long as a `.gitignore` line survives" is a
weaker guarantee than "the queue is not in the repo".

**Interaction with the three existing mechanisms:**
- **`lastFireAt` watermark** — unchanged and still authoritative. Enqueue happens only
  when `isDue()` says yes AND the run cannot start; the queued entry carries the
  **original `firedAt`**, so draining advances the watermark to the fire it answers for,
  not to drain time. Catch-up bounds still apply at drain: a queued fire older than
  `catchupHours` is dropped with an `outside-catchup` log line, not run.
- **Per-slug lock** — the queue's whole purpose. `deferred` (lock busy) becomes: record
  the fire, return `deferred` as today. Next tick drains it.
- **Orphan guard** — `orphaned` does NOT enqueue. An orphan means a process group is
  loose; queueing fires behind it builds a backlog that all fires the instant a human
  runs `automations kill`. Stays a hard refusal.
- **Approval-blocked** — does not enqueue (nothing may run).
- **HITL-waiting** — does not enqueue as a separate mechanism; the existing
  `awaiting-review` gate already owes the fire by not advancing the watermark, and a
  queue entry on top would double-count it.

### D-E — Telegram "latest session" resolution + the card-registry replacement (D8, D1)

Resolution is a pure function over the cache, machine-locally re-verified:

```
latestResumableSession(contextRoot, slug, home) →
  resolveRunSession(cache)            // session.ts:50-78, no runNumber
    ↓ .sessionId
  readAutomationSession(slug, sessionId, home)   // machine-local allowlist
```

`resolveRunSession` with no `runNumber` **already** implements "the most recent run that
HAS a session, not simply the most recent" (session.ts:63–68). Reuse it; do not write a
second resolver.

**When the newest run has no session id:** `resolveRunSession` walks back to the newest
that does. If NO run in history has one, the bot replies with a plain refusal — "this
automation has no session to talk to yet; it has not completed a run on this machine" —
and does nothing else. It never falls back to spawning a fresh session from a Telegram
message, because that would make an inbound network message a run trigger.

**What replaces card-registry's capability isolation.** Deleting review cards deletes
`readCardSession`'s subject, but NOT its property, and the property is what matters:

- `~/.dreamcontext/automations/<slug>.sessions.json` (0600, 90-day TTL, same file
  mechanics as `card-registry.ts`) records, **written only by the runner**, the session
  ids that automation actually produced on this machine, with their slug binding.
- Every resume path — chat answer, Telegram answer, tab restore — resolves through
  `readAutomationSession(slug, sessionId, home)`, which returns the id only if THIS
  machine recorded it under THIS slug. A session id arriving from a manifest, a synced
  cache record, a Telegram message body, or a hand-edited roster resolves to `null` and
  is not resumable.
- `authoritativeSession`'s shape (verdict.ts:443–450 — refuse when the file's claim
  disagrees with the binding) is preserved verbatim, pointed at the new store.

**Why this is load-bearing.** The cache record `automations/cache/<slug>.json` **is
brain-synced**. Its `history[].sessionId` is therefore an attacker-writable field for
anyone who can push to the shared brain. Resolving "latest session" straight off the
cache with no machine-local check would be strictly WORSE than today's review cards,
because it needs no card-planting at all — just a synced JSON edit.

### D-F — The layout algorithm (D4's hard constraint)

A new **pure module** `dashboard/src/components/automations/flowLayout.ts` mapping
manifest graph → `FlowSpec`, plus a **sibling renderer** `AutomationFlowCanvas.tsx` that
COMPOSES the existing `FlowDiagram` rather than replacing or forking it.

**Algorithm — deterministic layered (Sugiyama-lite), no library:**
1. **Rank** — longest-path layering. `rank(n) = 0` for nodes with no inbound edge; else
   `1 + max(rank(pred))`. Cycles broken by ignoring any edge whose target already has a
   rank ≥ the source's (recorded in `warnings`, rendered dashed). Deterministic because
   `nodes[]` array order is the tie-break.
2. **Order within rank** — stable, by first appearance in `nodes[]`. No barycentre
   iteration: manifest graphs are small, and iteration would make the picture change
   between renders of identical data — worse than a crossing.
3. **Place** — fixed geometry from constants: `NODE_W = 168`, `NODE_H = 56`,
   `RANK_GAP = 88`, `LANE_GAP = 24`, left-to-right (`x = rank * (NODE_W + RANK_GAP)`),
   vertically centred per rank. All 4-divisible per the `design` skill's grid law,
   declared as module constants, never inline.
4. **Wire** — `makeLink(nodes)` from the existing `flow-geometry.ts`. `bow` derived, not
   hand-tuned: `0` for same-rank-adjacent straight runs, `±18` alternating for
   rank-skipping edges so parallel long edges separate.
5. **viewBox** — computed from placed extents + a 16px margin.

**Extend `FlowDiagram` or add a sibling — and why: SIBLING, COMPOSING.** `FlowDiagram` is
the renderer of a `FlowSpec` and it is correct; its consumers (the About page's
hand-authored specs) must not change behaviour. What is missing is not rendering, it is
**spec production**. Putting a layout engine inside `FlowDiagram` would make a
presentational component own graph algorithms and force every hand-authored spec through
a code path it does not need. So `flowLayout.ts` (pure, unit-testable, zero DOM) produces
a `FlowSpec`; `AutomationFlowCanvas.tsx` calls it and renders `<FlowDiagram spec={…} />`.
The one change INSIDE `FlowDiagram` is additive: an `unknown` entry in the variant union
+ its CSS class, needed by D-C.

**Purity requirement:** deterministic and side-effect-free — same graph in, byte-identical
`FlowSpec` out. That is what makes it testable without a browser and what lets
`scripts/verify/automations.mjs` assert on rendered node positions.

### D-G — What the HITL question looks like in chat (D2)

Rendered by the **existing chat message pipeline** as an inline question card — the same
component family the Chat view already uses for Claude's own questions — parameterised by
a `hitl` payload, NOT a ported `AutomationsReviewQueue` card. `ChatPane.tsx` already takes
`automation?: AutomationRunRef` (278) and renders `AutomationRunHeader` (1329–1335); the
question card slots into the message stream below it.

**Why.** D2 is explicit that it must read like Claude asking a question. A distinct widget
with its own chrome reads as a foreign system bolted on — the complaint that started this
redesign.

### D-H … D-K — resolutions to the four questions raised at plan time

The owner said "continue, don't stop" rather than answering, so these are decided here and
flagged. Each is reversible with a small, named change.

- **D-H (was Q1) — the `review` manifest field survives, meaning repointed.** D1 removes
  the review *queue*, but `ReviewMode` (`off`/`agent`/`output`) is an approval-hashed
  field (registry.ts:277). Removing it from the hash would silently un-gate every manifest
  that currently sets it — an upgrade that deletes a human gate is the one failure mode
  the tripwire exists to prevent. So the field stays, hashed exactly as today, and its
  semantics repoint from "stage a review card" to "raise a HITL question". Reversal cost
  if the owner wants it retired: one omit-line in `canonicalApprovalPayload` + a one-time
  re-approval for any manifest that set it.
- **D-I (was Q2) — the D7 "runs since last open" watermark lives at
  `~/.dreamcontext/automations-tabs.json`**, keyed by projectRoot,
  `{ lastOpenedAt: string }`, 0600. Chosen over `state/.agent-sessions.json` for
  consistency with D-D and D-E: everything that decides WHICH SESSION MAY BE RESUMED now
  lives behind the HOME boundary, and a watermark in the brain would let a synced edit
  cause a burst of tab-opens (and therefore auto-resumes) on someone else's machine.
- **D-J (was Q3) — a HITL question never expires.** Today's `awaiting-review` gate blocks
  the next fire indefinitely and does not advance the watermark
  (runner.ts:786–806) — that is deliberate ("the scheduler runs at the human's speed
  instead of the clock's"). Adding an expiry would silently convert an unanswered question
  into a resumed run, which is the opposite of what the gate is for. Kept as-is.
- **D-K (was Q4) — the approval question gets a runner-rendered diff.** `--permission-mode
  default` means the question session cannot read files to explain the diff richly, so the
  runner pre-renders it from `approvalFields(stored)` vs `approvalFields(current)` and
  passes it as quoted text (see D-B). Best of both: full explanation, no elevated
  permissions.

---

## 3. FILE-BY-FILE PLAN

### 3.1 The `## Flow` block — verbatim schema

Stored in `automations/<slug>.md` as a fenced JSON block under `## Flow`, read via
`extractSection(content, 'Flow')` and written via `upsertSection`.

````markdown
## Flow

```json
{
  "version": "automation-flow/v1",
  "nodes": [
    { "id": "trigger", "kind": "trigger", "label": "Every weekday 18:00",
      "config": { "source": "schedule" } },
    { "id": "gather", "kind": "agent", "label": "Read today's commits",
      "config": { "connectors": ["bash", "read"] } },
    { "id": "ask", "kind": "hitl", "label": "Send the digest?",
      "config": { "channel": "chat", "choices": ["send", "revise", "skip"] } },
    { "id": "out", "kind": "report", "label": "Daily digest",
      "config": { "target": "output" } }
  ],
  "edges": [
    { "from": "trigger", "to": "gather" },
    { "from": "gather",  "to": "ask" },
    { "from": "ask",     "to": "out", "label": "send" }
  ]
}
```
````

**Normative field contract:**

| Field | Type | Req | Rule |
|---|---|---|---|
| `version` | string | yes | `"automation-flow/v1"`. Any other value ⇒ whole block reads as absent (lenient, per store.ts's never-throw read contract). |
| `nodes` | `FlowGraphNode[]` | yes | 1..24. Empty/absent ⇒ flow reads `null`. |
| `nodes[].id` | string | yes | `/^[a-z0-9][a-z0-9_-]{0,39}$/`, unique. Duplicate ⇒ later dropped. |
| `nodes[].kind` | string | yes | Free string. Known: `trigger`,`agent`,`hitl`,`report`,`connector`,`branch`. Unknown ⇒ D-C pass-through. |
| `nodes[].label` | string | no | ≤80 chars, truncated. Absent ⇒ renderer falls back to `kind`. |
| `nodes[].config` | object | no | Opaque to the graph layer; interpreted only by the node's registry entry. **Never executed as instruction.** |
| `edges` | `FlowGraphEdge[]` | yes | 0..48. |
| `edges[].from`/`.to` | string | yes | Must reference an existing `nodes[].id`; a dangling reference drops that edge. |
| `edges[].label` | string | no | ≤24 chars. |

**Approval-hash treatment — THE BYTE-IDENTITY RULE (critical).** `flow` is added to
`canonicalApprovalPayload` (registry.ts:246–280) **omitted-when-absent**, exactly as
`effort` (251), `learning` (264) and `review` (277) are:

```ts
...(m.flow !== null ? { flow: canonicalFlowJson(m.flow) } : {}),
```

placed **last** in the literal, after `review`. `canonicalFlowJson` emits nodes and edges
in manifest array order, keys in fixed order, `config` omitted when empty. A manifest
written before `## Flow` existed has `flow === null`, contributes nothing, and hashes
**byte-identical to before** — so no existing approval breaks. This is the answer to "what
happens to a manifest written before `## Flow` existed": it keeps its approval, renders a
DERIVED flow (`deriveFlowFromManifest`), and is never blocked by the upgrade.
`flow` also goes into `APPROVAL_DIFF_FIELDS` (types.ts:424–433), same position, so
`approve` diffs it.

### 3.2 Backend — `src/lib/automations/`

| File | Change |
|---|---|
| **`types.ts`** (608) | **MODIFY.** Add `FlowGraph`, `FlowGraphNode`, `FlowGraphEdge`, `KNOWN_NODE_KINDS` (a const array — `kind` stays `string`, deliberately not a closed union, per D-C). Add `flow: FlowGraph \| null` to `AutomationManifest` (after `pattern`:156, before `path`:157). Add `flow` to `ApprovalPayloadFields` (364–383) and `'flow'` last in `APPROVAL_DIFF_FIELDS` (424–433). Add `QueuedFire`, `HITL_CHANNELS = ['chat','telegram'] as const`, `AutomationQuestion` + its state consts. **Remove** `ReviewCard` (264–316), `ReviewSteer` (250–261), `REVIEW_VERDICTS` (234), `REVIEW_CARD_STATES` (238), `REVIEW_DIR` (319), `REVIEW_STEER_LIMIT` (324), `REVIEW_BODY_MAX_CHARS` (327) — ONLY after the HITL types that replace them land. **Keep `REVIEW_MODES` (53) and `AutomationManifest.review` (150) exactly as they are** (D-H). Keep `AUTOMATIONS_REVIEW_GITIGNORE_ENTRIES` (342) + `_ROOT` (343) and its 328–341 doc VERBATIM in substance, repointed at `automations/hitl/` — the reason they sit outside `AUTOMATIONS_GITIGNORE_ENTRIES` is unchanged. |
| **`store.ts`** (883) | **MODIFY.** Add `parseFlowSection(content): FlowGraph \| null` (lenient: bad JSON, wrong `version`, empty `nodes` ⇒ `null`) over `extractSection(content,'Flow')`. Add `writeFlowSection(contextRoot, slug, graph)` via `upsertSection`. Add `deriveFlowFromManifest(m): FlowGraph` — the pre-`## Flow` fallback: `trigger(schedule) → agent(title) → [hitl when review !== 'off'] → report(outputDir)`. Wire `flow` into the manifest read in `getAutomation`. |
| **`registry.ts`** (441) | **MODIFY, surgically.** Add `canonicalFlowJson(g)`. Add the omit-when-null `flow` line to `canonicalApprovalPayload` (246–280), LAST, with a comment matching the existing three. Add `flow` to `approvalFields` (294–313) — always present there (DISPLAY shape). Add `approvalDiff(stored, current)` returning the field-by-field diff D-K needs. **No change** to `checkApproval` (333–344) or `approveAutomation` (349–364). |
| **`flow-registry.ts`** | **CREATE ~140.** `FlowNodeEntry { glyph, variant, describe(node), execute?, defaultSpan }`; `NODE_REGISTRY: Record<string, FlowNodeEntry>` (**open**); `nodeEntry(kind)` → generic fallback for unknown. Module doc must state the deliberate difference from `chartRegistry`'s closed record. |
| **`flow-runner.ts`** | **CREATE ~180.** `executeFlow(graph, ctx)` — walks the ranked graph, dispatches each node to `nodeEntry(kind).execute`, passes through unknown kinds with a log line. Called from `runner.ts` ONLY when `manifest.flow !== null`; a null flow runs today's single-prompt path byte-for-byte. |
| **`queue.ts`** | **CREATE ~150.** `~/.dreamcontext/automations-queue.json` (0600). `enqueueFire` (overwrite-by-key = D9's drop-the-older), `drainQueue`, `queuedFire`, `clearQueuedFire`. Same mechanics as `card-registry.ts`: never-throw reads, temp+rename, TTL prune on write. |
| **`hitl.ts`** | **CREATE ~260, replacing `review.ts`.** `AutomationQuestion` = the ReviewCard shape minus queue semantics. Files at `automations/hitl/<slug>/<id>.json`, O_EXCL claim lock, `pendingQuestion(contextRoot, slug)` — what the runner's serial gate reads. |
| **`session-registry.ts`** | **CREATE ~130, replacing `card-registry.ts`.** `~/.dreamcontext/automations/<slug>.sessions.json`, 0600, 90-day TTL. `recordAutomationSession` (RUNNER-ONLY writer), `readAutomationSession`, `latestBoundSession`. Carry `card-registry.ts`'s header threat model over in substance — do not make a future reader re-derive it. |
| **`verdict.ts`** (832) | **MODIFY.** Repoint `authoritativeSession` (443–450) at `readAutomationSession`. Repoint `resumeWithVerdict` (467) / `applySteer` (697) at `hitl.ts`. **DO NOT TOUCH** `buildResumeArgs` (381–397), `spawnResume` (343–379), claim-before-spawn (593–609), reopen-only-on-`not-spawned` (614–629) — four review rounds of ordering, and the machinery D2 says to reuse. Add `resumeWithAnswer(...)` as a thin adapter so chat and Telegram share one resume path. |
| **`review.ts`** (535) | **DELETE**, after `hitl.ts` absorbs `pendingReviewCard`'s gate semantics, `claimReviewCard`'s O_EXCL claim, `refreshReviewCard`'s disk-is-authority read, and `backfillCardSession`. |
| **`card-registry.ts`** (127) | **DELETE**, after `session-registry.ts` lands and `verdict.ts` is repointed. |
| **`runner.ts`** (1241) | **MODIFY.** Step 2 (741–747): split `never-approved` ⇒ `blocked` (unchanged) from `manifest-changed`/`payload-format-changed` ⇒ the D-B/D-K question spawn. Step 4.5 (800–806): `pendingReviewCard` → `pendingQuestion`; carry the 786–799 comment over verbatim. Step 5 (808–813): on lock-busy, `enqueueFire` before returning `deferred`. 960–1041: card decision → question decision; `recordCardSession` → `recordAutomationSession`. 854–855: `composePrompt` gains the flow block when `manifest.flow !== null`. **DO NOT TOUCH** `executeClaudeDetached` (455–508); **never import `killRunGroup` (1113) into tick**. |
| **`tick.ts`** (233) | **MODIFY.** At 150–157, before the `isDue()` loop, `drainQueue(projectRoot, home)` and run drained fires first (original `firedAt`, catch-up-bounded). Replace the single global Telegram poll (178) with a per-slug loop over `~/.dreamcontext/telegram/*.json`, each with its own persisted `offset`. |
| **`telegram.ts`** (440) | **MODIFY.** `~/.dreamcontext/telegram.json` → `~/.dreamcontext/telegram/<slug>.json`, 0600. Layer-1 auth gate (drop any update whose chat id ≠ authorized) **unchanged**, now per-bot. Per-bot `offset` in the same file. `readTelegramConfig(slug, home)` / `writeTelegramConfig(slug, cfg, home)`. One-shot migration: an existing global `telegram.json` is COPIED to the first automation that requests one, then **left in place** — deleting a user's only bot token on upgrade is not recoverable. |
| **`schedule.ts`** (174) | **NO CHANGE.** `isDue()`'s `already-ran`/`not-yet`/`outside-catchup` contract is what bounds the queue; changing it moves watermark semantics. |
| **`session.ts`** (122) | **NO CHANGE.** `resolveRunSession` (50–78) reused verbatim by D-E; its newest-first "do not reverse" invariant is what makes "latest session" correct. |
| `notifier.ts`, `launchd.ts`, `sharing.ts`, `snapshot.ts`, `consumption.ts` | **NO CHANGE** (compile-only impact from the added `flow` field). |

### 3.3 Server — `src/server/`

| File | Change |
|---|---|
| **`routes/automations.ts`** (681) | **MODIFY.** Delete `GET /api/automations/review` + `POST /api/automations/review/:id`. Add `GET /api/automations/:slug/flow`, `GET /api/automations/questions`, `POST /api/automations/questions/:id`, `GET/POST /api/automations/:slug/telegram`, `GET /api/automations/queue`. **Registration ORDER is load-bearing** — every new literal sub-path (`questions`, `queue`) goes BEFORE the `:slug` routes; extend `automations-route.test.ts` + `automations-dispatcher-route.test.ts` to pin them. |
| **`automation-job.ts`** (86) | **MODIFY.** The single run-now job per contextRoot (:47) stays; on rejection it now `enqueueFire`s instead of dropping. |
| **`routes/agent-sessions.ts`** | **MODIFY.** `SavedMeta` gains `kind?: SessionKind` and `automation?: { slug, runFiredAt }` so D7's restore knows which tabs are automation runs. |

### 3.4 Dashboard

| File | Change |
|---|---|
| `components/automations/AutomationsReviewQueue.tsx` (162) + `.css` (207) | **DELETE.** |
| `components/automations/AutomationFlowCanvas.tsx` | **CREATE ~120.** Calls `layoutFlow()`, renders `<FlowDiagram spec={…} />`. PRIMARY visual of the detail screen (D4). |
| `components/automations/flowLayout.ts` | **CREATE ~200.** Pure `layoutFlow(graph): FlowSpec` per D-F. Zero DOM, zero React. |
| `components/automations/AutomationDetailPanel.tsx` (523) | **MODIFY.** Flow canvas first; prompt demoted to a collapsed `<details>`; reports + last-run summaries below; Telegram credentials banner (mirroring `LabCredentialsBanner.tsx`); the never-approved approve screen (D-A path 3). |
| `components/automations/AutomationCard.tsx` (200) + `.css` | **MODIFY.** Last fire time, last status, **and a short summary of the last report** (D5) from `RunEvent` + `extractNotificationSummary`. One click opens the session as a chat tab. |
| `components/automations/AutomationsBoard.tsx` (157) | **MODIFY.** Remove the review-queue mount; add the never-approved row. |
| `components/about/FlowDiagram.tsx` | **MODIFY, ADDITIVE ONLY.** Add `unknown` to the variant union + CSS (dashed). No behaviour change for existing specs. |
| `hooks/useAutomations.ts` (471) | **MODIFY.** Delete `useReviewQueue` (5s poll) + `useAnswerReviewCard`. Add `useAutomationFlow`, `useAutomationQuestions`, `useAnswerQuestion`, `useAutomationTelegram`, `useSetAutomationTelegram`. `AutomationManifestDetail` gains `flow`. |
| `components/agent/AgentSurface.tsx` (2170) | **MODIFY.** `SessionKind` gains `'automation'`. Sites ~112, 352, 358, 420 (`spawn`), 509 (`resumeSession`), 626, 1066, 1140, 1710; hydration 321–373 gains the D-I watermark drain; `openAutomationRunChat` (939–1004) already dedupes by `claudeId` — extend it to title tabs `<name> · <run date>`. |
| `components/agent/AgentTabs.tsx` | **MODIFY.** 138, 163, 166–173 — fourth glyph `⬡`. |
| `lib/agentSession.ts` (:68), `components/agent/AgentDock.tsx`, `lib/agentStatus.ts` + CSS | **MODIFY.** Fourth kind through every switch + `data-session-kind` selectors. |
| `components/agent/ChatPane.tsx` (1485) | **MODIFY.** Inline HITL question card in the message stream (D-G), below `AutomationRunHeader` (1329–1335). |
| `components/agent/ChatPaneHost.tsx` | **MODIFY.** Thread the question payload through. |
| `lib/automationCreateChat.ts` | **CREATE.** D3 bridge, following `delegateAgent.ts`/`automationRunChat.ts`. |

### 3.5 CLI, skill docs, verify

| File | Change |
|---|---|
| `src/cli/commands/automations.ts` (1488) | **MODIFY.** `review` verb → `questions`/`answer`. `telegram setup/test/off` gain a required `<slug>`. New `flow <slug>` (print/validate). `create` writes a `## Flow` block. |
| `skill/SKILL.md` | **MODIFY.** Capabilities row + **Entity Router** row for chat-first creation. NEVER `.claude/skills/` — installed copies are clobbered. |
| `skill/references/automations.md` | **MODIFY.** Flow schema, HITL semantics, per-automation Telegram, the queue, the three approval paths. |
| `skill/references/sleep.md` + `agents/sleep-*.md` | **MODIFY.** Name the owning specialist for `automations/hitl/` artifacts. |
| `scripts/verify/automations.mjs` | **CREATE.** Scratch vault + fake HOME; four checkpoints. |
| 23 test files | **MODIFY** per the map. |

---

## 4. DEPENDENCY MAP

Safety rules applied: same file → never two tasks in one wave; every cross-task interface
pinned; max 3 concurrent per wave.

| task | files owned | depends on | wave | contract |
|---|---|---|---|---|
| **T1 — Flow types + contract root** | `src/lib/automations/types.ts` | — | 1 | `interface FlowGraph { version: 'automation-flow/v1'; nodes: FlowGraphNode[]; edges: FlowGraphEdge[] }` · `interface FlowGraphNode { id: string; kind: string; label?: string; config?: Record<string, unknown> }` · `interface FlowGraphEdge { from: string; to: string; label?: string }` · `AutomationManifest.flow: FlowGraph \| null` · `ApprovalPayloadFields.flow: FlowGraph \| null` · `APPROVAL_DIFF_FIELDS` gains `'flow'` LAST · `interface QueuedFire { slug: string; firedAt: string; enqueuedAt: string }` · `HITL_CHANNELS = ['chat','telegram'] as const` · `interface AutomationQuestion { id; slug; runFiredAt; sessionId: string\|null; channel: 'chat'\|'telegram'; question: string; choices: string[]; state: 'pending'\|'answered'\|'expired'; answeredAt: string\|null; answeredVia: ReviewChannel\|null; answer: string\|null; resolutionNote: string\|null; resolutionError: string\|null }` |
| **T2 — Machine-local run queue** | `src/lib/automations/queue.ts`, `tests/unit/automations-queue.test.ts` | — | 1 | `enqueueFire(projectRoot: string, slug: string, firedAt: string, home?: string): void` (overwrite-by-slug) · `queuedFire(projectRoot: string, slug: string, home?: string): QueuedFire \| null` · `drainQueue(projectRoot: string, home?: string): QueuedFire[]` · `clearQueuedFire(projectRoot: string, slug: string, home?: string): void` · path `~/.dreamcontext/automations-queue.json`, 0600 |
| **T3 — Session binding store** | `src/lib/automations/session-registry.ts`, `tests/unit/automations-session-registry.test.ts` | — | 1 | `recordAutomationSession(slug: string, sessionId: string\|null, home?: string, nowMs?: number): boolean` · `readAutomationSession(slug: string, sessionId: string, home?: string): string \| null` (null on slug mismatch) · `latestBoundSession(slug: string, home?: string): string \| null` · path `~/.dreamcontext/automations/<slug>.sessions.json`, 0600, 90-day TTL |
| **T4 — Flow parse/write/derive in store** | `src/lib/automations/store.ts`, `tests/unit/automations-store.test.ts` | T1 | 2 | `parseFlowSection(content: string): FlowGraph \| null` · `writeFlowSection(contextRoot: string, slug: string, g: FlowGraph): void` · `deriveFlowFromManifest(m: AutomationManifest): FlowGraph` · `getAutomation` returns `flow` |
| **T5 — Approval hash + node registry** | `src/lib/automations/registry.ts`, `src/lib/automations/flow-registry.ts`, `tests/unit/automations-registry.test.ts`, `tests/unit/automations-flow-registry.test.ts` | T1 | 2 | `canonicalFlowJson(g: FlowGraph): string` · `canonicalApprovalPayload` gains `...(m.flow !== null ? { flow: canonicalFlowJson(m.flow) } : {})` **LAST** · `approvalDiff(stored: ApprovalPayloadFields, current: ApprovalPayloadFields): string` · `nodeEntry(kind: string): FlowNodeEntry` (unknown ⇒ generic) · `NODE_REGISTRY: Record<string, FlowNodeEntry>` **open record** |
| **T6 — HITL question store** | `src/lib/automations/hitl.ts`, `tests/unit/automations-hitl.test.ts` | T1 | 2 | `pendingQuestion(contextRoot: string, slug: string): AutomationQuestion \| null` · `createQuestion(contextRoot, input): AutomationQuestion` · `claimQuestion(contextRoot, q, answer, via, nowISO)` O_EXCL · `refreshQuestion(contextRoot, q)` · files at `automations/hitl/<slug>/<id>.json` |
| **T7 — Verdict repoint + answer adapter** | `src/lib/automations/verdict.ts`, `tests/unit/automations-verdict.test.ts` | T3, T6 | 3 | `resumeWithAnswer(contextRoot: string, q: AutomationQuestion, answer: string, via: ReviewChannel, opts?: VerdictOptions): Promise<VerdictOutcome>` · `authoritativeSession` reads `readAutomationSession` · `buildResumeArgs` **UNCHANGED** |
| **T8 — Flow execution** | `src/lib/automations/flow-runner.ts`, `tests/unit/automations-flow-runner.test.ts` | T4, T5 | 3 | `executeFlow(graph: FlowGraph, ctx: FlowExecContext): Promise<FlowExecResult>` · unknown kind ⇒ `{ passedThrough: true }` + log; never throws, never silently skips |
| **T9 — Per-automation Telegram** | `src/lib/automations/telegram.ts`, `tests/unit/automations-telegram.test.ts` | T3 | 3 | `readTelegramConfig(slug: string, home?: string): TelegramConfig \| null` · `writeTelegramConfig(slug: string, cfg: TelegramConfig, home?: string): void` (0600, gitignore-FIRST ordering per `writeCredential`) · path `~/.dreamcontext/telegram/<slug>.json` · per-bot `offset` |
| **T10 — Runner lifecycle** | `src/lib/automations/runner.ts`, `tests/unit/automations-runner.test.ts`, `tests/unit/automations-review-gate.test.ts`→`automations-hitl-gate.test.ts` | T2, T6, T7, T8 | 4 | Step 2 splits `never-approved`(blocked) from `manifest-changed`(question spawn, `--permission-mode default`, 2-min cap, runner-rendered diff) · step 4.5 reads `pendingQuestion` · step 5 lock-busy ⇒ `enqueueFire` then `deferred` · `executeClaudeDetached` + `killRunGroup` untouched |
| **T11 — Tick: drain + multi-bot poll** | `src/lib/automations/tick.ts`, `tests/unit/automations-tick.test.ts`, `tests/unit/automations-no-auto-reap.test.ts` | T2, T9 | 4 | `drainQueue` before the `isDue()` loop; drained fires keep their ORIGINAL `firedAt` and are catch-up-bounded; per-slug Telegram poll; **still no `killRunGroup` import** |
| **T12 — Delete review + card-registry** | `src/lib/automations/review.ts` (D), `src/lib/automations/card-registry.ts` (D), `tests/unit/automations-review-store.test.ts` (D), `tests/unit/automations-card-registry.test.ts` (D) | T6, T7 | 4 | No remaining import of `./review.js` or `./card-registry.js` anywhere in `src/` — grep-asserted in T20 |
| **T13 — Server routes** | `src/server/routes/automations.ts`, `src/server/automation-job.ts`, `tests/unit/automations-route.test.ts`, `tests/unit/automations-dispatcher-route.test.ts` | T2, T6, T9 | 5 | `GET /api/automations/:slug/flow` → `{ flow: FlowGraph\|null; derived: boolean }` · `GET /api/automations/questions` → `{ questions: AutomationQuestion[] }` · `POST /api/automations/questions/:id` `{ answer: string }` · `GET/POST /api/automations/:slug/telegram` · `GET /api/automations/queue` · **literal sub-paths registered BEFORE `:slug`** |
| **T14 — Layout engine** | `dashboard/src/components/automations/flowLayout.ts`, `tests/unit/automations-flow-layout.test.ts` | T1 | 5 | `layoutFlow(g: FlowGraph): FlowSpec` — pure, deterministic, no DOM. Constants `NODE_W=168, NODE_H=56, RANK_GAP=88, LANE_GAP=24` (all ÷4). Cycle-safe. Uses `makeLink` from `flow-geometry.ts` |
| **T15 — Fourth session kind** | `dashboard/src/lib/agentSession.ts`, `dashboard/src/components/agent/AgentTabs.tsx`, `dashboard/src/components/agent/AgentDock.tsx`, `dashboard/src/lib/agentStatus.ts` + their CSS | — | 5 | `type SessionKind = 'agent' \| 'shell' \| 'chat' \| 'automation'` · glyph map `◇ / >_ / ◆ / ⬡` · `data-session-kind="automation"` in every CSS keyed on it |
| **T16 — Flow canvas + FlowDiagram variant** | `dashboard/src/components/automations/AutomationFlowCanvas.tsx`, `dashboard/src/components/about/FlowDiagram.tsx` (+CSS) | T14, T5 | 6 | `<AutomationFlowCanvas graph={FlowGraph} />` · `FlowNode.variant` gains `'unknown'` (dashed). ADDITIVE only — existing specs unchanged |
| **T17 — Hooks + review-queue removal** | `dashboard/src/hooks/useAutomations.ts`, `dashboard/src/components/automations/AutomationsReviewQueue.tsx` (D) + `.css` (D), `dashboard/src/components/automations/AutomationsBoard.tsx` | T13 | 6 | `useAutomationFlow(slug)` · `useAutomationQuestions()` · `useAnswerQuestion()` · `useAutomationTelegram(slug)` / `useSetAutomationTelegram()` · `useReviewQueue`/`useAnswerReviewCard` REMOVED |
| **T18 — Chat surface: kind, restore, question card** | `dashboard/src/components/agent/AgentSurface.tsx`, `dashboard/src/components/agent/ChatPane.tsx`, `dashboard/src/components/agent/ChatPaneHost.tsx`, `src/server/routes/agent-sessions.ts` | T15, T13 | 7 | `spawn(bypass, sessionId, resume, kind: SessionKind)` accepts `'automation'` · `openAutomationRunChat` titles `"<name> · <YYYY-MM-DD>"`, dedupes by `claudeId` · hydration (321–373) drains the D-I watermark `~/.dreamcontext/automations-tabs.json` · `SavedMeta` gains `kind?` + `automation?` · inline question card in the message stream |
| **T19 — Cards, detail screen, creation-chat bridge** | `dashboard/src/components/automations/AutomationCard.tsx` (+CSS), `dashboard/src/components/automations/AutomationDetailPanel.tsx` (+CSS), `dashboard/src/components/automations/AutomationsEmptyState.tsx`, `dashboard/src/lib/automationCreateChat.ts` (new) | T16, T17 | 7 | Card shows last fire + status + **report summary**; detail = flow first, prompt collapsed. Bridge follows `delegateAgent.ts`/`automationRunChat.ts`: `AUTOMATION_CREATE_CHAT_EVENT` + `interface AutomationCreateChatDetail { accepted?: boolean }`, synchronous ACK read |
| **T20 — CLI verbs** | `src/cli/commands/automations.ts`, `tests/integration/automations-cli.test.ts` | T4, T6, T9, T12 | 8 | `automations questions [slug]` · `automations answer <id> <answer>` · `automations telegram setup <slug>` (slug REQUIRED) · `automations flow <slug>` · `create` writes `## Flow` · grep assertion: zero `review.js`/`card-registry.js` imports |
| **T21 — Runtime verify script** | `scripts/verify/automations.mjs` | T18, T19, T20 | 9 | Scratch vault + fake `HOME`; real server + UI. Asserts in order: (a) create-through-chat writes a manifest with a valid `## Flow`; (b) the detail screen renders ≥4 flow nodes at `layoutFlow`-predicted coords; (c) a HITL question renders inline in the chat pane and answering it resumes; (d) a completed run opens as a tab with `data-session-kind="automation"` titled `<name> · <date>`. Exit non-zero on any failure |
| **T22 — Feature-integration checklist** | `skill/SKILL.md`, `skill/references/automations.md`, `skill/references/sleep.md`, `agents/sleep-*.md`, `tests/unit/automations-skill.test.ts` | T20, T21 | 9 | All 9 items of `knowledge/patterns/feature-integration-pattern.md`: capabilities row · Entity Router row · reference section · sleep wiring naming the owner of `automations/hitl/` · sub-agent scan (decision recorded even when "not relevant") · skill-pack scan · two-way cross-refs · marker test extended · `dreamcontext update` |
| **T23 — Test sweep** | `tests/unit/automations-sharing.test.ts`, `automations-snapshot-section.test.ts`, `automations-consumption.test.ts`, `automations-pattern.test.ts`, `automations-process-group.test.ts`, `automations-notifier.test.ts`, `automations-launchd.test.ts`, `automations-session-summary.test.ts`, `automations-schedule.test.ts` | T20 | 9 | Every file compiles against the new `AutomationManifest` (added `flow`). Behavioural assertions UNCHANGED — these tests must NOT be weakened to pass |

**Waves:** W1 = T1,T2,T3 · W2 = T4,T5,T6 · W3 = T7,T8,T9 · W4 = T10,T11,T12 ·
W5 = T13,T14,T15 · W6 = T16,T17 · W7 = T18,T19 · W8 = T20 · W9 = T21,T22,T23.

---

## 5. ACCEPTANCE CRITERIA (each provable by running something)

**Approval / capability**
1. A manifest with `flow === null` produces a `canonicalApprovalPayload` string
   byte-identical to the pre-change implementation's output for the same manifest.
2. A manifest with non-null `flow` hashes differently from the same manifest with
   `flow: null` — asserted by direct comparison.
3. `checkApproval` → `never-approved` produces `status: 'blocked'` and **zero**
   `spawnImpl` invocations (injected spy, call count `0`).
4. `checkApproval` → `manifest-changed` on a previously-approved slug produces exactly one
   spawn whose argv contains `--permission-mode default` and NOT `bypassPermissions`.
5. `grep -rn "from './review.js'\|from './card-registry.js'" src/` returns zero lines.
6. `readAutomationSession('slug-a', <id bound to slug-b>, home)` returns `null`.

**Queue (D9)**
7. `enqueueFire(root,'x','T1')` then `enqueueFire(root,'x','T2')` → `queuedFire(root,'x')`
   has `firedAt === 'T2'`; the file contains exactly one entry for `x`.
8. `automations-queue.json` mode is `0600` (`statSync().mode & 0o777 === 0o600`).
9. `grep -rn "automations-queue" _dream_context/` returns zero lines.
10. A run refused by the per-slug lock returns `deferred` AND leaves a queue entry; a run
    refused as `orphaned` returns `orphaned` and leaves NO queue entry.
11. Draining a queued fire older than `catchupHours` does not spawn (spy count `0`) and
    logs `outside-catchup`.

**Flow**
12. `parseFlowSection` returns `null` for each of: malformed JSON, `version:
    "automation-flow/v2"`, `nodes: []`, missing section (four assertions).
13. `layoutFlow` called twice on the same graph returns `JSON.stringify`-equal specs.
14. `layoutFlow` on a cyclic graph returns without throwing and emits every node once.
15. `nodeEntry('a-kind-that-does-not-exist')` returns the generic entry with
    `variant: 'unknown'`; `executeFlow` over a graph containing it resolves with
    `passedThrough: true` and does not throw.
16. Every `x`, `y`, `w`, `h` in `layoutFlow`'s output is divisible by 4.

**Chat surface**
17. `SessionKind` has exactly four members; `AgentTabs` renders `⬡` for
    `kind: 'automation'`.
18. Calling `openAutomationRunChat` twice with the same `claudeId` yields exactly one tab.
19. `npm run build` exits `0` (catches any missed switch site of the ~dozen in D6).

**Telegram**
20. `writeTelegramConfig('x', cfg, home)` creates `<home>/.dreamcontext/telegram/x.json`
    at mode `0600`, and the gitignore entry exists BEFORE the file is written.
21. An update whose chat id ≠ the authorized id is dropped and does not advance `offset`.
22. `latestBoundSession` on a cache whose newest run has `sessionId: null` but whose
    second-newest has one returns the second-newest's id.

**End to end**
23. `npm test` exits `0`.
24. `npm run build` exits `0`.
25. `node scripts/verify/automations.mjs` exits `0` and prints its four named checkpoints.
26. That script run with `HOME` pointed at a scratch dir leaves the real `~/.dreamcontext`
    byte-unchanged (hash before/after).

**Integration wiring**
27. `npm test -- automations-skill` passes with the updated Entity Router count.
28. `skill/SKILL.md` has both a capabilities row and an Entity Router row for automations;
    `skill/references/automations.md` contains the literal string `automation-flow/v1`.

---

## 6. ASSUMPTIONS (flagged, not asserted)

- **A1.** Files read in full and line-verified: `types.ts`, `registry.ts`,
  `card-registry.ts`, `session.ts`, `verdict.ts`, `runner.ts`. **NOT opened this session:**
  `store.ts`, `review.ts`, `telegram.ts`, `tick.ts`, `schedule.ts`, `snapshot.ts`,
  `consumption.ts`, server routes, CLI, every dashboard file. Their line numbers come from
  the recon brief. **The implementer MUST re-verify every line number in §3 for those
  files before editing.**
- **A2.** `extractSection`/`upsertSection` handle a fenced JSON block inside a `## X`
  section without mangling the fence. If not, `parseFlowSection` needs a fence-aware
  extractor and T4 grows.
- **A3.** The Chat view has an existing inline question-card component (D-G depends on it).
  If not, T18 builds one — still in the chat message-stream idiom, never as a ported
  review card.
- **A4.** `FlowDiagram`'s `variant` union is a plain TS union with a matching CSS class per
  member.
- **A5.** No automation manifests exist on this machine, so migration is untested by
  absence. The `flow === null` byte-identity rule (criterion 1) is the only thing between
  an upgrade and mass re-approval — **it must be tested against a fixture manifest, not
  against the empty vault.**

---

## 7. PLANNER CORRECTION PASS (verified against real code — supersedes §3/§4 where they conflict)

Recorded by the fork-base planner session `834fb40a-829b-4cdd-83cd-7666f538dd4e`.
Every item below was checked against the actual file. Assumption A1 is now RESOLVED.

### C1 — SEVEN WRONG PATHS. The chat surface lives in `dashboard/src/components/sleepy/`, NOT `components/agent/` or `lib/`.
- `sleepy/AgentSurface.tsx` (2170 ✓), `sleepy/ChatPane.tsx` (1485 ✓), `sleepy/AgentTabs.tsx` (234),
  `sleepy/AgentDock.tsx` (150), `sleepy/ChatPaneHost.tsx` (96), `sleepy/agentSession.ts` (738),
  `sleepy/agentStatus.ts` (116).
- `lib/automationRunChat.ts` (128) and `lib/delegateAgent.ts` (151) ARE in `dashboard/src/lib/` ✓.
- **T15, T18, T19 owned-file lists are corrected accordingly.**

### C2 — T13 omits the file that owns the load-bearing route ORDER.
Registration is `src/server/index.ts:457–480`, not `routes/automations.ts`. Review routes 471–472;
`:slug` routes begin 475. **`src/server/index.ts` is added to T13's owned files.**

### C3 — `store.ts`: wrong edit site.
`flow` must be read in **`readAutomationFile` (199–245)**, not `getAutomation` (417–425, a delegator).
`extractSection(body, heading)` is at **136–145** (body-first ✓). `upsertSection` **387–399** ✓.
A2 HOLDS: both line-scan on `/^##\s/`, so a fenced JSON block survives — but **`parseFlowSection`
must strip the ``` fences itself.**

### C4 — `RESERVED_SLUGS` (types.ts:417) is `['cache','output','review']` and the plan never mentions it.
Renaming `review/`→`hitl/` **requires adding `'hitl'`**; dropping `'review'` would let a slug collide
with an existing directory. **T1 owns this.** Everything else in the types row verified exact.

### C5 — T6's `hitl.ts` contract is FAR too small (blocking).
`review.ts` exports 18 symbols. Importers: `verdict.ts` 10 (lines 46–57), `telegram.ts` 5 (30–35),
`runner.ts` 3 (12), routes 2 (33), **`snapshot.ts:5`**. T6 listed 4.
Minimum additional exports: `noteResolution`, `reopenReviewCard`, `resolveReviewCard`, `recordSteer`,
`writeReviewCard`, `allPending*`, `setChannelRef`, `canResume`, `backfillCardSession`, `listReviewCards`.
**`snapshot.ts` is NOT "NO CHANGE" — it imports `pendingReviewCard` and must be repointed.**

### C6 — `telegram.ts` is under-scoped (blocking).
Verified anchors: `readTelegramConfig` 55–69, `writeTelegramConfig` 74–81, auth gate 302–305,
offset 297/323. But **`renderCardText` (113), `renderKeyboard` (134), `emitPendingCards` (153),
`editCardInPlace` (175), `finalizeCardMessage` (192), `findCardById` (257), `handleCallback` (327),
`handleSteerMessage` (363), `describeTelegram` (422)** all take `ReviewCard` and all need repointing.
Changing the signature to `readTelegramConfig(slug, home)` **breaks `tick.ts:44` `defaultPollTelegram`
and `TickOptions.pollTelegram` (69)** — which `automations-tick.test.ts` injects. T9 and T11 must
co-ordinate on that seam; the contract is pinned in the revised map.

### C7 — Acceptance criterion #20 is UNACHIEVABLE as written; corrected.
`writeCredential` (credentials.ts:66–103) is gitignore-first because it writes **into the brain**.
`~/.dreamcontext/telegram/<slug>.json` is in HOME — there is no governing `.gitignore` and none should
be created. **Criterion #20 becomes: 0600 mode + write-to-tmp-then-rename, mirroring telegram.ts:74–81.
The gitignore clause is struck.**

### C8 — T14/D-F: the layout math was wrong TWICE (blocking).
1. `makeLink` (flow-geometry.ts:37) takes `Record<string, Box>` where `Box = {cx, cy, w, h}` —
   **centre-based**, while `FlowNode` is top-left `x/y`. `layoutFlow` must build BOTH maps.
2. `bow` is a **fraction of edge length** (`cx = mx + -dy*bow*len`, line 50); real specs use 0.06–0.45.
   The plan's "±18 alternating" would throw wires ~18× the edge length off-canvas.
   **Corrected: `bow` 0 for straight adjacent runs, ±0.12 alternating for rank-skipping edges.**

### C9 — T16: `FlowEdge.comet` is opt-OUT, not opt-in (`edge.comet !== false`, FlowDiagram.tsx:161).
A generated graph would animate EVERY wire. **`layoutFlow` must emit `comet: false` explicitly.**
`arrow` is correctly opt-in (159).

### C10 — A4 is half-false. `FlowNodeVariant` is a plain union at FlowDiagram.tsx:23 ✓, but
`FlowDiagram.css` has rect rules for only `hook` (78), `agent` (83), `rem` (88), `accent` (93) —
`region` and `plain` have NONE. Adding `unknown` means **authoring a new rule**, not mirroring one.

### C11 — T18: `SavedMeta` already has `kind?`, and the SERVER silently drops it (blocking for D7).
Client `SavedMeta` (AgentSurface.tsx:148) has `kind?: SessionKind` and PUTs it (388); **server**
`SavedMeta` (`src/server/routes/agent-sessions.ts:29–36`) has only 5 fields and **`coerceMeta` (60)
strips everything else**. So hydration's `m.kind === 'shell' ? 'shell' : claudeKind` (352) can never
see a persisted kind. **The server side must be fixed or D7 restore cannot distinguish automation tabs.**

### C12 — Corrected AgentSurface anchors (all under `sleepy/`).
`SessionMeta` 78–85 ✓ · `claudeKind` **241** (`chatMode ? 'chat' : 'agent'` — kind is already computed
dynamically; T15 must thread through HERE) · hydration **336–392** (NOT 321–373) · `spawn` 419 ✓ ·
`resumeSession` 502 ✓ · `automationRuns` 937 ✓ · `openAutomationRunChat` 939 ✓ (dedupe 963–970,
`spawn(bypass, sessionId, true, claudeKind)` 971 ✓) · event listener **993–1001** (NOT 998–1004) ·
`SessionKind` agentSession.ts:68 ✓ · glyphs AgentTabs.tsx:173 ✓ with `data-session-kind` at 166.

### C13 — Tab title is an EDIT, not an addition.
Tabs are titled by `automationRunTabTitle(title, runNumber)` → `"<name> · run #1"`.
D7/T18's `"<name> · <date>"` **changes that existing helper**.

### VERIFIED CORRECT AS STATED
All of `runner.ts` (1241; 58/89/105/133/147/187/233/275/301/455–508/566–1090; gates at 741, 750, 763,
800, 808, 826, 854, 923, 960–1041, 980–986, 1053, 1074, 1113 — every one exact), `verdict.ts` 832,
`registry.ts` 441, `card-registry.ts` 127, `session.ts` 122, `store.ts` 883, `tick.ts` 233 (isDue 150,
runImpl 157, poll 178), `schedule.ts` 174, `review.ts` 535, `routes/automations.ts` 681,
`automation-job.ts` 86, `cli/commands/automations.ts` 1488, `useAutomations.ts` 471,
`automationsFlowSpec.ts` 135, all dashboard automations component sizes, and 22 unit + 1 integration
= 23 test files.

---

## 8. REVISED PLAN — round 2 (supersedes §3/§4 wherever they conflict)

Inputs folded in: the planner correction pass (§7, C1–C13), the **pragmatist** lens
(NEEDS_WORK, 5 findings) and the **critic** lens (NEEDS_WORK, 8 findings). Baseline
measured on the clean tree: `npm run build` exit 0.

### 8.1 Design amendments

**A1 — `executeFlow` IS SPAWN-FREE. This resolves D4 vs D-C.** (critic #8, pragmatist #1)
D4 is fixed: "the runner READS this graph and executes it." The pragmatist wanted the
module cut; cutting it violates D4. The resolution both lenses converge on:

> `flow-runner.ts` never spawns a process. `FlowNodeEntry.execute` produces a **text/state
> fragment only**, which `runner.ts`'s existing `composePrompt` (147–157) folds into the
> ONE prompt sent by the ONE existing spawn (`executeClaudeDetached`). `runner.ts` remains
> the only code in the subsystem that spawns `claude`.

The graph therefore genuinely drives the run — it decides what the prompt says, whether a
`hitl` node means the run must ask before publishing, and where the `report` goes — while
D-C's "descriptive, not authoritative" claim becomes literally true: no node, known or
unknown, can acquire capability, because nothing but the single already-approved spawn
executes anything. **T8's contract is amended to state `execute` is spawn-free, and T10
must actually CALL it** (the round-1 plan declared the engine but never wired it — the
pragmatist's core catch).
`FlowNodeEntry` keeps `execute?` but it returns `string | null`, never a process.
T5 re-scoped to ~60–80 lines (describe/render + the fragment hook), not 140.

**A2 — THE D-B QUESTION SPAWN IS NEVER RECORDED AS A BOUND SESSION.** (critic #7 — the
most consequential finding of the round.) The restricted `--permission-mode default`
approval-question spawn must NOT reach `recordAutomationSession`, must NOT be written into
`cache.history[].sessionId`, and must NOT be resolvable by `latestBoundSession`. Otherwise
D-E's Telegram/tab-restore resolution could later resume it through `resumeWithAnswer` →
`buildResumeArgs`, which hardcodes `bypassPermissions` — upgrading a session that was never
approved to run anything into one that can. **T10 owns this**: the question spawn takes a
separate code path that writes no session binding and no run event. Acceptance criterion 29
proves it.

**A3 — `flow` is `FlowGraph | null`, NEVER `undefined`.** (critic #6) `m.flow !== null` is
`true` for `undefined`, which would call `canonicalFlowJson(undefined)` and silently break
the byte-identity hash guarantee for every legacy manifest. T4 must normalize on every read
path. Criterion 1 depends on this.

**A4 — `drainQueue` re-checks `enabled` and existence.** (critic #5 — a real bug.)
`manifest.enabled` is checked ONLY at `tick.ts:144`, inside the per-manifest loop;
`runAutomation()` has no enabled-gate anywhere. Draining before that loop bypasses it, so a
disabled automation with a stale queue entry would run. **T11**: before running a
`QueuedFire`, re-`getAutomation` and check `enabled`; if disabled or missing,
`clearQueuedFire` + log, never `runImpl`.

**A5 — criterion #20 corrected** (planner C7): HOME has no governing `.gitignore`; the
gitignore-first clause is struck and replaced with 0600 + write-tmp-then-rename, mirroring
`telegram.ts:74–81`.

**A6 — T9/T11 seam** (critic #3): T9 adds `readTelegramConfigForSlug(slug, home)` and
`listTelegramSlugs(home)` and LEAVES the global reader/poller intact, so the wave-3 gate
stays green. T11 then migrates `tick.ts`, deletes the transitional globals, and therefore
**owns `telegram.ts` and `tests/unit/automations-telegram.test.ts` as well**.

### 8.2 Revised dependency map

| task | files owned | depends on | wave | contract |
|---|---|---|---|---|
| **T1** Flow types + contract root | `src/lib/automations/types.ts` | — | 1 | `FlowGraph{version:'automation-flow/v1';nodes:FlowGraphNode[];edges:FlowGraphEdge[]}` · `FlowGraphNode{id:string;kind:string;label?:string;config?:Record<string,unknown>}` · `FlowGraphEdge{from:string;to:string;label?:string}` · `AutomationManifest.flow: FlowGraph\|null` · `ApprovalPayloadFields.flow` · `APPROVAL_DIFF_FIELDS` gains `'flow'` LAST · `QueuedFire{slug;firedAt;enqueuedAt}` · `AutomationQuestion{...}` · `HITL_CHANNELS` · **`RESERVED_SLUGS` gains `'hitl'`, keeps `'review'`** (C4) · keeps `REVIEW_MODES` + `.review` (D-H) |
| **T2** Machine-local run queue | `src/lib/automations/queue.ts`, `tests/unit/automations-queue.test.ts` | — | 1 | `enqueueFire(projectRoot,slug,firedAt,home?):void` overwrite-by-slug · `queuedFire(projectRoot,slug,home?):QueuedFire\|null` · `drainQueue(projectRoot,home?):QueuedFire[]` · `clearQueuedFire(projectRoot,slug,home?):void` · `~/.dreamcontext/automations-queue.json` 0600 |
| **T3** Session binding store | `src/lib/automations/session-registry.ts`, `tests/unit/automations-session-registry.test.ts` | — | 1 | `recordAutomationSession(slug,sessionId\|null,home?,nowMs?):boolean` · `readAutomationSession(slug,sessionId,home?):string\|null` (null on slug mismatch) · `latestBoundSession(slug,home?):string\|null` · `~/.dreamcontext/automations/<slug>.sessions.json` 0600, 90-day TTL · slug validated via the existing `isSafeAutomationSlug` |
| **T4** Flow parse/write/derive | `src/lib/automations/store.ts`, `tests/unit/automations-store.test.ts` | T1 | 2 | `parseFlowSection(content):FlowGraph\|null` — **strips ``` fences itself** (C3) · `writeFlowSection(contextRoot,slug,g):void` · `deriveFlowFromManifest(m):FlowGraph` · **read site is `readAutomationFile` (199–245), NOT `getAutomation`** (C3) · **`flow` is `null`, never `undefined`, on every path** (A3) |
| **T5** Approval hash + node registry | `src/lib/automations/registry.ts`, `src/lib/automations/flow-registry.ts`, `tests/unit/automations-registry.test.ts`, `tests/unit/automations-flow-registry.test.ts` | T1 | 2 | `canonicalFlowJson(g):string` · `canonicalApprovalPayload` gains `...(m.flow!==null?{flow:canonicalFlowJson(m.flow)}:{})` **LAST** · `approvalDiff(stored,current):string` · `nodeEntry(kind):FlowNodeEntry` unknown⇒generic · `NODE_REGISTRY:Record<string,FlowNodeEntry>` **open** · **`FlowNodeEntry.execute?:(node)=>string\|null` — SPAWN-FREE** (A1) · ~60–80 lines |
| **T6** HITL question store | `src/lib/automations/hitl.ts`, `tests/unit/automations-hitl.test.ts` | T1 | 2 | **Must export the full 18-symbol surface `review.ts` exports** (C5): `pendingQuestion`, `createQuestion`, `claimQuestion`, `refreshQuestion`, `noteResolution`, `reopenQuestion`, `resolveQuestion`, `recordSteer`, `writeQuestion`, `allPendingQuestions`, `setChannelRef`, `canResume`, `backfillQuestionSession`, `listQuestions` · files at `automations/hitl/<slug>/<id>.json`, O_EXCL claim |
| **T7** Verdict repoint + answer adapter | `src/lib/automations/verdict.ts`, `tests/unit/automations-verdict.test.ts` | T3, T6 | 3 | `resumeWithAnswer(contextRoot,q,answer,via,opts?):Promise<VerdictOutcome>` · `authoritativeSession` reads `readAutomationSession` · **`buildResumeArgs` UNCHANGED** |
| **T8** Flow interpreter | `src/lib/automations/flow-runner.ts`, `tests/unit/automations-flow-runner.test.ts` | T4, T5 | 3 | `executeFlow(graph,ctx):FlowExecResult` — **PURE, SPAWN-FREE, SYNCHRONOUS**; returns prompt fragments + `{needsHitl:boolean; reportTarget:string\|null; warnings:string[]}` for `composePrompt` to fold in · unknown kind ⇒ `{passedThrough:true}` + warning, never throws |
| **T9** Per-automation Telegram (additive) | `src/lib/automations/telegram.ts` | T3 | 3 | **ADDITIVE ONLY — the global reader/poller stays** (A6): `readTelegramConfigForSlug(slug,home?):TelegramConfig\|null` · `writeTelegramConfigForSlug(slug,cfg,home?):void` (0600, tmp+rename) · `listTelegramSlugs(home?):string[]` · `~/.dreamcontext/telegram/<slug>.json` · slug validated via `isSafeAutomationSlug` · repoints the 9 `ReviewCard`-typed helpers (C6) to `AutomationQuestion` |
| **T10** Runner lifecycle | `src/lib/automations/runner.ts`, `tests/unit/automations-runner.test.ts`, `tests/unit/automations-review-gate.test.ts`→`automations-hitl-gate.test.ts` | T2, T5, T6, T7, T8 | 4 | Step 2 (741): `never-approved`⇒`blocked` unchanged; `manifest-changed`⇒question spawn w/ `--permission-mode default`, runner-rendered `approvalDiff`, 2-min cap, **NO session binding, NO run event** (A2) · step 4.5 (800) reads `pendingQuestion` · step 5 (808) lock-busy ⇒ `enqueueFire` then `deferred` · `composePrompt` (854) **calls `executeFlow` and folds its fragments** (A1) · `executeClaudeDetached` untouched |
| **T11** Tick: drain + multi-bot + telegram cutover | `src/lib/automations/tick.ts`, `tests/unit/automations-tick.test.ts`, `tests/unit/automations-no-auto-reap.test.ts`, `src/lib/automations/telegram.ts`, `tests/unit/automations-telegram.test.ts` | T2, T9 | 5 | `drainQueue` before the `isDue()` loop; **re-checks `enabled`+existence, else `clearQueuedFire`** (A4); drained fires keep their ORIGINAL `firedAt`, catch-up-bounded · per-slug poll via `listTelegramSlugs` · deletes the transitional globals · **still no `killRunGroup` import** |
| **T13** Server routes | `src/server/routes/automations.ts`, **`src/server/index.ts`** (C2), `src/server/automation-job.ts`, `tests/unit/automations-route.test.ts`, `tests/unit/automations-dispatcher-route.test.ts` | T2, T4, T6, T9 | 5 | `GET /api/automations/:slug/flow`→`{flow:FlowGraph\|null;derived:boolean}` · `GET /api/automations/questions` · `POST /api/automations/questions/:id {answer}` · `GET/POST /api/automations/:slug/telegram` · `GET /api/automations/queue` · **literal sub-paths registered BEFORE `:slug` at `index.ts:457–480`** |
| **T14** Layout engine | `dashboard/src/components/automations/flowLayout.ts`, `tests/unit/automations-flow-layout.test.ts` | T1 | 5 | `layoutFlow(g):FlowSpec` pure/deterministic · `NODE_W=168,NODE_H=56,RANK_GAP=88,LANE_GAP=24` (÷4) · **builds BOTH top-left `x/y` and centre `Box{cx,cy,w,h}` maps for `makeLink`** (C8) · **`bow` is a FRACTION: 0 straight, ±0.12 rank-skipping** (C8) · **emits `comet:false` explicitly** (C9) · cycle-safe |
| **T15** Fourth session kind | `dashboard/src/components/sleepy/agentSession.ts`, `.../sleepy/AgentTabs.tsx`, `.../sleepy/AgentDock.tsx`, `.../sleepy/agentStatus.ts` + their CSS | — | 5 | `SessionKind='agent'\|'shell'\|'chat'\|'automation'` · glyphs `◇/>_/◆/⬡` at AgentTabs.tsx:173, `data-session-kind` at 166 · **all paths under `components/sleepy/`** (C1) |
| **T16** Flow canvas + FlowDiagram variant | `dashboard/src/components/automations/AutomationFlowCanvas.tsx`, `dashboard/src/components/about/FlowDiagram.tsx` + `FlowDiagram.css` | T5, T14 | 6 | `<AutomationFlowCanvas graph={FlowGraph}/>` · `FlowNodeVariant` (FlowDiagram.tsx:23) gains `'unknown'` · **a NEW `.css` rect rule must be authored — `region`/`plain` have none to copy** (C10) |
| **T17** Hooks + review-queue removal | `dashboard/src/hooks/useAutomations.ts`, `.../automations/AutomationsReviewQueue.tsx` (D) + `.css` (D), `.../automations/AutomationsBoard.tsx` | T13 | 6 | `useAutomationFlow` · `useAutomationQuestions` · `useAnswerQuestion` · `useAutomationTelegram`/`useSetAutomationTelegram` · `useReviewQueue`/`useAnswerReviewCard` REMOVED |
| **T20** CLI verbs | `src/cli/commands/automations.ts`, `tests/integration/automations-cli.test.ts` | T4, T6, T9, T13 | 6 | `questions [slug]` · `answer <id> <answer>` · `telegram setup <slug>` (slug REQUIRED) · `flow <slug>` · `create` writes `## Flow` · **repoints its own `review.js` import (line 52)** |
| **T18a** Kind plumbing + restore | `dashboard/src/components/sleepy/AgentSurface.tsx`, `src/server/routes/agent-sessions.ts` | T13, T15 | 7 | `claudeKind` at **241** must thread `'automation'` · hydration **336–392** drains the D-I watermark · `openAutomationRunChat` 939 (dedupe 963–970) · **server `SavedMeta` (29–36) + `coerceMeta` (60) must stop stripping `kind`** (C11) · **`automationRunTabTitle` is EDITED to `"<name> · <date>"`** (C13) |
| **T19** Cards, detail screen, creation bridge | `.../automations/AutomationCard.tsx`+css, `.../automations/AutomationDetailPanel.tsx`+css, `.../automations/AutomationsEmptyState.tsx`, `dashboard/src/lib/automationCreateChat.ts` (new) | T16, T17 | 7 | Card: last fire + status + **report summary** · detail: flow canvas first, prompt collapsed, Telegram banner, never-approved approve screen · bridge mirrors `lib/delegateAgent.ts`(151)/`lib/automationRunChat.ts`(128): `AUTOMATION_CREATE_CHAT_EVENT` + `{accepted?:boolean}` + synchronous ACK |
| **T18b** HITL question card in chat | `dashboard/src/components/sleepy/ChatPane.tsx`, `.../sleepy/ChatPaneHost.tsx` | T18a, T7, T13 | 8 | Inline question card in the message stream below `AutomationRunHeader` (1329–1335), reading as Claude asking — **not** a ported review card |
| **T12** Migrate last consumers + delete | `src/lib/automations/snapshot.ts`, `src/lib/automations/review.ts` (D), `src/lib/automations/card-registry.ts` (D), `tests/unit/automations-review-store.test.ts` (D), `tests/unit/automations-card-registry.test.ts` (D) | T6, T7, T9, T10, T11, T13, T20 | 9 | **Wave 9, strictly after every one of the six importers is repointed** (critic #1). Repoints `snapshot.ts:5` `pendingReviewCard`→`pendingQuestion` (uses at 54/178/229). **Owns criterion 5's grep proof.** |
| **T21** Runtime verify script | `scripts/verify/automations.mjs` | T18b, T19, T20 | 9 | Scratch vault + fake `HOME`, house style per `scripts/verify/automation-run-chat.mjs`. Four checkpoints: create-through-chat writes a valid `## Flow`; detail screen renders ≥4 nodes at `layoutFlow`-predicted coords; a HITL question renders inline and answering it resumes; a completed run opens as a tab `data-session-kind="automation"` titled `<name> · <date>` |
| **T22** Feature-integration checklist | `skill/SKILL.md`, `skill/references/automations.md`, `skill/references/sleep.md`, `agents/sleep-*.md`, `tests/unit/automations-skill.test.ts` | T20, T21 | 9 | All 9 items of `knowledge/patterns/feature-integration-pattern.md` |
| **T23** Test sweep | `tests/unit/automations-sharing.test.ts`, `automations-snapshot-section.test.ts`, `automations-consumption.test.ts`, `automations-pattern.test.ts`, `automations-process-group.test.ts`, `automations-notifier.test.ts`, `automations-launchd.test.ts`, `automations-session-summary.test.ts`, `automations-schedule.test.ts` | T20 | 9 | Compile against the new `AutomationManifest`. **Behavioural assertions UNCHANGED — never weakened to pass** |

**Waves:** W1 T1,T2,T3 · W2 T4,T5,T6 · W3 T7,T8,T9 · W4 T10 · W5 T11,T13,T14 ·
W5b T15 · W6 T16,T17,T20 · W7 T18a,T19 · W8 T18b · W9 T12,T21,T22,T23.
(T15 has no deps and is scheduled with W5 only if the cap allows; otherwise it runs in W6.)

### 8.3 Added acceptance criteria

29. The D-B approval-question spawn writes **no** session binding and **no** run event:
    after a `manifest-changed` run, `latestBoundSession(slug, home)` returns what it
    returned before, and `cache.history.length` is unchanged. (A2)
30. `executeFlow` never spawns: `tests/unit/automations-flow-runner.test.ts` injects a
    `spawnImpl` spy and asserts call count `0` for a graph containing every known kind. (A1)
31. Draining a queued fire for a **disabled** automation does not spawn and clears the
    entry. (A4)
32. `parseFlowSection` returns a graph for a manifest whose `## Flow` body is inside a
    ```json fence (C3).
33. `layoutFlow` emits `comet: false` on every edge (C9).

---

## 9. SECURITY AMENDMENTS — round 2 (security lens, all VERIFIED by the orchestrator)

The security lens returned NEEDS_WORK with 6 findings. Every load-bearing claim was
re-verified against the real code before being folded in. These amendments OVERRIDE §2/§8
where they conflict.

### S1 — `AutomationQuestion` gains a `kind` discriminator. (security #1 + critic #7 — two
lenses found this hole independently, from different directions.)

Nothing in the round-1 schema distinguished an **approval-diff question** (D-B: must never
be resumed with elevated permissions) from an **in-flow HITL question** (D2: legitimately
resumed). Both render through the same inline card and answer through the same route, so
there was no code-level mechanism stopping the generic handler from calling
`resumeWithAnswer` on a question session — resuming it with `bypassPermissions`, on a
manifest that is at that moment still *unapproved*.

**Amendment (T1 + T13 + T10):**
```ts
kind: 'approval' | 'flow-hitl'
```
- `'approval'` → the answer route calls `approveAutomation(...)` and starts a **fresh**
  `runAutomation`. It NEVER touches `resumeWithAnswer`/`buildResumeArgs`.
- `'flow-hitl'` → the only kind that goes through the verdict machinery.
- The approval-question spawn's session id is **never** passed to
  `recordAutomationSession` and **never** written into `AutomationCache.history` (A2).

### S2 — D-B's spawn is `plan` mode + `--disallowedTools` + a guard prompt, not one flag.
**VERIFIED**: `src/server/routes/sleepy-chat.ts:35–48` documents this codebase's own
precedent for the identical hazard class (headless `-p`, no TTY to approve at) and states
in as many words: *"Read-only is enforced THREE ways (a single flag isn't enough)"* —
`--permission-mode plan` as "the load-bearing guard", `--disallowedTools` to stop fan-out
into sub-agents/skills/background tasks, and a guard system prompt. The concrete invocation
is at `sleepy-chat.ts:314`.

Round-1 D-B used `--permission-mode default` alone, cited no precedent, and is therefore
weaker than established practice. **Amended (T10):** the approval-question spawn uses
`--permission-mode plan --disallowedTools "<the sleepy-chat DISALLOWED_TOOLS list>"
--append-system-prompt "<guard>"`. The runner-rendered diff (D-K) still arrives as quoted
data. D-K's rationale is unchanged — the diff is pre-rendered precisely because a read-only
session cannot go and read the files itself.

### S3 — `src/server/routes/agent-chat.ts` IS the resume gate, and it is automations-blind.
**THE MOST IMPORTANT FINDING OF THE ROUND. VERIFIED LINE BY LINE:**
- `:181` gates only on `isDesktop() && isLoopback(req)`
- `:187` `const bypass = url.searchParams.get('bypass') === '1'`
- `:189` `const resumeId = sanitizeUuid(url.searchParams.get('resume'))`
- `:312` `'--permission-mode', permissionModeFor(bypass)` → `'bypassPermissions'` (`:105`)

So a client-supplied `bypass=1&resume=<uuid>` becomes a live
`claude --resume <uuid> --permission-mode bypassPermissions` process, with **zero**
automations-awareness. D7's "open every run since last open" reads
`cache.history[].sessionId` — a **brain-synced, teammate-writable** field — and feeds it
into exactly this path. D-E's claim that "every resume path resolves through
`readAutomationSession`" was FALSE for tab restore: chat-answer and Telegram-answer both
terminate in `verdict.ts`'s `authoritativeSession` (T7 repoints it, preserved), but tab
restore never went near it.

**Amendment: a new owned task, T24.** `src/server/routes/agent-chat.ts` must reject a
`bypass=1` WS connect tagged `kind:'automation'` unless
`readAutomationSession(slug, resumeId, home)` returns non-null. Server-side, not
client-side — a gate living in `AgentSurface.tsx` is not a gate.

### S4 — `isSafeAutomationSlug` must guard the two NEW per-slug HOME filenames.
**VERIFIED**: the validator is `store.ts:80` (`/^[a-z0-9][a-z0-9-]*$/`, no `--`, no trailing
`-`, not in `RESERVED_SLUGS`), and every existing `:slug` route gates through it
transitively via `getAutomation(...)`→404 (`routes/automations.ts:162,234,292,317,355`).
This is a genuinely NEW attack-surface class: old `card-registry.ts` kept the slug as a JSON
*value* inside one shared file, never as a **path segment**. Now it is a path segment in
`~/.dreamcontext/telegram/<slug>.json` and `~/.dreamcontext/automations/<slug>.sessions.json`.
**Amendment (T3, T9, T13):** new `:slug` routes follow the existing `getAutomation`-first
pattern, AND `writeTelegramConfigForSlug` / `recordAutomationSession` defensively call
`isSafeAutomationSlug` internally rather than trusting callers.

### S5 — Telegram per-bot scoping: never a project-wide lookup.
A leaked or compromised per-automation bot token must not be able to answer or resume a
DIFFERENT automation's question. **Amendment (T9/T11):** the per-bot poll uses only
`pendingQuestion(contextRoot, slug)`-scoped lookups. The old unscoped `allPendingReviewCards`
/ `findCardById` must NOT be carried into the multi-bot rewrite unscoped.

### S6 — flow-node `config` reaching a subprocess uses argv, never a shell string.
The approval hash proves a human READ the JSON; it does not prove the implementation treats
it as data rather than as shell text. The codebase is otherwise disciplined here
(`defaultPgidProbe`'s `execFileSync('ps', [...])`). **Amendment (T8):** any `execute()` that
reaches a process passes `config` fields as argv elements — never interpolated into a shell
command string. (Under A1, `execute` is spawn-free anyway, so this is belt-and-braces for
any future node kind.)

**Accepted as PRESERVED, no change needed:** the queue's HOME boundary (security #4 — brain
sync only pushes the project repo, so it cannot reach it); and `## Flow` needing NO
`buildPatternBlock`-style "UNTRUSTED NOTES" framing, because once `flow` is inside
`canonicalApprovalPayload` a `config` value is exactly as trusted as `m.prompt` — both
reviewed together, both gated by the same hash. The plan gets that right by omission.

### S7 — the gitignore constant's VALUE, not just its doc.
Because `AUTOMATIONS_REVIEW_GITIGNORE_ENTRIES` keeps its NAME, `runner.ts` step 6 (826–850)
picks up a new value with zero code edit and the re-ensure-on-every-run property survives by
construction. **Amendment (T1):** the literal value changes `'automations/review/'` →
`'automations/hitl/'`, in lockstep with where T6 actually writes. **(T10):** step 6 is
explicitly unchanged and still fires every run.

### 9.1 Map deltas from §8.2

| task | change |
|---|---|
| **T1** | + `AutomationQuestion.kind: 'approval' \| 'flow-hitl'` (S1); + gitignore constant VALUE → `automations/hitl/` (S7) |
| **T3** | + `recordAutomationSession` internally calls `isSafeAutomationSlug` (S4) |
| **T8** | + `execute()` is spawn-free (A1) AND argv-only if it ever reaches a process (S6) |
| **T9** | + `writeTelegramConfigForSlug` internally validates the slug (S4); + per-bot lookups are `pendingQuestion(contextRoot, slug)`-scoped only, never `allPending*` (S5) |
| **T10** | + approval-question spawn = `plan` mode + `--disallowedTools` + guard prompt (S2); + never records a session or run event (A2); + step 6 unchanged (S7) |
| **T13** | + the answer route branches on `question.kind`: `'approval'`⇒`approveAutomation`+fresh run, `'flow-hitl'`⇒`resumeWithAnswer` (S1); + new `:slug` routes gate through `getAutomation` first (S4) |
| **T24** *(NEW)* | **owns `src/server/routes/agent-chat.ts`** — gate `bypass=1` + `kind:'automation'` WS connects on `readAutomationSession`. depends on T3, T15. **wave 7.** (S3) |

**Final waves:** W1 T1,T2,T3 · W2 T4,T5,T6 · W3 T7,T8,T9 · W4 T10 · W5 T11,T13,T14 ·
W6 T15,T16,T17 · W6b T20 · W7 T18a,T19,T24 · W8 T18b · W9 T12,T21,T22,T23.

### 9.2 Added acceptance criteria

34. A WS connect to `/api/agent/chat?bypass=1&resume=<uuid>` tagged `kind:'automation'`
    whose uuid has **no** machine-local binding is REJECTED by the server (not the client).
    (S3)
35. The approval-question spawn's argv contains `--permission-mode plan` and
    `--disallowedTools`, and does NOT contain `bypassPermissions`. (S2, supersedes
    criterion 4)
36. Answering a `kind:'approval'` question calls `approveAutomation` and starts a fresh run;
    `resumeWithAnswer` is never invoked for it (spy asserts call count `0`). (S1)
37. `writeTelegramConfigForSlug('../../etc/passwd', …)` throws/refuses and writes no file.
    (S4)
38. A per-automation bot polling for `slug-a` never returns a question belonging to
    `slug-b`. (S5)

---

## 10. ROUND-2 PLANNER CONSISTENCY PASS — final amendments (OVERRIDE §8/§9 on conflict)

The fork-base planner, re-reading §7/§8/§9 with the whole codebase in context, found six
internal inconsistencies. All six are accepted. These are the FINAL binding amendments.

### P1 — T9 contradicted itself. T9 is now PURELY additive; the repoint moves to T11.
§8.2 said T9 is "ADDITIVE ONLY — the global reader/poller stays" (A6) and, in the same
cell, "repoints the 9 `ReviewCard`-typed helpers". Those nine are exactly what the GLOBAL
`pollTelegram` calls, fed by `allPendingReviewCards()` — alive until T12 in the last wave —
so repointing them cannot compile in W3. Worse, `handleCallback` (327) → `resumeWithVerdict`
and `handleSteerMessage` (363) → `applySteer` would need T7's `resumeWithAnswer`, which is
in the SAME wave.
**Amendment:** T9 adds `readTelegramConfigForSlug`, `writeTelegramConfigForSlug`,
`listTelegramSlugs` and NOTHING ELSE. **T11 (W5, after T7 lands in W3) owns the repoint of
all nine helpers** plus the cutover and the deletion of the transitional globals.

### P2 — declared dependencies completed.
T9 → `T1`. T11 → `T2, T6, T7, T9`.

### P3 — the approval-question spawn moves INSIDE the per-slug lock. (blocking)
Round 2 put it at step 2 (741) — before the lock (808) and past the orphan guard (763).
`executeClaudeDetached` is detached, so with no `onSpawned` sidecar it is an untrackable
orphan: precisely the defect `verdict.ts` already paid for and fixed with
`acquireRunLock`/`spawnResume`. Writing a sidecar without the lock is worse — the orphan
guard and `killRunGroup` would see a "run" that never took the lock.
**Amendment (T10):** step 2 only DECIDES that an approval question is owed. The spawn
happens inside the existing `try` block, after the per-slug lock is held, using the same
`onSpawned`-writes-the-sidecar contract as the main spawn, and released by the same
`finally`. No new orphan class, no new lock protocol, zero new machinery — it reuses all of
it. `RunSidecar` gains `kind: 'run' | 'question'` (T1) so `automations kill` can say which
it is killing.

### P4 — "no run event" now has a real exit path: a new `RunStatus`.
Every return from `runAutomation` goes through `finalize`→`recordRun`; `shortCircuit`
always records. A silently non-recording return would leave `RunOutcome.status` and tick's
`verdictFor` (117–124) with no value.
**Amendment (T1 + T10):** add `'awaiting-approval'` to `RUN_STATUSES`. It is the exact twin
of the existing `'awaiting-review'` — the human is the bottleneck, not a fault; the
watermark is NOT advanced, so the fire is OWED and comes back once, not once per tick. The
run event IS recorded, with `advanceWatermark: false`, `notify: false`, and
**`sessionId: null` explicitly**, so the approval-question conversation is never bound and
never resumable (A2 holds, by construction rather than by omission).
**Criterion 29 is restated:** after a `manifest-changed` run, `latestBoundSession(slug,home)`
is unchanged AND the newest `cache.history` entry has `status: 'awaiting-approval'` with
`sessionId: null`.

### P5 — T24 must gate on the RESUME UUID, not on a client-supplied tag. (critical)
S3 proposed rejecting WS connects "tagged `kind:'automation'`". But `agent-chat.ts` has no
`kind` param today (187–191 are vault/bypass/sessionId/resume/model/effort), so adding one
means **the caller asserts its own authorization and an attacker simply omits it** — which
fails S3's own stated standard ("a gate living in `AgentSurface.tsx` is not a gate").
**Amendment (T24):** the gate keys on the uuid itself. On `bypass=1&resume=<uuid>`, the
server asks: does `<uuid>` appear in ANY automation's `cache.history[].sessionId` for this
project? If YES, require `readAutomationSession(slug, uuid, home)` to return non-null,
else reject the upgrade. If NO, behaviour is exactly as today. An attacker cannot opt out of
this check by omitting a parameter, because the check is driven by the value they must
supply to get anything at all. `resolveAgentSession` (250) must be evaluated AFTER this gate,
never before, so a tab-session mapping cannot launder an unbound id.

### P6 — T6's export surface is derived mechanically, not from a hand list.
§8.2 said "the full 18-symbol surface" then listed 14. Also missing: `pruneResolvedCards`,
`RESOLVED_CARD_KEEP`, `readQuestion`, the `reviewCardExists` duplicate-check the propose
guard uses, and the four path helpers (`reviewDir`/`reviewSlugDir`/`reviewCardPath`/
`reviewStagedPath`).
**Amendment (T6):** the implementer derives the required surface by enumerating
`review.ts`'s actual exports and providing an equivalent for each — never from a list in
this document.

### P7 — wave numbers reconciled (§8.2's column and §9's list disagreed on T15 and T20).
**THE BINDING WAVE LIST — this supersedes every earlier one:**

| wave | tasks |
|---|---|
| W1 | T1, T2, T3 |
| W2 | T4, T5, T6 |
| W3 | T7, T8, T9 |
| W4 | T10, T15 |
| W5 | T11, T13, T14 |
| W6 | T16, T17, T20 |
| W7 | T18a, T19, T24 |
| W8 | T18b |
| W9 | T12, T23 |
| W10 | T21, T22 |

Max 3 per wave, satisfied everywhere. T15 moves to W4 (no dependencies, files disjoint from
T10, and W4 was a wasteful solo wave). T21 moves to W10 so the runtime verify script runs
against the fully-migrated tree, after T12 has removed the dead surface. T22 (the
feature-integration checklist) is last by design — it documents what actually shipped.

### 10.1 Final map deltas

| task | change |
|---|---|
| **T1** | + `RUN_STATUSES` gains `'awaiting-approval'` (P4); + `RunSidecar.kind: 'run'\|'question'` (P3) |
| **T6** | export surface derived from `review.ts`'s real exports (P6) |
| **T9** | PURELY additive — three new functions, no repointing (P1); depends on T1 (P2) |
| **T10** | approval-question spawn moves inside the per-slug lock with a sidecar (P3); records an `'awaiting-approval'` event with `sessionId: null` (P4) |
| **T11** | + owns the repoint of telegram's nine `ReviewCard`-typed helpers (P1); depends on T2, T6, T7, T9 (P2) |
| **T24** | gate keys on the resume UUID, not a client tag; evaluated BEFORE `resolveAgentSession` (P5) |

### 10.2 Baseline measurement (recorded before any code changes)

`npm run build` → **exit 0, clean**.
`npm test` → **4 test files / 5 tests FAILING on the untouched tree** (6640 passed, 1
skipped, 18 todo, 383 files). The failures are PRE-EXISTING and are being captured to
`_dream_context/tmp/test-baseline.log` by name. **Every wave gate compares against that
named list, never against "zero failures"** — otherwise a pre-existing failure reads as a
regression, or a real regression hides behind one. A wave gate FAILS if any test outside the
baseline list fails, or if a baseline failure changes shape.

### 10.3 THE BASELINE, measured twice (binding for every wave gate)

`npm run build` → exit 0, clean.

`npm test`, run 1: 4 files / 5 tests failed. Run 2 on the SAME untouched tree:
**3 files / 3 tests failed** (378 passed, 2 skipped, 383 files). The set shrank between two
runs of identical code, so the baseline is **FLAKY, not fixed**:

| pre-existing failure | area |
|---|---|
| `tests/integration/clickup-config.test.ts` — "changing the sync list non-interactively REQUIRES --migrate or --keep when tasks are mapped" | ClickUp sync |
| `tests/integration/clickup-hooks.test.ts` — "post-sleep: `sleep done` succeeds (best-effort sync) in a broken clickup project" | ClickUp git hooks |
| `tests/integration/marketing-council.test.ts` — "creates a debate with all 4 marketing personas pre-registered" | marketing council |

**None of the three touches automations.** All three are slow integration tests (8–35 s).

**WAVE GATE RULE (binding):** a gate PASSES when every failing test is inside that
three-test set. A gate FAILS the moment any OTHER test fails — and in particular any
`automations-*` test. A gate is NEVER judged against "zero failures", because that would
either read a pre-existing flake as a regression or let a real regression hide behind one.
Implementers are told this explicitly so nobody "fixes" a ClickUp test that was never part
of this goal, and nobody weakens an automations test to make a gate green.

---

## 11. ROUND-2 CRITIC AMENDMENTS — FINAL (override §8/§9/§10 on conflict)

### R1 — the `kind` refusal moves INSIDE `resumeWithAnswer`. (blocking; the round's best catch)
§9's S1 scoped the `'approval'`/`'flow-hitl'` branch to "the answer route" (T13's HTTP
handler). **VERIFIED: the CLI does not go through the HTTP server** —
`src/cli/commands/automations.ts:827-828` imports and calls `resumeWithVerdict`/`applySteer`
from `verdict.ts` directly. Telegram's `handleCallback`/`handleSteerMessage` reach the same
machinery through a third, independent path. So as written, a `kind:'approval'` question
could be answered from the CLI or from Telegram and resumed with `bypassPermissions` —
defeating D-B's entire tripwire through two doors the amendment never looked at.

**Amendment (T7):** the refusal lives INSIDE `resumeWithAnswer` (and `resumeWithVerdict`):
```
if (question.kind !== 'flow-hitl') return { status: 'refused',
  error: 'an approval question is answered by approving the manifest, not by resuming its session' }
```
Every caller — HTTP route, CLI verb, Telegram handler, and any future one — is then protected
BY CONSTRUCTION. T13's route-level branch stays, demoted from "the defense" to "a nicer early
error". **This is the difference between a gate and a convention.**

### R2 — T24 needs a reverse lookup that no task owned. (blocking)
`readAutomationSession(slug, sessionId, home)` requires a KNOWN slug, but the WS handler has
only a uuid. **Amendment (T3 gains an export):**
```ts
export function isAutomationBoundSession(sessionId: string, home?: string): string | null
```
— scans `~/.dreamcontext/automations/*.sessions.json` and returns the owning slug, or null.
**T24 calls it UNCONDITIONALLY on every `bypass=1&resume=<uuid>` connect** — never behind a
client-suppliable flag, because a gate an attacker can skip by omitting a parameter is not a
gate. The full rule:

> If `<uuid>` appears in ANY automation's `cache.history[].sessionId` for this project
> (the brain-synced, teammate-writable side) AND `isAutomationBoundSession(uuid)` returns
> null (the machine-local side), REJECT the upgrade. Otherwise proceed as today.

Evaluated BEFORE `resolveAgentSession` (agent-chat.ts:250), so a tab-session mapping cannot
launder an unbound id. T24 depends on T3.

### R3 — D4 gets REAL control flow, not just more prompt text. (blocking)
The critic is right that A1, as contracted, left the graph's only proven effect as "adds text
to the same free-form prompt" — textually indistinguishable from writing the same words into
`## Prompt` prose, which is the exact complaint this redesign exists to fix.

**Amendment (T10):** `executeFlow`'s output drives NAMED runner branches:
- **`needsHitl === true`** ⇒ the run does NOT publish its document. It creates a
  `kind:'flow-hitl'` question and exits (D2's ask-and-exit), recording `'awaiting-review'`
  with the watermark unadvanced. This is a real branch with a real observable difference.
- **`reportTarget`** ⇒ selects where the output document is written, overriding the default
  `outputDirFor` result when the graph names one.
- **`warnings`** ⇒ ride `RunEvent.error` the same way `degradeReason` already does
  (runner.ts:1049-1051), so an unknown node kind is SURFACED rather than silently absorbed.

**New acceptance criterion 39:** the same manifest, run twice — once with a `hitl` node in
its `## Flow` and once without — produces observably different behaviour: with the node, a
pending question exists and NO document is published; without it, the document publishes and
no question exists. That is the test that proves the graph executes.

### R4 — waves re-split (T22 depended on a same-wave sibling; W9 had four tasks).

**THE FINAL WAVE LIST — supersedes §10 P7:**

| wave | tasks |
|---|---|
| W1 | T1, T2, T3 |
| W2 | T4, T5, T6 |
| W3 | T7, T8, T9 |
| W4 | T10, T15 |
| W5 | T11, T13, T14 |
| W6 | T16, T17, T20 |
| W7 | T18a, T19, T24 |
| W8 | T18b |
| W9 | T12, T23 |
| W10 | T21 |
| W11 | T22 |

T21 alone in W10 so the runtime verify script runs against the fully-migrated tree; T22 alone
in W11 because the feature-integration checklist documents what actually shipped and must be
able to consume T21's result. Max 3 per wave holds everywhere.

### R5 — nits accepted
- **A4 revised**: a queued fire whose automation is DISABLED at drain time is **kept, not
  dropped** — skipped this tick and left for a future one, bounded by the 7-day TTL. D9 exists
  precisely so a fire is not silently lost, and "the user toggled it off for an hour" must not
  destroy an owed fire. A queued fire whose automation no longer EXISTS is cleared.
- **S7 stale entry**: `ensureGitignoreEntries` (`src/lib/gitignore.ts:16`) only ever appends,
  so the old `automations/review/` line would be stranded forever. **T12** calls the existing
  `removeGitignoreEntries` for it as part of finishing the migration.
- **Edges for auditability**: T11 and T13 both dispatch through `runner.ts` at runtime — add
  `T10` to both `depends on` columns (harmless in practice, W4 precedes W5, but the map should
  name it).

### 11.1 Final map deltas
| task | change |
|---|---|
| **T3** | + `isAutomationBoundSession(sessionId, home?): string \| null` (R2) |
| **T7** | + the `kind !== 'flow-hitl'` refusal lives INSIDE `resumeWithAnswer`/`resumeWithVerdict` (R1) |
| **T10** | + named branches on `needsHitl` / `reportTarget` / `warnings` (R3) |
| **T11** | + depends on T10; a disabled automation's queued fire is KEPT, not dropped (R5) |
| **T12** | + calls `removeGitignoreEntries` for the stale `automations/review/` line (R5) |
| **T13** | + depends on T10 |
| **T24** | + depends on T3; calls `isAutomationBoundSession` unconditionally (R2) |

---

## 12. ROUND-2 SECURITY AMENDMENTS — FINAL (override everything above on conflict)

### X1 — CAPABILITY LIFETIME. The one property the new design silently dropped. (blocking)
`card-registry.ts:120-127`'s `forgetCardSession` is called from `verdict.ts:683-685`'s
`finally` the instant a card leaves `'pending'`, with the comment: *"a resolvable session is
a capability, and it should not outlive the decision it existed for."* Nothing in T3, T7 or
§10 adds an equivalent. Because the new store is deliberately per-slug and plural (D-E wants
every session the automation produced, for D7/D8), an automation firing daily would reach a
steady state of **~90 simultaneously-live, independently `bypassPermissions`-resumable
sessions** — a strict widening of the old model, where a binding lived only as long as an
OPEN decision.

The tension is real: D7/D8 genuinely need long-lived resumability, so a blanket
"forget on answer" would break the feature. **The retention rule (T3 + T7):**

```ts
export function retireAutomationSession(slug: string, sessionId: string, home?: string): void
```
Called from `resumeWithAnswer`'s `finally` (T7) for `kind:'flow-hitl'` answers, and it
retires the binding ONLY when BOTH hold:
- (a) the run reached a terminal status with no further HITL pending, AND
- (b) the session was never persisted into the local tab roster
  (`state/.agent-sessions.json`) — i.e. the user never actually opened it as a chat tab.

If it WAS opened, its lifetime hands off to the roster/D7 mechanism, which is machine-local,
user-visible, and already the thing D7 restores from — rather than remaining an indefinite
standing grant nobody asked for. This closes the common case (a question is answered and
nobody revisits the tab) and leaves D7/D8's real use case untouched.

### X2 — D7 restore must not render a refusal as a crash. (blocking)
Traced concretely: hydration (§7 C12, `AgentSurface.tsx` 336-392) calls
`spawn(m.bypass, m.sessionId, true, kind)` SYNCHRONOUSLY, so the tab is visible in
`sessionList`/`panes` before the WS connect resolves. `rejectUpgrade` closes at the HTTP
upgrade level, before any application frame, so the client's `onclose`/`onerror` both land in
`stopOnClose` → `status: 'closed'` with **no populated `lastError`** (that field is only set
by an app-level `meta-error` frame a rejected upgrade never gets to send). A T24 refusal is
therefore indistinguishable from a crash — and per D-E's own reasoning about
`cache.history[].sessionId` being brain-synced and teammate-writable, this will be COMMON for
team-brain users after a sync or a stretch away, not rare. It would undermine the very
feature D7 exists to deliver.

**Amendment (T18a):** filter at hydration time, BEFORE creating a tab or attempting a WS
connect. An entry that is not locally bound renders as a distinct, non-resumable placeholder
naming why — *"Automation run from &lt;date&gt; — not available on this machine"* — never as a
tab that silently dies. T18a reuses the same bindability check T24 uses, exposed through the
sessions API.

### X3 — non-blocking pins accepted
- **T24 checks the RAW `resume` URL param**, never a `resolveAgentSession`-mapped value.
  "Evaluated BEFORE `resolveAgentSession`" already guarantees this, but it is written into
  T24's contract line so it survives a refactor.
- Reusing the SAME real bot token across two automations is not validated anywhere; with two
  simultaneous pending questions, `handleSteerMessage`'s bare-reply fallback
  (`open.length === 1 → assume it`) could misattribute a plain-text reply. Narrow,
  self-inflicted, not a cross-tenant leak. Recorded, not fixed.

### X4 — properties CONFIRMED preserved (six of seven from `card-registry.ts`'s module doc)
HOME-boundary move · inert display-only body with only the session id as capability ·
one-file-per-owner avoiding the lost-update race (now per-slug, even less contention) ·
slug-scoped lookup so a moved artifact cannot borrow another automation's session · 90-day
outer TTL · 0600 + atomic write. The seventh is X1, now restored.
Telegram `offset` replay and cross-token scope: **preserved** — `getUpdates` is scoped
server-side by bot token, so two per-slug tokens structurally cannot see each other's streams.

### 12.1 Final map deltas
| task | change |
|---|---|
| **T3** | + `retireAutomationSession(slug, sessionId, home?): void` (X1); + `isAutomationBoundSession(sessionId, home?): string \| null` (R2) |
| **T7** | + calls `retireAutomationSession` in `resumeWithAnswer`'s `finally` under the X1 two-condition rule |
| **T18a** | + hydration filters unbound automation sessions into a non-resumable placeholder BEFORE any WS connect (X2) |
| **T24** | + checks the RAW `resume` param (X3) |
