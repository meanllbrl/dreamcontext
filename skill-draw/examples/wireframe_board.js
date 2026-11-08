// wireframe_board.js — the device + product-UI kit, on one board.
// Run:  node examples/wireframe_board.js   → examples/Wireframe Kit.excalidraw.md
//
// Doubles as the kit's smoke test. Note how each screen is composed: device() hands back `.inner`
// (the safe region inside the bezel, below the island, above the home indicator) and everything is
// flowed into it with stack()/row(). No screen coordinates are ever typed by hand.
const path = require('path');
const { buildExcalidraw } = require(path.resolve(__dirname, '../scripts/build_excalidraw.js'));
const { sectionTitle, prose, stack, row, READ_W } = require(path.resolve(__dirname, '../scripts/lib/style.js'));
const {
  device, appBar, tabBar, icon, iconButton, iconNames,
  listRow, toggle, segmented, slider, searchField,
  button, input, textRows, imagePlaceholder, avatar, chip, navbar, windowFrame,
} = require(path.resolve(__dirname, '../scripts/lib/wireframe.js'));

const els = [];
const P = (...a) => els.push(...a.flat());

// flow the header — a hardcoded y let the wrapped title land on the prose (the audit caught it)
P(stack({
  x: 60, y: 40, gap: 12, items: [
    (x, y) => sectionTitle({ x, y, text: 'Wireframe kit — cihaz kalıpları + UI kontrolleri', fontSize: 40, maxWidth: 1400 }),
    (x, y) => prose({
      x, y, width: READ_W, fontSize: 15,
      text: 'Cihazlar gerçek oranlarda (iPhone 393×852, iPad 834×1194, Mac 1440×900). device() güvenli alanı .inner olarak döner — çocuklar oraya akar, chrome’a çarpamaz.',
    }),
  ],
}));

// ── iPhone: a feed screen ─────────────────────────────────────────────────
const ph = device({ kind: 'iphone', x: 60, y: 180, label: 'iPhone — feed' });
P(ph);
P(stack({
  x: ph.inner.x, y: ph.inner.y, gap: 10, items: [
    (x, y) => appBar({ x, y, w: ph.inner.w, title: 'Discover', back: false, actions: ['bell', 'more-v'] }),
    (x, y) => searchField({ x, y, w: ph.inner.w, placeholder: 'Ara…' }),
    (x, y) => segmented({ x, y, w: ph.inner.w, items: ['Hepsi', 'Takip', 'Yeni'], active: 0 }),
    (x, y) => imagePlaceholder({ x, y, w: ph.inner.w, h: 130, label: 'kapak' }),
    (x, y) => textRows({ x, y, w: ph.inner.w, rows: 3 }),
    (x, y) => row({
      x, y, gap: 8, valign: 'middle', items: [
        (x, y) => iconButton({ x, y, size: 32, icon: 'heart', variant: 'ghost', color: 'red' }),
        (x, y) => iconButton({ x, y, size: 32, icon: 'share', variant: 'ghost' }),
        (x, y) => iconButton({ x, y, size: 32, icon: 'bookmark', variant: 'ghost' }),
        (x, y) => button({ x, y, w: 110, h: 32, text: 'Takip et', fontSize: 13 }),
      ],
    }),
  ],
}));
// tab bar pinned to the bottom of the safe area
P(tabBar({
  x: ph.inner.x, y: ph.inner.y + ph.inner.h - 52, w: ph.inner.w, active: 0,
  items: [{ icon: 'home', label: 'Akış' }, { icon: 'search', label: 'Ara' }, { icon: 'heart', label: 'Beğeni' }, { icon: 'user', label: 'Profil' }],
}));

// ── iPhone: a settings screen ─────────────────────────────────────────────
const ph2 = device({ kind: 'iphone', x: 520, y: 180, label: 'iPhone — ayarlar' });
P(ph2);
P(stack({
  x: ph2.inner.x, y: ph2.inner.y, gap: 0, items: [
    (x, y) => appBar({ x, y, w: ph2.inner.w, title: 'Ayarlar', back: true }),
    (x, y) => listRow({ x, y, w: ph2.inner.w, leading: 'avatar', title: 'Alex Doe', subtitle: 'Account, iCloud' }),
    (x, y) => listRow({ x, y, w: ph2.inner.w, leading: 'bell', title: 'Bildirimler', trailing: 'toggle' }),
    (x, y) => listRow({ x, y, w: ph2.inner.w, leading: 'lock', title: 'Gizlilik', trailing: 'chevron-right' }),
    (x, y) => listRow({ x, y, w: ph2.inner.w, leading: 'settings', title: 'Genel', trailing: 'chevron-right' }),
    (x, y) => listRow({ x, y, w: ph2.inner.w, leading: 'mail', title: 'Posta', trailing: '3', divider: false }),
  ],
}));

// ── iPad: a split view ────────────────────────────────────────────────────
const ip = device({ kind: 'ipad', x: 980, y: 180, label: 'iPad — split view' });
P(ip);
const sideW = Math.round(ip.inner.w * 0.34);
P(stack({
  x: ip.inner.x, y: ip.inner.y, gap: 0, items: [
    (x, y) => listRow({ x, y, w: sideW, leading: 'home', title: 'Gelen kutusu', trailing: '12' }),
    (x, y) => listRow({ x, y, w: sideW, leading: 'star', title: 'Yıldızlı' }),
    (x, y) => listRow({ x, y, w: sideW, leading: 'bookmark', title: 'Kaydedilen' }),
    (x, y) => listRow({ x, y, w: sideW, leading: 'trash', title: 'Çöp', divider: false }),
  ],
}));
P(stack({
  x: ip.inner.x + sideW + 16, y: ip.inner.y, gap: 12, items: [
    (x, y) => appBar({ x, y, w: ip.inner.w - sideW - 16, title: 'Mesaj', back: false, actions: ['edit', 'trash'], border: false }),
    (x, y) => imagePlaceholder({ x, y, w: ip.inner.w - sideW - 16, h: 150 }),
    (x, y) => textRows({ x, y, w: ip.inner.w - sideW - 16, rows: 5 }),
  ],
}));

// ── Mac: a desktop app ────────────────────────────────────────────────────
// device({content}) is the safe pattern: widths derive from the `inner` you're handed, and anything
// escaping the glass is reported. Hardcoding these columns overflowed the bezel by 26px.
P(device({
  kind: 'mac', x: 60, y: 1140, label: 'dreamcontext',
  content: (inner) => {
    const SIDE = Math.round(inner.w * 0.27), RIGHT = Math.round(inner.w * 0.25);
    const MID = inner.w - SIDE - RIGHT - 32;
    return stack({
      x: inner.x, y: inner.y, gap: 12, items: [
        (x, y) => navbar({ x, y, w: inner.w, brand: 'dreamcontext', items: ['Tasks', 'Knowledge', 'Roadmap'], cta: 'Sleep' }),
        (x, y) => row({
          x, y, gap: 16, valign: 'top', items: [
            (x, y) => stack({
              x, y, gap: 0, items: [
                (x, y) => listRow({ x, y, w: SIDE, leading: 'home', title: 'Board' }),
                (x, y) => listRow({ x, y, w: SIDE, leading: 'calendar', title: 'Roadmap' }),
                (x, y) => listRow({ x, y, w: SIDE, leading: 'image', title: 'Diagrams', divider: false }),
              ],
            }),
            (x, y) => stack({
              x, y, gap: 12, items: [
                (x, y) => searchField({ x, y, w: MID, placeholder: 'recall…' }),
                (x, y) => textRows({ x, y, w: MID, rows: 4 }),
                (x, y) => row({ x, y, gap: 10, items: [(x, y) => chip({ x, y, text: 'topic:excalidraw', color: 'blue' }), (x, y) => chip({ x, y, text: 'enhancement', color: 'green' })] }),
              ],
            }),
            (x, y) => stack({
              x, y, gap: 14, items: [
                (x, y) => input({ x, y, w: RIGHT, label: 'Slug', placeholder: 'chart-kit' }),
                (x, y) => slider({ x, y, w: RIGHT, value: 0.65 }),
                (x, y) => row({ x, y, gap: 10, valign: 'middle', items: [(x, y) => toggle({ x, y, on: true }), (x, y) => toggle({ x, y, on: false })] }),
                (x, y) => button({ x, y, w: RIGHT, text: 'Kaydet' }),
                (x, y) => button({ x, y, w: RIGHT, text: 'Vazgeç', variant: 'outline', color: 'gray' }),
              ],
            }),
          ],
        }),
      ],
    });
  },
}));

// ── icon set ──────────────────────────────────────────────────────────────
const ICON_Y = 1900;
P(sectionTitle({ x: 60, y: ICON_Y, text: `icon() — ${iconNames().length} glif`, fontSize: 26 }));
const names = iconNames();
const PER = 11, CELL = 92;
names.forEach((n, i) => {
  const cx = 60 + (i % PER) * CELL, cy = ICON_Y + 50 + Math.floor(i / PER) * 76;
  P(icon({ name: n, x: cx + 18, y: cy, size: 26, color: '#1e1e1e' }));
  P({ type: 'text', x: cx - 6, y: cy + 34, text: n, fontSize: 9, color: '#868e96', width: CELL - 6, align: 'center', fontFamily: 5 });
});

// ── iconButton variants ───────────────────────────────────────────────────
const IB_Y = ICON_Y + 50 + Math.ceil(names.length / PER) * 76 + 30;
P(sectionTitle({ x: 60, y: IB_Y, text: 'iconButton() — shape × variant', fontSize: 26 }));
P(row({
  x: 60, y: IB_Y + 46, gap: 18, valign: 'middle', items: [
    (x, y) => iconButton({ x, y, icon: 'plus', shape: 'circle', variant: 'solid', color: 'blue' }),
    (x, y) => iconButton({ x, y, icon: 'heart', shape: 'circle', variant: 'solid', color: 'red' }),
    (x, y) => iconButton({ x, y, icon: 'check', shape: 'circle', variant: 'solid', color: 'green' }),
    (x, y) => iconButton({ x, y, icon: 'search', shape: 'square', variant: 'outline' }),
    (x, y) => iconButton({ x, y, icon: 'settings', shape: 'rounded', variant: 'outline' }),
    (x, y) => iconButton({ x, y, icon: 'more-v', variant: 'ghost' }),
    (x, y) => iconButton({ x, y, icon: 'share', variant: 'ghost' }),
    (x, y) => iconButton({ x, y, icon: 'trash', shape: 'circle', variant: 'outline', color: 'red' }),
  ],
}));

const res = buildExcalidraw({ out: path.resolve(__dirname, 'Wireframe Kit.excalidraw.md'), elements: els });
console.log(`elements=${res.elements} texts=${res.texts} overlaps=${res.overlaps} buriedText=${res.buriedText} longLines=${res.longLines}`);
