---
id: know_eNIu8Puh
name: context-ceiling-economics
description: >-
  Measured cost model of agent context growth: cache_read is 97.4% of billed
  input, and resetting at 200k bills 2.2-2.6x fewer input tokens than growing to
  1M.
tags:
  - 'topic:context'
  - 'topic:agents'
  - 'kind:architecture'
  - decisions
pinned: false
date: '2026-09-13'
---

## Why this exists

This vault measured, on its own transcripts, what a long agent session actually costs — and the answer changed a product decision (the opt-in context handoff, shipped 2026-09-13 in `1e12c855`). The measurement is durable: it is a property of how prompt caching is billed, not of any one session. The owner's standing deliverable is an **article-grade write-up** built from this data; that article is still open (see "Open deliverable").

## The measurement

**Corpus:** 120 real dreamcontext sessions / **10,917 API calls**, read from `~/.claude/projects/-Users-mehmetnuraydin-projects-dreamcontext/*.jsonl`.

**Headline findings:**

1. **`cache_read` is 97.4% of billed input tokens.** Context is not paid for once — every turn re-reads the whole prefix. The bill is therefore the *area under the context curve*, not the peak.
2. **A 200k reset bills 2.2–2.6x fewer input tokens than growing to 1M** for the same work (~1.5x fewer dollars, and the same ratio in Max-plan quota burn — the dollar ratio is smaller than the token ratio because output and cache-write are priced far above cache read).
3. **The threshold dominates; the mechanism is secondary.** 150–250k is a flat optimum on the cap sweep. Compact-in-place vs restart-fresh *at the same threshold* is only a ~20% effect — so "where do you reset" matters an order of magnitude more than "how do you reset".
4. **Observed context routinely climbs to 500–775k** in real sessions, i.e. well past the knee, with nothing telling the agent it had crossed it.

**Live confirmation in this vault (2026-09-12/13), using the shipped `lastMainChainContext()` — not the simulator:**

| Session | Last main-chain context |
|---|---|
| `371d0fed…` (handing off) | **429,471** tokens |
| `d607e422…` (fresh, continued the same task) | **105,462** tokens |

**4.07x smaller, −75.4%** — and the fresh session then ran two sub-agents and the full test suite from that lower base. The handoff itself was recorded at 388,283 tokens (`state/.sleep.json` `compaction_log[0]`, `trigger: "handoff"`); the old session climbed to 429k before the rotation actually fired.

## Model parameters (so a future replay is reproducible)

Pricing used (Opus 5, per MTok): fresh input **$5**, output **$25**, **cache read $0.50**, 1h cache write **$10**, 5m cache write $6.25. Simulation constants: base context 45,500 · post-compact 25,000 · re-orientation after a restart 30,000 tokens over 6 calls · handoff write-out 3,000 output tokens · compact summary 15,000 output tokens.

The re-orientation allowance is the break-even lever: `sim.js` sweeps it from 0 to 800k, which is where the "is a restart worth it?" answer is actually decided. At the measured ~30k re-orientation cost, restart@200k wins comfortably.

## Where the raw data and scripts live

`_dream_context/inbox/context-ceiling-research/` (owner-curated, kept out of `knowledge/` deliberately — it is a data folder, not prose):

- `stream.json` — the extracted per-call delta stream (the replay input).
- `scan.js` — scans the transcript corpus; `deltas.js` — writes `stream.json`.
- `sim.js` — the policy simulator (restart@cap vs compact@trigger vs no-reset; cap sweep; break-even sweep).
- `replay.js` — replays real work against each policy.
- `traj.js` — emits the SVG polylines for the chart.
- `context-curve-200k-vs-1m.png` — **the visualization the owner wants**: the area under the context curve IS the bill, drawn for 200k-reset vs grow-to-1M.

Re-run with `TDIR=<transcript dir> node scan.js` → `node deltas.js` → `node sim.js` / `node replay.js` / `node traj.js`. Note `sim.js` and `traj.js` currently read `stream.json` from a hardcoded `/tmp/ctxmath/` path.

## What was built on it

`knowledge/features/opt-in-context-handoff.md` — the nudge at 200k, `dreamcontext tasks handoff`, and the Chat rotation. The research is the *why*; the PRD is the *what*.

## Open deliverable

The **article-grade report** is not written yet. Owner's words (★★★ bookmark `bm_pvboPypY`, 2026-09-13): *"çok net valide olmuş bir makale üstüne çıkmış bir deneme"* — a properly validated, essay-grade piece produced **from this data**, using the area-under-the-curve chart. Writing it is task work, not a sleep-cycle output.

## Sources

- Bookmark `bm_pvboPypY` (★★★, 2026-09-13) and `bm_0FY7Vfrb` (★★).
- Task `opt-in-context-handoff-the-agent-is-told-at-200k-that-it-may-move-its-state-into-the-task-and-continue-in-a-fresh-session` (`## Why`, Constraints).
- `_dream_context/inbox/context-ceiling-research/README.md` and the scripts above.
- Transcript `d607e422-59c7-4d6d-a69f-271c39989789.jsonl` (the live 4.07x measurement).
- Related: `knowledge/transcript-usage-accounting.md` (how per-session usage is computed — the accounting mechanics behind these numbers).

**Last verified:** 2026-09-13.
