import type { FlowSpec, FlowEdge } from '../about/FlowDiagram';

/**
 * Council's signature diagram — a richer take on the About-page Council faculty.
 * Six persona archetypes sit around a round table and DEBATE each other: instead
 * of a one-way perimeter relay, every persona reads the reasoning of personas
 * ACROSS the table (Researcher ↔ Architect, Architect ↔ Advocate, …). Each chord
 * runs node-edge to node-edge with a directional arrowhead landing AT the persona
 * being read, so "who reads whom" is obvious at a glance; travelling comets show
 * the live flow; the centre reads "↻ rounds"; and the resolved debate converges
 * out to a synthesizer that writes one decision report.
 *
 * Authored as data and rendered by the shared {@link FlowDiagram} engine, so it
 * animates via CSS Motion Path (compositor-friendly) and is reduced-motion safe.
 * Personas are generated per-topic in the real skill (no preset library); the
 * archetypes here are illustrative of the cognitive diversity a council aims for.
 */

const P_W = 122;
const P_H = 48;
// A round table of six personas centred on (250, 214). Rects are (cx - w/2, …).
const PERSONAS: { id: string; x: number; y: number; title: string; sub: string; delay: number }[] = [
  { id: 'p1', x: 189, y: 36,  title: 'Architect',  sub: 'systems',   delay: 0.0 },  // top
  { id: 'p2', x: 322, y: 113, title: 'Pragmatist', sub: 'shipping',  delay: 0.2 },  // upper-right
  { id: 'p3', x: 322, y: 267, title: 'Skeptic',    sub: 'risk',      delay: 0.4 },  // lower-right
  { id: 'p4', x: 189, y: 344, title: 'Researcher', sub: 'evidence',  delay: 0.6 },  // bottom
  { id: 'p5', x: 56,  y: 267, title: 'Advocate',   sub: 'the user',  delay: 0.8 },  // lower-left
  { id: 'p6', x: 56,  y: 113, title: 'Strategist', sub: 'long game', delay: 1.0 },  // upper-left
];

type Box = { cx: number; cy: number; w: number; h: number };
const NODES: Record<string, Box> = {};
for (const p of PERSONAS) NODES[p.id] = { cx: p.x + P_W / 2, cy: p.y + P_H / 2, w: P_W, h: P_H };
NODES.syn = { cx: 566, cy: 214, w: 132, h: 96 };

// The point on a node's (padded) rectangle boundary in the direction of another
// point — so chords start/end exactly at the node edge, never under it or adrift.
function rectEdge(box: Box, towardX: number, towardY: number, pad: number): [number, number] {
  const hx = box.w / 2 + pad;
  const hy = box.h / 2 + pad;
  const ux = towardX - box.cx;
  const uy = towardY - box.cy;
  const sx = ux !== 0 ? hx / Math.abs(ux) : Infinity;
  const sy = uy !== 0 ? hy / Math.abs(uy) : Infinity;
  const s = Math.min(sx, sy);
  return [box.cx + ux * s, box.cy + uy * s];
}

// A debate chord A→B: leaves A's edge, lands an arrowhead just off B's edge, and
// bows gently to one side. Every chord shares the same handedness, so the
// cross-talk reads as a subtle swirl around the central "↻ rounds".
function chord(a: string, b: string, bow = 0.1): string {
  const A = NODES[a];
  const B = NODES[b];
  const [sx, sy] = rectEdge(A, B.cx, B.cy, 3);
  const [ex, ey] = rectEdge(B, A.cx, A.cy, 9); // +9 so the arrowhead clears the box
  const mx = (sx + ex) / 2;
  const my = (sy + ey) / 2;
  let dx = ex - sx;
  let dy = ey - sy;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len;
  dy /= len;
  const cx = mx + -dy * bow * len;
  const cy = my + dx * bow * len;
  return `M ${sx.toFixed(1)} ${sy.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}`;
}

// Directed cross-reads — every persona both reads and is read across the table.
// Includes the diameters (p1↔p4, p2↔p5, p3↔p6) and skip-one chords so each node
// has three cross-links; the listed direction is "source → reader".
const CROSS: [string, string][] = [
  ['p1', 'p4'], // Architect → Researcher  (researcher reads architect)
  ['p5', 'p1'], // Advocate  → Architect   (architect reads advocate)
  ['p1', 'p3'], // Architect → Skeptic
  ['p2', 'p5'], // Pragmatist → Advocate
  ['p2', 'p6'], // Pragmatist → Strategist
  ['p3', 'p6'], // Skeptic    → Strategist
  ['p4', 'p2'], // Researcher → Pragmatist
  ['p4', 'p6'], // Researcher → Strategist
  ['p5', 'p3'], // Advocate   → Skeptic
];

const debateEdges: FlowEdge[] = CROSS.map(([a, b], i) => ({
  id: `${a}-${b}`,
  d: chord(a, b),
  arrow: true,
  thin: true,
  dur: 2.5 + (i % 3) * 0.25,
  delay: (i * 0.27) % 2.5,
}));

export const COUNCIL_SHOWCASE: FlowSpec = {
  viewBox: '0 0 700 412',
  ariaLabel:
    'A council of six persona sub-agents reads each other’s reasoning across the table, round after round, then the resolved debate converges into a synthesizer that writes one decision report.',
  nodes: [
    ...PERSONAS.map((p) => ({
      id: p.id,
      x: p.x,
      y: p.y,
      w: P_W,
      h: P_H,
      title: p.title,
      sub: p.sub,
      variant: 'region' as const,
      breathe: true,
      breatheDelay: p.delay,
    })),
    {
      id: 'syn',
      x: 500,
      y: 166,
      w: 132,
      h: 96,
      title: 'synthesizer',
      sub: 'decision report',
      variant: 'rem' as const,
    },
  ],
  edges: [
    ...debateEdges,
    // "↻ rounds" sits at the centre of the cross-talk (attached to a zero-length
    // wire so the label renders in the wires layer, behind the nodes).
    { id: 'rounds', d: 'M 250 214 L 250 214', comet: false, label: { text: '↻ rounds', x: 250, y: 214 } },
    // Convergence — the resolved debate flows out into the synthesizer.
    { id: 'p2-syn', d: chord('p2', 'syn'), arrow: true, dur: 2.4, delay: 0.5 },
    { id: 'p3-syn', d: chord('p3', 'syn'), arrow: true, dur: 2.4, delay: 1.0 },
  ],
};
