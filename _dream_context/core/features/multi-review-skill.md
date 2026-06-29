---
id: feat_multirev001
status: active
created: '2026-05-24'
updated: '2026-06-21'
released_version: v0.8.7
tags:
  - 'topic:skills'
  - 'topic:cli'
  - 'topic:agents'
  - kind:testing
related_tasks:
  - multi-review-skill
---

## Why

A single generalist reviewer biases its findings toward whatever its mandate emphasizes. Non-trivial diffs crossing multiple domains (Cloud Functions + frontend + security) need niche reviewers that each know their domain cold — not one reviewer doing its best on everything.

The `/multi-review` skill productizes the multi-agent code review pattern: a router classifies the diff by tier and domain, dispatches niche specialist sub-agents in parallel, and a coordinator deduplicates findings into one greptile-style report. The dreamcontext-native innovation is that each specialist declares `skills:` in its YAML frontmatter — the specialists are skill-document-aware, reviewing against the live project rules the developer already consults when writing the code.

This is distinct from: (a) the existing single `reviewer` agent (suited only for trivial diffs), (b) the `three-reviewer-parallel-mandates-pattern` (pre-implementation plan review, no code yet).

Architecture depth: see `_dream_context/knowledge/multi-reviewer-pattern.md`.

## User Stories

- [ ] As a developer, I can invoke `/multi-review` (or say "thorough review of my changes") and have the router classify my diff automatically, so I don't have to pick which reviewers to run
- [ ] As a developer, I get findings from a security specialist that reads the real security skills, not just generic security best practices
- [ ] As a developer, I get findings from a Cloud Functions specialist that reads the firebase-cloud-functions skill, catching idempotency and scaling traps specific to that runtime
- [ ] As a developer, I get a single coordinator-deduped report instead of 4 overlapping specialist outputs, so I read one list of findings not four
- [ ] As a developer, production-critical paths (auth, crypto, env vars, migrations) are automatically escalated to Full tier with security always included, without me remembering to request it
- [ ] As a developer, trivial diffs are not routed through the multi-reviewer system — the skill routes them to the existing `reviewer` agent to avoid unnecessary overhead

## Acceptance Criteria

- [x] `.claude/skills/multi-review/SKILL.md` shipped — orchestration entry, fires on `/multi-review` slash command and natural-language triggers
- [x] `.claude/skills/multi-review/REVIEWER_SHARED.md` shipped — shared severity rubric (critical/major/minor/nit) and output format used by all specialists
- [x] `.claude/agents/review-router.md` shipped — classifies diff into tier (Lite/Standard/Full) + domain; emits JSON dispatch plan with `file_map` per specialist
- [x] `.claude/agents/review-security.md` shipped — covers secrets, auth/authz, injection, SSRF/CSRF/XSS, env-var leakage, weak crypto; declares no external skill (security fundamentals are embedded)
- [x] `.claude/agents/review-cloud-functions.md` shipped — covers infinite loops, idempotency, cold-start, scaling traps, billing gotchas; declares `engineering:firebase-cloud-functions` skill
- [x] `.claude/agents/review-frontend.md` shipped — covers file size, hook rules, a11y, design tokens, XSS sinks; declares `engineering:web-app-frontend` + `design` skills
- [x] `.claude/agents/review-edge-cases.md` shipped — covers null/empty, concurrency, partial failures, retries; default-on for tier >= Lite
- [x] `.claude/agents/review-coordinator.md` shipped — sole reader of all full specialist reports; dedupes, re-ranks, drops false positives; emits unified verdict (READY_TO_MERGE / NEEDS_ATTENTION / NEEDS_WORK)
- [ ] Tested on a real non-trivial diff — router classification thresholds and coordinator dedup wording validated against actual findings

## Constraints & Decisions

### 2026-05-24 — Coordinator-only reads full reports (council isolation pattern)
Main agent reads only executive summaries from each specialist. The coordinator is the only agent that reads all full specialist reports. This prevents main agent context accumulation at scale — the same isolation the `/council` skill uses. Keeps the main agent light even for Full-tier reviews.

### 2026-05-24 — Skill-declaration is mandatory for all specialist agents
Every specialist agent must list required skills in YAML frontmatter `skills:` field AND in a `## Skills always loaded` body section (per `feedback_agent_skills_declaration` rule). Agents that skip this have frozen rules; agents that declare skills get live updates when the skill file changes.

### 2026-05-24 — Hot-path override is unconditional
Files matching `auth/`, `crypto/`, `*.env*`, or migration file patterns force Full tier + `review-security` regardless of diff size. This is non-negotiable: a 2-line change to `functions/auth/login.ts` deserves full security review.

### 2026-05-24 — Trivial diffs routed out to existing `reviewer` agent
The skill explicitly routes ≤10-line single-domain diffs to the existing `reviewer` agent. Multi-reviewer overhead is not justified below that threshold.

## Technical Details

**Orchestration entry**: `.claude/skills/multi-review/SKILL.md` — the main agent loads this skill when `/multi-review` fires or a trigger phrase matches. The skill instructs the main agent to: (1) call `review-router` with the diff, (2) fan out specialists in parallel based on the JSON dispatch plan, (3) collect executive summaries, (4) call `review-coordinator` with full reports + summaries, (5) return coordinator output.

**Router output schema**:```json
{
  "tier": "Lite | Standard | Full",
  "specialists": ["security", "cloud-functions", "frontend", "edge-cases"],
  "file_map": { "<specialist>": ["<file>", ...] }
}```
**Specialist scope discipline**: each specialist receives only the `file_map` entries for its domain from the router output. No specialist reads the entire diff — scoped file lists keep context windows focused.

**Coordinator isolation**: main agent passes all specialist full reports to `review-coordinator` in a single prompt. Coordinator emits one unified verdict. Main agent forwards verdict to user.

**All files reside in the project's `.claude/` directory** (not in `_dream_context/`): skills under `.claude/skills/multi-review/`, agents under `.claude/agents/review-*.md`. These are project-specific, not dreamcontext CLI files.

**v1 status**: architecture verified, all 8 files shipped, untested on a real diff. First real run expected to require iteration on router classification thresholds and coordinator dedup prompt.
