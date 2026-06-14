// Issue #9 — graphical improvement board: bar chart + depth ladder + substance-debt + pipeline
const path = require('path');
const { buildExcalidraw } = require(path.resolve(__dirname, '../../.claude/skills/excalidraw/scripts/build_excalidraw.js'));
const { card, node, sectionTitle, connector, PALETTE, INK } = require(path.resolve(__dirname, '../../.claude/skills/excalidraw/scripts/lib/style.js'));

const E = [];
const push = (...els) => E.push(...els);
const txt = (x, y, text, fontSize = 16, color = INK, width, align = 'left') =>
  ({ type: 'text', x, y, text, fontSize, color, fontFamily: 5, align, width: width || Math.max(40, String(text).length * fontSize * 0.6) });
const rect = (x, y, w, h, fill, stroke = INK, sw = 2) =>
  ({ type: 'rectangle', x, y, width: w, height: h, strokeColor: stroke, backgroundColor: fill, fillStyle: 'solid', strokeWidth: sw, roundness: true });
const lineEl = (pts, stroke = '#ced4da', sw = 1, dashed = true) =>
  ({ type: 'line', points: pts, strokeColor: stroke, strokeWidth: sw, strokeStyle: dashed ? 'dashed' : 'solid' });

// ── Title ────────────────────────────────────────────────────────────────────
push(...sectionTitle({ x: 60, y: 24, text: 'Issue #9 — Yapilanlar & Olculen Iyilesme', fontSize: 34 }));
push(txt(60, 74, 'Deterministik eval (LLM\'siz, tek komutla tekrarlanabilir):  npx vitest run tests/unit/sleep-quality-eval.test.ts', 15, '#495057', 1200));

// ── BAR CHART: BEFORE → AFTER (0–100) ─────────────────────────────────────────
push(...sectionTitle({ x: 60, y: 120, text: 'Eval kalite skoru:  ONCE → SONRA', fontSize: 22, color: '#1971c2' }));

const baseY = 470;     // chart baseline
const maxH = 240;      // pixels for 100%
const x0 = 110;        // first group x
const pitch = 150;     // distance between groups
const bw = 40;         // bar width
const innerGap = 12;   // gap between before/after bar

// gridlines + axis labels
for (const p of [0, 25, 50, 75, 100]) {
  const gy = baseY - (p / 100) * maxH;
  push(lineEl([[90, gy], [1010, gy]], '#dee2e6', 1, p !== 0));
  push(txt(54, gy - 9, String(p), 13, '#adb5bd', 30, 'right'));
}

const groups = [
  { label: 'OVERALL', before: 57.1, after: 100, kind: 'mover' },
  { label: 'Attribution', before: 0, after: 100, kind: 'mover' },
  { label: 'Substance scoring', before: 0, after: 100, kind: 'mover' },
  { label: 'Depth-gating', before: 0, after: 100, kind: 'mover' },
  { label: 'Epoch-safety (guard)', before: 100, after: 100, kind: 'guard' },
  { label: 'No-double-count (guard)', before: 100, after: 100, kind: 'guard' },
];

groups.forEach((g, i) => {
  const gx = x0 + i * pitch;
  const hB = (g.before / 100) * maxH;
  const hA = (g.after / 100) * maxH;
  // BEFORE bar (gray)
  push(rect(gx, baseY - hB, bw, Math.max(2, hB), PALETTE.gray.fill, PALETTE.gray.stroke, 2));
  push(txt(gx - 4, baseY - hB - 22, g.before % 1 ? g.before.toFixed(1) : String(g.before), 13, '#868e96', bw + 8, 'center'));
  // AFTER bar (green movers, mint guards)
  const af = g.kind === 'mover' ? PALETTE.green : PALETTE.mint;
  push(rect(gx + bw + innerGap, baseY - hA, bw, Math.max(2, hA), af.fill, af.stroke, 2));
  push(txt(gx + bw + innerGap - 4, baseY - hA - 22, String(g.after), 14, af.stroke, bw + 8, 'center'));
  // group label below baseline (wrapped)
  push(txt(gx - 22, baseY + 12, g.label, 13, INK, pitch - 16, 'center'));
});

// Δ callout on OVERALL
push(...connector({ from: [x0 + bw + innerGap + bw + 6, baseY - maxH + 6], to: [x0 + 250, 150], label: '' }));
push(txt(x0 + 200, 120, 'Δ +42.9 puan', 18, '#2f9e44', 220));

// legend
push(rect(720, 120, 22, 16, PALETTE.gray.fill, PALETTE.gray.stroke, 2)); push(txt(748, 119, 'ONCE (eski davranis)', 14, '#495057', 220));
push(rect(720, 144, 22, 16, PALETTE.green.fill, PALETTE.green.stroke, 2)); push(txt(748, 143, 'SONRA — mover (gercek iyilesme)', 14, '#495057', 320));
push(rect(720, 168, 22, 16, PALETTE.mint.fill, PALETTE.mint.stroke, 2)); push(txt(748, 167, 'SONRA — guard (regresyon yok)', 14, '#495057', 320));

// ── DEPTH LADDER (debt → consolidation depth) ─────────────────────────────────
const ladX = 60, ladY = 600;
push(...sectionTitle({ x: ladX, y: ladY, text: 'Dinamik derinlik (debt → mod)', fontSize: 20, color: '#6741d9' }));
const steps = [
  { t: '0–3 debt\nlight\nyalniz guvenli:\nolustur / genislet', c: 'gray' },
  { t: '4–9 debt\nstandard\nbirlestir + etiketle', c: 'yellow' },
  { t: '10+ debt\ndeep\nozetle + SIL\n(+ archive-before-delete)', c: 'mint' },
];
const stepW = 190, stepH = 120, stepDX = 36, stepDY = 56;
steps.forEach((s, i) => {
  const x = ladX + i * (stepW - stepDX);
  const y = ladY + 50 + (steps.length - 1 - i) * stepDY;
  push(...card({ x, y, w: stepW, h: stepH, text: s.t, color: s.c, fontSize: 14 }));
});
push(...connector({ from: [ladX, ladY + 50 + steps.length * stepDY + 10], to: [ladX + 2 * (stepW - stepDX) + stepW, ladY + 50 + 10], label: 'artan debt → daha derin' }));

// ── SUBSTANCE-WEIGHTED DEBT (edit-free dense session) ─────────────────────────
const sbX = 640, sbY = 600;
push(...sectionTitle({ x: sbX, y: sbY, text: 'Substance-weighted debt', fontSize: 20, color: '#1971c2' }));
push(txt(sbX, sbY + 40, '"Dosya editi YOK, ama cok bilgi paylasildi" seansi:', 14, '#495057', 360));
// mini bars: score 0..3 scale, each unit = 50px
const sBaseY = sbY + 230, unit = 55;
push(lineEl([[sbX, sBaseY], [sbX + 300, sBaseY]], '#dee2e6', 1, false));
// before: max(change,tool) = 1
push(rect(sbX + 30, sBaseY - 1 * unit, 70, 1 * unit, PALETTE.gray.fill, PALETTE.gray.stroke));
push(txt(sbX + 20, sBaseY - 1 * unit - 24, 'skor 1', 14, '#868e96', 90, 'center'));
push(txt(sbX + 20, sBaseY + 10, 'ONCE\nmax(change,tool)', 13, INK, 90, 'center'));
// after: max(change,tool,substance) = 3
push(rect(sbX + 180, sBaseY - 3 * unit, 70, 3 * unit, PALETTE.green.fill, PALETTE.green.stroke));
push(txt(sbX + 170, sBaseY - 3 * unit - 24, 'skor 3', 16, '#2f9e44', 90, 'center'));
push(txt(sbX + 165, sBaseY + 10, 'SONRA\n+scoreFromSubstance', 13, INK, 110, 'center'));
push(...connector({ from: [sbX + 105, sBaseY - 60], to: [sbX + 175, sBaseY - 120], label: '' }));

// ── ORCHESTRATION PIPELINE ────────────────────────────────────────────────────
const pX = 60, pY = 900;
push(...sectionTitle({ x: pX, y: pY, text: 'Nasil yapildi — goal-skill orkestrasyonu', fontSize: 20, color: '#495057' }));
const pNodes = [
  { t: 'Plan\n(opus)', c: 'blue' },
  { t: '3 Reviewer\n→ SOLID', c: 'purple' },
  { t: 'Task doc', c: 'gray' },
  { t: 'Implement\n(opus)', c: 'blue' },
  { t: 'Code review\n→ PASS', c: 'purple' },
  { t: 'Validate\n→ PASS', c: 'green' },
];
const nW = 165, nH = 70, nGap = 40;
pNodes.forEach((n, i) => {
  const x = pX + i * (nW + nGap);
  push(...card({ x, y: pY + 50, w: nW, h: nH, text: n.t, color: n.c, fontSize: 15 }));
  if (i > 0) {
    const px = pX + (i - 1) * (nW + nGap) + nW;
    push(...connector({ from: [px + 2, pY + 50 + nH / 2], to: [px + nGap - 2, pY + 50 + nH / 2] }));
  }
});
push(txt(pX, pY + 140, 'Iter cap 3/loop · plan review iter 2/3\'te SOLID converge etti', 14, '#868e96', 700));

buildExcalidraw({ out: path.resolve(__dirname, '../Issue9-Improvement-Graphic.excalidraw.md'), background: '#ffffff', elements: E });
