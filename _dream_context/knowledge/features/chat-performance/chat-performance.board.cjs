/**
 * Chat performance — before/after board.
 *
 * Every number here was MEASURED, not estimated: the same 500-item transcript in the same
 * browser, windowed versus fully unwound (unwinding the window by pressing "Show earlier
 * messages" until nothing is hidden IS the pre-change render), plus a live streaming turn
 * driven by a scripted CLI stand-in so the token rate was controlled.
 *
 *   node _dream_context/knowledge/features/chat-performance/chat-performance.board.cjs
 */
const path = require('path');
const SKILL = path.resolve(__dirname, '../../../../.claude/skills/excalidraw/scripts');
const { buildExcalidraw } = require(path.join(SKILL, 'build_excalidraw.js'));
const {
  sectionTitle, stack, row, prose, card, connector, chip,
} = require(path.join(SKILL, 'lib/style.js'));
const { kpi, barCompare, table, callout, barChart } = require(path.join(SKILL, 'lib/charts.js'));

const OUT = path.resolve(__dirname, 'chat-performance.excalidraw.md');

// ── Measured data ────────────────────────────────────────────────────────────────
// Static: 500 replayed history items, same browser, forced GC before each heap read.
const STATIC = [
  { metric: 'Transcript DOM nodes', short: 'DOM', before: 9533, after: 764, unit: '' },
  { metric: 'Document DOM nodes', short: 'doc DOM', before: 9837, after: 1066, unit: '' },
  { metric: 'Mounted transcript rows', short: 'rows', before: 502, after: 43, unit: '' },
  { metric: 'Scroll height', short: 'height', before: 105456, after: 8415, unit: 'px' },
  { metric: 'JS heap, after GC', short: 'heap', before: 12.3, after: 9.9, unit: 'MB' },
];
const pct = (b, a) => `−${(((b - a) / b) * 100).toFixed(1)}%`;
const fmt = (v, unit) => (unit === 'MB' ? `${v} MB` : `${v.toLocaleString('en-US')}${unit ? ' ' + unit : ''}`);

const elements = [];
const P = (els) => { elements.push(...els); return els; };

// ── Header ───────────────────────────────────────────────────────────────────────
let cur = P(stack({
  x: 60, y: 60, gap: 26, items: [
    (x, y) => sectionTitle({ x, y, text: 'Chat performance — what the windowed transcript bought', fontSize: 42, maxWidth: 1200 }),
    (x, y) => callout({
      x, y, w: 1180, color: 'gray', title: 'Same page,\nmeasured\nboth ways',
      text: '"Before" is not a memory — it is this same conversation with the window fully unwound, which is exactly what the old code mounted. The live-stream numbers come from a scripted stand-in for the CLI, so the token rate was controlled rather than hoped for.',
    }),
  ],
})).nextY;

// ── Headline tiles ───────────────────────────────────────────────────────────────
cur = P(row({
  x: 60, y: cur + 14, gap: 22, items: [
    (x, y) => kpi({ x, y, w: 278, h: 172, label: 'Transcript DOM nodes', value: '764', delta: 'was 9,533  ·  −92.0%', color: 'green' }),
    (x, y) => kpi({ x, y, w: 278, h: 172, label: 'Scroll height', value: '8,415px', delta: 'was 105,456px  ·  −92.0%', color: 'green' }),
    (x, y) => kpi({ x, y, w: 278, h: 172, label: 'Mounted rows', value: '43', delta: 'was 502  ·  bounded now', color: 'green' }),
    (x, y) => kpi({ x, y, w: 278, h: 172, label: 'JS heap, whole page', value: '9.9MB', delta: 'was 12.3 MB  ·  −19.5%', color: 'mint' }),
  ],
})).nextY;

// ── Normalised comparison + raw table ────────────────────────────────────────────
cur = P(row({
  x: 60, y: cur + 34, gap: 34, valign: 'top', items: [
    (x, y) => barCompare({
      x, y, w: 640, h: 400,
      title: 'Every metric as a % of what it used to be',
      seriesLabels: ['before', 'after'],
      colors: ['red', 'green'],
      groups: STATIC.map((m) => ({
        label: m.short,
        values: [100, Math.round((m.after / m.before) * 1000) / 10],
      })),
      yTitle: '% of before',
      yMax: 110,
    }),
    (x, y) => table({
      x, y,
      title: 'The raw numbers',
      headers: ['metric', 'before', 'after', 'change'],
      rows: STATIC.map((m) => [
        m.metric,
        fmt(m.before, m.unit),
        fmt(m.after, m.unit),
        { text: pct(m.before, m.after), color: 'green' },
      ]),
    }),
  ],
})).nextY;

cur = P(stack({
  x: 60, y: cur + 22, gap: 18, items: [
    (x, y) => callout({
      x, y, w: 1180, color: 'mint', title: 'The valve really frees',
      text: 'Heap is the WHOLE page, so −19.5% understates the transcript\'s own share. The number that proves the memory actually comes back: after unwinding to 12.3 MB, pressing "↓ Latest" re-shrinks the window and the heap settles at 10.3 MB. It is a release valve, not merely a slower leak.',
    }),
  ],
})).nextY;

// ── Live stream ──────────────────────────────────────────────────────────────────
cur = P(stack({
  x: 60, y: cur + 40, gap: 24, items: [
    (x, y) => sectionTitle({ x, y, text: 'While a turn is actually streaming', fontSize: 32, maxWidth: 1180 }),
    (x, y) => callout({
      x, y, w: 1180, color: 'blue', title: 'A 60-item\nturn at\n~250 fps',
      text: 'The window slides forward as items land, so the mounted DOM stays flat for the whole turn — and the coalescer stops a React commit per token without ever delaying something the user is waiting on.',
    }),
  ],
})).nextY;

cur = P(row({
  x: 60, y: cur + 12, gap: 22, items: [
    (x, y) => kpi({ x, y, w: 278, h: 168, label: 'Mounted rows across the turn', value: '14–41', delta: 'bounded, not growing', color: 'green' }),
    (x, y) => kpi({ x, y, w: 278, h: 168, label: 'Longest transcript stall', value: '200ms', delta: 'deltas deferred, never dropped', color: 'green' }),
    (x, y) => kpi({ x, y, w: 278, h: 168, label: 'Permission card mid-stream', value: 'instant', delta: 'painted while text still streaming', color: 'blue' }),
    (x, y) => kpi({ x, y, w: 278, h: 168, label: 'Pinned view left the bottom', value: '0 / 74', delta: 'samples — it followed the whole turn', color: 'green' }),
  ],
})).nextY;

cur = P(row({
  x: 60, y: cur + 30, gap: 34, valign: 'top', items: [
    (x, y) => barChart({
      x, y, w: 560, h: 320, horizontal: true, color: 'blue',
      title: 'React commits per second, during a stream',
      bars: [
        { label: 'before — one per token', value: 250, color: 'red' },
        { label: 'after — one per frame', value: 60, color: 'green' },
      ],
      xTitle: 'commits / sec',
    }),
    (x, y) => barChart({
      x, y, w: 560, h: 320, horizontal: true, color: 'blue',
      title: 'Lines rendered for one 1,200-line shell result',
      bars: [
        { label: 'before — every line', value: 1201, color: 'red' },
        { label: 'after — head 20 + tail 20', value: 41, color: 'green' },
      ],
    }),
  ],
})).nextY;

// ── What each phase does ─────────────────────────────────────────────────────────
cur = P(stack({
  x: 60, y: cur + 40, gap: 24, items: [
    (x, y) => sectionTitle({ x, y, text: 'Where the win comes from — five independent changes', fontSize: 32, maxWidth: 1180 }),
  ],
})).nextY;

const PHASES = [
  { n: '1', t: 'Memo the items', b: 'a token re-rendered EVERY item', a: 'it re-renders one', c: 'purple' },
  { n: '2', t: 'Isolate the panes', b: 'any session\'s status edge re-rendered every pane', a: 'it stops at the memo boundary', c: 'blue' },
  { n: '3', t: 'Coalesce the stream', b: 'one React commit per NDJSON frame', a: 'one per animation frame', c: 'yellow' },
  { n: '4', t: 'Window the transcript', b: 'every item ever, mounted forever', a: 'the last 40, revealed on demand', c: 'green' },
  { n: '5', t: 'Bound the card bodies', b: 'a Read result could be megabytes of DOM', a: 'clamped, with the rest one click away', c: 'mint' },
];
const PHASE_W = 224;
cur = P(row({
  x: 60, y: cur + 6, gap: 15, valign: 'top',
  items: PHASES.map((p) => (x, y) => stack({
    x, y, gap: 10, items: [
      (cx, cy) => card({ x: cx, y: cy, w: PHASE_W, h: 74, text: `${p.n}. ${p.t}`, color: p.c, fontSize: 16 }),
      (cx, cy) => card({ x: cx, y: cy, w: PHASE_W, h: 96, text: p.b, color: 'red', fontSize: 12 }),
      (cx, cy) => card({ x: cx, y: cy, w: PHASE_W, h: 96, text: p.a, color: 'green', fontSize: 12 }),
    ],
  })),
})).nextY;

// ── Method + the two defects review caught ───────────────────────────────────────
cur = P(row({
  x: 60, y: cur + 34, gap: 26, valign: 'top', items: [
    (x, y) => callout({
      x, y, w: 576, color: 'gray', title: 'How it was measured',
      text: 'A synthesized 300-turn transcript (1,200 JSONL entries, 7.4 MB, 1,200-line shell results, inline images) in an isolated scratch vault with a fake HOME. Resumed through the real WS route into the real dashboard. Heap from CDP JSHeapUsedSize after three forced collections. No estimates anywhere on this board.',
    }),
    (x, y) => callout({
      x, y, w: 576, color: 'red', title: 'Two defects a review caught, both in the reveal',
      text: 'Compensating a prepend by total scroll height double-counts a streamed append landing in the same commit (measured: 214–358 px of false scroll). And the anchor row itself can be unmounted mid-commit when the sub-agent card\'s key migrates. Both fixed; the reader now drifts 0 px across a 3,990 px reveal.',
    }),
  ],
})).nextY;

buildExcalidraw({
  out: OUT,
  elements,
  name: 'chat-performance-windowed-transcript',
  tags: ['performance', 'agents', 'frontend', 'excalidraw'],
  description: 'Measured before/after for the Agent Chat performance work: a tail-windowed transcript, memoized transcript items, a memo boundary between AgentSurface and each pane, per-frame notification coalescing, and clamped card bodies. Same 500-item conversation measured both ways in one browser — transcript DOM nodes 9,533 to 764 (-92%), scroll height 105,456px to 8,415px, mounted rows 502 to 43, JS heap 12.3MB to 9.9MB with 10.3MB reclaimed on return to the tail. Live streaming turn: rows bounded 14-41, React commits capped at the frame rate instead of the token rate, permission cards still painting mid-stream, no dropped deltas.',
});
