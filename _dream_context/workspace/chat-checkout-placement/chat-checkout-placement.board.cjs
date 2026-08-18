/**
 * "Bu bilgi nerede yaşasın?" — the placement options for a chat session's branch/worktree +
 * context reading, drawn as eight mini mockups of the SAME pane so they can be compared at a
 * glance and one (or a combination) picked.
 *
 * Scratch by intent: it lives under `workspace/`, so it is not indexed and will not pollute
 * recall. Promote it only if a decision record is wanted afterwards.
 *
 *   node _dream_context/workspace/chat-checkout-placement/chat-checkout-placement.board.cjs
 */
const path = require('path');
const SKILL = path.resolve(__dirname, '../../../.claude/skills/excalidraw/scripts');
const { buildExcalidraw } = require(path.join(SKILL, 'build_excalidraw.js'));
const {
  PALETTE, INK, card, sectionTitle, prose, stack, row, chip,
} = require(path.join(SKILL, 'lib/style.js'));

const W = 360;          // one mockup's width
const PANE_H = 210;

/** The pane every option is drawn into: tab strip, transcript, composer. Grey, unlabelled —
 *  the only coloured thing in a mockup is the option's own placement, so the eye goes there. */
function pane(x, y, parts = [], { body = 'bars', bodyOffset = 0 } = {}) {
  const els = [
    { type: 'rectangle', x, y, width: W, height: PANE_H, roundness: true, strokeColor: INK, backgroundColor: '#ffffff', fillStyle: 'solid', strokeWidth: 2 },
    // tab strip
    { type: 'rectangle', x: x + 1, y: y + 1, width: W - 2, height: 24, backgroundColor: '#f1f3f5', fillStyle: 'solid', strokeColor: '#e9ecef', strokeWidth: 1 },
    { type: 'rectangle', x: x + 8, y: y + 6, width: 54, height: 13, roundness: true, backgroundColor: '#dee2e6', fillStyle: 'solid', strokeColor: '#dee2e6', strokeWidth: 1 },
    { type: 'rectangle', x: x + 68, y: y + 6, width: 40, height: 13, roundness: true, backgroundColor: '#e9ecef', fillStyle: 'solid', strokeColor: '#e9ecef', strokeWidth: 1 },
    // transcript body — grey bars standing in for messages. `body:'none'` is the EMPTY chat
    // (option E), where drawing messages would contradict the option being shown.
    ...(body === 'none' ? [] : [0, 1, 2].map((i) => ({
      type: 'rectangle', x: x + 14, y: y + 44 + bodyOffset + i * 22, width: i === 1 ? 200 : 160, height: 10,
      roundness: true, backgroundColor: '#f1f3f5', fillStyle: 'solid', strokeColor: '#f1f3f5', strokeWidth: 1,
    }))),
    // composer card + its toolbar row
    { type: 'rectangle', x: x + 10, y: y + 142, width: W - 20, height: 58, roundness: true, backgroundColor: '#ffffff', fillStyle: 'solid', strokeColor: '#ced4da', strokeWidth: 1 },
    { type: 'rectangle', x: x + 10, y: y + 172, width: W - 20, height: 1, backgroundColor: '#e9ecef', fillStyle: 'solid', strokeColor: '#e9ecef', strokeWidth: 1 },
    { type: 'rectangle', x: x + 300, y: y + 178, width: 24, height: 16, roundness: true, backgroundColor: '#dee2e6', fillStyle: 'solid', strokeColor: '#dee2e6', strokeWidth: 1 },
    { type: 'ellipse', x: x + 330, y: y + 177, width: 18, height: 18, backgroundColor: '#343a40', fillStyle: 'solid', strokeColor: '#343a40', strokeWidth: 1 },
  ];
  // `parts` mixes single specs with builder RESULTS (which are arrays) — flatten, or a
  // nested array reaches the builder as an element with no `type`.
  return [...els, ...parts.flat()];
}

/** One option: heading, the mockup with its placement highlighted, one line of consequence. */
function option(x, y, { key, title, note, parts, paneOpts }) {
  return stack({
    x,
    y,
    gap: 10,
    items: [
      (cx, cy) => sectionTitle({ x: cx, y: cy, text: `${key} · ${title}`, fontSize: 21, maxWidth: W }),
      (cx, cy) => pane(cx, cy, parts(cx, cy), paneOpts),
      (cx, cy) => prose({ x: cx, y: cy, text: note, fontSize: 13, width: W }),
    ],
  });
}

/** The placement itself — always a `card()`, so its label is grouped with its box and can
 *  never be read as buried text. Orange = where the information would live. */
/* `card()`'s 8px vertical padding is sized for a real card; these are 20px chips, where it
   would leave 4px for the glyph. Tighter padding, thinner outline. */
const spot = (x, y, w, h, text, color = 'yellow', fontSize = 11) =>
  card({ x, y, w, h, text, color, fontSize, padX: 6, padY: 3, strokeWidth: 1.5 });

const OPTIONS = [
  {
    key: 'A',
    title: 'Composer toolbar — chip',
    note: 'Şu anki hali. Her zaman görünür, ama satırı uzatıyor ve gözü mesajdan çalıyor.',
    parts: (x, y) => [spot(x + 16, y + 175, 120, 22, '⑂ feat/doctor…')],
  },
  {
    key: 'B',
    title: 'Toolbar — sadece ikon',
    note: 'Aynı yer, tek bir 12px ikon. Ad yok; worktree ise turuncu yanar, detay hover’da.',
    parts: (x, y) => [spot(x + 16, y + 175, 30, 22, '⑂')],
  },
  {
    key: 'C',
    title: 'Sekme satırının sağında',
    note: 'Composer’a hiç dokunmaz. Branch “bu sekme nerede” bilgisidir — sekmenin yanı doğal yeri.',
    parts: (x, y) => [spot(x + 232, y + 3, 120, 20, '⑂ feat/doctor…')],
  },
  {
    key: 'D',
    title: 'Transkript üstünde şerit',
    note: 'Her zaman görünür, tek satır, tam genişlik. Konuşmadan ~22px yükseklik çalar.',
    paneOpts: { bodyOffset: 26 },
    parts: (x, y) => [spot(x + 12, y + 30, W - 24, 22, '⑂ feat/doctor… · 21% · 212k/1.0M · $14.22', 'yellow', 10)],
  },
  {
    key: 'E',
    title: 'Boş ekranda kart',
    note: 'Şimdi yaptığım. Hiç yer çalmaz ama ilk mesajdan sonra kaybolur — canlı oturumda görünmez.',
    paneOpts: { body: 'none' },
    parts: (x, y) => [spot(x + 60, y + 58, 240, 52, '⑂ feat/doctor…\n21% · 212k/1.0M · $14.22', 'mint', 11)],
  },
  {
    key: 'F',
    title: 'Composer’da açılır satır',
    note: 'Çubuğa tıkla → composer’ın içinde kalıcı bir satır açılır, tekrar tıkla kapanır. Sen karar verirsin.',
    parts: (x, y) => [spot(x + 16, y + 146, W - 32, 22, '⑂ feat/doctor… · 21% · $14.22 · ✕', 'blue', 10)],
  },
  {
    key: 'G',
    title: 'Sağ üstte durum noktası',
    note: 'Normalde tek bir nokta; worktree ise turuncu. Tıklayınca yandan bir bilgi paneli açılır.',
    parts: (x, y) => [
      spot(x + 326, y + 3, 24, 20, '●', 'red', 11),
      spot(x + 240, y + 34, 112, 62, 'Session\n⑂ feat/doctor…\n21% · $14.22', 'gray', 10),
    ],
  },
  {
    key: 'H',
    title: 'Sadece hover kartı',
    note: 'Toolbar tertemiz kalır. Bilgi yalnızca çubuğun üstüne gelince açılan kartta yaşar.',
    parts: (x, y) => [
      spot(x + 186, y + 104, 160, 36, '⑂ feat/doctor…\n21% · $14.22', 'gray', 10),
      { type: 'rectangle', x: x + 214, y: y + 182, width: 40, height: 4, roundness: true, backgroundColor: '#adb5bd', fillStyle: 'solid', strokeColor: '#adb5bd', strokeWidth: 1 },
    ],
  },
];

const COLS = 3;
const GAP_X = 56;
const GAP_Y = 54;

const rows = [];
for (let i = 0; i < OPTIONS.length; i += COLS) {
  rows.push(OPTIONS.slice(i, i + COLS));
}

const board = stack({
  x: 60,
  y: 60,
  gap: 34,
  items: [
    (x, y) => sectionTitle({ x, y, text: 'Branch / worktree + context: bu bilgi nerede yaşasın?', fontSize: 38, maxWidth: 1200 }),
    (x, y) => prose({
      x,
      y,
      fontSize: 15,
      text: 'Sekiz yer. Her mockup aynı sohbet panelidir; renkli olan tek şey o seçeneğin bilgiyi koyduğu yerdir. '
        + 'Birini seç, ya da birleştir (ör. C + H: sekmede ad, detay hover’da). Seçtiğinde diğerlerini geri alırım.',
    }),
    ...rows.map((r) => (x, y) => row({
      x,
      y,
      gap: GAP_X,
      valign: 'top',
      items: r.map((o) => (cx, cy) => option(cx, cy, o)),
    })),
  ],
});

// `stack`'s gap is uniform; the grid rows want a bigger one than the header does.
buildExcalidraw({
  out: path.resolve(__dirname, 'chat-checkout-placement.excalidraw.md'),
  name: 'chat-checkout-placement',
  description: 'Eight placement options for a chat session\'s branch/worktree + context reading — the same pane drawn eight times with only the placement coloured, as a pick-one board.',
  tags: ['topic:desktop', 'topic:agents', 'excalidraw'],
  elements: [...board],
});
console.log('wrote board · GAP_Y unused =', GAP_Y, '· chip helper available =', typeof chip === 'function', '· palette keys =', Object.keys(PALETTE).length);
