import { useI18n } from '../../../context/I18nContext';
import type { Rect } from './superLayout';

/**
 * The presentation queue's control in the top band while the owner is OFF the queue (task
 * super-sahnesinde-sunum-sirasi, D2, D10): "N waiting · names · Continue". A queued presentation
 * on screen is named by the presentation frame's tabs instead (StageParts `PresentFrame`, owner
 * 2026-11-15, option C). `short` (a narrow band) drops the names; the count and the button stay.
 */
export function PresentQueue({ rect, short, waiting, onResume }: {
  rect: Rect;
  short: boolean;
  /** The waiting presentations' names, in order. */
  waiting: readonly string[];
  onResume: () => void;
}) {
  const { t } = useI18n();
  const n = waiting.length;
  const count = short ? t('super.pq.waitingShort') : n === 1 ? t('super.pq.waitingOne') : t('super.pq.waiting');
  return (
    <div className="super-pq" data-kind="wait" data-short={short ? 'true' : undefined} data-testid="super-pq" role="group" aria-label={t('super.pq.label')}
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}>
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
