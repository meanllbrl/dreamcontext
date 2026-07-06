import type { JSX } from 'react';
import { FlowDiagram } from './FlowDiagram';
import { SLEEP_FLOW_SPEC } from './flow-specs';
import './SleepFlowSection.css';

// Real debt thresholds from the sleep-consolidation feature: session score is
// max(changeScore, toolScore); debt accumulates across sessions until reset.
const DEBT_LEVELS: { level: string; range: string; note: string }[] = [
  { level: 'Alert', range: '0–3', note: 'fresh — nothing to consolidate yet' },
  { level: 'Drowsy', range: '4–6', note: 'consolidation offered' },
  { level: 'Sleepy', range: '7–9', note: 'advisory note prepended' },
  { level: 'Must Sleep', range: '10+', note: 'critical directive prepended' },
];

// Each specialist owns a non-overlapping file domain and runs in parallel.
const SPECIALISTS: { name: string; domain: string; always: boolean }[] = [
  {
    name: 'sleep-tasks',
    domain: 'state/*.md — logs progress, bumps statuses, reconciles task bodies and workflow nodes.',
    always: true,
  },
  {
    name: 'sleep-state',
    domain:
      'soul · user · memory · data-structures · CHANGELOG · RELEASES — surgical core-file updates with an anti-bloat sweep.',
    always: true,
  },
  {
    name: 'sleep-product',
    domain: 'knowledge/ (incl. features/ PRDs) — writes and refreshes knowledge files and feature PRDs.',
    always: false,
  },
];

/**
 * "How sleep works" section: the debt → fan-out → converge → reset diagram plus
 * supporting cards. Consumes the shared FlowDiagram engine via SLEEP_FLOW_SPEC.
 */
export function SleepFlowSection(): JSX.Element {
  return (
    <section className="about-section">
      <p className="about-kicker">How sleep works</p>
      <h2 className="about-h2">It sleeps to remember — like REM, but for your project.</h2>
      <p className="about-section-lead">
        Every session adds <em>sleep debt</em>. When it builds up, one command fans out to
        parallel specialists that fold what changed back into the brain — then resets the meter.
      </p>

      <FlowDiagram spec={SLEEP_FLOW_SPEC} />

      <div className="sleepf-cards">
        <article className="sleepf-card sleepf-card--debt">
          <h3 className="sleepf-card-title">Debt accumulates across sessions</h3>
          <p className="sleepf-card-body">
            Each session scores by how much changed; the score adds to a running debt total that
            crosses graduated thresholds, so consolidation urgency is never ambiguous.
          </p>
          <ul className="sleepf-debt">
            {DEBT_LEVELS.map((d) => (
              <li key={d.level} className="sleepf-debt-row">
                <span className="sleepf-debt-level">{d.level}</span>
                <span className="sleepf-debt-range">{d.range}</span>
                <span className="sleepf-debt-note">{d.note}</span>
              </li>
            ))}
          </ul>
        </article>

        <article className="sleepf-card">
          <h3 className="sleepf-card-title">Specialists run in parallel</h3>
          <p className="sleepf-card-body">
            <code className="sleepf-cmd">sleep start</code> pins the epoch, then the main agent
            dispatches the specialists together in a single message — each updating a distinct
            knowledge domain, never editing outside it.
          </p>
          <ul className="sleepf-specialists">
            {SPECIALISTS.map((s) => (
              <li key={s.name} className="sleepf-spec-row">
                <code className="sleepf-spec-name">{s.name}</code>
                <span
                  className={`sleepf-spec-badge${s.always ? ' sleepf-spec-badge--always' : ''}`}
                >
                  {s.always ? 'always fires' : 'conditional'}
                </span>
                <span className="sleepf-spec-domain">{s.domain}</span>
              </li>
            ))}
          </ul>
        </article>

        <article className="sleepf-card sleepf-card--done">
          <h3 className="sleepf-card-title">
            <code className="sleepf-cmd">sleep done</code> resets the debt
          </h3>
          <p className="sleepf-card-body">
            Their reports converge into one stitched summary of updated system knowledge. The main
            agent calls <code className="sleepf-cmd">sleep done</code>, which records the
            consolidation and resets the debt to zero — ready for the next cycle.
          </p>
        </article>
      </div>
    </section>
  );
}
