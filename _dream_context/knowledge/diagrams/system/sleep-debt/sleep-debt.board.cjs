// dreamcontext — sleep debt: how a session is scored, and what caps how often
// the brain is allowed to ask for a consolidation.
//
// Every number on this board is MEASURED, not chosen: the session-score
// distribution comes from 395 real transcripts, the daily-volume bars from 30
// real days of this project. Regenerate with:
//   node _dream_context/knowledge/diagrams/system/sleep-debt/sleep-debt.board.cjs
const path = require('node:path');
const { buildExcalidraw } = require('../../../../../scripts/diagrams/excalidraw/build_excalidraw.js');
const {
  card, sectionTitle, connector, chip, prose, stack, row, rightOf, leftOf,
} = require('../../../../../scripts/diagrams/excalidraw/lib/style.js');
const { lineChart, barChart, table, callout, kpi } = require('../../../../../scripts/diagrams/excalidraw/lib/charts.js');

const OUT = path.resolve(__dirname, 'sleep-debt.excalidraw.md');
const els = [];
const P = (a) => { els.push(...a); return a; };

// ── 1. Session score ────────────────────────────────────────────────────────
P(sectionTitle({ x: 60, y: 30, text: 'Uyku borcu — hesap ve limitler', fontSize: 44 }));
P(prose({
  x: 60, y: 100,
  text: 'Her biten oturum 0–10 arası tam sayı bir skor alır. Skor dört eksenin '
      + 'log-sıkıştırmalı AĞIRLIKLI TOPLAMI — eskiden max() idi ve oturumların %77\'si '
      + 'tavana çarpıyordu.',
  fontSize: 16,
}));

P(sectionTitle({ x: 60, y: 205, text: '1 · Oturum skoru (0–10)', fontSize: 28 }));

const AX_Y = 265, AX_W = 232, AX_H = 118, AX_GAP = 22;
const AXES = [
  { t: 'novel token\nağırlık 4.0', c: 'blue',   note: 'k=100k · full=3.5M' },
  { t: 'dosya değişikliği\nağırlık 3.0', c: 'purple', note: 'k=2 · full=40' },
  { t: 'tool çağrısı\nağırlık 1.5', c: 'yellow', note: 'k=10 · full=200' },
  { t: 'substance\nağırlık 1.5', c: 'mint',   note: 'karar · task · tur' },
];
AXES.forEach((a, i) => {
  const x = 60 + i * (AX_W + AX_GAP);
  P(card({ x, y: AX_Y, w: AX_W, h: AX_H, text: a.t, color: a.c, fontSize: 17 }));
  P(chip({ x: x + 14, y: AX_Y + AX_H + 10, text: a.note, color: 'gray', fontSize: 12 }));
  // A '+' in each gap: without it the single arrow into TOPLA reads as though
  // only the LAST axis feeds the sum.
  if (i < AXES.length - 1) {
    els.push({ type: 'text', x: x + AX_W + 4, y: AX_Y + AX_H / 2 - 14, text: '+', fontSize: 24 });
  }
});

const SUM = { x: 60 + 4 * (AX_W + AX_GAP) + 40, y: AX_Y - 6, w: 250, h: 130 };
P(card({ x: SUM.x, y: SUM.y, w: SUM.w, h: SUM.h, text: 'TOPLA\nyuvarla\n→ 0–10', color: 'green', fontSize: 22 }));
P(connector({
  from: rightOf(60 + 3 * (AX_W + AX_GAP), AX_Y, AX_W, AX_H),
  to: leftOf(SUM.x, SUM.y, SUM.w, SUM.h),
}));

// The log curve — why one huge session cannot swamp every threshold.
P(lineChart({
  x: 60, y: 440, w: 700, h: 300,
  title: 'Token ekseni: log eğrisi (0 → 4 puan)',
  xLabels: ['0', '100k', '300k', '700k', '1.5M', '2.5M', '3.5M', '8M'],
  series: [{ label: 'puan', color: 'blue', points: [0, 0.77, 1.55, 2.32, 3.09, 3.64, 4.0, 4.0] }],
  yTitle: 'puan', area: true, legend: false,
}));

P(callout({
  x: 800, y: 440, w: 560, color: 'red', title: 'cache_read SAYILMAZ',
  text: 'output + cache_creation + input toplanır. cache_read her turda yeniden okunan '
      + 'AYNI bağlam — gerçek transcript\'lerde novel\'in 20–40 katı (bir oturumda 341M\'e '
      + 'karşı 15.6M). Sayılsaydı "iş" değil "tur × bağlam boyutu" ölçülürdü.',
}));
P(callout({
  x: 800, y: 640, w: 560, color: 'gray', title: 'Sub-agent\'lar',
  text: 'subagents/agent-*.jsonl de katlanır. Fan-out\'lu bir oturum eskiden ledger\'a '
      + 'tek bir Task çağrısı olarak giriyordu.',
}));

// ── 2. Debt ladder ──────────────────────────────────────────────────────────
P(sectionTitle({ x: 60, y: 800, text: '2 · Borç merdiveni', fontSize: 28 }));
P(table({
  x: 60, y: 860,
  headers: ['Seviye', 'Debt', 'Ajan ne yapar'],
  rows: [
    [{ text: 'Alert', color: 'gray' },  '0–23',  'sessiz'],
    [{ text: 'Drowsy', color: 'yellow' }, '24–39', 'görev bitince ÖNERİR'],
    [{ text: 'Sleepy', color: 'blue' },  '40–59', 'işe başlamadan TAVSİYE eder'],
    [{ text: 'Must Sleep', color: 'red' }, '60+',   'konsolide eder'],
  ],
  fontSize: 15,
}));
P(callout({
  x: 60, y: 1090, w: 620, color: 'purple', title: 'deep ≠ Must Sleep',
  text: 'Yıkıcı knowledge işlemleri (merge-with-delete, archive/delete) ayrı bir eşikte: '
      + 'debt 90. "Konsolidasyon gecikti" ile "silmeye yetkilisin" farklı iddialar.',
}));

// ── 3. Daily volume + the ceiling ───────────────────────────────────────────
P(sectionTitle({ x: 760, y: 800, text: '3 · Günlük hacim → günde maks 3', fontSize: 28 }));
P(barChart({
  x: 760, y: 860, w: 560, h: 300,
  title: 'Günlük biriken debt (30 gerçek gün)',
  bars: [
    { label: 'p25', value: 12, color: 'gray' },
    { label: 'p50', value: 42, color: 'yellow' },
    { label: 'p75', value: 107, color: 'blue' },
    { label: 'p90', value: 168, color: 'purple' },
    { label: 'max', value: 185, color: 'red' },
  ],
}));
P(barChart({
  x: 1360, y: 860, w: 460, h: 300,
  title: 'O gün kaç ZORUNLU uyku (eşik 60)',
  bars: [
    { label: 'p25', value: 0, color: 'gray' },
    { label: 'p50', value: 0, color: 'yellow' },
    { label: 'p75', value: 1, color: 'blue' },
    { label: 'p90', value: 2, color: 'purple' },
    { label: 'max', value: 3, color: 'red' },
  ],
  yTitle: 'uyku', yMax: 4,
}));
P(callout({
  x: 760, y: 1190, w: 620, color: 'green', title: 'Tavan buradan geliyor',
  text: 'Eşik 60, dağılımdan okundu: medyan gün HİÇ zorunlu uyku istemez (sadece tavsiye — '
      + 'kararı kullanıcı verir), en yoğun gün 3. Eşik 30 olsaydı en yoğun gün 6 isterdi.',
}));

// ── 4. Cooldown ─────────────────────────────────────────────────────────────
P(sectionTitle({ x: 60, y: 1290, text: '4 · Cooldown — zaman tabanı (3 saat)', fontSize: 28 }));
P(prose({
  x: 60, y: 1348,
  text: 'Eşik "bir uykunun kaç iş değerinde olduğunu" sınırlar; iki uykunun ne kadar YAKIN '
      + 'düştüğünü sınırlayamaz. Yoğun bir öğleden sonra üçünü üç saate sıkıştırabilir.',
  fontSize: 16,
}));

const CD_Y = 1440, CD_H = 96;
const A = { x: 60, y: CD_Y, w: 270, h: CD_H };
const B = { x: 400, y: CD_Y, w: 430, h: CD_H };
const C = { x: 900, y: CD_Y, w: 300, h: CD_H };
P(card({ ...A, text: 'sleep done\nlast_consolidated_at', color: 'green', fontSize: 17 }));
P(card({ ...B, text: '3 SAAT — hooks susar\n"Cooling down · 2h 5m"', color: 'gray', fontSize: 18 }));
P(card({ ...C, text: 'yeniden sorabilir', color: 'blue', fontSize: 18 }));
P(connector({ from: rightOf(A.x, A.y, A.w, A.h), to: leftOf(B.x, B.y, B.w, B.h) }));
P(connector({ from: rightOf(B.x, B.y, B.w, B.h), to: leftOf(C.x, C.y, C.w, C.h) }));

P(sectionTitle({ x: 60, y: 1580, text: 'Cooldown\'u aşan üç şey', fontSize: 20 }));
const BY = 1625, BW = 400, BH = 92;
[
  { t: '★★★ bookmark\nsalience 3\'ü sadece insan koyar', c: 'red' },
  { t: 'debt ≥ 120\n2× Must Sleep — kaçış kapağı', c: 'yellow' },
  { t: 'KULLANICI isterse\nher zaman uyur', c: 'green' },
].forEach((b, i) => P(card({ x: 60 + i * (BW + 24), y: BY, w: BW, h: BH, text: b.t, color: b.c, fontSize: 16 })));

P(callout({
  x: 60, y: 1750, w: 640, color: 'gray', title: 'Bozuk damga = cooldown yok',
  text: 'null, okunamayan veya GELECEK tarihli last_consolidated_at → pencere hiç açılmaz. '
      + 'Kötü bir timestamp beyni en fazla eskisi gibi dürtükletebilir, asla kalıcı susturamaz. '
      + 'Süren bir uyku kilidi ise cooldown\'dan önce gelir.',
}));

buildExcalidraw({
  out: OUT,
  background: '#ffffff',
  name: 'sleep-debt',
  tags: ['architecture', 'sleep', 'excalidraw'],
  description: 'How dreamcontext scores sleep debt and what limits consolidation frequency. '
    + 'Session score is a log-compressed weighted sum over four axes (novel tokens 4, file changes 3, '
    + 'tool calls 1.5, substance 1.5) rounded to 0-10; cache_read tokens are deliberately excluded and '
    + 'sub-agent transcripts are folded in. Debt levels Alert 0-23 / Drowsy 24-39 / Sleepy 40-59 / '
    + 'Must Sleep 60+, with destructive deep authority split off at 90. Thresholds are calibrated '
    + 'against 30 days of measured daily volume so the busiest day demands at most 3 consolidations, '
    + 'and a 3-hour post-consolidation cooldown enforces the time floor between them.',
  elements: els,
});
