import type { FlowGraph, FlowGraphEdge, FlowGraphNode } from '../../../../src/lib/automations/types.js';
import { nodeEntry } from '../../../../src/lib/automations/flow-registry.js';
import type { FlowSpec, FlowNode, FlowEdge, FlowNodeVariant } from '../about/FlowDiagram';
import { makeLink, type Box } from '../about/flow-geometry';

/**
 * Pure `manifest graph → FlowSpec` layout engine — deterministic layered
 * ("Sugiyama-lite") placement with no library and no DOM. Given the same
 * {@link FlowGraph}, {@link layoutFlow} always returns a byte-identical
 * {@link FlowSpec}: that purity is what makes it unit-testable without a
 * browser, and what will let `scripts/verify/automations.mjs` assert on
 * rendered node positions later.
 *
 * `AutomationFlowCanvas.tsx` (a sibling, different lane) is the only caller —
 * it composes the existing {@link FlowDiagram} renderer with the spec this
 * module produces rather than forking or extending that renderer.
 *
 * Reconciling the two type families is the actual work here:
 * {@link FlowGraph}/{@link FlowGraphNode}/{@link FlowGraphEdge} (the manifest's
 * `## Flow` shape, `src/lib/automations/types.ts`) describe WHAT the graph is;
 * {@link FlowSpec}/{@link FlowNode}/{@link FlowEdge} ({@link FlowDiagram}'s own
 * shape) describe WHERE it is drawn. They do not line up on their own:
 * `FlowGraphNode` is top-left `x/y`-free (no geometry at all) while `FlowNode`
 * needs a rectangle, and {@link makeLink} — the shared wire-drawing helper
 * every other `FlowSpec` producer in this codebase already uses — wants
 * CENTRE-based boxes (`{cx, cy, w, h}`), not the top-left boxes `FlowNode`
 * itself carries. This module builds both.
 */

// ─── Placement geometry — module constants, never inline literals. All
// 4-divisible per the `design` skill's 4px grid law. ───────────────────────
/**
 * Every automation node draws with a glyph (the registry always supplies one),
 * and `FlowDiagram`'s glyph layout stacks three rows inside the box — glyph at
 * `y + 26`, title at the centre, caption at `y + h - 16`. At the original
 * `NODE_H = 56` those three rows landed on top of each other; 96 is the height
 * that layout was designed against (the About page's own glyph nodes are 92)
 * and gives a wrapped two-line title room to sit between glyph and caption.
 * Width buys those titles — a schedule phrase, an automation name, an output
 * path, all user data — more characters per line, paid for out of `RANK_GAP`
 * so the diagram's total width (and so its on-screen text size, since the SVG
 * scales to its container) stays where it was.
 */
export const NODE_W = 200;
export const NODE_H = 104;
export const RANK_GAP = 56;
export const LANE_GAP = 24;
/** Added on every side of the placed extents to compute the viewBox. */
export const MARGIN = 16;
/** Fractional bow (see {@link makeLink}) applied, alternating sign, to any
 *  edge that is not a plain one-rank-forward step — see {@link toFlowEdges}. */
export const BOW_SKIP = 0.12;

/** The `FlowSpec` for a graph with zero nodes — computed from {@link MARGIN}
 *  alone so it never drifts from the general placement math's margin. */
const EMPTY_VIEWBOX = `${-MARGIN} ${-MARGIN} ${MARGIN * 2} ${MARGIN * 2}`;

/**
 * The rank (layer) of every node: 0 for a node with no inbound edge, else
 * 1 + the max rank among its predecessors — computed by DFS with a
 * "currently resolving" set, the standard, provably-correct way to assign
 * exactly this recursive definition when the graph may contain cycles.
 *
 * An edge whose source is still mid-resolution when a node examines it (i.e.
 * an ancestor of the current call — which can only happen if the graph loops
 * back through it) is a back edge: it is excluded from the max, so the node
 * it would have inflated settles on its rank from its other predecessors (or
 * 0, if that was its only one). That exclusion is exactly why every edge NOT
 * excluded ends with `rank(to) > rank(from)`: whichever predecessor's rank
 * fed the max was itself already fully resolved before use, so the +1 always
 * lands strictly higher. A genuine cycle-closing edge is therefore always
 * identifiable AFTER the fact as `rank(to) <= rank(from)` — see
 * {@link toFlowEdges}, which uses exactly that to decide `dashed` without any
 * separate bookkeeping of which edges were skipped.
 *
 * Traversal is `nodes[]` array order at the top level and `edges[]` array
 * order within each node's predecessor list (via `predsOf`, built in that
 * order) — both are the deterministic tie-break the algorithm calls for. A
 * graph that is entirely a cycle still resolves: the first node visited
 * simply settles at rank 0 or above once its own back edge is excluded, and
 * every other node chains forward from there — see the cycle test cases.
 */
function computeRanks(nodes: readonly FlowGraphNode[], predsOf: ReadonlyMap<string, FlowGraphEdge[]>): Map<string, number> {
  const rank = new Map<string, number>();
  const resolving = new Set<string>();

  function resolve(id: string): number {
    const known = rank.get(id);
    if (known !== undefined) return known;
    resolving.add(id);
    let maxPredRank = -1;
    for (const edge of predsOf.get(id) ?? []) {
      if (resolving.has(edge.from)) continue; // back edge — breaks a cycle
      const predRank = resolve(edge.from);
      if (predRank > maxPredRank) maxPredRank = predRank;
    }
    resolving.delete(id);
    const r = maxPredRank + 1;
    rank.set(id, r);
    return r;
  }

  for (const node of nodes) resolve(node.id);
  return rank;
}

/** Edges dropped before layout: a dangling reference (mirrors the store's own
 *  lenient read — "a dangling reference drops the edge, never a throw") and a
 *  self-loop, which {@link makeLink}'s `rectEdge` cannot express (a box aimed
 *  at its own centre divides by zero and produces `NaN` coordinates). Both
 *  are defensive boundary checks: `layoutFlow` must not assume every caller's
 *  graph was built by the store's own strict write path. */
function selectValidEdges(edges: readonly FlowGraphEdge[], nodeIds: ReadonlySet<string>): FlowGraphEdge[] {
  return edges.filter((e) => e.from !== e.to && nodeIds.has(e.from) && nodeIds.has(e.to));
}

/** Groups edges by target id, preserving `edges[]` array order within each
 *  group — the deterministic predecessor order {@link computeRanks} walks. */
function groupByTarget(edges: readonly FlowGraphEdge[]): Map<string, FlowGraphEdge[]> {
  const map = new Map<string, FlowGraphEdge[]>();
  for (const edge of edges) {
    const list = map.get(edge.to);
    if (list) list.push(edge);
    else map.set(edge.to, [edge]);
  }
  return map;
}

/** Groups nodes by rank, preserving `nodes[]` first-appearance order within
 *  each rank — step 2 of the algorithm ("order within rank"), deliberately
 *  with no barycentre iteration: these graphs are small, and iterating would
 *  make identical data render differently between passes. */
function groupByRank(nodes: readonly FlowGraphNode[], rank: ReadonlyMap<string, number>): Map<number, FlowGraphNode[]> {
  const byRank = new Map<number, FlowGraphNode[]>();
  for (const node of nodes) {
    const r = rank.get(node.id) ?? 0;
    const list = byRank.get(r);
    if (list) list.push(node);
    else byRank.set(r, [node]);
  }
  return byRank;
}

interface PlacedNode {
  node: FlowGraphNode;
  x: number;
  y: number;
}

/**
 * Left to right by rank (`x = rank * (NODE_W + RANK_GAP)`), each rank's stack
 * vertically centred on one shared y = 0 axis shared by every rank — a rank
 * with more nodes simply extends further up and down from that same centre
 * line than a sparser one, which is what keeps the whole diagram visually
 * balanced instead of each column centring on its own, different midpoint.
 *
 * `NODE_H` and `LANE_GAP` are both even, so every stack's height (and hence
 * its half-height offset) is always a whole number — no fractional pixels.
 */
function placeNodes(byRank: ReadonlyMap<number, FlowGraphNode[]>): PlacedNode[] {
  const placed: PlacedNode[] = [];
  const ranks = [...byRank.keys()].sort((a, b) => a - b);
  for (const r of ranks) {
    const atRank = byRank.get(r) ?? [];
    const blockH = atRank.length * NODE_H + (atRank.length - 1) * LANE_GAP;
    const top = -blockH / 2;
    atRank.forEach((node, i) => {
      placed.push({ node, x: r * (NODE_W + RANK_GAP), y: top + i * (NODE_H + LANE_GAP) });
    });
  }
  return placed;
}

/**
 * One placed node's `FlowNode`. `variant`/`glyph` come straight from the
 * registry (`nodeEntry`, `src/lib/automations/flow-registry.ts`) — the ONE
 * place a node kind maps to how it draws — never a second mapping here.
 *
 * `variant: entry.variant as FlowNodeVariant` — the cast is deliberate and
 * safe: `nodeEntry` only ever returns one of the strings the registry itself
 * defines, `'unknown'` (`UNKNOWN_NODE_ENTRY`, for a kind this build does not
 * recognise) included. `'unknown'` is not yet a member of `FlowDiagram`'s
 * `FlowNodeVariant` union — that union gains it, and `FlowDiagram.css` gains
 * the matching rect rule, in T16 (next wave). Until then this cast is what
 * lets an unrecognised node kind render (with whatever fallback styling an
 * unmatched CSS class produces) instead of failing this module to compile.
 */
function toFlowNode(placed: PlacedNode): FlowNode {
  const entry = nodeEntry(placed.node.kind);
  const label = placed.node.label?.trim();
  const flowNode: FlowNode = {
    id: placed.node.id,
    x: placed.x,
    y: placed.y,
    w: NODE_W,
    h: NODE_H,
    title: label || placed.node.kind,
    variant: entry.variant as FlowNodeVariant,
    glyph: entry.glyph,
  };
  // Only add a caption when it says something `title` doesn't already: a
  // custom label is the title, so the caption below it is the underlying
  // kind; with no label, `title` already IS the kind and a caption would
  // just repeat it.
  if (label) flowNode.sub = placed.node.kind;
  return flowNode;
}

/** Centre-based boxes keyed by node id — the shape {@link makeLink} needs
 *  (`Record<string, Box>`, `Box = {cx, cy, w, h}`), built from the same
 *  top-left placement {@link toFlowNode} uses for `FlowNode.x/y`. */
function toCentreBoxes(placed: readonly PlacedNode[]): Record<string, Box> {
  const boxes: Record<string, Box> = {};
  for (const p of placed) {
    boxes[p.node.id] = { cx: p.x + NODE_W / 2, cy: p.y + NODE_H / 2, w: NODE_W, h: NODE_H };
  }
  return boxes;
}

/**
 * One graph edge's `FlowEdge`. Every field here follows a corrected reading
 * of the plan (see the module doc and this file's task):
 *
 * - `comet: false` is EXPLICIT on every edge. `FlowDiagram` treats `comet` as
 *   opt-OUT (`edge.comet !== false`), so an omitted field would silently
 *   animate every generated wire.
 * - `bow` is a FRACTION of edge length, not a pixel offset. `0` for a plain
 *   one-rank forward step; `±BOW_SKIP` alternating for everything else — a
 *   rank-skipping edge (so parallel long edges separate), and equally a
 *   cycle-closing edge (`rank(to) <= rank(from)`, see {@link computeRanks}),
 *   which without a bow would otherwise draw as a straight line doubling back
 *   through whatever sits between its endpoints.
 * - `dashed` marks exactly the cycle-closing edges — the plan's "recorded in
 *   warnings, rendered dashed". `FlowSpec` has no separate warnings channel
 *   (`layoutFlow`'s contract returns only a `FlowSpec`), so `dashed` on the
 *   returned edge IS the observable record of the cycle break.
 */
function toFlowEdges(edges: readonly FlowGraphEdge[], rank: ReadonlyMap<string, number>, boxes: Record<string, Box>): FlowEdge[] {
  const link = makeLink(boxes);
  let skipParity = 0;
  return edges.map((edge, i) => {
    const rf = rank.get(edge.from) ?? 0;
    const rt = rank.get(edge.to) ?? 0;
    const straight = rt - rf === 1;
    let bow = 0;
    if (!straight) {
      bow = skipParity % 2 === 0 ? BOW_SKIP : -BOW_SKIP;
      skipParity++;
    }
    const flowEdge: FlowEdge = {
      id: `e${i}:${edge.from}->${edge.to}`,
      d: link(edge.from, edge.to, bow),
      comet: false,
      arrow: true,
      dashed: rt <= rf,
    };
    if (edge.label) {
      const from = boxes[edge.from];
      const to = boxes[edge.to];
      flowEdge.label = { text: edge.label, x: (from.cx + to.cx) / 2, y: (from.cy + to.cy) / 2 - 4 };
    }
    return flowEdge;
  });
}

/** Bounding viewBox over every placed node, plus {@link MARGIN} on each side. */
function computeViewBox(placed: readonly PlacedNode[]): string {
  const minX = Math.min(...placed.map((p) => p.x));
  const minY = Math.min(...placed.map((p) => p.y));
  const maxX = Math.max(...placed.map((p) => p.x + NODE_W));
  const maxY = Math.max(...placed.map((p) => p.y + NODE_H));
  const x = minX - MARGIN;
  const y = minY - MARGIN;
  const w = maxX - minX + MARGIN * 2;
  const h = maxY - minY + MARGIN * 2;
  return `${x} ${y} ${w} ${h}`;
}

/** A short, accessible summary of the whole graph for `FlowSpec.ariaLabel`
 *  (rendered as `role="img" aria-label={...}` by `FlowDiagram`) — reuses the
 *  registry's own `describe()` per node rather than inventing new prose. */
function buildAriaLabel(nodes: readonly FlowGraphNode[]): string {
  if (nodes.length === 0) return 'Automation flow diagram with no nodes.';
  const described = nodes.map((n) => nodeEntry(n.kind).describe(n));
  return `Automation flow diagram: ${described.join(', ')}.`;
}

/**
 * Lay out a manifest's `## Flow` graph as a `FlowSpec` — pure, deterministic,
 * zero DOM, no side effects. See the module doc for the algorithm.
 */
export function layoutFlow(graph: FlowGraph): FlowSpec {
  if (graph.nodes.length === 0) {
    return { viewBox: EMPTY_VIEWBOX, nodes: [], edges: [], ariaLabel: buildAriaLabel([]) };
  }

  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  const edges = selectValidEdges(graph.edges, nodeIds);
  const predsOf = groupByTarget(edges);
  const rank = computeRanks(graph.nodes, predsOf);
  const byRank = groupByRank(graph.nodes, rank);
  const placed = placeNodes(byRank);
  const boxes = toCentreBoxes(placed);

  return {
    viewBox: computeViewBox(placed),
    nodes: placed.map(toFlowNode),
    edges: toFlowEdges(edges, rank, boxes),
    ariaLabel: buildAriaLabel(graph.nodes),
  };
}
