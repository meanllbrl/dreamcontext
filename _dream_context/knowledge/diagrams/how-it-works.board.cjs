// Generates the dreamcontext "how it works" source-of-truth board.
// Mirrors dashboard/src/components/about/HowItWorksDiagram.tsx.
const path = require('node:path');
const { buildExcalidraw } = require('../../../.claude/skills/excalidraw/scripts/build_excalidraw.js');
const {
  card, node, sectionTitle, connector,
  topOf, bottomOf, rightOf,
} = require('../../../.claude/skills/excalidraw/scripts/lib/style.js');

const OUT = path.resolve(__dirname, 'how-it-works.excalidraw.md');

// ── Geometry ────────────────────────────────────────────────────────────────
const HOOK = { x: 380, y: 70, w: 360, h: 88 };
const REGION = { y: 250, w: 188, h: 96, gap: 22 };
const AGENT = { x: 350, y: 470, w: 420, h: 88 };
const REM = { x: 380, y: 650, w: 360, h: 88 };

const REGIONS = [
  { file: 'soul', tag: 'Identity' },
  { file: 'user', tag: 'Episodic' },
  { file: 'memory', tag: 'Semantic' },
  { file: 'knowledge', tag: 'Procedural' },
  { file: 'state', tag: 'Working' },
];
const bandWidth = REGIONS.length * REGION.w + (REGIONS.length - 1) * REGION.gap;
const bandStart = HOOK.x + HOOK.w / 2 - bandWidth / 2; // center the band under the hook

function regionX(i) { return bandStart + i * (REGION.w + REGION.gap); }

const els = [];

els.push(...sectionTitle({ x: 60, y: 8, text: 'dreamcontext — how it works', fontSize: 40 }));

// 1) Hook
els.push(...card({ ...HOOK, color: 'blue', fontSize: 20, text: 'SessionStart hook fires\npreloads context · 0 tool calls' }));

// 2) Brain-region files
const regionCards = REGIONS.map((r, i) => {
  const x = regionX(i);
  els.push(...card({ x, y: REGION.y, w: REGION.w, h: REGION.h, color: 'purple', fontSize: 18, text: `${r.file}\n${r.tag}` }));
  return { x, y: REGION.y, w: REGION.w, h: REGION.h };
});

// 3) Agent (dark/core node)
els.push(...card({ ...AGENT, color: 'gray', fontSize: 20, text: 'Your agent works with the whole picture\nno re-exploring · no token-burning search spiral' }));

// 4) RemSleep
els.push(...card({ ...REM, color: 'mint', fontSize: 19, text: 'RemSleep consolidation ↺\ndistils the session like the brain during sleep' }));

// ── Arrows ──────────────────────────────────────────────────────────────────
// hook → each region
const hookBottom = bottomOf(HOOK.x, HOOK.y, HOOK.w, HOOK.h);
regionCards.forEach((rc, i) => {
  const label = i === 0 ? 'preload' : undefined;
  els.push(...connector({ from: hookBottom, to: topOf(rc.x, rc.y, rc.w, rc.h), label }));
});
// each region → agent
const agentTop = topOf(AGENT.x, AGENT.y, AGENT.w, AGENT.h);
regionCards.forEach((rc, i) => {
  const label = i === 2 ? 'full context' : undefined;
  els.push(...connector({ from: bottomOf(rc.x, rc.y, rc.w, rc.h), to: agentTop, label }));
});
// agent → remsleep
els.push(...connector({ from: bottomOf(AGENT.x, AGENT.y, AGENT.w, AGENT.h), to: topOf(REM.x, REM.y, REM.w, REM.h), label: 'session ends' }));

// 5) feedback loop: remsleep → back up to the region band (dashed)
const lastRegion = regionCards[regionCards.length - 1];
els.push(...connector({
  from: rightOf(REM.x, REM.y, REM.w, REM.h),
  to: bottomOf(lastRegion.x, lastRegion.y, lastRegion.w, lastRegion.h),
  label: 'consolidates & feeds back',
  dashed: true,
  strokeColor: '#6741d9',
}));

buildExcalidraw({ out: OUT, background: '#ffffff', elements: els });
