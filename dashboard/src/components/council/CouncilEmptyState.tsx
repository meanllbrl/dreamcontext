import { BrandMark } from '../brand/BrandMark';
import { CouncilShowcase } from './CouncilShowcase';

interface Props {
  onNew: () => void;
}

/**
 * Council's zero-state. With no debates to list, the search/filter chrome would
 * be noise — so the Hall hides it and shows this instead: a compact "What is
 * Council?" explainer (brand mark + kicker + heading + the 01/02/03 step cards,
 * same language as the landing page) ending in the single action that matters,
 * "Start your first debate", which opens the Lab create flow.
 */
export function CouncilEmptyState({ onNew }: Props) {
  return (
    <div className="council-intro">
      <div className="council-intro-mark">
        <BrandMark size={40} glow />
      </div>

      <p className="council-intro-kicker">Lab · Council</p>
      <h2 className="council-intro-title">
        Put your hardest decisions to a <span>council</span>.
      </h2>
      <p className="council-intro-lead">
        When one perspective isn’t enough, Council convenes a panel of AI personas to
        debate the question across rounds, expose each other’s reasoning, and synthesize a
        verdict you can trace back to who argued what.
      </p>

      <CouncilShowcase />

      <button type="button" className="council-new-btn council-intro-cta" onClick={onNew}>
        <span aria-hidden>＋</span> Start your first debate
      </button>
      <p className="council-intro-foot">
        Council is experimental. Debates are convened from Claude today — this page is where
        you read them back.
      </p>
    </div>
  );
}
