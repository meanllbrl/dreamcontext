// dreamcontext "architecture" board — capture → store → inject, the full system map.
const path = require('node:path');
const { buildExcalidraw } = require('../../../../../scripts/diagrams/excalidraw/build_excalidraw.js');
const {
  card, node, sectionTitle, connector,
  rightOf, leftOf, bottomOf, topOf,
} = require('../../../../../scripts/diagrams/excalidraw/lib/style.js');

const OUT = path.resolve(__dirname, 'architecture.excalidraw.md');
const els = [];
els.push(...sectionTitle({ x: 60, y: 8, text: 'dreamcontext — architecture', fontSize: 38 }));

// Three lanes: Capture (left) → Store (middle) → Inject (right).
const COLW = 300, NH = 56, NGAP = 22;
const CAP_X = 60, STORE_X = 470, INJ_X = 900;
const TITLE_Y = 90, FIRST_Y = 150;

function lane(x, title, items, color) {
  els.push(...sectionTitle({ x, y: TITLE_Y, text: title, fontSize: 22 }));
  let y = FIRST_Y;
  const cards = items.map((t) => {
    const c = { x, y, w: COLW, h: NH };
    els.push(...node({ ...c, color, fontSize: 15, text: t }));
    y += NH + NGAP;
    return c;
  });
  return cards;
}

const capture = lane(CAP_X, 'Capture', [
  'Stop hook — session ends',
  'PostToolUse — format + typecheck',
  'Bookmarks — awake ripples',
  'RemSleep agent — consolidates',
  'You — edit files or dashboard',
], 'blue');

const store = lane(STORE_X, '_dream_context/  (store)', [
  'core/ — soul · user · memory\nstyle · tech · features · changelog',
  'knowledge/ — tagged deep docs',
  'state/ — tasks · sleep debt\nbookmarks · triggers',
], 'purple');

const inject = lane(INJ_X, 'Inject', [
  'SessionStart hook',
  'UserPromptSubmit — reminders',
  'PreToolUse — context-first',
  'Compiled snapshot\n+ warm knowledge',
  'Agent starts with full context',
], 'green');

// capture → store (writers feed the store)
[capture[0], capture[2], capture[3], capture[4]].forEach((c) => {
  els.push(...connector({ from: rightOf(c.x, c.y, c.w, c.h), to: leftOf(store[0].x, store[1].y, store[0].w, store[0].h) }));
});
// store → inject (snapshot reads the store)
store.forEach((c) => {
  els.push(...connector({ from: rightOf(c.x, c.y, c.w, c.h), to: leftOf(inject[0].x, inject[3].y, inject[0].w, inject[0].h) }));
});
// inject chain → agent
els.push(...connector({ from: bottomOf(inject[3].x, inject[3].y, inject[3].w, inject[3].h), to: topOf(inject[4].x, inject[4].y, inject[4].w, inject[4].h) }));

buildExcalidraw({ out: OUT, background: '#ffffff', elements: els });
