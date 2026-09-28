---
name: route-the-finding-to-the-lane-that-owns-the-file
description: >-
  A wave-parallel lane that finds a defect in ANOTHER lane's file reports it and
  does NOT fix it. The finding is routed to the owning lane's own resumed
  session as a delta. Fixing it in place produces two diffs to one file from two
  sessions that cannot see each other.
type: knowledge
tags:
  - 'kind:pattern'
  - architecture
  - 'topic:agents'
pinned: false
date: '2026-09-22'
---

# Route the finding to the lane that owns the file

## Why This Exists

In a wave-parallel build, each lane owns a disjoint set of files — that ownership is the entire
no-stomp guarantee. But lanes are not hermetic: lane T9 runs the test suite and a test fails for a
reason that lives in T6's hunk; a reviewer reads the whole diff and the Major it finds belongs to
T10. The tempting move is the helpful one — it is a one-liner, the lane is already in the file,
just fix it.

**Don't.** Two sessions editing one file cannot see each other's edits. The second write lands on a
copy of the file the first session never read, and the reconciliation happens at `git` level with
nobody holding the reasoning for either change. Worse, the lane that *owns* the file ends its run
believing its diff is what is on disk, and its own validation gate was run against a file that has
since moved.

## The Rule

> A lane that finds a defect outside its own file set **reports it and stops**. The orchestrator
> routes the finding to the owning lane's **resumed** session as a delta. The owning lane makes the
> fix, re-runs its own gate, and reports.

Three properties make this cheap rather than bureaucratic:

1. **The owning lane's session is resumable**, so the delta costs the delta, not a re-explore (see
   `fork-resume-builder-sessions.md`). Routing is a two-sentence prompt into a session that already
   holds the file, the design and the reason the hunk is shaped the way it is.
2. **The finder is the better diagnostician, the owner is the better fixer.** The report carries the
   evidence (which test, which line, which hunk, and often the suggested one-liner); the owner
   carries the context for whether that one-liner is right.
3. **The gate stays meaningful.** The owning lane re-runs *its* gate after *its* change. A
   cross-lane fix leaves a green gate that was never run against the final file.

## What the report looks like

A lane's report gets a dedicated section — not a footnote, not a fixed file:

```
## Cross-lane finding — yours, not mine to fix
`tests/unit/agent-board-assets.test.ts:122` ("404s a board that is not there") now returns 403.
Cause is T6's realpath hunk in `resolveServablePath`: `realpathSync.native` throws ENOENT on a
missing path, the catch sets `outside = true`, so a not-found board degrades to `needs_grant`
instead of 404. My entire diff to that file is one hunk at :316 in a different describe block.
Suggested one-liner for T6: re-decide on realpath only when the path exists.
```

Everything the owner needs, plus the sentence that makes the boundary explicit (*"my entire diff to
that file is one hunk at :316"*) — that is the finder proving it is not its own regression.

## Occurrences

- **2026-09-22, agents epic P4.** T9 found that T6's realpath containment hunk turned a
  not-found board from `404` into `403`/`needs_grant`. T9 reported it with the suggested fix and
  touched nothing; the orchestrator routed it to T6's resumed session.
- **2026-09-22, agents epic P5.** The code reviewer found a scratch-bucket object-URL leak and an
  unbounded retry poller, both in T10's files. Neither was fixed by the reviewer; both were routed
  to T10 as `delta2`, which fixed them and re-ran T10's own gate.

## The inverse also holds

A lane that is *handed* a cross-lane delta must not widen it. The delta prompt names the finding and
the gate; "fix both, nothing else" is part of the instruction, because a resumed session with a
green light is exactly where scope creep is cheapest to commit and most expensive to review.
