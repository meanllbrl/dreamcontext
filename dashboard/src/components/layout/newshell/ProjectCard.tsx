import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../../../context/I18nContext';
import { PAGE_LABEL_KEY } from '../../../lib/pageLabels';
import type { Place } from '../../../lib/placeHistory';
import { PhoneSheet, PhoneSheetClose } from '../../sleepy/super/PhoneSheet';
import { RailFace, type RailProject } from './ProjectRail';
import type { NeedsYouRow } from './railMarks';

/** The card's width on a computer (build notes). */
export const CARD_WIDTH = 300;

export interface ProjectCardData {
  project: Pick<RailProject, 'name' | 'logo' | 'logoStamp'>;
  /** The project's Super Agent: on, at work, waiting on the owner. Absent on a device shell. */
  superAgent?: { on: boolean; working: boolean; asking: boolean };
  needsYou: NeedsYouRow[];
  lastHere: Place | null;
  recent: Place[];
}

/** Where a card on a computer sits: right of its badge, its top on the badge's top, kept inside
 *  the window. Pure. */
export function cardPosition(anchor: { top: number; right: number }, height: number, viewport: { width: number; height: number }): { left: number; top: number } {
  const left = Math.min(anchor.right + 8, Math.max(8, viewport.width - CARD_WIDTH - 8));
  const top = Math.max(8, Math.min(anchor.top - 8, viewport.height - height - 8));
  return { left, top };
}

function PlaceIcon({ place }: { place: Place }) {
  const page = place.kind === 'chat' ? 'chat' : place.page;
  return (
    <svg className="ns-pcard-ico" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      {page === 'chat' && <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" strokeLinejoin="round" />}
      {page === 'whiteboards' && <><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M4.5 10.5 7 8l2 2 2.5-3" /></>}
      {page === 'tasks' && <><rect x="2.5" y="2.5" width="11" height="11" rx="2" /><path d="M5.5 8.2 7.2 10 10.5 6" /></>}
      {page !== 'chat' && page !== 'whiteboards' && page !== 'tasks' && <><rect x="2.5" y="2.5" width="11" height="11" rx="2" /><path d="M5 6h6M5 8.5h6M5 11h3.5" /></>}
    </svg>
  );
}

/**
 * A project's card (navigation B, D10): its Super Agent, what waits on the owner there (NEEDS
 * YOU), where he was last and what he visited lately. Every row lands in one click. On a computer
 * it opens beside its badge on hover and closes on leave (with a grace) and on Esc; on a phone it
 * is a bottom sheet from a long press.
 */
export function ProjectCard({ data, anchor, sheet = false, onNeedsYou, onPlace, onClose }: {
  data: ProjectCardData;
  anchor: DOMRect | null;
  sheet?: boolean;
  onNeedsYou(row: NeedsYouRow): void;
  onPlace(place: Place): void;
  onClose(): void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (sheet || !anchor) return;
    const h = ref.current?.offsetHeight ?? 320;
    setPos(cardPosition(anchor, h, { width: window.innerWidth, height: window.innerHeight }));
  }, [sheet, anchor, data]);
  useEffect(() => {
    if (sheet) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [sheet, onClose]);

  const placeText = (p: Place) => {
    const page = p.kind === 'chat' ? t('nav.chat') : t(PAGE_LABEL_KEY[p.page]);
    const name = p.kind === 'page' && p.label ? p.label : page;
    return { name, page };
  };
  const { name } = data.project;
  const s = data.superAgent;

  const body = (
    <>
      {s && (
        <button type="button" className="ns-pcard-super ns-pcard-row" data-testid="ns-pcard-super"
          onClick={() => onNeedsYou({ key: 'super', kind: 'super', label: '', count: 0, intent: { kind: 'super' } })}>
          <span className="ns-pcard-diamond" data-working={s.working ? 'true' : undefined} aria-hidden="true" />
          <span className="ns-pcard-t">{t('shell.drawer.superAgent')}</span>
          <span className="ns-pcard-state" data-asking={s.asking ? 'true' : undefined}>
            {s.asking ? t('shell.nav.needsYou') : s.working ? t('shell.nav.superWorking') : s.on ? t('shell.nav.superIdle') : t('shell.nav.superOff')}
          </span>
        </button>
      )}
      <div className="ns-pcard-head ns-pcard-head--needs">{t('shell.nav.needsYou')}</div>
      {data.needsYou.length === 0 && <div className="ns-pcard-empty">{t('shell.nav.nothingWaits')}</div>}
      {data.needsYou.map((r) => (
        <button key={r.key} type="button" className="ns-pcard-row ns-pcard-needs" data-testid="ns-pcard-needs" onClick={() => onNeedsYou(r)}>
          <span className="ns-pcard-dot" aria-hidden="true" />
          <span className="ns-pcard-t">{r.kind === 'super' ? t('shell.drawer.superAgent') : r.label}</span>
          {r.count > 1 && <span className="ns-pcard-n">{r.count}</span>}
        </button>
      ))}
      {data.lastHere && (
        <>
          <div className="ns-pcard-head">{t('shell.nav.lastHere')}</div>
          <PlaceRow place={data.lastHere} text={placeText(data.lastHere)} onPick={onPlace} testId="ns-pcard-last" />
        </>
      )}
      {data.recent.length > 0 && (
        <>
          <div className="ns-pcard-head">{t('shell.nav.recent')}</div>
          {data.recent.slice(0, 5).map((p, i) => <PlaceRow key={i} place={p} text={placeText(p)} onPick={onPlace} testId="ns-pcard-recent" />)}
        </>
      )}
    </>
  );

  if (sheet) {
    return (
      <PhoneSheet testId="ns-pcard-sheet" label={name} className="ns-pcard-sheet" onClose={onClose}
        handle={<div className="ns-pcard-title"><RailFace p={data.project} size={24} /><span>{name}</span><PhoneSheetClose testId="ns-pcard-close" label={t('common.close')} onClick={onClose} /></div>}>
        <div className="ns-pcard-body">{body}</div>
      </PhoneSheet>
    );
  }
  return createPortal(
    <div ref={ref} className="ns-pcard" role="dialog" aria-label={name} data-testid="ns-pcard" data-project={name}
      style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden' }}
      onMouseEnter={() => window.dispatchEvent(new Event('ns-prail-card-enter'))}
      onMouseLeave={() => window.dispatchEvent(new Event('ns-prail-card-leave'))}>
      <div className="ns-pcard-title"><RailFace p={data.project} size={20} /><span>{name}</span></div>
      {body}
    </div>,
    document.body,
  );
}

function PlaceRow({ place, text, onPick, testId }: { place: Place; text: { name: string; page: string }; onPick(p: Place): void; testId: string }) {
  return (
    <button type="button" className="ns-pcard-row" data-testid={testId} onClick={() => onPick(place)}>
      <PlaceIcon place={place} />
      <span className="ns-pcard-t">{text.name}</span>
      {text.name !== text.page && <span className="ns-pcard-where">{text.page}</span>}
    </button>
  );
}
