import type { JSX } from 'react';
import type { FlowGraph } from '../../../../src/lib/automations/types.js';
import { layoutFlow } from './flowLayout';
import { FlowDiagram, type FlowDiagramProps } from '../about/FlowDiagram';

export interface AutomationFlowCanvasProps {
  /**
   * The manifest's parsed `## Flow` graph. Typed as `layoutFlow`'s own input
   * (`FlowGraph`, `src/lib/automations/types.ts`) rather than
   * `useAutomations.ts`'s dashboard-side mirror (`AutomationFlowGraph`) — the
   * two are structurally identical field-for-field (same `version` literal,
   * same `nodes[]`/`edges[]` shapes), so either passes to the other with no
   * cast. `FlowGraph` is the choice because it is the one already pinned by
   * this task's frozen dependencies (T5's registry, T14's `layoutFlow`);
   * `AutomationFlowGraph` lives in a hook file another lane is editing
   * concurrently this wave and is not a dependency of this task.
   */
  graph: FlowGraph;
  className?: string;
  /** Forwarded to `FlowDiagram` untouched — this component has no opinion of
   *  its own on sizing. Omit to get `FlowDiagram`'s own default (`'full'`). */
  size?: FlowDiagramProps['size'];
}

/**
 * The composing sibling D-F calls for. `layoutFlow` (pure graph → geometry,
 * zero DOM) produces a `FlowSpec`; `FlowDiagram` (pure geometry → SVG, zero
 * graph algorithms) renders it. Neither owns the other's job, and this
 * component doesn't either — it is only the seam between them, plus the one
 * thing neither half can honestly say on its own: what an automation with no
 * flow graph yet looks like. An empty `FlowSpec` would still be a valid,
 * renderable SVG (a bare viewBox with nothing in it), which would look like a
 * rendering bug rather than the true state ("this manifest has no `## Flow`
 * block, or it lays out with a truthy-but-empty graph") — so that case gets
 * an explicit, honest message instead of an empty box.
 */
export function AutomationFlowCanvas({ graph, className, size }: AutomationFlowCanvasProps): JSX.Element {
  if (graph.nodes.length === 0) {
    return (
      <div
        className={`automation-flow-canvas-empty${className ? ` ${className}` : ''}`}
        role="status"
        style={{
          padding: 'var(--space-6)',
          textAlign: 'center',
          fontSize: 'var(--font-size-sm)',
          color: 'var(--color-text-tertiary)',
          border: '1px dashed var(--color-border)',
          borderRadius: 'var(--radius-lg)',
        }}
      >
        This automation has no flow graph yet.
      </div>
    );
  }

  const spec = layoutFlow(graph);
  return <FlowDiagram spec={spec} className={className} size={size} />;
}
