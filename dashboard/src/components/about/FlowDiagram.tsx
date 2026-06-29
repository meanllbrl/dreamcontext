import { useId, type JSX } from 'react';
import './FlowDiagram.css';

/**
 * Data-driven SVG flow diagram. A generalization of the original
 * HowItWorksDiagram: instead of one hard-coded flow it renders any {@link FlowSpec}
 * — nodes, edges, comet animations, labels — so multiple distinct diagrams can be
 * authored as data (see `flow-specs.ts`) and dropped on the same page.
 *
 * Everything is pure SVG + CSS custom properties, so it always renders, scales
 * cleanly, themes via tokens (light/dark automatic), and animates without JS.
 * All motion (travelling "comet" dashes, breathing nodes) is disabled under
 * `prefers-reduced-motion: reduce`.
 *
 * BUG FIX vs. the original: gradients are now referenced through per-instance
 * ids generated with {@link useId} and applied as INLINE SVG attributes
 * (`stroke={url(#...)}`, `fill={url(#...)}`). The original referenced static
 * gradient ids from CSS, which collides when several instances live on one page
 * — the first `<defs>` wins and later diagrams lose their gradients. The CSS no
 * longer contains any `stroke: url(...)` / `fill: url(...)`.
 */

export type FlowNodeVariant = 'hook' | 'region' | 'agent' | 'rem' | 'accent' | 'plain';

export interface FlowNode {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  /** One line (string) or several stacked, centered lines (string[]). */
  sub?: string | string[];
  glyph?: string;
  variant?: FlowNodeVariant;
  breathe?: boolean;
  breatheDelay?: number;
}

export interface FlowEdge {
  id: string;
  d: string;
  comet?: boolean;
  dashed?: boolean;
  /** Draw a directional arrowhead at the path end (opt-in). */
  arrow?: boolean;
  /** Thinner, lower-contrast wire — for dense meshes where 2px reads as heavy. */
  thin?: boolean;
  delay?: number;
  dur?: number;
  travel?: number;
  label?: { text: string; x: number; y: number; rotate?: number };
}

export interface FlowSpec {
  viewBox: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  ariaLabel: string;
}

export interface FlowDiagramProps {
  spec: FlowSpec;
  className?: string;
  size?: 'full' | 'mini';
}

/**
 * Greedily wraps a caption so it fits a node's width — SVG `<text>` never wraps
 * on its own, so long subtitles would otherwise spill past the box. Breaks
 * preferentially at the " · " separators captions use, and falls back to spaces
 * for any single segment that is itself too wide. All math is in viewBox units
 * (font-size in an SVG is interpreted in user units), so it is scale-invariant.
 */
export function wrapSub(text: string, boxW: number, fontSize: number): string[] {
  const charW = fontSize * 0.6; // conservative average advance for the UI font
  const pad = fontSize; // ~1em of breathing room on each side
  const maxChars = Math.max(6, Math.floor((boxW - pad * 2) / charW));
  if (text.length <= maxChars) return [text];

  const lines: string[] = [];
  let cur = '';
  const push = (tok: string, sep: string): void => {
    const candidate = cur ? cur + sep + tok : tok;
    if (cur && candidate.length > maxChars) {
      lines.push(cur);
      cur = tok;
    } else {
      cur = candidate;
    }
  };

  text.split(' · ').forEach((seg, si) => {
    const lead = si === 0 ? '' : ' · ';
    if (seg.length <= maxChars) {
      push(seg, lead);
    } else {
      // A single segment wider than the box: break it on spaces instead.
      seg.split(' ').forEach((word, wi) => push(word, wi === 0 ? lead : ' '));
    }
  });
  if (cur) lines.push(cur);
  return lines;
}

export function FlowDiagram({ spec, className, size = 'full' }: FlowDiagramProps): JSX.Element {
  const uid = useId();
  // useId() can include characters (":") that are illegal in SVG fragment ids,
  // so sanitize before composing url() references.
  const safe = uid.replace(/[^a-zA-Z0-9_-]/g, '');
  const nodeId = `fd-node-${safe}`;
  const dotId = `fd-dot-${safe}`;
  const arrowId = `fd-arrow-${safe}`;
  const dotR = size === 'mini' ? 5 : 7;

  return (
    <div
      className={`fd fd--${size} ${className ?? ''}`}
      role="img"
      aria-label={spec.ariaLabel}
    >
      <svg viewBox={spec.viewBox} preserveAspectRatio="xMidYMid meet" className="fd-svg">
        <defs>
          <linearGradient id={nodeId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" className="fd-node-grad-a" />
            <stop offset="1" className="fd-node-grad-b" />
          </linearGradient>
          {/* Radial gradient for the travelling dot: a bright core fading to a
              transparent halo, so the "glow" is baked into the fill and needs no
              per-frame filter as the dot moves. */}
          <radialGradient id={dotId}>
            <stop offset="0" className="fd-dot-core" />
            <stop offset="0.45" className="fd-dot-mid" />
            <stop offset="1" className="fd-dot-edge" />
          </radialGradient>
          {/* Directional arrowhead, applied per-edge via marker-end when an edge
              opts in (arrow: true). orient="auto" rotates it to the path tangent. */}
          <marker
            id={arrowId}
            viewBox="0 0 10 10"
            refX="8.5"
            refY="5"
            markerWidth="6.5"
            markerHeight="6.5"
            orient="auto-start-reverse"
            markerUnits="userSpaceOnUse"
          >
            <path d="M0 1 L9 5 L0 9 z" className="fd-arrowhead" />
          </marker>
        </defs>

        {/* ── Edges (drawn first, behind nodes) ───────────────────────────── */}
        <g className="fd-wires" fill="none">
          {spec.edges.map((edge) => (
            <g key={edge.id}>
              <path
                d={edge.d}
                className={`fd-wire${edge.dashed ? ' fd-wire--dashed' : ''}${edge.thin ? ' fd-wire--thin' : ''}`}
                markerEnd={edge.arrow ? `url(#${arrowId})` : undefined}
              />
              {edge.comet !== false && (
                // A small glowing dot rides the edge via the CSS Motion Path
                // (offset-path + animated offset-distance) instead of scrolling
                // stroke-dashoffset along the whole stroke. Moving a tiny element
                // dirties a ~14px region per frame and is compositor-friendly,
                // where animating a full-length dashed stroke forced a main-thread
                // re-rasterization of the entire path every frame ("frame-by-frame"
                // stutter). The glow is the radial fill, rasterized once.
                <circle
                  cx="0"
                  cy="0"
                  r={dotR}
                  className="fd-comet-dot"
                  fill={`url(#${dotId})`}
                  style={{
                    offsetPath: `path('${edge.d}')`,
                    animationDelay: `${edge.delay ?? 0}s`,
                    animationDuration: `${edge.dur ?? 2.6}s`,
                  }}
                />
              )}
              {edge.label && (
                <text
                  x={edge.label.x}
                  y={edge.label.y}
                  className="fd-label"
                  transform={
                    edge.label.rotate !== undefined
                      ? `rotate(${edge.label.rotate} ${edge.label.x} ${edge.label.y})`
                      : undefined
                  }
                >
                  {edge.label.text}
                </text>
              )}
            </g>
          ))}
        </g>

        {/* ── Nodes ───────────────────────────────────────────────────────── */}
        {spec.nodes.map((node) => {
          const cx = node.x + node.w / 2;
          const cy = node.y + node.h / 2;
          // `sub` is auto-wrapped to fit the node width (a string[] is an
          // explicit author override, used verbatim). Glyph nodes keep a single
          // short caption on their fixed baseline.
          const subLines: string[] =
            node.sub == null
              ? []
              : Array.isArray(node.sub)
                ? node.sub
                : node.glyph
                  ? [node.sub]
                  : wrapSub(node.sub, node.w, size === 'mini' ? 10 : 12);
          const SUB_LH = 15; // sub line-height, in viewBox units
          // Glyph nodes keep their fixed single-line layout; non-glyph nodes
          // vertically center the (title + N sub lines) block so multi-line
          // captions stay balanced inside the box.
          const titleY = node.glyph
            ? cy + 6
            : subLines.length
              ? cy - 8 - (subLines.length - 1) * (SUB_LH / 2)
              : cy;
          const subStartY = node.glyph ? node.y + node.h - 16 : titleY + 22;
          return (
            <g
              key={node.id}
              className={`fd-node fd-node--${node.variant ?? 'plain'}${
                node.breathe ? ' fd-node--breathe' : ''
              }`}
            >
              <rect
                x={node.x}
                y={node.y}
                width={node.w}
                height={node.h}
                rx="14"
                fill={`url(#${nodeId})`}
                style={
                  node.breathe && node.breatheDelay !== undefined
                    ? { animationDelay: `${node.breatheDelay}s` }
                    : undefined
                }
              />
              {node.glyph && (
                <text x={cx} y={node.y + 26} className="fd-region-glyph">
                  {node.glyph}
                </text>
              )}
              <text x={cx} y={titleY} className="fd-node-title">
                {node.title}
              </text>
              {subLines.length > 0 && (
                <text x={cx} y={subStartY} className="fd-node-sub">
                  {subLines.map((line, i) => (
                    <tspan key={i} x={cx} dy={i === 0 ? 0 : SUB_LH}>
                      {line}
                    </tspan>
                  ))}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
