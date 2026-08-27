---
id: federation-cross-vault
name: "Cross-Vault Federation — When & What Two Vaults Read"
description: "End-to-end model of dreamcontext federation: live-reference READ (crossVaultRecall default-on for connected peers, per-prompt hook, zero copies) + peer mail WRITE (addressed agent-to-agent correspondence, headless delivery, v0.25.0) + the parked copy-based PUSH half (sleep-driven sync/drain, disabled) kept as history. Covers consent gates, delivery modes, and why correspondence is not derived copies."
tags: ["topic:federation", "architecture", "domain:knowledge", "topic:recall", "decisions"]
pinned: false
date: "2026-06-15"
updated: "2026-08-26"
---

## The question this answers

"How do two connected projects know *when* to read each other? Which agent decides 'I should look there'? I connected them but never set a 'in situation X, read Y' rule."

The honest answer: **there is no such rule to set, because federation is not event-/trigger-driven.** A connection is not a conditional ("when working on auth, read the API vault"). It is a standing agreement that resolves through two mechanisms — a **PUSH** half that runs at sleep time and a **PULL** half that runs on demand. Neither needs a per-situation setting.

See the figure: `public/image/diagram-federation.png` (PDF: `public/image/diagram-federation.pdf`). Board source: `_dream_context/knowledge/diagrams/system/federation/federation.board.cjs`.

## STATUS: federation has both READ and WRITE again (but the write half is new)

> **Changed (v0.25.0 — peer mail ships).** Federation now has BOTH halves:
>
> **READ** (unchanged): live recall across vault boundaries. A connection means "this vault may READ a peer's canonical docs at recall time." `crossVaultRecall` searches live; nothing is copied. Each vault remains the sole source of truth for its own knowledge.
>
> **WRITE** (new): **peer mail** — addressed agent-to-agent correspondence. One vault can send a note/question/command to a connected peer; the peer answers from its OWN brain via a headless `claude` run rooted in its own directory. Messages live at `state/.peer-mail/` and are duplicated on both ends of a thread (correspondence is SUPPOSED to be duplicated — both sides hold the full conversation locally). Mail never materializes as knowledge files.
>
> **Why mail is not the parked digest:** the old **copy-based PUSH** (sleep `federation sync` → peer inbox → `federation drain` → `knowledge/<slug>--from-<vault>.md` with `federated:true`) carried *derived knowledge copies* — a write-once snapshot of someone else's knowledge that went stale the moment the source changed. That broke SSoT and was retired. Peer mail carries *addressed messages* instead: a question gets an answer, a note surfaces in the peer's next snapshot, and the thread lives in a mailbox that is not the knowledge corpus. Same disk neighborhood (`state/.peer-mail/` vs `state/.federation-inbox/`), different contract, separate directory.
>
> - The parked digest path (`federation sync` / `federation drain`) remains **disabled** — those commands print a roadmap note and write nothing. The `sleep-federation` specialist is **no longer dispatched**.
> - Leftover `federated:true` copies from the old path are removed with `dreamcontext federation purge [--all | --vault <name>]` (deliberate, never auto-run).
> - The lib code (`federation-digest.ts`, `federation-ingest.ts`, `federation-inbox.ts`) stays in-tree but **unreferenced by any live path** — the seed for a future redesigned sync if one is ever warranted.
>
> Everything below the line about PUSH/digest/drain is **historical** — it documents the parked mechanism, not current behavior.

## The live-read path (current behaviour)

`crossVaultRecall` (`src/lib/federation-recall.ts`) searches the current vault **plus
consenting peers live** — it builds each readable peer's corpus at query time and
merges BM25 hits, namespaced `<vault>::<type>/<slug>`. It writes nothing.

**This is the DEFAULT, not flag-gated (v0.8.5 matured this path significantly):**
- `dreamcontext memory recall "<query>"` spans connected read-peers when any exist
  (`memory.ts` — `resolveConnectedVaults` ⇒ cross-vault recall; falls back to local
  when there are none). **Default cross-vault hit count: `topK = 10`** (was 5 before
  v0.8.5 — raised to match the local recall depth for symmetric coverage).
- The **per-prompt UserPromptSubmit recall hook** (`hook.ts`) spans connected read-peers
  live and prints a `— Connected peers (live read) —` block. Zero added cost when there
  are no read-connections (`resolveConnectedVaults` returns just the current vault and
  the block is skipped).
- Explicit scoping flags still work: `--connected` (out/both peers), `--all-vaults`
  (all registered vaults), `--vault <name>` (one named peer).
- **`dreamcontext federation peers`** (v0.8.5) — CLI command that refreshes peer
  summaries on demand and prints them compactly. Calls `refreshPeerSummaries()` from
  `src/lib/federation-peer-summary.ts`; also runs automatically during the sleep cycle.

**The read gate (v0.23.0 — shareable retired).** Peer B is readable from A iff A→B
direction is `out`/`both` AND not stale. **The old `shareable: true` gate was removed**
(commit `6bf9871`, 2026-08-01): drawing the connection IS the consent, end to end. A
vault could be wired and still return nothing, which read as "federation is broken" far
more often than "privacy" — these are one person's own projects on one machine. The
toggle is gone from the CLI, config route, Settings, and federation board. `.config.json`
still round-trips the old key for compatibility, but nothing branches on it.
`federated:true` docs are still excluded from onward serving (transitive-leak guard) —
though read-only federation no longer creates any.

The SessionStart **snapshot** stays off the peer-resolution hot path: it shows a cheap
**ambient "Connected projects" glance** from the local `state/.peer-summaries.json`
cache (written by `federation peers` / sleep cycle / post-connection). Zero peer I/O at
session start; recall surfaces the peers' canonical docs live (no copies). If the cache
is absent the section is silently skipped.

Per peer the glance carries `whatItIs`, the last 1–2 changelog headlines, the active
task, top tags, **and each peer's `pinned: true` doc titles** (`Pinned docs:` line —
knowledge + features, scanned recursively over `knowledge/**` plus `core/features/` for
un-migrated peers, alphabetically sorted, capped at 5). Pinned is the peer's own
"load-bearing / canonical" signal, so this gives the agent a free table-of-contents of
each peer's most important docs without a live recall. Titles only — content still comes
from recall (`--vault <name>`). Built by `readPinnedTitles` in
`src/lib/federation-peer-summary.ts`; refreshed on the same off-hot-path cadence as the
rest of the summary, so a newly-pinned peer doc surfaces on the next refresh.

## The write path — peer mail (v0.25.0)

**Peer mail** is agent-to-agent messaging across connected vaults: one vault addresses another with a note, question, or command, and the peer answers from its OWN brain.

**Three message kinds:**
- `note` — FYI. Deferred: surfaces in the peer's next SessionStart snapshot. No spawn, no token cost.
- `question` — Wants an answer. Delivered LIVE: spawns a headless `claude -p --permission-mode auto` run rooted in the PEER's project directory. The peer's SessionStart hook fires, so it answers from its own soul/memory/knowledge. The answer comes back as a reply on the same thread.
- `command` — Wants work done. Live, and the ONLY kind that may modify the peer's repo — always under `auto` permissions, never bypass.

**Storage:** `state/.peer-mail/<id>.json`, one file per message, with `archive/` for closed threads. Messages live in the vault they were addressed TO; replies are written back into the sender's dir on the same thread. Both sides therefore hold the full thread locally — this is correspondence, which is SUPPOSED to be duplicated. It never materializes as knowledge files.

**Consent gate (same rule as read):** an active, non-stale connection is sufficient consent. Drawing the connection IS the consent — the v0.23.0 precedent (commit 6bf9871) that retired the separate `shareable` opt-in. A peer may ask; what it may DO is held by `PEER_PERMISSION_MODE = 'auto'` (a constant — no caller-supplied path to bypass).

**Surfaces:**
- **CLI:** `dreamcontext peer send|ask|inbox|read|thread|reply|done`
- **Snapshot:** "Peer mail" section with pending count (never evicts — a peer waiting is load-bearing)
- **Dashboard Chat (v0.25.0):** `@` mention picker lists connected peers; addressing one opens a live session panel with the peer's transcript (ItemView), permissions (PermissionCard), and a real Composer — the app's own chat components mounted on the peer's session object. The panel is a VIEW; the session (WebSocket + child process in the peer's directory) stays mounted in a holder so it survives close→reopen.

**Envoy sub-agents:** each active connection generates `.claude/agents/peer-<vault>.md` carrying the peer's identity, routing rule ("ask when the answer must be reasoned, or when recall came back empty"), and real path. Retracted on disconnect.

**Permission asymmetry:** in a HEADLESS delivery (CLI), a permission prompt has nobody to answer it — the peer reports itself blocked. In the DASHBOARD peer session, the socket is two-way and the holder stays mounted, so there IS somebody to ask: the permission renders in the panel and answering it unblocks the peer. This is by design.

**Why this is not the digest inbox:** the parked `federation sync/drain` path carried *derived knowledge copies* — a lossy snapshot of someone else's knowledge that went stale instantly. Peer mail carries *addressed messages*: a question → reasoned answer, a note → surfaces in snapshot, a thread lives in a mailbox that is not the knowledge corpus. Correspondence vs derived copies; separate contracts, separate directories.

See the feature PRD: `knowledge/features/peer-mail.md`. Implementation: `src/lib/peer-mail.ts`, `src/lib/peer-delivery.ts`, `src/lib/peer-agent-gen.ts`, `src/cli/commands/peer.ts`, `src/server/routes/peer.ts`, `dashboard/src/components/sleepy/chat/PeerSessionCard.tsx`.

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
| `direction` (out/both) | which way digests flow (read-only mode: which vault reads which) | `state/.connections.json` |
| `status` (active/stale) | dead peer skipped, warned once | `connections.ts` / recall |
| **consent (v0.23.0 — simplified)** | Drawing the connection IS the consent; no second opt-in. Old `shareable` gate removed (6bf9871) | `federation-recall.ts` |
| **watermark** (`last_synced_at`) | (PARKED — copy-based push disabled) only docs changed since the last sync | `computeDigest` (unreferenced) |
| **interest profile** | (PARKED — copy-based push disabled) digest BM25-ranked to the peer's tags + active-task terms | `buildInterestProfile` (unreferenced) |
| `topics` | (PARKED — copy-based push disabled) filters **WHAT** subjects flow | connection `topics` field (round-tripped, not enforced) |
| **transitive-leak guard** | `federated:true` docs are never re-exported in a digest and never served across another boundary in `crossVaultRecall` | both libs (copy-path disabled, guard still enforced for old docs) |

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

2026-08-01 (v0.23.0 — shareable gate retired, Space launcher).
