// dreamcontext "memory uplift — before/after" comparison board (2026-06-10).
// The proof artifact for the recall-context-uplift-v07 goal: recall v3 engine
// (TR+EN) validated on a blind held-out gold set, snapshot budget ladder live,
// PreCompact forget-hole closed. All numbers measured on a frozen 242-doc
// corpus via scripts/recall-ab.ts; full suite 1310 passing.
const path = require('node:path');
const { buildExcalidraw } = require('../../../../../scripts/diagrams/excalidraw/build_excalidraw.js');
const {
  card, sectionTitle, connector,
  leftOf, rightOf, prose,
} = require('../../../../../scripts/diagrams/excalidraw/lib/style.js');
const { callout } = require('../../../../../scripts/diagrams/excalidraw/lib/charts.js');

const OUT = path.resolve(__dirname, 'memory-uplift-comparison.excalidraw.md');

const els = [];
els.push(...sectionTitle({ x: 60, y: 8, text: 'dreamcontext memory uplift — measured before / after', fontSize: 36, maxWidth: 1240 }));
els.push(...prose({ x: 60, y: 64, width: 620, fontSize: 16, color: '#495057', text: 'tuned on 60q train set · validated on 30q BLIND held-out set · frozen 242-doc corpus · zero regressions' }));

// ── Column geometry ─────────────────────────────────────────────────────────
const BEFORE_X = 60, AFTER_X = 720, COL_W = 560, ROW_H = 96, GAP = 16;
let y = 150;

els.push(...sectionTitle({ x: BEFORE_X, y: y - 34, text: 'BEFORE', fontSize: 24 }));
els.push(...sectionTitle({ x: AFTER_X, y: y - 34, text: 'AFTER', fontSize: 24 }));

const rows = [
  {
    label: 'arrow: held-out, the blind judge',
    before: { color: 'red', text: 'Recall overall (blind held-out, 30q)\nrecall@1 83.3% · recall@3 90.0% · MRR 0.875' },
    after: { color: 'green', text: 'Recall overall (blind held-out, 30q)\nrecall@1 93.3% (+10) · recall@3 96.7% (+6.7) · MRR 0.957' },
  },
  {
    label: 'TR morphology + bridges',
    before: { color: 'red', text: 'Turkish recall (held-out)\nr@1 70% · r@3 80%\nsuffix gaps: sunucusu/başında unmatched, nelerdi = noise' },
    after: { color: 'green', text: 'Turkish recall (held-out)\nr@1 90% (+20) · r@3 100% (+20)\ntwo-hop suffix folding · TR→EN directed bridges · TR stopwords' },
  },
  {
    label: 'EN paraphrase + stemmer fix',
    before: { color: 'red', text: 'EN paraphrase (train) r@1 66.7%\nstemmer bug: databases≠database,\nreleases≠release — families never matched' },
    after: { color: 'green', text: 'EN paraphrase (train) r@1 91.7% (+25)\n-e fold merges word families ·\nfold/promote/brain → canonical bridges (one-way)' },
  },
  {
    label: 'the live breakage',
    before: { color: 'red', text: 'SessionStart brain: 20,253 tokens / 79.2KB\nOVER harness limit → persisted to file,\nagent saw a 2KB blind preview. Brain NOT loaded.' },
    after: { color: 'green', text: 'SessionStart brain: 10,386 tokens / 42KB\nfully inline again. Demotion ladder: curated summaries\n→ references → recall. Identity/warnings never evicted.' },
  },
  {
    label: 'forget-holes closed',
    before: { color: 'red', text: 'Compaction = decisions die mid-session\nPreCompact logged only metadata ·\nstale tasks bloated every snapshot forever' },
    after: { color: 'green', text: 'PreCompact digests the live transcript →\nrecallable on the NEXT prompt, same session ·\nsleep-tasks 21-day staleness sweep' },
  },
  {
    label: 'proof discipline',
    before: { color: 'gray', text: 'Tests: 1281 passing\nsingle gold set (tune = judge) ·\nlinkAware: untested hypothesis since v2' },
    after: { color: 'blue', text: 'Tests: 1310 passing (+29 regression locks)\ntrain/held-out split, held-out authored blind ·\nlinkAware benchmarked → REJECTED (r@1 68.3) · stays off' },
  },
];

for (const row of rows) {
  const b = { x: BEFORE_X, y, w: COL_W, h: ROW_H };
  const a = { x: AFTER_X, y, w: COL_W, h: ROW_H };
  els.push(...card({ ...b, color: row.before.color, fontSize: 15, text: row.before.text }));
  els.push(...card({ ...a, color: row.after.color, fontSize: 15, text: row.after.text }));
  els.push(...connector({
    from: rightOf(b.x, b.y, b.w, b.h),
    to: leftOf(a.x, a.y, a.w, a.h),
  }));
  y += ROW_H + GAP;
}

// ── Bottom: what shipped ────────────────────────────────────────────────────
const SHIP = { x: 60, y: y + 18, w: 1220, h: 96 };
els.push(...callout({
  ...SHIP, color: 'yellow', titleSize: 16, fontSize: 14, sideTitle: true, minH: SHIP.h,
  title: 'shipped',
  text: 'recall.ts v3 (TR two-hop stemming · -e fold · CHANGELOG_RANK_FACTOR 0.85) · recall-synonyms.ts (DIRECTED_BRIDGES) · snapshot-budget.ts (demotion ladder, DREAMCONTEXT_SNAPSHOT_BUDGET) · hook.ts (PreCompact partial digest) · session-digest.ts (partial supersede) · agents/sleep-tasks.md (staleness sweep) · eval/gold-heldout.jsonl (30q blind) · scripts/recall-ab.ts (frozen-corpus A/B)',
}));

buildExcalidraw({ out: OUT, background: '#ffffff', elements: els });
