// dreamcontext "memory recall" source-of-truth board.
// Mirrors the dashboard RECALL_FLOW_SPEC: prompt → BM25F → Haiku → snapshot.
const path = require('node:path');
const { buildExcalidraw } = require('../../../scripts/diagrams/excalidraw/build_excalidraw.js');
const {
  card, sectionTitle, connector,
  rightOf, leftOf,
} = require('../../../scripts/diagrams/excalidraw/lib/style.js');

const OUT = path.resolve(__dirname, 'recall.excalidraw.md');

const Y = 200;
const W = 250;
const H = 120;
const GAP = 78;
const X0 = 60;
const stageX = (i) => X0 + i * (W + GAP);

const STAGES = [
  { color: 'blue', title: 'Your prompt', sub: 'any language' },
  { color: 'purple', title: 'BM25F keyword match', sub: 'field-weighted · stemming' },
  { color: 'purple', title: 'Haiku recall', sub: 'smallest cloud agent\n0-3 docs · BM25 fallback' },
  { color: 'mint', title: 'SessionStart snapshot', sub: 'warm + cold · features\nindex · pinned' },
];
const LABELS = [undefined, 'match', 'sharpen', 'assemble'];

const els = [];
els.push(...sectionTitle({ x: 60, y: 60, text: 'dreamcontext — how recall surfaces context', fontSize: 36 }));

const cards = STAGES.map((s, i) => {
  const x = stageX(i);
  els.push(...card({ x, y: Y, w: W, h: H, color: s.color, fontSize: 18, text: `${s.title}\n${s.sub}` }));
  return { x, y: Y, w: W, h: H };
});

for (let i = 1; i < cards.length; i++) {
  const prev = cards[i - 1];
  const cur = cards[i];
  els.push(...connector({ from: rightOf(prev.x, prev.y, prev.w, prev.h), to: leftOf(cur.x, cur.y, cur.w, cur.h), label: LABELS[i] }));
}

buildExcalidraw({ out: OUT, background: '#ffffff', elements: els });
