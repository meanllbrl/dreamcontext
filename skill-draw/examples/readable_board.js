#!/usr/bin/env node
// readable_board.js — the typography + emphasis kit, and the wall-of-text it replaced.
//
// Left column: how a finding used to ship (one blob of 15px handwriting on 1.25 leading).
// Right column: the same finding as structure — a lead, bullets, and emphasis on the numbers that
// carry the argument. Same words, ~4x faster to read.
//
//   node examples/readable_board.js
const path = require('path');
const { buildExcalidraw } = require('../scripts/build_excalidraw.js');
const S = require('../scripts/lib/style.js');
const C = require('../scripts/lib/charts.js');

const els = [];
const push = (a) => { els.push(...a); return a; };

push(S.sectionTitle({ x: 0, y: 0, text: 'Reading a board', fontSize: 40 }));
push(S.takeaway({
  x: 0, y: 70, width: 760, accent: 'blue', label: 'IN A NUTSHELL',
  text: 'A board is read at a **glance**, not at a sitting. Lead with the conclusion, keep a block under ==4 lines==, and mark the one number the argument rests on.',
}));

// ── the old shape ────────────────────────────────────────────────────────
push(S.prose({ x: 0, y: 230, width: 520, text: 'BEFORE — one blob, nothing to land on', fontSize: 15, color: '#868e96' }));
push(C.callout({
  x: 0, y: 262, w: 540, color: 'red', fit: false, font: 'hand', fontSize: 15, lh: 1.25,
  title: '"Paywall geçişi %99,8" bir metrik DEĞİL',
  text: 'Bu tahtanın ilk sürümü lead → paywall oranını %99,8 diye raporlayıp "bu adımda sızıntı yok" demişti. Rakam aritmetik olarak doğru ama anlamsız: /checkout sayfası email submitin arkasına kilitli. Hafta boyunca 17.613 paywall görüntüleyenin sadece 2\'si lead bırakmadan oraya ulaşabildi, ve 17.611 eşleşmenin 17.607\'sinde paywall görünümü leadden SONRA geliyor.',
}));

// ── the new shape ────────────────────────────────────────────────────────
push(S.prose({ x: 640, y: 230, width: 520, text: 'AFTER — lead, evidence, emphasis', fontSize: 15, color: '#868e96' }));
push(C.callout({
  x: 640, y: 262, w: 540, color: 'green', fit: false,
  title: 'Paywall geçişi',
  lead: '%99,8 bir metrik değil, bir ==yönlendirme==.',
  items: [
    '`/checkout` email submitin arkasına ==kilitli==.',
    '17.613 paywall görüntüleyenin ==sadece 2\'si== lead bırakmadan ulaştı.',
    '17.611 eşleşmenin ==17.607\'sinde== paywall, leadden **sonra** geliyor.',
  ],
}));

// ── the three emphases, isolated ─────────────────────────────────────────
push(S.sectionTitle({ x: 0, y: 640, text: 'Emphasis is geometry, not a second font', fontSize: 24 }));
push(S.bullets({
  x: 0, y: 690, width: 620, items: [
    'Double asterisks draw a **rule under the phrase** — for the claim itself.',
    'Double equals paints a ==highlighter band== — for the number the claim rests on.',
    'Backticks set a soft chip — for identifiers like `analytics.all_merged` and paths.',
    'The paragraph stays **one text element**, so recall still extracts clean prose.',
  ],
}));

const res = buildExcalidraw({
  out: path.resolve(__dirname, 'Readable Board.excalidraw.md'),
  name: 'Readable Board',
  description: 'Typography + emphasis demo: the wall-of-text callout versus the same finding as lead, bullets and marked numbers.',
  elements: els,
});
console.log(`readable demo → ${res.outPath}\n  overlaps=${res.overlaps} buriedText=${res.buriedText} longLines=${res.longLines} wallOfText=${res.wallOfText}`);
