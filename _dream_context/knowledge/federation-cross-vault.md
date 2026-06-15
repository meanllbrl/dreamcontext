---
id: federation-cross-vault
name: "Cross-Vault Federation — When & What Two Vaults Read"
description: "End-to-end model of dreamcontext federation: current read-only live-reference model (crossVaultRecall default-on for connected peers, per-prompt hook, zero copies) + the parked copy-based PUSH half (sleep-driven sync/drain, disabled) kept as history. Covers the consent + watermark + transitive-leak gates, federation purge, and why there is no 'when X read Y' trigger."
tags: ["federation", "architecture", "memory", "recall", "decisions"]
pinned: false
date: "2026-06-15"
---

## The question this answers

"How do two connected projects know *when* to read each other? Which agent decides 'I should look there'? I connected them but never set a 'in situation X, read Y' rule."

The honest answer: **there is no such rule to set, because federation is not event-/trigger-driven.** A connection is not a conditional ("when working on auth, read the API vault"). It is a standing agreement that resolves through two mechanisms — a **PUSH** half that runs at sleep time and a **PULL** half that runs on demand. Neither needs a per-situation setting.

See the figure: `public/image/diagram-federation.png` (PDF: `public/image/diagram-federation.pdf`). Board source: `_dream_context/knowledge/diagrams/federation.board.cjs`.

## STATUS: federation is READ-ONLY (single-source-of-truth)

> **Changed (read-only pivot).** Federation now does ONE thing: **live read**. A
> connection means "this vault may READ a shareable peer's CANONICAL docs at recall
> time." Nothing is ever copied across a vault boundary. Each vault remains the sole
> source of truth for its own knowledge.
>
> The old **copy-based PUSH** (sleep `federation sync` → peer inbox → `federation
> drain` → `knowledge/<slug>--from-<vault>.md` with `federated:true`) is **disabled
> and parked on the roadmap.** It produced lossy (title + ~280-char summary +
> provenance), write-once-**stale** duplicates — a re-edited source did not refresh
> the copy; it spawned a `--from-<vault>` duplicate + a conflict-note bookmark. That
> broke SSoT, so it was removed from the active surface pending a redesign.
>
> - `federation sync` / `federation drain` are now **inert** (print a roadmap note,
>   write nothing). The `sleep-federation` specialist is **no longer dispatched**.
> - Leftover `federated:true` copies from the old path are removed with
>   `dreamcontext federation purge [--all | --vault <name>]` (deliberate, never auto-run).
> - The lib code (`federation-digest.ts`, `federation-ingest.ts`, `federation-inbox.ts`)
>   stays in-tree but **unreferenced by any live path** — the seed for the eventual
>   redesigned sync.
>
> Everything below the line about PUSH/digest/drain is **historical** — it documents
> the parked mechanism, not current behaviour.

## The live-read path (current behaviour)

`crossVaultRecall` (`src/lib/federation-recall.ts`) searches the current vault **plus
consenting peers live** — it builds each readable peer's corpus at query time and
merges BM25 hits, namespaced `<vault>::<type>/<slug>`. It writes nothing.

**This is now the DEFAULT, not flag-gated:**
- `dreamcontext memory recall "<query>"` already spans connected read-peers when any
  exist (`memory.ts` — `resolveConnectedVaults` ⇒ cross-vault recall; falls back to
  local when there are none).
- The **per-prompt UserPromptSubmit recall hook** (`hook.ts`) now ALSO spans connected
  read-peers live and prints a `— Connected peers (live read) —` block. Zero added
  cost when there are no read-connections (`resolveConnectedVaults` returns just the
  current vault and the block is skipped).
- Explicit scoping flags still work: `--connected` (out/both peers), `--all-vaults`
  (every shareable vault), `--vault <name>` (one named peer).

The read gate is unchanged: peer B is readable from A iff A→B direction is `out`/`both`
AND not stale AND B has `shareable: true`. `federated:true` docs are still excluded from
onward serving (transitive-leak guard) — though read-only federation no longer creates
any.

The SessionStart **snapshot** stays off the peer-resolution hot path: it shows a cheap
ambient "Connected projects" glance from the local `.peer-summaries.json` cache and
states that recall surfaces the peers' canonical docs live (no copies).

---

## HISTORICAL — the parked copy-based PUSH (do not re-enable without redesign)

### PUSH — sleep-driven, automatic *(DISABLED)*

The link in `state/.connections.json` (`direction: out|both`) used to mean: **at every sleep cycle**, the conditional `sleep-federation` specialist runs (it joins the fan-out only when there is an active connection OR a pending inbox). Its contract was two idempotent verbs, always in this order (`agents/sleep-federation.md`):

1. **`federation drain`** (first) — ingest inbound peer digests so this vault's corpus is current *before* it computes its own outbound digest.
2. **`federation sync`** (then) — compute a recall-filtered digest of what changed here and write one entry per item into each consenting peer's inbox.

After a peer's digest is drained into your vault, it was materialised as a **first-class local knowledge file** — `knowledge/<slug>--from-<vault>.md` with `federated: true` + provenance (`origin.vault`, `entryId`, `sourceTimestamp`). The flaw: that copy was a write-once **stale** snapshot — a re-edited source spawned a duplicate + conflict-note instead of refreshing it. This is exactly why the copy path was retired in favour of live read.

## What actually crosses the boundary

A common misconception is "only knowledge is shared." Not so. Three facts (all in `src/lib/federation-digest.ts`):

1. **Source = the FULL corpus.** `computeDigest` defaults to the whole corpus — `knowledge + feature + task + changelog + memory` — minus two exclusions (below). Feature PRDs, changelog entries, and tasks are all candidate sources, not just `knowledge/`.

2. **What crosses is a digest *entry*, not the file.** Each entry is `title` + `summary` (the doc's `description`, or the first 280 chars of the body) + a link + provenance. A lightweight pointer/summary travels, never the full document.

3. **Source type is kind-mapped, then everything materialises as knowledge on the receiver:**

   | Source type | Digest `kind` | On receiver |
   |---|---|---|
   | `changelog` | `changelog` | `knowledge/<slug>--from-<vault>.md` |
   | `task` | `decision` | `knowledge/<slug>--from-<vault>.md` |
   | knowledge / feature / memory | `knowledge` | `knowledge/<slug>--from-<vault>.md` |

   This is why, on disk and in the launcher graph, you only *see* knowledge files even though a feature or changelog may have been the source. The type survives in `kind` and `origin.entryId` (`<type>/<slug>@date`), but the physical form is a knowledge doc.

## The gates (the only knobs)

There is no "when" condition anywhere. The flow is governed solely by:

| Gate | Effect | Where |
|---|---|---|
| `direction` (out/both) | which way digests flow | `state/.connections.json` |
| `status` (active/stale) | dead peer skipped, warned once | `connections.ts` / sync |
| **consent** | sync writes to a peer only if that peer declares `in`/`both` back AND is `shareable` | `federation-recall.ts`, `federation-digest` sync |
| **watermark** (`last_synced_at`) | only docs changed since the last sync (undated docs included — safer to over-send) | `computeDigest` |
| **interest profile** | digest BM25-ranked to the peer's tags + active-task terms; empty profile ⇒ nothing sent (no blind dump) | `buildInterestProfile` |
| `topics` | filters **WHAT** subjects flow — not **WHEN** | connection `topics` field |
| **transitive-leak guard** | `federated:true` docs are never re-exported in a digest and never served across another boundary in `crossVaultRecall` | both libs |

## Why recall is not knowledge-only either

`buildCorpus` (`src/lib/recall.ts`) default types are `['knowledge', 'feature', 'task', 'memory', 'changelog']` (plus bookmarks/digest docs). Plain `recall` already spans all of them; `--types knowledge` is a *narrowing* flag, not the default. So both halves of the picture — what federates and what recall searches — are corpus-wide, not knowledge-scoped.

## Read-only by construction (security)

The browser-reachable `POST /api/federation/sync` is dry-run by construction: it computes the deltas a sleep cycle *would* push and returns `dryRun: true`; no file under `src/server/routes/` may import a federation write function. Every mutation lives in the CLI, run by the sleep specialist, where the consent check and the per-connection watermark advance sit together in one auditable place. A `conflict-note` (same slug/title, differing body) is surfaced as a bookmark and never auto-resolved.

## Sources

- `src/lib/federation-digest.ts` — `computeDigest`, `buildInterestProfile`, `kindOf`, watermark + transitive-leak filters.
- `src/lib/federation-recall.ts` — `crossVaultRecall`, `resolveConnectedVaults`, serving exclusion + consent gate.
- `src/lib/federation-ingest.ts` — drain → `knowledge/<slug>--from-<vault>.md` materialisation.
- `agents/sleep-federation.md` — drain-then-sync contract, idempotency, conflict handling.
- `src/lib/recall.ts:579` — default corpus types.
- DEEP-DIVE.md `## Federation` — the prose companion to this file.

## Last Verified

2026-06-15.
