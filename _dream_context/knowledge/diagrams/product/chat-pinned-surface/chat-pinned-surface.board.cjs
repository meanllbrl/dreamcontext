/* Regenerate: node _dream_context/knowledge/diagrams/product/chat-pinned-surface/chat-pinned-surface.board.cjs
 *
 * CANONICAL: the decided placement for the pinned surface in the native Chat view.
 * Owner picked option A on 2026-08-22 and specified its resting state. The four-option
 * exploration board this supersedes lived at workspace/chat-pinned-surface/ and is folded
 * into the "not chosen" strip below.
 */
const path = require('path');
const SKILL = path.resolve(__dirname, '../../../../../.claude/skills/excalidraw/scripts');
const { buildExcalidraw } = require(path.join(SKILL, 'build_excalidraw.js'));
const S = require(path.join(SKILL, 'lib/style.js'));
const C = require(path.join(SKILL, 'lib/charts.js'));
const { sectionTitle, prose, card, chip, textRows, windowFrame, connector } = S;
const { table, callout } = C;

const FW = 560, FH = 420, CH = 56;

/** Composer + the shelf docked to its top edge. */
function pane(inner, { tags = [], row = null, rowH = 34, rowColor = 'purple' }) {
  const cy = inner.y + inner.h - CH;
  const out = [];

  // transcript filler — shortened when a tall row is open, since the shelf
  // grows UPWARD into the transcript and nothing below it moves.
  const fill = rowH > 60 ? 3 : 5;
  out.push(...textRows({ x: inner.x, y: inner.y, w: inner.w, rows: fill }));
  if (rowH <= 60) out.push(...textRows({ x: inner.x, y: inner.y + 130, w: inner.w * 0.72, rows: 4 }));

  // TAG LINE — sits directly on the composer and never moves.
  const tagY = cy - 8 - 25;
  let tx = inner.x;
  for (const t of tags) {
    const el = chip({ x: tx, y: tagY, text: t.text, color: t.color, fontSize: 11 });
    out.push(...el);
    tx += el.w + 6;
  }

  // ROW — transient, opens ABOVE the tag line so the tags never jump.
  if (row) {
    out.push(...card({ x: inner.x, y: tagY - 6 - rowH, w: inner.w, h: rowH, text: row, color: rowColor, fontSize: 12 }));
  }

  // composer
  out.push(...card({ x: inner.x, y: cy, w: inner.w, h: CH, text: '', color: 'gray' }));
  out.push(...chip({ x: inner.x + 14, y: cy + 8, text: 'Message Claude…', color: 'gray', fontSize: 11 }));
  out.push(...chip({ x: inner.x + inner.w - 88, y: cy + CH - 30, text: 'Opus  ↑', color: 'purple', fontSize: 11 }));
  return Object.assign(out, { tagY });
}

function panel(x, y, title, note, opts) {
  const els = [];
  els.push(...sectionTitle({ x, y, text: title, fontSize: 21, maxWidth: FW }));
  const fy = y + 38;
  const f = windowFrame({ x, y: fy, w: FW, h: FH, kind: 'app', title: 'dreamcontext — Chat' });
  els.push(...f);
  els.push(...pane(f.inner, opts));
  els.push(...prose({ x, y: fy + FH + 16, text: note, fontSize: 14, width: FW }));
  return els;
}

const TAGS = [
  { text: '⎇ feat/pin-surface', color: 'blue' },
  { text: 'worktree', color: 'red' },
  { text: ':5173', color: 'mint' },
];

const P = [];

P.push(...sectionTitle({ x: 80, y: 60, text: 'Chat — the pinned surface', fontSize: 42 }));
P.push(...prose({
  x: 80, y: 118, width: 660, fontSize: 15,
  text: 'DECIDED 2026-08-22 (owner). The shelf docks to the composer\'s top edge. It does not scroll, it does not react to scroll direction, and it never exceeds two rows. Pins carry a WEIGHT: a short fact is a tag, a rich one takes a row.',
}));

P.push(...panel(80, 240, 'Resting — a tag line',
  'The default. Session facts pack onto ONE chip line sitting on the composer: branch, a worktree marker when the checkout is linked, the port the work can be tested on. This is the lightness of the rejected option D, kept as A\'s zero state.',
  { tags: TAGS }));

P.push(...panel(760, 240, 'Active — one row opens above',
  'A run starts and the progress row opens ABOVE the tag line, so the tags never move. Percent, criteria count and the criterion in flight — all read from the task file. The row closes when the run ends; the tags stay.',
  { tags: TAGS, row: '64%  ·  7/11  ·  now: loopback url exception' }));

// ── A LONG pin: the lede, and the user-opened detail ────────────────────────
P.push(...panel(80, 800, 'Long pin — resting is a lede',
  'Prose that will not fit one line still occupies ONE row. The pin carries a lede and a detail; the shelf shows the lede plus a ⌄ affordance. It never quietly takes two rows — that would spend the whole ceiling and push the tag line out.',
  { tags: TAGS, row: '▸ Session özeti · 16 task silindi, 0.24.2 → 0.25.0 katlandı, yerleşim A     ⌄', rowColor: 'yellow' }));

P.push(...panel(760, 800, 'Long pin — the user opens it',
  'Clicking grows the row UPWARD into the transcript. The tag line and the composer do not move a pixel — the same property that made the row open above the tags. Expansion is user-initiated, so it is allowed past the ceiling; capped at ~40% of the pane, then it scrolls inside itself.',
  {
    tags: TAGS, rowH: 116, rowColor: 'yellow',
    row: 'Session özeti                                             ⌃\n\n16 gereksiz task silindi, 0.24.2 sürümü 0.25.0\'a katlandı.\nPinned surface için A yerleşimi seçildi; karar boardı\nknowledge\'a terfi etti ve kriterler yeniden yazıldı.',
  }));

// ── The rules ───────────────────────────────────────────────────────────────
const RY = 1400;
P.push(...sectionTitle({ x: 80, y: RY, text: 'The five rules', fontSize: 26 }));
P.push(...callout({
  x: 80, y: RY + 44, w: 660, title: 'WEIGHT',
  text: 'A pin with one short label renders as a tag and shares a line with its neighbours. A pin with a bar or several labelled facts takes a full row. The agent asks for a weight; the surface is free to demote a tag-sized row.',
}));
P.push(...callout({
  x: 80, y: RY + 190, w: 660, title: 'CEILING',
  text: 'Two rows, hard. The tag line counts as one. Nothing the agent sends can make the shelf grow a third row — it eats the conversation, which is the one failure mode option A has.',
}));
P.push(...callout({
  x: 80, y: RY + 336, w: 660, title: 'OVERFLOW',
  text: 'Past the ceiling, the oldest row demotes to a tag — it demoted, it did not close. Tags themselves are NEVER hidden: no "+N" fold, no per-line cap. The tag area wraps onto more lines as needed, capping at ~25% of the pane and scrolling inside itself.',
}));
P.push(...callout({
  x: 80, y: RY + 482, w: 660, title: 'EXPANSION',
  text: 'A long PIN rests as a lede and opens IN PLACE on click. The ceiling binds what the AGENT can force, not what the USER opens: expansion grows upward, past two rows, capped near 40% of the pane. One pin is open at a time. Progress detail is NOT in place — it opens as a floating popover, so the row costs the same height open or closed.',
}));
P.push(...callout({
  x: 80, y: RY + 640, w: 660, title: 'NO SCROLL REACTION',
  text: 'The shelf is fixed to the composer and never hides, reveals or resizes on a scroll gesture. Scrolling up is usually the user hunting for a fact the pin already holds — hiding it then is backwards, and scroll-reactive chrome re-opens a bug class this transcript already paid to close twice.',
}));

// ── Not chosen ──────────────────────────────────────────────────────────────
P.push(...sectionTitle({ x: 820, y: RY, text: 'Not chosen', fontSize: 26 }));
P.push(...table({
  x: 820, y: RY + 44, headers: ['Option', 'Why not'],
  rows: [
    ['B · rail beside\nthe transcript', 'Permanently narrows the\nnarrowest surface in the app.'],
    ['C · strip under\nthe tab bar', 'The region the eye learns to\nskip. Unwatched progress is\nnot progress.'],
    ['D · chips only,\ndetail on click', 'Already rejected once as the\ntoolbar chip. A progress card\nyou must click open is not\npinned — it survives here as\nA\'s resting state instead.'],
  ],
}));
P.push(...callout({
  x: 820, y: RY + 330, w: 620, title: 'HISTORY',
  text: 'Eight placements were rejected on 2026-08-17 because the composer was too crowded to receive anything. The 2026-08-22 composer redesign — one row, the context meter demoted to a ring — is what made this shelf possible.\n\n2026-08-23 live test: fold cut — tags always visible and wrap; progress detail became a popover.',
}));

buildExcalidraw({
  out: path.resolve(__dirname, 'chat-pinned-surface.excalidraw.md'),
  name: 'chat-pinned-surface',
  description: 'DECIDED placement for the pinned surface in the dreamcontext native Chat view: a shelf docked to the composer\'s top edge, resting as a single tag line and opening one row above it for the pinned progress card. Records the weight/ceiling/overflow/no-scroll-reaction rules and why options B, C and D were not chosen.',
  tags: ['topic:excalidraw', 'topic:agents', 'topic:desktop', 'kind:decision'],
  elements: P,
});
