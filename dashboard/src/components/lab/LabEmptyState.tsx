import { BrandMark } from '../brand/BrandMark';
import { LabShowcase } from './LabShowcase';

/**
 * Lab's zero-state. With no insights to list, the "Lab" title and Sync-all chrome
 * would be noise — so the board hides them and shows this instead: a compact "What
 * is Insights?" explainer (brand mark + kicker + heading + the animated pipeline
 * stage) that teaches what the page is for, ending in the one thing a user can do
 * about it — scaffold their first insight from the CLI.
 */
export function LabEmptyState() {
  return (
    <div className="lab-intro">
      <div className="lab-intro-mark">
        <BrandMark size={40} glow />
      </div>

      <p className="lab-intro-kicker">Insights</p>
      <h2 className="lab-intro-title">
        The metrics that matter, <span>live in the brain</span>.
      </h2>
      <p className="lab-intro-lead">
        Insights are curated analytics — WAU, conversion, revenue — pulled from PostHog,
        Stripe, any HTTP API, or your own script. One sync rolls the raw data into a capped
        series, caches it here, and feeds it to every agent’s session snapshot and your
        bound roadmap Key Results. Not a BI tool — a metrics-delivery layer for agents.
      </p>

      <LabShowcase />

      <p className="lab-intro-scaffold">
        Scaffold your first insight from the CLI:
      </p>
      <code className="lab-intro-cmd">
        dreamcontext lab create &lt;slug&gt; --title "Weekly Active Users" --render number --adapter http
      </code>
      <p className="lab-intro-foot">
        Insights is experimental. Sources sync on demand (TTL-gated); credentials stay
        gitignored and are never logged. Bind an insight to a roadmap objective to turn
        asserted targets into measured ones.
      </p>
    </div>
  );
}
