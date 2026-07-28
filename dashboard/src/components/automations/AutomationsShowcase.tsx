import { FlowDiagram } from '../about/FlowDiagram';
import { AUTOMATIONS_SHOWCASE } from './automationsFlowSpec';

/**
 * The Automations "stage" — the animated cadence diagram framed in a gradient
 * panel, echoing the Council and Lab showcases so the three experimental
 * surfaces read as a set. Used full-size as the centrepiece of the empty state.
 */
export function AutomationsShowcase() {
  return (
    <div className="auto-stage">
      <span className="auto-stage-tag">Lab · Automations</span>
      <FlowDiagram spec={AUTOMATIONS_SHOWCASE} className="auto-stage-flow" />
    </div>
  );
}
