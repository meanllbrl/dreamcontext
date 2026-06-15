// dreamcontext "council" board — persona sub-agents debate across rounds → synthesizer → report.
const path = require('node:path');
const { buildExcalidraw } = require('../../../scripts/diagrams/excalidraw/build_excalidraw.js');
const {
  card, node, sectionTitle, connector,
  bottomOf, topOf, rightOf, leftOf,
} = require('../../../scripts/diagrams/excalidraw/lib/style.js');

const OUT = path.resolve(__dirname, 'council.excalidraw.md');
const els = [];
els.push(...sectionTitle({ x: 60, y: 8, text: 'dreamcontext — council debates', fontSize: 38 }));

// Question
const Q = { x: 320, y: 90, w: 380, h: 70 };
els.push(...card({ ...Q, color: 'blue', fontSize: 18, text: 'A hard decision\n(architecture · risk · brand)' }));

// 3 personas in a row
const PY = 250, PW = 240, PH = 92, PGAP = 60;
const personas = [
  { t: 'persona\nlens A', },
  { t: 'persona\nlens B', },
  { t: 'persona\nlens C', },
];
const bandW = personas.length * PW + (personas.length - 1) * PGAP;
const cx = Q.x + Q.w / 2;
const px0 = cx - bandW / 2;
const pCards = personas.map((p, i) => {
  const c = { x: px0 + i * (PW + PGAP), y: PY, w: PW, h: PH };
  els.push(...card({ ...c, color: 'purple', fontSize: 18, text: p.t }));
  return c;
});
// question → each persona
pCards.forEach((c) => els.push(...connector({ from: bottomOf(Q.x, Q.y, Q.w, Q.h), to: topOf(c.x, c.y, c.w, c.h) })));
// cross-talk across rounds (persona ↔ persona)
els.push(...connector({ from: rightOf(pCards[0].x, pCards[0].y, pCards[0].w, pCards[0].h), to: leftOf(pCards[1].x, pCards[1].y, pCards[1].w, pCards[1].h), label: '× rounds', double: true, dashed: true }));
els.push(...connector({ from: rightOf(pCards[1].x, pCards[1].y, pCards[1].w, pCards[1].h), to: leftOf(pCards[2].x, pCards[2].y, pCards[2].w, pCards[2].h), label: 'cross-context', double: true, dashed: true }));

// Synthesizer
const SY = { x: 360, y: 430, w: 300, h: 84 };
els.push(...card({ ...SY, color: 'mint', fontSize: 19, text: 'synthesizer\ndecision report + citations' }));
pCards.forEach((c) => els.push(...connector({ from: bottomOf(c.x, c.y, c.w, c.h), to: topOf(SY.x, SY.y, SY.w, SY.h) })));

// Promote to knowledge (optional)
const KN = { x: 380, y: 580, w: 260, h: 64 };
els.push(...node({ ...KN, color: 'green', fontSize: 16, text: 'promote → knowledge/' }));
els.push(...connector({ from: bottomOf(SY.x, SY.y, SY.w, SY.h), to: topOf(KN.x, KN.y, KN.w, KN.h), dashed: true, label: 'optional' }));

buildExcalidraw({ out: OUT, background: '#ffffff', elements: els });
