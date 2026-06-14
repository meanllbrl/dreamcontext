// Issue #9 — Sleep quality story board: ne kötüydü → ne planladım → nasıl çözdüm → nasıl gelişti
const path = require('path');
const { buildExcalidraw } = require(path.resolve(__dirname, '../../.claude/skills/excalidraw/scripts/build_excalidraw.js'));
const { card, sectionTitle, connector } = require(path.resolve(__dirname, '../../.claude/skills/excalidraw/scripts/lib/style.js'));

const W = 380;        // column / card width
const FS = 15;        // body font size
const GAP = 16;       // vertical gap between cards
const TOPY = 150;     // first card y
const COLS = { c1: 60, c2: 500, c3: 940, c4: 1380 };

// stack a list of {text,color,h,fontSize} cards in a column, return {elements, midY}
function stack(x, items, topY = TOPY) {
  const out = [];
  let y = topY;
  const ys = [];
  for (const it of items) {
    const h = it.h || 70;
    ys.push([y, h]);
    out.push(...card({ x, y, w: W, h, text: it.text, color: it.color, fontSize: it.fontSize || FS }));
    y += h + GAP;
  }
  // mid of the whole column (for wiring arrows)
  const first = ys[0][0];
  const last = ys[ys.length - 1][0] + ys[ys.length - 1][1];
  return { elements: out, midY: (first + last) / 2, bottom: last };
}

// ── Title ──────────────────────────────────────────────────────────────────
const title = sectionTitle({ x: COLS.c1, y: 30, text: 'Issue #9 — Uyku (Sleep) Kalitesini Iyilestirme', fontSize: 34 });
const subtitle = [{ type: 'text', x: COLS.c1, y: 82, text: 'goal-skill orkestrasyonu: plan → 3 reviewer → uygula → review → validate', fontSize: 16, color: '#495057', fontFamily: 5, width: 1100 }];

// ── Column headers ──────────────────────────────────────────────────────────
const h1 = sectionTitle({ x: COLS.c1, y: 112, text: 'Ne kotuydu?', fontSize: 24, color: '#e03131' });
const h2 = sectionTitle({ x: COLS.c2, y: 112, text: 'Ne planladim?', fontSize: 24, color: '#1971c2' });
const h3 = sectionTitle({ x: COLS.c3, y: 112, text: 'Nasil cozdum?', fontSize: 24, color: '#6741d9' });
const h4 = sectionTitle({ x: COLS.c4, y: 112, text: 'Nasil gelisti?', fontSize: 24, color: '#2f9e44' });

// ── Col 1 — problems (red) ──────────────────────────────────────────────────
const col1 = stack(COLS.c1, [
  { text: 'Kritik invariant\'lar test edilemez: epoch temizleme + debt hesabi sleep.ts .action() icine gomulu', color: 'red', h: 100 },
  { text: '22 lifecycle invariant = sifir test (hepsi it.todo)', color: 'red', h: 70 },
  { text: 'Debt skoru yalniz dosya/arac sayisi → "edit yok ama cok bilgi paylasildi" seanslari dusuk puan', color: 'red', h: 100 },
  { text: 'Knowledge ops (birlestir/sil/ozetle) HER ZAMAN calisiyor — derinlik (sleep mode) kontrolu yok', color: 'red', h: 100 },
  { text: 'Kisi-bazli atif + feature PRD bakimi zayif', color: 'red', h: 70 },
]);

// ── Col 2 — plan (blue) ─────────────────────────────────────────────────────
const col2 = stack(COLS.c2, [
  { text: 'WS1: saf, export\'lu fonksiyonlar cikar — davranis DEGISMEDEN (golden test)', color: 'blue', h: 85 },
  { text: 'WS2: her it.todo → gercek gecen test', color: 'blue', h: 60 },
  { text: 'WS3: kanita dayali specialist roster karari', color: 'blue', h: 60 },
  { text: 'WS4: kisi-bazli atif + capture→promote denetimi', color: 'blue', h: 70 },
  { text: 'EK: debt\'e gore DINAMIK derinlik + substance-weighted debt', color: 'paleBlue', h: 85 },
  { text: 'Olcum: deterministik eval (BEFORE→AFTER, LLM\'siz)', color: 'paleBlue', h: 70 },
]);

// ── Col 3 — solution (purple) ───────────────────────────────────────────────
const col3 = stack(COLS.c3, [
  { text: 'sleep-consolidation.ts: saf fonksiyonlar (applyConsolidation, consolidationDepth, isDestructiveAllowed)', color: 'purple', h: 100 },
  { text: 'scoreFromSubstance: bilgi-yogun seanslari yakalar → max(change, tool, substance)', color: 'purple', h: 85 },
  { text: 'Depth gating: deep\'te birlestir/sil + "archive-before-delete" guvenlik agi', color: 'purple', h: 85 },
  { text: 'attribution.ts: attributeByPerson (bot-filtreli, phantom yok)', color: 'palePurple', h: 70 },
  { text: 'eval/sleep-quality/: scorer + fixture + gold (deterministik)', color: 'palePurple', h: 70 },
  { text: '3 reviewer turu → tum blocking bulgular duzeltildi (iter 2/3 SOLID)', color: 'palePurple', h: 70 },
]);

// ── Col 4 — results (green/mint) ────────────────────────────────────────────
const col4 = stack(COLS.c4, [
  { text: 'Eval OVERALL  57.1 → 100.0\n(Δ +42.9)', color: 'mint', h: 95, fontSize: 22 },
  { text: 'Attribution coverage  0 → 100', color: 'green', h: 55 },
  { text: 'Substance scoring  0 → 100', color: 'green', h: 55 },
  { text: 'Depth-gating  0 → 100', color: 'green', h: 55 },
  { text: 'Regression guard\'lar 100\'de sabit (veri kaybi yok)', color: 'paleGreen', h: 70 },
  { text: 'Tum test suite: 1922 passed, 0 fail · build temiz', color: 'paleGreen', h: 70 },
  { text: 'WS3: stale %9 < %40 → 3 specialist korundu + self-report', color: 'paleGreen', h: 70 },
]);

// ── Flow arrows between columns ─────────────────────────────────────────────
const ay = 300;
const arrows = [
  ...connector({ from: [COLS.c1 + W + 5, ay], to: [COLS.c2 - 5, ay], label: 'planla' }),
  ...connector({ from: [COLS.c2 + W + 5, ay], to: [COLS.c3 - 5, ay], label: 'uygula' }),
  ...connector({ from: [COLS.c3 + W + 5, ay], to: [COLS.c4 - 5, ay], label: 'olc' }),
];

buildExcalidraw({
  out: path.resolve(__dirname, '../Issue9-Sleep-Quality.excalidraw.md'),
  background: '#ffffff',
  elements: [
    ...title, ...subtitle, ...h1, ...h2, ...h3, ...h4,
    ...col1.elements, ...col2.elements, ...col3.elements, ...col4.elements,
    ...arrows,
  ],
});
