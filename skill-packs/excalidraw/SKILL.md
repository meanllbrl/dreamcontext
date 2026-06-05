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
const { buildExcalidraw, lane, grid } = require('.../scripts/build_excalidraw.js');
buildExcalidraw({ out, elements: [ ...lane({ title, images, x, y, thumbW }) ] });
```

## Spec schema
```jsonc
{
  "out": "/abs/path/Board.excalidraw.md",   // required (or pass --out)
  "vaultRoot": "/abs/vault",                  // optional; auto-detected by walking up to `.obsidian`
  "attachDir": "Attachments",                 // external images get copied here (relative to board dir)
  "wikilinkMode": "basename",                 // "basename" (default) or "path" (vault-relative)
  "background": "#ffffff",
  "elements": [ /* ElementSpec… */ ]
}
```

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
