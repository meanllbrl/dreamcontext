#!/usr/bin/env node
// build_excalidraw.js — generate an Obsidian-compatible .excalidraw.md board from a high-level spec.
//
// Format reverse-engineered from the user's own vault (see ../reference/format.md):
//   - frontmatter `excalidraw-plugin: parsed`
//   - `## Text Elements`  : "<text> ^<id>" per text element
//   - `## Embedded Files` : "<sha1>: [[image.png]]"  (plugin resolves image from vault by this map)
//   - `%% ## Drawing ```json <scene> ``` %%`  (uncompressed JSON; plugin reads it fine)
// Images need NO base64 — the fileId (sha1 of the file) + the Embedded Files wikilink is enough.
//
// Usage (CLI):  node build_excalidraw.js <spec.json> [--out <path.excalidraw.md>]
// Usage (API):  const { buildExcalidraw, lane, grid } = require('./build_excalidraw.js')
//
// Spec shape:
// {
//   "out": "/abs/Board.excalidraw.md",          // or pass --out
//   "vaultRoot": "/abs/vault",                    // auto-detected (walks up for .obsidian) if omitted
//   "attachDir": "Attachments",                   // where external images get copied (relative to board dir)
//   "wikilinkMode": "basename" | "path",          // how Embedded Files links are written (default basename)
//   "background": "#ffffff",
//   "elements": [ <ElementSpec>, ... ]
// }
// ElementSpec.type: text | image | rectangle | ellipse | diamond | line | arrow | frame
//   ...plus any COMPOSITE type (chart / house-style widget / layout) — see COMPOSITES below. A
//   composite element is expanded into primitives before the build, so the CLI can draw a whole
//   lineChart or funnel declaratively without writing a generator script.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { generateNKeysBetween } = require('./lib/fractional-indexing.js');
const { imageSize } = require('./lib/imagesize.js');
const TYPO = require('./lib/typography.js');
const STYLE = require('./lib/style.js');
const CHARTS = require('./lib/charts.js');
const WF = require('./lib/wireframe.js');

// ---------- composite element types (declarative surface) ----------
// Every entry maps a spec `type` to a builder that returns an ElementSpec[]. The expander runs BEFORE
// the primitive loop and is recursive, so composites may emit composites. This is what makes the JSON
// surface as capable as the JS API — the same builders back both.
const COMPOSITES = {
  // charts
  lineChart: CHARTS.lineChart, barChart: CHARTS.barChart, barCompare: CHARTS.barCompare,
  stackedBar: CHARTS.stackedBar, gantt: CHARTS.gantt, quadrant: CHARTS.quadrant,
  donut: CHARTS.donut, pie: (o) => CHARTS.donut(Object.assign({ inner: 0 }, o)),
  sparkline: CHARTS.sparkline, heatmap: CHARTS.heatmap, table: CHARTS.table,
  timeline: CHARTS.timeline, kpi: CHARTS.kpi, callout: CHARTS.callout,
  // house style
  funnel: STYLE.funnel, card: STYLE.card, node: STYLE.node, column: STYLE.column, hub: STYLE.hub,
  connector: STYLE.connector, annotate: STYLE.annotate, chip: STYLE.chip, divider: STYLE.divider,
  prose: STYLE.prose, bullets: STYLE.bullets, sectionTitle: STYLE.sectionTitle,
  takeaway: STYLE.takeaway,
  // wireframe kit
  windowFrame: STYLE.windowFrame, navbar: STYLE.navbar, button: STYLE.button, input: STYLE.input,
  textRows: STYLE.textRows, imagePlaceholder: STYLE.imagePlaceholder, avatar: STYLE.avatar,
  // device + product-UI kit
  device: WF.device, appBar: WF.appBar, tabBar: WF.tabBar, icon: WF.icon, iconButton: WF.iconButton,
  listRow: WF.listRow, toggle: WF.toggle, segmented: WF.segmented, slider: WF.slider,
  searchField: WF.searchField, roundRect: WF.roundRect,
};
// Layout composites take `items` (child specs) rather than scalar props, so they expand differently.
const LAYOUTS = { stack: STYLE.stack, row: STYLE.row };

function expandElements(list) {
  const out = [];
  for (const e of (list || [])) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) { if (e) out.push(e); continue; }
    if (LAYOUTS[e.type]) {
      // each item is itself a spec (or array of specs) → expand first, then let stack/row measure it
      const items = (e.items || []).map((it) => expandElements(Array.isArray(it) ? it : [it]));
      out.push(...expandElements(LAYOUTS[e.type](Object.assign({}, e, { items }))));
    } else if (COMPOSITES[e.type]) {
      out.push(...expandElements(COMPOSITES[e.type](e)));
    } else {
      out.push(e);
    }
  }
  return out;
}

// ---------- frontmatter YAML ----------
// Minimal, dependency-free emitters. Only what frontmatter needs: a safe scalar and a folded block
// for long prose (a description is often a paragraph, and an unquoted one with `:` breaks the parse).
function yamlScalar(v) {
  const s = String(v);
  return /^[\w][\w .\-/()]*$/.test(s) ? s : JSON.stringify(s);
}
function yamlFolded(key, text, width = 96) {
  // `>-` folds newlines to spaces on read, so wrap freely; indent 2 marks the block.
  const words = String(text).replace(/\s+/g, ' ').trim().split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (cur && (cur + ' ' + w).length > width) { lines.push(cur); cur = w; } else cur = cur ? cur + ' ' + w : w;
  }
  if (cur) lines.push(cur);
  return [`${key}: >-`, ...lines.map((l) => '  ' + l)];
}

// ---------- deterministic PRNG (stable seeds => clean git diffs) ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0);
  };
}
function strHash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
function idFrom(rng) { let s = ''; for (let i = 0; i < 8; i++) s += B62[rng() % 62]; return s; }

const FIXED_UPDATED = 1735689600000; // stable timestamp; visual no-op

// ---------- vault helpers ----------
function findVaultRoot(startDir) {
  let d = startDir;
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(path.join(d, '.obsidian'))) return d;
    const p = path.dirname(d);
    if (p === d) break; d = p;
  }
  return null;
}

// ---------- text sizing ----------
// Measuring and wrapping live in lib/typography.js, on advance tables measured from the real font
// files (scripts/diagrams/calibrate-excalidraw-fonts.mjs) rather than a single guessed constant.
const { isWideGlyph, glyphW, measureText, wrapToWidth: wrapText } = TYPO;

// When a fixedWidth is given the text WRAPS to it (autoResize off) and the wrapped text is baked with
// newlines, so it renders at the intended measure and its height reflects the real line count. Baking
// is what actually fixes over-wide text: a width-set text element with no hard newlines is re-flowed
// by the renderer into ONE line wider than its box (captions then overlap their neighbours).
// Returns { width, height, text } — `text` carries the baked newlines when a width was given.
function sizeText(text, fontSize, fixedWidth, lineHeight, font) {
  const lh = lineHeight || TYPO.LH.tight;
  if (fixedWidth != null) {
    const wrapped = wrapText(text, fontSize, fixedWidth, font);
    const lc = wrapped.split('\n').length;
    return { width: fixedWidth, height: Math.max(Math.round(fontSize * lh), Math.round(lc * fontSize * lh)), text: wrapped };
  }
  const rawLines = String(text).split('\n');
  const maxW = rawLines.reduce((m, l) => Math.max(m, measureText(l, fontSize, font)), 0);
  return { width: Math.max(10, Math.round(maxW)), height: Math.round(rawLines.length * fontSize * lh), text: String(text) };
}

// ---------- element factory ----------
// `roughness` was hardcoded to 1 for every element, so a spec asking for a CLEAN edge silently got a
// sketchy one. That is invisible on a card outline and very visible on a 40px underline: rough.js
// overshoots a wobbly line's endpoints, so an emphasis rule drawn to a phrase's exact width rendered
// several pixels past it — reading as though the punctuation after the phrase were underlined too.
// 0 = precise, 1 = the hand-drawn default, 2 = loose.
function withRoughness(spec, el) {
  if (spec && spec.roughness != null) el.roughness = spec.roughness;
  return el;
}

function baseEl(rng, type, x, y, w, h, overrides) {
  return Object.assign({
    id: idFrom(rng),
    type, x, y, width: w, height: h,
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: 'a0',
    roundness: null,
    seed: rng() >>> 0,
    version: 1,
    versionNonce: rng() >>> 0,
    isDeleted: false,
    boundElements: [],
    updated: FIXED_UPDATED,
    link: null,
    locked: false,
  }, overrides || {});
}

// ---------- overlap auditor ----------
// Overlapping opaque boxes are the #1 thing that makes a generated board look broken. After the scene
// is built we scan for it and warn — so a hand-authored spec that miscomputed a coordinate gets caught
// at generate time instead of in the reader's face. We flag SIBLING COLLISIONS: two comparable filled
// boxes (rect / ellipse / diamond, or images) that partially overlap or fully stack. We do NOT flag
// CONTAINMENT — a small box nested inside a much larger one (a button inside a window, a dot inside a
// title bar, content inside a frame) is the normal parent/child relationship. Grouped composites (a
// card's own label, a window's own chrome) and connectors / transparent shapes are skipped too.
// Disable with `spec.audit === false`.
function auditOverlaps(elements) {
  const label = (e) => {
    if (e.type === 'text') return JSON.stringify(String(e.text).split('\n')[0].slice(0, 24));
    return `${e.type}@(${Math.round(e.x)},${Math.round(e.y)})`;
  };
  const grp = (e) => (e.groupIds && e.groupIds[0]) || null;
  const isOpaqueBox = (e) => (
    ((e.type === 'rectangle' || e.type === 'ellipse' || e.type === 'diamond') && e.backgroundColor && e.backgroundColor !== 'transparent') ||
    e.type === 'image'
  );
  const area = (e) => Math.max(0, e.width) * Math.max(0, e.height);
  const overlap = (a, b) => {
    const ix = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
    const iy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
    return ix * iy;
  };
  const boxes = elements.filter(isOpaqueBox);
  const hits = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (grp(a) && grp(a) === grp(b)) continue;         // same composite ⇒ intentional
      const ov = overlap(a, b); if (ov <= 0) continue;
      const minA = Math.min(area(a), area(b)), maxA = Math.max(area(a), area(b));
      const cover = ov / Math.max(1, minA);              // fraction of the SMALLER box that is covered
      const sizeRatio = minA / Math.max(1, maxA);        // ~1 = comparable boxes, ~0 = tiny-in-huge
      if (cover > 0.85 && sizeRatio < 0.5) continue;      // small box nested in a big container ⇒ intentional
      if (cover > 0.12) hits.push({ a, b, frac: cover });  // sibling boxes covering >12% of the smaller ⇒ collision
    }
  }
  if (hits.length) {
    const sample = hits.slice(0, 5).map((h) => `  ${label(h.a)} ↔ ${label(h.b)} (${Math.round(h.frac * 100)}%)`).join('\n');
    try {
      console.warn(`[excalidraw] ${hits.length} overlap(s) detected — boards read cleaner when boxes don't stack.\n${sample}${hits.length > 5 ? '\n  …' : ''}\n  Fix: lay out with stack()/row() (flow layout) or move the boxes apart.`);
    } catch (e) {}
  }
  return hits.length;
}

// A text element buried under a foreign opaque box. The box-vs-box audit above cannot see this: a
// section title swallowed by a card is text-vs-box, and it ships looking like `overlaps: 0`.
//
// Z-ORDER is the discriminator, and it is what keeps this check honest. Excalidraw paints in array
// order, so a box only BURIES text that was pushed BEFORE it. Text pushed after a box is drawn on top
// — that's just a label on a shape (the `hello.spec.json` pattern), which is fine and must not warn.
// Text inside its OWN composite (same group) never flags either.
function auditTextCollisions(elements) {
  const zOf = new Map();
  elements.forEach((e, i) => zOf.set(e, i));
  const isOpaqueBox = (e) => (
    ((e.type === 'rectangle' || e.type === 'ellipse' || e.type === 'diamond') && e.backgroundColor && e.backgroundColor !== 'transparent') ||
    e.type === 'image'
  );
  const grp = (e) => (e.groupIds && e.groupIds[0]) || null;
  const texts = elements.filter((e) => e.type === 'text' && e.width > 0 && e.height > 0);
  const boxes = elements.filter(isOpaqueBox);
  const hits = [];
  for (const t of texts) {
    // Check EACH LINE, not the element as a whole: a 2-line title with its second line swallowed only
    // scores ~18% element-wide and would slip through, yet that line is just as unreadable. A line is
    // also only as wide as its glyphs — measuring the full `width` box would over-report centered text.
    const lines = String(t.text).split('\n');
    const lh = (t.fontSize || 20) * (t.lineHeight || 1.25);
    let worst = null;
    for (let i = 0; i < lines.length; i++) {
      const lw = measureText(lines[i], t.fontSize || 20, t.fontFamily);
      if (lw <= 0) continue;
      const align = t.textAlign || 'left';
      const lx = align === 'center' ? t.x + (t.width - lw) / 2 : align === 'right' ? t.x + t.width - lw : t.x;
      const ly = t.y + i * lh;
      const lArea = Math.max(1, lw * lh);
      for (const b of boxes) {
        if (grp(t) && grp(t) === grp(b)) continue;        // its own composite's chrome
        if (zOf.get(b) < zOf.get(t)) continue;            // box painted first ⇒ text sits ON it (a label)
        const ix = Math.max(0, Math.min(lx + lw, b.x + b.width) - Math.max(lx, b.x));
        const iy = Math.max(0, Math.min(ly + lh, b.y + b.height) - Math.max(ly, b.y));
        const frac = (ix * iy) / lArea;
        if (frac > 0.3 && (!worst || frac > worst.frac)) worst = { t, b, frac, line: lines[i] };
      }
      // Text-on-text. Two texts have no reason to share pixels — this is always a defect, and z-order
      // can't save it (both are painted, so they just tangle). A wrapped title landing on the subtitle
      // beneath it is the classic case, and neither the box audit nor the measure audit can see it.
      for (const u of texts) {
        if (u === t) continue;
        if (grp(t) && grp(t) === grp(u)) continue;
        if (zOf.get(u) < zOf.get(t)) continue;            // report the pair once, from the lower element
        const ulines = String(u.text).split('\n');
        const ulh = (u.fontSize || 20) * (u.lineHeight || 1.25);
        for (let k = 0; k < ulines.length; k++) {
          const uw = measureText(ulines[k], u.fontSize || 20, u.fontFamily);
          if (uw <= 0) continue;
          const ua = u.textAlign || 'left';
          const ux = ua === 'center' ? u.x + (u.width - uw) / 2 : ua === 'right' ? u.x + u.width - uw : u.x;
          const uy = u.y + k * ulh;
          const ix = Math.max(0, Math.min(lx + lw, ux + uw) - Math.max(lx, ux));
          const iy = Math.max(0, Math.min(ly + lh, uy + ulh) - Math.max(ly, uy));
          const frac = (ix * iy) / lArea;
          if (frac > 0.3 && (!worst || frac > worst.frac)) worst = { t, b: u, frac, line: lines[i], vsText: true };
        }
      }
    }
    if (worst) hits.push(worst);
  }
  if (hits.length) {
    const sample = hits.slice(0, 5).map((h) => {
      const onto = h.vsText ? `text ${JSON.stringify(String(h.b.text).split('\n')[0].slice(0, 22))}` : `${h.b.type}@(${Math.round(h.b.x)},${Math.round(h.b.y)})`;
      return `  ${JSON.stringify(String(h.line).slice(0, 30))} collides with ${onto} (${Math.round(h.frac * 100)}%)`;
    }).join('\n');
    try {
      console.warn(`[excalidraw] ${hits.length} text element(s) collide — the label is unreadable.\n${sample}${hits.length > 5 ? '\n  …' : ''}\n  Fix: flow the region with stack()/row(); a wrapped title landing on the text below is the usual cause.`);
    } catch (e) {}
  }
  return hits.length;
}

// Body copy that runs past the reading measure. This is the skill's headline rule and it was, until
// now, unenforced — a board could ship 1400px lines reporting a clean audit. Display type (>= 28px)
// is scanned, not read, so it is exempt; a 10% tolerance keeps borderline headings quiet.
// The measure is a count of CHARACTERS (typography puts the comfortable ceiling around 70), not a
// count of pixels — so the cap has to scale with the font size and the font's own advance. A flat
// pixel cap flagged a 22px lead sentence that was only 62 characters long, while letting a 12px block
// run to 90 characters unchallenged. `spec.measure` still pins a hard pixel cap when a board wants one.
const MEASURE_CHARS = 78; // classic ceiling is ~75; the extra few keep borderline lines quiet
const REF = 'abcdefghijklmnopqrstuvwxyz ';
function auditMeasure(elements, limit) {
  const capFor = (e) => (limit != null
    ? limit * 1.1
    : (STYLE.measureText(REF, e.fontSize || 20, e.fontFamily) / REF.length) * MEASURE_CHARS);
  const hits = [];
  for (const e of elements) {
    if (e.type !== 'text' || !e.text || e.fontSize >= 28) continue;
    const cap = capFor(e);
    let longest = 0;
    for (const line of String(e.text).split('\n')) longest = Math.max(longest, STYLE.measureText(line, e.fontSize, e.fontFamily));
    if (longest > cap) hits.push({ e, longest, cap });
  }
  if (hits.length) {
    hits.sort((a, b) => b.longest / b.cap - a.longest / a.cap);
    const cap = Math.round(hits[0].cap);
    const sample = hits.slice(0, 5).map((h) => `  ${Math.round(h.longest)}px / cap ${Math.round(h.cap)}px  ${JSON.stringify(String(h.e.text).split('\n')[0].slice(0, 36))}`).join('\n');
    try {
      console.warn(`[excalidraw] ${hits.length} text block(s) exceed the reading measure (${Math.round(cap)}px) — long lines are the #1 readability killer.\n${sample}${hits.length > 5 ? '\n  …' : ''}\n  Fix: use prose()/bullets()/callout() (they cap at READ_W), or set an explicit \`width\` on the text element.`);
    } catch (e) {}
  }
  return hits.length;
}

// A block of body copy long enough that nobody will read it. The measure audit above only asks
// whether a line is too WIDE; this one asks whether the block is too MUCH — which is the defect that
// actually shipped: nine tight lines of unbroken prose inside a callout, every line legally short.
// A board is a picture with labels. If a point needs more than a few lines, it needs to become
// structure: a lead sentence, bullets, a chart, or its own band.
const MAX_BLOCK_LINES = 5;
const MAX_BLOCK_WORDS = 45;
function auditBlockLength(elements) {
  const hits = [];
  for (const e of elements) {
    if (e.type !== 'text' || !e.text || e.fontSize >= 28) continue;
    const lc = String(e.text).split('\n').length;
    const words = String(e.text).trim().split(/\s+/).filter(Boolean).length;
    if (lc > MAX_BLOCK_LINES || words > MAX_BLOCK_WORDS) hits.push({ e, lc, words });
  }
  if (hits.length) {
    hits.sort((a, b) => b.words - a.words);
    const sample = hits.slice(0, 5).map((h) => `  ${h.lc} lines / ${h.words} words  ${JSON.stringify(String(h.e.text).split('\n')[0].slice(0, 36))}`).join('\n');
    try {
      console.warn(`[excalidraw] ${hits.length} wall(s) of text — a block past ${MAX_BLOCK_LINES} lines or ${MAX_BLOCK_WORDS} words gets skimmed, not read.\n${sample}${hits.length > 5 ? '\n  …' : ''}\n  Fix: lead with the conclusion (takeaway()/callout lead), move the evidence into bullets/items, and mark the number that carries the point with ==…==.`);
    } catch (e) {}
  }
  return hits.length;
}

// ---------- main build ----------
function buildExcalidraw(spec) {
  const outPath = spec.out;
  if (!outPath) throw new Error('spec.out (output .excalidraw.md path) is required');
  // Expand composite types (charts, house-style widgets, stack/row) down to primitives first, so the
  // rest of the build only ever sees text/image/rectangle/line/… — one code path for JSON and JS.
  spec = Object.assign({}, spec, { elements: expandElements(spec.elements) });
  const boardDir = path.dirname(path.resolve(outPath));
  const vaultRoot = spec.vaultRoot || findVaultRoot(boardDir) || boardDir;
  const attachDir = spec.attachDir || 'Attachments';
  const wikilinkMode = spec.wikilinkMode || 'basename';
  const background = spec.background || '#ffffff';

  // Pre-flight: every referenced image MUST exist on disk before we write the
  // board. A missing asset would otherwise be emitted as a dangling `## Embedded
  // Files` wikilink (`<sha1>: [[missing.png]]`) that can never resolve in any
  // renderer — the board ships with blank images. Collect ALL missing paths and
  // fail once with the full list (and the board path), so the author fixes every
  // gap in a single pass instead of discovering them one throw at a time.
  const missingImages = [];
  for (const e of (spec.elements || [])) {
    if (e && e.type === 'image' && e.path) {
      // A missing file OR a non-file (directory / broken symlink) is unusable —
      // statSync throws for a broken link / absent path, so default to missing.
      let isFile = false;
      try { isFile = fs.statSync(path.resolve(e.path)).isFile(); } catch { isFile = false; }
      if (!isFile) missingImages.push(e.path);
    }
  }
  if (missingImages.length) {
    throw new Error(
      `build_excalidraw: ${missingImages.length} referenced image(s) missing or not a file — ` +
      `refusing to write a board with dangling embeds:\n  ` +
      missingImages.join('\n  ') +
      `\n(board: ${outPath})`,
    );
  }

  const rng = mulberry32(strHash(path.resolve(outPath)));
  const elements = [];
  const textEntries = [];          // {text, id}
  const embedded = new Map();       // sha1 -> linkName
  const usedNames = new Map();       // linkName -> sha1 (collision guard)

  function placeImage(srcPath) {
    const abs = path.resolve(srcPath);
    if (!fs.existsSync(abs)) throw new Error('image not found: ' + abs);
    const bytes = fs.readFileSync(abs);
    const sha = crypto.createHash('sha1').update(bytes).digest('hex');
    const dims = imageSize(abs);
    if (embedded.has(sha)) return { sha, dims, link: embedded.get(sha) };

    // ensure the image is inside the vault so the plugin can resolve it
    let insideVault = abs.startsWith(path.resolve(vaultRoot) + path.sep);
    let finalAbs = abs;
    if (!insideVault) {
      const destDir = path.join(boardDir, attachDir);
      fs.mkdirSync(destDir, { recursive: true });
      finalAbs = path.join(destDir, path.basename(abs));
      fs.copyFileSync(abs, finalAbs);
    }
    let link;
    if (wikilinkMode === 'path') {
      link = path.relative(vaultRoot, finalAbs).split(path.sep).join('/');
    } else {
      link = path.basename(finalAbs);
      // disambiguate same-basename/different-content within this board
      if (usedNames.has(link) && usedNames.get(link) !== sha) {
        const ext = path.extname(link); const stem = link.slice(0, -ext.length || undefined);
        link = `${stem}-${sha.slice(0, 6)}${ext}`;
      }
    }
    usedNames.set(link, sha);
    embedded.set(sha, link);
    return { sha, dims, link };
  }

  for (const e of (spec.elements || [])) {
    const type = e.type;
    if (type === 'text') {
      const fontSize = e.fontSize || 20;
      // `font:` accepts the aliases ('sans' | 'hand' | 'code'); `fontFamily:` still takes a raw
      // Excalidraw id. Unset ⇒ the readable sans, not the hand-drawn face.
      const fontFamily = e.fontFamily != null ? e.fontFamily : TYPO.fontId(e.font);
      // Leading. Body copy needs ~1.6; a label inside a shape wants the 1.25 Excalidraw default. The
      // SAME value has to reach both the height math and the element, or the lines land outside the
      // box the layout reserved for them.
      const lineHeight = e.lineHeight || TYPO.LH.tight;
      const { width, height, text: baked } = sizeText(e.text, fontSize, e.width, lineHeight, fontFamily);
      const el = baseEl(rng, 'text', e.x || 0, e.y || 0, width, height, {
        strokeColor: e.color || '#1e1e1e',
        text: baked,
        rawText: baked,
        originalText: baked,
        fontSize,
        fontFamily,
        textAlign: e.align || 'left',
        verticalAlign: e.verticalAlign || 'top',
        containerId: null,
        lineHeight,
        // width given ⇒ wrap to it (autoResize off); width omitted ⇒ size to content (single line)
        autoResize: e.width == null,
        backgroundColor: 'transparent',
      });
      elements.push(withRoughness(e, el));
      textEntries.push({ text: el.text, id: el.id });
    } else if (type === 'image') {
      const { sha, dims, link } = placeImage(e.path);
      let w = e.width, h = e.height;
      if (w && !h) h = Math.round(w * dims.height / dims.width);
      else if (h && !w) w = Math.round(h * dims.width / dims.height);
      else if (!w && !h) { w = dims.width; h = dims.height; }
      const el = baseEl(rng, 'image', e.x || 0, e.y || 0, w, h, {
        strokeColor: 'transparent',
        fileId: sha,
        scale: [1, 1],
        status: 'pending',
        crop: null,
      });
      elements.push(withRoughness(e, el));
    } else if (type === 'rectangle' || type === 'ellipse' || type === 'diamond') {
      const el = baseEl(rng, type, e.x || 0, e.y || 0, e.width || 100, e.height || 100, {
        strokeColor: e.strokeColor || '#1e1e1e',
        backgroundColor: e.backgroundColor || 'transparent',
        fillStyle: e.fillStyle || 'solid',
        strokeWidth: e.strokeWidth != null ? e.strokeWidth : 2,
        strokeStyle: e.strokeStyle || 'solid',
        roundness: e.roundness ? { type: 3 } : null,
      });
      elements.push(withRoughness(e, el));
    } else if (type === 'line' || type === 'arrow') {
      const pts = (e.points && e.points.length ? e.points : [[0, 0], [100, 0]]);
      const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]);
      const minX = Math.min(...xs); const minY = Math.min(...ys);
      const norm = pts.map((p) => [p[0] - minX, p[1] - minY]);
      const w = Math.max(...xs) - minX; const h = Math.max(...ys) - minY;
      // A `line` may be a FILLED polygon: pass backgroundColor + fillStyle and close the path
      // (first point repeated as last) and Excalidraw fills it — this is how funnel trapezoids and
      // custom regions are drawn. Arrows never fill. roundness softens polygon corners when asked.
      const el = baseEl(rng, type, (e.x || 0) + minX, (e.y || 0) + minY, w, h, {
        strokeColor: e.strokeColor || '#1e1e1e',
        backgroundColor: type === 'line' ? (e.backgroundColor || 'transparent') : 'transparent',
        fillStyle: e.fillStyle || 'solid',
        strokeWidth: e.strokeWidth != null ? e.strokeWidth : 2,
        strokeStyle: e.strokeStyle || 'solid',
        roundness: e.roundness ? { type: 2 } : null,
        points: norm,
        lastCommittedPoint: null,
        startBinding: null,
        endBinding: null,
        startArrowhead: e.startArrow || null,
        endArrowhead: type === 'arrow' ? (e.endArrow || 'arrow') : (e.endArrow || null),
      });
      elements.push(withRoughness(e, el));
    } else if (type === 'frame') {
      const el = baseEl(rng, 'frame', e.x || 0, e.y || 0, e.width || 600, e.height || 400, {
        strokeColor: '#bbb', backgroundColor: 'transparent', name: e.name || 'Frame', roundness: null,
      });
      elements.push(withRoughness(e, el));
    } else {
      throw new Error('unknown element type: ' + type);
    }
  }

  // group support: specs sharing a `group` key move together in Excalidraw
  const groupMap = new Map();
  const gidFor = (key) => { if (!groupMap.has(key)) groupMap.set(key, idFrom(rng) + idFrom(rng)); return groupMap.get(key); };
  (spec.elements || []).forEach((e, i) => { if (e.group != null && elements[i]) elements[i].groupIds = [gidFor(String(e.group))]; });

  // assign canonical fractional indices in array order (z-order)
  const keys = generateNKeysBetween(null, null, elements.length);
  elements.forEach((el, i) => { el.index = keys[i]; });

  // Catch the four ways a board ships broken (opt out with spec.audit === false):
  //   overlaps       — two opaque boxes stacked
  //   buriedText     — a label swallowed by a foreign box (box-vs-box audit is blind to this)
  //   longLines      — body copy past the reading measure (too WIDE)
  //   wallOfText     — a block of copy too LONG to be read at all
  const doAudit = spec.audit !== false;
  const overlaps = doAudit ? auditOverlaps(elements) : 0;
  const buriedText = doAudit ? auditTextCollisions(elements) : 0;
  const longLines = doAudit ? auditMeasure(elements, spec.measure) : 0;
  const wallOfText = doAudit ? auditBlockLength(elements) : 0;

  const scene = {
    type: 'excalidraw',
    version: 2,
    source: 'https://github.com/zsviczian/obsidian-excalidraw-plugin',
    elements,
    appState: { gridSize: null, gridStep: 5, gridModeEnabled: false, viewBackgroundColor: background },
    files: {},
  };

  // ---------- assemble markdown ----------
  const L = [];
  // Frontmatter. dreamcontext REQUIRES `name` + `description` to index/recall a board — memory reads
  // frontmatter + `## Text Elements`, never the scene JSON — so emit them when given rather than
  // making every generator hand-patch the file afterwards.
  L.push('---', '');
  if (spec.name) L.push(`name: ${yamlScalar(spec.name)}`);
  if (spec.description) L.push(...yamlFolded('description', spec.description));
  const tags = spec.tags && spec.tags.length ? spec.tags : ['excalidraw'];
  L.push(`tags: [${tags.join(', ')}]`);
  for (const [k, v] of Object.entries(spec.frontmatter || {})) L.push(`${k}: ${yamlScalar(v)}`);
  L.push('excalidraw-plugin: parsed', '', '---');
  L.push("==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠== You can decompress Drawing data with the command palette: 'Decompress current Excalidraw file'. For more info check in plugin settings under 'Saving'");
  L.push('', '', '# Excalidraw Data', '');
  L.push('## Text Elements');
  for (const t of textEntries) L.push(`${t.text} ^${t.id}`, '');
  L.push('## Embedded Files');
  for (const [sha, link] of embedded) L.push(`${sha}: [[${link}]]`, '');
  L.push('%%');
  L.push('## Drawing');
  L.push('```json');
  L.push(JSON.stringify(scene, null, '\t'));
  L.push('```');
  L.push('%%');
  const md = L.join('\n') + '\n';

  fs.mkdirSync(boardDir, { recursive: true });
  fs.writeFileSync(outPath, md, 'utf8');

  return { outPath, elements: elements.length, images: embedded.size, texts: textEntries.length, overlaps, buriedText, longLines, wallOfText, vaultRoot };
}

// ---------- layout helpers (JS API) ----------
// Real on-board thumbnail height from the image file, so captions hug the image and rows never
// gap (short image) or overlap (tall image). Falls back to a 1.6 aspect if the file is unreadable.
function thumbHeight(p, thumbW) {
  try { const d = imageSize(p); if (d && d.width) return Math.max(1, Math.round(thumbW * d.height / d.width)); } catch (e) {}
  return Math.round(thumbW * 1.6);
}

// A horizontal lane: optional title, then a row of images left->right with each caption hugging
// its own image's bottom (wraps to thumbW). Returns ElementSpec[] (spread with ...) and also carries
// `.width` / `.height` / `.nextY` so lanes/sections stack cleanly without manual height math.
function lane(opts) {
  const { title, images = [], x = 0, y = 0, thumbW = 220, gap = 40, captionSize = 14, captionGap = 8,
    titleSize = 28, titleColor = '#1e1e1e', captionColor = '#555', laneGap = 48 } = opts;
  const els = [];
  let cy = y, titleH = 0;
  if (title) {
    els.push({ type: 'text', x, y: cy, text: title, fontSize: titleSize, color: titleColor, width: Math.max(300, String(title).length * titleSize * 0.6) });
    titleH = titleSize * 1.4 + 12; cy += titleH;
  }
  let cx = x, maxH = 0, capMax = 0;
  for (const im of images) {
    const h = thumbHeight(im.path, thumbW);
    els.push({ type: 'image', x: cx, y: cy, path: im.path, width: thumbW, height: h });
    if (im.caption) {
      els.push({ type: 'text', x: cx, y: cy + h + captionGap, text: im.caption, fontSize: captionSize, color: captionColor, width: thumbW });
      capMax = Math.max(capMax, captionGap + sizeText(im.caption, captionSize, thumbW).height);
    }
    maxH = Math.max(maxH, h);
    cx += thumbW + gap;
  }
  els.width = images.length ? images.length * thumbW + (images.length - 1) * gap : 0;
  els.height = titleH + maxH + capMax;
  els.nextY = y + els.height + laneGap;
  return els;
}

// A wrapping grid of images. Each row sizes to its tallest image and every caption hugs its own
// image's bottom — no fixed-aspect rowH guess, so no gaps under short shots or overlaps under tall
// ones. Returns ElementSpec[] carrying `.height` / `.nextY` for stacking below the grid.
function grid(opts) {
  const { images = [], x = 0, y = 0, cols = 6, thumbW = 220, gapX = 36, gapY = 60,
    captionSize = 14, captionGap = 8, captionColor = '#555' } = opts;
  const els = [];
  let rowTop = y;
  for (let r = 0; r * cols < images.length; r++) {
    const row = images.slice(r * cols, r * cols + cols);
    const hs = row.map((im) => thumbHeight(im.path, thumbW));
    const maxH = Math.max(...hs);
    let capMax = 0;
    row.forEach((im, ci) => {
      const cx = x + ci * (thumbW + gapX);
      const h = hs[ci];
      els.push({ type: 'image', x: cx, y: rowTop, path: im.path, width: thumbW, height: h });
      if (im.caption) {
        els.push({ type: 'text', x: cx, y: rowTop + h + captionGap, text: im.caption, fontSize: captionSize, color: captionColor, width: thumbW });
        capMax = Math.max(capMax, captionGap + sizeText(im.caption, captionSize, thumbW).height);
      }
    });
    rowTop += maxH + capMax + gapY;
  }
  els.height = rowTop - y;
  els.nextY = rowTop;
  return els;
}

module.exports = { buildExcalidraw, lane, grid, thumbHeight };

// ---------- CLI ----------
if (require.main === module) {
  const args = process.argv.slice(2);
  let specPath = null, out = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') out = args[++i];
    else specPath = args[i];
  }
  if (!specPath) { console.error('usage: node build_excalidraw.js <spec.json> [--out <path.excalidraw.md>]'); process.exit(1); }
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  if (out) spec.out = out;
  const res = buildExcalidraw(spec);
  console.log(`OK  ${res.outPath}\n    elements=${res.elements} images=${res.images} texts=${res.texts} overlaps=${res.overlaps} buriedText=${res.buriedText} longLines=${res.longLines} wallOfText=${res.wallOfText}\n    vaultRoot=${res.vaultRoot}`);
}
