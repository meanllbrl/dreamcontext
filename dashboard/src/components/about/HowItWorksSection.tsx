import type { JSX } from 'react';
import { FlowDiagram } from './FlowDiagram';
import { HOW_IT_WORKS_SPEC } from './flow-specs';
import './HowItWorksSection.css';

// Three steps under the diagram. Copy is grounded in the broadened context set
// (soul/user/memory/knowledge/state PLUS data-structures, skills, sub-agents)
// and the fact that RemSleep consolidation is multi-agent.
const HIW2_STEPS: { n: string; title: string; body: string }[] = [
  {
    n: '01',
    title: 'It loads',
    body:
      'A SessionStart hook preloads the whole project picture — soul, user, memory, knowledge and state, plus data-structures, skills and sub-agents — before the agent makes a single tool call.',
  },
  {
    n: '02',
    title: 'It works',
    body:
      'With identity, history, procedures, schema and capabilities already in context, your agent works against the real project — no re-exploring, no blind search spiral, no re-teaching what it learned last time.',
  },
  {
    n: '03',
    title: 'It sleeps',
    body:
      'RemSleep is multi-agent: parallel specialists consolidate the session in their own domains and feed the distilled knowledge back into those context files — so the next session starts even sharper.',
  },
];

/**
 * "How it works" landing section: the SessionStart loop diagram plus three
 * step cards. Consumes the shared FlowDiagram engine via HOW_IT_WORKS_SPEC.
 */
export function HowItWorksSection(): JSX.Element {
  return (
    <section className="about-section">
      <p className="about-kicker">How it works</p>
      <h2 className="about-h2">
        A brain that loads, works, and sleeps — across your whole system.
      </h2>
      <p className="about-section-lead">
        Three moves, repeated every session. A hook preloads the entire context set with{' '}
        <em>zero tool calls</em>, your agent works with the whole picture, and a multi-agent
        RemSleep cycle consolidates what changed. The loop is the product.
      </p>

      <FlowDiagram spec={HOW_IT_WORKS_SPEC} />

      <div className="hiw2-steps">
        {HIW2_STEPS.map((s) => (
          <div key={s.n} className="hiw2-step">
            <span className="hiw2-step-n">{s.n}</span>
            <h3 className="hiw2-step-title">{s.title}</h3>
            <p className="hiw2-step-body">{s.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
