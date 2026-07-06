/**
 * Shared wiring geometry for {@link FlowDiagram} specs. Spec files (council, lab)
 * author their nodes as boxes and draw the connecting wires with `makeLink`:
 * each wire leaves the source box's edge, lands an arrowhead just off the target
 * box's edge, and can bow to one side so parallel wires fan out (or, with a shared
 * handedness, swirl around a centre). Extracted from councilFlowSpec so the magic
 * pads that encode the engine's arrowhead clearance live in exactly one place.
 */

export type Box = { cx: number; cy: number; w: number; h: number };

// Wire endpoints sit exactly ON the node boundary (+pad): 3 viewBox units out for
// the tail, 9 for the head so FlowDiagram's arrowhead marker clears the box.
const TAIL_PAD = 3;
const HEAD_PAD = 9;

/**
 * The point on a node's (padded) rectangle boundary in the direction of another
 * point — so wires start/end exactly at the node edge, never under it or adrift.
 */
export function rectEdge(box: Box, towardX: number, towardY: number, pad: number): [number, number] {
  const hx = box.w / 2 + pad;
  const hy = box.h / 2 + pad;
  const ux = towardX - box.cx;
  const uy = towardY - box.cy;
  const sx = ux !== 0 ? hx / Math.abs(ux) : Infinity;
  const sy = uy !== 0 ? hy / Math.abs(uy) : Infinity;
  const s = Math.min(sx, sy);
  return [box.cx + ux * s, box.cy + uy * s];
}

/**
 * A path factory over a spec's node map. The returned `link(a, b, bow)` draws a
 * directed wire A→B: edge-to-edge with arrowhead clearance, bowed `bow`×length
 * to one side (positive = left of travel; 0 = straight).
 */
export function makeLink(nodes: Record<string, Box>) {
  return function link(a: string, b: string, bow = 0): string {
    const A = nodes[a];
    const B = nodes[b];
    const [sx, sy] = rectEdge(A, B.cx, B.cy, TAIL_PAD);
    const [ex, ey] = rectEdge(B, A.cx, A.cy, HEAD_PAD);
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
  };
}
