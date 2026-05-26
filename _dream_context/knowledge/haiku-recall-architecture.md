---
id: haiku-recall-architecture
name: "Haiku Single-Call Recall Architecture"
description: "Why dreamcontext replaced multi-query BM25 keyword extraction with a single Haiku LLM call for intent-aware recall in the UserPromptSubmit hook. Covers the architecture, security hardening (execFileSync, corpus cap), fallback behaviour, multi-review security findings that shaped the implementation, and the relationship to the existing BM25 layer."
tags: ["architecture", "decisions", "memory", "search"]
pinned: false
date: "2026-05-26"
---

## Why This Exists

The original UserPromptSubmit hook injected BM25 recall by tokenizing the raw user prompt into keyword queries. This worked for explicit, English, on-topic queries, but had three failure modes:

1. **Intent gap.** Vague or short prompts ("nasıl çalışıyor?", "ne yapmıştık?") produce weak or zero BM25 hits — the user's intent is clear but the keyword overlap with corpus docs is low.
2. **Language gap.** Turkish prompts query against English-titled knowledge files. BM25 stopword filtering handles Turkish particles but cannot resolve "hafıza yönetimi" → `memory-recall-bm25.md`.
3. **Keyword noise.** Long prompts with incidental words (e.g., code snippets) pollute the BM25 query with irrelevant terms, surfacing false-positive hits.

The fix: replace keyword extraction with a single `claude --model haiku` call that sees the full prompt and the corpus index, and returns only the 0–3 directly relevant doc keys.

## Architecture

**Key file:** `src/lib/recall-query-extractor.ts`

### Flow (UserPromptSubmit hook, default mode)

```
user prompt (stdin)
  └─→ [haikuRecall(prompt, root)]
        ├─→ buildCorpus(root)           // same corpus as BM25 recall
        ├─→ buildCorpusIndex(corpus)    // slug + description + tags, one line per doc
        │     └─→ cap at 8,000 chars with [...]truncated note
        ├─→ execFileSync('claude', [    // single stateless invocation
        │     '--model', 'haiku',
        │     '-p',
        │     '--setting-sources', '',  // no project config leakage
        │     '--tools', '',            // no tool calls
        │     '--no-session-persistence',
        │     '--system-prompt', systemPrompt,  // contains corpus index
        │     rawPrompt,
        │   ], { timeout: 15_000, encoding: 'utf-8' })
        ├─→ stripCodeBlock(output)      // handles ```json and ```JSON (case-insensitive)
        ├─→ JSON.parse → { docs: ["type/slug", ...], skip: bool }
        └─→ map doc keys → CorpusDoc[]  // resolved against live corpus, unknown keys dropped
              ├─→ RecallHit[]           // Haiku hits returned to hook
              ├─→ 'skip'               // greeting/ack, no injection
              └─→ null                 // error → fallback to raw BM25
```

### Mode matrix (`DREAMCONTEXT_RECALL_MODE`)

| Value | Behaviour |
|---|---|
| `haiku` (default) | Single Haiku call; BM25 fallback when `claude` CLI unavailable or errors |
| `raw` | BM25 only, no external process |
| `off` | No recall injection |

### Haiku system prompt structure

```
You are a memory recall filter for an AI coding agent. Given a user prompt and a corpus index of project documents, select 0-3 documents that are DIRECTLY relevant to what the user needs.

Rules:
- Return 0 docs if nothing is relevant — zero noise is better than wrong context
- The user may write in Turkish, English, or mixed — understand intent in any language
- The corpus is in English — match concepts across languages
- skip=true only for pure greetings/acknowledgments ("ok", "evet", "tamam", "devam")
- Prefer specific docs over generic ones

Corpus:
[slug + description + tags, one line per doc, capped at 8K chars]

Return ONLY valid JSON: {"docs":["type/slug","type/slug"],"skip":false}
```

## Security Hardening (from Multi-Review Findings)

The Haiku call was multi-reviewed before shipping. Four findings were addressed:

| Finding | Fix |
|---|---|
| `stripCodeBlock` case-sensitive (only matched ` ```json ` not ` ```JSON ` ) | Regex changed to `/```(?:\w+)?\s*\n?...```/i` |
| Silent catch block hid errors during debugging | Added `console.error` gated by `DREAMCONTEXT_DEBUG=1` |
| Unbounded corpus index string passed to `--system-prompt` | Capped at 8,000 chars with `[...truncated]` suffix |
| No test for empty-corpus case (executor should not be called) | Added unit test confirming `null` return + executor not invoked |

**`execFileSync` vs `exec`:** The call uses `execFileSync` with positional args — no shell interpolation, no injection risk. The prompt is passed as a positional argument, not via string interpolation.

**Stateless invocation flags:**
- `--setting-sources ""` — strips Claude Code project config injection; Haiku sees only the system prompt we provide.
- `--tools ""` — disables all tool access; Haiku cannot read files or run code.
- `--no-session-persistence` — no conversation history; each call is independent.
- `--exclude-dynamic-system-prompt-sections` — prevents dynamic content from the user's session leaking into the sub-process.

## Relationship to BM25

Haiku mode does NOT replace BM25. The existing `src/lib/recall.ts` library is unchanged. Haiku is a **query strategy** that sits above BM25:

- `dreamcontext memory recall <query>` (CLI command) still uses raw BM25 directly.
- The UserPromptSubmit hook uses Haiku first, BM25 as fallback.
- The `--types`, `--top`, `--json` CLI flags all operate on BM25 results.
- The BM25 corpus (knowledge + features + tasks + memory + changelog) is the same corpus the Haiku call indexes against.

Haiku resolves a doc key (`type/slug`) → the hook looks up the full `CorpusDoc` from the in-memory corpus → emits the same `— Memory recall —` block format. Score is not relevant for Haiku hits (Haiku already filtered by relevance); the score threshold (`≥2.0`) only applies when falling back to BM25.

## What was deleted

`src/lib/recall-multi-query.ts` and `tests/unit/recall-multi-query.test.ts` were deleted. That file explored a multi-query BM25 variant (extracting multiple keyword sub-queries from the prompt). It was superseded by the Haiku approach, which is strictly better at intent extraction without the keyword fragmentation problem.

## Test Coverage

`tests/unit/recall-query-extractor.test.ts` covers:
- Normal case: Haiku returns docs, mapped to CorpusDoc[]
- `skip=true`: returns `'skip'`
- Invalid JSON: returns `null`
- Unknown doc keys in response: silently dropped, known keys returned
- Caps at 3 docs even if Haiku returns more
- Raw JSON without code block wrapper
- Empty corpus: executor not called, returns `null`
- Corpus index format: `buildCorpusIndex` unit test

## Sources

- Session `fcaa4dbc-0f95-4314-bae8-f61a53a7bad4` (2026-05-26) — Haiku recall architecture, implementation, multi-review, and final fixes.
- Multi-review security findings: see transcript distillation for session above.
- Feature PRD: `_dream_context/core/features/memory-recall-bm25.md`.
- Related decision: `knowledge/decision-mem0-vs-bm25-recall.md`.

## Last Verified

2026-05-26.
