---
name: dreamcontext-deep-research
description: >
  Load when a question needs synthesis across a LARGE or MULTI-PROJECT dreamcontext corpus —
  more than `dreamcontext-explore` can answer in a single fast pass — or the user invokes
  `/dreamcontext-deep-research`. Triggers: "deep research the brain", "research this across my
  projects", "synthesize what we know about X across everything", "deep dive across the
  connected vaults", "explore is too shallow for this", "pull together everything on X and
  cite it", "cross-project / cross-corpus question", or any "tons of data, federated/tagged
  vault" question where one explore agent and one answer under-serves. This is the heavy,
  iterative, sub-agent-driven counterpart to `dreamcontext-explore`: it fans out searchers over
  the whole curated corpus (knowledge + features + tasks + memory + CHANGELOG + objectives) AND connected
  peer vaults, adversarially verifies the load-bearing claims, and returns a SYNTHESIZED, CITED
  report — not raw hits.
user-invocable: true
alwaysApply: false
tags: [deep-research, recall, synthesis, federation, cross-project, orchestration, sub-agents, dreamcontext]
---

# Deep Research — iterative, sub-agent-driven corpus synthesis

You are the **orchestrator**. Like `curator`, `initializer`, `multi-review`, and `council`,
**you do not do the bulk of the searching yourself** — you decompose the question, fan out
`dreamcontext-explore` searchers in parallel, read their cited findings, loop to close gaps,
adversarially verify the claims that matter, and then **you** write the synthesized report. Your
value is the decomposition, the gap loop, the verification gate, and the final synthesis — not
running every `recall` and `grep` by hand.

**Why this exists, vs `dreamcontext-explore`.** Explore is tuned for **speed and a single
answer**: one Haiku agent, a tight tool-call budget, recall-then-grep, return the best hit. That
is the right tool for "where is X?" / "how does Y work?" on one project. It **under-serves** the
question that needs *synthesis across many files and many projects*: "what have we decided about
recall across all my vaults?", "reconcile everything we know about federation", "pull the whole
history of how the sleep cycle evolved and cite it". For those, a single fast pass returns a
fragment and stops. Deep research is the escalation: **iterative fan-out → verify → synthesize a
cited answer**.

| | `dreamcontext-explore` | `dreamcontext-deep-research` (this) |
|---|---|---|
| Shape | one sub-agent, one pass | main agent orchestrates many searchers + verifiers, looped |
| Budget | tight (1–20 tool calls) | scaled to the corpus; multiple waves |
| Scope | one project, narrow | whole corpus + **connected peer vaults** |
| Output | the best hit, fast | a **synthesized, cited** report reconciling sources |
| Verify | none | adversarial pass on load-bearing claims |
| Use when | "where / how is X?" | "synthesize / reconcile / research X across everything" |

**It is read-only.** Deep research never mutates the corpus. It may *recommend* capturing a
finding (a knowledge file, a feedback item) at the end — but only with the user's say-so, via the
normal CLI. It is not a writer.

**Recall is the engine; the corpus index + peer connections are the substrate.** Every wave starts
from `dreamcontext memory recall` (BM25 + Haiku intent extraction over the curated corpus), which
already spans readable peers and namespaces cross-vault hits `<vault>::<type>/<slug>`. You are not
grepping a blind filesystem — you are mining a pre-indexed, cross-project brain.

## When to invoke

- `/dreamcontext-deep-research` (primary entry).
- A `dreamcontext-explore` pass came back thin, fragmented, or "found a piece but not the whole
  picture", and the real question spans many files.
- The question is explicitly **cross-project / federated**: "across my vaults", "everything we
  know about X", "reconcile what project A and project B decided".
- "Synthesize", "reconcile", "pull together and cite", "deep dive", "research" over the brain.

**Scale the machinery to the corpus.** A small single-project brain rarely needs this — say so and
just run one `dreamcontext-explore`. Reserve the full fan-out for a genuinely large or multi-project
tagged corpus where one agent and one answer leave the question half-answered.

## Commitment ritual (do this FIRST)

1. **Announce**: tell the user you're running deep research — that it fans out read-only searchers
   across the whole corpus and any connected peer vaults, verifies the key claims, and ends in a
   cited synthesis. Confirm the question and its scope (which vaults, which time range if any).
2. **TodoWrite** the phases (1–6) so the gates are visible. A phase isn't done until its gate passes.
3. **Sharpen the question.** If it's underspecified ("research recall"), narrow it with the user
   first (recall *precision*? recall *architecture*? across *which* projects?) — a vague question
   fans out into vague reports. One or two clarifying questions beat a 10-agent wild goose chase.

## The flow (the main agent runs this directly — sub-agents can't nest)

In this harness a sub-agent cannot dispatch sub-agents, so **you** own the loop and the fan-out —
exactly like the sleep cycle. `dreamcontext-explore` is your searcher *and* your verifier; you are
the planner and the synthesizer.

### Phase 1 — Scope & seed (recall-driven)

- Establish the corpus surface: read the **Connected projects** section of the snapshot, or run
  `dreamcontext connections list` / `dreamcontext vaults list`. Decide the span:
  - current vault only → recall as-is (already spans eligible peers by default),
  - specific peers → `--vault <name>` (repeatable),
  - everything readable → `--connected` (out/both peers) or `--all-vaults`.
- If the brain **governs linked code repos** (`dreamcontext links` → resolved local paths for the bare product repos it points at, no `_dream_context/` of their own), those checkouts are part of the substrate too: a fan-out searcher can Grep/Read a governed product's *code* directly when a claim depends on the implementation, not just the docs. Missing (✗) linked repos aren't on this machine — note the gap rather than guessing.
- **Seed with recall, in JSON, scoped by type:**
  ```bash
  dreamcontext memory recall "<facet>" --json --top 15 --types knowledge,feature,task,memory,changelog,objective --connected
  ```
  Run it for **2–4 different phrasings/facets** of the question — recall is cheap (<100ms, zero
  token overhead) and different keywords surface different docs. Collect the union of hits.
- **Decompose** the question into 3–6 sub-questions / facets / per-project slices. This decomposition
  is the fan-out plan. Write it into the Todo.

### Phase 2 — Fan-out search (parallel `dreamcontext-explore`)

- Dispatch **one `dreamcontext-explore` per sub-question / corpus slice / project, in parallel**
  (one message, multiple `Agent` calls). Each searcher gets:
  - its narrow sub-question,
  - the seed hits relevant to it (file paths / `<vault>::<slug>` from Phase 1 — so it doesn't
    re-discover them),
  - an explicit instruction: **return findings WITH citations** (absolute path or
    `<vault>::<type>/<slug>`), and flag anything that looks contradictory or stale.
- Searchers are read-only and recall-first by design — that's the whole point of using them. Scope a
  searcher to a peer when a specific sibling project owns that slice (it can `recall --vault`,
  `snapshot --vault`, or read the peer's files directly).

### Phase 3 — Gap loop (loop-until-dry)

- Read every searcher's report. Build a running map: **claim → source(s)**.
- Identify **gaps** (a facet nobody answered), **contradictions** (two sources disagree), and
  **dangling references** (a doc cites another you haven't read). Dispatch a **second wave** of
  `dreamcontext-explore` aimed only at those.
- Stop when a wave returns nothing materially new (two dry waves) or the picture is complete enough
  to answer. **Log what you chose not to chase** — silent truncation reads as "covered everything".

### Phase 4 — Adversarial verification (the gate)

- For each **load-bearing claim** (the ones the answer actually rests on), dispatch a
  `dreamcontext-explore` **verifier** whose job is to *check the claim against its cited source* —
  open the file, confirm the source says what the claim says, and look for a more recent doc that
  supersedes it. Default to **"unverified"** when the source doesn't actually support the claim.
- Drop or downgrade claims that don't survive. A plausible-but-uncited assertion does not enter the
  report. This is what separates deep research from a confident hallucination.

### Phase 5 — Synthesize (you write this — not a sub-agent)

- **You** write the report from the verified claim→source map. It must be a *synthesis*, not a
  concatenation of searcher outputs:
  - **Answer** — the reconciled conclusion, organized by the question's structure.
  - **Every claim carries a citation** — absolute path or `<vault>::<type>/<slug>`. No citation ⇒
    it doesn't go in (or it's explicitly marked as inference).
  - **Cross-project provenance** — when projects agree, say so; when they diverge, surface the
    divergence with both sources rather than silently picking one.
  - **Contradictions & open questions** — name them; don't paper over them.
  - **Confidence** — note where evidence is thin or a source looked stale.

### Phase 6 — Persist (optional, only on consent)

- If durable findings emerged ("we actually decided X across A and B" / "these three docs are
  near-duplicates"), **offer** to capture them — a `dreamcontext knowledge create`, or a
  `dreamcontext feedback` if deep research exposed a recall/structure gap. Never auto-write; the
  user confirms. Deep research is a reader.

## Output contract

A **synthesized, cited report** — never a raw hit dump. The minimum bar:
- Citations are **mandatory** for every load-bearing claim (path or `<vault>::<type>/<slug>`).
- Cross-vault hits are first-class, not noise — provenance is the point on a multi-project corpus.
- Contradictions and gaps are surfaced, not hidden.
- Any coverage you deliberately capped is stated.

## Boundaries

- **Read-only.** No writes except the optional, consent-gated Phase 6 capture via the normal CLI.
- **Reuse `dreamcontext-explore`.** Don't reinvent a searcher — it's the tested, recall-accelerated,
  read-only explorer. This skill is the *orchestration* around it.
- **Stay in the decisions/knowledge lane.** For raw code *structure* ("who calls this function?")
  the code-graph lane (graphify) owns it — deep research synthesizes curated decisions/knowledge, it
  is not an AST indexer.
- **Scale to the corpus.** Don't fan out 10 agents at a 12-file single-project brain. Match the
  machinery to the data.

## Relationship to the rest of dreamcontext

- **vs `dreamcontext-explore`** — explore is the fast single-pass searcher; this is the iterative
  multi-agent synthesizer that *uses* explore. Escalate from explore → deep-research when one pass
  and one answer leave a cross-corpus question half-answered.
- **vs `sleep`** — sleep *writes* (consolidates experience into memory); deep research *reads*
  (synthesizes existing memory into an answer). Same fan-out shape, opposite direction.
- **vs `curator`** — curator refactors the corpus's *shape*; deep research mines its *content*.
- **vs the generic `deep-research` web skill** — that one researches the open web; this one researches
  *your brain* (the curated corpus + connected vaults). Same harness shape, different substrate.
