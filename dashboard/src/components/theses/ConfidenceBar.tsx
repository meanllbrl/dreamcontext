import './theses.css';

/**
 * Split confidence bar (supports-vs-contradicts share) + mono % label. Used on
 * board cards (mini), the detail modal header (default), and roadmap Learning
 * mini-cards (mini). Confidence itself is always DERIVED upstream (see
 * src/lib/theses/confidence.ts) — this component only renders the number.
 */
export interface ConfidenceBarProps {
  /** Derived confidence, 0–1. */
  confidence: number;
  /** Evidence-ledger weight sums. When given, the split bar segments size from
   *  the actual supports/contradicts weight share; otherwise falls back to
   *  confidence vs (1 − confidence). */
  ws?: number;
  wc?: number;
  /** Compact variant for board cards / mini-cards (thinner bar, smaller %). */
  variant?: 'default' | 'mini';
  /** Hide the mono "%" label (bar only). */
  hideLabel?: boolean;
  className?: string;
}

/** Confidence % ink thresholds pinned by the design: ≥66 green, 40–65 amber, <40 red. */
function inkColorVar(pct: number): string {
  if (pct >= 66) return 'var(--thesis-validated)';
  if (pct >= 40) return 'var(--thesis-amber)';
  return 'var(--thesis-invalidated)';
}

export function ConfidenceBar({
  confidence,
  ws,
  wc,
  variant = 'default',
  hideLabel = false,
  className,
}: ConfidenceBarProps) {
  const clamped = Math.max(0, Math.min(1, confidence));
  const pct = Math.round(clamped * 100);
  const hasWeights = typeof ws === 'number' && typeof wc === 'number' && ws + wc > 0;
  const supportShare = hasWeights ? ws! / (ws! + wc!) : clamped;
  const supportPct = Math.max(0, Math.min(100, Math.round(supportShare * 100)));

  return (
    <div className={`thesis-confidence thesis-confidence--${variant}${className ? ` ${className}` : ''}`}>
      <div className="thesis-confidence-track" role="img" aria-label={`Confidence ${pct}%`}>
        <div className="thesis-confidence-fill thesis-confidence-fill--support" style={{ width: `${supportPct}%` }} />
        <div className="thesis-confidence-fill thesis-confidence-fill--contradict" style={{ width: `${100 - supportPct}%` }} />
      </div>
      {!hideLabel && (
        <span className="thesis-confidence-label" style={{ color: inkColorVar(pct) }}>
          {pct}%
        </span>
      )}
    </div>
  );
}
