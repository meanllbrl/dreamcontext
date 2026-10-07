# Gold-set repairs, 2026-10-07

Part of `recall-maintenance-haiku-out-hybrid-default-repaired-gold-sets-ranking-and-latency` (task T1).

Why: since the sets were authored, archived tasks left the corpus, so gold targets pointed at docs that no longer exist. Such a query is unwinnable for every engine, which understates every mode's recall equally and makes cross-run comparisons meaningless.

How: every target of every `eval/gold*.jsonl` was resolved against the **frozen** dc corpus (`~/.dreamcontext/eval-frozen/dc-20261007/_dream_context`, 1449 docs, built with `buildCorpus`), not the live brain. Query text was never edited. A stale `expected` was repointed to the live doc that now carries the answer, verified by reading it; a stale `alt` (an extra acceptable target) was dropped, which cannot change any measured result because a missing doc can never match.

`eval/gold.jsonl` (train): no stale targets, unchanged.

## `eval/gold-heldout.jsonl` — stale `expected` repointed (3)

| id | was | now | evidence in the frozen corpus |
|---|---|---|---|
| h009 | `task/sleep-epoch-race-fix` | `knowledge/technical-decisions-archive` | line 63: "Sleep epoch-based clearing: `sleep start` records timestamp; `sleep done` only clears records from before epoch" — the fix for parallel sessions' records being cleared during consolidation. `feature/sleep-consolidation` (already an `alt`) stays as an alternative. |
| h019 | `task/disable-claude-native-memory` | `feature/control-panel` | user stories + technical details: Settings → Memory toggle and `config native-memory enable\|disable`; `applyClaudeAutoMemory` writes `autoMemoryEnabled: false`. It was already the `alt`, so `alt` is now empty. |
| h021 | `task/mermaid-render-fix` | `feature/web-dashboard` | the mermaid work: edge-line corruption fix (line 156) and `sanitizeMermaid` (line 528). |

## `eval/gold-heldout.jsonl` — stale `alt` dropped (20 targets, 19 queries)

Each was a task slug that has since been archived. The `expected` target of each query is unchanged and still live (h021's is the repointed one above).

| id | dropped alt |
|---|---|
| h001 | `task/server-security-hardening` |
| h003 | `task/apache-relicense-push-and-publish` |
| h004 | `task/sleep-fanout-3specialist-collapse` |
| h006 | `task/v06-vault-management` |
| h007 | `task/rice-prioritization` |
| h008 | `task/v05-positioning-easy-install-update-nudge` |
| h011 | `task/v04-ws1-install-update-overhaul` |
| h013 | `task/haiku-recall-extraction` |
| h014 | `task/reflection-engine` |
| h016 | `task/council-skill` |
| h017 | `task/ecc-inspired-roadmap` |
| h021 | `task/v06-markdownpreview-sanitize` |
| h022 | `task/optional-skill-packs` |
| h023 | `task/v06-control-plane-backend` |
| h025 | `task/multi-review-skill` |
| h027 | `task/v04-ws1-install-update-overhaul`, `task/v06-install-update-hardening` |
| h028 | `task/server-security-hardening` |
| h029 | `task/web-dashboard` |
| h030 | `task/goal-skill-and-related-skills-recall` |

An `alt` that became empty is kept as `"alt":[]`, the shape the file already used. In total 21 of the file's 30 lines changed: the 19 queries above, plus h009 and h019.

## Not repaired, parked

`eval/gold.smoke.jsonl` smoke-3 → `task/haiku-recall-extraction` (archived). The file is a 3-query smoke fixture, not a measured set; it is parked in `eval/gold-quarantine.json` rather than edited.

## Going forward

`tests/unit/recall-eval.test.ts` now resolves every `expected` and `alt` of every gold file. With `RECALL_EVAL_ROOT` set (a frozen brain) a missing target fails the test; on a live brain it only warns, so sleep-driven edits cannot redden `npm test` unrelatedly.
