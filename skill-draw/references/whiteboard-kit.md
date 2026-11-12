# Drawing on a dreamcontext whiteboard

This is the `draw` kit as `dreamcontext whiteboard draw <board> --spec <spec.json>` uses it:
the same builders, type and build audit as the `draw` skill, straight from a JSON spec, no
script and no `node`. `dreamcontext whiteboard kit` prints this page. Full guide: the `draw` skill.

**Explain or show something: draw it. A number: a live widget. A note: a caption.**

- An explanation is a drawing: a flow of steps, groups in panels, a comparison, a timeline,
  with short labels (1 to 4 words a box). Never a stack of markdown notes.
- A number (MRR, signups, a trend, a split) is a live widget: `whiteboard add <board> insight
  --ref <insight>`, `lab-card`, `task`, `todo`. Never a drawn `kpi`, chart or table of today's values.
- A `note` widget is a caption, at most 5 lines and 45 words; `add note` warns past that.
- A picture is part of the drawing: `{ "type": "image", "path": "docs/screens/a.png", "width": 300 }`
  in the spec, with its caption under it as a `chip` and two or three `bullets`, never a note
  beside it. `draw` stores the picture with the board (PNG, JPEG, GIF or WebP).

## What goes where on a whiteboard

| On the board | Use |
|---|---|
| an explanation, a process, a design, a comparison | a kit drawing: `flow`, `panel`, `timeline`, a comparison (`draw --spec`) |
| a number (MRR, signups, a trend, a split) | an `insight` widget (`add <board> insight --ref <slug>`); no insight yet: create it first |
| a card of a Lab board | a `lab-card` widget (`--ref <board>/<card-id>`) |
| a page | a `knowledge` card, or a `wiki` card for a list of pages |
| open work | a `todo` (or `task` widgets) |
| a caption | a `note`, at most 5 lines |
| a screenshot | an `image` in the spec, a `chip` caption under it |
| a helper that lives on the board | an agent card (`add <board> agent --ref <agent>`) |

Group related things in a `panel` (or a frame), place with `--below <tag>` / `--right-of <tag>`,
`render` and look at the PNG, and keep the spec so the drawing can be redrawn in place.

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
| a screen sketched, not shot (a phone, a tablet, a Mac, a window) | `device`, `windowFrame` holding their parts | see Screens below |
| an arrow you place yourself | `connector` | `from` and `to` as `[x, y]`, `label`, `dashed`, `elbow` `hv`/`vh` |

## Primitives

A shape you place yourself, when no type above fits (an apple, a logo, an arrow in a gap). Its
`x`, `y` are inside the spec, from 0,0.

| The shape is | Type | Fields |
|---|---|---|
| a box, a circle, a rhombus | `rectangle`, `ellipse`, `diamond` | `x`, `y`, `width`, `height`, `strokeColor`, `backgroundColor`, `fillStyle` (`solid`), `strokeWidth`, `roundness` (true) |
| a stroke, a polygon, an arrow | `line`, `arrow` | `x`, `y`, `points` (`[[0,0],[120,40],…]`), `strokeColor`, `backgroundColor` (a closed `line` fills), `strokeWidth`, `startArrow`, `endArrow` |
| loose words | `text` | `x`, `y`, `text`, `fontSize`, `color`, `width` (wraps), `align` |

The types above are the ones a board needs (a number is a widget, so the charts are left out). In text, `**bold**` draws a rule
under the phrase, `==mark==` a highlighter band, `` `code` `` a grey chip: mark one or two
phrases a block, the number the point rests on first.

## Screens: a phone, a tablet, a Mac, a window

A screen mockup is a `device` (or a `windowFrame`) holding its parts in `items`. Never draw a
phone from rectangles: the shell has the real proportions, status bar, island and home bar. The
`items` flow top to bottom inside the safe area (`gap`, default 10); a bar, field or button takes
the full width unless it names its own `w`. Nothing is placed by hand.

| Type | Fields |
|---|---|
| `device` | `kind` (`iphone` 393x852, `ipad`, `mac`), `label` (caption above), `dark`, `w`, `items` (the screen's parts) |
| `windowFrame` | `kind` (`browser` draws a URL bar, `app` a centred title), `url`, `title`, `w`, `h`, `items` |
| `appBar` | `title`, `back` (true), `actions` (icon names, up to 3) |
| `tabBar` | `items` (icon names or `{icon, label}`), `active` (index) |
| `listRow` | `title`, `subtitle`, `leading` (an icon name or `avatar`), `trailing` (an icon name, `toggle` or text) |
| `searchField` | `placeholder` |
| `segmented` | `items` (labels), `active` (index) |
| `input` | `label`, `placeholder` |
| `button` | `text`, `color`, `variant` (`outline`), `w` |
| `textRows` | `rows` (grey bars for body copy; never lorem ipsum) |
| `imagePlaceholder` | `h`, `label` (a box where a picture goes) |
| `navbar` | `brand`, `items` (links), `cta` (a web page's top bar) |
| `toggle`, `slider` | `on` / `value` (0..1) |
| `avatar`, `chip`, `divider`, `icon`, `iconButton` | `r` / `text`, `color` / (none) / `name`, `size` / `icon`, `shape`, `variant` |

Icons: menu close plus minus check search chevron-left chevron-right chevron-up chevron-down
arrow-left arrow-right more more-v play heart star user home bell trash settings share lock mail
camera image edit filter bookmark calendar. Any other name draws an empty box.

A phone screen:

```json
{ "elements": [ { "type": "device", "kind": "iphone", "label": "Ayarlar", "items": [
  { "type": "appBar", "title": "Ayarlar", "back": true },
  { "type": "searchField", "placeholder": "Ara" },
  { "type": "listRow", "leading": "bell", "title": "Bildirimler", "trailing": "toggle" },
  { "type": "listRow", "leading": "avatar", "title": "Hesap", "subtitle": "Plan: Pro" },
  { "type": "button", "text": "Kaydet" },
  { "type": "tabBar", "items": [ { "icon": "home", "label": "Ana" }, { "icon": "settings", "label": "Ayar" } ], "active": 1 }
] } ] }
```

A desktop app window (`"kind": "browser"` with a `url` for a web page):

```json
{ "elements": [ { "type": "windowFrame", "kind": "app", "title": "Panel", "w": 560, "h": 380, "items": [
  { "type": "input", "label": "Ad", "placeholder": "Adın" },
  { "type": "textRows", "rows": 3 },
  { "type": "button", "text": "Gönder", "w": 140 }
] } ] }
```

## Writing for a board

- Conclusion first: a `takeaway` or a callout `lead`, then the evidence.
- One idea a box. A label is 1 to 4 words; a block is at most 5 lines and 45 words.
- Bullets over prose for anything you can count.
- Look at the render before you say it is done; fix what reads badly and redraw in place.
