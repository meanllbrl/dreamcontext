# Knowledge, Recall & Taxonomy — full reference

## Knowledge files

Deep, durable docs the agent should recall in future sessions (research, design rationale, domain context). The **index is auto-loaded each session** (names, descriptions, tags, staleness) — so you already know what exists.

**Knowledge is prose, not everything.** A metric the user wants tracked ("create an insight", "track MRR") is a **Lab insight** (`dreamcontext lab create` — see [tasks-and-features.md](tasks-and-features.md)); an outcome with a target date is a roadmap **objective**; what a shipped capability is belongs in a **feature PRD**. See the Entity Router in SKILL.md before creating anything.

```bash
dreamcontext knowledge create <name> -d "description" -t architecture,api -c "body"
dreamcontext knowledge index [--tag <tag>] [--plain]
dreamcontext knowledge tags
dreamcontext knowledge touch <slug>     # record access AFTER reading — powers staleness + warm loading
```

- **Pin** frequently-needed files so they load in full every session: set `pinned: true` (via `dreamcontext memory update <slug> --pin`). Read non-pinned files on demand, then `knowledge touch`.
- **Surgical edits mid-session**: `dreamcontext memory update <slug> [--description|--tags|--content|--append <text>|--pin|--unpin]`. Heavy maintenance (merging, deduping, restructuring) belongs to `sleep-product`.
- **Quick capture**: `dreamcontext memory remember "<text>"` writes a `type=note` CHANGELOG entry; sleep reconciles it into knowledge later.

### Organize knowledge into context folders (the promoted convention)

`knowledge/**/*.md` is indexed **recursively** — a file under `knowledge/<context>/` stays first-class in the index, recall, snapshot, and dashboard (its slug becomes `<context>/<name>`). The promoted layout is **context/topic-grouped folders**, not a flat dump and not a segregated `diagrams/` tree:

```
knowledge/
├── recall/                         ← a context folder
│   ├── recall-engine-v2.md
│   ├── decision-mem0-vs-bm25.md
│   └── recall/recall.excalidraw.md ← the context's diagram lives INSIDE the folder
├── federation/
│   └── ...
├── data-structures/{default,<product>}.md
└── products/<product>.md
```

**Don't reorganize by hand-moving files + hand-editing links.** To group an existing flat file into a context folder, use the atomic command:

```bash
dreamcontext knowledge move <slug> <folder>   # knowledge/<slug>.md → knowledge/<folder>/<basename>.md
```

It moves the file **and** rewrites every inbound `[[wikilink]]` in one atomic step (target token only; `|alias` and `#anchor` are preserved), keeps the file first-class in index/recall/snapshot/dashboard, and migrates its `knowledge_access` decay key. Folder names are free-form — nothing is reserved; nested folders are allowed; path traversal and clobbering an existing destination are rejected. Context grouping is normally done by `sleep-product` during consolidation — its "Organize" pass groups files that share a clear topic and calls this same command. During active work, just create knowledge with `dreamcontext knowledge create` and let sleep organize, or run `knowledge move` yourself — but never `mv` + hand-edit links by hand. When creating a brand-new doc you may place it directly in its context folder.

**Moving a whole board directory.** The **same command** relocates an Excalidraw board's `<title>/` wrapper folder as one unit — pass the **directory** slug instead of a file slug (`dreamcontext knowledge move diagrams/recall system` → `knowledge/system/recall/`). When `<slug>` resolves to a directory (and no `<slug>.md` exists) that contains a `*.excalidraw.md`, the command carries the board **and its dark tooling siblings** (`.board.cjs`, spec `.json`, helper `.md`) together, rewrites the path-based inbound `[[wikilinks]]` for every indexed `.md` inside (board + any co-located teardown), and migrates each file's decay key — so a board is never split from its generator across two folders. This is the sanctioned way to conform a legacy `knowledge/diagrams/<title>/` board (or any already-foldered board) to the **board-inside-its-context-folder** convention; you no longer need `mv`. A directory with no board inside is rejected (move plain knowledge with a file slug); so are traversal, self-nesting, and clobbering an existing destination.

---

## Memory functions — what they are and how to use them

The `memory` command group is your interface to the curated corpus: `knowledge/*` (`knowledge/features/*` loads as its own `feature` channel — `--types feature` vs `--types knowledge` — never double-counted), `state/*.md`, `core/2.memory.md` (Technical Decisions + Known Issues), every `core/CHANGELOG.json` entry, `core/objectives/*` (`objective` channel), and `lab/insights/*` (`insight` channel). No setup, no index file, no external service — rebuilt in memory each call (<100ms on ~130 docs).

| Function | Use it to… | Command |
|---|---|---|
| **recall** | Find prior decisions/context across the whole corpus | `dreamcontext memory recall <query...>` |
| **remember** | Capture a one-off fact mid-session before it's lost | `dreamcontext memory remember "<text>"` |
| **update** | Surgically edit a knowledge file (desc/tags/body/pin) | `dreamcontext memory update <slug> …` |
| **delete** | Remove a knowledge file (irreversible; recover via git) | `dreamcontext memory delete <slug> -f` |
| **list** | Enumerate the corpus by type | `dreamcontext memory list [--types …]` |
| **status** | See corpus size + breakdown by type | `dreamcontext memory status` |
| **recall mode** | Switch how recall ranks (haiku/raw/hybrid/off) | `dreamcontext recall on\|raw\|hybrid\|off\|status` |

### recall — your first-line discovery tool

**Run `memory recall` BEFORE grep or blind file reads** whenever the user asks "where did we decide X?", "have we discussed Y?", "what do we know about Z?", or before duplicating work. It ranks across knowledge + features + tasks + memory + changelog + objectives + insights in one shot.

```bash
# Plain discovery — top 10 hits with snippets
dreamcontext memory recall "how did we decide on the sleep fan-out"

# Narrow to where the answer likely lives (cheaper, sharper)
dreamcontext memory recall "auth flow" --types knowledge,feature
dreamcontext memory recall "deprecated" --types changelog        # ship history
dreamcontext memory recall "rate limit" --types task             # in-flight work
dreamcontext memory recall "retention goal" --types objective    # roadmap objectives (OKR outcomes)
dreamcontext memory recall "weekly active users" --types insight # lab insights (curated analytics metrics)

# Tune result count / machine-readable output
dreamcontext memory recall "rice prioritization" --top 3 --json
dreamcontext memory recall "vault registry" --plain              # no colors, for piping

# Span federation peers (see integrations.md)
dreamcontext memory recall "<query>" --connected                 # + out/both peers
dreamcontext memory recall "<query>" --vault other-project       # + one named peer (repeatable)
```
Read the hit's `slug`/path from the output, then `Read` that file for full context. Hits are scored (higher = better); cross-vault hits are namespaced `<vault>::<type>/<slug>`.

### remember — quick capture mid-session

```bash
dreamcontext memory remember "Chose BM25 over mem0 after a 3-reviewer review"
dreamcontext memory remember "<text>" --references decision:recall-v2,task:recall-engine
dreamcontext memory remember "<text>" --person mehmet,ada      # attribute (multi-person)
```
Writes a CHANGELOG entry (`type=note`, `scope=quick`); the sleep cycle reconciles it into knowledge later. You do NOT hand-edit `2.memory.md` for these (it no longer carries a LIFO notes section).

### Recall modes
| Mode | Behavior | Set with |
|---|---|---|
| `haiku` (**default**) | A small cloud model picks 0–3 relevant docs per prompt (smarter than keywords; BM25 fallback) | `dreamcontext recall on` |
| `raw` | BM25 keyword scoring only — no LLM call | `dreamcontext recall raw` |
| `hybrid` (**experimental**) | BM25 + local dense embeddings fused (multilingual, no LLM call; falls back to BM25 if the model is unavailable) | `dreamcontext recall hybrid` |
| `off` | No recall injection at all | `dreamcontext recall off` |
| — | Inspect current mode | `dreamcontext recall status` |

- **Auto-injection (ON by default):** the UserPromptSubmit hook surfaces top hits on every non-trivial prompt. Opt out with `DREAMCONTEXT_MEMORY_HOOK=0`; override mode per-session with `DREAMCONTEXT_RECALL_MODE`.
- **Federation:** plain `recall` automatically spans eligible readable peers; hits are namespaced `<vault>::<type>/<slug>`. Scope with `--vault`/`--connected`/`--all-vaults` (see [integrations.md](integrations.md)).

### What recall is and isn't
- BM25 is keyword/stemming-based, not semantic — "ML practitioner" won't match "data scientist" (haiku mode mitigates this).
- Recall does **not** replace the SessionStart snapshot (soul/user/memory/active-tasks/knowledge-index are always pre-loaded). It is not a vector DB or mem0; the corpus is the same set the sleep agents curate.

### Two depths of search: explore vs deep-research
Recall feeds two read surfaces — pick by how much synthesis the question needs:
- **`dreamcontext-explore`** (fast, single-pass): one sub-agent, recall-then-grep, one answer. Use for "where is X?" / "how does Y work?" on one project. This is the default and handles the vast majority of lookups.
- **`dreamcontext-deep-research` skill** (iterative, multi-agent): when a question needs **synthesis across a large or multi-project / federated corpus** and one explore pass comes back thin. The main agent decomposes the question, fans out parallel `dreamcontext-explore` searchers across the corpus **and connected peer vaults**, loops to close gaps, **adversarially verifies** the load-bearing claims, then writes a **synthesized, cited** report. Invoke via `/dreamcontext-deep-research`. **Escalation rule:** start with explore; escalate only when one pass and one answer leave a cross-corpus question half-answered. It is read-only — synthesis, not mutation.

---

## Root-cause analysis pattern

When debugging (e.g. "notifications are broken"):
1. `dreamcontext memory recall "notification"` — what's known + what changed?
2. SEARCH `core/CHANGELOG.json` / `RELEASES.json` for the term — what shipped recently?
3. READ `core/4.tech_stack.md` — how is the system wired?
4. SEARCH `knowledge/` for the module — any deep research?
5. Now diagnose with the full picture.

---

## Taxonomy (tags drive recall precision)

Consistent tags make recall sharp; fragmented near-duplicate tags degrade it. Before tagging anything, consult the vocabulary and reuse canonical faceted tags (`topic:recall`, `domain:security`) before inventing new ones.

```bash
dreamcontext taxonomy vocab [--facet <facet>] [--json]   # resolved vocabulary (defaults + core/taxonomy.json)
dreamcontext taxonomy resolve <tag>                       # normalized form, classification, canonical
dreamcontext taxonomy audit [--json]                      # surface non-canonical / orphan tags (read-only)
dreamcontext taxonomy audit --fix [--dry-run] [--json]    # BULK-normalize alias/normalizable tags → canonical
dreamcontext taxonomy init                                # scaffold core/taxonomy.json (idempotent)
dreamcontext taxonomy add <facet:value>                   # add a new vocabulary tag
dreamcontext taxonomy alias <alias> <canonical>           # merge a shorthand into a canonical tag
```
Standard bare tags: `architecture`, `api`, `frontend`, `backend`, `database`, `devops`, `security`, `testing`, `design`, `decisions`, `onboarding`, `domain`. **Never hand-edit `core/taxonomy.json`** — mutate via the CLI. `sleep-product` runs taxonomy maintenance during consolidation.

**Bulk-healing tag drift (`audit --fix`).** `taxonomy audit` only *reports* drift; `taxonomy audit --fix` *fixes* it in one shot across every knowledge/feature/task file. For each frontmatter tag it computes `normalizeTag → resolveAlias`; if that yields a **different tag that is canonical** in the vocabulary it rewrites it (e.g. `search → topic:recall`, `excalidraw → topic:excalidraw` once you've added that alias, `Architecture → architecture`). It is **safe by construction**: already-canonical tags are never touched (so `decisions` is not churned to `decision`), and orphan tags with no alias/canonical target are left untouched and reported as *"needs a vocab decision"* — resolve those first with `taxonomy add`/`taxonomy alias`, then re-run. The workflow is **alias-then-fix**: `taxonomy alias <orphan> <canonical>` teaches the mapping once, `audit --fix` applies it everywhere. Preview with `--fix --dry-run` (writes nothing), apply with `--fix`, automate with `--fix --json`. Idempotent — a second run is a no-op.

---

## Excalidraw boards (diagrams)

Excalidraw boards (`.excalidraw.md`) are first-class knowledge files. **A board belongs INSIDE the context folder it documents**, co-located with that context's `.md` knowledge — not in a separate top-level diagrams dump. A board lives in its own `<title>/` wrapper folder so its tooling siblings stay together:

```
knowledge/system/architecture/architecture.excalidraw.md   ← board inside its context folder
knowledge/recall/recall/recall.excalidraw.md
```

Rules:
- **REQUIRED frontmatter**: every board must have `name:` and `description:`. Boards with no `## Text Elements` fall back to description-only recall — make the description rich.
- **Do NOT hand-edit scene JSON.** The `.excalidraw.md` is generated output. Build a spec and run the generator (`.board.cjs`). Edit the spec, not the board. The spec is the source of truth; if they disagree, the spec wins. Commit both. (See the `excalidraw` skill pack for generating boards.)
- **Dark siblings**: tooling files inside a board's `<title>/` folder — generator scripts (`.board.cjs`), spec `.json`, and frontmatter-less helper `.md` — are excluded from index/recall/snapshot/dashboard. **Exception:** a companion `.md` with `name:` frontmatter is indexed as first-class, so you can co-locate a board with its teardown (`acme/acme.excalidraw.md` + `acme/acme.teardown.md`).
- **Indexing strips scene JSON/base64/element ids** — only frontmatter + `## Text Elements` are searchable, so a 2 MB board is as searchable as a tiny one. The dashboard renderer still gets the raw scene via the detail API and shows the full nested folder tree.

**Where does a board go?**
| Nature | Location | Indexed? |
|---|---|---|
| Canonical (architecture, flows, roadmaps a future session should recall) | inside its `knowledge/<context>/<title>/` folder | Yes |
| Temporary / scratch / exploratory | `inbox/` or `workspace/` (dark by location) | No |

Decision rule: *"Will a future session need this? → its context folder under `knowledge/`. Throwaway? → `inbox/` or `workspace/`."*

> **Legacy note:** older projects kept all boards under a single top-level `knowledge/diagrams/` tree. `dreamcontext migrations apply-diagrams` still *folds flat boards there into per-title folders* (in place, rewriting `[[wikilinks]]` atomically — never hand-edit links). To then **relocate a foldered board into its real context folder** — e.g. `knowledge/diagrams/recall/` → `knowledge/system/recall/` — run `dreamcontext knowledge move diagrams/recall system` (directory move; see "Moving a whole board directory" above), which carries the board + its tooling siblings as one unit. That legacy layout still indexes and renders, but new boards should go in their **context folder**, and `sleep-product` keeps the store organized over time.
