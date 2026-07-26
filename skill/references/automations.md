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

---

## The capture protocol

Automations are usually born from a conversation, not a form. When a user describes something they want to happen on a schedule, in any language, in their own words ("every evening at 6pm, pull together today's summary", "her cuma saat 17:00'de haftalık raporu çıkar", "on Tuesdays, look into X"), walk through this sequence:

1. **Detect the intent.** The shape is a recurring cadence plus an output. Watch for time-of-day or day-of-week phrasing combined with "do X" or "write X up" or "check on X".
2. **Dedupe first.** Before proposing anything new, check whether an automation already covers this. Use `dreamcontext automations list`, or `dreamcontext memory recall "<keywords>"`. Extend an existing automation's prompt rather than creating a near-duplicate.
3. **Agree the schedule and the output, in the user's own words.** Confirm the days, the time, and what the output should look like and where it should go, before writing anything.
4. **Scaffold it.** `dreamcontext automations create <slug> --title "..." --days <daily|mon,wed> --at HH:MM [--model] [--effort] [--timeout] [--catchup]`.
5. **Write the prompt from the conversation.** Edit the manifest's `## Prompt` section (and `## Output instructions` if the user cares how the result is formatted) to say, in full, what the scheduled run should do. This prompt is everything. The scheduled run has no user to ask follow-up questions, so it must be self-contained.
6. **Live-test it with the user watching.** `dreamcontext automations run <slug> --force` runs it right now, ignoring the schedule, and shows the user the actual output before they trust it to run unattended.
7. **Confirm.** Once the user is happy with a live-tested run, the automation is ready. `automations create` already auto-approved it on this machine, since the creator is the local human who wrote the prompt. Nothing further is required here, but see the approval section below for what happens the moment anyone else touches it.

If the dispatcher isn't installed yet, mention `dreamcontext automations install`. Nothing will actually fire on a schedule until that's done, even though the automation itself is created and approved.

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

Every automation carries a machine-local approval: a hash of exactly what it will do, computed the moment it's created, checked again every time it's about to run. If the prompt, output instructions, model, effort level, timeout, or output directory change, the hash no longer matches, and the automation is **blocked**. It will not spawn, on this machine, until a human reviews it again with `dreamcontext automations approve <slug>`. `approve` shows exactly what changed across all six of those fields before asking for confirmation, never just the prompt, because reviewing only the prompt would let a timeout or an output-directory change sail through unnoticed.

This is why the approval exists, and it exists regardless of whether the automation is shared. For a **shared** automation, the obvious case is a teammate's synced edit arriving through brain sync, and it's treated the same as new, unreviewed code. But approval isn't only about teammates: a fully **private** automation still has to re-approve after any of those six fields change, because anyone with local write access to this machine, not just a teammate, could alter the manifest before its next scheduled fire, and approval catches that too. Know precisely what that protection covers and what it doesn't.

1. **It does not limit what a run can do once it starts.** An approved automation can read or write any file it can reach, run any command, and access the network. Approving a prompt means "I read this and I would run it myself," not "I have limited what it's allowed to do."
2. **It does not follow references inside the prompt.** If a prompt says "read `knowledge/some-file.md` and follow its instructions," that file becomes an unreviewed, unhashed instruction source the moment anyone edits it. Approval never re-checks it. Never write an automation prompt that delegates its instructions to a file someone else can edit. Keep the instructions in the prompt itself.
3. **It does not vet the automation's own tools.** The `claude` CLI and the model it calls are trusted as-is.
4. **It is machine-local, not tamper-proof.** Approval lives outside the brain, in this machine's own configuration. Anyone with access to this machine's user account can forge one, the same trust boundary as your shell's own configuration files.
5. **It does not cover timing, or whether the automation is shared.** An automation's schedule (which days, what time, how enabled it is, and how generous its catch-up window is) and its `shared` flag are both deliberately not part of what's reviewed. A synced edit can move an automation from weekly to daily, or re-enable a disabled one with a wide catch-up window, without ever needing re-approval, because the behavior hasn't changed, only when it happens or where it's visible. Read that as a real capability change, not a technicality. The same prompt running four times as often, or resurrected after being turned off, is a bigger footprint even though nothing was re-reviewed.
6. **It does not vet the output for anything other than known credential shapes.** See the next section. This is important enough to read on its own.
7. **It does not stop a run once it's spawned.** See "Stopping a run" below.

## If it's shared, know what protects the output and what doesn't

If an automation is **private** (the default), its output never leaves this machine over git, so none of this applies. If it's **shared**, the output lands under `_dream_context/` and rides the same sync and push path as everything else in the brain, including the automatic push that happens on `sleep done` when cloud sync is on. Before sharing an automation whose output might be sensitive, understand exactly what stands between that output and your team's shared remote.

- **Credential-shaped secrets ARE caught.** A mandatory scrub runs before every commit and push, and it blocks outright on real, structured credential shapes: GitHub tokens, AWS keys, Google API keys, Slack tokens, Anthropic, OpenAI, and Stripe API keys, private-key headers, and JWTs. If a shared automation's output happens to contain one of these, the push stops.
- **Everything else is NOT caught.** The scrub matches known credential shapes, not "sensitive information" in general. Internal hostnames, customer data, private URLs, and any token or secret that isn't in one of the recognized shapes will pass through untouched. A path that looks like a home directory is flagged, but only as a soft warning. It does not stop a push on its own.
- **So only share automations whose output you'd be comfortable publishing to your team's remote.** If a scheduled digest might summarize something sensitive, keep the automation private, or say so explicitly in the prompt's output instructions so the run itself avoids including it.

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

Body sections:
- **`## Prompt`**: required. What the scheduled run should do. Written as if there is no one to ask follow-up questions, because there isn't.
- **`## Output instructions`**: optional. Extra guidance on formatting, tone, or where else the result should go.
- **`## Changelog`**: automatic run history notes, newest first.

---

## Quick reference

Full flags for every verb live in [cli-reference.md](cli-reference.md#automations).

| Command | What it's for |
|---|---|
| `automations create <slug>` | Scaffold a manifest and auto-approve it locally. |
| `automations list` / `show <slug>` | See every automation, or one in full: schedule, approval state, run history, and whether a previous run is still orphaned. |
| `automations run <slug> --force` | Run it right now, ignoring the schedule. The live-test step of the capture protocol. |
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
