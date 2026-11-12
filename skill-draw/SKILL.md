---
name: draw
description: >-
  Drawing: Excalidraw files and dreamcontext whiteboards (`dreamcontext whiteboard draw|add|kit`),
  and the Chat view's `dream-html` diagrams. Load BEFORE you draw a diagram, flowchart, chart,
  wireframe, mockup or board. Triggers: draw, sketch, diagram, wireframe, excalidraw, whiteboard,
  çiz, çizim, diyagram, şema, akış şeması, grafik çiz, tahtaya çiz.
---

# draw

One skill for every drawing that is kept: an Excalidraw file and a dreamcontext whiteboard. One
engine draws both (`scripts/build_excalidraw.js`, ~45 builders: you pass data, it emits a valid
board and audits it). This page routes you; the references hold the depth.

## 1. Which part

| You are drawing | Do this |
|---|---|
| **On a whiteboard**: a board under `_dream_context/whiteboards/`, or any `dreamcontext whiteboard` command | Run `dreamcontext whiteboard kit` (the types, their fields, what goes where, a worked spec). Then [references/whiteboards.md](references/whiteboards.md) for widgets, placement, recipes and agent cards. |
| **A standalone file**: an `.excalidraw.md`, an Obsidian board, a knowledge diagram, a wireframe or mockup file | [references/excalidraw.md](references/excalidraw.md) (builders, spec schema, layout, charts, devices, knowledge conventions); [references/format.md](references/format.md) for the file anatomy. |
| **In the dreamcontext Chat view, a drawing that is only part of your answer** ("sync akışını çiz") | Draw it in the reply as a `dream-html` `dc-graph`: [references/chat-html.md](references/chat-html.md) (when a block earns its place, the graph grammar, the `dc-` kit). Nothing to build or render. It becomes a kept drawing (the rows above) when it must be kept: a whiteboard, an Excalidraw file, a knowledge diagram, or "kaydet / save / keep". |

On a whiteboard the mix is the point: an explanation is a drawing from the kit; **a number (MRR,
revenue, signups, a trend, a split) is a live `insight` widget** (`dreamcontext whiteboard add
<board> insight --ref <slug>`), never a `kpi`/chart drawn from today's values; a note is a caption.

## 2. Five design rules (the references explain each)

1. Use a builder; never hand-roll rectangles and text when one fits.
2. Visual first: a flow, a funnel, a device, a chart before a sentence.
3. Text keeps a readable measure: every text block has a width.
4. Write for a glance: lead with the conclusion, blocks under ~4 lines.
5. No overlap: flow the layout with `stack` / `row` / `panel`, never hand-place.

## 3. Never

- Never hand-write Excalidraw scene JSON: write a spec and run the builder.
- Never write a whiteboard file directly: `dreamcontext whiteboard draw <board> --spec spec.json`
  (or `--file` a built `.excalidraw.md`), `whiteboard add` for widgets.

## 4. Verify

Look at what you drew with `dreamcontext whiteboard render <board> --out look.png` (a board) or
`dreamcontext whiteboard render --file x.excalidraw.md --out look.png` (a file), then READ the PNG.
Never open a browser to check a drawing. Fix the spec when the build audit reports overlaps,
buried labels, long lines or walls of text, and redraw.

## 5. Where the builder is

`scripts/build_excalidraw.js` in this skill's folder: in a Claude project
`.claude/skills/draw/scripts/build_excalidraw.js`.

```bash
node .claude/skills/draw/scripts/build_excalidraw.js spec.json --out boards/x.excalidraw.md
```

From a pipeline: `require('<project>/.claude/skills/draw/scripts/build_excalidraw.js')` and the
libs in `scripts/lib/` (`style.js`, `charts.js`, `wireframe.js`, `typography.js`). A whiteboard
needs neither: `dreamcontext whiteboard draw --spec` runs the same builder for you.
