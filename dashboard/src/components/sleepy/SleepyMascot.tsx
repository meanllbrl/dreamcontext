import './SleepyMascot.css';

export type SleepyMood = 'idle' | 'sleepy' | 'sleeps';

/** Base design size the mascot is drawn at; `size` scales the whole thing. */
const BASE = 92;

interface SleepyMascotProps {
  /** Mood, driven by the project's sleep debt: idle (<8) · sleepy (8–9) · sleeps (≥10). */
  mood?: SleepyMood;
  /** Rendered width in px (everything scales from the 92px base). */
  size?: number;
  /** Tight mode for the notch perch: drops the halo + Zzz so nothing overflows
   *  the menu-bar-height tab — just the face. */
  compact?: boolean;
}

/**
 * Sleepy — the dreamcontext companion. The SAME face as the dashboard's "Ask
 * Sleepy anything" surface (soft violet eyes + a curved smile over a glow), so
 * the notch and the app feel like one character. Mood follows sleep debt. The
 * whole face is drawn at a 92px base and uniformly scaled, so it's crisp at the
 * big in-panel size and the small on-perch size alike.
 */
export function SleepyMascot({ mood = 'idle', size = BASE, compact = false }: SleepyMascotProps) {
  const scale = size / BASE;
  return (
    <div
      className={`smascot smascot-${mood}${compact ? ' smascot-compact' : ''}`}
      style={{ width: size, height: size * 0.82 }}
      aria-hidden
    >
      <div className="smascot-scale" style={{ transform: `scale(${scale})` }}>
        {!compact && <div className="smascot-halo" />}
        {mood === 'sleeps' && !compact && (
          <div className="smascot-zzz">
            <span>z</span>
            <span>z</span>
            <span>z</span>
          </div>
        )}
        <div className="smascot-face">
          <div className="smascot-eyes">
            <span className="smascot-eye" />
            <span className="smascot-eye" />
          </div>
          <svg className="smascot-smile" width="62" height="22" viewBox="0 0 96 34" fill="none">
            <path d="M12 8 Q48 42 84 8" stroke="#9d8cff" strokeWidth="5" strokeLinecap="round" />
          </svg>
        </div>
      </div>
    </div>
  );
}
