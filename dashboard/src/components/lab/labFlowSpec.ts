import type { FlowSpec, FlowEdge } from '../about/FlowDiagram';
import { makeLink, type Box } from '../about/flow-geometry';

/**
 * Lab's signature diagram — the insight pipeline, left-to-right. External sources
 * (a PostHog query, a Stripe number, any HTTP/JSON API or local script) converge
 * into `lab sync`, which resolves the time window, fetches, and rolls the raw
 * points down to a capped, curated series (Lab is insights, NEVER raw dumps). The
 * synced snapshot lands in the brain's insight cache, where it fans out to the two
 * consumers that matter: every agent's SessionStart snapshot, and a bound roadmap
 * Key Result whose `metric.current` the sync writes — upgrading the roadmap from
 * pasted numbers to measured ones.
 *
 * Authored as data and rendered by the shared {@link FlowDiagram} engine, so it
 * animates via CSS Motion Path (compositor-friendly) and is reduced-motion safe.
 */

// Pipeline laid out left-to-right in a 700-wide viewBox (same width as the
// Council stage; the box height is trimmed to this flatter layout — see the
// viewBox note below). Sources on the left converge to the sync hub, then to the
// cache, then out to the two consumers on the right.
const SRC_W = 120;
const SRC_H = 50;
const SOURCES: { id: string; x: number; y: number; title: string; sub: string; delay: number }[] = [
  { id: 's1', x: 20, y: 44, title: 'PostHog', sub: 'product', delay: 0.0 },
  { id: 's2', x: 20, y: 158, title: 'Stripe', sub: 'revenue', delay: 0.4 },
  { id: 's3', x: 20, y: 272, title: 'HTTP · script', sub: 'anything', delay: 0.8 },
];

// Downstream stages, authored once (x/y/w/h) — NODES and the rendered `nodes:`
// array below both derive from this, so a nudge here moves box AND wires together.
const STAGES: { id: string; x: number; y: number; w: number; h: number; title: string; sub: string | string[]; variant: 'rem' | 'accent' | 'agent' }[] = [
  { id: 'sync', x: 209, y: 156, w: 134, h: 100, title: 'sync', sub: ['↻ TTL-gated', 'rollup · cap'], variant: 'rem' },
  { id: 'cache', x: 409, y: 170, w: 126, h: 72, title: 'insight', sub: 'cached series', variant: 'accent' },
  // 140 wide so the one-line subs ("session snapshot", "measured metric") fit
  // without wrapping past the box.
  { id: 'c1', x: 550, y: 114, w: 140, h: 56, title: 'agents', sub: 'session snapshot', variant: 'agent' },
  { id: 'c2', x: 550, y: 242, w: 140, h: 56, title: 'roadmap KR', sub: 'measured metric', variant: 'agent' },
];

const NODES: Record<string, Box> = {};
for (const s of SOURCES) NODES[s.id] = { cx: s.x + SRC_W / 2, cy: s.y + SRC_H / 2, w: SRC_W, h: SRC_H };
for (const s of STAGES) NODES[s.id] = { cx: s.x + s.w / 2, cy: s.y + s.h / 2, w: s.w, h: s.h };

// Directed wires A→B: edge-to-edge with arrowhead clearance (shared geometry —
// see flow-geometry.ts). Positive bow fans a wire out to one side.
const link = makeLink(NODES);

const ingest: FlowEdge[] = SOURCES.map((s, i) => ({
  id: `${s.id}-sync`,
  d: link(s.id, 'sync'),
  arrow: true,
  thin: true,
  dur: 2.4 + (i % 3) * 0.2,
  delay: (i * 0.5) % 2.4,
}));

export const LAB_SHOWCASE: FlowSpec = {
  // Content spans y 44..322 (centre 183) — the 366-high box centres it exactly,
  // where Council's 412 would leave 90px of dead space under this flatter layout.
  viewBox: '0 0 700 366',
  ariaLabel:
    'External sources — a PostHog query, a Stripe number, any HTTP API or local script — converge into one sync, which rolls the raw data down to a capped curated series, caches it in the brain, and fans it out to every agent’s session snapshot and a bound roadmap Key Result.',
  nodes: [
    ...SOURCES.map((s) => ({
      id: s.id,
      x: s.x,
      y: s.y,
      w: SRC_W,
      h: SRC_H,
      title: s.title,
      sub: s.sub,
      variant: 'region' as const,
      breathe: true,
      breatheDelay: s.delay,
    })),
    ...STAGES,
  ],
  edges: [
    ...ingest,
    // Curate → cache → fan-out.
    { id: 'sync-cache', d: link('sync', 'cache'), arrow: true, dur: 2.3, delay: 0.3 },
    { id: 'cache-c1', d: link('cache', 'c1', 0.06), arrow: true, dur: 2.2, delay: 0.9 },
    { id: 'cache-c2', d: link('cache', 'c2', -0.06), arrow: true, dur: 2.2, delay: 1.3 },
  ],
};
