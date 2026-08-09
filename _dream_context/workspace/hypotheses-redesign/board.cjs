// Hypotheses board redesign — 3 seçeneğin wireframe karşılaştırması (scratch board).
// Regen: node _dream_context/workspace/hypotheses-redesign/board.cjs
const path = require('path');
const LIB = path.resolve(__dirname, '../../../.claude/skills/excalidraw/scripts/lib');
const {
  buildExcalidraw,
} = require(path.resolve(LIB, '../build_excalidraw.js'));
const {
  sectionTitle, prose, bullets, annotate, stack, box, bbox,
  windowFrame, chip, divider, measureText, wrapToWidth,
} = require(path.resolve(LIB, 'style.js'));
const { segmented } = require(path.resolve(LIB, 'wireframe.js'));
const { callout } = require(path.resolve(LIB, 'charts.js'));

const INKS = { blue: '#1971c2', green: '#2f9e44', red: '#e03131', gray: '#868e96', yellow: '#f08c00' };
const MUTED = '#8a919c';
const TRACK = '#e3e6ea';
const UNREAD = '#3b82d9';

const T = [
  { status: 'OPEN', color: 'blue', pct: 72, claim: 'Hybrid recall (BM25F + local embeddings, RRF fusion) beats BM25F-only on the 60-query gold set', unread: true, change: '↑ confidence 61→72 · +2 evidence son bakışından beri', when: '2g önce' },
  { status: 'VALIDATED', color: 'green', pct: 88, claim: 'Snapshot pre-load, token yakan arama spiralini öldürüyor', unread: true, change: '⟳ FLIPPED validated · promote bekliyor', when: 'dün' },
  { status: 'OPEN', color: 'blue', pct: 55, claim: 'Türkçe sorgular recall@5 metriğinde İngilizce sorguların gerisinde', unread: false, change: '3 cycle · en son 2 gün önce kontrol edildi', when: '2g önce' },
  { status: 'DRAFT', color: 'gray', pct: null, claim: 'Sleep debt skoru hangi oturumun konsolidasyon gerektirdiğini öngörüyor', unread: false, change: 'prediction bekliyor — open olması için en az 1 tahmin gerek', when: '—' },
  { status: 'INVALIDATED', color: 'red', pct: 12, claim: 'Kartlarda glif kullanmak taranabilirliği artırıyor', unread: false, change: '2 contradicting · knowledge’a promote edildi', when: '5g önce' },
];

function truncate(text, fontSize, maxW) {
  let t = String(text);
  if (measureText(t, fontSize) <= maxW) return t;
  while (t.length > 4 && measureText(t + '…', fontSize) > maxW) t = t.slice(0, -1);
  return t + '…';
}

function clampLines(text, fontSize, w, maxLines) {
  const lines = wrapToWidth(String(text), fontSize, w).split('\n');
  if (lines.length <= maxLines) return lines.join('\n');
  const out = lines.slice(0, maxLines);
  out[maxLines - 1] = out[maxLines - 1].replace(/\s*\S{0,3}$/, '') + '…';
  return out.join('\n');
}

function pctText(x, y, d, fontSize, w) {
  return {
    type: 'text', x, y, width: w, align: 'right', fontFamily: 5, fontSize,
    text: d.pct === null ? '—' : `${d.pct}%`, color: d.pct === null ? MUTED : INKS[d.color],
  };
}

let barSeq = 0;
function miniBar(x, y, w, h, d) {
  const group = `minibar-${barSeq++}`;
  const els = [
    { type: 'rectangle', x, y, width: w, height: h, strokeColor: 'transparent', backgroundColor: TRACK, fillStyle: 'solid', strokeWidth: 0, roundness: true, group },
  ];
  if (d.pct !== null) {
    els.push({ type: 'rectangle', x, y, width: Math.max(4, w * d.pct / 100), height: h, strokeColor: 'transparent', backgroundColor: INKS[d.color], fillStyle: 'solid', strokeWidth: 0, roundness: true, group });
  }
  return els;
}

// ── Option A: activity list rows ─────────────────────────────────────────
const ROW_H = 56;
function listRowEls(x, y, w, d) {
  const els = [];
  if (d.unread) els.push({ type: 'ellipse', x: x + 2, y: y + 18, width: 9, height: 9, strokeColor: UNREAD, backgroundColor: UNREAD, fillStyle: 'solid', strokeWidth: 1 });
  els.push(...chip({ x: x + 22, y: y + 9, text: d.status, color: d.color, fontSize: 10 }));
  els.push(pctText(x + 122, y + 10, d, 16, 46));
  els.push(...miniBar(x + 180, y + 19, 60, 6, d));
  els.push({ type: 'text', x: x + 262, y: y + 8, width: 470, fontFamily: 5, fontSize: 13, color: '#2b2f36', text: truncate(d.claim, 13, 466) });
  els.push({ type: 'text', x: x + 262, y: y + 30, width: 470, fontFamily: 5, fontSize: 10.5, color: d.unread ? '#9a6700' : MUTED, text: truncate(d.change, 10.5, 466) });
  els.push({ type: 'text', x: x + w - 72, y: y + 10, width: 70, align: 'right', fontFamily: 5, fontSize: 10.5, color: MUTED, text: d.when });
  els.push(...divider({ x, y: y + ROW_H - 4, w }));
  return els;
}

function mockA(x, y) {
  const w = 960, contentH = 34 + 16 + T.length * ROW_H;
  const h = 38 + 16 * 2 + contentH;
  const win = windowFrame({ x, y, w, h, kind: 'app', title: 'Hypotheses' });
  const els = [...win];
  const ix = win.inner.x, iy = win.inner.y, iw = win.inner.w;
  els.push(...segmented({ x: ix, y: iy, w: 400, items: ['Aktivite', 'Needs attention', 'Unread', 'All'], active: 0 }));
  els.push({ type: 'text', x: ix + iw - 220, y: iy + 9, width: 220, align: 'right', fontFamily: 5, fontSize: 11, color: MUTED, text: '2 unread · 12 hypotheses · cycle 41' });
  T.forEach((d, i) => els.push(...listRowEls(ix, iy + 34 + 16 + i * ROW_H, iw, d)));
  return box(els, x, y, w, h);
}

// ── Option B/C: kanban-style mini card ───────────────────────────────────
function miniCard(x, y, w, d, opts = {}) {
  const { h = 104, claimSize = 11.5, claimLines = 2 } = opts;
  const pad = 10;
  const els = [
    { type: 'rectangle', x, y, width: w, height: h, strokeColor: '#c9ced6', backgroundColor: '#ffffff', fillStyle: 'solid', strokeWidth: 1.5, roundness: true },
  ];
  let cx = x + pad;
  if (d.unread) {
    els.push({ type: 'ellipse', x: cx, y: y + pad + 7, width: 8, height: 8, strokeColor: UNREAD, backgroundColor: UNREAD, fillStyle: 'solid', strokeWidth: 1 });
    cx += 14;
  }
  els.push(...chip({ x: cx, y: y + pad - 2, text: d.status, color: d.color, fontSize: 9 }));
  els.push(pctText(x + w - pad - 44, y + pad - 2, d, 15, 44));
  els.push({ type: 'text', x: x + pad, y: y + pad + 26, width: w - 2 * pad, fontFamily: 5, fontSize: claimSize, color: '#2b2f36', text: clampLines(d.claim, claimSize, w - 2 * pad, claimLines) });
  els.push({ type: 'text', x: x + pad, y: y + h - 20, width: w - 2 * pad, fontFamily: 5, fontSize: 9, color: d.unread ? '#9a6700' : MUTED, text: truncate(d.change, 9, w - 2 * pad) });
  return box(els, x, y, w, h);
}

function colHead(x, y, w, label, ink, count) {
  return box([
    { type: 'text', x, y, width: w - 30, fontFamily: 5, fontSize: 12, color: ink, text: label },
    { type: 'text', x: x + w - 28, y, width: 28, align: 'right', fontFamily: 5, fontSize: 12, color: MUTED, text: String(count) },
  ], x, y, w, 20);
}

function emptyCol(x, y, w) {
  return box([
    { type: 'rectangle', x, y, width: w, height: 48, strokeColor: '#c9ced6', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 1, roundness: true, strokeStyle: 'dashed' },
    { type: 'text', x, y: y + 16, width: w, align: 'center', fontFamily: 5, fontSize: 10, color: MUTED, text: 'boş' },
  ], x, y, w, 48);
}

function kanban(x, y, w, cols, cardOpts) {
  const n = cols.length, gap = 12;
  const cw = Math.floor((w - (n - 1) * gap) / n);
  const els = []; let maxH = 0;
  cols.forEach((c, i) => {
    const colX = x + i * (cw + gap);
    let cy = y;
    els.push(...colHead(colX, cy, cw, c.label, c.ink, c.items.length));
    cy += 30;
    if (c.items.length === 0) { els.push(...emptyCol(colX, cy, cw)); cy += 58; }
    for (const d of c.items) { const card = miniCard(colX, cy, cw, d, cardOpts); els.push(...card); cy += card.h + 10; }
    maxH = Math.max(maxH, cy - y);
  });
  return box(els, x, y, w, maxH);
}

function mockB(x, y) {
  const w = 960;
  const content = kanban(0, 0, w - 32, [
    { label: 'NEEDS ATTENTION', ink: INKS.yellow, items: [T[1]] },
    { label: 'ACTIVE', ink: INKS.blue, items: [T[0], T[2], T[3]] },
    { label: 'SETTLED', ink: INKS.gray, items: [T[4]] },
  ], { h: 104, claimSize: 11.5, claimLines: 2 });
  const h = 38 + 16 * 2 + content.h;
  const win = windowFrame({ x, y, w, h, kind: 'app', title: 'Hypotheses' });
  const placed = kanban(win.inner.x, win.inner.y, win.inner.w, [
    { label: 'NEEDS ATTENTION', ink: INKS.yellow, items: [T[1]] },
    { label: 'ACTIVE', ink: INKS.blue, items: [T[0], T[2], T[3]] },
    { label: 'SETTLED', ink: INKS.gray, items: [T[4]] },
  ], { h: 104, claimSize: 11.5, claimLines: 2 });
  return box([...win, ...placed], x, y, w, h);
}

function mockC(x, y) {
  const w = 960;
  const cols = [
    { label: 'DRAFT', ink: INKS.gray, items: [T[3]] },
    { label: 'OPEN', ink: INKS.blue, items: [T[0], T[2]] },
    { label: 'VALIDATED', ink: INKS.green, items: [T[1]] },
    { label: 'INVALIDATED', ink: INKS.red, items: [T[4]] },
    { label: 'RETIRED', ink: INKS.gray, items: [] },
  ];
  const opts = { h: 122, claimSize: 10, claimLines: 3 };
  const content = kanban(0, 0, w - 32, cols, opts);
  const h = 38 + 16 * 2 + content.h;
  const win = windowFrame({ x, y, w, h, kind: 'app', title: 'Hypotheses' });
  const placed = kanban(win.inner.x, win.inner.y, win.inner.w, cols, opts);
  return box([...win, ...placed], x, y, w, h);
}

// ── Card anatomy blow-up ─────────────────────────────────────────────────
function anatomy(x, y) {
  const w = 520, h = 176;
  const d = T[0];
  const els = [
    { type: 'rectangle', x, y: y + 40, width: w, height: h, strokeColor: '#c9ced6', backgroundColor: '#ffffff', fillStyle: 'solid', strokeWidth: 2, roundness: true },
  ];
  const pad = 18, top = y + 40;
  els.push({ type: 'ellipse', x: x + pad, y: top + pad + 8, width: 10, height: 10, strokeColor: UNREAD, backgroundColor: UNREAD, fillStyle: 'solid', strokeWidth: 1 });
  els.push(...chip({ x: x + pad + 18, y: top + pad, text: 'OPEN', color: 'blue', fontSize: 12 }));
  els.push({ type: 'text', x: x + w - pad - 80, y: top + pad - 4, width: 80, align: 'right', fontFamily: 5, fontSize: 28, color: INKS.blue, text: '72%' });
  els.push(...miniBar(x + pad, top + pad + 34, 220, 8, d));
  els.push({ type: 'text', x: x + pad, y: top + pad + 52, width: w - 2 * pad, fontFamily: 5, fontSize: 15, color: '#2b2f36', text: clampLines(d.claim, 15, w - 2 * pad, 2) });
  els.push({ type: 'text', x: x + pad, y: top + h - 30, width: w - 2 * pad, fontFamily: 5, fontSize: 12, color: '#9a6700', text: d.change });

  const nx = x + w + 70;
  const notes = [
    { from: [x + pad + 5, top + pad + 8], to: [nx, y + 4], text: 'Unread dot — son bakışından beri değişen tez. Detayı açınca söner.' },
    { from: [x + pad + 80, top + pad + 12], to: [nx, y + 58], text: 'Status kelimeyle yazılı, renk sadece destek — ezber gerekmez.' },
    { from: [x + w - 30, top + pad + 10], to: [nx, y + 112], text: 'Verdict önde: göz önce büyük yüzdeye düşer, iddia sonra gelir.' },
    { from: [x + w - 60, top + pad + 70], to: [nx, y + 166], text: 'İddia 2 satıra clamp — kart cümle okutmaz, detay modala kalır.' },
    { from: [x + 260, top + h - 22], to: [nx, y + 220], text: '“Ne değişti” satırı: confidence hareketi, yeni evidence, flip.' },
  ];
  for (const n of notes) els.push(...annotate({ ...n, fontSize: 14 }));
  return box(els, x, y, w + 70 + 300, Math.max(40 + h, 240));
}

// ── Assemble ─────────────────────────────────────────────────────────────
const elements = stack({
  x: 60, y: 40, gap: 64, items: [
    (x, y) => sectionTitle({ x, y, text: 'Hypotheses board — 3 seçenek, aynı 5 tez', fontSize: 38 }),
    (x, y) => prose({ x, y, fontSize: 16, width: 620, text: 'Karşılaştırma için beş örnek tez üç yerleşimde aynı. Kart anatomisi (en altta) üç seçenekte de ortak — asıl karar: tezler nasıl gruplansın?' }),

    (x, y) => stack({ x, y, gap: 16, items: [
      (x, y) => sectionTitle({ x, y, text: 'A · Aktivite akışlı liste (inbox)', fontSize: 28 }),
      (x, y) => mockA(x, y),
      (x, y) => bullets({ x, y, fontSize: 14, width: 620, items: [
        'Üç şikayeti tek yapıda çözer: status kelimesi okunur, geniş satır iddiaya alan açar, değişen en üste çıkar.',
        'Sütun kırılması (wrap) problemi kökten gider; sekmeler filtre görevi görür.',
        'Eksi: status dağılımı bir bakışta görünmez — üst şeritte küçük sayaçlar ister.',
      ] }),
    ] }),

    (x, y) => stack({ x, y, gap: 16, items: [
      (x, y) => sectionTitle({ x, y, text: 'B · 3 grup: Needs attention / Active / Settled', fontSize: 28 }),
      (x, y) => mockB(x, y),
      (x, y) => bullets({ x, y, fontSize: 14, width: 620, items: [
        'Kanban hissi korunur ama gruplar iş anlamı taşır: “neye bakmalıyım” sorusuna sütunun kendisi cevap verir.',
        'Geniş kartlar 2 satır iddiaya izin verir; 3 sütun geniş ekranda rahat nefes alır.',
        'Eksi: “ne değişti” yine kart içi sinyale muhtaç; sıralama sütun içinde belirsiz kalır.',
      ] }),
    ] }),

    (x, y) => stack({ x, y, gap: 16, items: [
      (x, y) => sectionTitle({ x, y, text: 'C · Kanban kalır (5 status sütunu), kart yenilenir', fontSize: 28 }),
      (x, y) => mockC(x, y),
      (x, y) => bullets({ x, y, fontSize: 14, width: 620, items: [
        'En az yapısal risk — mevcut koda en yakın seçenek.',
        'Eksi: 5 sütun ~170px’e sıkışır, iddia 3 satır kırpılır; dar ekranda sütunlar alt satıra kırılınca status bağlamı yine kaybolur.',
      ] }),
    ] }),

    (x, y) => stack({ x, y, gap: 16, items: [
      (x, y) => sectionTitle({ x, y, text: 'Yeni kart anatomisi (hangi seçenek seçilirse seçilsin)', fontSize: 28 }),
      (x, y) => anatomy(x, y),
    ] }),

    (x, y) => callout({ x, y, w: 900, title: 'Önerim: A', color: 'green', text: 'Aktivite akışlı liste + üst şeritte status sayaçları; B’nin “Needs attention” fikri A’ya hazır filtre sekmesi olarak taşınır. Detay modalı ve unread/seen mantığı zaten karara bağlandı — board şekli senin seçimin.' }),
  ],
});

buildExcalidraw({
  out: path.resolve(__dirname, 'hypotheses-board-options.excalidraw.md'),
  name: 'hypotheses-board-options',
  description: 'Hypotheses board redesign — aktivite akışlı liste, 3 grup kanban ve 5 sütun kanban seçeneklerinin aynı 5 örnek tezle wireframe karşılaştırması + ortak kart anatomisi.',
  tags: ['design', 'excalidraw'],
  elements,
});
console.log('done');
