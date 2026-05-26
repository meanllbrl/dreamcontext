---
name: business-idea-validation
description: >
  Sequential stage-gate pipeline for deep business idea validation. 9 stages,
  6 specialist sub-agents, kill gates between every stage. Takes an idea from
  raw concept through problem validation, customer analysis, market sizing,
  competitive intel, customer simulation, synthesis, GTM strategy, financial
  viability, to a scored Go/No-Go decision. Each stage builds on all prior
  artifacts — the pipeline is strictly sequential, not parallel.
tags: [business, validation, startup, pipeline, sub-agents, orchestration, stage-gate]
alwaysApply: false
---

# Business Idea Validation — sequential stage-gate pipeline

You are orchestrating a **validation pipeline**: a sequence of specialist
sub-agents that each execute one stage of business idea validation, producing
a cumulative dossier. Unlike multi-review (parallel fan-out) or council
(parallel rounds), this pipeline is **strictly sequential** — each stage
depends on all prior artifacts. Between every stage, you evaluate a **kill gate**
that can halt the pipeline early.

## When to invoke

Trigger phrases / explicit invocations:
- `/validate-idea`
- "validate this business idea"
- "run idea validation"
- "is this idea worth pursuing?"
- "go/no-go on this concept"
- "business idea validation"
- "validate my startup idea"
- "stage-gate this idea"

**Use it for**: deep validation of a specific business idea — the user already
has a concept and wants to stress-test it before committing time/money.

**Do NOT use it for**:
- Finding ideas from scratch → use `business-idea-discovery` skill.
- Quick vibes check → just answer directly.
- Post-build growth → use `growth` skill.
- Technical feasibility review → use `engineering` skill.

## Relationship to `business-idea-discovery`

`business-idea-discovery` = find ideas fast (single agent, 2-5 hours).
`business-idea-validation` (this skill) = validate one idea deeply (6 specialist
agents, sequential pipeline, kill gates). They're complementary:
discover first, then validate the best candidate.

---

## Flow (follow this exactly)

### 0. Capture the brief

Ask the user:
1. **What's the idea?** (product/service description)
2. **Who is it for?** (target audience, if known)
3. **What problem does it solve?** (core pain, if known)
4. **Ambition level?** — VC-scale ($100M+) or bootstrapped profitable ($1-10M)?
   This affects market sizing gates.
5. **Do you have any existing research?** (interviews, data, prior analysis)

Write the answers to `_biv/{idea-slug}/00-brief.md`. The slug is kebab-case
derived from the idea name (e.g., `ai-loyalty-programs`).

Initialize `_biv/{idea-slug}/pipeline-state.json`:
```json
{
  "idea": "<slug>",
  "ambition": "vc | bootstrapped",
  "current_stage": 0,
  "stages": {
    "1": { "status": "pending", "confidence": null, "gate": null },
    "2": { "status": "pending", "confidence": null, "gate": null },
    "3": { "status": "pending", "confidence": null, "gate": null },
    "4": { "status": "pending", "confidence": null, "gate": null },
    "5": { "status": "pending", "confidence": null, "gate": null },
    "6": { "status": "pending", "confidence": null, "gate": null },
    "7": { "status": "pending", "confidence": null, "gate": null },
    "8": { "status": "pending", "confidence": null, "gate": null },
    "9": { "status": "pending", "confidence": null, "gate": null }
  },
  "started_at": "<ISO timestamp>",
  "completed_at": null,
  "verdict": null
}
```

### 1-9. Execute stages sequentially

For each stage (1 through 9), follow this protocol:

#### a. Dispatch the specialist

Dispatch the appropriate sub-agent (see Agent-Stage Mapping below) in
**foreground** (not background — you need the result before proceeding).

The sub-agent's prompt MUST include:
- The idea brief (`00-brief.md` contents)
- All prior stage artifacts (read each `{NN}-*.md` file and include contents)
- The stage number and what it must produce
- The ambition level (affects scoring thresholds)
- Any user feedback from a prior WEAK gate iteration

#### b. Read the sub-agent's output

The sub-agent writes its artifact to `_biv/{idea-slug}/{NN}-{stage-name}.md`
and returns an executive summary + confidence score + any kill signals.

#### c. Evaluate the gate

Read the sub-agent's structured output. Apply the gate:

| Gate Result | Condition | Action |
|---|---|---|
| **PASS** | Confidence ≥ 3, no kill signals | Update `pipeline-state.json`, show exec summary to user, proceed |
| **WEAK** | Confidence = 2, no kill signals | Show findings to user. Ask: "Iterate this stage with adjustments, or proceed with acknowledged risk?" |
| **KILL** | Confidence ≤ 1 OR kill signals present | Stop pipeline. Show findings + kill reasons. Recommend: pivot the weak dimension or abandon the idea. |

If WEAK and user says "iterate": re-dispatch the same sub-agent with the
user's feedback appended. Max 2 iterations per stage — after that, force
a decision (proceed or kill).

If WEAK and user says "proceed": mark gate as "passed_with_risk" and continue.

#### d. Update state

After each gate decision, update `pipeline-state.json` with:
- `status`: "completed" / "passed_with_risk" / "killed"
- `confidence`: the sub-agent's score (1-5)
- `gate`: "pass" / "weak_proceed" / "weak_iterate" / "kill"

### Agent-Stage Mapping

| Stage | # | Agent | Model |
|---|---|---|---|
| Problem Discovery | 1 | `biv-researcher` | sonnet |
| Customer Analysis | 2 | `biv-customer-analyst` | sonnet |
| Market Sizing | 3 | `biv-market-analyst` | sonnet |
| Competitive Intelligence | 4 | `biv-researcher` | sonnet |
| Customer Validation (simulated) | 5 | `biv-customer-analyst` | sonnet |
| Synthesis & Hypothesis | 6 | `biv-strategist` | opus |
| GTM Strategy | 7 | `biv-strategist` | sonnet |
| Financial Viability | 8 | `biv-financial-analyst` | sonnet |
| Go/No-Go Decision | 9 | `biv-decision-gate` | opus |

Note: `biv-researcher` is called at stages 1 AND 4 with different prompts.
`biv-customer-analyst` is called at stages 2 AND 5 with different prompts.
`biv-strategist` is called at stages 6 AND 7 with different prompts.
`biv-strategist` defaults to opus — pass `model: sonnet` explicitly when
dispatching for Stage 7 (GTM is less synthesis-heavy than Stage 6).

### 10. Present the verdict

After Stage 9 completes, read `09-go-no-go-decision.md` and present:
- The scorecard (8 dimensions, each scored 1-5)
- The total score and verdict: **GO** (30-40) / **PIVOT** (18-29) / **NO-GO** (8-17)
- A pipeline summary: which stages passed clean, which had risk, which were strong

If GO: offer to generate a Lean Canvas as a capstone (re-dispatch `biv-strategist`
to produce `10-lean-canvas.md` from all artifacts).

If PIVOT: identify the weakest dimension(s) and recommend which stage to re-run.

If NO-GO: frame it as a success — "you just saved months of wasted effort."

---

## Resume protocol

If a conversation breaks mid-pipeline:
1. Read `_biv/{idea-slug}/pipeline-state.json`
2. Identify `current_stage` and which stages are completed
3. Tell the user: "Pipeline for '{idea}' is at Stage {N}. Stages 1-{N-1} are
   complete. Resuming from Stage {N}."
4. Continue from the next pending stage

The user can also explicitly say "re-run stage 4" to re-execute a specific stage
with updated context.

---

## Hard rules

- **Stages run strictly sequentially.** Never dispatch two stages in parallel.
  Every stage depends on prior artifacts.
- **You evaluate gates, not the sub-agents.** Sub-agents produce artifacts and
  confidence scores. You decide PASS/WEAK/KILL based on the scoring rubric.
- **All artifacts go to disk.** Every stage writes `_biv/{slug}/{NN}-name.md`.
  This is the cumulative dossier — it persists across conversations.
- **Sub-agent prompts include ALL prior artifacts.** Stage 6 receives outputs
  from stages 1-5. Stage 9 receives outputs from stages 1-8. No stage operates
  in isolation.
- **Max 2 iterations per stage.** A WEAK gate allows one re-run. After 2
  attempts, force a proceed-with-risk or kill.
- **Context budget**: keep your main-agent context under ~20K tokens. You read
  executive summaries from sub-agents, not their full research. The full
  artifacts are on disk for subsequent sub-agents to consume.
- **Stage 5 uses AI simulation.** Customer validation is synthesized from
  Reddit/forum data collected in Stage 1. The artifact is marked as
  "synthetic validation" with an automatic confidence cap of 3 (never higher).
  Tell the user that real interviews would increase confidence.

## Slash command

`/validate-idea` invokes this skill. Natural-language triggers listed above
also activate it.
