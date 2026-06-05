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
  sub?: string;
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

export function FlowDiagram({ spec, className, size = 'full' }: FlowDiagramProps): JSX.Element {
  const uid = useId();
  // useId() can include characters (":") that are illegal in SVG fragment ids,
  // so sanitize before composing url() references.
  const safe = uid.replace(/[^a-zA-Z0-9_-]/g, '');
  const nodeId = `fd-node-${safe}`;
  const accentId = `fd-accent-${safe}`;

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
          <linearGradient id={accentId} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" className="fd-accent-a" />
            <stop offset="1" className="fd-accent-b" />
          </linearGradient>
        </defs>

        {/* ── Edges (drawn first, behind nodes) ───────────────────────────── */}
        <g className="fd-wires" fill="none">
          {spec.edges.map((edge) => (
            <g key={edge.id}>
              <path
                d={edge.d}
                className={`fd-wire${edge.dashed ? ' fd-wire--dashed' : ''}`}
              />
              {edge.comet !== false && (
                <path
                  d={edge.d}
                  className="fd-flow"
                  stroke={`url(#${accentId})`}
                  style={{
                    animationDelay: `${edge.delay ?? 0}s`,
                    animationDuration: `${edge.dur ?? 2.6}s`,
                    ['--fd-travel' as string]: edge.travel ?? 240,
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
        {spec.nodes.map((node) => (
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
              <text x={node.x + node.w / 2} y={node.y + 26} className="fd-region-glyph">
                {node.glyph}
              </text>
            )}
            <text
              x={node.x + node.w / 2}
              y={node.glyph ? node.y + node.h / 2 + 6 : node.sub ? node.y + node.h / 2 - 8 : node.y + node.h / 2}
              className="fd-node-title"
            >
              {node.title}
            </text>
            {node.sub && (
              <text
                x={node.x + node.w / 2}
                y={node.glyph ? node.y + node.h - 16 : node.y + node.h / 2 + 14}
                className="fd-node-sub"
              >
                {node.sub}
              </text>
            )}
          </g>
        ))}
      </svg>
    </div>
  );
}
