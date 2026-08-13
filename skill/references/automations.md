# Automations: scheduled headless runs

An **automation** is a recurring job the brain runs on its own, on a schedule, with nobody at the keyboard. Under the hood a headless `claude` session runs with elevated permissions, so this subsystem ships completely disabled by default. Nothing installs and nothing runs until the user explicitly installs the dispatcher and approves each automation on this machine. An automation's manifest is also **private to this machine by default** — sharing it with the team is a separate, explicit step. Read this file in full before creating, approving, or troubleshooting one.

---

## What it is, in one picture

```
_dream_context/automations/<slug>.md        the manifest: schedule + prompt, written by you
              user runs: dreamcontext automations install
~/Library/LaunchAgents/…automations.plist   one dispatcher, ticks every 5 minutes
              user runs: dreamcontext automations approve <slug>
a due automation spawns a headless `claude -p` session, bypassPermissions
automations/output/<slug>/<date>.md         the run's final message, verbatim
automations/cache/<slug>.json               run history, status, telemetry
```

All job semantics live in the manifest's prose. The CLI only carries schedule, model, and timeout. There is no built-in "digest" command or hardcoded job type. If you can write it as a prompt, it can be an automation.

**Who a headless run's work is attributed to.** Nobody is at the keyboard, so a run's changelog entries and memory notes are stamped with whichever person the vault's active-person ladder resolves to on the dispatcher's machine — in practice the machine's git `user.email` matched against `people/people.json`. Set **`DREAMCONTEXT_PERSON=<slug>`** in the automation's environment to override that (rung 1, above the machine pin and git email; it must name a real roster slug). On a vault with no `people/people.json` the authors field is **omitted entirely**, not written empty. Full ladder → [cli-reference.md](cli-reference.md#people--who-works-in-this-vault).

---

## The pattern: an automation that gets better instead of repeating itself

A scheduled job that starts from zero every time repeats its mistakes forever. The same broken endpoint, the same flag it needed and had to rediscover, the same wrong assumption, every day, with nobody watching it happen.

So every automation carries a **pattern**: a `## Pattern` section in its own manifest that the run reads before it starts and appends to when it finishes. It holds two things, both bounded: a **playbook** (the standing prose of how this job is best done) and a newest-first **lesson ledger** (one line each, capped at 20). New automations get this switched on; `--no-learning` at create time, or `learning: false` in the frontmatter, turns it off.

The run records what it learned by calling the CLI, not by editing the file:

```bash
dreamcontext automations learn <slug> --lesson "the API 500s on Sundays — skip and note it"
dreamcontext automations learn <slug> --playbook "<the revised standing playbook>"
```

Going through a command rather than a file edit is what makes the caps enforceable, keeps the ledger's grammar intact, and guarantees the write never touches frontmatter — so a run recording a lesson can never change a hashed field and block itself.

Three things about this are worth understanding properly rather than assuming:

- **The pattern is NOT approval-hashed, and that is deliberate.** It changes on its own every run, so hashing it would block the automation daily and train you to approve without reading, which is worse than not gating it at all. What IS hashed is `learning`, the switch that admits the pattern into the run. Turning it on requires an approval; what the pattern later says does not.
- **Which means the pattern is an unreviewed input, and is framed as one.** It reaches the model as notes, after the approved prompt, explicitly labelled observations that lose to the instructions. This is the same hazard as "never write a prompt that delegates its instructions to a file someone else can edit" (below) — the difference is that here the file is bounded, written only through one command, and told to the model as untrusted. Do not undo that framing. A run that reads something from the outside world and dutifully "learns" it is exactly the case this defends against.
- **It follows the automation's privacy.** The pattern lives in the manifest, so a private automation's lessons stay on this machine and a shared automation's travel with it. There is no separate switch to get wrong.

Keep lessons durable and small: a command that failed and what worked instead, a flag that turned out to be needed, an assumption that was wrong. This run's findings belong in the output document. An automation whose pattern has become a second copy of its output archive has stopped learning and started hoarding.

---

## Reading the session a run actually had

The output document is the run's conclusion with the working thrown away, which is the wrong half when a run does something surprising. Every run records its claude session id, and the session's full transcript is already on disk, so:

```bash
dreamcontext automations session <slug>            # the last run that had a session
dreamcontext automations session <slug> --run 3    # the third-newest, 1-based
dreamcontext automations session <slug> --path     # just the transcript path
dreamcontext automations session <slug> --json     # the parsed session
```

It prints the turns, every tool call with its argument, which ones failed, and the run's cost and turn count. The dashboard shows the same thing: each row in an automation's run history has a **session** button that opens the drill-in.

A missing transcript is normal, not a fault. `claude` writes one only once a session has produced a turn, a run that never reached a session has no id at all, and nothing in dreamcontext owns that file's lifetime. All three report as "no transcript", never as an error.

---

## Automations are recallable — you don't need the slug

Automations are a first-class recall channel, so "do we already automate this?" and "what did the nightly job find?" are recall questions, not `automations list` + read-the-file questions:

```bash
dreamcontext memory recall "paddle revenue digest" --types automation
dreamcontext memory recall "what did the insight sync report" --types automation
dreamcontext memory recall "<keywords>"                  # automations rank alongside everything else
```

Three things are indexed: the **manifest** (its `## Prompt`, so a near-duplicate is found before you create one), its **`## Pattern`** (so a lesson a previous run learned is findable by a session that never ran it — this is what stops the lesson ledger being write-only), and each **run output** under `automations/output/<slug>/`.

The limits are deliberate:
- **Run outputs are level `★` and rank-penalised**, exactly like session digests — machine-generated, unreviewed output must never out-rank a curated knowledge file on an equal match. Only the **30 most recent** are indexed; older ones stay on disk and readable by path.
- **A manifest is `★★` while enabled, `★` while disabled**, so `--level 2` skips paused jobs and run logs.
- **Automations never cross a vault boundary.** Manifests are gitignored machine-local state, `shared` defaults false, and a manifest body IS the prompt a `bypassPermissions` session runs — so cross-vault recall and federation digests both exclude them, while your own vault's recall treats them as first-class.

---

## The capture protocol

Automations are usually born from a conversation, not a form. When a user describes something they want to happen on a schedule, in any language, in their own words ("every evening at 6pm, pull together today's summary", "her cuma saat 17:00'de haftalık raporu çıkar", "on Tuesdays, look into X"), walk through this sequence:

1. **Detect the intent.** The shape is a recurring cadence plus an output. Watch for time-of-day or day-of-week phrasing combined with "do X" or "write X up" or "check on X".
2. **Dedupe first.** Before proposing anything new, check whether an automation already covers this. Use `dreamcontext automations list`, or `dreamcontext memory recall "<keywords>"`. Extend an existing automation's prompt rather than creating a near-duplicate.
3. **Agree the schedule and the output, in the user's own words.** Confirm the days, the time, and what the output should look like and where it should go, before writing anything.
4. **Scaffold it.** `dreamcontext automations create <slug> --title "..." --days <daily|mon,wed> --at HH:MM [--model] [--effort] [--timeout] [--catchup]`.
5. **Write the prompt from the conversation.** Edit the manifest's `## Prompt` section (and `## Output instructions` if the user cares how the result is formatted) to say, in full, what the scheduled run should do. This prompt is everything. The scheduled run has no user to ask follow-up questions, so it must be self-contained. Every run is already told to open its document with a one-line result, because that line becomes the desktop notification — for most runs the notification is the only thing the user reads, so it has to carry the answer rather than announce that a file exists.
6. **Live-test it with the user watching.** `dreamcontext automations run <slug> --force` runs it right now, ignoring the schedule, and shows the user the actual output before they trust it to run unattended.
7. **Confirm.** Once the user is happy with a live-tested run, the automation is ready. `automations create` already auto-approved it on this machine, since the creator is the local human who wrote the prompt. Nothing further is required here, but see the approval section below for what happens the moment anyone else touches it.

If the dispatcher isn't installed yet, mention `dreamcontext automations install`. Nothing will actually fire on a schedule until that's done, even though the automation itself is created and approved. The dashboard's Automations page carries the same switch — a scheduler row above the board (and in its zero-state) that reads on/off and turns it on in place, so a user who never opens a terminal is not stranded with a page full of automations that silently never run. That row also catches the two states an "installed" dispatcher can still be wrong in: a **stale** install (baked against a `dreamcontext` that has since moved — it wakes on time and fails) and a project **the registry doesn't know about** (the usual shape when the manifests arrived over brain sync rather than being created here). Both reinstall in one click.

Turning the scheduler on from the dashboard grants nothing extra: it installs the clock, not permission. Every automation still needs its own machine-local approval before that clock will run it, and each automation's own `enabled` flag is a separate switch again — flippable per card in the dashboard or with `automations enable|disable <slug>`. That flag is deliberately not approval-hashed, so toggling it never re-blocks an approved automation.

---

## Sharing: automations are private by default

A newly created automation lives on this machine only. It does not sync to the team's shared brain unless you explicitly say so. This matters because an automation's prompt, and everything it produces, can be sensitive in a way a task or a knowledge file usually isn't: it runs unattended, with elevated permissions, on a schedule you set.

- **The flag is `shared` in the manifest's frontmatter, and it defaults to `false`.** The read is deliberately strict: only the literal value `true` counts as shared. A missing flag, a typo, `"yes"`, or anything else reads as private. A security-relevant flag has to fail toward the safe state, so an automation you create today, or one written before this feature existed, is never shared by accident.
- **Sharing moves three things together, never separately: the manifest, its cache, and its output.** A private prompt whose digest still published would be worse than no privacy at all, since the output is usually the sensitive part. There's no way to share the prompt but keep the output private, or the reverse.
- **`dreamcontext automations share <slug>`** flips the flag and publishes those three paths. **`dreamcontext automations unshare <slug>`** does the reverse, and prints a warning every time, because it needs to: **unsharing is not retroactive.** Once a manifest has been committed and pushed, it is in git history on the remote and on every machine that pulled it. Removing the negation lines only stops *future* changes from publishing. If the prompt or an output held something sensitive while it was shared, treat it as already disclosed, not as something `unshare` cleans up. Getting it fully out of history means rewriting history (`git filter-repo`) and a force-push, with every teammate re-cloning.
- **`dreamcontext automations list` and `automations show <slug>`** always tell you which state an automation is actually in, one of five:

  | State | Meaning |
  |---|---|
  | `private` | Not shared. The normal, default state. |
  | `shared` | Published: manifest, cache, and output all leave this machine. |
  | `drifted-flag-only` | The flag says shared, but nothing is actually publishing. Fails safe — the content stays local, you're just wrong about it leaving. Shown as a warning with the repair command. |
  | `drifted-ignore-only` | The flag says private, but something is still publishing. Does **not** fail safe. This state is auto-repaired the moment it's noticed, with a line printed showing what was removed. |
  | `tracked-despite-private` | The manifest is already committed to git despite being marked private. A `.gitignore` entry can never untrack a file git already has. This is the loudest state, never auto-repaired, and names the exact `git rm --cached` command to fix it. |

- **A private automation's output still feeds the local brain during sleep.** Marking something private controls what leaves this machine over git, not what this machine's own agent can read. See "Sleep reads their output" below for the one place that distinction matters: knowledge files are synced regardless of any automation's sharing flag, so distilling a private automation's output into knowledge can republish it through a different door. When that happens, `dreamcontext sleep done` refuses to finish: it lists every knowledge file involved and the private automation it came from, and only proceeds once you pass `--ack-private-derivation`. That flag has no shorter alias, on purpose, and there is no way to discard the disclosure without acknowledging it. If you don't want the material published, edit or delete the listed knowledge files first, then acknowledge.

---

## What approval covers, and what it does not

Every automation carries a machine-local approval: a hash of exactly what it will do, computed the moment it's created, checked again every time it's about to run. If the prompt, output instructions, model, effort level, timeout, output directory, the `learning` switch, the `review` mode, or the `## Flow` graph change, the hash no longer matches, and the automation is **blocked**. It will not spawn, on this machine, until a human reviews it again with `dreamcontext automations approve <slug>`. `approve` shows exactly what changed across all nine of those fields before asking for confirmation, never just the prompt, because reviewing only the prompt would let a timeout or an output-directory change sail through unnoticed.

One asymmetry in that list is deliberate. `learning` is hashed only in the ON direction: an automation with learning off hashes exactly as it did before the field existed, so upgrading dreamcontext never re-blocks a working automation (and a blocked run notifies nobody, by design, so that would be a silent outage). Turning it on changes the hash and demands a review, because it widens what the run reads. `flow` is hashed the same shape, for the same reason, one level further: appended **LAST** to the hashed payload and **omitted entirely** (not written as `null`) whenever the manifest has no `## Flow` block, so a manifest written before this field existed keeps its exact byte-identical hash and gains a graph without costing a re-approval. Once a manifest has one, editing it is hashed like any other field — the graph decides what the run's prompt says and whether it stops to ask, so a teammate's synced edit that quietly deletes a `hitl` node has removed a human gate exactly as editing `review` back to `off` would, and both re-trigger review the same way.

This is why the approval exists, and it exists regardless of whether the automation is shared. For a **shared** automation, the obvious case is a teammate's synced edit arriving through brain sync, and it's treated the same as new, unreviewed code. But approval isn't only about teammates: a fully **private** automation still has to re-approve after any of those nine fields change, because anyone with local write access to this machine, not just a teammate, could alter the manifest before its next scheduled fire, and approval catches that too. Know precisely what that protection covers and what it doesn't.

### Approval has three paths, and only one of them still shows a screen

1. **Local authorship.** `automations create` — and the chat-first creation flow, which writes through that same CLI verb — auto-approves on the spot. The human who just wrote the prompt is the approver; there is nothing left to ask.
2. **In-session re-approval, when a prior approval already exists.** A manifest that changed since an automation on THIS machine was last approved does not fail in silence. The run spawns a short, deliberately weaker session — read-only (`--permission-mode plan`), stripped of the orchestration and mutating tools, hard-capped at two minutes, told in its system prompt to ask one question and stop — that reviews the automation **as it now stands** (not a before/after diff: the approval record stores a hash, never the old field values, so nothing can say which field changed) and asks whether to approve it. That question is an `approval`-kind question (see "Questions" below): it takes an explicit `approve`/`yes`/`reject`/`no` only, never free text, because a human typing "no, this looks wrong" must never be read as consent. Answering yes calls the exact same `approveAutomation` the CLI's `approve` uses and starts a **completely fresh** run; the asking session itself is discarded, never resumed with elevated permissions.
3. **Never-approved manifests — the one path that still needs a screen.** A manifest that arrived over brain sync (or was hand-planted) and has never run on this machine keeps the hard, silent `blocked` it always has: no spawn, no question, no chat tab. A never-approved manifest has no prior grant and arrived over a channel a teammate — or an attacker — can write to, so letting it spawn to "ask nicely" would let a synced manifest bootstrap its own `bypassPermissions` execution, the exact attack the approval hash exists to prevent, one door over. It surfaces as its own row on the dashboard board and in `automations list`/`show`, and the only way through it is `dreamcontext automations approve <slug>` or the dashboard's own approve screen — never an automated "ask and wait".

### What approval does not cover

1. **It does not limit what a run can do once it starts.** An approved automation can read or write any file it can reach, run any command, and access the network. Approving a prompt means "I read this and I would run it myself," not "I have limited what it's allowed to do."
2. **It does not follow references inside the prompt.** If a prompt says "read `knowledge/some-file.md` and follow its instructions," that file becomes an unreviewed, unhashed instruction source the moment anyone edits it. Approval never re-checks it. Never write an automation prompt that delegates its instructions to a file someone else can edit. Keep the instructions in the prompt itself.
3. **It does not vet the automation's own tools.** The `claude` CLI and the model it calls are trusted as-is.
4. **It is machine-local, not tamper-proof.** Approval lives outside the brain, in this machine's own configuration. Anyone with access to this machine's user account can forge one, the same trust boundary as your shell's own configuration files.
5. **It does not cover timing, or whether the automation is shared.** An automation's schedule (which days, what time, how enabled it is, and how generous its catch-up window is) and its `shared` flag are both deliberately not part of what's reviewed. A synced edit can move an automation from weekly to daily, or re-enable a disabled one with a wide catch-up window, without ever needing re-approval, because the behavior hasn't changed, only when it happens or where it's visible. Read that as a real capability change, not a technicality. The same prompt running four times as often, or resurrected after being turned off, is a bigger footprint even though nothing was re-reviewed.
6. **It does not vet the output for anything other than known credential shapes.** See the next section. This is important enough to read on its own.
7. **It does not stop a run once it's spawned.** See "Stopping a run" below.

## The flow graph: the shape of the job, never its authority

An automation's manifest can carry a `## Flow` section — a fenced `automation-flow/v1` JSON graph of `trigger → agent (+ connectors) → hitl → report` nodes, one file holding both what the job does and what it is wired as. Three things read it: the runner **executes** it, the dashboard **draws** it, and the chat-first creation flow **writes** it.

"Executes" has one precise meaning here, and the whole security story rests on it: **a node never spawns a process.** A node's entry in the registry contributes a short text fragment or a routing decision, and those fragments fold into the ONE prompt sent by the ONE spawn `runner.ts` already had. The graph is **descriptive of orchestration, not of authority** — it decides what the approved prompt says and which branch the run takes, never what the run is permitted to do. `executeFlow` (`flow-runner.ts`) is pure, synchronous, and spawn-free; it reads a graph and returns fragments, never touches a process, a socket, or a file.

That is what makes an unrecognised node kind safe to pass through instead of fatal. Node kinds (`trigger`, `agent`, `connector`, `branch`, `hitl`, `report`) live in an **open registry** (`flow-registry.ts`) with a generic fallback: a kind this build doesn't know renders as a visibly unrecognised node, contributes nothing to the prompt, and is named in a warning — it degrades and is surfaced, it does not break the run. Dropping it silently would make the diagram lie about what the automation does; failing the run instead would make every manifest written by a newer dreamcontext dead on arrival on an older one.

The graph is **approval-hashed**, appended LAST to the hashed payload and **omitted entirely** when the manifest has none — see "What approval covers" above for why that ordering matters. A manifest with no `## Flow` block still gets a graph for the dashboard's canvas: `deriveFlowFromManifest` draws one from the schedule, the prompt's title, and the `review` mode (a non-`off` `review` draws as its own `hitl` node), but that derived graph is never written to disk and never hashed, so every automation gets a picture from day one without a single automation owing a re-approval for it.

```bash
dreamcontext automations flow <slug>          # print the graph (own, or derived)
dreamcontext automations flow <slug> --json    # the graph plus any problems found
```

`flow` reports concrete problems — an unknown node kind, a dangling edge, a cycle — without ever failing the run itself: a cycle is broken deterministically (nodes still unvisited after the topological sort run in manifest order, reported as a warning) rather than hung on, because the manifest is a file a human hand-edits and a drawing mistake must still produce a scheduled run. A `hitl` node in the graph makes the run stop and ask before its work takes effect — see Questions, next.

## Questions: the human-in-the-loop successor to review cards

A **question** is what a run hands a human when something must be decided before it continues, or before its work takes effect. It replaced the review-card board entirely (that store and its dashboard queue are gone) and lives at `automations/hitl/<slug>/<id>.json` — machine-local, never brain-synced, for the same reason the approval registry and the session bindings below are: a question can name a resumable session, which is a capability, and a synced one would hand it to every teammate who pulls.

There are exactly two kinds, and the difference is a security boundary, not a label:

- **`flow-hitl`** — an already-approved run stopped mid-flight to ask (a `hitl` node in its flow graph, or a manifest with `review: agent`/`review: output`). Free text is the correct answer here: it resumes the exact session that asked, so the reply lands in the conversation that raised it.
- **`approval`** — the manifest changed since it was last approved and the run is asking about the diff (approval path 2, above). This kind is never given a session id, on every write path, and answering it never resumes anything — it takes an explicit `approve`/`yes`/`reject`/`no` only. Free text is refused outright, because "no, wait" typed into a box must never be silently read as consent.

Every surface answers through the same store:

```bash
dreamcontext automations questions [slug]      # what is open — omit slug for everything
dreamcontext automations answer <id> <answer>  # free text for flow-hitl; approve/yes/reject/no for approval
```

The dashboard renders the same card inline, in the automation's chat, below the run header — it reads as the agent itself asking, not a ported review board — and Telegram (below) answers the same store too, for when nobody is watching a screen. A slug with an unanswered question refuses to fire again: the watermark is not advanced, so the fire is OWED and comes back once, the moment the question is answered, not once per tick for as long as it sits open.

## Telegram: one bot per automation, never one for the whole project

Every other surface above requires a human at the Mac. An automation fires precisely because nobody is, so its Telegram channel is scoped **per automation**, at `~/.dreamcontext/telegram/<slug>.json`, mode 0600, machine-local, never synced. A bot token plus an authorized chat id is the ability to resume a `bypassPermissions` session on this machine — a capability, not a preference — so one bot per automation keeps a leaked token's blast radius to one job instead of every automation on the machine at once. Every inbound update is checked against the authorized chat id and silently dropped otherwise: not answered, not logged back to the sender, because anyone can message a bot whose token they don't have.

```bash
dreamcontext automations telegram setup <slug> --token <t> --chat <id>   # point a bot at this automation
dreamcontext automations telegram test <slug>                            # post its waiting question now
dreamcontext automations telegram off <slug>                             # forget the token, stop the channel
```

A connected bot carries the automation's **results**, not just its questions: when a run completes, the runner delivers the same headline the macOS banner shows (✅ success with the run's opening line, ❌ failure with the error, ✋ needs-your-verdict) to the authorized chat. This delivery is independent of the manifest's `notify` field — that governs the desktop banner, while connecting a bot is its own opt-in to phone delivery — and best-effort: a network blip never fails a run. The run itself is told the connection exists (chat id only, never credentials) so a resumed chat can answer "did this reach my Telegram?" truthfully; the sending is done by the runner, never by the session.

Turning a channel off only stops Telegram from answering that automation's questions — the dashboard and `automations answer` still do.

## Session bindings: what a resume actually trusts

Answering a `flow-hitl` question, or reopening a finished run as a chat tab, both end in the same act: `claude --resume <id> --permission-mode bypassPermissions`. A resumable session id is therefore a capability, and `automations/cache/<slug>.json` — where a run's session id is also recorded, for display — is brain-synced and teammate-writable, which makes it the wrong place to trust. The authority instead lives at `~/.dreamcontext/automations/<slug>.sessions.json`, machine-local and written only by this machine's own runner the moment it spawns a session. A session id arriving from the synced cache, a Telegram message, or a hand-edited chat-tab roster resolves to **null** here — never resumable — however convincingly it claims to belong.

This is enforced in exactly one place that matters: the chat WebSocket's resume gate (`src/server/routes/agent-chat.ts`) rejects every `bypass=1&resume=<uuid>` connect whose uuid is claimed by some automation's synced cache but was never recorded by this machine's own session-binding store. A planted session id in a synced cache record can therefore never bootstrap an unattended, fully-armed resume of a conversation this machine never actually ran.

## If it's shared, know what protects the output and what doesn't

If an automation is **private** (the default), its output never leaves this machine over git, so none of this applies. If it's **shared**, the output lands under `_dream_context/` and rides the same sync and push path as everything else in the brain, including the automatic push that happens on `sleep done` when cloud sync is on. Before sharing an automation whose output might be sensitive, understand exactly what stands between that output and your team's shared remote.

- **Credential-shaped secrets ARE caught.** A mandatory scrub runs before every commit and push, and it blocks outright on real, structured credential shapes: GitHub tokens, AWS keys, Google API keys, Slack tokens, Anthropic, OpenAI, and Stripe API keys, private-key headers, and JWTs. If a shared automation's output happens to contain one of these, the push stops.
- **Everything else is NOT caught.** The scrub matches known credential shapes, not "sensitive information" in general. Internal hostnames, customer data, private URLs, and any token or secret that isn't in one of the recognized shapes will pass through untouched. A path that looks like a home directory is flagged, but only as a soft warning. It does not stop a push on its own.
- **So only share automations whose output you'd be comfortable publishing to your team's remote.** If a scheduled digest might summarize something sensitive, keep the automation private, or say so explicitly in the prompt's output instructions so the run itself avoids including it.

## The notification now carries content, and a screen is not private

Worth knowing whichever way an automation is shared: the completion notification's body is the run's own opening sentence, not just the name of a file. That is the point of it — the banner is realistically the only thing anyone reads when a job fires unattended — but it does mean **a private automation's findings appear on screen**, and macOS keeps them in Notification Centre afterwards. A screen can be mirrored, projected, or simply sat behind.

If a particular automation's result should not be readable at a glance, you have two clean options, and neither requires giving up notifications: add a `## Notification` section telling the run what to say instead ("sync finished, 2 anomalies — see the document"), or set `notify: false` on that one automation.

## Stopping a run: never guess with `pgrep`/`pkill`

A running automation is its own, separate process group, deliberately detached from the command that launched it. That means killing the tick or the `run` command does not stop the automation underneath it, and because that command was the one holding the timeout, killing it removes the only time limit the run had. If you need to stop a run in progress, use:

```bash
dreamcontext automations kill <slug>
```

This reads the exact process group recorded for that specific run and shows you what it's about to kill before it does. Never try to find and kill it by hand with `pgrep`/`pkill`. A command-line search for "claude" will match other sessions running on the same machine, including your own interactive work, and there is no way to tell them apart from the process list alone.

There is no automatic cleanup of a run left behind this way. If an automation's previous run is still out there, the automation will refuse to start again, reported every time the dispatcher ticks, in the session snapshot, and in `dreamcontext automations show <slug>`, until an operator runs `automations kill` to clear it. This is a deliberate trade: recovery takes a human noticing and acting, rather than something else guessing at what to kill on your behalf.

---

## Catch-up windows, and what shares a fire time

Automations run one at a time, in the order they come due, never in parallel with each other on the same tick. If two automations share a fire time and one of them takes a while, the other can be pushed later than its own catch-up window allows, and once that window closes, the fire is skipped entirely rather than run late. Set an automation's catch-up window comfortably longer than the combined timeouts of anything else that shares its fire time, so a slow sibling never causes a skip.

**The run queue is why a busy tick doesn't just lose a fire.** A fire that comes due while its own slug's lock is still held (a previous run overrunning into the next tick) is parked at `~/.dreamcontext/automations-queue.json` — machine-local, never brain-synced, one waiting entry per automation by construction (a second enqueue for the same slug overwrites the first, carrying the ORIGINAL scheduled time forward so a later drain still advances the watermark correctly), TTL-bounded at 7 days so a queue nobody ever drains cannot grow forever. The very next tick drains the queue before it asks `isDue()` anything, and re-resolves each entry's manifest rather than trusting what the queue entry remembered:

- **A disabled automation's queued fire is kept, re-parked for whenever the automation is re-enabled** — never run, and never dropped either. The queue exists precisely so a fire is not silently lost, and "the user toggled it off for an hour" must not be allowed to destroy a fire the schedule still owes.
- **A queued fire whose automation no longer exists at all is cleared.** That is the one case with genuinely nowhere to go — there is no manifest left to re-enable.

---

## Why the dispatcher resolves the way it does

The dispatcher is a single scheduled job that wakes up every five minutes and checks every automation across every project on the machine, not one job per automation. When it runs, it needs to find the real `dreamcontext` command, and that turns out to be less obvious than it sounds. A script's default, non-interactive shell can resolve a different installed copy of the command than the one actually in everyday use, because PATH setup that only applies to interactive shells (the kind you get when you open a terminal) doesn't apply to a script running unattended.

The dispatcher avoids this by resolving the real command path once, at install time, and using that resolved path directly on every tick, falling back to a full interactive-shell resolution only if that saved path ever stops working (for instance, after an upgrade moves things around). That fallback is what makes the dispatcher self-healing. If the installed CLI ever moves, the very next tick finds it again on its own instead of silently failing forever.

A known, accepted gap: if the fallback resolution itself ever hangs, an extremely unusual shell configuration problem, nothing actively watches for that and cuts it off. What you'd notice instead is that `dreamcontext automations install --check` shows its last-tick timestamps going stale, because a hung tick can't record that it started or finished. That's diagnosable, but only if someone looks. There is no active alert. `install --check` shows the raw timestamps of the last tick start and completion. There's no automatic "the dispatcher looks dead" warning layered on top of them, because how long a legitimately busy tick is allowed to take varies with how many automations are due at once, and a flat threshold would end up crying wolf during completely healthy runs.

---

## Manifest reference

`_dream_context/automations/<slug>.md`, one file per automation:

| Frontmatter field | Meaning |
|---|---|
| `id` | Assigned at creation, stable. |
| `title` | Human-readable name. |
| `enabled` | `false` means the dispatcher skips it entirely; approval is untouched either way. |
| `shared` | Whether this automation's manifest, cache, and output publish to the team's synced brain. Defaults to `false`; only the literal value `true` counts as shared. See "Sharing" above. |
| `schedule.days` | `daily`, or a list of weekdays. |
| `schedule.at` | 24-hour local time, `HH:MM`. |
| `model` | Optional model override. Omit to let `claude` pick. |
| `effort` | Optional reasoning effort: `low`, `medium`, `high`, `xhigh`, or `max`. Omit to let `claude` pick. |
| `timeout_minutes` | 1 to 60, default 15. The run is stopped if it runs longer. |
| `catchup_hours` | 1 to 168, default 6. How late a missed fire (e.g. the laptop was asleep) may still run. |
| `output.dir` | Optional override for where this automation's output lands. Must be a subdirectory under the brain, never the brain root itself. |
| `notify` | Whether a desktop notification fires when a run finishes, success or failure. `automations install` sets up a small notifier app so these arrive branded as "dreamcontext", with a sound: a soft one on success, macOS's error sound on failure, so an unattended failure is audibly different from a success. macOS asks for permission once, and **until it is allowed, notifications are filed silently and never appear on screen**. Sound is a **separate** switch from permission (System Settings > Notifications > dreamcontext > "Play sound for notifications"); allowing alerts does not turn it on. `install --check` reports whether the notifier is present. Defaults to `true`; only the literal value `false` silences it. Note the asymmetry with `shared`, which defaults the other way: an over-share is a leak, but a run nobody is told about is a silent loss, so the two flags fail toward opposite states on purpose. Not an approval-hashed field, for the same reason `shared` isn't — it changes whether you are told, never what the run does. |
| `learning` | Whether this automation keeps a `## Pattern` — read before every run, appended to after one. Defaults to `true` for anything created from now on (`create` writes it explicitly); a manifest written before this field existed reads `false`, which is what keeps its approved hash byte-identical across the upgrade. IS approval-hashed: turning it on widens what the run reads to a file the run itself rewrites. See "The pattern" above. |
| `review` | Whether this automation stops and asks before its work takes effect, and who decides: `off` (default — publishes and notifies with no verdict in between), `agent` (the run decides at runtime, via `automations propose`), or `output` (blanket — every finished document waits for a verdict before it publishes). Reads leniently toward `off` on anything unrecognised, the opposite of how `shared` fails, because a malformed `review` failing CLOSED would mean an automation silently stopping to ask a human who doesn't know a question exists. IS approval-hashed in the non-`off` direction: turning it on is a gate a teammate's synced edit must not be able to remove for free. |

Body sections:
- **`## Prompt`**: required. What the scheduled run should do. Written as if there is no one to ask follow-up questions, because there isn't.
- **`## Output instructions`**: optional. Extra guidance on formatting, tone, or where else the result should go.
- **`## Flow`**: a fenced `automation-flow/v1` JSON graph — see "The flow graph" above. Written by `create`, editable by hand or through the chat-first creation flow; absent on any manifest that predates it, which reads as a derived, unhashed graph instead.
- **`## Pattern`**: written by the runs themselves via `automations learn`, never by hand during a run. The playbook, then a `### Lessons` ledger, newest first. Absent until the automation has learned something.
- **`## Changelog`**: automatic run history notes, newest first.

---

## Quick reference

Full flags for every verb live in [cli-reference.md](cli-reference.md#automations).

| Command | What it's for |
|---|---|
| `automations create <slug>` | Scaffold a manifest and auto-approve it locally. |
| `automations list` / `show <slug>` | See every automation, or one in full: schedule, approval state, run history, and whether a previous run is still orphaned. |
| `automations run <slug> --force` | Run it right now, ignoring the schedule. The live-test step of the capture protocol. |
| `automations learn <slug> --lesson "…"` | Record what a run learned into its pattern. The run calls this itself; you can too. |
| `automations session <slug> [--run N]` | Read the claude session a run actually had: turns, tool calls, failures. |
| `automations flow <slug>` | Print this automation's flow graph — its own `## Flow` block, or the one implied by its schedule/prompt/review mode — and any problems in it. |
| `automations questions [slug]` | List questions awaiting a human answer, project-wide or for one automation. |
| `automations answer <id> <answer>` | Answer one: free text for a mid-run question, `approve`/`reject` for a changed-manifest question. |
| `automations telegram setup/test/off <slug>` | Point a per-automation Telegram bot at this automation's questions, post one now, or forget the token. `<slug>` is required — there is no project-wide bot any more. |
| `automations tick [--all]` | Simulate what the dispatcher would do this instant. |
| `automations enable` / `disable <slug>` | Turn dueness on or off without touching approval. |
| `automations approve <slug>` | Review a changed automation and re-approve it on this machine. |
| `automations share` / `unshare <slug>` | Publish (or stop publishing) this automation's manifest, cache, and output. Private by default; `unshare` is not retroactive. |
| `automations kill <slug>` | Stop a specific run's orphaned process group. Never `pgrep`/`pkill`. |
| `automations remove <slug>` | Delete a manifest and its machine-local state. |
| `automations install` / `uninstall` | Turn the scheduler itself on or off for this machine. |
| `automations logs` | Tail the dispatcher's own log. |

---

## Related

- [cli-reference.md](cli-reference.md#automations): every flag, live from `--help`.
- [sleep.md](sleep.md): sleep never runs automations and never owns their files, but it does read new output and fold it into knowledge, including a private automation's output. A private automation's output can still end up published this way, through the knowledge file it becomes, and `sleep done` refuses to finish until you've reviewed that.
- [tasks-and-features.md](tasks-and-features.md): the offer-and-confirm capture pattern automations shares with insights and theses.
