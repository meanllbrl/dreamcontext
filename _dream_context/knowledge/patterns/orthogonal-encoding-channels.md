---
id: know_QPPK82eP
name: orthogonal-encoding-channels
description: >-
  When one small glyph must carry two independent states, each state needs its
  OWN visual channel: colour for one, shape and motion for the other. A second
  colour channel makes the two fight over the same 26px. And the shape channel
  must be an ACTION ON A LOOP, not a static costume — motion is the only thing
  that survives the scale-down.
tags:
  - 'kind:pattern'
  - 'kind:design'
  - 'topic:branding'
  - 'layer:frontend'
pinned: false
date: '2026-08-29'
---

## Why This Exists

The dock chip and the mode picker drew ONE face for every chat, so nothing on screen said which brief a session was running under. The obvious fix — give each mode its own colour — was wrong, and the reason it was wrong generalizes.

**Sleepy's mood already owned every hue.** Green scanning = working, magenta wide-eyed = asking, violet = ready. Adding a second colour channel for chat mode would make the two states fight over the same 26px chip, and the loser would be whichever one you needed at that moment. A Develop agent blocked on a question must still read as **asking** — in a hard hat.

## The Pattern

### 1. One state per channel — the channels must be orthogonal

When a single small element carries N independent states, give each state a channel the others do not touch:

| channel | owned by |
|---|---|
| **colour / hue** | status, mood — the thing you must never miss |
| **shape + motion** | mode, kind — the thing that answers "which of these am I looking at" |

The second channel **layers on top of** the first rather than replacing it, so both states are legible simultaneously. Test the pairing explicitly: pick the most awkward combination (Develop + asking) and confirm both still read.

### 2. The shape channel must be an ACTION ON A LOOP, not a costume

Three costume drafts were built and rejected before this landed:

| draft | why it lost |
|---|---|
| **spectacles / visor** | reads as wardrobe, not character — an accessory says nothing about what the thing is *doing* |
| **brows** (expression only, no object) | too subtle; collides with the mood channel, which already speaks through the eyes |
| **sheet + hard hat** (static props) | still wardrobe; and at 26px the prop is a smudge |

What shipped instead is a loop of *work*: Plan holds a sheet and writes on it (pencil laying down a squiggle, a full stop, a fresh page); Develop works a forge (torch welds, pulls clear, hammer strikes, sparks, anvil dips, a blacksmith's tap).

**The reason is scale, and it is the load-bearing part.** At 26px every static detail is gone. Motion is not — the *rhythm* of writing versus the *rhythm* of striking still identifies the mode when nothing else survives. A costume is only legible at the size you designed it at; a loop is legible at every size.

### 3. Make the mapping function TOTAL, so an unknown state degrades to plain

```ts
/** Total over ChatMode, so a new mode is a silent bare face rather than a crash. */
export function gearForMode(mode: ChatMode | undefined): SleepyGear | null {
  return mode === 'plan' || mode === 'develop' ? mode : null
}
```

The null arm is what protects every surface that mounts the glyph with no second state behind it — here, the notch perch, the sleep-debt tracker and the zero-session FAB, all of which must render **byte for byte** as they did before the channel existed. Adding a channel must be a no-op wherever that channel has nothing to say.

### 4. Read the state from the durable record, not the live one

Mode is read off the **roster** (`SessionMeta.mode`), not off the live session. A mode switch and a relaunch both keep the glyph honest — a dormant Develop tab is still at the anvil when it reopens. A live-session read would go blank exactly when the record is most useful.

### 5. Draw in theme ink; spend real colour only on things that are genuinely that colour

Scenes are drawn in theme ink so both light and dark work with no hex baked in. Only genuinely hot things — flame, weld, sparks — take `--color-warning`. This keeps the colour channel (rule 1) uncontaminated: nothing in the *mode* drawing can be mistaken for a *status* hue.

### 6. Judge the art at the smallest size, in both themes, from rendered frames

The decision between the four candidates was made against rendered frame strips at **100px and 26px, in both themes** — not against the source drawing. The 26px strip is what killed the costumes. Build the throwaway preview harness; delete it after (it was `dashboard/src/mascot-preview.tsx`, removed in the same session).

## Where This Applies Next

Any surface where one small element must carry two independent states at once: a tab that shows both sync state and content kind, a status dot that must encode both severity and source, a cursor that shows both tool and permission level. Ask first *which channel is already spoken for*, and give the newcomer a different one — never a second hue.

## Sources

- `d1267e0` — "Sleepy ACTS OUT the chat mode — Plan writes, Develop forges" (8 files, +478/−5, 2026-08-28)
- `dashboard/src/components/sleepy/SleepyMascot.tsx` — the file header carries the same rationale, so the three rejected drafts are not re-derived in code
- `tests/unit/mascot-mode-gear.test.ts` — 9 tests: bare-face default, per-mode animation clocks, the reduced-motion stand-down, the no-hardcoded-colour rule, the picker wiring
- Feature record: `knowledge/features/in-app-agent-terminal.md` (Constraints & Decisions, 2026-08-28)
