import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../../../context/I18nContext';
import { PAD_STATUSES, type PadStatus } from '../../../lib/superTypes';
import { StatusGlyph } from './AgendaRow';
import { placeBelow } from './agendaGroups';

/**
 * A layer drawn outside the card's clip (plan build notes: a five-item menu on the 160x160 card is
 * never cut off), into the stage root so it keeps the stage's tokens, fixed on screen. Escape and
 * a press outside close it.
 */
export function FloatLayer({ anchorOf, place, onClose, children, className, testId, role, label }: {
  anchorOf: () => HTMLElement | null;
  place: (anchor: DOMRect, size: { width: number; height: number }) => { x: number; y: number };
  onClose: () => void;
  children: ReactNode;
  className: string;
  testId: string;
  role?: string;
  label?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [style, setStyle] = useState<CSSProperties>({ position: 'fixed', left: -9999, top: 0, visibility: 'hidden' });
  const anchor = anchorOf();
  const host = (anchor?.closest('.super-surface') as HTMLElement | null) ?? (typeof document !== 'undefined' ? document.body : null);
  useLayoutEffect(() => {
    const a = anchorOf();
    const el = ref.current;
    if (!a || !el) return;
    const p = place(a.getBoundingClientRect(), { width: el.offsetWidth, height: el.offsetHeight });
    setStyle({ position: 'fixed', left: p.x, top: p.y });
  }, []);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); closeRef.current(); } };
    const down = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (ref.current && target && !ref.current.contains(target) && !anchorOf()?.contains(target)) closeRef.current();
    };
    document.addEventListener('keydown', key, true);
    document.addEventListener('pointerdown', down, true);
    return () => { document.removeEventListener('keydown', key, true); document.removeEventListener('pointerdown', down, true); };
  }, []);
  if (!host) return null;
  return createPortal(
    <div ref={ref} className={className} data-testid={testId} role={role} aria-label={label} style={style}>{children}</div>,
    host,
  );
}

/** The five statuses (owner 14 Nov): the circle's menu. The current one is marked. */
export function AgendaStatusMenu({ anchor, current, onPick, onClose }: {
  anchor: HTMLElement;
  current: PadStatus;
  onPick: (s: PadStatus) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const first = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { first.current?.focus(); }, []);
  return (
    <FloatLayer
      anchorOf={() => (anchor.isConnected ? anchor : null)}
      place={(a, s) => placeBelow(a, s.width, s.height, { width: window.innerWidth, height: window.innerHeight })}
      onClose={onClose}
      className="agenda-menu"
      testId="super-agenda-status-menu"
      role="menu"
      label={t('super.agenda.statusTitle')}
    >
      {PAD_STATUSES.map((s) => (
        <button
          key={s}
          ref={s === current ? first : undefined}
          type="button"
          role="menuitemradio"
          aria-checked={s === current}
          className="agenda-menu-item"
          data-status={s}
          data-current={s === current ? 'true' : undefined}
          onClick={() => { onClose(); if (s !== current) onPick(s); }}
        >
          <StatusGlyph status={s} />
          <span>{t(`super.agenda.status.${s}`)}</span>
        </button>
      ))}
    </FloatLayer>
  );
}
