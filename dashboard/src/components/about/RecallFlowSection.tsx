import type { JSX } from 'react';
import { FlowDiagram } from './FlowDiagram';
import { RECALL_FLOW_SPEC } from './flow-specs';
import './RecallFlowSection.css';

// The three stages of the read pipeline. Grounded in src/lib/recall.ts (BM25F),
// src/lib/embeddings/hybrid.ts (local dense embeddings), and
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
    tag: 'Semantic recall',
    title: 'Local embeddings',
    body:
      'A small multilingual embedding model runs on your machine and blends its semantic matches with the keyword ranking — so a paraphrase or a Turkish question still finds the English doc. Nothing is uploaded, and if the model or index is not ready the pipeline falls back to plain BM25.',
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
