---
name: excalidraw
description: >-
  Generate or extend Obsidian Excalidraw (.excalidraw.md) boards in this vault — visual-first diagrams,
  charts (line/bar/comparison/stacked/gantt/quadrant/donut/heatmap/table/timeline/KPI/sparkline),
  funnels, device mockups (iPhone/iPad/Mac) and wireframes/prototypes, flowcharts, image/screenshot
  layouts, shapes, arrows, frames, lanes and grids — by passing DATA to ~44 ready-made deterministic
  builders and letting a script emit valid plugin markup (so it costs ~no tokens and always renders).
  Every builder works from JS or straight from a JSON spec. Text wraps to a readable measure; the build
  audits the scene for overlaps, buried labels and over-long lines. Embeds local images via the plugin's
  sha1 wikilink trick (no base64). Triggers: '/excalidraw', 'draw this in excalidraw', 'make an
  excalidraw board', 'excalidraw diagram', 'chart', 'line chart', 'bar chart', 'compare before/after',
  'gantt', 'timeline', 'quadrant', 'impact effort matrix', 'heatmap', 'KPI tiles', 'dashboard board',
  'funnel', 'conversion funnel', 'wireframe', 'prototype', 'mockup', 'app/web screen mockup', 'iphone
  mockup', 'ipad mockup', 'mac app mockup', 'ui kit', 'icon button', 'funnel map board', 'embed
  screenshots into excalidraw', 'add images to an excalidraw file', 'excalidraw çiz', 'excalidraw board
  oluştur', 'grafik çiz', 'çizgi grafik', 'bar grafik', 'karşılaştırma grafiği', 'zaman çizelgesi',
  'funnel çiz', 'wireframe çiz', 'prototip çiz', 'iphone ekranı çiz', 'ekran tasarımı çiz', 'ekran
  görüntülerini excalidraw a ekle'.
---

# Excalidraw board generator (Obsidian)

Write `.excalidraw.md` files that render natively in this vault's Obsidian Excalidraw plugin.
**Do not hand-author the scene JSON.** Build a small spec and run the generator — it produces the
frontmatter, `## Text Elements`, `## Embedded Files`, and the `%% ## Drawing … %%` JSON, with
correct sha1 image links, fractional z-indices, and deterministic seeds (clean git diffs).

## Design principles (read first)

Excalidraw's strength is **pictures, not paragraphs**. Four rules keep a board clean, readable, and
visually rich — the primitives below enforce them, so lean on them instead of placing raw text/shapes:

1. **Use a primitive; don't hand-roll one.** There are ~44 ready builders (charts, house style,
   devices/UI) covering most of what a board needs — pass DATA, get correct geometry. This is the rule
   the other three depend on: hand-rolled composites are where boards break. Reach for `charts.js` /
   `wireframe.js` / `style.js` **before** writing rects + text yourself, and only drop to raw elements
   when nothing fits. Every builder is also a spec JSON `type`, so a whole board can be pure JSON.
2. **Visual-first.** Explain complex things with *structure you can see*: a `funnel()` of trapezoid
   bands, a `device()` of the actual screen, a `lineChart()` of the trend, a `hub()`/flow of `card()`s.
   Reach for a picture before a sentence. When you must write, keep it to labels and short notes.
3. **Readable measure — text never runs edge-to-edge.** Every text primitive wraps to a bounded width
   (`READ_W ≈ 620px`, ~60 chars). Use `prose()` for body copy, `bullets()` for lists, `callout()` for
   titled notes, `sectionTitle()` for headers — they cap + wrap for you. A raw `text` element **must**
   carry a `width` (it then wraps and the newlines are baked in, so it renders at that measure). Long
   unbounded text is the #1 readability killer, and the build now **enforces** this (`longLines`).
4. **No overlap — flow the layout, don't hand-place.** Build with `stack()` (top-to-bottom) and `row()`
   (left-to-right): each block is placed after the previous one's *measured* size, so boxes can't
   collide. Every build audits the finished scene and reports
   `overlaps=N buriedText=N longLines=N` — any non-zero count is a real defect (see **Layout rules**).

Everything downstream (the primitives, the auditors, the wrap-baking) exists to make these four cheap.

> **A clean audit is necessary, not sufficient — render the board and LOOK at it.** This is not a
> platitude: in practice most defects that reach a finished board are ones the audit cannot see —
> a mis-scaled axis, an axis caption wrapping one glyph per line, a sentence torn across a gap,
> content escaping a device bezel, a row label silently truncated. The audit catches geometry it can
> measure; your eyes catch the rest. See **Verify** for the headless render command.

## The one trick that makes images work
An image element references `fileId` = **sha1 of the image file**. The `## Embedded Files` section
maps `<sha1>: [[image.png]]`. The plugin resolves the picture from the vault via that wikilink —
**no base64 needed.** The generator computes the sha1 and writes both sides for you.

## Usage

### CLI (most common)
```bash
node .claude/skills/excalidraw/scripts/build_excalidraw.js <spec.json> [--out <path.excalidraw.md>]
```
Write a spec JSON, then run it. On success it prints
`elements=… images=… texts=… overlaps=… buriedText=… longLines=…` — the last three must all be **0**.
A spec element's `type` may be a primitive OR any of the ~44 composites (charts, house style, devices,
`stack`/`row`), so a whole board can be pure JSON with no generator script.

### JS API (for pipelines that generate many boards)
```js
const path = require('path');
// skill lives at <project>/.claude/skills/excalidraw/ — adjust leading ../ count to match your script's depth from project root
const { buildExcalidraw, lane, grid } = require(path.resolve(__dirname, '../.claude/skills/excalidraw/scripts/build_excalidraw.js'));
buildExcalidraw({ out: path.resolve(__dirname, '../boards/Board.excalidraw.md'), elements: [ ...lane({ title, images, x, y, thumbW }) ] });
```

## File layout

### Single board (default)
Keep the spec next to the generated board but clearly separated:
```
boards/
├── MyBoard.excalidraw.md      ← generated deliverable; do not hand-edit
└── _spec/
    └── MyBoard.json           ← source of truth; edit this, then regenerate
```
The `.excalidraw.md` is **disposable** — it is fully derived from the spec. If the two ever
disagree, the spec wins. Commit both (the board for Obsidian/GitHub preview, the spec for
reproducibility), but only edit the spec.

### Multi-board pipeline
When a single generator produces several boards, isolate it in a `pipeline/` folder so the
deliverable boards stay at the top of the project and are easy to open in Obsidian:
```
boards/
├── Overview.excalidraw.md     ← generated
├── Funnel.excalidraw.md       ← generated
├── Pricing.excalidraw.md      ← generated
└── pipeline/
    ├── generate.js            ← single regen entrypoint: `node pipeline/generate.js`
    ├── shared-style.js        ← shared palette / helpers
    └── spec/
        ├── Overview.json      ← source spec for Overview board
        ├── Funnel.json        ← source spec for Funnel board
        └── Pricing.json       ← source spec for Pricing board
```
- **Generated files** (`*.excalidraw.md`) live one level above `pipeline/` — open them in Obsidian without navigating into a sub-folder.
- **Source specs** live in `pipeline/spec/` — one JSON per board.
- **Single entrypoint**: `node pipeline/generate.js` rebuilds every board. No per-board manual commands.

### Many boards from shared data (recipe)
Use this pattern when multiple boards pull from the same data set (e.g. one board per product, per region, or per funnel step):

```js
// pipeline/generate.js  (lives at boards/pipeline/generate.js)
const path = require('path');
const ROOT  = path.resolve(__dirname, '..');          // boards/ directory
// ../../ = project root (boards/ → project/); adjust if boards/ is nested deeper
const { buildExcalidraw, lane } = require(path.resolve(__dirname, '../../.claude/skills/excalidraw/scripts/build_excalidraw.js'));
const style  = require(path.resolve(__dirname, 'shared-style.js'));
const items  = require(path.resolve(__dirname, 'spec/items.json'));  // shared data

for (const item of items) {
  const elements = style.buildItemBoard(item);        // per-item spec logic
  buildExcalidraw({
    out: path.resolve(ROOT, `${item.slug}.excalidraw.md`),
    elements,
  });
  console.log('wrote', item.slug);
}
```

```js
// pipeline/shared-style.js  (lives at boards/pipeline/shared-style.js)
const path = require('path');
// ../../ = project root (boards/ → project/); adjust if boards/ is nested deeper
const { card, connector, sectionTitle } = require(path.resolve(__dirname, '../../.claude/skills/excalidraw/scripts/lib/style.js'));

exports.buildItemBoard = (item) => [
  sectionTitle({ x: 0, y: 0, text: item.name, fontSize: 40 }),
  // … common layout using item fields
];
```

Key conventions:
- `ROOT = path.resolve(__dirname, '..')` pins paths relative to the generator file, not the working directory. The generator works correctly wherever it is invoked from.
- Each item produces exactly one board; the mapping is `items.json → <slug>.excalidraw.md`.
- `shared-style.js` owns the layout logic — boards stay visually consistent; change the style once, regenerate all.
- Add a `package.json` script or `Makefile` alias so the command is always `npm run boards` (or similar) and never has to be rediscovered.

## Spec schema
```jsonc
{
  "out": "./boards/Board.excalidraw.md",    // prefer __dirname-relative in JS generators; relative to cwd for CLI
  "vaultRoot": "/abs/vault",                  // optional; auto-detected by walking up to `.obsidian`
  "attachDir": "Attachments",                 // external images get copied here (relative to board dir)
  "wikilinkMode": "basename",                 // "basename" (default) or "path" (vault-relative)
  "background": "#ffffff",

  // frontmatter — REQUIRED for a board that lives in knowledge/ (dreamcontext indexes name +
  // description + tags; without them the board is effectively unrecallable). Omit for scratch boards.
  "name": "recall-engine-v2",
  "description": "One paragraph on what this board visualises. Long prose is fine — it is emitted as a folded YAML block.",
  "tags": ["architecture", "excalidraw"],
  "frontmatter": { "any-extra-key": "value" },   // optional passthrough

  "elements": [ /* ElementSpec… */ ]
}
```

**Paths in generators**: always use `path.resolve(__dirname, ...)` for `out` and image `path` fields — never
hardcode absolute paths. This keeps the generator portable: move the folder and it still runs.

### Element types
A `type` is either a **primitive** (below) or any **composite** — every chart (`lineChart`, `barCompare`,
`gantt`, `quadrant`, `heatmap`, `table`, `kpi`, `callout`, …), house-style widget (`card`, `funnel`,
`windowFrame`, `chip`, …) or layout (`stack`, `row`, which nest via `items`). Composites expand to
primitives before the build, so the JSON surface is as capable as the JS API. See **Charts** below.

- `text`     — `{ x, y, text, fontSize?, color?, width?, align?, fontFamily? }` (fontFamily 1=hand, 2=normal, 3=code). **Set `width` for any caption/label that must stay inside a column or card** → the text WRAPS to that width (autoResize off) and its height is computed from the wrapped line count. Omit `width` only for short single-line text you want sized to content (it renders on one line and will overlap neighbours if long).
- `image`    — `{ x, y, path, width? , height? }` — give ONE of width/height; the other is derived from aspect. `path` is an absolute file path.
- `rectangle`/`ellipse`/`diamond` — `{ x, y, width, height, strokeColor?, backgroundColor?, fillStyle?(solid|hachure|cross-hatch), strokeWidth?, roundness?(true=rounded) }`
- `line`/`arrow` — `{ points: [[x1,y1],[x2,y2],…], strokeColor?, strokeWidth?, endArrow?, startArrow? }` (coords are absolute; arrows default to an end arrowhead)
- `frame`    — `{ x, y, width, height, name }`

### Layout helpers (JS API) — dimension-aware, never gap/overlap
Both read each image's real pixel size at layout time, so every caption **hugs its own image's bottom**
(no fixed-aspect guess → no big gap under a short screenshot, no overlap under a tall one). They return
an `ElementSpec[]` you spread with `...`, and that array also carries `.height`, `.width`, and **`.nextY`**
so you can stack lanes/grids/sections without doing height math by hand.
- `lane({ title, images:[{path, caption}], x, y, thumbW, gap, captionSize, captionGap })` → titled horizontal
  strip; caption wraps to `thumbW` under each thumb. Ideal for **funnel step maps** (one lane per funnel).
- `grid({ images:[{path, caption}], x, y, cols, thumbW, gapX, gapY, captionSize })` → wrapping grid; each
  row sizes to its tallest image, each caption hugs its image.
- `thumbHeight(path, thumbW)` → the on-board height a thumbnail of width `thumbW` will get (exported for
  custom layouts that need to place captions/rows themselves).
```js
const a = lane({ title:'Pilates', images, x:60, y:120, thumbW:150 });
const b = lane({ title:'Fasting', images2, x:60, y:a.nextY, thumbW:150 }); // stacks under `a`, no overlap
buildExcalidraw({ out, elements:[ ...a, ...b ] });
```
House-style `card()` labels are also vertically centered correctly even when the label **wraps** to the card width.

## House style (`scripts/lib/style.js`) — learned from the vault's presentation boards
Match the team's look by default. The builder now defaults text to **Excalifont (fontFamily 5)**.
`style.js` exports the palette + ready-made builders so boards look hand-drawn and consistent:

- **`PALETTE`** (semantic, = Excalidraw's native swatches): `green` benefit/go · `red` pain/risk ·
  `blue` system/flow · `purple` core service · `yellow` processing · `mint` result · `gray` muted.
  Each is `{ fill, stroke }`. `INK` = `#1e1e1e` (the default 2px card outline). Fills are **solid**,
  rects are **always rounded**.
- **`card({x,y,w,h,text,color,fontSize})`** → rounded filled rect + centered label, grouped (move as one).
  The label **cannot overflow**: it is hard-wrapped to the card width and the font auto-shrinks (down to
  `minFont`, default 9px) until it also fits the height. Optional `{ minFont, padX, padY }`. If even the
  floor font won't fit, it still draws but logs a `[excalidraw]` warning — that's your cue to enlarge the
  card or shorten the text.
- **`node(...)`** → smaller card for flow steps.
- **`sectionTitle({x,y,text,fontSize})`** → big plain header (no box), like "Configuration" / "Flow".
- **`connector({from,to,label,double,dashed,via,elbow})`** → labeled arrow between two points. Route it
  AROUND intervening boxes instead of through them: `elbow:'hv'` (horizontal then vertical) / `elbow:'vh'`
  (vertical then horizontal) bends it once at a right angle, or `via:[[x,y],…]` threads explicit waypoints.
- **`fitText({text,w,h,fontSize,minFont})`** → the wrap+shrink primitive `card()` uses; call it directly to
  pre-size a box to its label (returns `{ text, fontSize, lineCount, fits }`).
- **`annotate({from,to,text})`** → short arrow to a side-spec note (the "90sec / deepseek…" pattern).
- **`column({x,y,items,color})`** → vertical stack of cards (benefit/risk lists). `items` may be
  strings or `{text,color}`.
- **`hub({cx,cy,label,spokes})`** → central node + satellites with arrows (the "Layer + APIs" pattern).
- **`bullets({x,y,items})`** → one left-aligned bulleted text block (their spec-list pattern).
- Edge helpers `center/rightOf/leftOf/topOf/bottomOf(x,y,w,h)` to wire connectors to card edges.

### Readable text + flow layout (use these, don't hand-place)
Every builder below returns an `ElementSpec[]` that also carries `.x/.y/.w/.h/.nextX/.nextY`, so the
layout helpers can measure and place blocks for you — no coordinate math, no overlap.
- **`prose({x,y,text,fontSize,width})`** → a wrapped paragraph. `width` defaults to `READ_W` (~60 chars);
  text can never exceed it. This is THE body-copy primitive. Height is derived from the wrapped lines.
- **`bullets({x,y,items,width})`** → left-aligned list; each item wraps to `width` with a hanging indent.
- **`sectionTitle({x,y,text,fontSize,maxWidth})`** → big header; long titles wrap to `maxWidth`.
- **`stack({x,y,gap,items})`** → flow blocks TOP-TO-BOTTOM. Each item is a factory `(x,y)=>els` (draws
  itself at the running cursor) or a pre-built `els` array (gets shifted down). Returns `.nextY`.
- **`row({x,y,gap,valign,items})`** → flow blocks LEFT-TO-RIGHT (same contract). Returns `.nextX`.
- `READ_W` / `NOTE_W` are the exported reading measures; `translate(els,dx,dy)` / `bbox(els)` are the
  low-level helpers the layout uses.

## Charts (`scripts/lib/charts.js`) — data in, correct geometry out

**Never hand-roll a chart from rects + text.** These builders own the axes, scales, wrapping, label
thinning and collision-avoidance; you supply DATA only. Same contract as `style.js` (return an
`ElementSpec[]` carrying `.x/.y/.w/.h/.nextY`), so they drop straight into `stack()`/`row()`. Nothing
is random or time-dependent — same input ⇒ same bytes. Each chart is **grouped**, so it moves as one
unit and the auditors treat its internals as intentional.

| builder | use it for |
|---|---|
| **`lineChart({series,xLabels,area,markers})`** | trend over time — DAU, spend, error rate. `series[].points` is a `number[]` aligned to `xLabels` (or `[{x,y}]` for irregular spacing) |
| **`barChart({bars,horizontal})`** | one value per category. `horizontal:true` when labels are long — they get their own gutter instead of being crammed under vertical bars |
| **`barCompare({groups,seriesLabels})`** | the "did it move?" chart — same categories across 2+ scenarios (W1↔W2, before/after, plan/actual) |
| **`stackedBar({groups,seriesLabels})`** | composition per category (revenue by plan, traffic by source); segments stack to each group's total |
| **`gantt({tasks,today})`** | timeline bars over a date axis. `start`/`end` take `'YYYY-MM-DD'`; `done:0..1` overlays progress; `milestone:true` draws a diamond |
| **`quadrant({items,xAxis,yAxis,quadrantLabels})`** | 2×2 positioning map (impact×effort, RICE). `items[]` carry `{label,x,y}` in 0..1; top-right is tinted as the "go" quadrant |
| **`donut({slices,inner})`** / **`pie`** | composition of a whole. Keep to ≤ ~6 slices — beyond that `barChart` reads better |
| **`sparkline({points})`** | a tiny trend with no axes, for inside a KPI tile or table cell. A glyph, not a chart |
| **`heatmap({rows,cols,values})`** | matrix of intensities (cohort×day retention). Cell tint interpolates, and the label flips to white on dark cells |
| **`table({headers,rows,align})`** | a real grid — column widths derive from content, so cells never spill. A cell may be `{text,color}` |
| **`timeline({events})`** | milestones on a track; labels alternate above/below so they can't collide |
| **`kpi({label,value,delta,spark})`** | the metric tile: three type sizes for hierarchy, optional sparkline footer |
| **`callout({title,text,sideTitle})`** | a titled note band. Body copy is **always** bounded to `READ_W`; a wide band puts its heading *beside* the text rather than stretching one line |

**`w` is a MAXIMUM, not a target.** `callout()` sizes itself to its own wrapped text — hand it 1080px for
620px of copy and it returns ~780px, not a band with 27% dead space. The title gutter hugs the title too.
That is what makes a primitive atomic: the caller says *at most this wide*, the builder works out the rest.
Pin `titleW` only to align the gutters of several stacked callouts; pass `fit: false` for a deliberate
full-width band. `prose()` already hugs the same way. (`card()`/`kpi()` stay caller-sized on purpose —
a row of tiles should be uniform.)

Helpers for custom charts: `linScale`, `niceScale`, `fmtNum`, `plotFrame`, `chartHead`, `xTickLabels`.

**Never split short copy into newspaper columns.** A 1–2 line "column" reads as a sentence torn across
a gap — worse than a long line. `callout()` handles this for you.

### Declarative charts — any composite works as a spec `type`
Every chart and house-style widget is also a **spec JSON element type**, expanded to primitives before
the build. An agent can draw a whole board without writing a generator — `stack`/`row` nest as JSON too:
```jsonc
{ "out": "./Board.excalidraw.md", "elements": [
  { "type": "stack", "x": 40, "y": 40, "gap": 40, "items": [
    { "type": "sectionTitle", "text": "Weekly review", "fontSize": 34 },
    { "type": "row", "gap": 24, "items": [
      { "type": "kpi", "w": 260, "label": "D0 ROAS", "value": "0.25", "delta": "flat", "color": "red" },
      { "type": "lineChart", "w": 620, "h": 300, "xLabels": ["3","5","7"],
        "series": [{ "label": "DAU", "color": "blue", "points": [58, 69, 32] }] }
    ]}
  ]}
]}
```
Reach for the JS API instead when you need loops, data mapping, or many boards from one data set.
Runnable: `node examples/chart_board.js` (every builder) · `node scripts/build_excalidraw.js examples/chart.spec.json` (pure JSON).

### Funnel
- **`funnel({x,y,w,stageH,stages,topW,botW})`** → a conversion/marketing funnel: filled trapezoid bands
  narrowing top→bottom, one per `stages[]` entry `{ label, note?, color? }`. Labels auto-fit; an optional
  `note` (a metric / drop-off) is placed in the right margin with a short non-crossing connector. Colors
  cycle through the semantic palette unless you set `color`. Returns `.nextY`.

## Devices + product UI (`scripts/lib/wireframe.js`) — sketch a real screen

For **app/product** wireframes. One require gives the whole UI kit (it re-exports style.js's wireframe
bits too). Every builder is also a spec JSON `type`.

- **`device({kind,x,y,w?,label?,dark?,content?})`** → a device shell at **real proportions**
  (`iphone` 393×852 · `ipad` 834×1194 · `mac` 1440×900), with status bar, dynamic island / camera /
  notch, home indicator, Mac menu bar + laptop foot. Returns **`.inner`** — the safe content region
  (inside the bezel, below the island, above the home indicator) — and `.screen`.
  **Pass `content: (inner) => els`**: it's the only place overflow can be caught. The build audit is
  blind here — a device shell is a filled polygon and `isOpaqueBox()` only knows rect/ellipse/diamond/
  image — so a hardcoded child width silently renders *outside the bezel*. `content` warns instead.
- **`appBar({title,back,actions})`** · **`tabBar({items,active})`** — mobile top/bottom chrome.
- **`icon({name,size})`** — 31 line-drawn glyphs. `iconNames()` lists them; an unknown name draws a
  box so a typo is visible rather than silently absent.
- **`iconButton({icon,shape,variant,color})`** — `shape`: circle/square/rounded · `variant`: solid/outline/ghost.
- **`listRow({title,subtitle,leading,trailing})`** — `leading` an icon name or `'avatar'`; `trailing`
  an icon name, `'toggle'`, or text.
- **`toggle({on})`** · **`segmented({items,active})`** · **`slider({value})`** · **`searchField({placeholder})`**
- Plus the generic bits: `windowFrame` (browser/app chrome), `navbar`, `button`, `input`, `textRows`,
  `imagePlaceholder`, `avatar`, `chip`, `divider`.

```js
const { device, appBar, tabBar, listRow } = require('.../lib/wireframe.js');
P(device({ kind: 'iphone', x: 60, y: 80, label: 'Ayarlar', content: (inner) => stack({
  x: inner.x, y: inner.y, gap: 0, items: [
    (x, y) => appBar({ x, y, w: inner.w, title: 'Ayarlar', back: true }),
    (x, y) => listRow({ x, y, w: inner.w, leading: 'bell', title: 'Bildirimler', trailing: 'toggle' }),
  ],
})}));
```
Runnable: `node examples/wireframe_board.js` — three devices, every control, the full icon set.

**Corner radius gotcha**: `roundness:true` maps to Excalidraw's ADAPTIVE_RADIUS, capped at ~32px —
too tight for a phone (an iPhone's is ~14% of its width). Device shells are therefore filled
**polygons** with exact arc corners (`roundRect()` is exported if you need the same trick).

### Generic UI bits (grayscale — sketch a UI, not decoration)
These live in `style.js` and are re-exported by `wireframe.js`, so `require` either one. Use them
inside a `device()` for an app screen, or a `windowFrame()` for a web page.
- **`windowFrame({x,y,w,h,kind,url,title})`** → a browser (`kind:'browser'`, draws a URL bar) or app
  (`kind:'app'`, centered title) window with traffic-light chrome. **Returns `.inner = {x,y,w,h}`** — the
  safe content region; place children there (via `stack`/`row`) and they won't hit the chrome.
  For an **iPhone/iPad/Mac** shell with real proportions, use `device()` above instead.
- **`navbar({x,y,w,brand,items,cta})`** → top nav: brand left, links right, optional CTA button.
- **`button({x,y,w,h,text,color,variant})`** → solid CTA (default) or `variant:'outline'`.
- **`input({x,y,w,h,placeholder,label})`** → a form field with a muted placeholder + optional label.
- **`textRows({x,y,w,rows})`** → grey bars standing in for body copy — VISUAL filler, no real text. Use
  these instead of lorem ipsum so a wireframe never becomes a wall of text.
- **`imagePlaceholder({x,y,w,h,label})`** → the universal box-with-an-X where a screenshot would go.
- **`avatar({cx,cy,r})`** → round user placeholder. **`chip({x,y,text,color})`** → a pill/tag/badge.
  **`divider({x,y,w})`** → a thin rule.

Conventions: color nodes by ROLE, label every arrow, put specs in side-annotations, use big plain
section titles to break the board into "slides", keep one idea per card, and **prefer a picture to a
paragraph**.

### Which lib?
| file | owns | reach for it when |
|---|---|---|
| `lib/style.js` | house style + layout: `card`, `node`, `connector`, `hub`, `column`, `funnel`, `prose`, `bullets`, `sectionTitle`, `chip`, `divider`, **`stack`/`row`**, `READ_W`, `measureText`, `wrapToWidth`, `fitText` | diagrams, flows, any board's skeleton |
| `lib/charts.js` | data viz + copy: `lineChart`, `barChart`, `barCompare`, `stackedBar`, `gantt`, `quadrant`, `donut`/`pie`, `sparkline`, `heatmap`, `table`, `timeline`, `kpi`, `callout` | anything with numbers |
| `lib/wireframe.js` | product UI: `device`, `appBar`, `tabBar`, `icon`, `iconButton`, `listRow`, `toggle`, `segmented`, `slider`, `searchField` (+ re-exports style.js's UI bits) | app/screen mockups |

All three share one contract — an `ElementSpec[]` carrying `.x/.y/.w/.h/.nextX/.nextY` — so anything
composes inside `stack()`/`row()`, and everything is also a spec JSON `type`.

### Layout rules that keep boards clean
- **Flow the layout with `stack()` / `row()`; never eyeball coordinates for a column or a grid.** They
  place each block after the previous one's measured size, so nothing overlaps by construction. Reserve
  hand-picked `x/y` for a handful of top-level anchors (where a funnel goes vs where a window goes).
- **Heed the audit — all three checks.** Every build reports `overlaps=N buriedText=N longLines=N`, and
  prints a `[excalidraw]` warning naming the offenders. Any non-zero count is a real defect:
  - `overlaps` — two filled boxes collide (intentional nesting like a button inside a window is ignored).
  - `buriedText` — a text LINE is >30% swallowed by a box it isn't grouped with, i.e. an unreadable
    label. Box-vs-box cannot see this: a section title eaten by a card is text-vs-box.
  - `longLines` — body copy past the reading measure (`READ_W`, +10% tolerance; display type ≥28px is
    exempt). This is the skill's headline rule, and it is now enforced rather than merely documented.

  Fix by flowing that region through `stack()`/`row()`, or by using the primitives that cap the measure
  (`prose`/`bullets`/`callout`). Opt out with `spec.audit === false` only if you *know* it's deliberate.
  **A clean audit is necessary, not sufficient — always render the board and LOOK at it.** The audit
  cannot see a chart with a mis-scaled axis, a torn sentence, or a layout that is merely ugly.
- **Size boxes for their text.** A card guarantees the label stays *inside*, but it does so by shrinking
  the font — a long label in a small box ends up tiny. Give wide/long labels a wider `w` (or more `h`),
  or split the idea across two cards. Watch for `[excalidraw]` fit warnings on the console.
- **Fan out through a margin bus, never as a diagonal star.** A hub wired straight to a vertical stack of
  boxes draws diagonals that cut across the boxes in between. Instead, route the trunk into an empty
  margin beside the stack, run one vertical "bus" line down that margin, then a short horizontal stub from
  the bus into each box. With `connector()`: send the trunk `elbow:'hv'` into the bus x, then one
  `elbow:'hv'` stub per branch (or `via:[[busX, branchY]]`). No arrow crosses a box it isn't pointing at.

## Rules & gotchas
- **Unique image filenames.** Obsidian resolves `[[name.png]]` by basename; if two different files
  share a name anywhere in the vault the link is ambiguous. Name screenshots uniquely
  (e.g. `bm-pilates-2707-step-03.png`) or use `"wikilinkMode": "path"`.
- Images must live inside the vault. External paths are auto-copied into `attachDir`.
- Output is uncompressed JSON inside `%% … %%`. The plugin reads it; on its first save it may
  re-compress — that's expected and harmless.
- Re-running with the same `out` + same spec yields a byte-stable file (seeds are derived from the
  output path), so boards diff cleanly in git.
- **Self-contained / portable.** No `npm install` — `build_excalidraw.js` uses only Node builtins +
  the vendored `scripts/lib/*` (fractional-indexing, imagesize, style). Copy `.claude/skills/excalidraw/`
  into any project and it works. `vaultRoot` auto-detects `.obsidian`; with none it falls back to the
  board's own folder, so the `.excalidraw.md` is still written (it just renders inside Obsidian).

## Verify
Run the bundled examples from the skill folder (they use skill-relative paths + a bundled `sample.png`,
so they work in any project):
```bash
cd .claude/skills/excalidraw
node scripts/build_excalidraw.js examples/hello.spec.json   # spec-driven: text/shapes/image → examples/Hello Excalidraw.excalidraw.md
node examples/style_board.js                                # JS API: card/connector/lane house style → examples/Style Demo.excalidraw.md
node examples/visual_board.js                              # visual-first kit: funnel + browser prototype + readable prose
node examples/chart_board.js                               # every chart in the kit, one board (smoke test)
node scripts/build_excalidraw.js examples/chart.spec.json  # charts declaratively, pure JSON, no generator
node examples/atomic_check.js                             # every type from ONE spec element + degenerate input
node examples/wireframe_board.js                          # devices (iPhone/iPad/Mac) + every UI control + icon set
```
`atomic_check.js` is the guard on the kit's core promise: each type must draw from a **single spec
element with data only**, and must not throw on degenerate input (empty series, one point, all-equal
values). Add a chart to `charts.js` but forget to register it in `COMPOSITES` and this fails. It exits
non-zero, so it can be wired into CI.
Each build prints `overlaps=N buriedText=N longLines=N` — a clean board reports **0 for all three**.

**Then LOOK at the board.** A clean audit is necessary, not sufficient: it cannot see a mis-scaled
axis, a sentence torn across a gap, or a layout that is simply ugly. Either open it in Obsidian
(Excalidraw view), or render it headlessly and inspect the PNG:
```bash
node scripts/diagrams/render-excalidraw.mjs <board.excalidraw.md> /tmp/out.png 1   # (in this repo)
```

See `reference/format.md` for the exact `.excalidraw.md` anatomy reverse-engineered from this vault.

---

## Boards as first-class knowledge in dreamcontext

When the project uses dreamcontext, an Excalidraw board belongs **inside the context folder it
documents** — co-located with that context's knowledge, e.g.
`_dream_context/knowledge/<context>/<title>/<title>.excalidraw.md`. Diagrams are NOT a segregated
top-level dump; they live with the context they illustrate (`knowledge/**/*.md` is indexed
recursively, so a board in a context subfolder is fully recalled). Boards are indexed and recalled
like any knowledge file — but memory extracts ONLY the `## Text Elements` section (never the scene
JSON).

### Required frontmatter

Every board MUST have `name:` and `description:` — **pass them to `buildExcalidraw`** and it emits
them for you (long descriptions become a folded YAML block; `tags` defaults to `[excalidraw]`).
Do NOT hand-patch the generated file afterwards.

```js
buildExcalidraw({ out, elements, name: 'recall-engine-v2', tags: ['architecture', 'excalidraw'],
  description: 'How recall ranks and merges hits across the vault and consenting peers…' });
```
Memory indexes frontmatter + `## Text Elements` and never the scene JSON, so a board with few labels
leans entirely on `description` for recall — make it descriptive.

```yaml
---
name: My Board Title
description: One-sentence summary of what this board visualises.
tags: [architecture, excalidraw]
excalidraw-plugin: parsed
---
```

### Folder convention (preferred)

A board lives in its own `<title>/` wrapper folder, INSIDE the context it documents:

```
_dream_context/knowledge/
├── recall/                          ← a context folder (its knowledge + its diagram)
│   ├── recall-engine-v2.md
│   └── recall/
│       ├── recall.excalidraw.md     ← generated board (do NOT hand-edit scene JSON)
│       ├── recall.board.cjs         ← generator (dark sibling — excluded from index/recall)
│       └── recall.json              ← spec / source of truth (dark sibling — excluded)
├── system/
│   └── architecture/
│       └── architecture.excalidraw.md
└── diagrams/                        ← LEGACY top-level tree still works (apply-diagrams maintains it)
    └── legacy-flat.excalidraw.md
```

Nesting is free-form, any depth — the dashboard Knowledge view renders the whole `knowledge/` tree
as a nested, collapsible folder tree (each board shows a sketch icon), so a large diagram set stays
navigable. A board's own `<title>/` folder is always its innermost folder. Note: a `.board.cjs`
that `require()`s shared helpers by relative path must use a depth that matches its actual location.

**Dark siblings**: tooling files inside a board's `<title>/` folder are automatically excluded
from the index, recall corpus, snapshot, and dashboard list — generator scripts (`.board.cjs`),
spec JSON, and frontmatter-less helper `.md` notes. They are tooling — they do not pollute memory.

**Companion knowledge is the exception**: a `.md` beside a board that carries `name:` frontmatter
is indexed as first-class knowledge (not a dark sibling). This lets you co-locate a board with its
detailed write-up — e.g. `acme/acme.excalidraw.md` next to `acme/acme.teardown.md` — and have the
teardown recall normally. Only frontmatter-less notes stay dark, so good organization no longer
costs you recall.

**Flat legacy layout** (`diagrams/<title>.excalidraw.md`) still works without migration, but new
boards belong in their context folder (above); use a per-title `<title>/` folder to keep the
board + generator + spec together cleanly.

### Memory contract

- Memory indexes: frontmatter (`name`, `description`, `tags`) + `## Text Elements` labels.
- Memory never indexes: scene JSON, base64 blobs, element ids, `## Embedded Files` map.
- The dashboard renderer receives the raw body (full scene JSON) via the detail API route —
  rendering is unaffected by extraction.
- A 2 MB board with rich Text Elements and a tiny board with the same labels have the same
  recall surface. Scene size does not affect recall or snapshot token cost.

### Where does a board go?

| Board nature | Location | Indexed? |
|---|---|---|
| Canonical / source-of-truth (architecture, system flows, roadmaps, durable plans the agent should recall in future sessions) | inside its `knowledge/<context>/<title>/` folder | Yes — indexed, recalled |
| Temporary / scratch / exploratory / in-progress | `inbox/` or `workspace/` (dark by location) | No — not indexed, will not pollute recall |

**Decision rule**: "Will a future session need to know this? → its context folder under `knowledge/`. Throwaway/working? → `inbox/` or `workspace/`."

Promote a board from inbox/workspace into its context folder only once it becomes canonical.

### Legacy `knowledge/diagrams/` + migration

Older projects kept all boards under a single top-level `knowledge/diagrams/` tree. That still
indexes and renders, and `sleep-product` keeps the store organized over time — but new boards
should go in their **context folder** (above), not the segregated dump.

- `dreamcontext migrations pending` — see pending migration task instructions (incl. 0.7.2 diagrams-folder-convention).
- `dreamcontext migrations apply-diagrams` — structural/legacy: folds flat `knowledge/diagrams/*.excalidraw.md` boards into per-title folders AND rewrites inbound [[wikilinks]] atomically. Safe to re-run. Do NOT hand-edit wikilinks manually.

Only organize boards you confirm are canonical knowledge. Temp/scratch boards stay in inbox/workspace.
