// dreamcontext "the problem" board — the search spiral (without) vs pre-loaded (with).
const path = require('node:path');
const { buildExcalidraw } = require('../../../../../scripts/diagrams/excalidraw/build_excalidraw.js');
const {
  node, sectionTitle, connector,
  topOf, bottomOf, rightOf, leftOf,
} = require('../../../../../scripts/diagrams/excalidraw/lib/style.js');

const OUT = path.resolve(__dirname, 'problem.excalidraw.md');

const els = [];

// ── Left column: the search spiral (red / pain) ──────────────────────────────
const LX = 80, LW = 300, LH = 64, LGAP = 46;
let ly = 110;
els.push(...sectionTitle({ x: LX, y: 30, text: 'Without dreamcontext', fontSize: 26 }));
const left = [
  'New session — agent knows nothing',
  'grep for a decision made yesterday',
  'read a few files',
  'search again…',
  'piece the context back together',
  'finally start the actual work',
];
const leftCards = left.map((t, i) => {
  const c = { x: LX, y: ly, w: LW, h: LH };
  els.push(...node({ ...c, color: i === left.length - 1 ? 'gray' : 'red', fontSize: 15, text: t }));
  ly += LH + LGAP;
  return c;
});
for (let i = 1; i < leftCards.length; i++) {
  els.push(...connector({ from: bottomOf(leftCards[i - 1].x, leftCards[i - 1].y, leftCards[i - 1].w, leftCards[i - 1].h), to: topOf(leftCards[i].x, leftCards[i].y, leftCards[i].w, leftCards[i].h) }));
}
// the spiral: "search again" loops back up to "read a few files"
const r3 = leftCards[2], r4 = leftCards[3];
els.push(...connector({ from: rightOf(r4.x, r4.y, r4.w, r4.h), to: rightOf(r3.x, r3.y, r3.w, r3.h), label: 'tokens burned ↺', dashed: true, strokeColor: '#e03131' }));

// ── Right column: pre-loaded (green / benefit) ───────────────────────────────
const RX = 560, RW = 320, RH = 64, RGAP = 70;
let ry = 110;
els.push(...sectionTitle({ x: RX, y: 30, text: 'With dreamcontext', fontSize: 26 }));
const right = [
  { t: 'New session', c: 'blue' },
  { t: 'SessionStart hook fires', c: 'blue' },
  { t: 'full context pre-loaded · 0 tool calls', c: 'green' },
  { t: 'straight to work', c: 'mint' },
];
const rightCards = right.map((r) => {
  const c = { x: RX, y: ry, w: RW, h: RH };
  els.push(...node({ ...c, color: r.c, fontSize: 16, text: r.t }));
  ry += RH + RGAP;
  return c;
});
for (let i = 1; i < rightCards.length; i++) {
  els.push(...connector({ from: bottomOf(rightCards[i - 1].x, rightCards[i - 1].y, rightCards[i - 1].w, rightCards[i - 1].h), to: topOf(rightCards[i].x, rightCards[i].y, rightCards[i].w, rightCards[i].h) }));
}

buildExcalidraw({ out: OUT, background: '#ffffff', elements: els });
