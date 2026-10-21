# eval/super-show — results

Does the real Super Agent SHOW a set the owner asks to see ("görevlerimi göster", "show my tasks",
"insight'ları göster", and the same on a full stage) as cards in one group, with at most two
sentences and no list? Scored by `scorer.ts` (pinned by `tests/unit/super-show-scorer.test.ts`,
whose negative fixture is the owner's own case of 2026-10-20). Threshold: 4 of 5 runs PASS per
prompt (jarvis plan r9, AC11b).

Paid and optional: `npm run build && npm run eval:super-show`. Each run appends a dated table below.

## 2026-10-21 — model: claude-opus-5-5[1m], runs per prompt: 5, threshold 4/5, total cost $2.13

| prompt | text | passed | verdict | cost |
|---|---|---|---|---|
| tasks-tr | `görevlerimi göster` | 5/5 | PASS | $2.13 |

## 2026-10-21 — model: claude-opus-5-5[1m], runs per prompt: 5, threshold 4/5, total cost $2.14

| prompt | text | passed | verdict | cost |
|---|---|---|---|---|
| open-work-tr | `açık işleri göster` | 5/5 | PASS | $2.14 |

## 2026-10-21 — model: claude-opus-5-5[1m], runs per prompt: 5, threshold 4/5, total cost $2.13

| prompt | text | passed | verdict | cost |
|---|---|---|---|---|
| tasks-en | `show my tasks` | 5/5 | PASS | $2.13 |

## 2026-10-21 — model: claude-opus-5-5[1m], runs per prompt: 5, threshold 4/5, total cost $2.22

| prompt | text | passed | verdict | cost |
|---|---|---|---|---|
| insights-tr | `insight'ları göster` | 3/5 | FAIL | $2.22 |

## 2026-10-21 — model: claude-opus-5-5[1m], runs per prompt: 5, threshold 4/5, total cost $2.33

| prompt | text | passed | verdict | cost |
|---|---|---|---|---|
| tasks-full-stage | `görevlerimi göster` | 3/5 | FAIL | $2.33 |

### 2026-10-21 summary (claude-opus-5-5[1m], 5 runs per prompt, threshold 4/5)

Total cost $10.95 across 25 runs. PASS: `görevlerimi göster` 5/5, `açık işleri göster` 5/5, `show my tasks` 5/5. FAIL: `insight'ları göster` 3/5 (two replies named all three insights in the sentence), full stage `görevlerimi göster` 3/5 (two replies used a third sentence to explain the stacking). Every run opened every gold item, opened no finished task, and closed no card. Reader caveat: the answer read is the FIRST assistant text after the prompt; in two PASS runs that was an interim line ("Stage is full; stacking…", "Three insights, opening them as a group.") rather than the turn's last reply. AC11b is not met.

## 2026-10-21 — model: claude-sonnet-5-5 / medium, runs per prompt: 5, threshold 4/5, total cost $1.63

| prompt | text | passed | verdict | cost |
|---|---|---|---|---|
| insights-tr | `insight'ları göster` | 4/5 | PASS | $1.63 |

## 2026-10-21 — model: claude-sonnet-5-5 / medium, runs per prompt: 5, threshold 4/5, total cost $1.73

| prompt | text | passed | verdict | cost |
|---|---|---|---|---|
| tasks-full-stage | `görevlerimi göster` | 3/5 | FAIL | $1.73 |

### 2026-10-21 re-run summary (claude-sonnet-5-5 / medium, the two failing prompts, 5 runs each)

Changes before it: the reader takes the LAST assistant text of the prompt's turn (up to the next owner message or event chip), and the briefing's "Show, don't tell" says never to name the items, not even three, and that a full stage is still two sentences without telling what was moved. Total cost $3.36. `insight'ları göster` 4/5 PASS. Full stage `görevlerimi göster` 3/5 FAIL: one real miss (a third sentence, "Hiçbir kartı kapatmadım", after naming the stacked cards), and two runs (insights #2, full stage #5) where the reader got the HAND-OVER turn's reply ("Chat 1 is idle … I updated its card reminder") instead of the prompt's, i.e. the hand-over turn had not finished when the prompt was sent; those two are harness misses, not model answers. Most full-stage replies still mention what went to Others, inside two sentences. AC11b is still not met; stopped here per the owner.
