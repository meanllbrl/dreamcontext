import { useState, type FormEvent } from 'react';
import { useNewCycle } from '../../hooks/useCycles';
import { useI18n } from '../../context/I18nContext';

/** A new cycle: its goal, when it starts, and how many weeks it runs (the project's default). */
export function NewCycleForm({ defaultWeeks, onCreated }: { defaultWeeks: number; onCreated?: (id: string) => void }) {
  const { t } = useI18n();
  const create = useNewCycle();
  const [goal, setGoal] = useState('');
  const [start, setStart] = useState('');
  const [weeks, setWeeks] = useState(String(defaultWeeks));
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!goal.trim()) return;
    setError(null);
    const n = Number(weeks);
    create.mutate(
      { goal: goal.trim(), ...(start ? { start } : {}), ...(Number.isInteger(n) && n > 0 ? { weeks: n } : {}) },
      {
        onSuccess: (r) => { setGoal(''); setStart(''); setWeeks(String(defaultWeeks)); onCreated?.(r.cycle.id); },
        onError: (err: Error) => setError(err.message),
      },
    );
  };

  return (
    <form className="pln-form" onSubmit={submit} data-new-cycle-form>
      <label className="pln-field pln-field--grow">
        <span className="pln-label">{t('planning.new.goal')}</span>
        <input className="pln-input" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder={t('planning.new.goalPlaceholder')} required />
      </label>
      <label className="pln-field">
        <span className="pln-label">{t('planning.new.start')}</span>
        <input className="pln-input" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
      </label>
      <label className="pln-field">
        <span className="pln-label">{t('planning.new.weeks')}</span>
        <input className="pln-input pln-input--narrow" type="number" min={1} max={12} value={weeks} onChange={(e) => setWeeks(e.target.value)} />
      </label>
      <button type="submit" className="pln-btn pln-btn--primary" disabled={!goal.trim() || create.isPending}>{t('planning.new.create')}</button>
      {error && <p className="pln-error" role="alert">{error}</p>}
    </form>
  );
}
