// dreamcontext "memory upgrade plan" board.
// Solution map from the 2026-06-10 memory-system review: the snapshot outgrew
// the hook injection budget (79KB → 2KB blind harness preview), so the fix is
// a demotion ladder (never deletion), split into quick wins vs higher impact.
const path = require('node:path');
const { buildExcalidraw } = require('../../../../../scripts/diagrams/excalidraw/build_excalidraw.js');
const {
  card, sectionTitle, connector,
  topOf, bottomOf, rightOf, leftOf,
} = require('../../../../../scripts/diagrams/excalidraw/lib/style.js');

const OUT = path.resolve(__dirname, 'memory-upgrade-plan.excalidraw.md');

const els = [];
els.push(...sectionTitle({ x: 60, y: 8, text: 'dreamcontext — memory upgrade plan', fontSize: 38 }));

// ── Row 1: the problem ──────────────────────────────────────────────────────
const PROBLEM = { x: 60, y: 90, w: 560, h: 120 };
const EVIDENCE = { x: 680, y: 90, w: 560, h: 120 };
els.push(...card({
  ...PROBLEM, color: 'red', fontSize: 18,
  text: 'Snapshot outgrew the injection budget\n79KB hook output → harness keeps a 2KB blind preview\nthe brain is NOT loaded — cut is positional, not curated',
}));
els.push(...card({
  ...EVIDENCE, color: 'gray', fontSize: 17,
  text: 'why it grew (linear with project age)\ndecisions 14.7KB · 35 active tasks 10KB\n18 PRDs 8.4KB · knowledge index 8.3KB · warm 8.1KB',
}));
els.push(...connector({
  from: rightOf(PROBLEM.x, PROBLEM.y, PROBLEM.w, PROBLEM.h),
  to: leftOf(EVIDENCE.x, EVIDENCE.y, EVIDENCE.w, EVIDENCE.h),
  label: 'measured live',
}));

// ── Column A: the solution — demotion ladder ────────────────────────────────
const COLA_X = 60, COLA_W = 460;
els.push(...sectionTitle({ x: COLA_X, y: 270, text: 'The fix — demotion ladder, never deletion', fontSize: 26 }));

const TIERS = [
  { color: 'red', h: 66, text: 'never-evict tier (budget-exempt)\nwarnings · non-negotiables · salience-3' },
  { color: 'blue', h: 66, text: 'Tier 1 — full body inline\nsoul · pinned docs · hottest decisions' },
  { color: 'blue', h: 66, text: 'Tier 2 — curated summary inline\nsleep-written description, not slice(0,297)' },
  { color: 'blue', h: 66, text: 'Tier 3 — one-line reference + path\n"this exists, go read it" — one targeted Read' },
  { color: 'purple', h: 66, text: 'Tier 4 — recall corpus only\nre-surfaced per-prompt by the recall hook' },
];
let ty = 330;
const tierBoxes = [];
for (const t of TIERS) {
  els.push(...card({ x: COLA_X, y: ty, w: COLA_W, h: t.h, color: t.color, fontSize: 16, text: t.text }));
  tierBoxes.push({ x: COLA_X, y: ty, w: COLA_W, h: t.h });
  ty += t.h + 18;
}
// pressure arrow alongside the ladder
els.push(...connector({
  from: { x: COLA_X + COLA_W + 50, y: tierBoxes[1].y + 10 },
  to: { x: COLA_X + COLA_W + 50, y: tierBoxes[4].y + 40 },
  label: 'budget pressure\ndemotes, never deletes',
}));
const LADDER_NOTE = { x: COLA_X, y: ty + 6, w: COLA_W, h: 76 };
els.push(...card({
  ...LADDER_NOTE, color: 'mint', fontSize: 16,
  text: 'safety net: UserPromptSubmit recall knows the\nprompt — tier-4 docs return exactly when relevant',
}));

// problem → solution
els.push(...connector({
  from: bottomOf(PROBLEM.x, PROBLEM.y, PROBLEM.w, PROBLEM.h),
  to: topOf(tierBoxes[0].x, tierBoxes[0].y, tierBoxes[0].w, tierBoxes[0].h),
  label: 'we choose the cut,\nnot the harness',
}));

// ── Column B: quick wins ────────────────────────────────────────────────────
const COLB_X = 640, COLB_W = 480;
els.push(...sectionTitle({ x: COLB_X, y: 270, text: 'Quick wins — days, low risk', fontSize: 26 }));

const WINS = [
  'sleep-tasks staleness rule\n35 active tasks → flag + archive stale ones\n≈10KB snapshot cut · effort S · impact high',
  'kill slice() char truncation\nuse curated frontmatter descriptions instead\nno more mid-sentence chops · effort S',
  'PreCompact → digest live transcript\nreuse the session-digest pipeline as-is\ncompacted-away decisions land in corpus · effort S-M',
  'digest expiry gated on consolidation\nK=50 cap drops only sleep-processed digests\nnothing forgotten before it is consolidated · effort S',
];
let wy = 330;
const winBoxes = [];
for (const w of WINS) {
  els.push(...card({ x: COLB_X, y: wy, w: COLB_W, h: 96, color: 'green', fontSize: 16, text: w }));
  winBoxes.push({ x: COLB_X, y: wy, w: COLB_W, h: 96 });
  wy += 96 + 18;
}

// ── Column C: higher impact ─────────────────────────────────────────────────
const COLC_X = 1200, COLC_W = 510;
els.push(...sectionTitle({ x: COLC_X, y: 270, text: 'Higher impact — the flagship work', fontSize: 26 }));

const BIG = [
  { color: 'purple', text: 'snapshot hard token budget (~10-12K)\nenforces the demotion ladder + never-evict tier\nfixes the live 79KB breakage · effort M · impact ★★★' },
  { color: 'purple', text: 'sleep coverage audit at `sleep done`\nevery salience≥2 bookmark/decision must be referenced\nby changelog/knowledge/task — else warn with orphans' },
  { color: 'purple', text: 'section-level (H2) recall chunking\nhit the right section, not a 300-line file\nsharper Haiku index entries + cheaper follow-up reads' },
  { color: 'gray', text: 'behind measured triggers (not yet)\nhierarchical knowledge index · persistent mtime index\n5K-doc benchmark · Haiku salience extraction' },
];
let by = 330;
const bigBoxes = [];
for (const b of BIG) {
  els.push(...card({ x: COLC_X, y: by, w: COLC_W, h: 96, color: b.color, fontSize: 16, text: b.text }));
  bigBoxes.push({ x: COLC_X, y: by, w: COLC_W, h: 96 });
  by += 96 + 18;
}

// ladder is implemented by the flagship budget card
els.push(...connector({
  from: rightOf(tierBoxes[2].x, tierBoxes[2].y, tierBoxes[2].w, tierBoxes[2].h),
  to: leftOf(winBoxes[0].x, winBoxes[0].y, winBoxes[0].w, winBoxes[0].h),
  label: 'start here',
  dashed: true,
}));
els.push(...connector({
  from: rightOf(winBoxes[0].x, winBoxes[0].y, winBoxes[0].w, winBoxes[0].h),
  to: leftOf(bigBoxes[0].x, bigBoxes[0].y, bigBoxes[0].w, bigBoxes[0].h),
  label: 'then',
  dashed: true,
}));

// ── Bottom: execution order ─────────────────────────────────────────────────
const ORDER = { x: 640, y: wy + 24, w: 1070, h: 84 };
els.push(...card({
  ...ORDER, color: 'yellow', fontSize: 17,
  text: 'order: 1 staleness rule → 2 PreCompact digest → 3 budget + demotion ladder → 4 coverage audit\n→ 5 H2 chunking → scale items only when corpus metrics trigger them',
}));

buildExcalidraw({ out: OUT, background: '#ffffff', elements: els });
