import type { FlowEdge, FlowNode, FlowSpec } from './FlowDiagram';

/**
 * Vertical S-curve cubic Bézier between two points. The control points sit at the
 * vertical midpoint, giving a smooth "drip" that fans out / converges cleanly.
 *
 *   M x1 y1  C x1 my, x2 my, x2 y2
 */
export function vCurve(x1: number, y1: number, x2: number, y2: number): string {
  const my = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`;
}

// ───────────────────────────────────────────────────────────────────────────
// 1. HOW IT WORKS — the SessionStart loop
//    A hook preloads 8 context categories (2 rows of 4) with zero tool calls →
//    the agent works with the whole picture → RemSleep specialists consolidate
//    and feed back into the band. The loop is the product.
// ───────────────────────────────────────────────────────────────────────────

interface Category {
  file: string;
  region: string;
  glyph: string;
}

const CATEGORIES: Category[] = [
  { file: 'soul', region: 'Identity', glyph: '◆' },
  { file: 'user', region: 'Episodic', glyph: '◉' },
  { file: 'memory', region: 'Semantic', glyph: '✦' },
  { file: 'knowledge', region: 'Procedural', glyph: '⚙' },
  { file: 'state', region: 'Working', glyph: '▦' },
  { file: 'data-structures', region: 'Schema', glyph: '▤' },
  { file: 'skills', region: 'Capabilities', glyph: '✧' },
  { file: 'sub-agents', region: 'Workers', glyph: '⬡' },
];

const HIW_CX = 600; // viewBox 0 0 1200 780, horizontal center
const CAT_W = 250;
const CAT_H = 92;
const COLS = 4;
const COL_GAP = (1200 - COLS * CAT_W) / (COLS + 1); // even gutters
const ROW1_TOP = 196;
const ROW2_TOP = 320;
const ROW_PITCH = ROW2_TOP - ROW1_TOP;

const HOOK_BOTTOM = 120;
const AGENT_TOP = 470;
const AGENT_BOTTOM = 548;
const REM_TOP = 632;

function catX(col: number): number {
  return COL_GAP + col * (CAT_W + COL_GAP);
}
function catCx(col: number): number {
  return catX(col) + CAT_W / 2;
}
function catTop(row: number): number {
  return ROW1_TOP + row * ROW_PITCH;
}

const hiwCategoryNodes: FlowNode[] = CATEGORIES.map((c, i) => {
  const col = i % COLS;
  const row = Math.floor(i / COLS);
  return {
    id: `cat-${c.file}`,
    x: catX(col),
    y: catTop(row),
    w: CAT_W,
    h: CAT_H,
    title: c.file,
    sub: c.region,
    glyph: c.glyph,
    variant: 'region',
    breathe: true,
    breatheDelay: i * 0.18,
  };
});

// Hook fans out into the TOP row; the top row visually seeds the bottom row.
const hiwFanOutEdges: FlowEdge[] = CATEGORIES.slice(0, COLS).map((_, col) => ({
  id: `fan-${col}`,
  d: vCurve(HIW_CX, HOOK_BOTTOM, catCx(col), ROW1_TOP),
  travel: 220,
  delay: col * 0.18,
  dur: 2.6,
}));

// Every category converges down into the agent node.
const hiwConvergeEdges: FlowEdge[] = CATEGORIES.map((c, i) => {
  const col = i % COLS;
  const row = Math.floor(i / COLS);
  return {
    id: `conv-${c.file}`,
    d: vCurve(catCx(col), catTop(row) + CAT_H, HIW_CX, AGENT_TOP),
    travel: 300,
    delay: 0.5 + i * 0.12,
    dur: 2.8,
  };
});

export const HOW_IT_WORKS_SPEC: FlowSpec = {
  viewBox: '0 0 1200 780',
  ariaLabel:
    'How dreamcontext works: a SessionStart hook preloads eight context categories — identity, episodic, semantic, procedural, working, schema, capabilities and workers — with zero tool calls. The agent then works with the whole picture, and RemSleep parallel specialists consolidate the session and feed the distilled knowledge back into the context categories. The loop is the product.',
  nodes: [
    {
      id: 'hook',
      x: HIW_CX - 215,
      y: 40,
      w: 430,
      h: 80,
      title: 'SessionStart hook fires',
      sub: 'preloads context · 0 tool calls',
      variant: 'hook',
    },
    ...hiwCategoryNodes,
    {
      id: 'agent',
      x: HIW_CX - 250,
      y: AGENT_TOP,
      w: 500,
      h: 78,
      title: 'Your agent works with the whole picture',
      sub: 'no re-exploring · no blind search spiral',
      variant: 'agent',
    },
    {
      id: 'rem',
      x: HIW_CX - 200,
      y: REM_TOP,
      w: 400,
      h: 78,
      title: 'RemSleep — parallel specialists',
      sub: 'multi-agent consolidation',
      variant: 'rem',
    },
  ],
  edges: [
    ...hiwFanOutEdges,
    ...hiwConvergeEdges,
    // Agent → RemSleep (straight drop).
    {
      id: 'agent-rem',
      d: `M ${HIW_CX} ${AGENT_BOTTOM} L ${HIW_CX} ${REM_TOP}`,
      travel: 90,
      delay: 1.6,
      dur: 1.8,
    },
    // Feedback loop: RemSleep → up the right gutter → back into the band.
    {
      id: 'feedback',
      d: 'M 800 671 C 1140 671, 1170 470, 1170 300 C 1170 170, 1110 170, 1010 170',
      dashed: true,
      travel: 520,
      delay: 0,
      dur: 4.2,
      label: { text: 'consolidates & feeds back', x: 1180, y: 420, rotate: 90 },
    },
  ],
};

// ───────────────────────────────────────────────────────────────────────────
// 2. SLEEP FLOW — debt → sleep start → 3 parallel specialists → sleep done
//    Mirrors the real fan-out architecture: sleep-tasks + sleep-state always
//    fire; sleep-product is conditional.
// ───────────────────────────────────────────────────────────────────────────

const SLEEP_CX = 550; // viewBox 0 0 1100 680
const SPEC_W = 300;
const SPEC_H = 116;
const SPEC_COLS = 3;
const SPEC_GAP = (1100 - SPEC_COLS * SPEC_W) / (SPEC_COLS + 1);
const SPEC_TOP = 280;

const SLEEP_START_BOTTOM = 196;
const SLEEP_CONVERGE_TOP = 470;
const SLEEP_CONVERGE_BOTTOM = 540;
const SLEEP_DONE_TOP = 596;

function specX(col: number): number {
  return SPEC_GAP + col * (SPEC_W + SPEC_GAP);
}
function specCx(col: number): number {
  return specX(col) + SPEC_W / 2;
}

interface Specialist {
  id: string;
  title: string;
  sub: string;
}

const SPECIALISTS: Specialist[] = [
  { id: 'sleep-tasks', title: 'sleep-tasks', sub: 'state/*.md tasks' },
  {
    id: 'sleep-state',
    title: 'sleep-state',
    sub: 'soul·user·memory·core 3-6·data-structures·changelog·releases',
  },
  { id: 'sleep-product', title: 'sleep-product', sub: 'knowledge/ + features/ · conditional' },
];

const sleepSpecialistNodes: FlowNode[] = SPECIALISTS.map((s, col) => ({
  id: s.id,
  x: specX(col),
  y: SPEC_TOP,
  w: SPEC_W,
  h: SPEC_H,
  title: s.title,
  sub: s.sub,
  variant: 'region',
  breathe: true,
  breatheDelay: col * 0.25,
}));

const sleepFanOutEdges: FlowEdge[] = SPECIALISTS.map((s, col) => ({
  id: `fan-${s.id}`,
  d: vCurve(SLEEP_CX, SLEEP_START_BOTTOM, specCx(col), SPEC_TOP),
  travel: 200,
  delay: col * 0.3,
  dur: 2.4,
}));

const sleepConvergeEdges: FlowEdge[] = SPECIALISTS.map((s, col) => ({
  id: `conv-${s.id}`,
  d: vCurve(specCx(col), SPEC_TOP + SPEC_H, SLEEP_CX, SLEEP_CONVERGE_TOP),
  travel: 200,
  delay: 0.9 + col * 0.2,
  dur: 2.4,
}));

export const SLEEP_FLOW_SPEC: FlowSpec = {
  viewBox: '0 0 1100 680',
  ariaLabel:
    'Sleep consolidation: sessions accumulate sleep debt; running sleep start fans out to three parallel specialists — sleep-tasks updates task files, sleep-state updates core files, changelog and releases, and sleep-product conditionally updates knowledge and feature docs. Their reports converge into updated system knowledge, then sleep done resets the debt.',
  nodes: [
    {
      id: 'debt',
      x: SLEEP_CX - 230,
      y: 36,
      w: 460,
      h: 76,
      title: 'Sessions accumulate → sleep debt',
      sub: 'Alert · Drowsy · Sleepy · Must Sleep',
      variant: 'accent',
    },
    {
      id: 'sleep-start',
      x: SLEEP_CX - 130,
      y: 132,
      w: 260,
      h: 64,
      title: 'sleep start',
      sub: 'pins the epoch',
      variant: 'hook',
    },
    ...sleepSpecialistNodes,
    {
      id: 'converge',
      x: SLEEP_CX - 220,
      y: SLEEP_CONVERGE_TOP,
      w: 440,
      h: 70,
      title: 'system knowledge updated',
      sub: 'reports stitched into one summary',
      variant: 'agent',
    },
    {
      id: 'sleep-done',
      x: SLEEP_CX - 130,
      y: SLEEP_DONE_TOP,
      w: 260,
      h: 64,
      title: 'sleep done',
      sub: 'debt reset',
      variant: 'rem',
    },
  ],
  edges: [
    {
      id: 'debt-start',
      d: `M ${SLEEP_CX} 112 L ${SLEEP_CX} 132`,
      travel: 26,
      delay: 0,
      dur: 1.4,
    },
    ...sleepFanOutEdges,
    ...sleepConvergeEdges,
    {
      id: 'converge-done',
      d: `M ${SLEEP_CX} ${SLEEP_CONVERGE_BOTTOM} L ${SLEEP_CX} ${SLEEP_DONE_TOP}`,
      travel: 64,
      delay: 1.8,
      dur: 1.8,
    },
  ],
};

// ───────────────────────────────────────────────────────────────────────────
// 3. RECALL FLOW — the read pipeline, left → right
//    prompt → BM25F keyword match → Haiku recall → SessionStart snapshot.
// ───────────────────────────────────────────────────────────────────────────

const RECALL_CY = 230; // viewBox 0 0 1100 460
const RECALL_W = 230;
const RECALL_H = 132;

interface RecallStage {
  id: string;
  x: number;
  title: string;
  sub: string;
  variant: FlowNode['variant'];
}

const RECALL_STAGES: RecallStage[] = [
  { id: 'prompt', x: 40, title: 'Your prompt', sub: 'any language', variant: 'hook' },
  {
    id: 'bm25',
    x: 320,
    title: 'BM25F keyword match',
    sub: 'field-weighted · stemming · synonyms',
    variant: 'region',
  },
  {
    id: 'haiku',
    x: 600,
    title: 'Haiku recall',
    sub: 'smallest cloud agent · 0-3 docs · BM25 fallback',
    variant: 'region',
  },
  {
    id: 'snapshot',
    x: 880,
    title: 'SessionStart snapshot',
    sub: 'warm + cold knowledge · features · index · pinned',
    variant: 'rem',
  },
];

const recallNodes: FlowNode[] = RECALL_STAGES.map((s) => ({
  id: s.id,
  x: s.x,
  y: RECALL_CY - RECALL_H / 2,
  w: RECALL_W,
  h: RECALL_H,
  title: s.title,
  sub: s.sub,
  variant: s.variant,
}));

const recallEdges: FlowEdge[] = RECALL_STAGES.slice(0, -1).map((s, i) => {
  const next = RECALL_STAGES[i + 1];
  const x1 = s.x + RECALL_W;
  const x2 = next.x;
  return {
    id: `pipe-${s.id}`,
    d: `M ${x1} ${RECALL_CY} L ${x2} ${RECALL_CY}`,
    travel: x2 - x1,
    delay: i * 0.4,
    dur: 2.2,
  };
});

export const RECALL_FLOW_SPEC: FlowSpec = {
  viewBox: '0 0 1100 460',
  ariaLabel:
    'Memory recall pipeline: your prompt is matched by field-weighted BM25F keyword search with stemming and synonyms; a small Haiku cloud agent picks zero to three directly relevant docs (falling back to BM25 when unavailable); and the SessionStart snapshot assembles warm and cold knowledge, features, the index and pinned docs.',
  nodes: recallNodes,
  edges: recallEdges,
};
