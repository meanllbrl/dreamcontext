---
id: federation-cross-vault
name: "Cross-Vault Federation — When & What Two Vaults Read"
description: "End-to-end model of dreamcontext federation: the PUSH half (sleep-driven digest sync + drain) and the PULL half (crossVaultRecall via --connected). What actually crosses a vault boundary (the FULL corpus as a title+summary digest, not knowledge-only), how source types are kind-mapped and materialised as knowledge docs on the receiver, the consent + watermark + transitive-leak gates, and why there is no 'when X read Y' trigger."
tags: ["federation", "architecture", "memory", "recall", "decisions"]
pinned: false
date: "2026-06-15"
---

## The question this answers

"How do two connected projects know *when* to read each other? Which agent decides 'I should look there'? I connected them but never set a 'in situation X, read Y' rule."

The honest answer: **there is no such rule to set, because federation is not event-/trigger-driven.** A connection is not a conditional ("when working on auth, read the API vault"). It is a standing agreement that resolves through two mechanisms — a **PUSH** half that runs at sleep time and a **PULL** half that runs on demand. Neither needs a per-situation setting.

See the figure: `public/image/diagram-federation.png` (PDF: `public/image/diagram-federation.pdf`). Board source: `_dream_context/knowledge/diagrams/federation.board.cjs`.

## Two halves

### PUSH — sleep-driven, automatic

The link in `state/.connections.json` (`direction: out|both`) means: **at every sleep cycle**, the conditional `sleep-federation` specialist runs (it joins the fan-out only when there is an active connection OR a pending inbox). Its contract is two idempotent verbs, always in this order (`agents/sleep-federation.md`):

1. **`federation drain`** (first) — ingest inbound peer digests so this vault's corpus is current *before* it computes its own outbound digest.
2. **`federation sync`** (then) — compute a recall-filtered digest of what changed here and write one entry per item into each consenting peer's inbox.

After a peer's digest is drained into your vault, it is materialised as a **first-class local knowledge file** — `knowledge/<slug>--from-<vault>.md` with `federated: true` + provenance (`origin.vault`, `entryId`, `sourceTimestamp`). From that point it is *just local knowledge*. So the question "when is it read?" dissolves: the normal per-prompt recall (Haiku/BM25) surfaces it like any other local doc. **No special agent says "look at the peer"** — the peer's knowledge is already sitting locally.

### PULL — on-demand, only when you ask

`crossVaultRecall` (`src/lib/federation-recall.ts`) searches the current vault **plus consenting peers live**, but only when you explicitly run:

```bash
dreamcontext memory recall "<query>" --connected      # current + out/both peers
dreamcontext memory recall "<query>" --all-vaults     # current + every shareable vault
dreamcontext memory recall "<query>" --vault <name>   # current + one named vault
```

The default per-prompt UserPromptSubmit recall hook builds the corpus from a **single root** (the current vault) — it does **not** reach into peers live. Live cross-vault search happens only behind these flags.

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
