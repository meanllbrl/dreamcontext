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
// word-wrapped line count at a given width — keeps card labels vertically centered when they wrap
function wrapLineCount(text, fontSize, width) {
  const perLine = Math.max(1, Math.floor(width / (fontSize * 0.52)));
  let total = 0;
  for (const ln of String(text).split('\n')) {
    const words = ln.split(/\s+/).filter(Boolean);
    if (!words.length) { total += 1; continue; }
    let cur = 0, lc = 1;
    for (const w of words) { const add = (cur ? 1 : 0) + w.length; if (cur + add > perLine && cur > 0) { lc++; cur = w.length; } else cur += add; }
    total += lc;
  }
  return total;
}

// rounded card: filled rect + centered label, grouped so they move together
function card(o) {
  const { x, y, w = 260, h = 92, text = '', color = 'blue', fontSize = 20, stroke = INK, strokeWidth = 2, textColor = INK, roundness = true } = o;
  const group = o.group || newGroup('card');
  const p = pal(color);
  const textH = wrapLineCount(text, fontSize, w) * fontSize * 1.25;
  const ty = y + Math.max(6, (h - textH) / 2);
  return [
    { type: 'rectangle', x, y, width: w, height: h, strokeColor: stroke, backgroundColor: p.fill, fillStyle: 'solid', strokeWidth, roundness, group },
    { type: 'text', x, y: ty, text, fontSize, color: textColor, width: w, align: 'center', fontFamily: 5, group },
  ];
}
// small node (flow step) — card with tighter defaults
function node(o) { return card(Object.assign({ w: 200, h: 64, fontSize: 18 }, o)); }

// big plain section header (no box), like "Configuration" / "Flow"
function sectionTitle(o) {
  const { x, y, text, fontSize = 44, color = INK } = o;
  return [{ type: 'text', x, y, text, fontSize, color, fontFamily: 5, width: Math.max(200, String(text).length * fontSize * 0.6) }];
}

// labeled connector arrow between two points (centers of cards, etc.)
function connector(o) {
  const { from, to, label, double = false, strokeColor = INK, strokeWidth = 2, dashed = false, labelColor = '#495057', fontSize = 16 } = o;
  const out = [{ type: 'arrow', points: [from, to], strokeColor, strokeWidth, strokeStyle: dashed ? 'dashed' : 'solid', endArrow: 'arrow', startArrow: double ? 'arrow' : null }];
  if (label) {
    const mx = (from[0] + to[0]) / 2, my = (from[1] + to[1]) / 2;
    const w = Math.max(40, String(label).length * fontSize * 0.62);
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

module.exports = { INK, PALETTE, pal, card, node, sectionTitle, connector, annotate, column, hub, bullets, center, rightOf, leftOf, bottomOf, topOf };
