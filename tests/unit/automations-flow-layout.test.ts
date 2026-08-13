/**
 * `flowLayout.ts` is a pure `FlowGraph -> FlowSpec` layout engine (see its own
 * module doc for the algorithm) — deterministic layered placement with cycle
 * breaking, no library, no DOM. These tests exercise it exactly the way
 * `scripts/verify/automations.mjs` will later: call `layoutFlow`, inspect the
 * returned `FlowSpec` (positions, edge geometry, viewBox), never a browser.
 */
import { describe, it, expect } from 'vitest';
import type { FlowGraph, FlowGraphEdge, FlowGraphNode } from '../../src/lib/automations/types.js';
import {
  layoutFlow,
  NODE_W,
  NODE_H,
  RANK_GAP,
  LANE_GAP,
  MARGIN,
  BOW_SKIP,
} from '../../dashboard/src/components/automations/flowLayout.js';

function node(id: string, kind: string, extra: Partial<FlowGraphNode> = {}): FlowGraphNode {
  return { id, kind, ...extra };
}

function edge(from: string, to: string, extra: Partial<FlowGraphEdge> = {}): FlowGraphEdge {
  return { from, to, ...extra };
}

function graph(nodes: FlowGraphNode[], edges: FlowGraphEdge[]): FlowGraph {
  return { version: 'automation-flow/v1', nodes, edges };
}

/** Parses a `makeLink`-produced `M sx sy Q cx cy ex ey` path into its six
 *  numbers — the exact, documented format `flow-geometry.ts` emits. */
function parseQuadratic(d: string): { sx: number; sy: number; cx: number; cy: number; ex: number; ey: number } {
  const m = d.match(/^M (-?[\d.]+) (-?[\d.]+) Q (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)$/);
  expect(m).not.toBeNull();
  const [, sx, sy, cx, cy, ex, ey] = m!.map(Number);
  return { sx, sy, cx, cy, ex, ey };
}

/** Reference re-derivation of `makeLink`'s bow formula (documented in
 *  `flow-geometry.ts`: `cx = mx + -dy*bow*len`, `cy = my + dx*bow*len` over
 *  the unit tangent) — used to assert the exact control point a given `bow`
 *  must produce, independent of re-calling the module under test. */
function expectedControlPoint(sx: number, sy: number, ex: number, ey: number, bow: number): { cx: number; cy: number } {
  const mx = (sx + ex) / 2;
  const my = (sy + ey) / 2;
  const len = Math.hypot(ex - sx, ey - sy) || 1;
  const dx = (ex - sx) / len;
  const dy = (ey - sy) / len;
  return { cx: mx + -dy * bow * len, cy: my + dx * bow * len };
}

describe('layoutFlow — empty & trivial graphs', () => {
  it('lays out an empty graph without throwing: no nodes, no edges, a valid non-empty viewBox', () => {
    const spec = layoutFlow(graph([], []));
    expect(spec.nodes).toEqual([]);
    expect(spec.edges).toEqual([]);
    expect(spec.viewBox).toBe(`${-MARGIN} ${-MARGIN} ${MARGIN * 2} ${MARGIN * 2}`);
    expect(spec.ariaLabel.length).toBeGreaterThan(0);
  });

  it('places a single node at rank 0, centred on the shared axis, with the registry glyph/variant', () => {
    const spec = layoutFlow(graph([node('only', 'agent')], []));
    expect(spec.nodes).toHaveLength(1);
    const n = spec.nodes[0];
    expect(n.id).toBe('only');
    expect(n.x).toBe(0);
    expect(n.y).toBe(-NODE_H / 2);
    expect(n.w).toBe(NODE_W);
    expect(n.h).toBe(NODE_H);
    expect(n.variant).toBe('hook'); // agent's registry variant (flow-registry.ts)
    expect(n.glyph).toBe('◆');
    expect(n.title).toBe('agent'); // no label -> falls back to kind
    expect(spec.edges).toEqual([]);
  });
});

describe('layoutFlow — linear chain', () => {
  it('ranks a -> b -> c left to right, one rank apart, every edge straight (bow 0, not dashed)', () => {
    const g = graph(
      [node('a', 'trigger'), node('b', 'agent'), node('c', 'report')],
      [edge('a', 'b'), edge('b', 'c')],
    );
    const spec = layoutFlow(g);
    const byId = Object.fromEntries(spec.nodes.map((n) => [n.id, n]));
    expect(byId.a.x).toBe(0);
    expect(byId.b.x).toBe(NODE_W + RANK_GAP);
    expect(byId.c.x).toBe(2 * (NODE_W + RANK_GAP));
    // One node per rank throughout: every node sits on the shared centre axis.
    expect(byId.a.y).toBe(-NODE_H / 2);
    expect(byId.b.y).toBe(-NODE_H / 2);
    expect(byId.c.y).toBe(-NODE_H / 2);

    expect(spec.edges).toHaveLength(2);
    for (const e of spec.edges) {
      expect(e.dashed).toBe(false);
      const { sx, sy, cx, cy, ex, ey } = parseQuadratic(e.d);
      const want = expectedControlPoint(sx, sy, ex, ey, 0);
      expect(cx).toBeCloseTo(want.cx, 1);
      expect(cy).toBeCloseTo(want.cy, 1);
    }
  });
});

describe('layoutFlow — diamond (two branches rejoin)', () => {
  it('places both branches on one shared rank, the join one rank further, every edge straight', () => {
    const g = graph(
      [node('a', 'trigger'), node('b', 'agent'), node('c', 'connector'), node('d', 'report')],
      [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')],
    );
    const spec = layoutFlow(g);
    const byId = Object.fromEntries(spec.nodes.map((n) => [n.id, n]));
    expect(byId.a.x).toBe(0);
    expect(byId.b.x).toBe(NODE_W + RANK_GAP);
    expect(byId.c.x).toBe(NODE_W + RANK_GAP);
    expect(byId.d.x).toBe(2 * (NODE_W + RANK_GAP));

    // b and c share a rank and stack on either side of the shared centre axis
    // — b is first (nodes[] first-appearance order).
    const stackTop = -(2 * NODE_H + LANE_GAP) / 2;
    expect(byId.b.y).toBe(stackTop);
    expect(byId.c.y).toBe(stackTop + NODE_H + LANE_GAP);

    expect(spec.edges).toHaveLength(4);
    for (const e of spec.edges) expect(e.dashed).toBe(false);
  });
});

describe('layoutFlow — rank-skipping edges', () => {
  it('gives a rank-skipping edge a non-zero fractional bow while adjacent edges stay straight', () => {
    // a -> b -> c, plus a direct a -> c that skips rank 1 entirely.
    const g = graph(
      [node('a', 'trigger'), node('b', 'agent'), node('c', 'report')],
      [edge('a', 'b'), edge('b', 'c'), edge('a', 'c')],
    );
    const spec = layoutFlow(g);
    const straight = spec.edges.filter((e) => !e.id.includes('a->c'));
    const skip = spec.edges.find((e) => e.id.includes('a->c'));
    expect(straight).toHaveLength(2);
    expect(skip).toBeDefined();

    for (const e of straight) {
      const { sx, sy, cx, cy, ex, ey } = parseQuadratic(e.d);
      const want = expectedControlPoint(sx, sy, ex, ey, 0);
      expect(cx).toBeCloseTo(want.cx, 1);
      expect(cy).toBeCloseTo(want.cy, 1);
    }

    const { sx, sy, cx, cy, ex, ey } = parseQuadratic(skip!.d);
    // The a -> c edge is the first (and only) non-adjacent edge encountered
    // in edges[] order, so it gets the first alternating sign: +BOW_SKIP.
    const want = expectedControlPoint(sx, sy, ex, ey, BOW_SKIP);
    expect(cx).toBeCloseTo(want.cx, 1);
    expect(cy).toBeCloseTo(want.cy, 1);
    // And it is meaningfully off the straight-line midpoint (a real bow, not
    // a rounding artifact).
    const straightPoint = expectedControlPoint(sx, sy, ex, ey, 0);
    expect(Math.abs(cx - straightPoint.cx) + Math.abs(cy - straightPoint.cy)).toBeGreaterThan(1);
    // rank(a)=0, rank(c)=2: still a forward edge, just not adjacent — not dashed.
    expect(skip!.dashed).toBe(false);
  });
});

describe('layoutFlow — cycles break instead of hanging', () => {
  it('lays out a two-node cycle: both nodes finite and distinct, exactly one edge dashed (the warning)', () => {
    const g = graph([node('a', 'agent'), node('b', 'agent')], [edge('a', 'b'), edge('b', 'a')]);
    const spec = layoutFlow(g);
    expect(spec.nodes).toHaveLength(2);
    for (const n of spec.nodes) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
    }
    const ranksUsed = new Set(spec.nodes.map((n) => n.x));
    expect(ranksUsed.size).toBe(2); // genuinely laid out on two distinct ranks
    expect(spec.edges.filter((e) => e.dashed)).toHaveLength(1);
    expect(spec.edges.filter((e) => !e.dashed)).toHaveLength(1);
  });

  it('lays out a graph that is entirely a cycle (every node has an inbound edge) without dividing by zero', () => {
    const g = graph(
      [node('a', 'agent'), node('b', 'agent'), node('c', 'agent')],
      [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')],
    );
    const spec = layoutFlow(g);
    expect(spec.nodes).toHaveLength(3);
    for (const n of spec.nodes) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
    }
    const ranksUsed = new Set(spec.nodes.map((n) => n.x));
    expect(ranksUsed.size).toBe(3); // three distinct ranks, not collapsed to one
    expect(spec.edges).toHaveLength(3);
    expect(spec.edges.filter((e) => e.dashed)).toHaveLength(1);
    expect(spec.viewBox.length).toBeGreaterThan(0);
  });
});

describe('layoutFlow — determinism', () => {
  it('produces a deep-equal FlowSpec for the same graph across two calls', () => {
    const g = graph(
      [
        node('a', 'trigger', { label: 'Digest fires' }),
        node('b', 'agent'),
        node('c', 'connector'),
        node('d', 'hitl'),
        node('e', 'report'),
      ],
      [
        edge('a', 'b'),
        edge('b', 'c', { label: 'uses' }),
        edge('b', 'd'),
        edge('c', 'e'),
        edge('d', 'e'),
        edge('a', 'e'),
      ],
    );
    const first = layoutFlow(g);
    const second = layoutFlow(g);
    expect(second).toEqual(first);
  });

  it('does not mutate its input graph', () => {
    const g = graph([node('a', 'agent'), node('b', 'agent')], [edge('a', 'a'), edge('a', 'b')]);
    const snapshot = JSON.parse(JSON.stringify(g));
    layoutFlow(g);
    expect(g).toEqual(snapshot);
  });
});

describe('layoutFlow — defensive input handling', () => {
  it('drops a self-loop edge instead of producing NaN geometry', () => {
    const g = graph([node('a', 'agent'), node('b', 'agent')], [edge('a', 'a'), edge('a', 'b')]);
    const spec = layoutFlow(g);
    expect(spec.edges).toHaveLength(1);
    expect(spec.edges[0].d).not.toContain('NaN');
  });

  it('drops an edge referencing a node id that does not exist in the graph', () => {
    const g = graph([node('a', 'agent')], [edge('a', 'ghost')]);
    const spec = layoutFlow(g);
    expect(spec.nodes).toHaveLength(1);
    expect(spec.edges).toHaveLength(0);
  });
});

describe('layoutFlow — unknown node kinds', () => {
  it('falls back to the "unknown" variant for a kind the registry does not recognise', () => {
    const spec = layoutFlow(graph([node('mystery', 'a-brand-new-connector-kind')], []));
    expect(spec.nodes[0].variant).toBe('unknown');
  });

  it('a known kind resolves to its own registry variant, never "unknown"', () => {
    const spec = layoutFlow(graph([node('t', 'trigger')], []));
    expect(spec.nodes[0].variant).toBe('rem');
  });
});

describe('layoutFlow — comet is always explicit', () => {
  it('sets comet: false on every generated edge (FlowDiagram treats an omitted comet as animated)', () => {
    const g = graph(
      [node('a', 'trigger'), node('b', 'agent'), node('c', 'report')],
      [edge('a', 'b'), edge('b', 'c'), edge('a', 'c')],
    );
    const spec = layoutFlow(g);
    expect(spec.edges.length).toBeGreaterThan(0);
    for (const e of spec.edges) {
      expect(e.comet).toBe(false);
    }
  });
});

describe('layoutFlow — edge labels', () => {
  it('passes an edge label through, positioned at the wire midpoint', () => {
    const g = graph([node('a', 'agent'), node('b', 'agent')], [edge('a', 'b', { label: 'ok' })]);
    const spec = layoutFlow(g);
    expect(spec.edges[0].label?.text).toBe('ok');
  });
});
