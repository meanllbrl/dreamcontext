# Super orchestration eval: frozen set

Frozen 2026-10-21, before any measurement. `tests/unit/super-orchestration-eval.test.ts` fails when a
file below changes: a change is a new set, measured again in both arms, never a tweak.

- scenarios.jsonl: sha256=8dfcf84d87661767dd0161fd049ac8dfa55ffeb270d7c87b7e86a899bd97a605 count=10
- gold.json: sha256=6356a15d056482973fe511ada63a08886c25413953a3a77c4fdce5966cb57d52 count=10

## Splits

- TRAIN (the guide may be tuned on these, at most 2 rounds): S01-S08.
- HELD OUT (never read while tuning; a lower score is reported to the owner, never tuned): S09, S10.

## Authoring record

- The gold is implementation-blind: written from the scenario texts and the fixture's files, before the
  guide's tuning, by the plan's rules (r5 D10).
- 2026-10-21: match patterns made disjoint before freezing (S01 I1/I2, S03 I1, S04 I1, S08 I1-I3, S09 I4):
  each item's own text now matches its own patterns and no other item's (pinned by the test).
