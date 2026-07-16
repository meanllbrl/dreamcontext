// Device + UI kit for Excalidraw wireframes. Same contract as style.js/charts.js: every builder
// returns an ElementSpec[] carrying `.x/.y/.w/.h/.nextX/.nextY`, so it composes inside stack()/row().
//
// Why a separate lib: style.js owns the *diagram* house style (cards, connectors, funnels) and a
// handful of generic wireframe bits. This file owns the *product UI* vocabulary — real device shells,
// nav chrome, form controls, icons. It re-exports style.js's wireframe primitives too, so one require
// gives you the whole kit.
//
// Rounded corners: build_excalidraw maps `roundness:true` to Excalidraw's ADAPTIVE_RADIUS (type 3),
// which caps at ~32px — far too tight for a phone silhouette (an iPhone's is ~14% of its width). So
// device shells are drawn as FILLED POLYGONS with exact arc corners, the same trick funnel()/donut()
// use for shapes Excalidraw has no primitive for. Everything inside a device stays a normal element.

const {
  INK, WIRE, pal, measureText, wrapToWidth, box, bbox, translate,
  windowFrame, navbar, button, input, textRows, imagePlaceholder, avatar, chip, divider,
} = require('./style.js');

const LH = 1.25;
const FONT = 5;
const txt = (o) => Object.assign({ type: 'text', fontFamily: FONT, color: INK }, o);
let _gc = 0;
function G(els, hint) {
  const g = `wf${++_gc}-${hint}`;
  for (const e of els) if (e.group == null) e.group = g;
  return els;
}

// ── geometry ──────────────────────────────────────────────────────────────
// A closed rounded-rectangle polygon with an EXACT corner radius (Excalidraw's rect roundness can't
// go past ~32px). `seg` points per corner arc — 6 is smooth enough at board scale.
function roundRectPoints(x, y, w, h, r, seg = 6) {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  const pts = [];
  const arc = (cx, cy, a0, a1) => {
    for (let i = 0; i <= seg; i++) {
      const a = a0 + (a1 - a0) * (i / seg);
      pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
    }
  };
  const P = Math.PI;
  arc(x + w - rr, y + rr, -P / 2, 0);          // top-right
  arc(x + w - rr, y + h - rr, 0, P / 2);       // bottom-right
  arc(x + rr, y + h - rr, P / 2, P);           // bottom-left
  arc(x + rr, y + rr, P, (3 * P) / 2);         // top-left
  pts.push(pts[0]);
  return pts;
}
function roundRect(o) {
  const { x, y, w, h, r = 12, fill = WIRE.paper, stroke = WIRE.edge, strokeWidth = 2, seg = 6 } = o;
  return {
    type: 'line', points: roundRectPoints(x, y, w, h, r, seg),
    strokeColor: stroke, backgroundColor: fill, fillStyle: 'solid', strokeWidth,
  };
}

// ── icons ─────────────────────────────────────────────────────────────────
// Line-drawn glyphs on a size×size box centred at (cx,cy). Deliberately simple: a wireframe icon
// only has to READ as its concept, not be pixel-perfect. Every entry returns ElementSpec[].
const ICONS = {
  menu: (c, s, k, w) => [0, 0.5, 1].map((t) => ln([[c[0] - s / 2, c[1] - s / 2 + t * s], [c[0] + s / 2, c[1] - s / 2 + t * s]], k, w)),
  close: (c, s, k, w) => [ln([[c[0] - s / 2, c[1] - s / 2], [c[0] + s / 2, c[1] + s / 2]], k, w), ln([[c[0] + s / 2, c[1] - s / 2], [c[0] - s / 2, c[1] + s / 2]], k, w)],
  plus: (c, s, k, w) => [ln([[c[0] - s / 2, c[1]], [c[0] + s / 2, c[1]]], k, w), ln([[c[0], c[1] - s / 2], [c[0], c[1] + s / 2]], k, w)],
  minus: (c, s, k, w) => [ln([[c[0] - s / 2, c[1]], [c[0] + s / 2, c[1]]], k, w)],
  check: (c, s, k, w) => [ln([[c[0] - s / 2, c[1]], [c[0] - s / 8, c[1] + s / 3], [c[0] + s / 2, c[1] - s / 3]], k, w)],
  search: (c, s, k, w) => [el(c[0] - s / 2, c[1] - s / 2, s * 0.68, s * 0.68, k, w), ln([[c[0] + s * 0.14, c[1] + s * 0.14], [c[0] + s / 2, c[1] + s / 2]], k, w)],
  'chevron-left': (c, s, k, w) => [ln([[c[0] + s / 4, c[1] - s / 2], [c[0] - s / 4, c[1]], [c[0] + s / 4, c[1] + s / 2]], k, w)],
  'chevron-right': (c, s, k, w) => [ln([[c[0] - s / 4, c[1] - s / 2], [c[0] + s / 4, c[1]], [c[0] - s / 4, c[1] + s / 2]], k, w)],
  'chevron-up': (c, s, k, w) => [ln([[c[0] - s / 2, c[1] + s / 4], [c[0], c[1] - s / 4], [c[0] + s / 2, c[1] + s / 4]], k, w)],
  'chevron-down': (c, s, k, w) => [ln([[c[0] - s / 2, c[1] - s / 4], [c[0], c[1] + s / 4], [c[0] + s / 2, c[1] - s / 4]], k, w)],
  'arrow-left': (c, s, k, w) => [ln([[c[0] + s / 2, c[1]], [c[0] - s / 2, c[1]]], k, w), ln([[c[0] - s / 6, c[1] - s / 3], [c[0] - s / 2, c[1]], [c[0] - s / 6, c[1] + s / 3]], k, w)],
  'arrow-right': (c, s, k, w) => [ln([[c[0] - s / 2, c[1]], [c[0] + s / 2, c[1]]], k, w), ln([[c[0] + s / 6, c[1] - s / 3], [c[0] + s / 2, c[1]], [c[0] + s / 6, c[1] + s / 3]], k, w)],
  more: (c, s, k) => [-1, 0, 1].map((t) => dot(c[0] + t * s * 0.34, c[1], s * 0.09, k)),
  'more-v': (c, s, k) => [-1, 0, 1].map((t) => dot(c[0], c[1] + t * s * 0.34, s * 0.09, k)),
  play: (c, s, k, w) => [poly([[c[0] - s / 3, c[1] - s / 2], [c[0] + s / 2, c[1]], [c[0] - s / 3, c[1] + s / 2]], k, w)],
  heart: (c, s, k, w) => [poly(heartPts(c[0], c[1], s), k, w)],
  star: (c, s, k, w) => [poly(starPts(c[0], c[1], s / 2, s / 4.6, 5), k, w)],
  user: (c, s, k, w) => [el(c[0] - s * 0.22, c[1] - s / 2, s * 0.44, s * 0.44, k, w), ln([[c[0] - s * 0.38, c[1] + s / 2], [c[0] - s * 0.38, c[1] + s * 0.16], [c[0] + s * 0.38, c[1] + s * 0.16], [c[0] + s * 0.38, c[1] + s / 2]], k, w)],
  home: (c, s, k, w) => [ln([[c[0] - s / 2, c[1]], [c[0], c[1] - s / 2], [c[0] + s / 2, c[1]]], k, w), ln([[c[0] - s / 3, c[1]], [c[0] - s / 3, c[1] + s / 2], [c[0] + s / 3, c[1] + s / 2], [c[0] + s / 3, c[1]]], k, w)],
  bell: (c, s, k, w) => [ln([[c[0] - s * 0.36, c[1] + s * 0.2], [c[0] - s * 0.3, c[1] - s * 0.12], [c[0], c[1] - s * 0.44], [c[0] + s * 0.3, c[1] - s * 0.12], [c[0] + s * 0.36, c[1] + s * 0.2], [c[0] - s * 0.36, c[1] + s * 0.2]], k, w), ln([[c[0] - s * 0.1, c[1] + s * 0.34], [c[0] + s * 0.1, c[1] + s * 0.34]], k, w)],
  trash: (c, s, k, w) => [ln([[c[0] - s * 0.4, c[1] - s * 0.26], [c[0] + s * 0.4, c[1] - s * 0.26]], k, w), ln([[c[0] - s * 0.28, c[1] - s * 0.26], [c[0] - s * 0.22, c[1] + s * 0.44], [c[0] + s * 0.22, c[1] + s * 0.44], [c[0] + s * 0.28, c[1] - s * 0.26]], k, w), ln([[c[0] - s * 0.12, c[1] - s * 0.26], [c[0] - s * 0.12, c[1] - s * 0.44], [c[0] + s * 0.12, c[1] - s * 0.44], [c[0] + s * 0.12, c[1] - s * 0.26]], k, w)],
  settings: (c, s, k, w) => {
    // flat-topped teeth — an alternating-radius star reads as a SUN, not a gear
    const teeth = 7, R = s * 0.5, r = s * 0.36, pts = [];
    for (let i = 0; i < teeth; i++) {
      const a0 = (i / teeth) * Math.PI * 2, st = (Math.PI * 2) / teeth;
      [[a0, R], [a0 + st * 0.42, R], [a0 + st * 0.58, r], [a0 + st, r]].forEach(([a, rr]) =>
        pts.push([c[0] + Math.cos(a) * rr, c[1] + Math.sin(a) * rr]));
    }
    return [ln([...pts, pts[0]], k, w), el(c[0] - s * 0.16, c[1] - s * 0.16, s * 0.32, s * 0.32, k, w)];
  },
  share: (c, s, k, w) => [dot(c[0] + s * 0.32, c[1] - s * 0.36, s * 0.11, k), dot(c[0] - s * 0.34, c[1], s * 0.11, k), dot(c[0] + s * 0.32, c[1] + s * 0.36, s * 0.11, k), ln([[c[0] - s * 0.26, c[1] - s * 0.06], [c[0] + s * 0.24, c[1] - s * 0.3]], k, w), ln([[c[0] - s * 0.26, c[1] + s * 0.06], [c[0] + s * 0.24, c[1] + s * 0.3]], k, w)],
  lock: (c, s, k, w) => [rc(c[0] - s * 0.32, c[1] - s * 0.04, s * 0.64, s * 0.5, k, w), ln([[c[0] - s * 0.18, c[1] - s * 0.04], [c[0] - s * 0.18, c[1] - s * 0.3], [c[0] + s * 0.18, c[1] - s * 0.3], [c[0] + s * 0.18, c[1] - s * 0.04]], k, w)],
  mail: (c, s, k, w) => [rc(c[0] - s * 0.44, c[1] - s * 0.32, s * 0.88, s * 0.64, k, w), ln([[c[0] - s * 0.44, c[1] - s * 0.32], [c[0], c[1] + s * 0.06], [c[0] + s * 0.44, c[1] - s * 0.32]], k, w)],
  camera: (c, s, k, w) => [rc(c[0] - s * 0.46, c[1] - s * 0.26, s * 0.92, s * 0.6, k, w), el(c[0] - s * 0.16, c[1] - s * 0.1, s * 0.32, s * 0.32, k, w), ln([[c[0] - s * 0.18, c[1] - s * 0.26], [c[0] - s * 0.1, c[1] - s * 0.4], [c[0] + s * 0.1, c[1] - s * 0.4], [c[0] + s * 0.18, c[1] - s * 0.26]], k, w)],
  image: (c, s, k, w) => [rc(c[0] - s * 0.44, c[1] - s * 0.36, s * 0.88, s * 0.72, k, w), ln([[c[0] - s * 0.44, c[1] + s * 0.14], [c[0] - s * 0.12, c[1] - s * 0.14], [c[0] + s * 0.16, c[1] + s * 0.36]], k, w), dot(c[0] + s * 0.2, c[1] - s * 0.16, s * 0.07, k)],
  edit: (c, s, k, w) => [ln([[c[0] - s * 0.44, c[1] + s * 0.44], [c[0] - s * 0.3, c[1] + s * 0.16], [c[0] + s * 0.3, c[1] - s * 0.44], [c[0] + s * 0.44, c[1] - s * 0.3], [c[0] - s * 0.16, c[1] + s * 0.3], [c[0] - s * 0.44, c[1] + s * 0.44]], k, w)],
  filter: (c, s, k, w) => [ln([[c[0] - s * 0.46, c[1] - s * 0.34], [c[0] + s * 0.46, c[1] - s * 0.34], [c[0] + s * 0.1, c[1] + s * 0.06], [c[0] + s * 0.1, c[1] + s * 0.42], [c[0] - s * 0.1, c[1] + s * 0.28], [c[0] - s * 0.1, c[1] + s * 0.06], [c[0] - s * 0.46, c[1] - s * 0.34]], k, w)],
  bookmark: (c, s, k, w) => [ln([[c[0] - s * 0.3, c[1] - s * 0.44], [c[0] + s * 0.3, c[1] - s * 0.44], [c[0] + s * 0.3, c[1] + s * 0.44], [c[0], c[1] + s * 0.14], [c[0] - s * 0.3, c[1] + s * 0.44], [c[0] - s * 0.3, c[1] - s * 0.44]], k, w)],
  calendar: (c, s, k, w) => [rc(c[0] - s * 0.42, c[1] - s * 0.34, s * 0.84, s * 0.76, k, w), ln([[c[0] - s * 0.42, c[1] - s * 0.1], [c[0] + s * 0.42, c[1] - s * 0.1]], k, w), ln([[c[0] - s * 0.2, c[1] - s * 0.34], [c[0] - s * 0.2, c[1] - s * 0.48]], k, w), ln([[c[0] + s * 0.2, c[1] - s * 0.34], [c[0] + s * 0.2, c[1] - s * 0.48]], k, w)],
};
const ln = (points, k, w) => ({ type: 'line', points, strokeColor: k, strokeWidth: w, backgroundColor: 'transparent' });
const poly = (points, k, w) => ({ type: 'line', points: [...points, points[0]], strokeColor: k, backgroundColor: k, fillStyle: 'solid', strokeWidth: w });
const el = (x, y, w2, h2, k, w) => ({ type: 'ellipse', x, y, width: w2, height: h2, strokeColor: k, backgroundColor: 'transparent', strokeWidth: w });
const rc = (x, y, w2, h2, k, w) => ({ type: 'rectangle', x, y, width: w2, height: h2, strokeColor: k, backgroundColor: 'transparent', strokeWidth: w, roundness: true });
const dot = (cx, cy, r, k) => ({ type: 'ellipse', x: cx - r, y: cy - r, width: r * 2, height: r * 2, strokeColor: k, backgroundColor: k, fillStyle: 'solid', strokeWidth: 1 });
function starPts(cx, cy, R, r, n) {
  const p = [];
  for (let i = 0; i < n * 2; i++) {
    const a = (i / (n * 2)) * Math.PI * 2 - Math.PI / 2;
    const rr = i % 2 ? r : R;
    p.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
  }
  return p;
}
function heartPts(cx, cy, s) {
  const p = [];
  for (let i = 0; i <= 24; i++) {
    const t = (i / 24) * Math.PI * 2;
    const x = 16 * Math.pow(Math.sin(t), 3);
    const y = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t));
    p.push([cx + (x / 17) * (s / 2), cy + (y / 17) * (s / 2)]);
  }
  return p;
}

/** A line-drawn glyph. `name` must be a key of ICONS; unknown names fall back to a box (so a typo is
 *  visible on the board instead of silently drawing nothing). */
function icon(o) {
  const { name = 'menu', x = 0, y = 0, size = 20, color = WIRE.strong, strokeWidth = 1.6 } = o;
  const c = [x + size / 2, y + size / 2];
  const f = ICONS[name];
  const els = f ? f(c, size, color, strokeWidth).flat() : [rc(x, y, size, size, color, strokeWidth)];
  return box(els, x, y, size, size);
}
const iconNames = () => Object.keys(ICONS);

/** A tappable icon: glyph inside a circle/square/bare hit area. The workhorse of mobile chrome. */
function iconButton(o) {
  const {
    x = 0, y = 0, size = 40, icon: name = 'menu', shape = 'circle', color = null,
    variant = 'ghost', iconSize = null, strokeWidth = 1.6,
  } = o;
  const p = color ? pal(color) : null;
  const solid = variant === 'solid';
  const fill = solid ? (p ? p.fill : WIRE.chrome) : (variant === 'ghost' ? 'transparent' : WIRE.paper);
  const stroke = variant === 'ghost' ? 'transparent' : (p ? p.stroke : WIRE.edge);
  const glyph = solid && p ? p.stroke : (p ? p.stroke : WIRE.strong);
  const out = [];
  if (variant !== 'ghost') {
    if (shape === 'circle') out.push({ type: 'ellipse', x, y, width: size, height: size, strokeColor: stroke, backgroundColor: fill, fillStyle: 'solid', strokeWidth: 1.5 });
    else out.push(roundRect({ x, y, w: size, h: size, r: shape === 'square' ? 8 : size / 2, fill, stroke, strokeWidth: 1.5 }));
  }
  const is = iconSize || size * 0.5;
  out.push(...icon({ name, x: x + (size - is) / 2, y: y + (size - is) / 2, size: is, color: glyph, strokeWidth }));
  return G(box(out, x, y, size, size), 'iconbtn');
}

// ── device shells ─────────────────────────────────────────────────────────
// Real proportions, so a phone mock reads as a phone and a layout drawn inside it is honest about
// how much room it actually has. aspect = h/w of the SCREEN (logical points).
const DEVICES = {
  iphone: { aspect: 852 / 393, w: 380, bezel: 11, radius: 0.13, island: true, home: true, status: true, label: 'iPhone' },
  ipad:   { aspect: 1194 / 834, w: 560, bezel: 16, radius: 0.05, camera: true, home: true, status: true, label: 'iPad' },
  mac:    { aspect: 900 / 1440, w: 920, bezel: 9, radius: 0.014, menubar: true, notch: true, base: true, label: 'Mac' },
};

/** A device shell with real proportions. Returns `.inner = {x,y,w,h}` — the SAFE content region
 *  (inside the bezel, below the status bar / notch, above the home indicator). Place children there
 *  (via stack/row) and they cannot hit the chrome. `screen` is the full screen rect if you need it. */
function device(o) {
  const {
    kind = 'iphone', x = 0, y = 0, w = null, h = null, label = null, labelSize = 14,
    time = '9:41', status = null, wallpaper = WIRE.paper, bezelColor = '#343a40', dark = false,
  } = o;
  const d = DEVICES[kind] || DEVICES.iphone;
  const bodyW = w || d.w;
  const bezel = Math.max(4, Math.round(d.bezel * (bodyW / d.w)));
  const screenW = bodyW - bezel * 2;
  const screenH = h ? h - bezel * 2 : Math.round(screenW * d.aspect);
  const bodyH = screenH + bezel * 2;
  const r = Math.round(bodyW * d.radius) + bezel;
  const out = [];
  // caption above the device
  let top = y;
  if (label || d.label) {
    const t = label || d.label;
    out.push(txt({ x, y: top, text: t, fontSize: labelSize, color: WIRE.text, width: bodyW, align: 'center' }));
    top += labelSize * LH + 8;
  }
  // body (filled polygon: exact corner radius, which a rect's adaptive roundness can't reach)
  out.push(roundRect({ x, y: top, w: bodyW, h: bodyH, r, fill: bezelColor, stroke: '#212529', strokeWidth: 2, seg: 8 }));
  const sx = x + bezel, sy = top + bezel;
  out.push(roundRect({ x: sx, y: sy, w: screenW, h: screenH, r: Math.max(2, r - bezel), fill: dark ? '#212529' : wallpaper, stroke: dark ? '#343a40' : WIRE.line, strokeWidth: 1, seg: 8 }));

  let innerTop = sy, innerBottom = sy + screenH;
  const fg = dark ? '#f1f3f5' : INK;
  const SB_H = 20;

  // Status marks live in an explicit band [top, top+h] and the caller advances innerTop past it.
  // (Deriving the band from innerTop and then rewinding innerTop is how the time ended up sitting on
  // the first row of content — the audit caught it at 73%.)
  const statusBand = (top, h) => {
    out.push(txt({ x: sx + 14, y: top + (h - 12 * LH) / 2, text: time, fontSize: 12, color: fg, width: 60, align: 'left' }));
    const bx = sx + screenW - 52, by = top + h / 2 - 5;
    for (let i = 0; i < 3; i++) out.push({ type: 'rectangle', x: bx + i * 5, y: by + 8 - i * 2.5, width: 3, height: 3 + i * 2.5, strokeColor: fg, backgroundColor: fg, fillStyle: 'solid', strokeWidth: 1 });
    out.push(rc(bx + 22, by + 1, 18, 9, fg, 1));
    out.push({ type: 'rectangle', x: bx + 24, y: by + 3, width: 10, height: 5, strokeColor: fg, backgroundColor: fg, fillStyle: 'solid', strokeWidth: 1 });
  };
  const wantStatus = d.status && status !== false;

  if (d.island) {
    // dynamic island: a pill inset from the top; the status marks sit BESIDE it, in its own band
    const iw = screenW * 0.34, ih = Math.max(18, screenW * 0.075), iy = sy + Math.max(8, screenW * 0.026);
    out.push(roundRect({ x: sx + (screenW - iw) / 2, y: iy, w: iw, h: ih, r: ih / 2, fill: '#212529', stroke: '#212529', strokeWidth: 1 }));
    if (wantStatus) statusBand(iy, ih);
    innerTop = iy + ih + 8;
  } else {
    let bandTop = sy;
    if (d.camera) { out.push(dot(sx + screenW / 2, sy + 11, 4, WIRE.hint)); bandTop = sy + 22; }
    if (d.notch) { const nw = screenW * 0.16, nh = 12; out.push({ type: 'rectangle', x: sx + (screenW - nw) / 2, y: sy, width: nw, height: nh, strokeColor: '#212529', backgroundColor: '#212529', fillStyle: 'solid', strokeWidth: 1 }); bandTop = sy + nh + 2; }
    if (wantStatus) { statusBand(bandTop, SB_H); bandTop += SB_H; }
    innerTop = bandTop + 4;
  }
  if (d.menubar) {
    const mbH = 22;
    out.push({ type: 'rectangle', x: sx, y: innerTop, width: screenW, height: mbH, strokeColor: WIRE.line, backgroundColor: WIRE.chrome, fillStyle: 'solid', strokeWidth: 1 });
    ['#ff5f57', '#febc2e', '#28c840'].forEach((c, i) => out.push(dot(sx + 14 + i * 14, innerTop + mbH / 2, 4, c)));
    out.push(txt({ x: sx + 60, y: innerTop + 4, text: label || 'Finder', fontSize: 11, color: WIRE.text, width: 120, align: 'left' }));
    innerTop += mbH;
  }
  if (d.home) {
    const hw = screenW * 0.36, hh = 5;
    out.push(roundRect({ x: sx + (screenW - hw) / 2, y: sy + screenH - 12, w: hw, h: hh, r: hh / 2, fill: dark ? '#868e96' : '#adb5bd', stroke: 'transparent', strokeWidth: 1 }));
    innerBottom = sy + screenH - 20;
  }
  if (d.base) {
    // laptop foot — what makes a display read as a Mac
    const baseH = 12, lipW = bodyW * 1.06;
    out.push({ type: 'line', points: [[x - (lipW - bodyW) / 2, top + bodyH], [x + bodyW + (lipW - bodyW) / 2, top + bodyH], [x + bodyW + (lipW - bodyW) / 2 - 18, top + bodyH + baseH], [x + (lipW - bodyW) / 2 - 12, top + bodyH + baseH], [x - (lipW - bodyW) / 2, top + bodyH]], strokeColor: '#212529', backgroundColor: '#adb5bd', fillStyle: 'solid', strokeWidth: 2 });
  }

  const inner = { x: sx + 8, y: innerTop + 6, w: screenW - 16, h: Math.max(20, innerBottom - innerTop - 12) };
  const screen = { x: sx, y: sy, w: screenW, h: screenH };

  // `content` is the safe way to fill a screen: the callback receives `inner`, and anything that
  // escapes the glass gets reported. The build-time audit CANNOT see this on its own — the shell is a
  // filled polygon, and isOpaqueBox() only knows rect/ellipse/diamond/image — so a hardcoded child
  // width that overflows the bezel would otherwise ship looking clean.
  if (typeof o.content === 'function') {
    const kids = [].concat(...[].concat(o.content(inner)));
    if (kids.length) {
      const b = bbox(kids);
      const over = [
        b.x < screen.x - 1 && 'left', b.y < screen.y - 1 && 'top',
        b.x + b.w > screen.x + screen.w + 1 && 'right', b.y + b.h > screen.y + screen.h + 1 && 'bottom',
      ].filter(Boolean);
      if (over.length) {
        const by = Math.round(Math.max(b.x + b.w - (screen.x + screen.w), b.y + b.h - (screen.y + screen.h), screen.x - b.x, screen.y - b.y));
        try {
          console.warn(`[excalidraw] device(${kind}): content escapes the screen on the ${over.join('/')} by ~${by}px — it will render outside the bezel.\n  Fix: size children from the \`inner\` you were handed (inner.w=${Math.round(inner.w)}), don't hardcode widths.`);
        } catch (e) {}
      }
      out.push(...kids);
    }
  }

  const els = box(out, x, y, bodyW, (top - y) + bodyH + (d.base ? 12 : 0));
  els.inner = inner;
  els.screen = screen;
  return G(els, 'device');
}

// ── app chrome ────────────────────────────────────────────────────────────
/** Mobile top bar: optional back chevron, centred title, trailing icon buttons. */
function appBar(o) {
  const { x = 0, y = 0, w = 340, h = 44, title = '', back = false, actions = [], fontSize = 15, border = true, fill = WIRE.paper } = o;
  const out = [{ type: 'rectangle', x, y, width: w, height: h, strokeColor: border ? WIRE.line : 'transparent', backgroundColor: fill, fillStyle: 'solid', strokeWidth: 1, roundness: false }];
  if (back) out.push(...iconButton({ x: x + 4, y: y + (h - 32) / 2, size: 32, icon: 'chevron-left', variant: 'ghost' }));
  if (title) out.push(txt({ x, y: y + (h - fontSize * LH) / 2, text: title, fontSize, width: w, align: 'center' }));
  actions.slice(0, 3).forEach((a, i) => {
    out.push(...iconButton({ x: x + w - 8 - (i + 1) * 34, y: y + (h - 32) / 2, size: 32, icon: typeof a === 'string' ? a : a.icon, variant: 'ghost' }));
  });
  return G(box(out, x, y, w, h), 'appbar');
}

/** Bottom tab bar. `items` are icon names or {icon,label}; `active` is the index that reads selected. */
function tabBar(o) {
  const { x = 0, y = 0, w = 340, h = 52, items = [], active = 0, color = 'blue', fontSize = 10, fill = WIRE.paper } = o;
  const p = pal(color);
  const out = [{ type: 'rectangle', x, y, width: w, height: h, strokeColor: WIRE.line, backgroundColor: fill, fillStyle: 'solid', strokeWidth: 1, roundness: false }];
  const n = Math.max(1, items.length);
  const cw = w / n;
  items.forEach((it, i) => {
    const name = typeof it === 'string' ? it : it.icon;
    const label = typeof it === 'string' ? null : it.label;
    const on = i === active;
    const k = on ? p.stroke : WIRE.hint;
    const is = 20;
    out.push(...icon({ name, x: x + i * cw + (cw - is) / 2, y: y + (label ? 7 : (h - is) / 2), size: is, color: k, strokeWidth: on ? 2 : 1.5 }));
    if (label) out.push(txt({ x: x + i * cw, y: y + 31, text: label, fontSize, color: k, width: cw, align: 'center' }));
  });
  return G(box(out, x, y, w, h), 'tabbar');
}

// ── form controls ─────────────────────────────────────────────────────────
// Truncate to a pixel width with an ellipsis. A row is ONE line by definition, so an over-long title
// has to be cut — but it must LOOK cut. Wrapping and keeping line 1 (what this used to do) turned
// "Yıldızlı" into "Yıldız" with no hint anything was lost.
function clip(s, fontSize, w) {
  const str = String(s == null ? '' : s);
  if (!str || measureText(str, fontSize) <= w) return str;
  let acc = '';
  for (const ch of str) {
    if (measureText(acc + ch + '…', fontSize) > w) break;
    acc += ch;
  }
  return acc.replace(/\s+$/, '') + '…';
}

/** A list/table row: leading icon or avatar, title + subtitle, trailing chevron/toggle/text. */
function listRow(o) {
  const {
    x = 0, y = 0, w = 340, h = 56, title = '', subtitle = null, leading = null, trailing = 'chevron-right',
    fontSize = 14, subSize = 12, divider: rule = true,
  } = o;
  const out = [{ type: 'rectangle', x, y, width: w, height: h, strokeColor: 'transparent', backgroundColor: WIRE.paper, fillStyle: 'solid', strokeWidth: 1, roundness: false }];
  let tx = x + 14;
  if (leading) {
    if (leading === 'avatar') { out.push(...avatar({ cx: x + 14 + 16, cy: y + h / 2, r: 16 })); tx = x + 14 + 40; }
    else { out.push(...icon({ name: leading, x: x + 14, y: y + (h - 20) / 2, size: 20, color: WIRE.strong })); tx = x + 14 + 32; }
  }
  const tw = w - (tx - x) - 46;
  if (subtitle) {
    out.push(txt({ x: tx, y: y + h / 2 - fontSize * LH + 2, text: clip(title, fontSize, tw), fontSize, width: tw, align: 'left' }));
    out.push(txt({ x: tx, y: y + h / 2 + 2, text: clip(subtitle, subSize, tw), fontSize: subSize, color: WIRE.text, width: tw, align: 'left' }));
  } else {
    out.push(txt({ x: tx, y: y + (h - fontSize * LH) / 2, text: clip(title, fontSize, tw), fontSize, width: tw, align: 'left' }));
  }
  if (trailing === 'toggle') out.push(...toggle({ x: x + w - 58, y: y + (h - 28) / 2, on: true }));
  else if (typeof trailing === 'string' && ICONS[trailing]) out.push(...icon({ name: trailing, x: x + w - 30, y: y + (h - 16) / 2, size: 16, color: WIRE.hint }));
  else if (trailing) out.push(txt({ x: x + w - 110, y: y + (h - subSize * LH) / 2, text: String(trailing), fontSize: subSize, color: WIRE.text, width: 96, align: 'right' }));
  if (rule) out.push({ type: 'line', points: [[tx, y + h], [x + w, y + h]], strokeColor: WIRE.line, strokeWidth: 1 });
  return G(box(out, x, y, w, h), 'listrow');
}

/** iOS-style switch. */
function toggle(o) {
  const { x = 0, y = 0, w = 48, h = 28, on = false, color = 'green' } = o;
  const p = pal(color);
  const out = [roundRect({ x, y, w, h, r: h / 2, fill: on ? p.fill : WIRE.line, stroke: on ? p.stroke : WIRE.edge, strokeWidth: 1.5 })];
  const kr = h / 2 - 3;
  out.push({ type: 'ellipse', x: on ? x + w - kr * 2 - 3 : x + 3, y: y + 3, width: kr * 2, height: kr * 2, strokeColor: WIRE.edge, backgroundColor: '#ffffff', fillStyle: 'solid', strokeWidth: 1 });
  return G(box(out, x, y, w, h), 'toggle');
}

/** Segmented control — the mobile tab picker. */
function segmented(o) {
  const { x = 0, y = 0, w = 300, h = 34, items = [], active = 0, fontSize = 13, color = 'blue' } = o;
  const p = pal(color);
  const out = [roundRect({ x, y, w, h, r: 8, fill: WIRE.chrome, stroke: WIRE.edge, strokeWidth: 1.5 })];
  const n = Math.max(1, items.length), cw = (w - 6) / n;
  items.forEach((it, i) => {
    const on = i === active;
    if (on) out.push(roundRect({ x: x + 3 + i * cw, y: y + 3, w: cw, h: h - 6, r: 6, fill: p.fill, stroke: p.stroke, strokeWidth: 1 }));
    out.push(txt({ x: x + 3 + i * cw, y: y + (h - fontSize * LH) / 2, text: String(it), fontSize, color: on ? p.stroke : WIRE.text, width: cw, align: 'center' }));
  });
  return G(box(out, x, y, w, h), 'segmented');
}

/** A slider at `value` (0..1). */
function slider(o) {
  const { x = 0, y = 0, w = 260, value = 0.5, color = 'blue', knob = 11 } = o;
  const p = pal(color);
  const cy = y + knob;
  const v = Math.max(0, Math.min(1, value));
  const out = [
    roundRect({ x, y: cy - 2, w, h: 4, r: 2, fill: WIRE.line, stroke: 'transparent', strokeWidth: 1 }),
    roundRect({ x, y: cy - 2, w: Math.max(2, w * v), h: 4, r: 2, fill: p.stroke, stroke: 'transparent', strokeWidth: 1 }),
    { type: 'ellipse', x: x + w * v - knob, y: cy - knob, width: knob * 2, height: knob * 2, strokeColor: WIRE.edge, backgroundColor: '#ffffff', fillStyle: 'solid', strokeWidth: 1.5 },
  ];
  return G(box(out, x, y, w, knob * 2), 'slider');
}

/** A search field — an input with a magnifier, the most-drawn control in mobile wireframes. */
function searchField(o) {
  const { x = 0, y = 0, w = 300, h = 36, placeholder = 'Search', fontSize = 13 } = o;
  const out = [roundRect({ x, y, w, h, r: h / 2, fill: WIRE.chrome, stroke: WIRE.edge, strokeWidth: 1.5 })];
  out.push(...icon({ name: 'search', x: x + 12, y: y + (h - 15) / 2, size: 15, color: WIRE.hint }));
  out.push(txt({ x: x + 36, y: y + (h - fontSize * LH) / 2, text: placeholder, fontSize, color: WIRE.hint, width: w - 48, align: 'left' }));
  return G(box(out, x, y, w, h), 'search');
}

module.exports = {
  // devices + chrome
  device, DEVICES, appBar, tabBar,
  // icons
  icon, iconButton, ICONS, iconNames,
  // controls
  listRow, toggle, segmented, slider, searchField,
  // geometry / text helpers
  clip,
  roundRect, roundRectPoints,
  // re-exported from style.js so one require gives the whole UI kit
  windowFrame, navbar, button, input, textRows, imagePlaceholder, avatar, chip, divider,
};
