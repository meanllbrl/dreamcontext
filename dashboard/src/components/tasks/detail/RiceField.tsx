import type { RiceFields, RiceInput } from '../../../hooks/useTasks';
import { useI18n } from '../../../context/I18nContext';

/** The values the server accepts (src/lib/rice.ts): reach 1–10, impact 1–5, confidence 25/50/75/100, effort > 0 and ≤ 52 weeks. */
export const REACH_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
export const IMPACT_OPTIONS = [1, 2, 3, 4, 5] as const;
export const CONFIDENCE_OPTIONS = [25, 50, 75, 100] as const;
export const EFFORT_OPTIONS = [0.5, 1, 1.5, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 26, 39, 52] as const;

type Field = keyof RiceInput;

/**
 * RICE as four small boxes (Reach, Impact, Conf., Effort) and the server's score under them.
 * Each box is a select over exactly the values the server accepts; "—" clears that one value.
 * The score is the server's, never recomputed here.
 */
export function RiceField({ rice, onUpdate }: { rice: RiceFields | null; onUpdate: (patch: RiceInput | null) => void }) {
  const { t } = useI18n();
  const current = (f: Field): number | null => (rice ? rice[f] : null);
  const pick = (f: Field, raw: string) => {
    const next = raw === '' ? null : Number(raw);
    if (next !== null && !Number.isFinite(next)) return;
    if (next === current(f)) return;
    onUpdate({ [f]: next } as RiceInput);
  };
  const boxes: { f: Field; label: string; tip: string; opts: readonly number[]; fmt: (v: number) => string }[] = [
    { f: 'reach', label: t('rice.reach'), tip: t('rice.tooltip.reach'), opts: REACH_OPTIONS, fmt: String },
    { f: 'impact', label: t('rice.impact'), tip: t('rice.tooltip.impact'), opts: IMPACT_OPTIONS, fmt: String },
    { f: 'confidence', label: 'Conf.', tip: t('rice.tooltip.confidence'), opts: CONFIDENCE_OPTIONS, fmt: (v) => `${v}%` },
    { f: 'effort', label: t('rice.effort'), tip: t('rice.tooltip.effort'), opts: EFFORT_OPTIONS, fmt: (v) => `${v}w` },
  ];
  // A stored effort the list does not offer (hand-edited, e.g. 7) still shows as itself.
  const withCurrent = (opts: readonly number[], f: Field) => {
    const c = current(f);
    return c !== null && !opts.includes(c) ? [...opts, c].sort((a, b) => a - b) : [...opts];
  };
  return (
    <div className="rice-field2">
      <div className="rice-boxes">
        {boxes.map((b) => (
          <label key={b.f} className="rice-box" title={b.tip}>
            <select className="rice-box-select" value={current(b.f) ?? ''} onChange={(e) => pick(b.f, e.target.value)} aria-label={b.label}>
              <option value="">—</option>
              {withCurrent(b.opts, b.f).map((v) => <option key={v} value={v}>{b.fmt(v)}</option>)}
            </select>
            <span className="rice-box-label">{b.label}</span>
          </label>
        ))}
      </div>
      <div className="rice-score-line">
        <span>{t('rice.score')}</span>
        <span className="rice-score-value">{rice?.score ?? '—'}</span>
        <span className="rice-score-formula">R×I×C ÷ E</span>
        {rice && <button type="button" className="rice-clear-link" onClick={() => onUpdate(null)}>{t('rice.clear')}</button>}
      </div>
    </div>
  );
}
