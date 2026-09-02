const path = require('path');
const SKILL = path.resolve(__dirname, '../../../.claude/skills/excalidraw/scripts');
const { buildExcalidraw } = require(path.join(SKILL, 'build_excalidraw.js'));
const S = require(path.join(SKILL, 'lib/style.js'));
const C = require(path.join(SKILL, 'lib/charts.js'));
const W = require(path.join(SKILL, 'lib/wireframe.js'));
const { stack, row, sectionTitle, takeaway, bullets, chip, divider, card } = S;
const { callout } = C;
const { windowFrame, textRows, listRow, button } = W;

const MOCK_W = 430;

/** A chat-window mockup. `windowFrame` has no `content` hook (only `device` does), so the
 *  body is drawn into its returned `.inner` and concatenated here. */
const MOCK_H = 300;
function mock({ x, y, title, body }) {
  const frame = windowFrame({ x, y, w: MOCK_W, h: MOCK_H, kind: 'app', title });
  const out = [...frame, ...body(frame.inner)];
  // One group id for the whole mockup: a wireframe nests boxes BY NATURE (a tinted report
  // block inside a window inside a card), and the overlap auditor only skips a pair that
  // shares a group. Overriding the nested per-composite ids is the point — the mockup is one
  // intentional composite, and it also drags as one unit in Excalidraw.
  const gid = `mock-${title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
  for (const e of out) e.group = gid;
  Object.assign(out, { x, y, w: MOCK_W, h: MOCK_H, nextX: x + MOCK_W, nextY: y + MOCK_H });
  return out;
}

// ── mockup bodies ──────────────────────────────────────────────────────────────
const groupRow = (inner) => (x, y) => card({
  x, y, w: inner.w, h: 30, text: '⚡ 1 agent finished · elapsed 4:12', color: 'blue', fontSize: 11,
});

const nowBody = (inner) => stack({
  x: inner.x + 8, y: inner.y + 8, gap: 8, items: [
    groupRow({ w: inner.w - 16 }),
    (x, y) => [
      ...card({ x, y, w: inner.w - 16, h: 196, text: '', color: 'red' }),
      ...textRows({ x: x + 10, y: y + 10, w: inner.w - 36, rows: 7 }),
      ...chip({ x: x + 10, y: y + 162, text: 'raporun TAMAMI, düz metin', color: 'red' }),
    ],
  ],
});

const aBody = (inner) => stack({
  x: inner.x + 8, y: inner.y + 8, gap: 8, items: [
    groupRow({ w: inner.w - 16 }),
    (x, y) => [
      ...card({ x, y, w: inner.w - 16, h: 132, text: '', color: 'green' }),
      ...listRow({ x: x + 6, y: y + 4, w: inner.w - 28, leading: 'avatar', title: 'review-security', subtitle: 'Güvenlik incelemesi · NEEDS_WORK' }),
      ...textRows({ x: x + 12, y: y + 58, w: inner.w - 40, rows: 2 }),
      ...chip({ x: x + 12, y: y + 98, text: 'tam raporu oku ▾', color: 'green' }),
    ],
    (x, y) => textRows({ x: x + 4, y, w: inner.w - 24, rows: 2 }),
  ],
});

const bBody = (inner) => stack({
  x: inner.x + 8, y: inner.y + 8, gap: 8, items: [
    groupRow({ w: inner.w - 16 }),
    (x, y) => listRow({ x, y, w: inner.w - 16, leading: 'avatar', title: 'review-security', subtitle: 'bitti · 4:12', trailing: 'raporu oku →' }),
    (x, y) => textRows({ x: x + 4, y, w: inner.w - 24, rows: 2 }),
  ],
});

const cBody = (inner) => stack({
  x: inner.x + 8, y: inner.y + 8, gap: 8, items: [
    groupRow({ w: inner.w - 16 }),
    (x, y) => textRows({ x: x + 4, y, w: inner.w - 24, rows: 3 }),
    (x, y) => chip({ x, y, text: 'satıra tıkla → drill-in (bugünkü hâli)', color: 'gray' }),
  ],
});

// ── board ──────────────────────────────────────────────────────────────────────
const els = [];
const P = (a) => { els.push(...a); return a; };

const head = P(stack({
  x: 60, y: 60, gap: 26, items: [
    (x, y) => sectionTitle({ x, y, text: 'Sub-agent rapor katmanı — üç seçenek', fontSize: 40 }),
    (x, y) => takeaway({
      x, y, width: 900, label: 'TEŞHİS',
      text: 'UI zaten sub-agent gürültüsünü ==bastırıyor==. Chat’i dolduran duvar, **ana agent’ın kendi mesajı** — Agent tool ona “rapor kullanıcıya gösterilmiyor” dediği için raporu satır satır yeniden yazıyor.',
    }),
  ],
}));

const nowRow = P(row({
  x: 60, y: head.nextY + 30, gap: 40, valign: 'top', items: [
    (x, y) => mock({ x, y, title: 'Chat — ŞU AN', body: nowBody }),
    (x, y) => callout({
      x, y, w: 500, color: 'red', title: 'Kırılan şey',
      lead: 'Rapor **iki yerde** yaşıyor: kartın arkasında ve ana agent’ın mesajında.',
      items: [
        '`ChatPane.tsx:786` sub-agent tool çağrılarını düşürüyor.',
        '`SubAgentCard.tsx:100` iş bitince satırları katlıyor.',
        'Tam rapor drill-in’de var — ama ==ham JSON== olarak.',
      ],
    }),
  ],
}));

const optTitle = P(stack({ x: 60, y: nowRow.nextY + 50, gap: 0, items: [
  (x, y) => sectionTitle({ x, y, text: 'Seçenekler', fontSize: 32 }),
] }));

const opts = P(row({
  x: 60, y: optTitle.nextY + 24, gap: 34, valign: 'top', items: [
    // A
    (x, y) => stack({ x, y, gap: 14, items: [
      (x2, y2) => chip({ x: x2, y: y2, text: 'A · rapor kartı (önerdiğim)', color: 'green' }),
      (x2, y2) => mock({ x: x2, y: y2, title: 'Chat — A', body: aBody }),
      (x2, y2) => bullets({ x: x2, y: y2, width: MOCK_W, items: [
        { text: '**Ad + tip + 2 satır özet** akışta kalır; tıkla, yerinde açılır.', color: '#1e7a34' },
        { text: 'Özet uydurma değil: `run.summary` task-notification’dan geliyor.', color: '#1e7a34' },
        { text: 'Drill-in’deki JSON dökümü markdown’a çevrilir.', color: '#1e7a34' },
        { text: 'Yeni kart + katlama state’i — en büyük iş.', color: '#a33' },
      ] }),
    ] }),
    // B
    (x, y) => stack({ x, y, gap: 14, items: [
      (x2, y2) => chip({ x: x2, y: y2, text: 'B · satır + drill-in', color: 'blue' }),
      (x2, y2) => mock({ x: x2, y: y2, title: 'Chat — B', body: bBody }),
      (x2, y2) => bullets({ x: x2, y: y2, width: MOCK_W, items: [
        { text: 'Satıra `raporu oku →` eklenir, drill-in raporun üstüne açılır.', color: '#1a5fb4' },
        { text: 'Küçük değişiklik, mimariye dokunmaz.', color: '#1a5fb4' },
        { text: 'Rapor akıştan ==tamamen== kaybolur — özet bile yok.', color: '#a33' },
      ] }),
    ] }),
    // C
    (x, y) => stack({ x, y, gap: 14, items: [
      (x2, y2) => chip({ x: x2, y: y2, text: 'C · sadece prompt kuralı', color: 'gray' }),
      (x2, y2) => mock({ x: x2, y: y2, title: 'Chat — C', body: cBody }),
      (x2, y2) => bullets({ x: x2, y: y2, width: MOCK_W, items: [
        { text: 'Hiç UI değişikliği yok; tek dosya: `src/server/chat-surface.ts`.', color: '#555' },
        { text: 'Bugün akşam biter, geri alması bir commit.', color: '#555' },
        { text: 'Duvar gider ama rapor için ==her seferinde tıklamak== gerekir.', color: '#a33' },
      ] }),
    ] }),
  ],
}));

P([divider({ x: 60, y: opts.nextY + 40, w: 1420 })].flat());

P(callout({
  x: 60, y: opts.nextY + 70, w: 900, color: 'yellow', title: 'Her hâlükârda',
  lead: 'Prompt yarısı **şart** — A veya B’yi tek başına yaparsak kullanıcı aynı raporu ==iki kez== görür.',
  items: [
    '`chat-surface.ts`: “dispatch edilmiş bir sub-agent’ın tam raporu chat’te okunabilir — yeniden basma.”',
    'Ana agent’a kalan iş: agent’ın adını söylemek, tek satır sonuç, ne yapacağı.',
  ],
}));

buildExcalidraw({
  out: path.resolve(__dirname, 'subagent-report-layer.excalidraw.md'),
  name: 'Sub-agent rapor katmanı — üç seçenek',
  description: 'Chat view: biten bir sub-agent raporunun nerede yaşayacağına dair karar boardu. Teşhis (duvarı basan UI değil, ana agentın kendi relay mesajı) + üç seçenek: A inline collapsed rapor kartı, B satır + drill-in, C sadece chat-surface prompt kuralı.',
  tags: ['agents', 'chat', 'design', 'excalidraw'],
  elements: els,
});
