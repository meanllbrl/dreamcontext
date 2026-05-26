---
name: multi-review
description: >
  Multi-agent code review with a router and niche specialists.
  Load when the user invokes `/multi-review`, says "multi-reviewer", "review with
  a team", "review this PR with specialists", "team review", "thorough review",
  or otherwise asks for a multi-aspect code review (security + cloud-functions
  + frontend + edge-cases) of a diff or branch. Routes the diff to relevant
  specialist sub-agents in parallel, then the main agent synthesizes findings
  into one greptile-style report.
tags: [review, multi-agent, sub-agents, orchestration, code-review]
alwaysApply: false
---

# Multi-Reviewer — orchestrated specialist code review

You are orchestrating a **multi-reviewer team**: a small cast of niche specialist
sub-agents that each review the diff from a single angle. **You** read the full
specialist reports, dedupe findings, and produce the final report directly.
Specialists run **in parallel**.

This skill is distinct from the existing single-reviewer `reviewer` agent and the
pre-implementation `three-reviewer-parallel-mandates-pattern` knowledge entry:

- **Use `reviewer` agent** for tiny diffs (≤10 lines, single domain).
- **Use three-reviewer parallel-mandates** for **pre-implementation** plan review
  (critic / pragmatist / security against a draft plan — no code yet).
- **Use multi-reviewer (this skill)** for **post-implementation** code review of a
  non-trivial diff that touches multiple domains.

## When to invoke

Trigger phrases / explicit invocations:
- `/multi-review` (slash command — primary entry)
- "multi-reviewer"
- "review with the team"
- "review this PR with specialists"
- "team review"
- "thorough review of my changes"
- "review my branch with all the reviewers"

**Use it for**: non-trivial diffs spanning multiple domains (e.g. Cloud Functions
+ frontend + security implications), pre-merge safety on critical paths,
production-bound changes touching auth/payments/data.

**Do NOT use it for**:
- Tiny diffs (≤10 lines, one file) — use the existing `reviewer` agent.
- Plan/spec review (no code written yet) — use `three-reviewer-parallel-mandates`.
- Style/formatting passes — those aren't worth specialist time.

## Flow (follow this exactly)

### 0. Identify the diff

Default: `git diff main...HEAD` on the current branch. If the user named a PR,
branch, or commit range, use that instead. Confirm the diff scope back to the
user in one line before dispatching anything (file count, line count, base ref).

If there are no changes, say so and stop.

### 1. Dispatch the router

Dispatch **one** `review-router` sub-agent with the diff in its prompt. It returns
a dispatch plan (JSON) with:

```json
{
  "tier": "trivial | lite | full",
  "specialists": ["security", "cloud-functions", "frontend", "edge-cases"],
  "scope": {
    "security": ["functions/auth/login.ts", "..."],
    "cloud-functions": ["functions/triggers/onUserCreate.ts"],
    "frontend": ["web/src/components/Login.tsx"],
    "edge-cases": ["functions/triggers/onUserCreate.ts", "web/src/components/Login.tsx"]
  },
  "rationale": "one-line why this set was picked"
}
```

**Short-circuit rules:**
- If `tier == "trivial"` and only one specialist is named → dispatch that one
  specialist alone, present its report directly.
- If `tier == "trivial"` and the router judges no specialist is needed →
  fall through to the existing `reviewer` agent and stop here.
- If `tier == "lite"` → dispatch the named specialists (usually 2–3) in parallel.
- If `tier == "full"` → dispatch all four specialists in parallel.

**Hot-path override**: any file under `auth/`, `crypto/`, files matching
`*.env*`, or migration files (`*.sql`, `migrations/**`) forces `security` to be
in the specialist set regardless of tier.

### 2. Dispatch specialists in parallel

In a single message, fire one `Agent` call per named specialist:
`review-security`, `review-cloud-functions`, `review-frontend`,
`review-edge-cases`. Pass each one only the files in *its* scope from the
dispatch plan (do not give every specialist every file — niche is the point).

Each specialist returns a full report (bounded, greptile-style markdown ≤1000
words) with an executive summary up top. You read the full reports to
synthesize the final report in step 3.

### 3. Synthesize the final report

Read every specialist's full report. Dedupe, re-rank, and produce one final
report yourself — no coordinator sub-agent. Apply these rules:

**Deduplicate**: for each (file, line, ~topic) flagged by multiple specialists,
keep one finding from the specialist whose domain best fits, cite all sources.

**Re-rank severity**: a specialist's `Major` may downgrade to `Minor` in the
full diff context (e.g. already rate-limited upstream). Downgrades need a
one-line justification. Upgrades are fine without justification.

**Drop false positives**: if a finding contradicts the diff context or loaded
skills, drop it. Note all drops in **Coordinator notes** so the user can verify.

**Compute verdict** per `REVIEWER_SHARED.md` §5:
- **`READY_TO_MERGE`** — every specialist returned PASS, no Critical, no Major.
- **`NEEDS_ATTENTION`** — any specialist returned CONCERNS, no Critical.
- **`NEEDS_WORK`** — any specialist returned FAIL (at least one Critical).

**Emit the report** inline using this structure:

```markdown
# Multi-Reviewer Report — <verdict>

**Verdict:** READY_TO_MERGE | NEEDS_ATTENTION | NEEDS_WORK
**Diff:** <files_changed> files, +<added>/-<deleted> lines, <base>...<head>
**Specialists ran:** <list>
**Dispatch tier:** <trivial|lite|full>

## Summary
<2–4 sentences.>

## Findings
### 🔴 Critical / ### 🟠 Major / ### 🟡 Minor / ### ⚪ Nits
<deduped findings, each with source tag e.g. *(security, edge-cases)*>

## What looks good
<1–3 bullets aggregated across specialists.>

## Open questions
<Aggregated, deduped. Only real questions.>

## Coordinator notes
<Drops, downgrades, upgrades and why. ≤5 bullets. Skip if none.>
```

**Critical never gets dropped silently** — downgrade explicitly with a reason.
Report ≤2000 words total.

If the user wants to act on findings, follow up by editing the relevant files
(do not auto-fix without confirmation on Critical findings).

## Hard rules

- **You read full specialist reports and synthesize yourself.** No coordinator
  sub-agent — you have full context and produce the final report directly.
- **Specialists run in parallel** in a single message with multiple Agent calls.
  Sequential dispatch defeats the architecture.
- **The router is mandatory** for tier ≥ lite. Skipping it means every specialist
  sees every file, which is exactly the noise this design eliminates.
- **Hot paths always get security**, regardless of tier.
- **Use `dreamcontext` skill** to look up the active task before starting — the
  review is scoped to what the task actually asked for, not a generic "things I'd
  prefer."

## Slash command wiring

The `/multi-review` command (configured in `.claude/settings.json` or wherever
slash commands are registered) invokes this skill. Skill-based fallback triggers
on the natural-language phrases listed in **When to invoke**.

## Relationship to other review surfaces

| Surface | When | This skill's relationship |
|---|---|---|
| `reviewer` agent (built-in, single) | Tiny diffs, final go/no-go gate | Standalone. Multi-reviewer can hand off to it for the final merge gate after fixes. |
| `greptile-style-review` skill | Generalist single-pass review | Becomes the **output spec** all specialists conform to (severity tags, format). |
| `three-reviewer-parallel-mandates-pattern` (knowledge) | Pre-implementation plan review | Different stage. Multi-reviewer is post-implementation. |
| `sub-agent-iterative-reviewer-pattern` | Single holistic post-impl review | Superseded by multi-reviewer for non-trivial diffs; still fine for tiny ones. |
