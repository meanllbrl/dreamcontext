// Deterministic chart kit for Excalidraw boards. Same contract as style.js: every builder returns an
// ElementSpec[] that also carries `.x/.y/.w/.h/.nextX/.nextY`, so charts compose inside stack()/row()
// exactly like cards and funnels do.
//
// Why this exists: hand-rolling a chart out of raw rects+text is where boards break. The measure rule
// gets violated, labels collide with bars, axes drift. These builders own the geometry so the author
// only supplies DATA. Nothing here is random or time-dependent — same input ⇒ same bytes.
//
// Excalidraw has no arc primitive, so wedges/rings are emitted as filled polygons (`line` with
// backgroundColor + fillStyle:'solid'), the same trick funnel() uses for its trapezoids.
//
// Every chart:
//   - keeps its own text inside its own box (labels are measured, never assumed)
//   - colors by the semantic PALETTE (or an explicit per-series color)
//   - degrades sanely on empty/1-point data instead of dividing by zero

const {
  INK, PALETTE, WIRE, READ_W, pal,
  measureText, wrapToWidth, fitText, box, bbox, translate,
} = require('./style.js');

const LH = 1.25;
const FONT = 5; // Excalifont — matches the house style

// default series color cycle (semantic palette, in a visually distinguishable order)
const CYCLE = ['blue', 'red', 'green', 'purple', 'yellow', 'mint', 'gray'];
const cyc = (i) => CYCLE[i % CYCLE.length];

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);
const txt = (o) => Object.assign({ type: 'text', fontFamily: FONT, color: INK }, o);

// Tag a composite's elements with ONE group id: the chart moves as a unit in Excalidraw, and the
// build-time auditors treat its own internals (label over its own bar, dot over its own tint) as
// intentional rather than a collision. Nested composites keep the group they already have.
let _gc = 0;
function G(els, hint) {
  const g = `chart${++_gc}-${hint}`;
  for (const e of els) if (e.group == null) e.group = g;
  return els;
}


// ── scales ────────────────────────────────────────────────────────────────
// A linear map d0..d1 → r0..r1. Degenerate domains collapse to the range midpoint rather than NaN.
function linScale(d0, d1, r0, r1) {
  const dd = d1 - d0;
  if (!isFinite(dd) || dd === 0) return () => (r0 + r1) / 2;
  return (v) => r0 + ((num(v) - d0) / dd) * (r1 - r0);
}

// "Nice" axis bounds: expand [min,max] to round numbers and emit evenly spaced ticks.
function niceScale(min, max, count = 5) {
  let lo = num(min), hi = num(max);
  if (lo === hi) { hi = lo + 1; }
  if (hi < lo) { const t = lo; lo = hi; hi = t; }
  const raw = (hi - lo) / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const nlo = Math.floor(lo / step) * step;
  const nhi = Math.ceil(hi / step) * step;
  const ticks = [];
  // toFixed guards float drift (0.1+0.2) so tick labels read clean
  const dp = Math.max(0, -Math.floor(Math.log10(step)));
  for (let v = nlo; v <= nhi + step / 1e6; v += step) ticks.push(Number(v.toFixed(dp + 2)));
  return { min: nlo, max: nhi, step, ticks, dp };
}

// Compact axis label: 12500 → 12.5K, 3_400_000 → 3.4M
function fmtNum(v, dp = 0) {
  const n = num(v);
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return dp > 0 ? n.toFixed(dp) : String(Math.round(n * 100) / 100);
}

// ── shared chrome ─────────────────────────────────────────────────────────
// Title + optional legend above a plot. Returns { els, top } where `top` is the first free y.
function chartHead({ x, y, w, title, titleSize = 20, legend = null, legendSize = 13 }) {
  const els = [];
  let cy = y;
  let used = w;
  if (title) {
    // a narrow chart (heatmap, donut) must not shred its title into 3 lines — let the title set the
    // width and report it, so the caller's box grows instead of the text wrapping to nothing
    const tw = Math.max(w, Math.min(measureText(String(title), titleSize) + 4, READ_W * 1.6));
    const t = wrapToWidth(title, titleSize, tw);
    els.push(txt({ x, y: cy, text: t, fontSize: titleSize, width: tw, align: 'left' }));
    cy += t.split('\n').length * titleSize * LH + 8;
    used = Math.max(used, tw);
  }
  if (legend && legend.length) {
    let lx = x;
    const sw = 14, sgap = 6, igap = 18;
    for (const s of legend) {
      const p = pal(s.color);
      const tw = measureText(s.label, legendSize);
      els.push({ type: 'rectangle', x: lx, y: cy + 2, width: sw, height: sw, strokeColor: p.stroke, backgroundColor: p.fill, fillStyle: 'solid', strokeWidth: 1.5, roundness: true });
      els.push(txt({ x: lx + sw + sgap, y: cy, text: s.label, fontSize: legendSize, color: WIRE.strong, width: tw + 4, align: 'left' }));
      lx += sw + sgap + tw + igap;
    }
    cy += legendSize * LH + 10;
  }
  return { els, top: cy, w: used };
}

// The plot rectangle + axes + gridlines + tick labels. This is the piece every xy chart shares, so
// axis geometry is defined once instead of re-derived (and re-broken) per chart.
//   yScale : {min,max,ticks,dp} from niceScale
//   xLabels: categorical labels drawn under the axis (optional)
// Returns { els, px, py, pw, ph, sy } — sy maps a value to a canvas y.
function plotFrame({
  x, y, w, h, yScale, xLabels = [], grid = true, yFmt = fmtNum,
  labelSize = 12, xLabelRotate = false, padR = 16, padT = 8, yTitle = null, xTitle = null,
}) {
  const els = [];
  const yLabels = yScale.ticks.map((t) => yFmt(t, yScale.dp));
  const padL = Math.max(...yLabels.map((l) => measureText(l, labelSize))) + 14 + (yTitle ? labelSize * LH + 8 : 0);
  // x labels sit under the axis; rotated labels need the longest label's width as height
  const xLabH = xLabels.length
    ? (xLabelRotate ? Math.max(...xLabels.map((l) => measureText(String(l), labelSize))) * 0.72 + 10 : labelSize * LH + 8)
    : 6;
  const padB = xLabH + (xTitle ? labelSize * LH + 8 : 0);
  const px = x + padL, py = y + padT;
  const pw = Math.max(40, w - padL - padR), ph = Math.max(40, h - padT - padB);
  const sy = linScale(yScale.min, yScale.max, py + ph, py);

  // gridlines + y ticks
  yScale.ticks.forEach((t, i) => {
    const gy = sy(t);
    if (grid) els.push({ type: 'line', points: [[px, gy], [px + pw, gy]], strokeColor: WIRE.line, strokeWidth: 1 });
    els.push(txt({ x: px - measureText(yLabels[i], labelSize) - 10, y: gy - labelSize * 0.62, text: yLabels[i], fontSize: labelSize, color: WIRE.text, width: measureText(yLabels[i], labelSize) + 4, align: 'right' }));
  });
  // axes
  els.push({ type: 'line', points: [[px, py], [px, py + ph]], strokeColor: WIRE.edge, strokeWidth: 1.5 });
  els.push({ type: 'line', points: [[px, py + ph], [px + pw, py + ph]], strokeColor: WIRE.edge, strokeWidth: 1.5 });
  if (yTitle) els.push(txt({ x, y: py + ph / 2 - labelSize, text: yTitle, fontSize: labelSize, color: WIRE.strong, width: padL - 10, align: 'left' }));
  if (xTitle) els.push(txt({ x: px, y: py + ph + xLabH + 2, text: xTitle, fontSize: labelSize, color: WIRE.strong, width: pw, align: 'center' }));
  return { els, px, py, pw, ph, sy, padL, padB };
}

// Place categorical x labels centered on given canvas x positions, skipping some when they'd collide.
function xTickLabels({ xs, labels, py, ph, labelSize = 12 }) {
  const els = [];
  if (!labels.length) return els;
  // thin out labels until neighbours stop overlapping — a dense x axis stays readable
  const widest = Math.max(...labels.map((l) => measureText(String(l), labelSize)));
  const gapAvail = xs.length > 1 ? Math.abs(xs[1] - xs[0]) : widest + 10;
  const every = Math.max(1, Math.ceil((widest + 8) / Math.max(1, gapAvail)));
  labels.forEach((l, i) => {
    if (i % every !== 0 && i !== labels.length - 1) return;
    const tw = measureText(String(l), labelSize) + 4;
    els.push(txt({ x: xs[i] - tw / 2, y: py + ph + 8, text: String(l), fontSize: labelSize, color: WIRE.text, width: tw, align: 'center' }));
  });
  return els;
}

// ── lineChart ─────────────────────────────────────────────────────────────
// Trend over an ordered x axis. `series[].points` is a plain number[] aligned to `xLabels`
// (or [{x,y}] for irregular spacing). Use for time series: DAU, spend, error rate.
function lineChart(o) {
  const {
    x = 0, y = 0, w = 720, h = 360, series = [], xLabels = [], title = null,
    yMin = null, yMax = null, yTicks = 5, grid = true, markers = true, area = false,
    legend = true, strokeWidth = 2.5, labelSize = 12, yFmt = fmtNum, xTitle = null, yTitle = null,
    xLabelRotate = false,
  } = o;
  const S = series.map((s, i) => ({
    label: s.label || `series ${i + 1}`,
    color: s.color || cyc(i),
    pts: (s.points || []).map((p, k) => (typeof p === 'number' ? { x: k, y: p } : { x: num(p.x), y: num(p.y) })),
  }));
  const all = S.flatMap((s) => s.pts.map((p) => p.y));
  const lo = yMin != null ? yMin : Math.min(0, ...(all.length ? all : [0]));
  const hi = yMax != null ? yMax : Math.max(...(all.length ? all : [1]));
  const yScale = niceScale(lo, hi, yTicks);
  const head = chartHead({ x, y, w, title, legend: legend && S.length > 1 ? S : null });
  const fr = plotFrame({ x, y: head.top, w, h: h - (head.top - y), yScale, xLabels, grid, yFmt, labelSize, xTitle, yTitle, xLabelRotate });
  const els = [...head.els, ...fr.els];

  const xDom = S.flatMap((s) => s.pts.map((p) => p.x));
  const sx = linScale(Math.min(...(xDom.length ? xDom : [0])), Math.max(...(xDom.length ? xDom : [1])), fr.px, fr.px + fr.pw);
  for (const s of S) {
    if (!s.pts.length) continue;
    const p = pal(s.color);
    const pts = s.pts.map((q) => [sx(q.x), fr.sy(q.y)]);
    if (area && pts.length > 1) {
      els.push({
        type: 'line', strokeColor: 'transparent', backgroundColor: p.fill, fillStyle: 'solid', strokeWidth: 1,
        points: [...pts, [pts[pts.length - 1][0], fr.py + fr.ph], [pts[0][0], fr.py + fr.ph], pts[0]],
      });
    }
    if (pts.length > 1) els.push({ type: 'line', points: pts, strokeColor: p.stroke, strokeWidth });
    if (markers) for (const [mx, my] of pts) {
      els.push({ type: 'ellipse', x: mx - 4, y: my - 4, width: 8, height: 8, strokeColor: p.stroke, backgroundColor: p.stroke, fillStyle: 'solid', strokeWidth: 1 });
    }
  }
  if (xLabels.length) els.push(...xTickLabels({ xs: xLabels.map((_, i) => sx(i)), labels: xLabels, py: fr.py, ph: fr.ph, labelSize }));
  return G(box(els, x, y, w, Math.max(h, fr.py + fr.ph + fr.padB - y)), 'xy');
}

// ── barChart ──────────────────────────────────────────────────────────────
// One value per category. `horizontal:true` when labels are long (they get their own column instead
// of being crammed under vertical bars).
function barChart(o) {
  const {
    x = 0, y = 0, w = 720, h = 360, bars = [], title = null, horizontal = false,
    yMin = null, yMax = null, yTicks = 5, grid = true, valueLabels = true, color = 'blue',
    labelSize = 12, valueSize = 13, yFmt = fmtNum, barGap = 0.3, xTitle = null, yTitle = null,
  } = o;
  const B = bars.map((b, i) => ({ label: String(b.label ?? i), value: num(b.value), color: b.color || color }));
  const vals = B.map((b) => b.value);
  const lo = yMin != null ? yMin : Math.min(0, ...(vals.length ? vals : [0]));
  const hi = yMax != null ? yMax : Math.max(...(vals.length ? vals : [1]));
  const scale = niceScale(lo, hi, yTicks);
  const head = chartHead({ x, y, w, title });
  const els = [...head.els];

  if (horizontal) {
    // labels in a left gutter, bars run rightwards
    const labelW = Math.min(READ_W / 2, Math.max(...B.map((b) => measureText(b.label, labelSize))) + 12);
    const px = x + labelW + 8, pw = Math.max(40, w - labelW - 60);
    const top = head.top, ph = Math.max(40, h - (top - y) - 24);
    const sxv = linScale(scale.min, scale.max, px, px + pw);
    const band = ph / Math.max(1, B.length);
    const bh = band * (1 - barGap);
    if (grid) for (const t of scale.ticks) {
      els.push({ type: 'line', points: [[sxv(t), top], [sxv(t), top + ph]], strokeColor: WIRE.line, strokeWidth: 1 });
      const l = yFmt(t, scale.dp), tw = measureText(l, labelSize) + 4;
      els.push(txt({ x: sxv(t) - tw / 2, y: top + ph + 6, text: l, fontSize: labelSize, color: WIRE.text, width: tw, align: 'center' }));
    }
    B.forEach((b, i) => {
      const p = pal(b.color);
      const by = top + i * band + (band - bh) / 2;
      const x0 = sxv(Math.max(scale.min, Math.min(0, b.value))), x1 = sxv(b.value);
      els.push({ type: 'rectangle', x: Math.min(x0, x1), y: by, width: Math.max(2, Math.abs(x1 - x0)), height: bh, strokeColor: p.stroke, backgroundColor: p.fill, fillStyle: 'solid', strokeWidth: 2, roundness: true });
      els.push(txt({ x, y: by + bh / 2 - labelSize * 0.62, text: b.label, fontSize: labelSize, color: WIRE.strong, width: labelW, align: 'right' }));
      if (valueLabels) els.push(txt({ x: Math.max(x0, x1) + 8, y: by + bh / 2 - valueSize * 0.62, text: yFmt(b.value, scale.dp), fontSize: valueSize, color: INK, width: 80, align: 'left' }));
    });
    els.push({ type: 'line', points: [[sxv(Math.max(scale.min, 0)), top], [sxv(Math.max(scale.min, 0)), top + ph]], strokeColor: WIRE.edge, strokeWidth: 1.5 });
    return G(box(els, x, y, w, top + ph + 26 - y), 'barh');
  }

  const fr = plotFrame({ x, y: head.top, w, h: h - (head.top - y), yScale: scale, xLabels: B.map((b) => b.label), grid, yFmt, labelSize, xTitle, yTitle });
  els.push(...fr.els);
  const band = fr.pw / Math.max(1, B.length);
  const bw = band * (1 - barGap);
  const zero = fr.sy(Math.max(scale.min, Math.min(0, ...vals, 0)));
  B.forEach((b, i) => {
    const p = pal(b.color);
    const bx = fr.px + i * band + (band - bw) / 2;
    const vy = fr.sy(b.value);
    els.push({ type: 'rectangle', x: bx, y: Math.min(vy, zero), width: bw, height: Math.max(2, Math.abs(zero - vy)), strokeColor: p.stroke, backgroundColor: p.fill, fillStyle: 'solid', strokeWidth: 2, roundness: true });
    if (valueLabels) {
      const l = yFmt(b.value, scale.dp), tw = measureText(l, valueSize) + 6;
      els.push(txt({ x: bx + bw / 2 - tw / 2, y: Math.min(vy, zero) - valueSize * LH - 3, text: l, fontSize: valueSize, width: tw, align: 'center' }));
    }
  });
  els.push(...xTickLabels({ xs: B.map((_, i) => fr.px + i * band + band / 2), labels: B.map((b) => b.label), py: fr.py, ph: fr.ph, labelSize }));
  return box(els, x, y, w, Math.max(h, fr.py + fr.ph + fr.padB - y));
}

// ── barCompare ────────────────────────────────────────────────────────────
// Grouped bars: the same categories measured across 2+ scenarios (W1 vs W2, before/after, plan/actual).
// This is the "did it move?" chart — the one a weekly review actually needs.
function barCompare(o) {
  const {
    x = 0, y = 0, w = 720, h = 380, groups = [], seriesLabels = [], title = null,
    yMin = null, yMax = null, yTicks = 5, grid = true, valueLabels = true, colors = null,
    labelSize = 12, valueSize = 12, yFmt = fmtNum, groupGap = 0.3, legend = true, yTitle = null,
  } = o;
  const G = groups.map((g, i) => ({ label: String(g.label ?? i), values: (g.values || []).map(num) }));
  const nS = Math.max(0, ...G.map((g) => g.values.length));
  const sLabels = Array.from({ length: nS }, (_, i) => seriesLabels[i] || `s${i + 1}`);
  const sColors = Array.from({ length: nS }, (_, i) => (colors && colors[i]) || cyc(i));
  const vals = G.flatMap((g) => g.values);
  const lo = yMin != null ? yMin : Math.min(0, ...(vals.length ? vals : [0]));
  const hi = yMax != null ? yMax : Math.max(...(vals.length ? vals : [1]));
  const scale = niceScale(lo, hi, yTicks);
  const head = chartHead({ x, y, w, title, legend: legend ? sLabels.map((l, i) => ({ label: l, color: sColors[i] })) : null });
  const fr = plotFrame({ x, y: head.top, w, h: h - (head.top - y), yScale: scale, xLabels: G.map((g) => g.label), grid, yFmt, labelSize, yTitle });
  const els = [...head.els, ...fr.els];
  const band = fr.pw / Math.max(1, G.length);
  const inner = band * (1 - groupGap);
  const bw = inner / Math.max(1, nS);
  const zero = fr.sy(Math.max(scale.min, 0));
  G.forEach((g, gi) => {
    g.values.forEach((v, si) => {
      const p = pal(sColors[si]);
      const bx = fr.px + gi * band + (band - inner) / 2 + si * bw;
      const vy = fr.sy(v);
      els.push({ type: 'rectangle', x: bx + 1, y: Math.min(vy, zero), width: Math.max(2, bw - 2), height: Math.max(2, Math.abs(zero - vy)), strokeColor: p.stroke, backgroundColor: p.fill, fillStyle: 'solid', strokeWidth: 2, roundness: true });
      if (valueLabels && bw > 26) {
        const l = yFmt(v, scale.dp), tw = measureText(l, valueSize) + 4;
        els.push(txt({ x: bx + bw / 2 - tw / 2, y: Math.min(vy, zero) - valueSize * LH - 2, text: l, fontSize: valueSize, width: tw, align: 'center' }));
      }
    });
  });
  els.push(...xTickLabels({ xs: G.map((_, i) => fr.px + i * band + band / 2), labels: G.map((g) => g.label), py: fr.py, ph: fr.ph, labelSize }));
  return box(els, x, y, w, Math.max(h, fr.py + fr.ph + fr.padB - y));
}

// ── stackedBar ────────────────────────────────────────────────────────────
// Composition per category (revenue by plan, traffic by source). Segments stack to each group's total.
function stackedBar(o) {
  const {
    x = 0, y = 0, w = 720, h = 380, groups = [], seriesLabels = [], title = null,
    yTicks = 5, grid = true, colors = null, labelSize = 12, yFmt = fmtNum, barGap = 0.35,
    legend = true, totals = true, valueSize = 12, yTitle = null,
  } = o;
  const G = groups.map((g, i) => ({ label: String(g.label ?? i), values: (g.values || []).map(num) }));
  const nS = Math.max(0, ...G.map((g) => g.values.length));
  const sLabels = Array.from({ length: nS }, (_, i) => seriesLabels[i] || `s${i + 1}`);
  const sColors = Array.from({ length: nS }, (_, i) => (colors && colors[i]) || cyc(i));
  const sums = G.map((g) => g.values.reduce((a, b) => a + b, 0));
  const scale = niceScale(0, Math.max(...(sums.length ? sums : [1])), yTicks);
  const head = chartHead({ x, y, w, title, legend: legend ? sLabels.map((l, i) => ({ label: l, color: sColors[i] })) : null });
  const fr = plotFrame({ x, y: head.top, w, h: h - (head.top - y), yScale: scale, xLabels: G.map((g) => g.label), grid, yFmt, labelSize, yTitle });
  const els = [...head.els, ...fr.els];
  const band = fr.pw / Math.max(1, G.length);
  const bw = band * (1 - barGap);
  G.forEach((g, gi) => {
    const bx = fr.px + gi * band + (band - bw) / 2;
    let acc = 0;
    g.values.forEach((v, si) => {
      const p = pal(sColors[si]);
      const y0 = fr.sy(acc), y1 = fr.sy(acc + v);
      if (Math.abs(y0 - y1) >= 1) {
        els.push({ type: 'rectangle', x: bx, y: Math.min(y0, y1), width: bw, height: Math.max(1, Math.abs(y0 - y1)), strokeColor: p.stroke, backgroundColor: p.fill, fillStyle: 'solid', strokeWidth: 1.5, roundness: false });
      }
      acc += v;
    });
    if (totals) {
      const l = yFmt(sums[gi], scale.dp), tw = measureText(l, valueSize) + 4;
      els.push(txt({ x: bx + bw / 2 - tw / 2, y: fr.sy(sums[gi]) - valueSize * LH - 3, text: l, fontSize: valueSize, width: tw, align: 'center' }));
    }
  });
  els.push(...xTickLabels({ xs: G.map((_, i) => fr.px + i * band + band / 2), labels: G.map((g) => g.label), py: fr.py, ph: fr.ph, labelSize }));
  return box(els, x, y, w, Math.max(h, fr.py + fr.ph + fr.padB - y));
}

// ── gantt ─────────────────────────────────────────────────────────────────
// Timeline bars over a date axis. `start`/`end` accept 'YYYY-MM-DD' or a day number; the axis ticks
// are derived, never hand-placed. `done` (0..1) overlays a progress fill; `milestone:true` draws a diamond.
function parseDay(v, origin) {
  if (typeof v === 'number') return v;
  const t = Date.parse(String(v) + (/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? 'T00:00:00Z' : ''));
  if (!isFinite(t)) return 0;
  return Math.round(t / 86400000) - origin;
}
function gantt(o) {
  const {
    x = 0, y = 0, w = 860, tasks = [], title = null, rowH = 34, rowGap = 8,
    labelSize = 13, tickSize = 11, ticks = 6, grid = true, today = null, color = 'blue',
  } = o;
  // resolve every date against the earliest date so the axis is plain day-offsets
  const stamps = tasks.flatMap((t) => [t.start, t.end]).filter((v) => typeof v === 'string');
  const origin = stamps.length ? Math.min(...stamps.map((s) => Math.round(Date.parse(s + 'T00:00:00Z') / 86400000))) : 0;
  const T = tasks.map((t, i) => ({
    label: String(t.label ?? i),
    s: parseDay(t.start, origin),
    e: parseDay(t.end != null ? t.end : t.start, origin),
    color: t.color || color,
    done: t.done != null ? Math.max(0, Math.min(1, num(t.done))) : null,
    milestone: !!t.milestone,
  }));
  const lo = Math.min(...(T.length ? T.map((t) => t.s) : [0]));
  const hi = Math.max(...(T.length ? T.map((t) => t.e) : [1]));
  const head = chartHead({ x, y, w, title });
  const els = [...head.els];
  const labelW = Math.min(READ_W / 2, Math.max(60, ...T.map((t) => measureText(t.label, labelSize))) + 14);
  const px = x + labelW + 10, pw = Math.max(60, w - labelW - 30);
  const top = head.top + tickSize * LH + 8;
  const sx = linScale(lo, hi === lo ? lo + 1 : hi, px, px + pw);
  const fmtDay = (d) => {
    if (!stamps.length) return String(Math.round(d));
    const dt = new Date((origin + d) * 86400000);
    return `${dt.getUTCDate()}/${dt.getUTCMonth() + 1}`;
  };
  // axis ticks across the span
  const span = (hi - lo) || 1;
  const step = Math.max(1, Math.round(span / Math.max(1, ticks)));
  const H = T.length * (rowH + rowGap) - rowGap;
  for (let d = lo; d <= hi + 0.001; d += step) {
    const gx = sx(d);
    if (grid) els.push({ type: 'line', points: [[gx, top], [gx, top + Math.max(0, H)]], strokeColor: WIRE.line, strokeWidth: 1 });
    const l = fmtDay(d), tw = measureText(l, tickSize) + 4;
    els.push(txt({ x: gx - tw / 2, y: head.top, text: l, fontSize: tickSize, color: WIRE.text, width: tw, align: 'center' }));
  }
  T.forEach((t, i) => {
    const by = top + i * (rowH + rowGap);
    const p = pal(t.color);
    els.push(txt({ x, y: by + rowH / 2 - labelSize * 0.62, text: t.label, fontSize: labelSize, color: WIRE.strong, width: labelW, align: 'right' }));
    if (t.milestone) {
      const cx = sx(t.s), r = rowH * 0.38;
      els.push({ type: 'diamond', x: cx - r, y: by + rowH / 2 - r, width: r * 2, height: r * 2, strokeColor: p.stroke, backgroundColor: p.fill, fillStyle: 'solid', strokeWidth: 2 });
      return;
    }
    const x0 = sx(t.s), x1 = Math.max(sx(t.e), x0 + 3);
    els.push({ type: 'rectangle', x: x0, y: by, width: x1 - x0, height: rowH, strokeColor: p.stroke, backgroundColor: p.fill, fillStyle: 'solid', strokeWidth: 2, roundness: true });
    if (t.done != null && t.done > 0) {
      els.push({ type: 'rectangle', x: x0, y: by + rowH * 0.3, width: Math.max(2, (x1 - x0) * t.done), height: rowH * 0.4, strokeColor: 'transparent', backgroundColor: p.stroke, fillStyle: 'solid', strokeWidth: 1, roundness: true });
    }
  });
  if (today != null) {
    const tx = sx(parseDay(today, origin));
    els.push({ type: 'line', points: [[tx, top - 6], [tx, top + Math.max(0, H)]], strokeColor: PALETTE.red.stroke, strokeWidth: 2, strokeStyle: 'dashed' });
  }
  return G(box(els, x, y, w, top + Math.max(0, H) - y), 'gantt');
}

// ── quadrant ──────────────────────────────────────────────────────────────
// 2×2 positioning map (impact/effort, reach/confidence, Eisenhower). `items[]` carry {label,x,y} in
// 0..1 (or supply xDomain/yDomain). Quadrant tints are fixed so "top-right = win" reads instantly.
function quadrant(o) {
  const {
    x = 0, y = 0, w = 560, h = 560, items = [], title = null,
    xAxis = { left: 'low', right: 'high' }, yAxis = { bottom: 'low', top: 'high' },
    xDomain = [0, 1], yDomain = [0, 1], quadrantLabels = null,
    labelSize = 13, axisSize = 13, dot = 7, tint = true, color = 'blue',
  } = o;
  const head = chartHead({ x, y, w, title });
  const els = [...head.els];
  // gutter must fit the y captions horizontally, else they wrap to one glyph per line
  const padL = Math.max(measureText(String(yAxis.top || ''), axisSize), measureText(String(yAxis.bottom || ''), axisSize)) + 12;
  const padB = axisSize * LH + 10;
  const px = x + padL, py = head.top;
  const pw = Math.max(60, w - padL - 8), ph = Math.max(60, h - (head.top - y) - padB);
  const sx = linScale(xDomain[0], xDomain[1], px, px + pw);
  const sy = linScale(yDomain[0], yDomain[1], py + ph, py);
  const mx = px + pw / 2, my = py + ph / 2;
  if (tint) {
    // TL / TR / BL / BR — TR is the "go" quadrant
    const q = [['#f8f9fa', px, py], [PALETTE.paleGreen.fill, mx, py], [PALETTE.gray.fill, px, my], [PALETTE.paleBlue.fill, mx, my]];
    for (const [fill, qx, qy] of q) els.push({ type: 'rectangle', x: qx, y: qy, width: pw / 2, height: ph / 2, strokeColor: 'transparent', backgroundColor: fill, fillStyle: 'solid', strokeWidth: 1, roundness: false });
  }
  els.push({ type: 'rectangle', x: px, y: py, width: pw, height: ph, strokeColor: WIRE.edge, backgroundColor: 'transparent', strokeWidth: 1.5, roundness: false });
  els.push({ type: 'line', points: [[mx, py], [mx, py + ph]], strokeColor: WIRE.edge, strokeWidth: 1.5, strokeStyle: 'dashed' });
  els.push({ type: 'line', points: [[px, my], [px + pw, my]], strokeColor: WIRE.edge, strokeWidth: 1.5, strokeStyle: 'dashed' });
  if (quadrantLabels) {
    // outer corners, aligned outward — the middle is where the points live
    const qw = pw / 2 - 20;
    const corners = [
      [quadrantLabels.tl, px + 10, py + 8, 'left'],
      [quadrantLabels.tr, mx + 10, py + 8, 'right'],
      [quadrantLabels.bl, px + 10, my + ph / 2 - labelSize * LH - 8, 'left'],
      [quadrantLabels.br, mx + 10, my + ph / 2 - labelSize * LH - 8, 'right'],
    ];
    for (const [l, lx, ly, al] of corners) {
      if (!l) continue;
      els.push(txt({ x: lx, y: ly, text: wrapToWidth(String(l), labelSize, qw), fontSize: labelSize, color: WIRE.hint, width: qw, align: al }));
    }
  }
  // axis captions
  els.push(txt({ x: px, y: py + ph + 6, text: xAxis.left || '', fontSize: axisSize, color: WIRE.strong, width: pw / 2, align: 'left' }));
  els.push(txt({ x: mx, y: py + ph + 6, text: xAxis.right || '', fontSize: axisSize, color: WIRE.strong, width: pw / 2, align: 'right' }));
  els.push(txt({ x, y: py + ph - axisSize * LH, text: String(yAxis.bottom || ''), fontSize: axisSize, color: WIRE.strong, width: padL - 6, align: 'left' }));
  els.push(txt({ x, y: py, text: String(yAxis.top || ''), fontSize: axisSize, color: WIRE.strong, width: padL - 6, align: 'left' }));
  for (const it of items) {
    const p = pal(it.color || color);
    const cx = sx(num(it.x)), cy = sy(num(it.y));
    els.push({ type: 'ellipse', x: cx - dot, y: cy - dot, width: dot * 2, height: dot * 2, strokeColor: p.stroke, backgroundColor: p.fill, fillStyle: 'solid', strokeWidth: 2 });
    if (it.label) {
      // label sits toward the plot interior so it can't run off the frame
      const tw = Math.min(measureText(it.label, labelSize) + 4, pw / 2);
      const right = cx < mx;
      els.push(txt({ x: right ? cx + dot + 5 : cx - dot - 5 - tw, y: cy - labelSize * 0.62, text: it.label, fontSize: labelSize, width: tw, align: right ? 'left' : 'right' }));
    }
  }
  return G(box(els, x, y, w, py + ph + padB - y), 'quadrant');
}

// ── donut / pie ───────────────────────────────────────────────────────────
// Composition of a whole. Excalidraw has no arc, so each wedge is a filled polygon approximating the
// sector; `inner` > 0 makes it a ring. Keep to <= ~6 slices — beyond that a barChart reads better.
function donut(o) {
  const {
    x = 0, y = 0, r = 130, slices = [], title = null, inner = 0.55, legend = true,
    seg = 64, labelSize = 13, startAngle = -Math.PI / 2, percent = true, legendGap = 28,
  } = o;
  const S = slices.map((s, i) => ({ label: String(s.label ?? i), value: Math.max(0, num(s.value)), color: s.color || cyc(i) }));
  const total = S.reduce((a, s) => a + s.value, 0) || 1;
  const legendW = legend ? Math.max(0, ...S.map((s) => measureText(`${s.label} — ${percent ? Math.round((s.value / total) * 100) + '%' : fmtNum(s.value)}`, labelSize))) + 26 : 0;
  const w = r * 2 + (legend ? legendGap + legendW : 0);
  const head = chartHead({ x, y, w, title });
  const els = [...head.els];
  const cx = x + r, cy = head.top + r;
  let a0 = startAngle;
  for (const s of S) {
    const sweep = (s.value / total) * Math.PI * 2;
    if (sweep <= 0) continue;
    const p = pal(s.color);
    const n = Math.max(2, Math.ceil((sweep / (Math.PI * 2)) * seg));
    const outer = [], innerPts = [];
    for (let i = 0; i <= n; i++) {
      const a = a0 + (sweep * i) / n;
      outer.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
      if (inner > 0) innerPts.push([cx + Math.cos(a) * r * inner, cy + Math.sin(a) * r * inner]);
    }
    const ring = inner > 0 ? [...outer, ...innerPts.reverse(), outer[0]] : [[cx, cy], ...outer, [cx, cy]];
    els.push({ type: 'line', points: ring, strokeColor: p.stroke, backgroundColor: p.fill, fillStyle: 'solid', strokeWidth: 1.5 });
    a0 += sweep;
  }
  if (legend) {
    let ly = head.top + Math.max(0, r - (S.length * (labelSize * LH + 8)) / 2);
    const lx = x + r * 2 + legendGap;
    for (const s of S) {
      const p = pal(s.color);
      els.push({ type: 'rectangle', x: lx, y: ly + 1, width: 13, height: 13, strokeColor: p.stroke, backgroundColor: p.fill, fillStyle: 'solid', strokeWidth: 1.5, roundness: true });
      const l = `${s.label} — ${percent ? Math.round((s.value / total) * 100) + '%' : fmtNum(s.value)}`;
      els.push(txt({ x: lx + 20, y: ly, text: l, fontSize: labelSize, color: WIRE.strong, width: legendW, align: 'left' }));
      ly += labelSize * LH + 8;
    }
  }
  return G(box(els, x, y, Math.max(w, head.w), head.top + r * 2 - y), 'donut');
}

// ── sparkline ─────────────────────────────────────────────────────────────
// A tiny trend with no axes — for inside a KPI tile or a table cell. Not a chart; a glyph.
function sparkline(o) {
  const {
    x = 0, y = 0, w = 140, h = 36, points = [], color = 'blue', strokeWidth = 2,
    fill = false, last = true, baseline = false,
  } = o;
  const P = points.map(num);
  if (!P.length) return box([], x, y, w, h);
  const lo = Math.min(...P), hi = Math.max(...P);
  const sy = linScale(lo === hi ? lo - 1 : lo, lo === hi ? hi + 1 : hi, y + h - 2, y + 2);
  const sx = linScale(0, Math.max(1, P.length - 1), x, x + w);
  const pts = P.map((v, i) => [sx(i), sy(v)]);
  const p = pal(color);
  const els = [];
  if (baseline) els.push({ type: 'line', points: [[x, y + h - 1], [x + w, y + h - 1]], strokeColor: WIRE.line, strokeWidth: 1 });
  if (fill && pts.length > 1) els.push({ type: 'line', strokeColor: 'transparent', backgroundColor: p.fill, fillStyle: 'solid', strokeWidth: 1, points: [...pts, [pts[pts.length - 1][0], y + h], [pts[0][0], y + h], pts[0]] });
  if (pts.length > 1) els.push({ type: 'line', points: pts, strokeColor: p.stroke, strokeWidth });
  if (last) { const [lx, ly] = pts[pts.length - 1]; els.push({ type: 'ellipse', x: lx - 3, y: ly - 3, width: 6, height: 6, strokeColor: p.stroke, backgroundColor: p.stroke, fillStyle: 'solid', strokeWidth: 1 }); }
  return G(box(els, x, y, w, h), 'spark');
}

// ── heatmap ───────────────────────────────────────────────────────────────
// Matrix of intensities (cohort × day retention, activity by hour). Cell tint is interpolated between
// two hexes, so magnitude reads without a legend lookup.
function lerpHex(a, b, t) {
  const pc = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [r1, g1, b1] = pc(a), [r2, g2, b2] = pc(b);
  const m = (u, v) => Math.round(u + (v - u) * Math.max(0, Math.min(1, t))).toString(16).padStart(2, '0');
  return `#${m(r1, r2)}${m(g1, g2)}${m(b1, b2)}`;
}
function heatmap(o) {
  const {
    x = 0, y = 0, rows = [], cols = [], values = [], title = null,
    cell = 44, gap = 3, from = '#ffffff', to = '#1971c2', labelSize = 12, valueSize = 11,
    showValues = true, vMin = null, vMax = null, fmt = (v) => (v == null ? '' : String(v)),
  } = o;
  const flat = values.flat().filter((v) => typeof v === 'number');
  const lo = vMin != null ? vMin : Math.min(...(flat.length ? flat : [0]));
  const hi = vMax != null ? vMax : Math.max(...(flat.length ? flat : [1]));
  const rowW = Math.max(0, ...rows.map((r) => measureText(String(r), labelSize))) + 10;
  const w = rowW + cols.length * (cell + gap);
  const head = chartHead({ x, y, w, title });
  const els = [...head.els];
  const top = head.top + labelSize * LH + 6;
  cols.forEach((c, j) => {
    const tw = measureText(String(c), labelSize) + 4;
    els.push(txt({ x: x + rowW + j * (cell + gap) + cell / 2 - tw / 2, y: head.top, text: String(c), fontSize: labelSize, color: WIRE.text, width: tw, align: 'center' }));
  });
  rows.forEach((r, i) => {
    const cy = top + i * (cell + gap);
    els.push(txt({ x, y: cy + cell / 2 - labelSize * 0.62, text: String(r), fontSize: labelSize, color: WIRE.strong, width: rowW - 8, align: 'right' }));
    cols.forEach((_, j) => {
      const v = (values[i] || [])[j];
      const has = typeof v === 'number';
      const t = has && hi !== lo ? (v - lo) / (hi - lo) : (has ? 1 : 0);
      const cx = x + rowW + j * (cell + gap);
      els.push({ type: 'rectangle', x: cx, y: cy, width: cell, height: cell, strokeColor: WIRE.line, backgroundColor: has ? lerpHex(from, to, t) : WIRE.panel, fillStyle: 'solid', strokeWidth: 1, roundness: true });
      if (showValues && has) {
        // flip label to white once the cell is dark enough to swallow ink
        els.push(txt({ x: cx, y: cy + cell / 2 - valueSize * 0.62, text: fmt(v), fontSize: valueSize, color: t > 0.55 ? '#ffffff' : INK, width: cell, align: 'center' }));
      }
    });
  });
  return G(box(els, x, y, Math.max(w, head.w), top + rows.length * (cell + gap) - gap - y), 'heatmap');
}

// ── table ─────────────────────────────────────────────────────────────────
// A real grid. Column widths derive from content (capped), so cells never spill — the failure mode of
// faking a table with hand-placed text.
function table(o) {
  const {
    x = 0, y = 0, headers = [], rows = [], title = null, fontSize = 13, headerSize = 13,
    padX = 10, padY = 8, maxColW = 260, minColW = 60, zebra = true, headColor = 'gray', align = [],
  } = o;
  const nC = Math.max(headers.length, ...(rows.length ? rows.map((r) => r.length) : [0]));
  const colW = [];
  for (let j = 0; j < nC; j++) {
    const cells = [headers[j] ?? '', ...rows.map((r) => (r[j] ?? ''))].map((c) => String(typeof c === 'object' && c ? c.text ?? '' : c));
    const want = Math.max(...cells.map((c) => measureText(c, fontSize))) + padX * 2;
    colW.push(Math.max(minColW, Math.min(maxColW, want)));
  }
  const w = colW.reduce((a, b) => a + b, 0);
  const head = chartHead({ x, y, w, title });
  const els = [...head.els];
  const wrapCell = (c, j) => wrapToWidth(String(c), fontSize, colW[j] - padX * 2);
  const rowHeights = rows.map((r) => Math.max(...Array.from({ length: nC }, (_, j) => {
    const c = r[j]; const t = typeof c === 'object' && c ? c.text ?? '' : c ?? '';
    return wrapCell(t, j).split('\n').length;
  })) * fontSize * LH + padY * 2);
  const headH = headers.length ? Math.max(...headers.map((c, j) => wrapCell(c ?? '', j).split('\n').length)) * headerSize * LH + padY * 2 : 0;
  let cy = head.top;
  const colX = []; let acc = x;
  for (let j = 0; j < nC; j++) { colX.push(acc); acc += colW[j]; }
  if (headers.length) {
    const p = pal(headColor);
    els.push({ type: 'rectangle', x, y: cy, width: w, height: headH, strokeColor: p.stroke, backgroundColor: p.fill, fillStyle: 'solid', strokeWidth: 1.5, roundness: false });
    headers.forEach((c, j) => els.push(txt({ x: colX[j] + padX, y: cy + padY, text: wrapCell(c ?? '', j), fontSize: headerSize, color: INK, width: colW[j] - padX * 2, align: align[j] || 'left' })));
    cy += headH;
  }
  rows.forEach((r, i) => {
    const rh = rowHeights[i];
    els.push({ type: 'rectangle', x, y: cy, width: w, height: rh, strokeColor: WIRE.line, backgroundColor: zebra && i % 2 ? WIRE.panel : '#ffffff', fillStyle: 'solid', strokeWidth: 1, roundness: false });
    for (let j = 0; j < nC; j++) {
      const c = r[j];
      const obj = typeof c === 'object' && c ? c : null;
      const t = obj ? obj.text ?? '' : c ?? '';
      if (obj && obj.color) {
        const p = pal(obj.color);
        els.push({ type: 'rectangle', x: colX[j] + 2, y: cy + 2, width: colW[j] - 4, height: rh - 4, strokeColor: 'transparent', backgroundColor: p.fill, fillStyle: 'solid', strokeWidth: 1, roundness: true });
      }
      els.push(txt({ x: colX[j] + padX, y: cy + padY, text: wrapCell(t, j), fontSize, color: INK, width: colW[j] - padX * 2, align: align[j] || 'left' }));
    }
    cy += rh;
  });
  // column rules drawn last so they sit above the row fills
  for (let j = 1; j < nC; j++) els.push({ type: 'line', points: [[colX[j], head.top], [colX[j], cy]], strokeColor: WIRE.line, strokeWidth: 1 });
  return G(box(els, x, y, Math.max(w, head.w), cy - y), 'table');
}

// ── timeline ──────────────────────────────────────────────────────────────
// Milestones on a horizontal track, labels alternating above/below so they never collide.
function timeline(o) {
  const {
    x = 0, y = 0, w = 860, events = [], title = null, labelSize = 13, dateSize = 11,
    color = 'blue', dot = 9, laneGap = 26, noteW = 190,
  } = o;
  const stamps = events.map((e) => e.at).filter((v) => typeof v === 'string');
  const origin = stamps.length ? Math.min(...stamps.map((s) => Math.round(Date.parse(s + 'T00:00:00Z') / 86400000))) : 0;
  const E = events.map((e, i) => ({
    label: String(e.label ?? i), at: parseDay(e.at, origin), color: e.color || color,
    date: typeof e.at === 'string' ? e.at.slice(5) : String(e.at),
  }));
  const lo = Math.min(...(E.length ? E.map((e) => e.at) : [0]));
  const hi = Math.max(...(E.length ? E.map((e) => e.at) : [1]));
  const head = chartHead({ x, y, w, title });
  const els = [...head.els];
  const wrapped = E.map((e) => wrapToWidth(e.label, labelSize, noteW));
  const maxLines = Math.max(1, ...wrapped.map((t) => t.split('\n').length));
  const laneH = maxLines * labelSize * LH + dateSize * LH + 6;
  const trackY = head.top + laneH + laneGap;
  const px = x + noteW / 2, pw = Math.max(60, w - noteW);
  const sx = linScale(lo, hi === lo ? lo + 1 : hi, px, px + pw);
  els.push({ type: 'line', points: [[x, trackY], [x + w, trackY]], strokeColor: WIRE.edge, strokeWidth: 2 });
  E.forEach((e, i) => {
    const cx = sx(e.at), p = pal(e.color), up = i % 2 === 0;
    els.push({ type: 'ellipse', x: cx - dot, y: trackY - dot, width: dot * 2, height: dot * 2, strokeColor: p.stroke, backgroundColor: p.fill, fillStyle: 'solid', strokeWidth: 2 });
    els.push({ type: 'line', points: [[cx, trackY + (up ? -dot : dot)], [cx, trackY + (up ? -laneGap + 4 : laneGap - 4)]], strokeColor: WIRE.edge, strokeWidth: 1.5 });
    const t = wrapped[i];
    const lines = t.split('\n').length;
    const ty = up ? trackY - laneGap - (lines * labelSize * LH) - dateSize * LH - 2 : trackY + laneGap;
    els.push(txt({ x: cx - noteW / 2, y: ty, text: e.date, fontSize: dateSize, color: WIRE.text, width: noteW, align: 'center' }));
    els.push(txt({ x: cx - noteW / 2, y: ty + dateSize * LH + 2, text: t, fontSize: labelSize, color: INK, width: noteW, align: 'center' }));
  });
  return G(box(els, x, y, w, trackY + laneH + laneGap - y), 'timeline');
}

// ── kpi ───────────────────────────────────────────────────────────────────
// The metric tile: label / big value / delta, three type sizes for hierarchy. Optional `spark`
// (number[]) draws a sparkline in the tile's footer. This is the piece every review board rebuilds.
function kpi(o) {
  const {
    x = 0, y = 0, w = 300, h = 160, label = '', value = '', delta = null, color = 'blue',
    valueSize = 40, labelSize = 14, deltaSize = 13, minValueFont = 18, spark = null,
    sparkColor = null, padX = 14, padY = 12, align = 'center',
  } = o;
  const p = pal(color);
  const inner = w - padX * 2;
  const lTxt = wrapToWidth(String(label), labelSize, inner);
  const lH = lTxt.split('\n').length * labelSize * LH;
  const vFit = fitText({ text: String(value), w, h: valueSize * 1.6, fontSize: valueSize, minFont: minValueFont, padX });
  const vH = vFit.lineCount * vFit.fontSize * LH;
  const dTxt = delta ? wrapToWidth(String(delta), deltaSize, inner) : null;
  const dH = dTxt ? dTxt.split('\n').length * deltaSize * LH : 0;
  const spH = spark && spark.length ? 30 : 0;
  const total = lH + 8 + vH + (dTxt ? 6 + dH : 0) + (spH ? 8 + spH : 0);
  const height = Math.max(h, total + padY * 2);
  let cy = y + (height - total) / 2;
  const els = [{ type: 'rectangle', x, y, width: w, height, strokeColor: p.stroke, backgroundColor: p.fill, fillStyle: 'solid', strokeWidth: 2, roundness: true }];
  els.push(txt({ x: x + padX, y: cy, text: lTxt, fontSize: labelSize, color: WIRE.strong, width: inner, align }));
  cy += lH + 8;
  els.push(txt({ x: x + padX, y: cy, text: vFit.text, fontSize: vFit.fontSize, color: INK, width: inner, align }));
  cy += vH;
  if (dTxt) { cy += 6; els.push(txt({ x: x + padX, y: cy, text: dTxt, fontSize: deltaSize, color: WIRE.strong, width: inner, align })); cy += dH; }
  if (spH) { cy += 8; els.push(...sparkline({ x: x + padX, y: cy, w: inner, h: spH, points: spark, color: sparkColor || color, fill: true })); }
  return G(box(els, x, y, w, height), 'kpi');
}

// ── callout ───────────────────────────────────────────────────────────────
// A titled note band. Body copy is ALWAYS bounded to <= READ_W: a wide band puts its heading beside
// the text (label | body) rather than stretching one line edge-to-edge. Never splits short copy into
// columns — a 1-line "column" reads as a torn sentence, which is worse than a long line.
// `w` is a MAXIMUM, not a target: the band shrinks to hug its own wrapped text. A callout handed 1080px
// for 620px of copy used to pad the difference with dead space (~27% on a real board — an empty title
// gutter plus a right margin). Sizing to content is what makes the primitive atomic: the caller says
// "at most this wide" and the builder works out the rest. Pass `fit: false` for a deliberate full-width
// band, or pin `titleW` to align the title gutters of several stacked callouts.
function callout(o) {
  const {
    x = 0, y = 0, w = 660, title = null, text = '', color = 'gray',
    fontSize = 15, titleSize = 16, minH = 0, sideTitle = null, titleW = null,
    padX = 16, padY = 14, gap = 40, fit = true, minW = 0,
  } = o;
  const p = pal(color);
  const avail = w - padX * 2;
  // auto: a band with room for a title column AND a full measure beside it uses the side layout
  const side = sideTitle == null ? (!!title && avail >= READ_W + 200) : (sideTitle && !!title);
  const widest = (s, fs) => Math.max(0, ...String(s).split('\n').map((l) => measureText(l, fs)));
  const parts = [];
  let h, natural;
  if (side) {
    const tCap = titleW != null ? titleW : Math.min(300, Math.max(80, avail - READ_W - gap));
    const tWrap = wrapToWidth(String(title), titleSize, tCap);
    const tW = titleW != null ? titleW : Math.min(tCap, Math.max(40, widest(tWrap, titleSize)));
    const bCap = Math.min(avail - tW - gap, READ_W);
    const bWrap = wrapToWidth(String(text), fontSize, bCap);
    const bW = Math.min(bCap, Math.max(40, widest(bWrap, fontSize)));
    parts.push({ text: tWrap, size: titleSize, dy: padY, color: p.stroke, x: x + padX, w: tW });
    parts.push({ text: bWrap, size: fontSize, dy: padY, color: INK, x: x + padX + tW + gap, w: bW });
    h = Math.max(tWrap.split('\n').length * titleSize * LH, bWrap.split('\n').length * fontSize * LH) + padY * 2;
    natural = padX + tW + gap + bW + padX;
  } else {
    const colW = Math.min(avail, READ_W);
    h = padY;
    let used = 0;
    if (title) {
      const t = wrapToWidth(String(title), titleSize, colW);
      parts.push({ text: t, size: titleSize, dy: h, color: p.stroke, x: x + padX, w: colW });
      h += t.split('\n').length * titleSize * LH + 6;
      used = Math.max(used, widest(t, titleSize));
    }
    const b = wrapToWidth(String(text), fontSize, colW);
    parts.push({ text: b, size: fontSize, dy: h, color: INK, x: x + padX, w: colW });
    h += b.split('\n').length * fontSize * LH + padY;
    used = Math.max(used, widest(b, fontSize));
    natural = padX + Math.max(40, used) + padX;
  }
  h = Math.max(h, minH);
  const width = fit ? Math.max(minW, Math.min(w, Math.ceil(natural))) : w;
  const els = [{ type: 'rectangle', x, y, width, height: h, strokeColor: p.stroke, backgroundColor: p.fill, fillStyle: 'solid', strokeWidth: 2, roundness: true }];
  for (const pp of parts) els.push(txt({ x: pp.x, y: y + pp.dy, text: pp.text, fontSize: pp.size, color: pp.color, width: pp.w, align: 'left' }));
  return G(box(els, x, y, width, h), 'callout');
}

module.exports = {
  // charts
  lineChart, barChart, barCompare, stackedBar, gantt, quadrant, donut, sparkline, heatmap, table, timeline,
  // tiles / copy
  kpi, callout,
  // scale + format helpers (exported for custom charts)
  linScale, niceScale, fmtNum, lerpHex, chartHead, plotFrame, xTickLabels, CYCLE,
};
