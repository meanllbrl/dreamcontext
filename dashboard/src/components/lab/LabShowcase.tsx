import { FlowDiagram } from '../about/FlowDiagram';
import { LAB_SHOWCASE } from './labFlowSpec';

/**
 * The Lab "stage" — the animated insight-pipeline diagram framed in a gradient
 * panel, echoing the Council showcase so the two experimental surfaces read as a
 * pair. Used full-size as the centrepiece of the empty state.
 */
export function LabShowcase() {
  return (
    <div className="lab-stage">
      <span className="lab-stage-tag">Insights</span>
      <FlowDiagram spec={LAB_SHOWCASE} className="lab-stage-flow" />
    </div>
  );
}
