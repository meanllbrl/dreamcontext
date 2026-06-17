---
name: excalidraw
description: >-
  Generate or extend Obsidian Excalidraw (.excalidraw.md) boards in this vault — lay out
  images/screenshots, text labels, shapes, arrows, frames, lanes and grids — by writing a small
  JSON spec and letting a deterministic script emit valid plugin markup (so it costs ~no tokens and
  always renders). Embeds local images via the plugin's sha1 wikilink trick (no base64). Triggers:
  '/excalidraw', 'draw this in excalidraw', 'make an excalidraw board', 'excalidraw diagram',
  'funnel map board', 'embed screenshots into excalidraw', 'add images to an excalidraw file',
  'excalidraw çiz', 'excalidraw board oluştur', 'ekran görüntülerini excalidraw a ekle'.
---

# Excalidraw board generator (Obsidian)

Write `.excalidraw.md` files that render natively in this vault's Obsidian Excalidraw plugin.
**Do not hand-author the scene JSON.** Build a small spec and run the generator — it produces the
frontmatter, `## Text Elements`, `## Embedded Files`, and the `%% ## Drawing … %%` JSON, with
correct sha1 image links, fractional z-indices, and deterministic seeds (clean git diffs).

## The one trick that makes images work
An image element references `fileId` = **sha1 of the image file**. The `## Embedded Files` section
maps `<sha1>: [[image.png]]`. The plugin resolves the picture from the vault via that wikilink —
**no base64 needed.** The generator computes the sha1 and writes both sides for you.

## Usage

### CLI (most common)
```bash
node .claude/skills/excalidraw/scripts/build_excalidraw.js <spec.json> [--out <path.excalidraw.md>]
```
Write a spec JSON, then run it. The script prints `elements/images/texts` counts on success.

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
  "elements": [ /* ElementSpec… */ ]
}
```

**Paths in generators**: always use `path.resolve(__dirname, ...)` for `out` and image `path` fields — never
hardcode absolute paths. This keeps the generator portable: move the folder and it still runs.

### Element types
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
- **`node(...)`** → smaller card for flow steps.
- **`sectionTitle({x,y,text,fontSize})`** → big plain header (no box), like "Configuration" / "Flow".
- **`connector({from,to,label,double,dashed})`** → labeled arrow between two points.
- **`annotate({from,to,text})`** → short arrow to a side-spec note (the "90sec / deepseek…" pattern).
- **`column({x,y,items,color})`** → vertical stack of cards (benefit/risk lists). `items` may be
  strings or `{text,color}`.
- **`hub({cx,cy,label,spokes})`** → central node + satellites with arrows (the "Layer + APIs" pattern).
- **`bullets({x,y,items})`** → one left-aligned bulleted text block (their spec-list pattern).
- Edge helpers `center/rightOf/leftOf/topOf/bottomOf(x,y,w,h)` to wire connectors to card edges.

Compose these into a `buildExcalidraw({ out, elements })` call. Runnable example: `examples/style_board.js`.
Conventions: color nodes by ROLE, label every arrow, put specs in side-annotations, use big plain
section titles to break the board into "slides", keep one idea per card.

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
```
Then open the resulting board in Obsidian (Excalidraw view) to confirm it renders.

See `reference/format.md` for the exact `.excalidraw.md` anatomy reverse-engineered from this vault.

---

## Boards as first-class knowledge in dreamcontext

When the project uses dreamcontext, Excalidraw boards belong in `_dream_context/knowledge/diagrams/`.
They are indexed and recalled just like any knowledge file — but memory extracts ONLY the
`## Text Elements` section (never the scene JSON).

### Required frontmatter

Every board MUST have `name:` and `description:`. Boards with no `## Text Elements` content rely
entirely on description for recall — make it descriptive.

```yaml
---
name: My Board Title
description: One-sentence summary of what this board visualises.
tags: [architecture, excalidraw]
excalidraw-plugin: parsed
---
```

### Folder convention (preferred)

```
_dream_context/knowledge/diagrams/
├── my-board/
│   ├── my-board.excalidraw.md   ← generated board (do NOT hand-edit scene JSON)
│   ├── my-board.board.cjs       ← generator (dark sibling — excluded from index/recall)
│   └── my-board.json            ← spec / source of truth (dark sibling — excluded)
├── competitors/                 ← optional category subfolder (groups many boards)
│   └── acme/
│       └── acme.excalidraw.md
└── legacy-flat.excalidraw.md    ← flat layout still works; no forced migration
```

**Category subfolders** are optional and free-form: `diagrams/<category>/<title>/<title>.excalidraw.md`.
The dashboard Knowledge view renders the whole `diagrams/` subtree as a nested, collapsible folder
tree (each board shows a sketch icon), so a large diagram set stays navigable instead of collapsing
into one flat list. A board's own `<title>/` folder is always its innermost folder. Note: a
`.board.cjs` that `require()`s shared helpers by relative path must use a depth that matches its
actual location.

**Dark siblings**: tooling files inside a `diagrams/<title>/` folder are automatically excluded
from the index, recall corpus, snapshot, and dashboard list — generator scripts (`.board.cjs`),
spec JSON, and frontmatter-less helper `.md` notes. They are tooling — they do not pollute memory.

**Companion knowledge is the exception**: a `.md` beside a board that carries `name:` frontmatter
is indexed as first-class knowledge (not a dark sibling). This lets you co-locate a board with its
detailed write-up — e.g. `acme/acme.excalidraw.md` next to `acme/acme.teardown.md` — and have the
teardown recall normally. Only frontmatter-less notes stay dark, so good organization no longer
costs you recall.

**Flat layout** (`diagrams/<title>.excalidraw.md`) works without any migration. Use the
per-title folder when you want to keep the board + generator + spec together cleanly.

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
| Canonical / source-of-truth (architecture, system flows, roadmaps, durable plans the agent should recall in future sessions) | `_dream_context/knowledge/diagrams/<title>/` | Yes — indexed, recalled |
| Temporary / scratch / exploratory / in-progress | `inbox/` or `workspace/` (dark by location) | No — not indexed, will not pollute recall |

**Decision rule**: "Will a future session need to know this? → `knowledge/diagrams/`. Throwaway/working? → `inbox/` or `workspace/`."

Promote a board from inbox/workspace to `knowledge/diagrams/` only once it becomes canonical.

### Migration

Flat boards in `knowledge/diagrams/` do NOT auto-migrate.

- `dreamcontext migrations pending` — see pending migration task instructions (including 0.7.2 diagrams-folder-convention).
- `dreamcontext migrations apply-diagrams` — opt-in: moves flat `knowledge/diagrams/*.excalidraw.md` boards into per-title folders AND rewrites all inbound [[wikilinks]] atomically. Safe to re-run. Do NOT hand-edit wikilinks manually.

Only organize boards you confirm are canonical knowledge. Temp/scratch boards stay in inbox/workspace.
