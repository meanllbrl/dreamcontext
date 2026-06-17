// dreamcontext "sleep consolidation" source-of-truth board.
// Mirrors the dashboard SLEEP_FLOW_SPEC: debt → sleep start → 3 parallel
// specialists → converge → sleep done.
const path = require('node:path');
const { buildExcalidraw } = require('../../../../../scripts/diagrams/excalidraw/build_excalidraw.js');
const {
  card, sectionTitle, connector,
  topOf, bottomOf, rightOf,
} = require('../../../../../scripts/diagrams/excalidraw/lib/style.js');

const OUT = path.resolve(__dirname, 'sleep.excalidraw.md');

const DEBT = { x: 300, y: 70, w: 460, h: 88 };
const START = { x: 400, y: 240, w: 260, h: 80 };
const SPEC = { y: 410, w: 270, h: 100, gap: 40 };
const CONVERGE = { x: 330, y: 600, w: 400, h: 84 };
const DONE = { x: 400, y: 760, w: 260, h: 76 };

const SPECIALISTS = [
  { title: 'sleep-tasks', sub: 'task files' },
  { title: 'sleep-state', sub: 'core · changelog · releases' },
  { title: 'sleep-product', sub: 'knowledge · features' },
];
const bandW = SPECIALISTS.length * SPEC.w + (SPECIALISTS.length - 1) * SPEC.gap;
const startCx = START.x + START.w / 2;
const bandStart = startCx - bandW / 2;
const specX = (i) => bandStart + i * (SPEC.w + SPEC.gap);

const els = [];
els.push(...sectionTitle({ x: 60, y: 8, text: 'dreamcontext — how sleep consolidates', fontSize: 38 }));

els.push(...card({ ...DEBT, color: 'yellow', fontSize: 19, text: 'Sessions accumulate → sleep debt\nAlert · Drowsy · Sleepy · Must Sleep' }));
els.push(...card({ ...START, color: 'blue', fontSize: 20, text: 'sleep start\npins the epoch' }));

const specCards = SPECIALISTS.map((s, i) => {
  const x = specX(i);
  els.push(...card({ x, y: SPEC.y, w: SPEC.w, h: SPEC.h, color: 'purple', fontSize: 18, text: `${s.title}\n${s.sub}` }));
  return { x, y: SPEC.y, w: SPEC.w, h: SPEC.h };
});

els.push(...card({ ...CONVERGE, color: 'gray', fontSize: 19, text: 'system knowledge updated\nreports stitched into one summary' }));
els.push(...card({ ...DONE, color: 'mint', fontSize: 20, text: 'sleep done\ndebt reset' }));

// debt → start
els.push(...connector({ from: bottomOf(DEBT.x, DEBT.y, DEBT.w, DEBT.h), to: topOf(START.x, START.y, START.w, START.h) }));
// start → each specialist (parallel fan-out)
const startBottom = bottomOf(START.x, START.y, START.w, START.h);
specCards.forEach((sc, i) => {
  els.push(...connector({ from: startBottom, to: topOf(sc.x, sc.y, sc.w, sc.h), label: i === 0 ? 'in parallel' : undefined }));
});
// each specialist → converge
const convTop = topOf(CONVERGE.x, CONVERGE.y, CONVERGE.w, CONVERGE.h);
specCards.forEach((sc) => {
  els.push(...connector({ from: bottomOf(sc.x, sc.y, sc.w, sc.h), to: convTop }));
});
// converge → done
els.push(...connector({ from: bottomOf(CONVERGE.x, CONVERGE.y, CONVERGE.w, CONVERGE.h), to: topOf(DONE.x, DONE.y, DONE.w, DONE.h) }));

buildExcalidraw({ out: OUT, background: '#ffffff', elements: els });
