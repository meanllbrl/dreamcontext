---
id: "{{ID}}"
topic: "{{TOPIC}}"
status: "created"
rounds_planned: {{ROUNDS}}
current_round: 0
interrupt_between_rounds: {{INTERRUPT}}
personas: []
promoted_to_knowledge: null
created_at: "{{DATE}}"
updated_at: "{{DATE}}"
---

## Question

{{TOPIC}}

## Constraints & Known Facts

(Main agent captures what the user said up front. User interruptions between rounds are appended here. Interlude injections land here as `- **[Interlude RN]** fact` bullets via `council inject`.)

## Session registry

(Orchestrator-maintained. One line per persona CLI session: `- <slug> · <model> · session <session_id>`. The orchestrator is the single writer of this section.)
