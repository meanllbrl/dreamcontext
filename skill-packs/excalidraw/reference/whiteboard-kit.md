# Drawing on a dreamcontext whiteboard

This is the excalidraw kit as `dreamcontext whiteboard draw <board> --spec <spec.json>` uses it:
the same builders, type and build audit as the `excalidraw` skill, straight from a JSON spec, no
script and no `node`. `dreamcontext whiteboard kit` prints this page.

**Explain or show something: draw it. A number: a live widget. A note: a caption.**

- An explanation is a drawing: a flow of steps, groups in panels, a comparison, a timeline,
  with short labels (1 to 4 words a box). Never a stack of markdown notes.
- A number (MRR, signups, a trend, a split) is a live widget: `whiteboard add <board> insight
  --ref <insight>`, `lab-card`, `task`, `todo`. Never a drawn `kpi`, chart or table of today's values.
- A `note` widget is a caption, at most 5 lines and 45 words; `add note` warns past that.
- A picture is part of the drawing: `{ "type": "image", "path": "docs/screens/a.png", "width": 300 }`
  in the spec, with its caption under it as a `chip` and two or three `bullets`, never a note
  beside it. `draw` stores the picture with the board (PNG, JPEG, GIF or WebP).

## The loop

```bash
dreamcontext whiteboard show <board>                                    # what is there, by tag
# write spec.json (below)
dreamcontext whiteboard draw <board> --spec spec.json --tag <tag>       # or --below <tag> / --right-of <tag> / --at x,y
dreamcontext whiteboard render <board> --tag <tag> --out /tmp/look.png  # then READ the PNG
# a board agent: --out $DREAMCONTEXT_AGENT_SCRATCH/look.png (it may write nowhere else)
```

Keep the spec where the next session finds it, so the drawing can be redrawn when what it shows
changes: a session in `_dream_context/workspace/`, a board agent in its own output folder
`_dream_context/automations/output/<self>/` (its `$DREAMCONTEXT_AGENT_SCRATCH` is removed after
every turn; the PNG goes there). A board agent runs each command as ONE `dreamcontext` call (no
`;`, `&&`, pipes or `cat`).

`draw` prints the kit's audit when it finds something: overlapping boxes, buried labels, over-long
lines, walls of text. Fix the spec and redraw in place: `whiteboard remove <board> --tag <tag>
--json` prints the old bbox, then `draw … --at <bbox.x>,<bbox.y> --tag <tag>`. The same two
commands bring a drawing up to date when what it shows has changed: keep its spec, edit, redraw.

## A spec

`{ "elements": [ … ] }`. Coordinates are the drawing's own, from 0,0: `draw` places the whole
group. A picture's `path` is relative to the folder you run `draw` from (the project). Lay blocks
out with `stack` (top to bottom) and `row` (left to right); they measure each block, so nothing
overlaps. Nest them freely. Colours carry meaning: `blue` system or flow,
`purple` core service, `yellow` processing or attention, `green` good or go, `red` risk or
pain, `mint` result, `gray` muted.

```json
{ "elements": [ { "type": "stack", "gap": 32, "items": [
  { "type": "sectionTitle", "text": "Sync engine: the path of one edit", "fontSize": 32 },
  { "type": "takeaway", "label": "IN A NUTSHELL", "text": "Every edit is saved ==on the device first==, then ordered by one server clock." },
  { "type": "flow", "steps": [
    { "text": "Editor", "color": "gray" },
    { "text": "Op log", "label": "append" },
    { "text": "Push batch", "label": "every 2 s", "note": "offline: retried, 1 s to 60 s" },
    { "text": "Server clock", "label": "POST", "color": "purple" },
    { "text": "Other devices", "label": "WebSocket", "color": "mint" }
  ] },
  { "type": "row", "gap": 24, "items": [
    { "type": "panel", "title": "Conflicts", "color": "yellow", "items": [
      { "type": "bullets", "width": 320, "items": ["Body text: merged (CRDT)", "A field: last writer wins", "Delete vs edit: delete wins"] }
    ] },
    { "type": "panel", "title": "Staying fast", "color": "green", "items": [
      { "type": "bullets", "width": 320, "items": ["Snapshot every ==500== ops", "Offline 30+ days: fresh snapshot"] }
    ] }
  ] }
] } ] }
```

## Pick the shape of the idea

| The idea is | Type | Fields |
|---|---|---|
| a process, a pipeline, a request's path | `flow` | `steps` (strings or `{text, color, note, label}`; `label` names the arrow into the step), `direction` `right`/`down`, `w`, `h` |
| things that belong together | `panel` | `title`, `color`, `items` (child specs), `direction` `down`/`right` |
| one centre and its parts | `hub` | `label`, `spokes` (strings or `{label, color}`), `radius` |
| a list of options, risks or benefits | `column` | `items` (strings or `{text, color}`), `color`, `w`, `h` |
| A versus B, before versus after | a `row` of two `panel`s, `table`, `barCompare` | table: `headers`, `rows`; barCompare: `groups`, `seriesLabels` |
| dates and milestones | `timeline` | `events` (`{label, at: "YYYY-MM-DD"}`), `w` |
| a plan over time | `gantt` | `tasks` (`{label, start, end, done}`), `today` |
| stages that narrow | `funnel` | `stages` (`{label, note, color}`) |
| where things sit on two axes | `quadrant` | `items` (`{label, x, y}` in 0..1), `xAxis`, `yAxis` |
| the one-line point | `takeaway` | `text`, `label` |
| a titled finding | `callout` | `title`, `lead`, `items`, `color` |
| a heading | `sectionTitle` | `text`, `fontSize` |
| a box with a label | `card`, `node`, `chip` | `text`, `color`, `w`, `h` |
| a short list | `bullets` | `items`, `width` |
| screenshots, each with what it is for | a `row` of `stack`s, each `image`, `chip`, `bullets` | image: `path`, `width` (the height follows) |
| a screen sketched, not shot | `windowFrame`, `appBar`, `listRow`, `tabBar`, `button`, `input`, `textRows` | see the `excalidraw` skill |
| an arrow you place yourself | `connector` | `from` and `to` as `[x, y]`, `label`, `dashed`, `elbow` `hv`/`vh` |

Every type: `dreamcontext whiteboard kit --json` lists them. In text, `**bold**` draws a rule
under the phrase, `==mark==` a highlighter band, `` `code` `` a grey chip: mark one or two
phrases a block, the number the point rests on first.

## Writing for a board

- Conclusion first: a `takeaway` or a callout `lead`, then the evidence.
- One idea a box. A label is 1 to 4 words; a block is at most 5 lines and 45 words.
- Bullets over prose for anything you can count.
- Look at the render before you say it is done; fix what reads badly and redraw in place.
