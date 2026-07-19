// Generates the README hero board: the dreamcontext loop.
// Work → Gather → Sleep → Sync, ringing the shared big picture.
const path = require('node:path');
const { buildExcalidraw } = require('../../../../../scripts/diagrams/excalidraw/build_excalidraw.js');
const {
  card, sectionTitle, connector,
  topOf, bottomOf, rightOf, leftOf,
} = require('../../../../../scripts/diagrams/excalidraw/lib/style.js');

const OUT = path.resolve(__dirname, 'loop.excalidraw.md');

// ── Geometry — a ring of four stages around the shared picture ──────────────
const WORK = { x: 410, y: 80, w: 400, h: 104 };
const GATHER = { x: 880, y: 350, w: 320, h: 130 };
const SLEEP = { x: 410, y: 640, w: 400, h: 116 };
const SYNC = { x: 20, y: 350, w: 320, h: 130 };
const CENTER = { x: 445, y: 360, w: 330, h: 110 };

const els = [];

els.push(...sectionTitle({ x: 60, y: 0, text: 'The loop — how a project runs on dreamcontext', fontSize: 34 }));

els.push(...card({ ...WORK, color: 'blue', fontSize: 19, text: '1 · Work\nyou build with your agents — every session starts with the full picture pre-loaded' }));
els.push(...card({ ...GATHER, color: 'yellow', fontSize: 18, text: '2 · Gather\nagents bring more in through connectors — analytics · task platforms · sibling projects' }));
els.push(...card({ ...SLEEP, color: 'purple', fontSize: 19, text: '3 · Sleep\nagents consolidate everything into human-readable files — the single source of truth' }));
els.push(...card({ ...SYNC, color: 'green', fontSize: 18, text: '4 · Sync\nthe picture reaches your whole team — git brain sync · ClickUp / GitHub tasks' }));

els.push(...card({ ...CENTER, color: 'gray', fontSize: 19, text: 'You. Your team. Your agents.\nOne big picture.' }));

// ── Ring arrows (clockwise) ─────────────────────────────────────────────────
els.push(...connector({
  from: rightOf(WORK.x, WORK.y, WORK.w, WORK.h),
  to: topOf(GATHER.x, GATHER.y, GATHER.w, GATHER.h),
  elbow: 'hv',
}));
els.push(...connector({
  from: bottomOf(GATHER.x, GATHER.y, GATHER.w, GATHER.h),
  to: rightOf(SLEEP.x, SLEEP.y, SLEEP.w, SLEEP.h),
  elbow: 'vh',
}));
els.push(...connector({
  from: leftOf(SLEEP.x, SLEEP.y, SLEEP.w, SLEEP.h),
  to: bottomOf(SYNC.x, SYNC.y, SYNC.w, SYNC.h),
  elbow: 'hv',
}));
els.push(...connector({
  from: topOf(SYNC.x, SYNC.y, SYNC.w, SYNC.h),
  to: leftOf(WORK.x, WORK.y, WORK.w, WORK.h),
  elbow: 'vh',
  label: 'repeat',
}));

// ── Dashed spokes: every stage feeds the shared picture ─────────────────────
els.push(...connector({ from: bottomOf(WORK.x, WORK.y, WORK.w, WORK.h), to: topOf(CENTER.x, CENTER.y, CENTER.w, CENTER.h), dashed: true, strokeColor: '#6741d9' }));
els.push(...connector({ from: leftOf(GATHER.x, GATHER.y, GATHER.w, GATHER.h), to: rightOf(CENTER.x, CENTER.y, CENTER.w, CENTER.h), dashed: true, strokeColor: '#6741d9' }));
els.push(...connector({ from: topOf(SLEEP.x, SLEEP.y, SLEEP.w, SLEEP.h), to: bottomOf(CENTER.x, CENTER.y, CENTER.w, CENTER.h), dashed: true, strokeColor: '#6741d9' }));
els.push(...connector({ from: rightOf(SYNC.x, SYNC.y, SYNC.w, SYNC.h), to: leftOf(CENTER.x, CENTER.y, CENTER.w, CENTER.h), dashed: true, strokeColor: '#6741d9' }));

buildExcalidraw({ out: OUT, background: '#ffffff', elements: els });
