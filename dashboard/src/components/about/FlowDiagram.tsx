import { useId, type JSX } from 'react';
import './FlowDiagram.css';
import { fitTitle, TITLE_LH } from './flow-text';

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

/**
 * `'unknown'` is additive — the automations flow canvas's escape hatch for a
 * node kind this build's registry does not recognise (see
 * `src/lib/automations/flow-registry.ts`'s `UNKNOWN_NODE_ENTRY`). It renders
 * visibly unrecognised (dashed, `FlowDiagram.css`) rather than being dropped
 * or mapped onto a variant that would misrepresent it. No hand-authored About
 * page spec uses it, so this addition changes nothing about their rendering.
 */
export type FlowNodeVariant = 'hook' | 'region' | 'agent' | 'rem' | 'accent' | 'plain' | 'unknown';

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
  /**
   * Floor, in px, on the rendered width. The SVG otherwise scales to whatever
   * container it is in, which for a GENERATED spec (whose node count is data,
   * not a design decision) means a long flow shrinks its own text to
   * illegibility. Set this and the diagram scrolls horizontally instead of
   * shrinking past it. Omit — as every hand-authored spec does, each laid out
   * for the width it is shown at — for the plain scale-to-fit behaviour.
   */
  minWidth?: number;
  /**
   * Re-fit a title too wide for its node (see {@link fitTitle}) instead of
   * letting it draw through its neighbours. Same reasoning as `minWidth`: a
   * GENERATED spec's titles are user data of unknown length, where a
   * hand-authored one's were written for the box they sit in — so this is
   * off by default and every existing spec renders exactly as before.
   */
  fitTitles?: boolean;
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

export function FlowDiagram({
  spec,
  className,
  size = 'full',
  minWidth,
  fitTitles = false,
}: FlowDiagramProps): JSX.Element {
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
      className={`fd fd--${size}${minWidth ? ' fd--scroll' : ''} ${className ?? ''}`}
      role="img"
      aria-label={spec.ariaLabel}
    >
      <svg
        viewBox={spec.viewBox}
        preserveAspectRatio="xMidYMid meet"
        className="fd-svg"
        style={minWidth ? { minWidth: `${minWidth}px` } : undefined}
      >
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
          // A title too wide for its box is re-fitted (smaller, wrapped to two
          // lines, ellipsized only as a last resort) rather than drawn straight
          // through the neighbouring node. One that fits is untouched.
          const title = fitTitles
            ? fitTitle(node.title, node.w, size === 'mini' ? 15 : 17)
            : { lines: [node.title], scaled: false, truncated: false };
          const titleBlock = (title.lines.length - 1) * TITLE_LH;
          // Glyph nodes keep their fixed layout; non-glyph nodes vertically
          // center the (title + N sub lines) block so multi-line captions stay
          // balanced inside the box. Both re-center around the title block so a
          // second title line grows symmetrically instead of downward, into the
          // caption.
          const titleY =
            (node.glyph
              ? cy + 6
              : subLines.length
                ? cy - 8 - (subLines.length - 1) * (SUB_LH / 2)
                : cy) -
            titleBlock / 2;
          const subStartY = node.glyph ? node.y + node.h - 16 : titleY + titleBlock + 22;
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
              {title.truncated && <title>{node.title}</title>}
              <text x={cx} y={titleY} className={`fd-node-title${title.scaled ? ' fd-node-title--fit' : ''}`}>
                {title.lines.map((line, i) => (
                  <tspan key={i} x={cx} dy={i === 0 ? 0 : TITLE_LH}>
                    {line}
                  </tspan>
                ))}
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
