import { useI18n } from '../../../context/I18nContext';
import type { Rect } from './superLayout';

/** Dots stop reading as a count past this many: the i/N text carries it alone. */
const MAX_DOTS = 8;

/**
 * The presentation queue's control in the top band (task super-sahnesinde-sunum-sirasi, D2, D7,
 * D10). `step`: a queued presentation of 2+ is on screen, left of the layout buttons: dots, i/N,
 * the shown one's name and "Next: <name>" (on the last one, "Finish"). `wait`: the owner left the
 * queue and presentations wait: "N waiting · names · Continue". `short` (a narrow band) drops the
 * names; the counter and the button stay.
 */
export function PresentQueue({ rect, kind, short, at, of, current, next, waiting, onNext, onResume }: {
  rect: Rect;
  kind: 'step' | 'wait';
  short: boolean;
  at: number;
  of: number;
  /** The shown presentation's name (step). */
  current: string;
  /** The next one's name; null on the last item (step). */
  next: string | null;
  /** The waiting presentations' names, in order (wait). */
  waiting: readonly string[];
  onNext: () => void;
  onResume: () => void;
}) {
  const { t } = useI18n();
  const style = { left: rect.x, top: rect.y, width: rect.width, height: rect.height };
  if (kind === 'wait') {
    const n = waiting.length;
    const count = short ? t('super.pq.waitingShort') : n === 1 ? t('super.pq.waitingOne') : t('super.pq.waiting');
    return (
      <div className="super-pq" data-kind="wait" data-short={short ? 'true' : undefined} data-testid="super-pq" role="group" aria-label={t('super.pq.label')} style={style}>
        <div className="super-pq-pill">
          <span className="super-pq-play" aria-hidden>▶</span>
          <span className="super-pq-text">
            <span className="super-pq-count">{count.replace('{n}', String(n))}</span>
            {!short && n > 0 && <span className="super-pq-names" title={waiting.join(', ')}>{`· ${waiting.join(', ')}`}</span>}
          </span>
          <button type="button" className="super-pq-go" data-testid="super-pq-resume" onClick={onResume}>{t('super.pq.resume')}</button>
        </div>
      </div>
    );
  }
  const nextLabel = next === null ? t('super.pq.finish') : t('super.pq.next').replace('{name}', next);
  return (
    <div className="super-pq" data-kind="step" data-short={short ? 'true' : undefined} data-testid="super-pq" role="group" aria-label={t('super.pq.label')} style={style}>
      <div className="super-pq-pill">
        {!short && of <= MAX_DOTS && (
          <span className="super-pq-dots" aria-hidden>
            {Array.from({ length: of }, (_, i) => <span key={i} className="super-pq-dot" data-on={i + 1 === at ? 'true' : undefined} data-past={i + 1 < at ? 'true' : undefined} />)}
          </span>
        )}
        <span className="super-pq-text">
          <span className="super-pq-count" data-testid="super-pq-count">{at}/{of}</span>
          {!short && <span className="super-pq-names" title={current}>{`· ${current}`}</span>}
        </span>
        <button type="button" className="super-pq-go" data-testid="super-pq-next" onClick={onNext}
          aria-label={short ? nextLabel : undefined} title={short ? nextLabel : undefined}>
          {short ? '›' : <>{nextLabel}{next !== null && <span aria-hidden>{' →'}</span>}</>}
        </button>
      </div>
    </div>
  );
}
