import type { JSX } from 'react';
import { FlowDiagram } from './FlowDiagram';
import { RECALL_FLOW_SPEC } from './flow-specs';
import './RecallFlowSection.css';

// The three stages of the read pipeline. Grounded in src/lib/recall.ts (BM25F),
// recall-query-extractor.ts + haiku-recall-architecture.md (Haiku), and
// src/cli/commands/snapshot.ts (the SessionStart snapshot assembly).
const STAGES: { n: string; tag: string; title: string; body: string }[] = [
  {
    n: '01',
    tag: 'Keyword match',
    title: 'Field-weighted BM25F',
    body:
      'Your prompt is matched against the corpus — knowledge, features, tasks, memory and changelog — with field weighting, stemming and synonym expansion. It runs locally in under 100ms, with zero token overhead.',
  },
  {
    n: '02',
    tag: 'Intent recall',
    title: 'The Haiku agent',
    body:
      'The smallest cloud agent reads your full prompt and a relevance-ranked corpus index, then returns only the 0–3 documents that are directly relevant — resolving intent across languages. If it is unavailable, the pipeline falls back to raw BM25.',
  },
  {
    n: '03',
    tag: 'Session start',
    title: 'The snapshot assembles',
    body:
      'At SessionStart a hook composes the knowledge distribution — warm and cold knowledge, the features summary, the knowledge index, and pinned docs — and hands it to the agent so it begins each session already oriented.',
  },
];

/**
 * "How the system remembers" section: the left-to-right recall pipeline diagram
 * plus three stage cards. Consumes the shared FlowDiagram via RECALL_FLOW_SPEC.
 *
 * Positioning-safe: recall *augments* the agent with the right context — it does
 * not direct it. The human still steers; the brain just shows up loaded.
 */
export function RecallFlowSection(): JSX.Element {
  return (
    <section className="about-section">
      <p className="about-kicker">How the system remembers</p>
      <h2 className="about-h2">The right memory, surfaced before you ask.</h2>
      <p className="about-section-lead">
        Remembering is a read pipeline. Three stages take a prompt — or a fresh session — and put
        exactly the relevant context in front of the agent, so it works on what you actually
        meant. It <em>augments</em> the agent's reach; you stay in the driver's seat.
      </p>

      <FlowDiagram spec={RECALL_FLOW_SPEC} />

      <div className="recallf-stages">
        {STAGES.map((s) => (
          <article key={s.n} className="recallf-stage">
            <div className="recallf-stage-head">
              <span className="recallf-stage-n">{s.n}</span>
              <span className="recallf-stage-tag">{s.tag}</span>
            </div>
            <h3 className="recallf-stage-title">{s.title}</h3>
            <p className="recallf-stage-body">{s.body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
