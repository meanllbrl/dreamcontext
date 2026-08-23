# Design prompt — the pinned shelf (Chat)

Working artifact. Paste the block below into the design tool. Spec of record is
`_dream_context/knowledge/diagrams/product/chat-pinned-surface/chat-pinned-surface.excalidraw.md`.

---

Design a **pinned shelf** for the Chat view of dreamcontext — a macOS desktop app (Tauri) where a developer drives an AI coding agent. Dark theme is primary; light must work too.

## What already exists — do NOT redesign it

The message composer at the bottom of the pane, just redesigned and settled:

- A rounded container, 12px radius, 1px border, card surface, sitting on the pane's bottom edge with a small drag handle centred on its top edge (the pane is resizable there).
- Placeholder `Message Claude…`.
- One control row along the bottom: at the left `Basic` (bold) + `auto` (monospace, with a caret) and a `+` attach button; at the right a small circular ring that reads as the context meter, then `Opus` (bold) + `Xhigh` (monospace, caret), then a circular send button with an up arrow.
- The row is deliberately sparse — most of its width is empty. That emptiness was fought for. Do not fill it.

Keep every one of these controls exactly as they are. You are adding a surface **above** the composer, not changing it.

## What to design

A **shelf** docked to the composer's top edge. It shares the composer's width and corner language so the two read as one continuous object, not as a floating card that happens to sit nearby. It holds **pins**: pieces of information the user needs for the whole session, which must never scroll away.

Pins carry a **weight**:

- **tag** — one short fact. Renders as a chip and shares a line with its neighbours.
- **row** — a rich pin. Takes a full-width line of its own.
- **long** — prose that will not fit one line. Rests as a one-line *lede* with an open affordance, and opens on click.

## The four states to draw

**1 · Resting — a tag line.** The default. Session facts pack onto ONE chip line sitting directly on the composer:

`⎇ feat/pin-surface` · `worktree` · `:5173`

(the branch; a marker shown only when the checkout is a linked git worktree; the localhost port the running work can be tested on — this one is clickable). Three chips, distinguishable at a glance, no heading, no container chrome around them. This state must feel almost weightless — it is the app at rest.

**2 · Active — a progress row opens ABOVE the tag line.** When a long agent run is going, one full-width row appears above the tags:

`64% · 7/11 · now: loopback url exception`

A percentage, a criteria count, and the item currently in flight. It needs a sense of progress — a bar, a track, something measurable — without becoming a loud banner. **The tag line and the composer must not move when this row appears or disappears.** The shelf grows upward into the conversation; nothing below it shifts.

**3 · Long pin — resting as a lede.** A pin whose content is a paragraph still occupies exactly ONE row: a single clamped line plus an affordance to open it.

`▸ Session summary · 16 tasks deleted, 0.24.2 folded into 0.25.0, placement A chosen  ⌄`

Design the clamp honestly — the user must be able to tell there is more, and (separately) tell when the surface itself did the clamping rather than the author writing a real lede.

**4 · Long pin — opened.** Clicking expands the detail in place, growing the row upward. Two to five lines of prose. Again: the tag line and composer do not move a pixel. Show what the open state's close affordance and its boundary look like.

## Hard rules — these are design constraints, not implementation notes

- **Grows upward, only.** Everything below the shelf is anchored. This is the rule the whole design hangs on.
- **Two rows at rest, hard.** The tag line counts as one. Nothing the agent sends can force a third. A user-initiated expansion may exceed it, capped near 40% of the pane height, scrolling inside itself past that.
- **No scroll reaction.** The shelf never hides, reveals, resizes or animates on a scroll gesture. It is simply always there.
- **Overflow is visible, never silent.** Past the ceiling the oldest row demotes to a tag; past the tag line's width, tags fold into a `+3` chip that opens the rest. Design both.
- **One pin open at a time.** Opening a second collapses the first.
- **Dismissible.** Each pin can be closed by the user; show the affordance and make it non-intrusive.

## Tokens (use these exact values)

```
radius      chip 6 · button 9 · card 12 · large 16 · pill 999
spacing     4px scale — 4 8 12 16 20 24
type        11px chrome/strip · 12px caption · 14px UI label
accent      dark #9d8cff   light #7b68ee
dark        bg #14171f · surface #1c1f2a · chip #2a2f3d
            text #f5f6fa · secondary #c8ccd9 · tertiary #9aa0b3 · border #2f3445
light       bg #ffffff · chip #e9ebf0
            text #292d34 · secondary #646464 · border #e8e8e8
```

Monospace for anything machine-authored — branch names, ports, counts. The accent is for interactive things; do not spend it on decoration.

## Deliverables

Each of the four states, dark and light. Plus two details: the `+3` overflow chip opened, and the clamped-lede marker. Draw them at a ~1440×900 window and again at a narrow pane (~470px wide) where button labels drop to icons — the shelf has to survive that width without becoming unreadable.

## Anti-goals

- Do not move this into a right-hand rail or a strip under the tab bar. Both were considered and rejected — a rail narrows the app's narrowest surface, a top strip is the region the eye learns to skip.
- Do not turn progress into a popover, tooltip or anything the user has to click open. Progress you must open is not pinned.
- Do not add a hide-on-scroll or auto-collapse animation. Scrolling up is usually the user hunting for the very fact the pin holds.
- Do not add a title bar, a "Pinned" heading, or a container label. The shelf's meaning must come from its position, not from a word.
- Do not restyle the composer's existing controls, and do not put pin content inside the composer's control row.
