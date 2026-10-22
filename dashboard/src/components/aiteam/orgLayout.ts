import { chainOf, descendantsOf, type TeamTree } from '../../../../src/lib/agents/tree.js';

/**
 * WHERE EVERY CARD OF THE ORG CHART GOES. Pure: the tree in, boxes and lines out, so the chart
 * is placed the same way every render and the placement is unit-tested.
 *
 * Two shapes, picked per node:
 *  - a lead whose reports have nobody under them is a TEAM FRAME: its card on top, its reports
 *    stacked under it in one column, the whole team in a labelled frame (the team's name and
 *    how many it holds). A team reads as one block, and a team of eight stays one column wide.
 *  - any other node with reports spreads them side by side under it, joined by an elbow line.
 * Roots sit side by side under "You". Lines from a parent to a child on the selected teammate's
 * chain are marked `onPath`.
 *
 * A row is PACKED: a teammate with nobody under it takes only its card's width, and may sit
 * above a neighbour's wide team (rows below are the neighbour's alone), so a lead with a wide
 * team does not push its lone siblings out to the sides.
 */

export const ORG = {
  cardW: 200,
  cardH: 92,
  /** Gap between side-by-side subtrees. */
  gapX: 16,
  /** Gap between a parent's row and its children's row. */
  gapY: 40,
  /** Gap between stacked cards inside a frame. */
  stackGap: 10,
  framePad: 10,
  frameHead: 30,
  /** How far a report sits right of its lead inside a frame. */
  stackIndent: 14,
  youW: 132,
  youH: 34,
} as const;

export interface OrgBox { x: number; y: number; w: number; h: number }
export interface OrgCard extends OrgBox { slug: string }
export interface OrgFrame extends OrgBox { lead: string; label: string; count: number; onPath: boolean }
export interface OrgEdge { from: string; to: string; points: [number, number][]; onPath: boolean }
export interface OrgLayout {
  width: number;
  height: number;
  you: OrgBox;
  cards: OrgCard[];
  frames: OrgFrame[];
  edges: OrgEdge[];
}

/** Is `slug` drawn as a team frame (it has reports, and none of them has reports)? */
export function isTeamFrame(tree: TeamTree, slug: string): boolean {
  const n = tree.nodes.get(slug);
  if (!n || n.children.length === 0) return false;
  return n.children.every((c) => (tree.nodes.get(c)?.children.length ?? 0) === 0);
}

interface Measured { w: number; h: number }

export function layoutOrgChart(
  tree: TeamTree,
  opts: { selected?: string | null; titleOf?: (slug: string) => string } = {},
): OrgLayout {
  const titleOf = opts.titleOf ?? ((s: string) => s);
  const onPath = new Set(opts.selected ? chainOf(tree, opts.selected) : []);
  const size = new Map<string, Measured>();

  const frameSize = (slug: string): Measured => {
    const n = descendantsOf(tree, slug).length;
    return {
      w: ORG.cardW + ORG.stackIndent + ORG.framePad * 2,
      h: ORG.frameHead + (n + 1) * ORG.cardH + n * ORG.stackGap + ORG.framePad,
    };
  };
  const measure = (slug: string): Measured => {
    const cached = size.get(slug);
    if (cached) return cached;
    const n = tree.nodes.get(slug)!;
    let m: Measured;
    if (isTeamFrame(tree, slug)) m = frameSize(slug);
    else if (n.children.length === 0) m = { w: ORG.cardW, h: ORG.cardH };
    else {
      const row = packRow(n.children);
      m = { w: Math.max(ORG.cardW, row.width), h: ORG.cardH + ORG.gapY + Math.max(...n.children.map((c) => measure(c).h)) };
    }
    size.set(slug, m);
    return m;
  };

  /**
   * Siblings on one row, left to right in their order: each one's card x and, for one with
   * reports, where its block (its whole subtree) starts. A card never overlaps a card; a block
   * never overlaps a block; a lone card may sit over a neighbour's block.
   */
  const packRow = (slugs: readonly string[]): { width: number; items: { slug: string; cardX: number; blockX: number }[] } => {
    let cardEnd = -ORG.gapX;
    let blockEnd = -ORG.gapX;
    const items = slugs.map((slug) => {
      const m = measure(slug);
      const leaf = (tree.nodes.get(slug)?.children.length ?? 0) === 0;
      if (leaf) {
        const cardX = cardEnd + ORG.gapX;
        cardEnd = cardX + m.w;
        return { slug, cardX, blockX: cardX };
      }
      if (isTeamFrame(tree, slug)) {
        // A frame fills its card row too: one solid block.
        const blockX = Math.max(cardEnd, blockEnd) + ORG.gapX;
        cardEnd = blockEnd = blockX + m.w;
        return { slug, cardX: blockX, blockX };
      }
      const inset = (m.w - ORG.cardW) / 2;
      const blockX = Math.max(blockEnd + ORG.gapX, cardEnd + ORG.gapX - inset, 0);
      blockEnd = blockX + m.w;
      cardEnd = Math.max(cardEnd, blockX + inset + ORG.cardW);
      return { slug, cardX: blockX + inset, blockX };
    });
    return { width: Math.max(cardEnd, blockEnd, 0), items };
  };

  const cards: OrgCard[] = [];
  const frames: OrgFrame[] = [];
  const edges: OrgEdge[] = [];

  /** Places `slug`'s block with its top-left at (x, y); returns where its top edge is entered. */
  const place = (slug: string, x: number, y: number): { cx: number; top: number } => {
    const n = tree.nodes.get(slug)!;
    const m = measure(slug);
    if (isTeamFrame(tree, slug)) {
      const inTeam = [slug, ...descendantsOf(tree, slug)];
      frames.push({
        x, y, w: m.w, h: m.h, lead: slug,
        label: n.team ?? titleOf(slug),
        count: inTeam.length,
        onPath: inTeam.some((s) => onPath.has(s)),
      });
      let cy = y + ORG.frameHead;
      inTeam.forEach((s, i) => {
        cards.push({ slug: s, x: x + ORG.framePad + (i === 0 ? 0 : ORG.stackIndent), y: cy, w: ORG.cardW, h: ORG.cardH });
        cy += ORG.cardH + ORG.stackGap;
      });
      // The lead's line runs down the frame's left, with a short arm into each report.
      const lx = x + ORG.framePad + ORG.stackIndent / 2;
      for (let i = 1; i < inTeam.length; i++) {
        const ry = y + ORG.frameHead + i * (ORG.cardH + ORG.stackGap) + ORG.cardH / 2;
        edges.push({
          from: slug,
          to: inTeam[i],
          points: [[lx, y + ORG.frameHead + ORG.cardH], [lx, ry], [lx + ORG.stackIndent / 2, ry]],
          onPath: onPath.has(slug) && onPath.has(inTeam[i]),
        });
      }
      return { cx: x + m.w / 2, top: y };
    }
    const cx = x + m.w / 2;
    cards.push({ slug, x: cx - ORG.cardW / 2, y, w: ORG.cardW, h: ORG.cardH });
    if (n.children.length > 0) {
      const row = packRow(n.children);
      const x0 = x + (m.w - row.width) / 2;
      const ky = y + ORG.cardH + ORG.gapY;
      const busY = y + ORG.cardH + ORG.gapY / 2;
      for (const it of row.items) {
        const at = place(it.slug, x0 + it.blockX, ky);
        edges.push({
          from: slug,
          to: it.slug,
          points: [[cx, y + ORG.cardH], [cx, busY], [at.cx, busY], [at.cx, at.top]],
          onPath: onPath.has(slug) && onPath.has(it.slug),
        });
      }
    }
    return { cx, top: y };
  };

  const row = packRow(tree.roots);
  const width = Math.max(row.width, ORG.youW);
  const you: OrgBox = { x: width / 2 - ORG.youW / 2, y: 0, w: ORG.youW, h: ORG.youH };
  const rootY = ORG.youH + ORG.gapY;
  const busY = ORG.youH + ORG.gapY / 2;
  const x0 = (width - row.width) / 2;
  for (const it of row.items) {
    const at = place(it.slug, x0 + it.blockX, rootY);
    edges.push({
      from: '',
      to: it.slug,
      points: [[width / 2, ORG.youH], [width / 2, busY], [at.cx, busY], [at.cx, at.top]],
      onPath: onPath.has(it.slug),
    });
  }
  const height = Math.max(ORG.youH, ...cards.map((c) => c.y + c.h), ...frames.map((f) => f.y + f.h));
  return { width, height, you, cards, frames, edges };
}

/** An edge as an SVG path: straight runs with small rounded corners. */
export function edgePath(points: readonly [number, number][], r = 6): string {
  if (points.length === 0) return '';
  let d = `M ${points[0][0]} ${points[0][1]}`;
  for (let i = 1; i < points.length; i++) {
    const [x, y] = points[i];
    const next = points[i + 1];
    if (!next) { d += ` L ${x} ${y}`; break; }
    const [px, py] = points[i - 1];
    const inLen = Math.hypot(x - px, y - py);
    const outLen = Math.hypot(next[0] - x, next[1] - y);
    const rr = Math.min(r, inLen / 2, outLen / 2);
    if (rr < 0.5) { d += ` L ${x} ${y}`; continue; }
    const ax = x - ((x - px) / inLen) * rr;
    const ay = y - ((y - py) / inLen) * rr;
    const bx = x + ((next[0] - x) / outLen) * rr;
    const by = y + ((next[1] - y) / outLen) * rr;
    d += ` L ${ax} ${ay} Q ${x} ${y} ${bx} ${by}`;
  }
  return d;
}
