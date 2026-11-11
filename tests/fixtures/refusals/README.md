Stream fixtures for the K2 refusal capture (tests/unit/chat-registry-refusals.test.ts).

- `auto.jsonl`, `dontask.jsonl`, `rules.jsonl`, `auto-hook.jsonl`: real Claude Code 2.1.322 streams
  from the premise step (scratch folders), trimmed to the frames the registry reads (hook start and
  response frames, thinking blocks and usage dropped).
- `classifier-block.synthetic.jsonl`: SYNTHETIC. A real classifier block could not be reproduced on
  demand; its shape (`non_execution_kind: automode-blocked`, `reason_type: classifier`,
  `classifier_category`) is inferred and pinned here.
