import { useI18n } from '../../../context/I18nContext';
import { SuperAgentIcon } from '../../layout/NavIcons';

/**
 * The Chat header's one button for the whole mode (owner decision 9, plan-r8 F10), a tab pinned at
 * the start of the chat tabs since 2026-10-29: the Super
 * Agent's own glyph ({@link SuperAgentIcon}, the rail's stroke family) and a short label,
 * "Süper Ajan" / "Super Agent" while the panes show (the glyph alone in a narrow window), "Geri al" / "Take back" while the Super Agent
 * has the screen. The full sentence ("Süper Ajana devret" / "Hand over to the
 * Super Agent") stays in its accessible name and tooltip, so a header with four tabs keeps them
 * all in view. Pressed during the animation it reverses it (D18) — the caller
 * decides that; the button only says which way it points.
 *
 * The small dot: after take-back the Super Agent is parked, and its queue may still hold
 * items waiting on the owner.
 */
export function HandoverButton({ handedOver, busy, queueDot, onClick, remote = false }: {
  handedOver: boolean;
  busy: boolean;
  queueDot: boolean;
  onClick: () => void;
  /** A remote screen on Mac mode's tunnel (hands-free sekmeler W2, D7): hand-over and take-back
   *  are the Mac's, so this is a label, "Super Agent devrede · Mac'te yönetilir", not a button. */
  remote?: boolean;
}) {
  const { t } = useI18n();
  if (remote) {
    return (
      <span className="super-handover-btn super-handover-remote" data-testid="super-handover-remote" data-state="handed-over" role="status">
        <span className="super-handover-btn-icon"><SuperAgentIcon size={16} /></span>
        <span className="super-handover-btn-label">{t('super.remote.managed')}</span>
      </span>
    );
  }
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
      <span className="super-handover-btn-icon"><SuperAgentIcon size={16} /></span>
      <span className="super-handover-btn-label">{short}</span>
      {dot && <span className="super-handover-btn-dot" aria-hidden="true" />}
    </button>
  );
}
