// Generates the README "what lives inside" board: the surfaces of the project —
// one memory engine, many faces, all readable by humans and loaded by agents.
const path = require('node:path');
const { buildExcalidraw } = require('../../../../../scripts/diagrams/excalidraw/build_excalidraw.js');
const {
  card, sectionTitle, prose, connector,
  rightOf, leftOf,
} = require('../../../../../scripts/diagrams/excalidraw/lib/style.js');

const OUT = path.resolve(__dirname, 'surfaces.excalidraw.md');

// ── Geometry — center engine, three surfaces per side ───────────────────────
const CENTER = { x: 440, y: 330, w: 340, h: 120 };
const COL = { w: 310, h: 110 };
const LEFT_X = 40;
const RIGHT_X = 870;
const ROW_Y = [140, 330, 520];

const LEFT = [
  { color: 'purple', text: 'Knowledge\ncurated, wikilinked docs —\nalways current, never a dump' },
  { color: 'blue', text: 'Features & PRDs\nliving product specs, tied to\nthe real work and releases' },
  { color: 'green', text: 'Tasks & Roadmap\nkanban, sprints, OKRs —\nwith forecast slip detection' },
];
const RIGHT = [
  { color: 'yellow', text: 'Lab insights\nlive metrics from your analytics,\ncached in the brain' },
  { color: 'mint', text: 'Council\nmulti-persona debates\nfor the hard calls' },
  { color: 'gray', text: 'Team sync\ngit brain sync · ClickUp /\nGitHub task backends' },
];

const els = [];

els.push(...sectionTitle({ x: 60, y: 0, text: 'One engine, many faces', fontSize: 36 }));
els.push(...prose({ x: 62, y: 56, fontSize: 18, text: 'Every surface is the same memory mechanism wearing a different face — readable by you, loaded by your agents.' }));

els.push(...card({ ...CENTER, color: 'purple', fontSize: 20, text: '_dream_context/\none memory engine\nplain files · git-tracked · yours' }));

LEFT.forEach((s, i) => {
  const c = { x: LEFT_X, y: ROW_Y[i], w: COL.w, h: COL.h };
  els.push(...card({ ...c, color: s.color, fontSize: 18, text: s.text }));
  els.push(...connector({
    from: leftOf(CENTER.x, CENTER.y, CENTER.w, CENTER.h),
    to: rightOf(c.x, c.y, c.w, c.h),
    elbow: 'hv',
  }));
});
RIGHT.forEach((s, i) => {
  const c = { x: RIGHT_X, y: ROW_Y[i], w: COL.w, h: COL.h };
  els.push(...card({ ...c, color: s.color, fontSize: 18, text: s.text }));
  els.push(...connector({
    from: rightOf(CENTER.x, CENTER.y, CENTER.w, CENTER.h),
    to: leftOf(c.x, c.y, c.w, c.h),
    elbow: 'hv',
  }));
});

buildExcalidraw({ out: OUT, background: '#ffffff', elements: els });
