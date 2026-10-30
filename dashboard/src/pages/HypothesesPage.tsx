import { useEffect, useState } from 'react';
import { useI18n } from '../context/I18nContext';
import { PageBar } from '../components/layout/PageBar';
import { useIsNewShell } from '../lib/uxMode';
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
  const newShell = useIsNewShell();
  const { t } = useI18n();

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
    const off = (
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
    // The new shell: the off state has no toolbar row, so it gets the title-only bar (W2-B).
    return newShell ? <div className="ns-empty-page"><PageBar title={t('nav.hypotheses')} />{off}</div> : off;
  }

  return (
    <div style={{ height: '100%', minHeight: 0 }}>
      <ThesisBoard initialObjective={initialObjective} initialDetailSlug={initialDetailSlug} />
    </div>
  );
}
