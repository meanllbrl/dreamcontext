import { useEffect, useState } from 'react';
import { useTheses } from '../hooks/useTheses';
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
  // Not installed never reaches here: the page switch shows its Mağaza page (Mağaza D1).
  const { isLoading } = useTheses();
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

  return (
    <div style={{ height: '100%', minHeight: 0 }}>
      <ThesisBoard initialObjective={initialObjective} initialDetailSlug={initialDetailSlug} />
    </div>
  );
}
