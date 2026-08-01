import { useEffect, useState } from 'react';
import { useTheses, useSetLearningEnabled } from '../hooks/useTheses';
import { ThesisBoard } from '../components/theses/ThesisBoard';
import type { FocusTarget } from '../hooks/useFocusTarget';
import '../components/theses/theses.css';
import './HypothesesPage.css';

interface HypothesesPageProps {
  /**
   * Shell navigation focus. Two distinct targets ride the same `id` channel,
   * disambiguated by prefix: `objective:<slug>` pre-filters the board to that
   * objective (the roadmap Learning section's "Open Hypothesis board for this
   * objective" footer button); a bare `<slug>` opens that thesis's detail
   * modal directly (a Learning-section mini-card click).
   */
  focus?: FocusTarget;
}

export function HypothesesPage({ focus }: HypothesesPageProps = {}) {
  const { data, isLoading } = useTheses();
  const setLearningEnabled = useSetLearningEnabled();
  const [initialObjective, setInitialObjective] = useState<string | null>(null);
  const [initialDetailSlug, setInitialDetailSlug] = useState<string | null>(null);

  useEffect(() => {
    const id = focus?.id;
    if (!id) return;
    if (id.startsWith('objective:')) {
      setInitialObjective(id.slice('objective:'.length));
      setInitialDetailSlug(null);
    } else {
      setInitialDetailSlug(id);
      setInitialObjective(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce]);

  if (isLoading) {
    return <div style={{ padding: 40, color: 'var(--color-text-tertiary)', fontSize: 13 }}>Loading…</div>;
  }

  if (data?.enabled === false) {
    return (
      <div className="hyp-off">
        <div className="hyp-off-icon" aria-hidden="true">⊘</div>
        <h2 className="hyp-off-title">The Proactive Learning Layer is off</h2>
        <p className="hyp-off-body">
          A hypothesis is a falsifiable claim about your project that the brain writes down, pre-registers a prediction
          for, and re-tests against fresh evidence on every sleep cycle — flipping it to validated or invalidated when
          the evidence decides. While the layer is off, no hypotheses are formed and sleep cycles stop re-testing the
          open ones. Turning it on is reversible from Settings; nothing existing is touched.
        </p>
        <button
          type="button"
          className="hyp-off-cta thesis-cta"
          disabled={setLearningEnabled.isPending}
          onClick={() => setLearningEnabled.mutate(true)}
        >
          Enable learning layer
        </button>
      </div>
    );
  }

  return (
    <div style={{ height: '100%', minHeight: 0 }}>
      <ThesisBoard initialObjective={initialObjective} initialDetailSlug={initialDetailSlug} />
    </div>
  );
}
