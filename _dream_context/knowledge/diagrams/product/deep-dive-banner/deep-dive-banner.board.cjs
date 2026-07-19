// Generates the README closing banner: three "why" hooks pointing at DEEP-DIVE.md.
const path = require('node:path');
const { buildExcalidraw } = require('../../../../../scripts/diagrams/excalidraw/build_excalidraw.js');
const {
  card, sectionTitle, connector,
  rightOf, leftOf,
} = require('../../../../../scripts/diagrams/excalidraw/lib/style.js');

const OUT = path.resolve(__dirname, 'deep-dive-banner.excalidraw.md');

const WHY = [
  'why files,\nnot a database',
  'why agents\nsleep',
  'why BM25, not\na vector store',
];
const CARD = { w: 250, h: 92 };
const Y = 90;

const els = [];

els.push(...sectionTitle({ x: 60, y: 0, text: 'Why it’s built this way', fontSize: 32 }));

const whyCards = WHY.map((text, i) => {
  const c = { x: 40 + i * (CARD.w + 40), y: Y, w: CARD.w, h: CARD.h };
  els.push(...card({ ...c, color: 'gray', fontSize: 18, text }));
  return c;
});

const DIVE = { x: 960, y: Y, w: 260, h: CARD.h };
els.push(...card({ ...DIVE, color: 'mint', fontSize: 19, text: 'Deep-Dive Wiki\nthe full story' }));

const last = whyCards[whyCards.length - 1];
els.push(...connector({
  from: rightOf(last.x, last.y, last.w, last.h),
  to: leftOf(DIVE.x, DIVE.y, DIVE.w, DIVE.h),
}));

buildExcalidraw({ out: OUT, background: '#ffffff', elements: els });
