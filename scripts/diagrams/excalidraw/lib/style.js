// House style learned from the vault's presentation boards (MemoryOS High Level, Personalization
// Module, Research): solid fills, always-rounded rects, 2px #1e1e1e ink, Excalidraw's native pastel
// swatches used semantically. These helpers return ElementSpec[] for build_excalidraw.js's
// buildExcalidraw({ elements }).
//
// Four rules keep boards clean and readable — the reason this file exists:
//   1. READABLE MEASURE   — body text wraps to a bounded reading width (READ_W), never the whole
//                           board. sectionTitle/bullets/annotate/prose all cap + wrap. Long text is
//                           unreadable when it runs edge-to-edge; keep the measure ~60 chars.
//   2. READABLE TYPE      — anything meant to be READ is set in the UI sans (Nunito) at >= 16px on a
//                           1.6 line height; hand-drawn (Excalifont) is opt-in via `font:'hand'` and
//                           belongs on labels and sketch annotations, not on paragraphs. See
//                           typography.js for why, and for the measured advance tables.
//   3. NO OVERLAP         — lay boards out with stack()/row() (flow layout: each element is placed
//                           after the previous one's measured height/width, so boxes can't collide).
//                           build_excalidraw also AUDITS the finished scene and warns on overlaps.
//   4. VISUAL-FIRST       — Excalidraw's strength is pictures, not walls of text. Prefer the visual
//                           kit (funnel, windowFrame, button, input, textRows, imagePlaceholder,
//                           navbar, avatar, chip) over paragraphs. Use textRows() as body-copy filler
//                           in wireframes instead of real sentences.

const TYPO = require('./typography.js');
const {
  FONT, fontId, LH_ROLE, textH, EMPHASIS,
  measureText, widestLine, wrapLines, wrapToWidth, textBlock, parseMarkup, hasMarkup, isWideGlyph, glyphW,
} = Object.assign({}, TYPO, { LH_ROLE: TYPO.LH });

const INK = '#1e1e1e';
const MUTED = '#495057';   // secondary copy: captions, side notes, axis labels

// Comfortable reading measures (px). READ_W ≈ 62 Nunito chars at 17px — the width past which a line
// of text gets hard to scan. NOTE_W is for terse side-annotations. Never let prose exceed READ_W.
const READ_W = 620;
const NOTE_W = 260;

// Body type. 15px handwriting on 1.25 leading was the readability bug this kit was built to stop
// repeating: the size, the face and the leading were all working against the reader at once.
const BODY_SIZE = 17;
const BODY_LH = LH_ROLE.body;

// semantic palette: { fill, stroke } — matches the vault's swatches and their meaning
const PALETTE = {
  green:      { fill: '#b2f2bb', stroke: '#2f9e44' }, // benefit / positive / go
  paleGreen:  { fill: '#ebfbee', stroke: '#2f9e44' },
  red:        { fill: '#ffc9c9', stroke: '#e03131' }, // problem / pain / risk
  blue:       { fill: '#a5d8ff', stroke: '#1971c2' }, // system / neutral / flow node
  paleBlue:   { fill: '#e7f5ff', stroke: '#1971c2' },
  purple:     { fill: '#d0bfff', stroke: '#6741d9' }, // core service / special
  palePurple: { fill: '#f3f0ff', stroke: '#6741d9' },
  yellow:     { fill: '#ffec99', stroke: '#f08c00' }, // processing / attention
  mint:       { fill: '#96f2d7', stroke: '#0c8599' }, // result / output
  gray:       { fill: '#e9ecef', stroke: '#868e96' }, // muted / inactive
};
function pal(c) { return PALETTE[c] || { fill: c, stroke: INK }; }

// neutral tones for wireframes / prototypes — grayscale chrome so the accent colors carry meaning
const WIRE = {
  paper:  '#ffffff',
  panel:  '#f8f9fa',
  chrome: '#f1f3f5',
  fill:   '#f1f3f5',
  line:   '#dee2e6',
  edge:   '#ced4da',
  hint:   '#adb5bd',
  text:   '#868e96',
  strong: '#495057',
};

let _gc = 0;
const newGroup = (hint) => `g${++_gc}-${hint || ''}`;
const lines = (t) => String(t).split('\n').length;
// Leading used when a height is derived from a line count. LH is the LABEL default (single-ish lines
// inside a shape); paragraphs use BODY_LH. Whatever a builder picks it must put the SAME value on the
// element as `lineHeight`, or Excalidraw draws lines outside the space the layout reserved.
const LH = LH_ROLE.tight;

// --- text fitting --------------------------------------------------------
// measureText / wrapToWidth / wrapLines now live in typography.js, backed by advance tables MEASURED
// from the real font files (see scripts/diagrams/calibrate-excalidraw-fonts.mjs). They take an
// optional font argument and default to the body sans.

const _warned = new Set();
function warnFit(msg) { if (!_warned.has(msg)) { _warned.add(msg); try { console.warn('[excalidraw] ' + msg); } catch (e) {} } }

// Wrap `text` to the card's inner width, then shrink the font (down to minFont) until the wrapped
// label also fits the card height. Returns { text (with baked-in newlines), fontSize, lineCount, fits }.
function fitText(o) {
  const { text = '', w = 260, h = 92, fontSize = 20, minFont = 9, lineHeight = LH, padX = 10, padY = 8 } = o;
  const innerW = Math.max(1, w - 2 * padX);
  const innerH = Math.max(1, h - 2 * padY);
  let fs = Math.max(minFont, Math.round(fontSize));
  let wrapped = wrapToWidth(text, fs, innerW);
  let lineCount = wrapped.split('\n').length;
  while (fs > minFont && lineCount * fs * lineHeight > innerH) {
    fs -= 1;
    wrapped = wrapToWidth(text, fs, innerW);
    lineCount = wrapped.split('\n').length;
  }
  return { text: wrapped, fontSize: fs, lineCount, fits: lineCount * fs * lineHeight <= innerH };
}

// Arc-length midpoint of a polyline — keeps a connector label on the line even when it elbows.
// Also reports whether the segment the midpoint lands on runs VERTICALLY, so the label can be placed
// beside a vertical run instead of being struck through by it.
function polyMid(pts) {
  if (!pts || pts.length < 2) return { x: (pts && pts[0] && pts[0][0]) || 0, y: (pts && pts[0] && pts[0][1]) || 0, vertical: false };
  const seg = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); seg.push(l); total += l; }
  let half = total / 2;
  for (let i = 1; i < pts.length; i++) {
    if (half <= seg[i - 1] || i === pts.length - 1) {
      const t = seg[i - 1] ? half / seg[i - 1] : 0;
      const dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1];
      return { x: pts[i - 1][0] + dx * t, y: pts[i - 1][1] + dy * t, vertical: Math.abs(dy) > Math.abs(dx) };
    }
    half -= seg[i - 1];
  }
  return { x: pts[0][0], y: pts[0][1], vertical: false };
}

// --- measurement + auto-layout ------------------------------------------
// Every builder below returns an ElementSpec[] that ALSO carries `.x/.y/.w/.h/.nextX/.nextY` so you
// can flow-lay-out boards without doing coordinate math by hand (the #1 source of overlap). `box()`
// stamps those; `bbox()` recovers them for a plain array; `stack()`/`row()` place a list with gaps.
function box(els, x, y, w, h) {
  els.x = x; els.y = y; els.w = w; els.h = h; els.nextX = x + w; els.nextY = y + h;
  return els;
}
// Tag every element of a composite (that doesn't already belong to a nested group) with ONE group id,
// so the widget moves as a unit in Excalidraw and the build-time overlap auditor treats its own chrome
// as intentional. Returns the same array (carried metadata intact).
function G(els, hint) {
  const g = newGroup(hint);
  for (const e of els) { if (e.group == null) e.group = g; }
  return els;
}
// Pixel bounding box of a spec array (pre-build form). Handles point-based (line/arrow) + boxed els.
function bbox(els) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const e of els) {
    let x0, y0, x1, y1;
    if (e.points && e.points.length) {
      const xs = e.points.map((p) => p[0]); const ys = e.points.map((p) => p[1]);
      x0 = (e.x || 0) + Math.min(...xs); y0 = (e.y || 0) + Math.min(...ys);
      x1 = (e.x || 0) + Math.max(...xs); y1 = (e.y || 0) + Math.max(...ys);
    } else {
      x0 = e.x || 0; y0 = e.y || 0;
      const w = e.width != null ? e.width : (e.text ? measureText(String(e.text).split('\n')[0], e.fontSize || 20) : 0);
      const h = e.height != null ? e.height : (e.text ? lines(e.text) * (e.fontSize || 20) * LH : 0);
      x1 = x0 + w; y1 = y0 + h;
    }
    if (x0 < minX) minX = x0; if (y0 < minY) minY = y0;
    if (x1 > maxX) maxX = x1; if (y1 > maxY) maxY = y1;
  }
  if (!isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
const measH = (els) => (els && els.h != null) ? els.h : bbox(els).h;
const measW = (els) => (els && els.w != null) ? els.w : bbox(els).w;

// Move a spec array by (dx,dy). x/y is the offset for BOTH boxed and point-based elements, so this
// works uniformly. Preserves carried metadata.
function translate(els, dx, dy) {
  const moved = els.map((e) => Object.assign({}, e, { x: (e.x || 0) + dx, y: (e.y || 0) + dy }));
  if (els.w != null) box(moved, (els.x || 0) + dx, (els.y || 0) + dy, els.w, els.h);
  return moved;
}

// Flow a list of blocks TOP-TO-BOTTOM with a fixed gap — the height of each block is measured, so the
// next one is placed right below it and nothing ever overlaps. Each item is either a factory
// `(x, y) => els` (preferred: it draws itself at the running cursor) or an already-built `els` array
// (it gets shifted down to the cursor). Returns the merged array carrying `.w/.h/.nextY`.
function stack(o) {
  const { x = 0, y = 0, gap = 24, items = [], align = 'left', width = null } = o;
  const out = []; let cy = y, maxW = 0;
  for (const it of items) {
    if (it == null) continue;
    let els = (typeof it === 'function') ? it(x, cy) : it;
    if (typeof it !== 'function') { const b = bbox(els); els = translate(els, x - b.x, cy - b.y); }
    const w = measW(els), h = measH(els);
    if (align === 'center' && width != null) els = translate(els, (width - w) / 2, 0);
    else if (align === 'right' && width != null) els = translate(els, (width - w), 0);
    out.push(...els);
    maxW = Math.max(maxW, w);
    cy += h + gap;
  }
  return box(out, x, y, width || maxW, Math.max(0, cy - gap - y));
}
// Flow a list of blocks LEFT-TO-RIGHT with a fixed gap (same contract as stack, horizontal).
function row(o) {
  const { x = 0, y = 0, gap = 24, items = [], valign = 'top' } = o;
  const out = []; let cx = x, maxH = 0;
  const built = items.filter(Boolean).map((it) => (typeof it === 'function') ? it : it);
  // first measure heights so valign can center within the tallest block
  const measured = built.map((it) => (typeof it === 'function') ? it(0, 0) : it);
  maxH = measured.reduce((m, els) => Math.max(m, measH(els)), 0);
  built.forEach((it, i) => {
    const probe = measured[i];
    const w = measW(probe), h = measH(probe);
    const dy = valign === 'middle' ? (maxH - h) / 2 : valign === 'bottom' ? (maxH - h) : 0;
    let els = (typeof it === 'function') ? it(cx, y + dy) : translate(it, cx - bbox(it).x, y + dy - bbox(it).y);
    out.push(...els);
    cx += w + gap;
  });
  return box(out, x, y, Math.max(0, cx - gap - x), maxH);
}

// --- readable text primitives -------------------------------------------
// All of these go through typography.textBlock(): bounded measure, real leading, and INLINE EMPHASIS
// (`**strong**` underlines, `==mark==` highlights, `` `code` `` chips) painted as geometry behind a
// single clean text element — so the words stay one paragraph in `## Text Elements`.

// A bounded, wrapped paragraph. Text NEVER exceeds `width` (default the reading measure) — this is
// the antidote to edge-to-edge text. Height is derived from the wrapped line count. Visual-first
// boards use this sparingly; prefer pictures, and keep a paragraph under ~4 lines.
function prose(o) {
  const {
    x = 0, y = 0, text = '', fontSize = BODY_SIZE, width = READ_W, color = INK,
    align = 'left', font = 'sans', lh = BODY_LH, markup = true,
  } = o;
  const b = textBlock({ x, y, text, width, fontSize, color, align, font, lh, markup });
  return box(b.els, x, y, b.w, b.h);
}

// big plain section header (no box), like "Configuration" / "Flow". Long titles WRAP to `maxWidth`
// instead of running off the board. Display type gets tighter leading than body copy.
function sectionTitle(o) {
  const {
    x = 0, y = 0, text, fontSize = 40, color = INK, maxWidth = 1000, align = 'left',
    font = 'sans', lh = LH_ROLE.title, markup = true,
  } = o;
  const b = textBlock({ x, y, text, width: maxWidth, fontSize, color, align, font, lh, markup });
  return box(b.els, x, y, b.w, b.h);
}

// The "in a nutshell" line: the ONE sentence a reader should leave with, set larger than body copy
// with an accent rule down its left edge. Put it at the top of a board or a section, before any
// supporting detail. Emphasis markup works here too — mark the number that carries the point.
function takeaway(o) {
  const {
    x = 0, y = 0, text = '', fontSize = 22, width = READ_W, color = INK, accent = 'blue',
    label = null, font = 'sans', lh = 1.45, markup = true,
  } = o;
  const g = o.group || newGroup('takeaway');
  const p = pal(accent);
  const padL = 18;
  const out = [];
  let cy = y;
  if (label) {
    const lb = textBlock({ x: x + padL, y: cy, text: label, width, fontSize: 12, color: p.stroke, font, lh: LH_ROLE.tight, markup: false, group: g });
    out.push(...lb.els);
    cy += lb.h + 4;
  }
  const b = textBlock({ x: x + padL, y: cy, text, width: width - padL, fontSize, color, font, lh, markup, group: g });
  out.push(...b.els);
  const h = (cy - y) + b.h;
  // the rule goes first so the text paints over it if they ever touch
  out.unshift({ type: 'rectangle', x, y, width: 5, height: Math.max(fontSize, h), strokeColor: 'transparent', backgroundColor: p.stroke, fillStyle: 'solid', strokeWidth: 1, roughness: 0, roundness: true, group: g });
  return box(out, x, y, padL + b.w, Math.max(fontSize, h));
}

// Bullet list. Each item is its OWN text element separated by `gap` — that gap is the point: a list
// whose items are only a line-height apart reads as one grey paragraph, not as a list you can scan.
// Items wrap to `width` with a hanging indent under the bullet, and support emphasis markup.
function bullets(o) {
  const {
    x = 0, y = 0, items = [], fontSize = BODY_SIZE, color = INK, bullet = '•  ', width = READ_W,
    gap = 10, font = 'sans', lh = BODY_LH, markup = true,
  } = o;
  const out = [];
  let cy = y;
  let usedW = 0;
  items.forEach((it, i) => {
    const raw = typeof it === 'string' ? it : (it && it.text) || '';
    const c = (typeof it === 'object' && it && it.color) || color;
    const b = textBlock({ x, y: cy, text: raw, width, fontSize, color: c, font, lh, markup, bullet });
    out.push(...b.els);
    usedW = Math.max(usedW, b.w);
    cy += b.h + (i === items.length - 1 ? 0 : gap);
  });
  return box(out, x, y, usedW || width, cy - y);
}

// --- rounded card / flow node -------------------------------------------
// rounded card: filled rect + centered label, grouped so they move together. The label is
// hard-wrapped to the card width and the font auto-shrinks (to `minFont`) until it also fits the
// height, so text can never spill outside the box. Warns if even the floor font won't fit.
function card(o) {
  const { x, y, w = 260, h = 92, text = '', color = 'blue', fontSize = 20, stroke = INK, strokeWidth = 2, textColor = INK, roundness = true, minFont = 9, padX = 10, padY = 8 } = o;
  const group = o.group || newGroup('card');
  const p = pal(color);
  const fit = fitText({ text, w, h, fontSize, minFont, padX, padY });
  if (!fit.fits) warnFit(`label ${JSON.stringify(String(text).slice(0, 32))} won't fit a ${w}×${h} card even at ${minFont}px — enlarge the card or shorten the text.`);
  const textH = fit.lineCount * fit.fontSize * LH;
  const ty = y + Math.max(padY, (h - textH) / 2);
  return box([
    { type: 'rectangle', x, y, width: w, height: h, strokeColor: stroke, backgroundColor: p.fill, fillStyle: 'solid', strokeWidth, roundness, group },
    { type: 'text', x, y: ty, text: fit.text, fontSize: fit.fontSize, color: textColor, width: w, align: 'center', fontFamily: FONT.sans, group },
  ], x, y, w, h);
}
// small node (flow step) — card with tighter defaults
function node(o) { return card(Object.assign({ w: 200, h: 64, fontSize: 18 }, o)); }

// labeled connector arrow between two points (centers of cards, etc.).
// Routing: pass `via:[[x,y],…]` for explicit waypoints, or `elbow:'hv'|'vh'` for an auto right-angle
// bend ('hv' = horizontal then vertical, 'vh' = vertical then horizontal). Use these to route a link
// AROUND intervening boxes instead of cutting a diagonal straight through them.
function connector(o) {
  const { from, to, label, double = false, strokeColor = INK, strokeWidth = 2, dashed = false, labelColor = '#495057', fontSize = 16, via = null, elbow = null, labelSide = 'left' } = o;
  let pts;
  if (via && via.length) pts = [from, ...via, to];
  else if (elbow === 'hv') pts = [from, [to[0], from[1]], to];
  else if (elbow === 'vh') pts = [from, [from[0], to[1]], to];
  else pts = [from, to];
  const out = [{ type: 'arrow', points: pts, strokeColor, strokeWidth, strokeStyle: dashed ? 'dashed' : 'solid', endArrow: 'arrow', startArrow: double ? 'arrow' : null }];
  if (label) {
    const m = polyMid(pts);
    const w = Math.max(40, measureText(String(label), fontSize) + fontSize);
    // On a vertical run the line would strike straight through a centered label, so sit the label
    // beside it (`labelSide`, default left); on a horizontal run keep it centered just above.
    const el = m.vertical
      ? { x: labelSide === 'right' ? m.x + 8 : m.x - w - 8, y: m.y - fontSize * 0.62, align: labelSide === 'right' ? 'left' : 'right' }
      : { x: m.x - w / 2, y: m.y - fontSize - 4, align: 'center' };
    out.push({ type: 'text', x: el.x, y: el.y, text: label, fontSize, color: labelColor, width: w, align: el.align, fontFamily: FONT.sans });
  }
  return out;
}

// side-annotation: short arrow from a node edge to a spec note (the "90sec / deepseek..." pattern).
// The note wraps to NOTE_W so it stays a tidy column, never a runaway line.
function annotate(o) {
  const { from, to, text, fontSize = 16, color = '#495057', width = NOTE_W } = o;
  const wrapped = wrapToWidth(text, fontSize, width);
  return [
    { type: 'arrow', points: [from, to], strokeColor: color, strokeWidth: 1.5, endArrow: 'arrow' },
    { type: 'text', x: to[0] + 6, y: to[1] - fontSize * 0.6, text: wrapped, fontSize, color, width, align: 'left', fontFamily: FONT.sans },
  ];
}

// vertical stack of cards (benefit/risk columns)
function column(o) {
  const { x, y, w = 280, h = 70, gap = 16, fontSize = 18, color = 'green', items = [] } = o;
  const out = [];
  items.forEach((it, i) => {
    const t = typeof it === 'string' ? it : it.text;
    const c = (typeof it === 'object' && it.color) || color;
    out.push(...card({ x, y: y + i * (h + gap), w, h, text: t, color: c, fontSize }));
  });
  return box(out, x, y, w, items.length ? items.length * (h + gap) - gap : 0);
}

// hub-and-spoke: central node + satellites with arrows (the "Personalization Layer" + APIs pattern)
function hub(o) {
  const { cx, cy, label, color = 'purple', rx = 64, ry = 44, radius = 170, spokes = [], spokeColor = 'blue', spokeRx = 30, spokeRy = 30, startAngle = -Math.PI / 2 } = o;
  const out = [];
  const p = pal(color);
  out.push({ type: 'ellipse', x: cx - rx, y: cy - ry, width: rx * 2, height: ry * 2, strokeColor: p.stroke, backgroundColor: p.fill, fillStyle: 'solid', strokeWidth: 2 });
  out.push({ type: 'text', x: cx - rx, y: cy - 10, text: label, fontSize: 16, color: INK, width: rx * 2, align: 'center', fontFamily: FONT.sans });
  const n = spokes.length;
  spokes.forEach((s, i) => {
    const a = startAngle + (i / Math.max(1, n)) * Math.PI * 2;
    const sx = cx + Math.cos(a) * radius, sy = cy + Math.sin(a) * radius;
    const c = (typeof s === 'object' && s.color) || spokeColor;
    const t = typeof s === 'string' ? s : s.label;
    const sp = pal(c);
    out.push({ type: 'arrow', points: [[cx + Math.cos(a) * rx, cy + Math.sin(a) * ry], [sx - Math.cos(a) * spokeRx, sy - Math.sin(a) * spokeRy]], strokeColor: INK, strokeWidth: 2, endArrow: 'arrow' });
    out.push({ type: 'ellipse', x: sx - spokeRx, y: sy - spokeRy, width: spokeRx * 2, height: spokeRy * 2, strokeColor: sp.stroke, backgroundColor: sp.fill, fillStyle: 'solid', strokeWidth: 2 });
    out.push({ type: 'text', x: sx - spokeRx, y: sy - 8, text: t, fontSize: 14, color: INK, width: spokeRx * 2, align: 'center', fontFamily: FONT.sans });
  });
  return out;
}

// --- funnel -------------------------------------------------------------
// A classic marketing/conversion funnel: filled trapezoid bands narrowing top→bottom, one per stage,
// each with a centered (auto-fit) label. Optional per-stage `note` (e.g. a metric / drop-off) is
// placed in a right margin with a short horizontal connector — no diagonal crossings. `stages` is a
// list of { label, note?, color? }. Returns ElementSpec[] carrying `.w/.h/.nextY`.
function funnel(o) {
  const {
    x = 0, y = 0, w = 520, stageH = 84, gap = 8, stages = [],
    topW = null, botW = null, fontSize = 20, labelColor = INK,
    noteColor = WIRE.strong, noteGap = 44, notes: showNotes = true,
  } = o;
  const n = Math.max(1, stages.length);
  const tW = topW != null ? topW : w;
  const bW = botW != null ? botW : Math.max(80, Math.round(w * 0.34));
  const cx = x + w / 2;
  const palette = ['blue', 'purple', 'yellow', 'mint', 'green', 'red'];
  const out = [];
  const hasNotes = showNotes && stages.some((s) => s.note);
  let cy = y;
  stages.forEach((s, i) => {
    const wt = tW + (bW - tW) * (i / n);
    const wb = tW + (bW - tW) * ((i + 1) / n);
    const p = pal(s.color || palette[i % palette.length]);
    // closed, filled trapezoid (sharp corners read as a funnel; roundness blobs it)
    out.push({
      type: 'line',
      points: [[cx - wt / 2, cy], [cx + wt / 2, cy], [cx + wb / 2, cy + stageH], [cx - wb / 2, cy + stageH], [cx - wt / 2, cy]],
      strokeColor: p.stroke, backgroundColor: p.fill, fillStyle: 'solid', strokeWidth: 2,
    });
    // label fit to the narrower (bottom) width so it never spills past the band edges
    const lw = Math.max(60, Math.min(wt, wb) - 24);
    const fit = fitText({ text: s.label, w: lw + 24, h: stageH, fontSize, minFont: 12 });
    const th = fit.lineCount * fit.fontSize * LH;
    out.push({ type: 'text', x: cx - lw / 2, y: cy + (stageH - th) / 2, text: fit.text, fontSize: fit.fontSize, color: labelColor, width: lw, align: 'center', fontFamily: FONT.sans });
    if (hasNotes && s.note) {
      const edgeX = cx + ((wt + wb) / 2) / 2; // right edge at the band's vertical middle
      const midY = cy + stageH / 2;
      const nx = x + w + noteGap;
      out.push({ type: 'arrow', points: [[edgeX, midY], [nx - 6, midY]], strokeColor: noteColor, strokeWidth: 1.5, endArrow: 'arrow' });
      const wrapped = wrapToWidth(s.note, 15, NOTE_W);
      out.push({ type: 'text', x: nx, y: midY - 15 * 0.6 * lines(wrapped), text: wrapped, fontSize: 15, color: noteColor, width: NOTE_W, align: 'left', fontFamily: FONT.sans });
    }
    cy += stageH + gap;
  });
  const totalW = w + (hasNotes ? noteGap + NOTE_W : 0);
  return box(out, x, y, totalW, Math.max(0, cy - gap - y));
}

// --- wireframe / prototype kit ------------------------------------------
// Neutral, grayscale components so you can sketch a UI PROTOTYPE (browser page, app screen, form)
// that reads as a mock, not as decoration. Real content stays sparse; textRows() stands in for body
// copy so a wireframe never becomes a wall of text.

// A window / browser chrome. `kind:'browser'` draws a URL bar; `kind:'app'` a centered title.
// `.inner = {x,y,w,h}` is the safe content region — place children there and they won't hit the chrome.
function windowFrame(o) {
  const { x = 0, y = 0, w = 560, h = 380, title = '', url = null, kind = 'browser', bar = 38, fill = WIRE.paper, chrome = WIRE.chrome, stroke = WIRE.edge, pad = 16 } = o;
  const out = [];
  out.push({ type: 'rectangle', x, y, width: w, height: h, strokeColor: stroke, backgroundColor: fill, fillStyle: 'solid', strokeWidth: 2, roundness: true });
  out.push({ type: 'rectangle', x, y, width: w, height: bar, strokeColor: stroke, backgroundColor: chrome, fillStyle: 'solid', strokeWidth: 2, roundness: true });
  ['#ff5f57', '#febc2e', '#28c840'].forEach((c, i) => out.push({ type: 'ellipse', x: x + 14 + i * 20, y: y + bar / 2 - 5, width: 10, height: 10, strokeColor: c, backgroundColor: c, fillStyle: 'solid', strokeWidth: 1 }));
  if (kind === 'browser') {
    const ux = x + 80, uw = w - 96;
    out.push({ type: 'rectangle', x: ux, y: y + 7, width: uw, height: bar - 14, strokeColor: WIRE.line, backgroundColor: WIRE.paper, fillStyle: 'solid', strokeWidth: 1, roundness: true });
    if (url) out.push({ type: 'text', x: ux + 12, y: y + bar / 2 - 7, text: url, fontSize: 12, color: WIRE.text, width: uw - 24, fontFamily: FONT.code });
  } else if (title) {
    out.push({ type: 'text', x: x + 80, y: y + bar / 2 - 8, text: title, fontSize: 13, color: WIRE.strong, width: w - 160, align: 'center', fontFamily: FONT.sans });
  }
  G(out, 'window');
  box(out, x, y, w, h);
  out.inner = { x: x + pad, y: y + bar + pad, w: w - 2 * pad, h: h - bar - 2 * pad };
  return out;
}

// A solid CTA button (default) or an outline button (`variant:'outline'`).
function button(o) {
  const { x = 0, y = 0, w = 150, h = 42, text = 'Button', color = 'blue', fontSize = 15, variant = 'solid', textColor = '#ffffff' } = o;
  const p = pal(color);
  const solid = variant !== 'outline';
  const fit = fitText({ text, w, h, fontSize, minFont: 11 });
  const th = fit.lineCount * fit.fontSize * LH;
  const g = newGroup('button');
  return box([
    { type: 'rectangle', x, y, width: w, height: h, strokeColor: p.stroke, backgroundColor: solid ? p.stroke : WIRE.paper, fillStyle: 'solid', strokeWidth: 2, roundness: true, group: g },
    { type: 'text', x, y: y + (h - th) / 2, text: fit.text, fontSize: fit.fontSize, color: solid ? textColor : p.stroke, width: w, align: 'center', fontFamily: FONT.sans, group: g },
  ], x, y, w, h);
}

// A text input field with a muted placeholder, and an optional label above it.
function input(o) {
  const { x = 0, y = 0, w = 260, h = 42, placeholder = '', label = null, fontSize = 14 } = o;
  const out = []; let yy = y;
  if (label) { out.push({ type: 'text', x, y: yy, text: label, fontSize: 12, color: WIRE.text, width: w, fontFamily: FONT.sans }); yy += 12 * LH + 6; }
  out.push({ type: 'rectangle', x, y: yy, width: w, height: h, strokeColor: WIRE.edge, backgroundColor: WIRE.paper, fillStyle: 'solid', strokeWidth: 1.5, roundness: true });
  if (placeholder) out.push({ type: 'text', x: x + 12, y: yy + h / 2 - fontSize * 0.6, text: placeholder, fontSize, color: WIRE.hint, width: w - 24, fontFamily: FONT.sans });
  return box(G(out, 'input'), x, y, w, (yy - y) + h);
}

// Grey bars that stand in for body copy in a wireframe — VISUAL filler, no real text. The last row is
// short (`last` fraction) like a real paragraph's final line.
function textRows(o) {
  const { x = 0, y = 0, w = 320, rows = 3, lineH = 12, gap = 10, color = WIRE.line, last = 0.6 } = o;
  const out = [];
  for (let i = 0; i < rows; i++) {
    const rw = (i === rows - 1 && rows > 1) ? Math.round(w * last) : w;
    out.push({ type: 'rectangle', x, y: y + i * (lineH + gap), width: rw, height: lineH, strokeColor: 'transparent', backgroundColor: color, fillStyle: 'solid', strokeWidth: 0, roundness: true });
  }
  return box(out, x, y, w, rows * lineH + (rows - 1) * gap);
}

// The universal image-placeholder glyph: a box with an X. Use anywhere a real screenshot would go.
function imagePlaceholder(o) {
  const { x = 0, y = 0, w = 220, h = 150, fill = WIRE.fill, stroke = WIRE.hint, label = null } = o;
  const out = [
    { type: 'rectangle', x, y, width: w, height: h, strokeColor: stroke, backgroundColor: fill, fillStyle: 'solid', strokeWidth: 1.5, roundness: false },
    { type: 'line', points: [[x, y], [x + w, y + h]], strokeColor: stroke, strokeWidth: 1.5 },
    { type: 'line', points: [[x + w, y], [x, y + h]], strokeColor: stroke, strokeWidth: 1.5 },
  ];
  if (label) out.push({ type: 'text', x, y: y + h / 2 - 8, text: label, fontSize: 13, color: WIRE.text, width: w, align: 'center', fontFamily: FONT.sans });
  return box(G(out, 'imgph'), x, y, w, h);
}

// A round avatar/user placeholder.
function avatar(o) {
  const { cx = 0, cy = 0, r = 24, fill = WIRE.line, stroke = WIRE.hint } = o;
  return box([{ type: 'ellipse', x: cx - r, y: cy - r, width: 2 * r, height: 2 * r, strokeColor: stroke, backgroundColor: fill, fillStyle: 'solid', strokeWidth: 1.5 }], cx - r, cy - r, 2 * r, 2 * r);
}

// A top navigation bar: brand on the left, links on the right, optional CTA button.
function navbar(o) {
  const { x = 0, y = 0, w = 800, h = 54, brand = '', items = [], cta = null, fill = WIRE.paper, stroke = WIRE.line, color = WIRE.strong } = o;
  const out = [{ type: 'rectangle', x, y, width: w, height: h, strokeColor: stroke, backgroundColor: fill, fillStyle: 'solid', strokeWidth: 1.5, roundness: false }];
  if (brand) out.push({ type: 'text', x: x + 22, y: y + h / 2 - 11, text: brand, fontSize: 18, color: INK, fontFamily: FONT.sans });
  let rx = x + w - 22 - (cta ? 132 : 0);
  for (let i = items.length - 1; i >= 0; i--) {
    const t = items[i]; const tw = measureText(t, 14) + 20; rx -= tw;
    out.push({ type: 'text', x: rx, y: y + h / 2 - 9, text: t, fontSize: 14, color, width: tw, align: 'center', fontFamily: FONT.sans });
  }
  if (cta) out.push(...button({ x: x + w - 22 - 120, y: y + (h - 34) / 2, w: 120, h: 34, text: cta, fontSize: 13 }));
  return box(G(out, 'navbar'), x, y, w, h);
}

// A small pill/tag/badge sized to its text.
function chip(o) {
  const { x = 0, y = 0, text = '', color = 'gray', fontSize = 13 } = o;
  const p = pal(color);
  const w = Math.round(measureText(text, fontSize) + 22), h = Math.round(fontSize + 14);
  const g = newGroup('chip');
  return box([
    { type: 'rectangle', x, y, width: w, height: h, strokeColor: p.stroke, backgroundColor: p.fill, fillStyle: 'solid', strokeWidth: 1.5, roundness: true, group: g },
    { type: 'text', x, y: y + (h - fontSize * LH) / 2, text, fontSize, color: p.stroke, width: w, align: 'center', fontFamily: FONT.sans, group: g },
  ], x, y, w, h);
}

// A thin horizontal rule.
function divider(o) {
  const { x = 0, y = 0, w = 600, color = WIRE.line, strokeWidth = 1.5 } = o;
  return box([{ type: 'line', points: [[x, y], [x + w, y]], strokeColor: color, strokeWidth }], x, y, w, 0);
}

// bullet list as a single left-aligned block (their "Configuration" spec list pattern) — kept for
// back-compat; prefer bullets() above which wraps to a reading measure.

// center helpers for wiring connectors to card edges
const center = (x, y, w, h) => [x + w / 2, y + h / 2];
const rightOf = (x, y, w, h) => [x + w, y + h / 2];
const leftOf = (x, y, w, h) => [x, y + h / 2];
const bottomOf = (x, y, w, h) => [x + w / 2, y + h];
const topOf = (x, y, w, h) => [x + w / 2, y];

module.exports = {
  INK, MUTED, PALETTE, WIRE, READ_W, NOTE_W, pal,
  // typography (re-exported so callers have one import for the house style)
  FONT, fontId, LH, BODY_SIZE, BODY_LH, LH_ROLE, textH, EMPHASIS, textBlock, wrapLines, widestLine,
  parseMarkup, hasMarkup, isWideGlyph, glyphW,
  // text + layout
  measureText, fitText, wrapToWidth, prose, sectionTitle, bullets, takeaway, annotate,
  box, bbox, translate, stack, row,
  // structure
  card, node, connector, column, hub, funnel,
  // wireframe / prototype kit
  windowFrame, button, input, textRows, imagePlaceholder, avatar, navbar, chip, divider,
  // edge helpers
  center, rightOf, leftOf, bottomOf, topOf,
};
