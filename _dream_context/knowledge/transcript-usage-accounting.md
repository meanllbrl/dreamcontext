---
id: knowledge_transcript_usage_accounting
name: transcript-usage-accounting
description: >-
  How dreamcontext computes accurate per-session cost and usage from Claude Code
  transcripts: message.id deduplication, Anthropic API pricing, and sidechain
  handling.
type: knowledge
tags:
  - layer:backend
  - topic:dashboard
  - kind:architecture
  - topic:desktop
pinned: false
created: '2026-07-16'
updated: '2026-07-16'
---

## Why this exists

The dashboard's per-session cost and context statistics (displayed in the agent terminal and session views) are computed from Claude Code transcript JSONL files. Three non-obvious implementation details govern accurate accounting: transcript structure causes message.id duplication, API pricing varies by model tier and cache type, and sidechain (subagent) turns must not inflate context footprint. Future sessions adding new pricing tiers or debugging usage discrepancies need these facts grounded.

## Implementation

**Location:** `src/server/routes/agent-terminal.ts` (`computeSessionStats` function)

## Transcript structure — message.id deduplication is MANDATORY

**Claude Code transcripts write one JSONL line PER CONTENT BLOCK of an assistant message.** Each line repeats the same `message.id` and identical `usage` object. If you naively sum `usage.input_tokens` across all lines, you **multiple-count by ~2.5x** (observed average).

**Correct aggregation:** deduplicate by `message.id` before summing usage. Track seen message IDs in a Set and skip duplicate entries.

```typescript
const seenMessageIds = new Set<string>();
for (const line of transcriptLines) {
  const event = JSON.parse(line);
  if (event.type === 'message' && event.message?.id) {
    if (seenMessageIds.has(event.message.id)) continue; // skip duplicate
    seenMessageIds.add(event.message.id);
    // now aggregate usage from event.message.usage
  }
}
```

Without this guard, dashboard cost/usage stats will be inflated by 2–3x.

## Anthropic API pricing (as of 2026-07-16)

Current list prices used by `computeSessionStats`:

| Model Tier | Input ($/MTok) | Output ($/MTok) |
|---|---|---|
| Fable | $10 | $50 |
| Opus 4.5+ | $5 | $25 |
| Legacy Opus (4.1/4.0/3) | $15 | $75 |
| Sonnet | $3 | $15 |
| Haiku | $1 | $5 |

**Cache pricing:**
- **Cache write** = 1.25× input price (5-min TTL)
- **Cache read** = 0.1× input price

**Long-context premium:** NONE on current 1M-token-context models.

**Maintenance rule:** when Anthropic changes model pricing or introduces new model tiers, **re-verify prices against the `claude-api` skill** (never from memory) before updating `computeSessionStats`. Do not trust stale pricing in code comments or this doc — the skill is the source of truth.

## Sidechain turns — exclude from context footprint

Turns with `isSidechain: true` are **subagent turns** — they are billed (count toward cost), but they run in **their own context window** separate from the main session. These turns must NOT drive the "context used" or "context footprint" display, or the dashboard will show inflated memory pressure for the main agent.

**Accounting rule:**
- **Cost aggregation:** include sidechain turns (they consume tokens and money).
- **Context footprint / "memory used" display:** exclude sidechain turns (they don't compete with the main agent's context window).

```typescript
const totalCost = allTurns.reduce(/* sum usage */);
const mainContextTokens = allTurns
  .filter(t => !t.isSidechain)
  .reduce(/* sum input tokens */);
```

## Sources

- Signal from sleep cycle 2026-07-16 (committed fcdb1b2)
- Implementation: `src/server/routes/agent-terminal.ts`
- Pricing source of truth: `claude-api` skill

## Last verified

2026-07-16
