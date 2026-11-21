/**
 * The Mac window lights, one component for a stage card and the presentation window (owner
 * 2026-11-08; one implementation so the two never drift, end review 2026-11-20).
 */
import { useI18n } from '../../../context/I18nContext';

/** One window control. No `onClick` = the control does not apply here: drawn off and disabled. */
export type Light = { label: string; onClick?: () => void; testId?: string; expanded?: boolean };

const LIGHT_GLYPHS = {
  close: <path d="M4.1 4.1l3.8 3.8M7.9 4.1L4.1 7.9" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />,
  minimize: <path d="M3.4 6h5.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />,
  zoom: <path d="M3.7 8V3.7H8z M8.3 4v4.3H4z" fill="currentColor" />,
} as const;

/**
 * The Mac window controls of a stage card (owner 2026-11-08): red close, yellow minimise, green
 * full screen, always in colour; hover or keyboard focus on the row shows the glyph in each dot.
 * The dot is 12 px, the button around it 24 px, so every control is a full-size target.
 */
export function CardLights({ close, minimize, zoom, floating, inline }: {
  close: Light; minimize: Light; zoom?: Light; floating?: boolean;
  /** In a title row (the presentation window): in the flow, no zoom, the same 24 px targets and glyphs. */
  inline?: boolean;
}) {
  const { t } = useI18n();
  const one = (tone: keyof typeof LIGHT_GLYPHS, l: Light) => {
    const off = !l.onClick;
    return (
      <button
        type="button"
        className={`super-light super-light--${tone}`}
        data-testid={off ? undefined : l.testId}
        aria-label={l.label}
        aria-expanded={l.expanded}
        title={l.label}
        disabled={off}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); l.onClick?.(); }}
      >
        <span className="super-light-dot" aria-hidden>
          {!off && <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>{LIGHT_GLYPHS[tone]}</svg>}
        </span>
      </button>
    );
  };
  return (
    <div className={floating ? 'super-card-lights super-card-lights--float' : inline ? 'super-card-lights super-card-lights--inline' : 'super-card-lights'} role="group" aria-label={t('super.card.controls')} data-testid="super-card-lights">
      {one('close', close)}
      {/* Yellow only where it works: an inert grey dot is not drawn (owner 2026-11-08). */}
      {minimize.onClick && one('minimize', minimize)}
      {zoom && one('zoom', zoom)}
    </div>
  );
}
