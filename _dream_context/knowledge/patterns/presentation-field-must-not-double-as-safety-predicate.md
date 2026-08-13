---
id: knowledge_presentation_field_safety
name: presentation-field-must-not-double-as-safety-predicate
description: >-
  A field computed for display (badge count, tab glyph kind) must never be
  reused as a safety or control predicate (eviction gate, mount filter) —
  display rules drift as UX evolves (e.g., "don't count shells in the badge");
  safety gates must be independent and named for their actual gate.
type: knowledge
tags:
  - kind:pattern
  - architecture
  - domain:frontend
pinned: false
created: '2026-08-11'
---

# Presentation Field Must Not Double as Safety Predicate

## Why this exists

A field computed for display purposes (badge counts, tab glyph kinds, status indicators) evolves with UX requirements — "don't show shells in the chat badge", "mark automation tabs differently". When that same field is reused as a safety or control predicate (an eviction gate, a mount filter, a permission check), **display drift breaks safety logic**. The UX change is low-stakes ("the badge looks weird"), so it merges easily. The safety impact is invisible until the gate fires under the new conditions and kills the wrong thing.

## The pattern

**Split presentation from control at write time.** When a field serves both display and safety:

1. **Name the split.** The safety field is named for its ACTUAL gate (e.g., `alive` for "has any live process", not `live` for "chat session count"). The display field keeps its UX-facing name.
2. **Compute independently.** The safety field is written with its own rules that never reference the display field. Display rules may change; safety rules must not.
3. **Regression-lock the split.** A test named after the bug exercises the case where display would say "idle" but safety must say "alive" (e.g., a project with only a running shell, no chat sessions).

## When to use it

- A field that gates resource cleanup (eviction, session disposal, PTY kill) — display is "what shows in the UI", control is "may I tear this down?"
- A field that gates mounting (which tabs render panes, which instances stay live) — display is "what glyph/color", control is "should this exist?"
- A field that gates permissions or access — display is "what the user sees", control is "is this allowed?"

## When NOT to split

- A field that is ONLY used for display, never read by control logic — no split needed.
- A field that is ONLY used for control, never shown to users — it's already pure.

## Two occurrences (qualifying this as a pattern)

### Occurrence 1: `ProjectRollup.live` was the eviction gate (2026-08-09, CRITICAL M9)

Task `one-window-holds-every-open-project-as-a-live-chip-strip`. `ProjectRollup.live` was the chat badge count (excludes shells because shells don't chat). The eviction test read `rollup.live === 0` to mean "this instance is idle, tear it down to a cold chip." A project with only a running dev server (a shell) reported `live:0` and would have been evicted mid-process, killing the PTY.

**Fix:** Added `ProjectRollup.alive` (any live PTY/WebSocket, shells included) as the sole eviction gate. `live` stayed as the chat badge count. Regression test named `'does not evict instance with live shell but no chat sessions'`.

**Why it happened:** The UX requirement ("don't count shells in the badge") changed `live`'s rules. The eviction gate didn't know it was reading a display field.

### Occurrence 2: `chatPanes` filtered on display `kind` (2026-08-10, found by runtime verification)

Task `automations-redesign-the-flow-graph-is-the-manifest-the-run-asks-in-chat-and-the-queue-never-loses-a-fire`. `AgentTab.kind` was computed for the tab glyph (automation tabs show an alarm-clock icon, chat tabs show a message icon). `chatPanes` filtered tabs by `kind !== 'automation'` to decide which tabs mount ChatPane components. Every automation-run tab spawned a healthy ChatSession (WS open, transcript fetchable) that was never mounted — the pane composer read the glyph field as a mount gate.

**Fix:** Split out `transportKind` (the control field: which tabs get a pane) from `kind` (the display field: which icon shows). The pane composer now filters on `transportKind`.

**Why it happened:** `kind` was a UX enum (what icon?), reused as a structural discriminator (does this tab have a chat?). When automation tabs were added, `kind: 'automation'` made them render the right icon but also excluded them from mounting.

## The litmus test

Ask: **"If I change this field's rules for UX reasons, does something unrelated break in a way tests won't catch?"** If yes, split it.

Display rules are low-stakes and change often. Safety rules are high-stakes and must be deliberate. Never let the first control the second.

## Sources

- Task `one-window-holds-every-open-project-as-a-live-chip-strip` (M9 review finding, 2026-08-09)
- Task `automations-redesign...` (runtime verification defect #3, 2026-08-10)
- Pattern discussion in sleep cycle 2026-08-11 (this is the third cycle this signal appeared, now two occurrences = pattern)

## Last verified

2026-08-11
