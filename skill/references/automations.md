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

**Recall cannot bootstrap discovery, and the snapshot is what covers that.** A vault with zero automations returns zero automation hits, so on exactly the vault where somebody is asking for the feature for the first time, recall is silent. That is why the session snapshot's `## Automations` section always renders at least one line — the zero state (`none yet — schedule recurring/unattended work with \`dreamcontext automations create <slug>\``) included. It is a discovery channel, not a status report, and it is what makes "can we make this run every morning?" answerable without the user naming the subsystem first.

---

## The capture protocol

Automations are usually born from a conversation, not a form. When a user describes something they want to happen on a schedule, in any language, in their own words ("every evening at 6pm, pull together today's summary", "her cuma saat 17:00'de haftalık raporu çıkar", "on Tuesdays, look into X"), walk through this sequence:

1. **Detect the intent.** The shape is a recurring cadence plus an output. Watch for time-of-day or day-of-week phrasing combined with "do X" or "write X up" or "check on X".
2. **Dedupe first.** Before proposing anything new, check whether an automation already covers this. Use `dreamcontext automations list`, or `dreamcontext memory recall "<keywords>"`. Extend an existing automation's prompt rather than creating a near-duplicate.
3. **Agree the schedule and the output, in the user's own words.** Confirm the days, the time, and what the output should look like and where it should go, before writing anything.
4. **Scaffold it.** `dreamcontext automations create <slug> --title "..." --days <daily|mon,wed> --at HH:MM [--model] [--effort] [--timeout] [--catchup] [--photo]`.
   **Ask which MODE it is before you ask for a time.** `--mode sched` (the default) runs on a wall-clock schedule. `--mode call` has no schedule at all: the dispatcher never fires it, `list` reports it as `When you call it` rather than a broken manifest, and it runs only when a human asks for it (`automations run <slug>`, or Run now on the Agents page). "her sabah" is `sched`; "çağırdığımda", "when I ask", "on demand" is `call` — and asking a person for a time they do not have one for is how a `call` agent ends up scheduled by accident.
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

- **Approving a shared automation on a second machine runs it twice.** There is no cross-machine coordination and no owner: approval is machine-local, so every machine that approves an enabled shared automation fires it on its own clock, and the two runs then fight over the same synced cache record. What stands between you and doing that unwittingly is a warning at every approval surface — the CLI `approve`, the dashboard's approve screen, and the in-session approval question all check whether the synced run history holds recent runs this machine's own session-binding store never recorded (i.e. runs that happened on a teammate's machine), and say plainly that approving here runs it duplicated, not moved. The warning is advisory, never a block, because duplication is occasionally wanted — but the intended pattern is one machine runs it, everyone else reads its shared output. Events older than the binding TTL, and events that never spawned a session, are left out of that evidence rather than guessed about; a private automation shows no such warning at all, since its cache never syncs and every run in it is local by construction.
- **A private automation's output still feeds the local brain during sleep.** Marking something private controls what leaves this machine over git, not what this machine's own agent can read. See "Sleep reads their output" below for the one place that distinction matters: knowledge files are synced regardless of any automation's sharing flag, so distilling a private automation's output into knowledge can republish it through a different door. When that happens, `dreamcontext sleep done` refuses to finish: it lists every knowledge file involved and the private automation it came from, and only proceeds once you pass `--ack-private-derivation`. That flag has no shorter alias, on purpose, and there is no way to discard the disclosure without acknowledging it. If you don't want the material published, edit or delete the listed knowledge files first, then acknowledge.

---

## The channel: what a run says, and to whom

Every automation is also a **channel**, and every fire is a **thread** in it. The dashboard's **Agentic Automations** page opens on `#agents`: one message per run, across every agent, newest at the bottom. The feed shows a run's opening line; **its thread shows the whole answer**, the run's published document drawn in the chat's own answer card, so the detail is one click away without opening the session.

- **The document is the thread's answer, not a file card.** The feed message carries it as `document`, separate from `files` (what the agent posted), so it never takes one of the four attachment slots and never shows as a card named by its date. The thread renders it as the answer card, just before the run's terminal row (`ok`, `replied`, `failed` or `timeout`), and the dashboard's Files view lists it with the posted files.
- **"N replies" is counted once, on the server.** `threadReplies()` in `feed.ts` counts every authored entry under the thread's root plus one for the answer card; the root is the ask for an @mention and the agent's first post for a scheduled run (`threadRootId()`). The feed row and the thread route (`replyCount`, `rootId`, `lastReplyAt`) both return that number, so the row and the panel always agree. The ask itself is never a reply, and a failed ask that posted nothing and published nothing shows no reply at all.
- **A running agent looks alive.** Its row shows a slowly breathing dot and a live elapsed time ("running 1m 12s") that keeps climbing, so a hung run is visible; an ask still in flight reads "Working · started 02:41 PM". With reduced motion the dot is still and the time keeps ticking.
- **The channel keeps your place.** At the bottom, new messages and growing answers stay in view; scrolled up, a "N new messages" pill appears instead of the page moving. Filter chips that do not fit fold into a "+N agents" menu with each agent's count, so no agent is ever off screen without one.
- **A first-time page starts something.** With no agents yet, three starter agents (a morning digest, a weekly report, an on-call researcher) open the New agent dialog already filled in; nothing runs until the scheduler is on and the agent is approved.
- **Known limit:** the feed reads only the newest 14 day files per agent, while a thread reads its whole run. A run whose opening entries are older than that window can show a different count in its feed row than in its thread. This is accepted rather than guarded, because the guard would put an unbounded read back on the 15-second poll.

**The run itself decides what to say.** Summaries are never derived from a transcript: a derived summary posts on every run whether or not anything happened, and the whole value of a channel is that an unremarkable run stays quiet.

```
dreamcontext automations post <slug> "<one or two sentences>" [--file <brain-relative path>] [--kv key=value]
```

- **Post only what is IMPORTANT**: a finding, a number that moved, something that needs a decision. Not progress narration, not "starting now", not the whole document (it is saved already and becomes the thread's answer card). **Zero posts is the right number for an unremarkable run**, and the run's preamble says so.
- **A run needs no ids.** The runner exports `DREAMCONTEXT_AUTOMATION_SLUG` and `DREAMCONTEXT_AUTOMATION_RUN` into the child's environment, so `post` binds to the run that is calling it. Those are HINTS, not capabilities: the slug is still a required positional and is still validated, so a leaked or forged variable grants nothing. With no run resolvable at all, `post` **refuses** with a non-zero exit and writes nothing — a post in a thread no run will ever close reads to a human as an agent talking to itself.
- **`--file` takes brain-relative paths only**, at most 4. An absolute or escaping path is refused at write, never stored. A path that already exists is additionally refused when it **is a symlink**, or when its realpath resolves outside the brain — a thread file of a shared agent is teammate-writable, so the path in it is not ours to trust.
- **`--kv key=value` attaches a structured summary**, at most 6 rows, split on the FIRST `=` only (`--kv change=+4% vs=last week` is one row whose value contains a space and an `=`). Both halves are required — `--kv wau` names a number it never gives and is refused. **`--kv` is for figures, not prose**: it renders as a small key/value block under the message, which is the wrong shape for a sentence. A seventh row exits non-zero and writes nothing.

**Asking with buttons.** A run that needs a decision does not post a question as text — a posted question has nothing to press. It calls `propose`, which is the same stop-and-ask primitive the review gate uses, now able to carry its own options:

```
dreamcontext automations propose <slug> --title "…" --body "…" --choice "A" --choice "B"
```

- **At most 4 choices, at most 64 characters each**, refused at the CLI with a non-zero exit and nothing created. The cap is also a **floor inside the store**: `parseChoices` strips control characters and newlines, truncates to 64 and keeps the first 4 for *every* producer and *every* reader, so a question file written by an older build or synced from a teammate is sanitised on the way in. The CLI refuses rather than relying on that silent truncation — a run that believes it offered five options and got four should be told, not quietly corrected.
- **It needs `review` on.** `propose` refuses under `review: off`, choices or not, because a proposal nobody is watching for is a run that stops and waits forever. Set `review: agent` (or `output`) in the manifest and re-approve — it is a hashed field.
- The choices become **buttons under the message** in the channel, and answering one goes through the ordinary question route; the thread then shows the answer and the run carries on. A question with no choices renders a free-text field instead.

**The runner writes the bookkeeping itself** — `started` when a child actually spawns, then exactly one of `ok` / `failed` / `timeout`, plus `asked` when a run stops to ask and `replied` when a reply turn finishes. A SCHEDULED fire that never ran (`blocked`, `deferred`, `orphaned`) writes **nothing**, or a still-due automation would post every five minutes forever. These `system` entries appear only inside the thread panel, as grey one-line rows; the feed shows the agent's own words.

**A run that hits the account's usage limit publishes nothing, and says so.** The limit is account-global (headless runs share it with your interactive sessions), and a capped turn comes back as an ordinary success envelope whose text is the limit banner. Left alone that banner becomes the day's document and is handed to sleep as the job's result; it happened four times across projects before this gate existed. So the run is detected as limited **before** anything else is decided, marked `failed` with one sentence naming the window and its reset time, and **no output file is written**: there is no document, so there is no answer card and nothing reaches Telegram. The thread carries the same sentence. A document that legitimately *discusses* usage limits still publishes normally: the detector requires the CLI's own refusal shapes, a short body and no headings, because a false positive silently suppresses real work and is the expensive direction.

**What a post can carry, and where each part renders.** A message is the agent's sentence plus, optionally, a `--kv` block and up to four files. The files are typed by extension, and the reach differs:

| attachment | renders as | where it works |
|---|---|---|
| `.excalidraw.md` | a **live board** sized to its box; *Full screen* opens it on the chat's fullscreen canvas | wherever the SERVER reports the desktop capability (`useAgentCapabilities().data.desktop`, the same gate its file routes use); elsewhere it is a plain, non-clickable card saying boards open in the desktop app |
| `.png` `.jpg` `.jpeg` `.gif` `.webp` | **inline in the message**; click opens the lightbox | **everywhere**: browser dashboard and phone included, because it is served from the vault-scoped route, not the desktop-gated one |
| `.mp4` `.webm` `.mov` | an **inline player** (range-streamed, so it seeks) that keeps the clip's own shape, so a portrait clip plays tall, and reserves its box before the clip loads | everywhere, same vault-scoped route |
| `.mp3` `.m4a` `.wav` | an audio card: name and **Open** above the player | everywhere |
| `.pdf` | a **PDF card**; click opens the full-window PDF viewer | everywhere (bytes from the vault-scoped route) |
| a markdown or text document | a card led by its type (`MD`, `CSV`…) that opens the document viewer | the desktop app (the viewer reads through the desktop-gated file route) |
| `.svg` | a card; click opens the **lightbox**, where it is drawn as an image | the desktop app (read through the desktop-gated file route); elsewhere the card opens the document viewer as text |

**Two tiers, and the feed folds.** Visuals (board, picture, clip) come first, all capped at one shared width (the chat's card width); documents follow as a row of cards led by their type and named without filler notes. A long name is shortened in the middle so its ending (the part that tells two files apart) stays visible, with the full path as the tooltip. In the **thread** every visual is drawn in full. In the **feed** only the first visual is drawn; the rest fold into typed cards in the same row, so a four-visual post stays a glanceable row. An ask's preview names what came back as one line, by kind and joined with " · " (`▦ funnel · ▣ chart.png · ▶ walkthrough.mp4 · ◧ report.pdf`): boards by their board name, PDFs `◧`, other documents `▤`. **Save anything you attach next to your document** (`automations/output/<slug>/`): `--file` only accepts brain-relative paths, and the preamble names that folder for the run. A run started from the app (an @mention, "run now") still finds `dreamcontext` on its PATH: the runner puts a shim for the CLI that started it at `~/.dreamcontext/bin/cli/`, because a Finder-launched app's PATH has no login-shell entries.

`.svg` is deliberately absent from what the **vault** route will serve as an image: there it is never rendered as an image. An SVG is a script-bearing document, that route is generic, and the page that consumes it frames the response same-origin, so a rendered SVG there would be script running with the local API's origin. Image responses from it carry `Content-Security-Policy: default-src 'none'; sandbox`; a PDF fetched from the same route carries no CSP, because `sandbox` would blank the viewer that has always rendered it. An `.svg` is shown through the **desktop** file route instead (`/api/agent/file?raw=1`), which serves it as `image/svg+xml` under `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`, `nosniff`, capped at 512 KB. The lightbox loads it into an `<img>`, where an SVG's script never runs, and the sandbox keeps the same URL inert if it is opened directly. Chat opens an `.svg` the same way. Nothing new is exposed: that route already served any project file as text. Both routes check containment on real paths, so a symlink inside the tree is followed and one that resolves outside it is refused.

**Calling an agent by hand, and replying to a run.** The channel has its own text field, and every run's thread has one too. Both are the chat's real composer, not a lookalike.

- **`@<slug>` in the channel** addresses one agent. What happens next depends on its mode: a **`call`** agent (or a `sched` one that has never completed a run on this machine) **runs once** with your sentence in its prompt; a **`sched`** agent with a bound session **resumes that session** and answers as a post, and its thread opens. Either way the exchange is **your** message, Slack-style: the thread hangs off your ask, the answer's opening is previewed inside your message as plain prose (markdown syntax stripped, three lines), and the agent's posts and the answer card are the thread's replies (the ask itself is never counted as one). **`/` opens the project's skills and commands** (the same cached list a new chat gets); a `/name` in an ask tells the run to load that skill.
- **`/` and `@` match Turkish-aware.** Both menus fold case and diacritics on both sides (`foldForMatch`: Turkish lower-casing, marks stripped, `ı` read as `i`), so `/içerik` finds `İçerik-planı`, `/ILIK` finds `ılık-özet` and `/cozum` finds `çözüm-raporu`. Plain ASCII matching and ordering are unchanged. The channel's `@` menu also matches an agent by its **title** (a word prefix, so `@deep` finds "Deep researcher" whose slug is `oncall`) and shows the agent's face: its photo, or its initials. The thread composer has no `@` menu at all; a thread has one recipient.
- **Replying inside a thread** resumes the run's own session on the machine that ran it. The reply lands as your entry, the route answers `202` with a reply-job id, and the thread then shows the agent's post followed by a `Reply delivered` row with the turn's duration and cost (`Reply not delivered · … : <reason>` when it failed). Replies to two different agents run in parallel; two replies to the same agent do not, because the per-slug run lock owns that.
- **Replies only EXECUTE where the session is bound.** The session id comes from a machine-local store only the runner writes, so a reply can only ever continue a conversation this machine itself produced. The refusals are all named and all say why, in the server's own words, which the app, the CLI and Telegram all show as written:
  - `reply_disabled`: *"<Agent> is turned off. Turn it on to reply."*
  - `reply_unapproved`: *"<Agent> is not approved on this machine yet. Approve it, then reply again."*
  - `bad_text`: *"A reply needs something to say."*
  - `bad_run`: *"That run id is not a timestamp this channel wrote."*
  - `stale_run`: *"This conversation moved on. Reply on the newest run."* This is how a concurrent @mention or a scheduled fire mid-read surfaces; it is the one rung the thread panel words itself, with the same sentence.
  - `not_bound`: *"<Agent> has no session to talk to yet. It needs one finished run on this machine first."*
  - `question_pending`: *"<Agent> is waiting for your answer to its own question, so answer that first."* The panel then shows that question inline, so it can be answered where the refusal was read.
  - `busy`: *"<Agent> is still running. Try again when it finishes."* Only a run of THIS agent refuses its reply; another agent's run never does.

  A refused reply writes **nothing**, and the composer puts your text back in the field (`restoreLastSent`) instead of losing it; the same holds for a refused @mention in the channel.
- **The thread panel.** When the channel is at least 900px wide, it opens beside the feed at 40% of the row, and its left edge is a resize handle: drag it, or focus it and use the arrow keys (16px a step). Its width is clamped between 360px and 60% and remembered per machine. When the channel is narrower (a 1100px window with the sidebar open is already below it), the thread opens OVER the feed the way Chat's side panel does: a scrim covers the channel, the feed keeps its full width, there is no handle, and clicking the scrim closes it. **Esc** closes it (not while a `/` or `@` menu is open, and not while a file opened from it is showing), and closing returns focus to the control that opened it. A draft typed in a thread stays with that agent: switching to another agent's thread never carries it over, and coming back finds it again. A turned-off agent's thread shows **Turn on** instead of a field; an unapproved agent's shows a button that opens the agent for review. **Open session** appears only on a run whose own session this machine can reopen (the feed's `sessionOpenable`); a run still in flight, a fire that never ran, or a turn with no recorded session shows no such button rather than one that can only fail.
- **An @mention to an agent with an open question is refused asynchronously**, not with a 409 — the request succeeds and the refusal arrives in the thread seconds later as a `failed` entry carrying the same sentence. The reply route checks up front; the channel's mention path lets the resume's own guard answer, rather than keeping a second copy of it.
- **One agent per message, and the mention is required.** There is no default agent, so a message with nobody named would land and never be answered; Send stays off until one is, and the draft and any staged attachments are kept rather than cleared.
- **One run at a time per AGENT; different agents run in parallel.** The server keeps one run slot per agent: "run now" or an @mention of an agent that is already running adopts or refuses, while calling a different agent starts right away. The feed response (`GET /api/automations/threads`) carries `runSlots`, a map from slug to `{ runId, startedAt }` (`{}` when nothing runs), covering every run started through this server (an @mention, "run now", another tab). While any entry exists the feed polls every 2 seconds instead of 15. The channel's field is never disabled: only a draft that names a running agent is refused, with *"<Agent> is still running. Try again when it finishes."* under it, and its text and staged attachments stay. A thread's field goes read-only only while that thread's own agent runs. Scheduled (launchd) fires and reply turns are not in `runSlots`; the per-slug run lock in the runner still keeps any one agent from running twice at once.
- **An ask an agent cannot answer is refused at the door**, not swallowed: an agent that is turned off, or edited since it was approved, gets a 409 and **nothing is written to its channel** (*"<Agent> is turned off. Turn it on to call it."*, *"<Agent> is not approved on this machine yet. Approve it, then ask again."*, or `say_busy` with the same sentence as `busy`). For the dispositions that can only be discovered after the fire, an ask (and only an ask) writes a terminal `skipped` entry saying why, one of:
  - *"It did not run. This agent is not approved on this machine yet. Approve it, then ask again."*
  - *"It did not run. A sleep cycle holds the lock right now. Ask again once it finishes."*
  - *"It did not run. The run was orphaned before it started."*
  - *"It did not run. An earlier run of this agent is still waiting on your verdict. Clear that first."*
  - *"It did not run. The agent was edited since you approved it, so it asked about the change instead."*
  - *"It did not run. Another agent was already running."* or *"It did not run. The run could not be started on this machine."*

  A failed run's terminal row reads *"Failed after <duration>: <reason>"*, where the reason is the run's own opening line rather than the CLI's error flag (the dashboard shows just *"Failed after <duration>"* when the thread's root already carries that reason, so it is never said twice); a reply interrupted by a server restart reads *"Outcome unknown: the server restarted during this reply."* A scheduled fire still stays silent on those paths for the reason above; an ask happens once, so it answers once.
- **The ask reaches the prompt fenced and labelled as speech**, after the approved prompt, never as the job description. This is the one place a request body reaches a run's prompt, and the reason it is not an approval hole is that the approval hash covers the stored manifest: an ask is never stored, never hashed and never replayed by the scheduler. It is the owner typing, which is authorisation in the present tense.

**Reading it:**

```
dreamcontext automations thread <slug> [--run <id>] [--limit N] [--json]
dreamcontext automations read <slug> [--up-to <id>]
```

Unread is **per machine** — a watermark in `~/.dreamcontext/`, never synced, because a synced one makes another machine's badges wrong. It is monotonic: marking an older entry read never rewinds it. Your own replies never badge you.

**Where it lives, and why the format is what it is.** `automations/threads/<slug>/<YYYY-MM-DD>.md` — markdown frontmatter, then one fenced JSON entry per marker. One file per slug per **day**, because one file per slug conflicts on every run from two machines and one file per run is 288 files a day for a five-minute automation. Entries are **append-only and sorted by id**, never by clock, so two machines' appends merge without coordination; the reader tolerates git conflict markers and de-duplicates by id, which makes a conflicted thread **readable before anyone resolves it**. That is the format's most important property.

**A thread is never injected into a prompt.** It is a teammate-writable synced file, and treating it as an instruction source would be exactly the hazard the pattern block's framing exists to prevent.

**Threads follow their automation's sharing — and so do your replies.** A private automation's channel is git-ignored; a shared one's publishes alongside its manifest, cache and output. **Say this out loud when someone replies in a shared agent's thread: what they type is written into a brain-synced file and goes to the team brain**, the same as any other shared content. It is not a private aside to the agent. This needed a base wildcard (`automations/threads/*/*`) plus a fourth negation per shared slug, and upgrading vaults get both through a migration that repairs the ignore block's ORDER — appending a wildcard below existing negations silently disables every one of them.

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
| `automations post <slug> "…" [--file <p>]` | Post to this agent's channel. The run calls this itself; only what is IMPORTANT, and zero posts is a valid run. |
| `automations thread <slug> [--run <id>]` | Read a channel, or one run's thread. |
| `automations read <slug>` | Mark this machine's unread cleared for that channel. |
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
