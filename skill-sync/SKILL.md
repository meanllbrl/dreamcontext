---
name: dream-sync
description: >
  Load when the user asks to sync/reconcile the dreamcontext brain repo with a team (a shared
  `_dream_context/` git remote), or when `dreamcontext brain sync` (or the SessionStart snapshot)
  reports a team merge awaiting resolution. Triggers: "/dream-sync", "sync the brain", "reconcile
  with the team", "resolve the brain merge conflict", "already-awaiting-agent", "awaiting-agent",
  "pending team-merge handoff". This is the agent half of the semantic-merge contract: the CLI
  resolves every deterministic file (JSON changelog/releases/config/taxonomy, task status +
  changelog) automatically and only ever defers PROSE files (knowledge/features) where two people
  edited the same section — you read base/ours/theirs snapshots and write the actual semantic
  merge, then hand back to the CLI to commit + push.
user-invocable: true
alwaysApply: false
tags: [sync, brain-repo, git, merge, collaboration, dreamcontext]
---

# /dream-sync — the agent half of the brain-repo merge contract

You are the **semantic merge resolver**. The CLI (`dreamcontext brain sync`) already did
everything it safely can on its own: every JSON class (changelog, releases, config, taxonomy) and
every task markdown file were merged and committed automatically — set-unions and furthest-status
logic never lose data and never need judgment. The ONLY thing left for you is **prose that two
people edited in the same `##` section** of a knowledge file or feature doc — a case the CLI
correctly refuses to resolve on its own (see `references/merge-rules.md` — the "C1 discard
contract"), because a naive textual merge mangles Markdown and a "remote wins" default would
silently throw away one author's words.

**Read `references/merge-rules.md` before touching anything** — it is the single source of truth
for the deterministic rules, the CLI-vs-agent split, and the full pull-only → resume → resolve →
continue state machine you are stepping into.

## Step 1 — determine the handoff state

Run `dreamcontext brain status`. It reports two independent booleans:

- `mergeInProgress` (a real git `MERGE_HEAD` exists) — the **classic** path: `brain sync` (auto
  mode) hit an agent-class conflict directly and left the merge open.
- `pendingAgentMerge` (no `MERGE_HEAD`, but a report was deferred) — the **pull-only** path: a
  headless background pull (session-start) hit the same conflict, but pull-only NEVER leaves the
  tree mid-merge — it aborted back to a clean commit and recorded the defer for you to redo
  attended.

Branch on exactly these two signals (equivalently: a plain `dreamcontext brain sync` returning
`already-awaiting-agent` tells you one of the two is true, without telling you which):

| State | What to do |
|---|---|
| `mergeInProgress: true` | Go straight to **Step 2** (report already exists, real `MERGE_HEAD`). |
| `pendingAgentMerge: true`, `mergeInProgress: false` | Run `dreamcontext brain sync --resume` FIRST. If it returns `pushed` or `pulled`, the handoff is DONE — the remote moved on and nothing needed your judgment. If it returns `awaiting-agent`, a FRESH report + a real `MERGE_HEAD` now exist — go to **Step 2**. |
| Neither | Just run `dreamcontext brain sync` (normal on-demand sync) — nothing to resolve. |

**You never call `--resume` when a `MERGE_HEAD` is already there, and you never skip `--resume`
for a `pendingAgentMerge`-only state** — the CLI enforces this with `invalid-flag`, but don't rely
on that as your only guardrail; read the state first.

## Step 2 — read the report and resolve each deferred file

Read `_dream_context/state/.brain-merge/report.json`. For each entry in `deferred`:

1. Read the three snapshots it names: `basePath` (common ancestor), `oursPath` (this machine's
   version), `theirsPath` (the remote/teammate's version) — all under `state/.brain-merge/`.
2. Write the semantically-merged content directly into the REAL file at `path` (repo-relative,
   possibly under an `_dream_context/` prefix in in-tree mode — strip it to find the file on disk).
   Preserve both authors' intent: don't just pick one side. For a knowledge/feature doc, merge
   section-by-section — sections only one side touched keep that side's version; sections BOTH
   touched are the ones you're here for — read them and write prose that keeps both people's point,
   reconciling wording, not concatenating raw diffs.
3. Stage it — run `git add <path>` at the project root (the git root is the project folder, so
   `path` carries the `_dream_context/` prefix).

Do this for every entry in `deferred` before moving on — `--continue` commits everything staged in
one shot.

## Step 3 — hand back to the CLI

Run `dreamcontext brain sync --continue`. It re-scrubs (a secret can be reintroduced by a merge —
never skip this), commits, and pushes (retrying once on a non-fast-forward race). On success the
report and its snapshot files are gone, `pendingAgentMerge` flips back to `false`, and a normal
`brain sync` runs cleanly from here on. If it instead reports `blocked-scrub`, something you wrote
looks like a secret or a local path — fix it and re-run `--continue`.

## What you must NEVER do

- **Never call `--resume` or `--continue` unattended / speculatively** — they are the explicit
  ATTENDED gates for exactly this handoff. `sleep done`'s autoSync, the session-start background
  pull, and the dashboard all stop at `already-awaiting-agent` and print the instruction to run
  `/dream-sync` — they never drive these flags themselves.
- **Never write the CLI's discarded remote-wins output** for a deferred knowledge/feature file —
  if you see `report.json`'s `deferred` entry for a path, that means the CLI's own attempt was
  thrown away specifically because it would have clobbered one side; only your snapshot-based
  merge is authoritative for that file.
- **Never hand-edit `.brain-merge/report.json`** or its snapshots — they are inputs, not outputs.
