# Drawing in the Chat view: `dream-html`

For a drawing that is only part of a reply in the dreamcontext Chat view. The surface briefing
keeps the short "prose first" rule and points here; this is the whole grammar. A drawing to keep
(a whiteboard, an Excalidraw file, a knowledge diagram) is the rest of this skill, not this page.

## Prose first. Draw only what prose cannot hold

Your default is markdown: sentences, a list, a small table, an image. A `dream-html` block
has to be CLEARER than the words it replaces, not a nicer wrapper around them. Three things
qualify, nothing else does:

- **A diagram** — the shape IS the message: it branches, merges or loops and the reader has
  to hold it whole. `dc-graph`: you write nodes and edges, the kit places the nodes and
  DRAWS the arrows. A 2-4 step chain is a sentence; a longer one (a user journey) is a
  `dc-graph` too, never a row of chips. A drawing to KEEP (board, Excalidraw file) is the
  `draw` skill.
- **An interactive view** — the reader filters, toggles, switches or hovers data they would
  otherwise scroll: `dc-tabs`, `dc-btn` + an inline `<script>`, `dc-hit`/`dc-tip`.
- **A deck** — several screens for the fullscreen button: `<section class="dc-slide">`s in a
  `<div class="dc-slides">`.

Never a block: a short answer, a status, a list of findings, a 2-4 step chain, two options
in two sentences, one key/value, cards holding paragraphs. A comparison with three or more
criteria is a `dc-table` or a `dc-compare` of SHORT bullets; fewer is a sentence. Test:
delete the block and keep the prose — if nothing is lost, it was ceremony. One block, one
idea, one screen; it renders exactly where you wrote it, so the prose around it says what to
notice and what you want back. Anything the user will copy or click stays in the prose: a
code block has a copy button, a backticked path opens the file; inside the block they are
text.

## `dream-html` — you write nodes and edges, we draw the diagram

```dream-html
<div class="dc-graph">
  <div class="dc-node" id="req">Request</div>
  <div class="dc-node dc-node--decision" id="hit">In cache?</div>
  <div class="dc-node dc-node--good" id="out">Answer</div>
  <div class="dc-node" id="db">DB query</div>
  <div class="dc-edge" data-from="req" data-to="hit"></div>
  <div class="dc-edge" data-from="hit" data-to="out" data-label="yes"></div>
  <div class="dc-edge" data-from="hit" data-to="db" data-label="no"></div>
  <div class="dc-edge dc-edge--dashed" data-from="db" data-to="out"></div>
</div>
```

A node is a NAME — 1-4 words, no sentence, no `→` inside it. `--decision` is a question,
`--ghost` an exit that is not the point, `--good|--bad|--warn|--accent` only when the node
IS that; mixed tones get a one-line legend. An edge takes `data-label`, a tone, `--dashed`; a cycle
is fine. Never position
nodes yourself: the kit lays out, re-lays on resize, and runs a chain left-to-right when it
fits. The reader gets it as a VIEW, not a picture — centred, drag to pan, pinch or
ctrl/cmd-wheel to zoom, click a node to light its path and dim the rest — so a ladder with
ten nodes is fine. Never explain those controls in prose; they are the surface's, not yours.

Sandboxed with NO network: everything inline, any data you show is in your markup. Inline
`<script>` DOES run — buttons, filters and toggles work on that data; `dc-tabs` needs none
(a `dc-tablist` of `dc-tab` buttons over a `dc-panels`: tab N opens panel N). Two views of
one thing = the reader switches; don't stack both.

**Use the `dc-` kit; never your own colors, fonts or spacing** — it follows the user's
theme and brand, a hardcoded hex is wrong on another screen. `style=` only for geometry the
kit has no word for (an SVG path, a bar width). That is your page's rule: a mockup of a real
product screen copies THAT product's colors, type, radii and frame from its source styles,
inline, light theme; grey boxes only for a wireframe that was asked for.
**Tone is MEANING, emphasis is a POINTER:**
a neutral step stays neutral, a block tinted end to end says nothing. Numbered colors
(`dc-bg|f|s1..8`) are CHART fills, never a surface under words. ONE channel a sentence:
bold OR highlight OR a tint. Little content takes `dc-doc--hug`; a wide table a
`dc-table-wrap`; two columns claim the pair is comparable — dense prose in both is one
column or a `dc-table`. A `dc-kv` is `<dt>`key`<dd>`value pairs, or one `<div>` per row
that opens with a `dc-label`.

Layout `dc-doc dc-doc--hug dc-row dc-row--between dc-stack dc-grid dc-grid--2|3|4
dc-rail dc-spacer dc-divider dc-divider-label` · Text `dc-h1|h2|h3 dc-lede dc-p dc-muted
dc-label dc-strong dc-list dc-mark dc-code dc-pre dc-caption` · Numbers `dc-value
dc-value--lg|--sm dc-unit dc-num dc-delta dc-delta--up|--down|--flat` · Blocks `dc-card
dc-card-title dc-card-sub dc-card-img dc-card-foot dc-stat dc-stat-label dc-stat-note
dc-chip dc-chip--accent|--good|--bad|--warn dc-callout dc-callout--good|--bad|--warn
dc-table dc-table-wrap dc-kv dc-img dc-figcaption dc-btn dc-empty dc-low-sample` ·
Diagram `dc-graph dc-node dc-node--accent|--good|--bad|--warn|--decision|--ghost dc-edge
dc-edge--accent|--good|--bad|--warn|--dashed` · Explaining `dc-steps dc-step dc-step-body
dc-timeline dc-tl dc-tl-dot dc-tl-body dc-tl-when dc-compare dc-option dc-option--pick
dc-option-head dc-option-title dc-pros dc-cons dc-tabs dc-tablist dc-tab dc-panels
dc-panel` · Data `dc-bar dc-bar-label dc-bar-track dc-bar-fill dc-bar-value dc-funnel
dc-funnel-step dc-funnel-bar dc-funnel-drop dc-svg dc-axis dc-gridline dc-axis-row
dc-axis-text dc-legend dc-legend-swatch dc-f1..8 (fill) dc-s1..8 (stroke) dc-bg1..8` ·
Hover `dc-hit` wraps the mark, `dc-tip` inside is revealed (`dc-tip--below` flips it
under); in SVG the tip is a `<g>` you transform, painted by `dc-tip-box dc-tip-text`

For a chart, hand-roll inline SVG with `dc-svg` and the numbered color classes — never a
chart library (nothing loads), never a hardcoded palette. Axis labels go in a `dc-axis-row`
BELOW the svg: svg text scales with the viewBox, so 10px in a 320-wide box renders at 3x.
