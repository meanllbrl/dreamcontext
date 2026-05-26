---
id: multi-reviewer-pattern
name: "Multi-Reviewer Pattern (router + niche specialists)"
description: "Productized multi-agent code review pattern: router classifies diffs by tier + domain, dispatches niche skill-aware specialists in parallel, main agent reads all reports and synthesizes directly (no coordinator sub-agent). Dreamcontext-native innovation: each specialist declares required skills in YAML frontmatter. Distinct from the pre-implementation three-reviewer-parallel-mandates pattern and the post-implementation sub-agent-iterative-reviewer pattern. v1.1: coordinator removed 2026-05-26."
tags: ["architecture", "decisions", "agents"]
pinned: false
date: "2026-05-26"
---

## Why This Exists

A single generalist reviewer agent has a systematic failure mode: the reviewer's own framing biases what it sees. A "find bugs" reviewer misses env-var leakage; a security reviewer misses frontend scalability issues; a general reviewer misses Cloud Functions scaling traps. Stacking these as sequential rounds works but compounds latency.

The deeper problem: generalist prompts produce generalist findings. A specialist that reads `engineering:firebase-cloud-functions` before it reviews Cloud Functions code catches idempotency violations, infinite-loop traps, and billing-clock mistakes that a generalist either misses or flags weakly. The rubric is not generic best practice — it is the exact rules that apply to this runtime.

Three external reference systems converged on specialist routing as the right architecture:

- **Cloudflare (2025)**: 7 specialist sub-agents, router-dispatched, ~131K reviews/month in production. 75% of diffs classified Trivial/Lite at scale — the router cuts cost substantially vs "all agents run always". Finding: specialists + router > one large LLM call.
- **HAMY (2025)**: 9 parallel Claude Code sub-agents, all run on every diff. No routing. High thoroughness, higher cost, no tier skipping. Strength: simplicity of no router. Weakness: every Lite diff pays Full cost.
- **Qodo 2.0 (2025)**: multi-agent with a coordinator to deduplicate. Noted that the biggest value of multi-agent review is reducing false positives at aggregation, not just catching more issues.
- **Anthropic official `code-review` plugin**: single specialist, no routing. Handles the "trivial diff" case well; not suited for multi-domain PRs.

The dreamcontext pattern is a hybrid: Cloudflare's routing + a dreamcontext-native layer others don't use: **skill-aware specialists**. Unlike Qodo, we skip the coordinator sub-agent — the main agent already sees all specialist reports and can dedupe directly.

## The Pattern

**Structure (sequential phases, specialists in parallel within phase 2):**

```
diff
  └─→ [review-router]  (classifies: tier × domain → JSON dispatch plan)
         └─→ parallel dispatch:
               [review-security]       ← files under auth/, crypto/, *.env*
               [review-cloud-functions] ← Cloud Functions files
               [review-frontend]        ← React/frontend files
               [review-edge-cases]      ← default-on for tier >= Lite
         └─→ main agent reads all full reports, dedupes, emits unified verdict
               READY_TO_MERGE / NEEDS_ATTENTION / NEEDS_WORK
```

**Router output (JSON):**

```json
{
  "tier": "Lite | Standard | Full",
  "specialists": ["security", "cloud-functions", "frontend", "edge-cases"],
  "file_map": {
    "security": ["functions/auth/login.ts"],
    "cloud-functions": ["functions/src/processOrder.ts"],
    "frontend": ["src/components/Checkout.tsx"]
  }
}
```

**Tier classification:**

| Tier | Trigger | Specialists |
|---|---|---|
| **Trivial** | ≤10 lines, 1 domain | Skip to single `reviewer` agent |
| **Lite** | ≤50 lines, 1-2 domains | edge-cases + relevant domain |
| **Standard** | >50 lines or 2+ domains | domain specialists + edge-cases |
| **Full** | auth/, crypto/, *.env*, migrations | All specialists, always |

**Hot-path override**: any file matching `auth/`, `crypto/`, `*.env*`, or migration patterns forces **Full** tier + `review-security` regardless of diff size.

**No coordinator sub-agent**: the main agent reads all full specialist reports and synthesizes directly. This eliminates one agent dispatch (latency + tokens) without losing quality — the main agent already has the diff context and can dedupe/re-rank in-place.

## Skill-Aware Specialists — The Dreamcontext Innovation

Neither Cloudflare, HAMY, nor Qodo use declared-skill loading. Their specialists have hardcoded prompts that describe the domain rules inline. The dreamcontext approach is different: each specialist agent file declares `skills:` in its YAML frontmatter (per the `feedback_agent_skills_declaration` rule). The session hook auto-loads those skills at specialist invocation time.

Concrete consequences:

- `review-cloud-functions` declares `skills: [engineering:firebase-cloud-functions]`. When it runs, it reads the live Cloud Functions skill file — the same authoritative rules the developer uses when writing the code. If those rules are updated, the reviewer picks up the update without a prompt change.
- `review-frontend` declares `skills: [engineering:web-app-frontend, design]`. It evaluates against the project's actual design token system and component patterns, not generic React best practice.
- `review-security` has no skill dependency — security fundamentals are sufficiently stable to embed in the prompt directly.

This means the reviewers are **in sync with the project's own standards**, not frozen at the time the agent was written. It is a documentation-driven review — the same documentation the author consults.

## Roster of Files Shipped (v1.1, 2026-05-26)

| File | Role |
|---|---|
| `skill-packs/multi-review/SKILL.md` | Orchestration entry; invoked by `/multi-review` or natural-language triggers |
| `skill-packs/multi-review/REVIEWER_SHARED.md` | Shared rubric: severity levels (critical/major/minor/nit), output format, what NOT to flag |
| `skill-packs/agents/review-router.md` | Classifies diff into tier + domain; emits JSON dispatch plan |
| `skill-packs/agents/review-security.md` | Secrets, auth/authz, injection, SSRF/CSRF/XSS, env leaks, weak crypto |
| `skill-packs/agents/review-cloud-functions.md` | Infinite loops, idempotency, cold-start, scaling traps, billing gotchas |
| `skill-packs/agents/review-frontend.md` | File size, hook rules, a11y, design tokens, XSS sinks |
| `skill-packs/agents/review-edge-cases.md` | Null/empty, concurrency, partial failures, retries; default-on for tier >= Lite |

Note: `review-coordinator.md` was removed in v1.1. Main agent reads all specialist reports directly and synthesizes the final verdict inline.

## Comparison to Peer Patterns

| Pattern | Stage | Structure | When |
|---|---|---|---|
| **Single `reviewer` agent** | Post-impl | 1 generalist agent | Trivial diffs, ≤10 lines |
| **`sub-agent-iterative-reviewer-pattern`** | Post-impl | 1 holistic reviewer across parallel workstreams | In-session multi-workstream sign-off |
| **`three-reviewer-parallel-mandates-pattern`** | Pre-impl | 3 mandate-diverse generalists (critic/pragmatist/security) against a plan | "Should we build this?" decisions |
| **`/multi-review` (this pattern)** | Post-impl | Router + 4 niche specialists, main agent synthesizes | Non-trivial code diffs, multi-domain |
| **Cloudflare (external)** | Post-impl | 7 specialists + router | ~131K reviews/month, no skill-loading |
| **HAMY (external)** | Post-impl | 9 parallel, no routing | All diffs pay full cost |
| **Qodo 2.0 (external)** | Post-impl | Multi-agent + coordinator | Coordinator dedup emphasis |

Key distinctions vs external peers: dreamcontext specialists are skill-document-aware (live rules, not frozen prompts), and the tier system avoids HAMY's "all agents always" cost profile.

## When to Use It

- Non-trivial diffs that cross domain boundaries (Cloud Functions + frontend + auth in one PR).
- Production-bound changes where a missed security issue or Cloud Functions trap would cause an incident.
- Pre-merge safety checks on any branch touching `auth/`, `crypto/`, `*.env*`, or migrations.
- When you want a structured written report with severity-rated findings, not just a conversational review.

## When NOT to Use It

- Tiny, single-domain diffs (≤10 lines, one file) — use the existing `reviewer` agent. `/multi-review` dispatches sub-agents with overhead that is not justified for a 3-line change.
- Pre-implementation plan reviews — use `three-reviewer-parallel-mandates`. No code exists to review yet; specialist agents need real files.
- Style or formatting passes — those are not worth specialist time and will produce mostly `nit` findings with no material signal.
- When you need an answer in seconds — specialist dispatch adds latency. For a quick gut-check, use the `reviewer` agent.

## Known Limitations (v1)

- **Untested on a real diff.** The architecture is theory-verified (drawn from external case studies and internal code review). Router classification thresholds will require iteration on first real non-trivial PR.
- **No diff-ingestion convenience.** The user must manually pass the diff or file list to `/multi-review`. A future version could auto-detect the current branch's diff against main.
- **No test coverage.** There are no automated tests for router classification or output format correctness.

## Sources

- Cloudflare blog: "How we built an AI code reviewer" (2025) — cloudflare.com/blog/ai-code-reviewer
- HAMY blog: "Multi-Agent Code Review with Claude Code" (2025) — hamy.io/post/multi-agent-code-review-with-claude-code
- Anthropic official: `claude-code/plugins/code-review` — anthropic.com/engineering/claude-code-best-practices
- Qodo benchmark articles: qodo.ai/blog/multi-agent-code-review
- Session: `79bddcc5-e485-4de6-ad45-e7afd7cb8dc2` (2026-05-24) — architecture design and file shipping

## Coordinator Removal (2026-05-26)

The `review-coordinator.md` agent was deleted in session `1cace19b`. Rationale: the main agent already receives every specialist report as a tool result in its context. The coordinator's only job was deduplication + re-ranking, which the main agent can do inline. The extra agent dispatch added latency and token cost without a quality gain. The one theoretical advantage of the coordinator — a clean context with only the reports, no conversation history — was judged insufficient to justify the overhead.

**Impact on the pattern:**
- `skill-packs/agents/review-coordinator.md` — deleted.
- `skill-packs/multi-review/SKILL.md` — flow updated: step 3 "dispatch coordinator" replaced by "main agent synthesizes directly."
- `skill-packs/multi-review/REVIEWER_SHARED.md` — "coordinator" references replaced with "main agent."
- `skill-packs/catalog.json` — `relatedAgents` no longer lists `review-coordinator`.

The shipped file roster is now 7 files (was 8): SKILL.md, REVIEWER_SHARED.md, review-router.md, review-security.md, review-cloud-functions.md, review-frontend.md, review-edge-cases.md.

The architecture summary in "The Pattern" section above remains correct with the coordinator row removed from the flow.

## Last Verified

2026-05-26.
