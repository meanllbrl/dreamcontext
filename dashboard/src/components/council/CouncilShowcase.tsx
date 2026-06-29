import { useState } from 'react';
import { FlowDiagram } from '../about/FlowDiagram';
import { COUNCIL_SHOWCASE } from './councilFlowSpec';

const BANNER_DISMISSED_KEY = 'dreamcontext.dashboard.councilShowcaseDismissed';

function readDismissed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(BANNER_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * The Council "stage" — the animated round-table debate diagram framed in a
 * gradient panel, echoing the About-page faculty spotlight (Image: "One brain,
 * many faculties"). Used full-size as the centrepiece of the empty state.
 */
export function CouncilShowcase() {
  return (
    <div className="council-stage">
      <span className="council-stage-tag">Agents · Lab</span>
      <FlowDiagram spec={COUNCIL_SHOWCASE} className="council-stage-flow" />
    </div>
  );
}

/**
 * Compact showcase for the populated state: a slim card above the debate grid
 * that pairs a short "how it works" blurb with a mini round-table diagram, so the
 * page still teaches what Council does without burying the list. Dismissible —
 * the choice persists per machine so power users with many debates can hide it.
 */
export function CouncilBanner() {
  const [dismissed, setDismissed] = useState<boolean>(readDismissed);

  if (dismissed) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      window.localStorage.setItem(BANNER_DISMISSED_KEY, '1');
    } catch {
      // localStorage unavailable — ignore.
    }
  };

  return (
    <div className="council-banner">
      <div className="council-banner-text">
        <p className="council-intro-kicker">How Council works</p>
        <p className="council-banner-body">
          A panel of persona sub-agents debates your decision across rounds, sees each
          other’s reasoning, then a synthesizer writes one traceable verdict.
        </p>
      </div>
      <div className="council-banner-flow">
        <FlowDiagram spec={COUNCIL_SHOWCASE} size="mini" />
      </div>
      <button
        type="button"
        className="council-banner-close"
        onClick={dismiss}
        aria-label="Hide explainer"
        title="Hide explainer"
      >
        ✕
      </button>
    </div>
  );
}
