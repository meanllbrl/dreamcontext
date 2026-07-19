// Generates the README "It starts with memory" board: the core mechanism —
// capture while awake, consolidate during sleep, start the next session ready.
const path = require('node:path');
const { buildExcalidraw } = require('../../../../../scripts/diagrams/excalidraw/build_excalidraw.js');
const {
  card, sectionTitle, connector,
  rightOf, leftOf, bottomOf,
} = require('../../../../../scripts/diagrams/excalidraw/lib/style.js');

const OUT = path.resolve(__dirname, 'memory-mechanism.excalidraw.md');

// ── Geometry — three stages left-to-right, with the loop closing below ──────
const CAPTURE = { x: 40, y: 130, w: 330, h: 150 };
const SLEEP = { x: 510, y: 130, w: 330, h: 150 };
const READY = { x: 980, y: 130, w: 330, h: 150 };

const els = [];

els.push(...sectionTitle({ x: 60, y: 8, text: 'It starts with memory', fontSize: 36 }));

els.push(...card({ ...CAPTURE, color: 'yellow', fontSize: 19, text: 'Capture\nwhile you work, hooks + bookmarks record decisions, constraints, discoveries — zero effort from you' }));
els.push(...card({ ...SLEEP, color: 'purple', fontSize: 19, text: 'Sleep\nagents fan out in parallel, distill the sessions into human-readable knowledge, retire what went stale' }));
els.push(...card({ ...READY, color: 'blue', fontSize: 19, text: 'Start ready\nthe next session opens with the full picture pre-loaded — zero tool calls · deeper recall in <100 ms' }));

els.push(...connector({
  from: rightOf(CAPTURE.x, CAPTURE.y, CAPTURE.w, CAPTURE.h),
  to: leftOf(SLEEP.x, SLEEP.y, SLEEP.w, SLEEP.h),
  label: 'debt accrues',
}));
els.push(...connector({
  from: rightOf(SLEEP.x, SLEEP.y, SLEEP.w, SLEEP.h),
  to: leftOf(READY.x, READY.y, READY.w, READY.h),
  label: 'consolidated',
}));

// Loop back under the row: every session sharpens the next.
els.push(...connector({
  from: bottomOf(READY.x, READY.y, READY.w, READY.h),
  to: bottomOf(CAPTURE.x, CAPTURE.y, CAPTURE.w, CAPTURE.h),
  via: [[READY.x + READY.w / 2, 400], [CAPTURE.x + CAPTURE.w / 2, 400]],
  dashed: true,
  strokeColor: '#6741d9',
  label: 'every session sharpens the next',
}));

buildExcalidraw({ out: OUT, background: '#ffffff', elements: els });
