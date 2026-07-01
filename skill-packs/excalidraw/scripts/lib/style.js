// House style learned from the vault's presentation boards (MemoryOS High Level, Personalization
// Module, Research). Excalifont (fontFamily 5), solid fills, always-rounded rects, 2px #1e1e1e ink,
// Excalidraw's native pastel swatches used semantically. These helpers return ElementSpec[] for
// build_excalidraw.js's buildExcalidraw({ elements }).

const INK = '#1e1e1e';

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

let _gc = 0;
const newGroup = (hint) => `g${++_gc}-${hint || ''}`;
const lines = (t) => String(t).split('\n').length;

// --- text fitting --------------------------------------------------------
// Excalifont glyph advance, in multiples of fontSize. Latin is ~0.58; emoji, arrows, CJK and
// combining marks render roughly square (~1.05) — the old flat 0.52 under-counted them, so wide
// labels measured narrow and spilled out of their card. Mirrored in build_excalidraw.js sizeText().
function isWideGlyph(code) {
  return (
    (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
    (code >= 0x2190 && code <= 0x21ff) || // arrows
    (code >= 0x2300 && code <= 0x23ff) || // misc technical (⏰ ⏳ …)
    (code >= 0x25a0 && code <= 0x27bf) || // geometric shapes, misc symbols, dingbats (✅ ★ …)
    (code >= 0x2b00 && code <= 0x2bff) || // extra arrows / symbols
    (code >= 0x2e80 && code <= 0x9fff) || // CJK radicals … unified ideographs
    (code >= 0xac00 && code <= 0xd7a3) || // Hangul syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK compatibility ideographs
    (code >= 0xfe30 && code <= 0xfe4f) || // CJK compatibility forms
    (code >= 0xff00 && code <= 0xff60) || // fullwidth forms
    (code >= 0x1f000 && code <= 0x1faff) || // emoji & pictographs
    (code >= 0x1f1e6 && code <= 0x1f1ff)    // regional indicators (flags)
  );
}
function glyphW(ch, fontSize) { return fontSize * (isWideGlyph(ch.codePointAt(0)) ? 1.05 : 0.58); }
function measureText(s, fontSize) { let w = 0; for (const ch of String(s)) w += glyphW(ch, fontSize); return w; }

// Greedy word-wrap to a pixel width, honoring existing \n and HARD-breaking any single word that is
// itself wider than the box (e.g. a long URL). Returns the text WITH the newlines baked in — the
// Obsidian plugin keeps them instead of re-flowing the label into one over-wide centered line.
function wrapToWidth(text, fontSize, width) {
  const out = [];
  for (const logical of String(text).split('\n')) {
    const words = logical.split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(''); continue; }
    let cur = '';
    for (let word of words) {
      while (measureText(word, fontSize) > width) {
        let acc = '';
        for (const ch of word) {
          if (acc && measureText(acc + ch, fontSize) > width) break;
          acc += ch;
        }
        if (cur) { out.push(cur); cur = ''; }
        out.push(acc);
        word = word.slice(acc.length);
        if (!word) break;
      }
      if (!word) continue;
      const candidate = cur ? cur + ' ' + word : word;
      if (cur && measureText(candidate, fontSize) > width) { out.push(cur); cur = word; }
      else cur = candidate;
    }
    if (cur) out.push(cur);
  }
  return out.join('\n');
}

const _warned = new Set();
function warnFit(msg) { if (!_warned.has(msg)) { _warned.add(msg); try { console.warn('[excalidraw] ' + msg); } catch (e) {} } }

// Wrap `text` to the card's inner width, then shrink the font (down to minFont) until the wrapped
// label also fits the card height. Returns { text (with baked-in newlines), fontSize, lineCount, fits }.
function fitText(o) {
  const { text = '', w = 260, h = 92, fontSize = 20, minFont = 9, lineHeight = 1.25, padX = 10, padY = 8 } = o;
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

// arc-length midpoint of a polyline — keeps a connector label on the line even when it elbows
function polyMid(pts) {
  if (!pts || pts.length < 2) return (pts && pts[0]) || [0, 0];
  const seg = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); seg.push(l); total += l; }
  let half = total / 2;
  for (let i = 1; i < pts.length; i++) {
    if (half <= seg[i - 1] || i === pts.length - 1) {
      const t = seg[i - 1] ? half / seg[i - 1] : 0;
      return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
    }
    half -= seg[i - 1];
  }
  return pts[0];
}

// rounded card: filled rect + centered label, grouped so they move together. The label is
// hard-wrapped to the card width and the font auto-shrinks (to `minFont`) until it also fits the
// height, so text can never spill outside the box. Warns if even the floor font won't fit.
function card(o) {
  const { x, y, w = 260, h = 92, text = '', color = 'blue', fontSize = 20, stroke = INK, strokeWidth = 2, textColor = INK, roundness = true, minFont = 9, padX = 10, padY = 8 } = o;
  const group = o.group || newGroup('card');
  const p = pal(color);
  const fit = fitText({ text, w, h, fontSize, minFont, padX, padY });
  if (!fit.fits) warnFit(`label ${JSON.stringify(String(text).slice(0, 32))} won't fit a ${w}×${h} card even at ${minFont}px — enlarge the card or shorten the text.`);
  const textH = fit.lineCount * fit.fontSize * 1.25;
  const ty = y + Math.max(padY, (h - textH) / 2);
  return [
    { type: 'rectangle', x, y, width: w, height: h, strokeColor: stroke, backgroundColor: p.fill, fillStyle: 'solid', strokeWidth, roundness, group },
    { type: 'text', x, y: ty, text: fit.text, fontSize: fit.fontSize, color: textColor, width: w, align: 'center', fontFamily: 5, group },
  ];
}
// small node (flow step) — card with tighter defaults
function node(o) { return card(Object.assign({ w: 200, h: 64, fontSize: 18 }, o)); }

// big plain section header (no box), like "Configuration" / "Flow"
function sectionTitle(o) {
  const { x, y, text, fontSize = 44, color = INK } = o;
  return [{ type: 'text', x, y, text, fontSize, color, fontFamily: 5, width: Math.max(200, String(text).length * fontSize * 0.6) }];
}

// labeled connector arrow between two points (centers of cards, etc.).
// Routing: pass `via:[[x,y],…]` for explicit waypoints, or `elbow:'hv'|'vh'` for an auto right-angle
// bend ('hv' = horizontal then vertical, 'vh' = vertical then horizontal). Use these to route a link
// AROUND intervening boxes instead of cutting a diagonal straight through them.
function connector(o) {
  const { from, to, label, double = false, strokeColor = INK, strokeWidth = 2, dashed = false, labelColor = '#495057', fontSize = 16, via = null, elbow = null } = o;
  let pts;
  if (via && via.length) pts = [from, ...via, to];
  else if (elbow === 'hv') pts = [from, [to[0], from[1]], to];
  else if (elbow === 'vh') pts = [from, [from[0], to[1]], to];
  else pts = [from, to];
  const out = [{ type: 'arrow', points: pts, strokeColor, strokeWidth, strokeStyle: dashed ? 'dashed' : 'solid', endArrow: 'arrow', startArrow: double ? 'arrow' : null }];
  if (label) {
    const [mx, my] = polyMid(pts);
    const w = Math.max(40, measureText(String(label), fontSize) + fontSize);
    out.push({ type: 'text', x: mx - w / 2, y: my - fontSize - 4, text: label, fontSize, color: labelColor, width: w, align: 'center', fontFamily: 5 });
  }
  return out;
}

// side-annotation: short arrow from a node edge to a spec note (the "90sec / deepseek..." pattern)
function annotate(o) {
  const { from, to, text, fontSize = 16, color = '#495057' } = o;
  return [
    { type: 'arrow', points: [from, to], strokeColor: color, strokeWidth: 1.5, endArrow: 'arrow' },
    { type: 'text', x: to[0] + 6, y: to[1] - fontSize * 0.6, text, fontSize, color, width: Math.max(80, String(text).split('\n')[0].length * fontSize * 0.62), align: 'left', fontFamily: 5 },
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
  return out;
}

// hub-and-spoke: central node + satellites with arrows (the "Personalization Layer" + APIs pattern)
function hub(o) {
  const { cx, cy, label, color = 'purple', rx = 64, ry = 44, radius = 170, spokes = [], spokeColor = 'blue', spokeRx = 30, spokeRy = 30, startAngle = -Math.PI / 2 } = o;
  const group = newGroup('hub');
  const out = [];
  const p = pal(color);
  out.push({ type: 'ellipse', x: cx - rx, y: cy - ry, width: rx * 2, height: ry * 2, strokeColor: p.stroke, backgroundColor: p.fill, fillStyle: 'solid', strokeWidth: 2 });
  out.push({ type: 'text', x: cx - rx, y: cy - 10, text: label, fontSize: 16, color: INK, width: rx * 2, align: 'center', fontFamily: 5 });
  const n = spokes.length;
  spokes.forEach((s, i) => {
    const a = startAngle + (i / Math.max(1, n)) * Math.PI * 2;
    const sx = cx + Math.cos(a) * radius, sy = cy + Math.sin(a) * radius;
    const c = (typeof s === 'object' && s.color) || spokeColor;
    const t = typeof s === 'string' ? s : s.label;
    const sp = pal(c);
    out.push({ type: 'arrow', points: [[cx + Math.cos(a) * rx, cy + Math.sin(a) * ry], [sx - Math.cos(a) * spokeRx, sy - Math.sin(a) * spokeRy]], strokeColor: INK, strokeWidth: 2, endArrow: 'arrow' });
    out.push({ type: 'ellipse', x: sx - spokeRx, y: sy - spokeRy, width: spokeRx * 2, height: spokeRy * 2, strokeColor: sp.stroke, backgroundColor: sp.fill, fillStyle: 'solid', strokeWidth: 2 });
    out.push({ type: 'text', x: sx - spokeRx, y: sy - 8, text: t, fontSize: 14, color: INK, width: spokeRx * 2, align: 'center', fontFamily: 5 });
  });
  return out;
}

// bullet list as a single left-aligned block (their "Configuration" spec list pattern)
function bullets(o) {
  const { x, y, items = [], fontSize = 20, color = INK, bullet = '• ', width } = o;
  const text = items.map((i) => bullet + i).join('\n');
  return [{ type: 'text', x, y, text, fontSize, color, fontFamily: 5, width: width || Math.max(200, Math.max(...items.map((i) => i.length)) * fontSize * 0.6) }];
}

// center helpers for wiring connectors to card edges
const center = (x, y, w, h) => [x + w / 2, y + h / 2];
const rightOf = (x, y, w, h) => [x + w, y + h / 2];
const leftOf = (x, y, w, h) => [x, y + h / 2];
const bottomOf = (x, y, w, h) => [x + w / 2, y + h];
const topOf = (x, y, w, h) => [x + w / 2, y];

module.exports = { INK, PALETTE, pal, card, node, sectionTitle, connector, annotate, column, hub, bullets, fitText, measureText, center, rightOf, leftOf, bottomOf, topOf };
