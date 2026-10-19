import { useI18n } from '../../../context/I18nContext';

/**
 * The cape-and-gem glyph (plan-r7 D19): the same superhero cue the centre mascot wears, at
 * 16/20 px on the 4 px grid — two cape flaps in the text colour, the dream gem clasp in the
 * brand accent. Static: the button never moves on its own.
 */
export function CapeGlyph({ size = 16 }: { size?: 16 | 20 }) {
  return (
    <svg className="super-cape-glyph" width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden>
      <path className="super-cape-glyph-cloth" d="M10 6.5 C7 6 4.5 5.4 2.5 4.2 C2 8 1.6 12 1 16.5 C3.6 15.2 6 15.6 8 14 C9 11.5 9.6 9 10 6.5 Z" />
      <path className="super-cape-glyph-cloth" d="M10 6.5 C13 6 15.5 5.4 17.5 4.2 C18 8 18.4 12 19 16.5 C16.4 15.2 14 15.6 12 14 C11 11.5 10.4 9 10 6.5 Z" />
      <path className="super-cape-glyph-gem-top" d="M7.4 6 L8.8 4 H11.2 L12.6 6 Z" />
      <path className="super-cape-glyph-gem" d="M7.4 6 H12.6 L10 9.6 Z" />
    </svg>
  );
}

/**
 * The Chat header's one button for the whole mode (owner decision 9, plan-r8 F10): the cape and
 * a short label, "Devret" / "Hand over" while the panes show, "Geri al" / "Take back" while the
 * Super Agent has the screen. The full sentence ("Süper Ajana devret" / "Hand over to the
 * Super Agent") stays in its accessible name and tooltip, so a header with four tabs keeps them
 * all in view. Pressed during the animation it reverses it (D18) — the caller
 * decides that; the button only says which way it points.
 *
 * The small dot: after take-back the Super Agent is parked, and its queue may still hold
 * items waiting on the owner.
 */
export function HandoverButton({ handedOver, busy, queueDot, onClick }: {
  handedOver: boolean;
  busy: boolean;
  queueDot: boolean;
  onClick: () => void;
}) {
  const { t } = useI18n();
  const label = handedOver ? t('super.button.takeBack') : t('super.button.handOver');
  const short = handedOver ? t('super.button.takeBackShort') : t('super.button.handOverShort');
  const dot = !handedOver && queueDot;
  return (
    <button
      type="button"
      className="super-handover-btn"
      data-testid="super-handover-btn"
      data-state={handedOver ? 'handed-over' : 'panes'}
      // The dot is decoration; what it means rides in the button's own accessible name (a label
      // on a role-less span is read by nothing).
      aria-label={dot ? `${label}, ${t('super.button.queueDot')}` : label}
      aria-pressed={handedOver}
      aria-busy={busy || undefined}
      title={`${label}. ${handedOver ? t('super.button.takeBackTitle') : t('super.button.handOverTitle')}`}
      onClick={onClick}
    >
      <CapeGlyph size={16} />
      <span className="super-handover-btn-label">{short}</span>
      {dot && <span className="super-handover-btn-dot" aria-hidden="true" />}
    </button>
  );
}
