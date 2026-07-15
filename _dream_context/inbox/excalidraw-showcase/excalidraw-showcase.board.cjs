// excalidraw-showcase.board.cjs — scratch/showcase board (lives in inbox/ ⇒ dark by location: not
// indexed, not recalled). Regenerate with:  node excalidraw-showcase.board.cjs
//
// One board, three visual registers, one real topic — a showcase of the excalidraw skill's v2 kit:
//   left   = funnel()      → the token-burning spiral of a cold session
//   middle = card/connector→ the fix, with the feedback loop routed through a MARGIN BUS
//   right  = windowFrame() → the product, as a browser prototype (kanban tickets composed from the kit)
//   bottom = prose/bullets → readable measure, bounded to a column
const path = require('path');
// inbox/<title>/ → project root is ../../../ ; never hardcode an absolute path (skill portability rule)
const SKILL = path.resolve(__dirname, '../../../.claude/skills/excalidraw');
const { buildExcalidraw } = require(path.join(SKILL, 'scripts', 'build_excalidraw.js'));
const {
  sectionTitle, prose, bullets, funnel, card, connector,
  windowFrame, navbar, chip, textRows, stack, row,
  leftOf, bottomOf, topOf, WIRE,
} = require(path.join(SKILL, 'scripts', 'lib', 'style.js'));

const els = [];
const P = (...a) => els.push(...a.flat());

// ── Header ────────────────────────────────────────────────────────────────
P(sectionTitle({ x: 60, y: 40, text: 'dreamcontext — the persistent brain for your AI agents', fontSize: 38, maxWidth: 1200 }));
P(prose({
  x: 60, y: 108, width: 700, fontSize: 17, color: WIRE.strong,
  text: 'Agents don\'t just "forget" — every session opens with a token-burning search spiral. This board tells the whole story in one screen: the waste, the fix, and the product.',
}));

// ── ZONE A — the problem, as a funnel of wasted tokens ────────────────────
P(sectionTitle({ x: 60, y: 210, text: 'The spiral — every cold session', fontSize: 20, color: '#868e96' }));
P(funnel({
  x: 60, y: 258, w: 440, stageH: 74, gap: 8,
  stages: [
    { label: 'Agent starts cold', note: 'no memory of last session', color: 'red' },
    { label: 'Reads a flat memory file', note: 'too thin for a real codebase', color: 'red' },
    { label: 'Re-explores the repo', note: 'grep · ls · read · repeat', color: 'yellow' },
    { label: '20K+ tokens burned', note: 'before one line of work', color: 'yellow' },
    { label: 'Work finally starts', note: 'context window already half gone', color: 'gray' },
  ],
}));

// ── ZONE B — the fix, as a flow with a margin-bus feedback loop ───────────
const BX = 1000, BW = 380;
P(sectionTitle({ x: BX, y: 210, text: 'The fix', fontSize: 20, color: '#868e96' }));
const steps = [
  { y: 258, h: 64, t: 'SessionStart hook fires', c: 'blue' },
  { y: 382, h: 96, t: '_dream_context/\nsoul · user · memory · knowledge · state', c: 'purple' },
  { y: 538, h: 76, t: 'Agent starts with full context\n0 tool calls', c: 'mint' },
  { y: 674, h: 64, t: 'RemSleep consolidates the session', c: 'yellow' },
];
steps.forEach((s) => P(card({ x: BX, y: s.y, w: BW, h: s.h, text: s.t, color: s.c, fontSize: 17 })));
const edge = (i) => ({ x: BX, y: steps[i].y, w: BW, h: steps[i].h });
P(connector({ from: bottomOf(...Object.values(edge(0))), to: topOf(...Object.values(edge(1))), label: 'reads' }));
P(connector({ from: bottomOf(...Object.values(edge(1))), to: topOf(...Object.values(edge(2))), label: 'pre-loads' }));
P(connector({ from: bottomOf(...Object.values(edge(2))), to: topOf(...Object.values(edge(3))), label: 'on stop' }));
// feedback loop routed through the LEFT MARGIN (never a diagonal across the boxes)
P(connector({
  from: leftOf(...Object.values(edge(3))),
  to: leftOf(...Object.values(edge(1))),
  via: [[BX - 44, steps[3].y + steps[3].h / 2], [BX - 44, steps[1].y + steps[1].h / 2]],
  label: 'writes back', dashed: true,
}));

// ── ZONE C — the product, as a real browser prototype ─────────────────────
P(sectionTitle({ x: 1480, y: 210, text: 'The product', fontSize: 20, color: '#868e96' }));
const win = windowFrame({ x: 1480, y: 258, w: 700, h: 480, kind: 'browser', url: 'dreamcontext.dev/dashboard' });
P(win);
const I = win.inner;
P(navbar({ x: I.x, y: I.y, w: I.w, brand: 'dreamcontext', items: ['Knowledge', 'Tasks', 'Lab'], cta: 'Sleep' }));

// a custom widget composed from the kit — proves the kit is extensible
const ticket = (x, y, w = 196) => {
  const h = 54;
  const out = [
    { type: 'rectangle', x, y, width: w, height: h, strokeColor: WIRE.edge, backgroundColor: WIRE.paper, fillStyle: 'solid', strokeWidth: 1.5, roundness: true },
    ...textRows({ x: x + 12, y: y + 15, w: w - 24, rows: 2, lineH: 8, gap: 9 }),
  ];
  out.w = w; out.h = h; out.nextY = y + h;
  return out;
};
const cols = [['Todo', 'gray'], ['In progress', 'yellow'], ['Done', 'green']];
P(row({
  x: I.x, y: I.y + 74, gap: 18,
  items: cols.map(([t, c]) => (x, y) => stack({
    x, y, gap: 10, items: [
      (a, b) => chip({ x: a, y: b, text: t, color: c }),
      (a, b) => ticket(a, b),
      (a, b) => ticket(a, b),
      (a, b) => ticket(a, b),
    ],
  })),
}));

// ── Footer — readable measure, bounded ────────────────────────────────────
P(sectionTitle({ x: 60, y: 800, text: 'Why it works', fontSize: 20, color: '#868e96' }));
P(bullets({
  x: 60, y: 846, width: 700, fontSize: 17,
  items: [
    'Context is pre-loaded by a hook, so the agent spends zero tool calls rediscovering the project.',
    'Knowledge is organised the way memory is — identity, episodic, semantic, procedural, working.',
    'A RemSleep cycle consolidates each session, so the brain gets sharper instead of longer.',
  ],
}));

const out = path.join(__dirname, 'excalidraw-showcase.excalidraw.md');
const res = buildExcalidraw({ out, elements: els, background: '#ffffff' });
console.log('showcase →', out, '| elements:', res.elements, '| overlaps:', res.overlaps);
