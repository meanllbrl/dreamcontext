// licensing.board.cjs — visual explainer of dreamcontext's open-source / source-available options.
// Run:  node scripts/diagrams/licensing.board.cjs
// Renders to _dream_context/knowledge/diagrams/product/licensing/licensing.excalidraw.md (open in Obsidian Excalidraw).
const path = require('path');
const SKILL = path.join(__dirname, '..', '..', '.claude', 'skills', 'excalidraw', 'scripts');
const { buildExcalidraw } = require(path.join(SKILL, 'build_excalidraw.js'));
const { card, node, sectionTitle, connector } = require(path.join(SKILL, 'lib', 'style.js'));

const els = [];
const P = (...a) => els.push(...a.flat());
const T = (x, y, text, fontSize, color, width) =>
  els.push({ type: 'text', x, y, text, fontSize: fontSize || 16, color: color || '#495057', fontFamily: 5, width: width || Math.max(120, String(text).length * (fontSize || 16) * 0.6), align: 'left' });
const dline = (x1, y1, x2, y2) =>
  els.push({ type: 'line', points: [[x1, y1], [x2, y2]], strokeColor: '#adb5bd', strokeWidth: 1.5, strokeStyle: 'dashed' });

// ===== TITLE =====
P(sectionTitle({ x: 40, y: -40, text: 'dreamcontext — Lisans Seçenekleri', fontSize: 40 }));

// ===== SLIDE 1 — the spectrum =====
P(sectionTitle({ x: 40, y: 40, text: '1 · Lisans Yelpazesi: Açıktan Korumalıya', fontSize: 26, color: '#6741d9' }));

// band labels
T(40, 120, 'AÇIK KAYNAK (OSS) — satışı ENGELLEYEMEZSİN', 15, '#2f9e44', 500);
T(560, 120, 'SOURCE-AVAILABLE — kuralı SEN koyarsın', 15, '#f08c00', 740);
T(1336, 120, 'KAPALI', 15, '#868e96', 220);

const SPEC = [
  { t: `MIT  (şu an)\nHerkes kullanır,\ndeğiştirir, SATAR.\nSıfır koruma.`, c: 'green' },
  { t: `Apache-2.0\nMIT + patent\n+ marka.\nYine de satılır.`, c: 'paleGreen' },
  { t: `PolyForm Shield\nRekabet hariç\nher şey serbest.`, c: 'yellow' },
  { t: `BSL 1.1\nKişisel/iç kullanım\nserbest.\n~4 yılda OSS olur.`, c: 'yellow' },
  { t: `PolyForm\nInternal Use  ★\nKişisel + şirket-içi\nserbest. Satış YASAK.`, c: 'purple' },
  { t: `Kapalı\nKaynak gizli.`, c: 'gray' },
];
const SW = 232, SGAP = 26, SX0 = 40, SY = 152, SH = 124;
SPEC.forEach((s, i) => P(card({ x: SX0 + i * (SW + SGAP), y: SY, w: SW, h: SH, text: s.t, color: s.c, fontSize: 14 })));

// boundary dividers between the three bands
dline(SX0 + 2 * (SW + SGAP) - SGAP / 2, 116, SX0 + 2 * (SW + SGAP) - SGAP / 2, SY + SH + 8);
dline(SX0 + 5 * (SW + SGAP) - SGAP / 2, 116, SX0 + 5 * (SW + SGAP) - SGAP / 2, SY + SH + 8);

// the open→protected axis under the cards
els.push({ type: 'arrow', points: [[SX0, SY + SH + 26], [SX0 + 6 * SW + 5 * SGAP, SY + SH + 26]], strokeColor: '#868e96', strokeWidth: 2, startArrow: 'arrow', endArrow: 'arrow' });
T(SX0, SY + SH + 30, 'daha AÇIK', 14, '#2f9e44', 160);
T(SX0 + 6 * SW + 5 * SGAP - 170, SY + SH + 30, 'daha KORUMALI', 14, '#e03131', 170);

// ===== SLIDE 2 — your rules across 3 licenses =====
const M_Y = 392;
P(sectionTitle({ x: 40, y: M_Y, text: '2 · Senin Kuralların 3 Lisansta', fontSize: 26, color: '#6741d9' }));
T(40, M_Y + 38, 'Renk = senin niyetine uyuyor mu?   yeşil = istediğin gibi · kırmızı = istemediğin · sarı = kısmen', 14, '#868e96', 1200);

const RULE_X = 40, RULE_W = 430, COL_W = 290, GAP = 16;
const MIT_X = RULE_X + RULE_W + GAP;          // 486
const IU_X = MIT_X + COL_W + GAP;             // 792
const BSL_X = IU_X + COL_W + GAP;             // 1098
const HEAD_Y = M_Y + 78, ROW0 = HEAD_Y + 78, RH = 56, RGAP = 10, STEP = RH + RGAP;

// header row
P(card({ x: RULE_X, y: HEAD_Y, w: RULE_W, h: 60, text: 'SENİN KURALIN', color: 'gray', fontSize: 18 }));
P(card({ x: MIT_X, y: HEAD_Y, w: COL_W, h: 60, text: 'MIT  (şu an)', color: 'green', fontSize: 17 }));
P(card({ x: IU_X, y: HEAD_Y, w: COL_W, h: 60, text: 'PolyForm Internal Use  ★', color: 'purple', fontSize: 16 }));
P(card({ x: BSL_X, y: HEAD_Y, w: COL_W, h: 60, text: 'BSL 1.1', color: 'yellow', fontSize: 17 }));

const ROWS = [
  { r: 'Kişisel kullanım', mit: ['serbest', 'green'], iu: ['serbest', 'green'], bsl: ['serbest', 'green'] },
  { r: 'Şirketin iç verimi (ticari şirket dahil)', mit: ['serbest', 'green'], iu: ['serbest', 'green'], bsl: ['serbest', 'green'] },
  { r: 'Freelancer kendi işinde kazanması', mit: ['serbest', 'green'], iu: ['serbest', 'green'], bsl: ['serbest', 'green'] },
  { r: 'Yeniden satış / dağıtım', mit: ['serbest', 'red'], iu: ['YASAK', 'green'], bsl: ['YASAK', 'green'] },
  { r: 'Üzerine ürün yapıp satmak', mit: ['serbest', 'red'], iu: ['YASAK', 'green'], bsl: ['~4y sonra serbest', 'yellow'] },
  { r: 'Marka / isim koruması', mit: ['yok', 'red'], iu: ['+ NOTICE', 'green'], bsl: ['+ NOTICE', 'green'] },
  { r: 'Süresiz kapalı kalır (asla satılamaz)', mit: ['hayır', 'red'], iu: ['EVET', 'green'], bsl: ['~4 yılda açılır', 'yellow'] },
];
ROWS.forEach((row, i) => {
  const y = ROW0 + i * STEP;
  P(card({ x: RULE_X, y, w: RULE_W, h: RH, text: row.r, color: 'gray', fontSize: 15 }));
  P(card({ x: MIT_X, y, w: COL_W, h: RH, text: row.mit[0], color: row.mit[1], fontSize: 15 }));
  P(card({ x: IU_X, y, w: COL_W, h: RH, text: row.iu[0], color: row.iu[1], fontSize: 15 }));
  P(card({ x: BSL_X, y, w: COL_W, h: RH, text: row.bsl[0], color: row.bsl[1], fontSize: 15 }));
});
const MATRIX_BOTTOM = ROW0 + ROWS.length * STEP;

// ===== SLIDE 3 — two hard truths =====
const H_Y = MATRIX_BOTTOM + 40;
P(sectionTitle({ x: 40, y: H_Y, text: '3 · İki Sert Gerçek', fontSize: 26, color: '#e03131' }));
P(card({ x: 40, y: H_Y + 56, w: 700, h: 150, color: 'red', fontSize: 16,
  text: `GERÇEK 1 — MIT geri alınamaz\n\n0.5.4 zaten npm'de, repo public. Yeni sürümleri\nrelicense edebilirsin ama dağıtılmış MIT haklar KALICI.\nBugün geç — yüzey hâlâ küçükken.` }));
P(card({ x: 780, y: H_Y + 56, w: 700, h: 150, color: 'yellow', fontSize: 16,
  text: `GERÇEK 2 — Mimari/fikir lisansla korunamaz\n\nTelif hakkı KODU korur, fikri değil. Repo public →\ntasarım ifşa. Biri sıfırdan klonlayıp satabilir.\nGerçek koruma = kapalı tut ya da patent.` }));

// ===== SLIDE 4 — recommendation =====
const R_Y = H_Y + 250;
P(sectionTitle({ x: 40, y: R_Y, text: '4 · Öneri', fontSize: 26, color: '#6741d9' }));
P(card({ x: 40, y: R_Y + 56, w: 1440, h: 120, color: 'purple', fontSize: 19,
  text: `PolyForm Internal Use 1.0.0   —   "açık kaynak" değil, "source-available"\nÇekirdek korunur  ·  kişisel & şirket-içi serbest  ·  satış / ürün kapalı  ·  süresiz` }));
const STEPS_Y = R_Y + 196;
P(node({ x: 40, y: STEPS_Y, w: 460, h: 66, color: 'blue', fontSize: 16, text: `1 · LICENSE + package.json değiş` }));
P(node({ x: 520, y: STEPS_Y, w: 460, h: 66, color: 'blue', fontSize: 16, text: `2 · TRADEMARK.md + NOTICE (marka)` }));
P(node({ x: 1000, y: STEPS_Y, w: 480, h: 66, color: 'blue', fontSize: 16, text: `3 · CONTRIBUTING + DCO (relicense hakkı)` }));
P(connector({ from: [500, STEPS_Y + 33], to: [520, STEPS_Y + 33] }));
P(connector({ from: [980, STEPS_Y + 33], to: [1000, STEPS_Y + 33] }));

const out = path.join(__dirname, '..', '..', '_dream_context', 'knowledge', 'diagrams', 'product', 'licensing', 'licensing.excalidraw.md');
buildExcalidraw({ out, elements: els, background: '#fbfbfb' });
console.log('licensing board →', out);
