import { useMemo, useState } from 'react';
import { useCloseCycle, useClosePlan, type CloseAction } from '../../hooks/useCycles';
import { confirmAction } from '../../lib/desktop';
import { useI18n } from '../../context/I18nContext';

const ACTIONS: CloseAction[] = ['carry', 'back', 'cancel'];

/**
 * Closing a cycle: every unfinished leaf gets a decision — Carry into the next cycle, Back to
 * Next, or Cancel — grouped under its parent, with how many times it was carried before.
 * "Apply to the rest" fills every undecided leaf at once. Close stays disabled until every leaf
 * is decided, and a close that cancels anything asks once. The decisions go to the same library
 * `dreamcontext cycle close` uses; an interrupted close resumes with what it recorded.
 */
export function CloseDeck({ cycleId, onDone, onCancel }: { cycleId: string; onDone: () => void; onCancel: () => void }) {
  const { t } = useI18n();
  // Off once the close is submitted (and back on if it fails): the plan of a closed cycle is
  // never read again.
  const [submitted, setSubmitted] = useState(false);
  const { data: plan, isLoading, error: loadError } = useClosePlan(cycleId, !submitted);
  const close = useCloseCycle();
  const [decisions, setDecisions] = useState<Record<string, CloseAction>>({});
  const [rest, setRest] = useState<CloseAction>('back');
  const [error, setError] = useState<string | null>(null);

  const leaves = useMemo(() => (plan?.groups ?? []).flatMap((g) => g.leaves), [plan]);
  const undecided = leaves.filter((l) => !decisions[l.slug]);
  const ready = !!plan && (plan.resuming || undecided.length === 0);

  if (isLoading) return <p className="pln-empty">{t('taskPage.loading')}</p>;
  if (loadError || !plan) return <p className="pln-error" role="alert">{loadError ? (loadError as Error).message : t('closeDeck.missing')}</p>;

  const decide = (slug: string, action: CloseAction) => setDecisions((d) => ({ ...d, [slug]: action }));
  const applyRest = () => setDecisions((d) => {
    const next = { ...d };
    for (const l of leaves) if (!next[l.slug]) next[l.slug] = rest;
    return next;
  });

  const submit = async () => {
    setError(null);
    const cancels = Object.values(decisions).filter((a) => a === 'cancel').length;
    if (cancels > 0 && !plan.resuming) {
      const ok = await confirmAction({
        title: t('closeDeck.confirmTitle').replace('{n}', String(cancels)),
        body: t('closeDeck.confirmBody'),
        confirmLabel: t('closeDeck.confirmLabel'),
        destructive: true,
      });
      if (!ok) return;
    }
    setSubmitted(true);
    close.mutate(
      { id: cycleId, decisions, ...(plan.into ? { into: plan.into.id } : {}) },
      { onSuccess: onDone, onError: (err: Error) => { setSubmitted(false); setError(err.message); } },
    );
  };

  return (
    <section className="cld-deck" aria-labelledby="cld-title" data-close-deck={cycleId}>
      <h2 className="cld-title" id="cld-title">{t('closeDeck.title').replace('{n}', String(plan.cycle.number))}</h2>
      <p className="pln-meta">
        {plan.into
          ? t('closeDeck.into').replace('{n}', String(plan.into.number))
          : t('closeDeck.noInto')}
      </p>
      {plan.resuming && <p className="cld-note" role="status">{t('closeDeck.resuming')}</p>}
      {leaves.length === 0 && <p className="pln-empty">{t('closeDeck.nothing')}</p>}

      {plan.groups.map((g) => (
        <div key={g.parent?.slug ?? '_none'} className="cld-group">
          <h3 className="cld-group-title" lang="und">{g.parent ? g.parent.name : t('closeDeck.noParent')}</h3>
          <ul className="cld-leaves">
            {g.leaves.map((l) => (
              <li key={l.slug} className="cld-leaf" data-close-leaf={l.slug}>
                <div className="cld-leaf-head">
                  <span className="cld-leaf-name" lang="und">{l.name || l.slug}</span>
                  {l.carried > 0 && <span className="pln-tag">{t('closeDeck.carried').replace('{n}', String(l.carried))}</span>}
                </div>
                <div className="cld-choices" role="radiogroup" aria-label={t('closeDeck.decide').replace('{name}', l.name || l.slug)}>
                  {ACTIONS.map((a) => (
                    <button
                      key={a}
                      type="button"
                      role="radio"
                      aria-checked={decisions[l.slug] === a}
                      className="cld-choice"
                      disabled={plan.resuming || (a === 'carry' && !plan.into)}
                      onClick={() => decide(l.slug, a)}
                    >
                      {t(`closeDeck.action.${a}`)}
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}

      {!plan.resuming && undecided.length > 0 && (
        <div className="cld-rest">
          <label className="pln-field">
            <span className="pln-label">{t('closeDeck.restLabel').replace('{n}', String(undecided.length))}</span>
            <select className="pln-select" value={rest} onChange={(e) => setRest(e.target.value as CloseAction)}>
              {ACTIONS.filter((a) => a !== 'carry' || plan.into).map((a) => <option key={a} value={a}>{t(`closeDeck.action.${a}`)}</option>)}
            </select>
          </label>
          <button type="button" className="pln-btn" onClick={applyRest}>{t('closeDeck.applyRest')}</button>
        </div>
      )}

      <div className="pln-actions">
        <button type="button" className="pln-btn pln-btn--primary" disabled={!ready || close.isPending} onClick={() => void submit()}>
          {t('closeDeck.submit')}
        </button>
        <button type="button" className="pln-btn" onClick={onCancel}>{t('taskPage.cancel')}</button>
      </div>
      {error && <p className="pln-error" role="alert">{error}</p>}
    </section>
  );
}
