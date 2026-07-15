// visual_board.js — the visual-first kit demo. Run from anywhere:  node examples/visual_board.js
// Shows the three rules in action: a trapezoid FUNNEL, a browser PROTOTYPE assembled purely with
// stack()/row() flow layout (no hand-computed coordinates → no overlap), and READABLE prose/bullets
// that wrap to a bounded measure instead of stretching across the whole board.
const path = require('path');
const { buildExcalidraw } = require(path.join(__dirname, '..', 'scripts', 'build_excalidraw.js'));
const {
  sectionTitle, prose, bullets, funnel,
  windowFrame, navbar, button, textRows, imagePlaceholder,
  stack, row,
} = require(path.join(__dirname, '..', 'scripts', 'lib', 'style.js'));

const els = [];
const P = (...a) => els.push(...a.flat());

P(sectionTitle({ x: 60, y: 40, text: 'Visual-first kit — funnel · prototype · readable text', fontSize: 32 }));

// ── FUNNEL (left) — filled trapezoid bands, each with a right-margin metric note ──
P(sectionTitle({ x: 60, y: 118, text: 'Conversion funnel', fontSize: 20, color: '#868e96' }));
P(funnel({
  x: 60, y: 168, w: 440, stageH: 80,
  stages: [
    { label: 'Visitors', note: '100% · 48,200 sessions', color: 'blue' },
    { label: 'Signups', note: '32% · quality-gated', color: 'purple' },
    { label: 'Activated', note: '18% · reached first value', color: 'yellow' },
    { label: 'Paying', note: '6% · $29 / mo', color: 'mint' },
  ],
}));

// ── PROTOTYPE (right) — a browser wireframe; every child placed by flow layout ──
const win = windowFrame({ x: 900, y: 118, w: 680, h: 560, kind: 'browser', url: 'https://acme.app/pricing' });
P(win);
const I = win.inner;
P(navbar({ x: I.x, y: I.y, w: I.w, brand: 'Acme', items: ['Product', 'Pricing', 'Docs'], cta: 'Sign up' }));

// hero: copy column + image, flowed side by side (row can't let them overlap)
const hero = row({
  x: I.x, y: I.y + 74, gap: 28, valign: 'top',
  items: [
    (x, y) => stack({
      x, y, gap: 14, items: [
        (hx, hy) => prose({ x: hx, y: hy, text: 'The persistent brain for your agents', fontSize: 24, width: 320 }),
        (hx, hy) => textRows({ x: hx, y: hy, w: 320, rows: 3 }),
        (hx, hy) => button({ x: hx, y: hy, w: 160, h: 42, text: 'Get started', color: 'blue' }),
      ],
    }),
    (x, y) => imagePlaceholder({ x, y, w: 236, h: 158, label: 'product shot' }),
  ],
});
P(hero);

// three feature tiles, flowed left→right
const tiles = row({
  x: I.x, y: hero.nextY + 28, gap: 18,
  items: [['Remember', 'green'], ['Recall', 'purple'], ['Act', 'mint']].map(([t]) => (x, y) => stack({
    x, y, gap: 8, items: [
      (ax, ay) => imagePlaceholder({ x: ax, y: ay, w: 190, h: 72 }),
      (ax, ay) => prose({ x: ax, y: ay, text: t, fontSize: 16, width: 190 }),
      (ax, ay) => textRows({ x: ax, y: ay, w: 190, rows: 2 }),
    ],
  })),
});
P(tiles);

// ── READABLE MEASURE (bottom-left) — text that wraps to a column, not the canvas ──
P(sectionTitle({ x: 60, y: 600, text: 'Readable measure', fontSize: 20, color: '#868e96' }));
P(prose({
  x: 60, y: 646, width: 620, fontSize: 18,
  text: 'Body text wraps to a bounded reading width (~60 characters) instead of stretching across the whole board. Long passages stay in a comfortable column, so the eye never has to travel the full width of a wide canvas to find the start of the next line — that is what keeps a text block legible.',
}));
P(bullets({
  x: 60, y: 792, width: 620, fontSize: 18,
  items: [
    'Prefer pictures — funnels, wireframes, placeholders — over paragraphs.',
    'When you do write, cap the measure with prose() / bullets() so nothing runs edge to edge.',
    'Lay out with stack() / row() so boxes flow and never overlap; the build step also audits and warns.',
  ],
}));

const out = path.join(__dirname, 'Visual Kit.excalidraw.md');
const res = buildExcalidraw({ out, elements: els, background: '#ffffff' });
console.log('visual demo →', out, '| overlaps:', res.overlaps);
