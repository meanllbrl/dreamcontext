# eval/super-show — results

Does the real Super Agent SHOW a set the owner asks to see ("görevlerimi göster", "show my tasks",
"insight'ları göster", and the same on a full stage) as cards in one group, with at most two
sentences and no list? Scored by `scorer.ts` (pinned by `tests/unit/super-show-scorer.test.ts`,
whose negative fixture is the owner's own case of 2026-10-20). Threshold: 4 of 5 runs PASS per
prompt (jarvis plan r9, AC11b).

Paid and optional: `npm run build && npm run eval:super-show`. Each run appends a dated table below.
