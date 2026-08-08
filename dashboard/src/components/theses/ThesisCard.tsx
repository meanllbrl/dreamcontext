import type { ThesisView } from '../../hooks/useTheses';
import { ConfidenceBar } from './ConfidenceBar';
import { STATUS_META, STALE_DAYS_THRESHOLD, daysSince, confidenceInkVar } from './thesis-chrome';
import type { ThesisDelta } from './thesis-seen';
import './theses.css';
import './ThesisBoard.css';

/**
 * Verdict-first thesis card (redesign 08-08). Signal budget: status as a WORD,
 * one big confidence number, claim clamped to two lines, and a single
 * activity/meta line — the "what changed since you last looked" summary when
 * unread, plain recency otherwise. No glyphs, no link counts, no avatars: the
 * old ◈◇▦◑⚑ row read as noise and told the user nothing without a legend.
 */

interface ThesisCardProps {
  thesis: ThesisView;
  delta: ThesisDelta;
  onOpen: (slug: string) => void;
}

export function ThesisCard({ thesis: t, delta, onOpen }: ThesisCardProps) {
  const statusMeta = STATUS_META[t.status] ?? STATUS_META.draft;
  const cb = t.confidenceBreakdown;
  const hasEvidence = t.evidence.length > 0 || cb.ws + cb.wc > 0;
  const pct = Math.round(Math.max(0, Math.min(1, t.confidence)) * 100);
  const stale = t.checked_at !== null && daysSince(t.checked_at) >= STALE_DAYS_THRESHOLD;

  const metaParts: string[] = [];
  metaParts.push(`${t.cycles_checked} cycle${t.cycles_checked === 1 ? '' : 's'}`);
  metaParts.push(t.checked_at ? `checked ${daysSince(t.checked_at)}d ago` : 'never checked');
  if (t.blocked_on_instrumentation) metaParts.push('needs metric');

  const open = () => onOpen(t.slug);

  return (
    <div
      className="thc-card"
      onClick={open}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}
    >
      <div className="thc-row1">
        {delta.unread && <span className="thc-unread" aria-label="Changed since you last looked" />}
        <span className={`thc-status thc-status--${t.status}`}>{statusMeta.label}</span>
        <span className="thc-spacer" />
        <span
          className="thc-pct"
          style={{ color: hasEvidence ? confidenceInkVar(pct) : 'var(--color-text-tertiary)' }}
          title={hasEvidence ? `Confidence ${pct}% — derived from evidence` : 'No evidence yet'}
        >
          {hasEvidence ? `${pct}%` : '—'}
        </span>
      </div>

      {hasEvidence ? (
        <ConfidenceBar confidence={t.confidence} ws={cb.ws} wc={cb.wc} variant="mini" hideLabel className="thc-bar" />
      ) : (
        <div className="thc-bar-empty" aria-hidden="true" />
      )}

      <p className="thc-claim">{t.claim}</p>

      {delta.unread && delta.summary ? (
        <div className="thc-change">{delta.summary}</div>
      ) : (
        <div className="thc-meta" style={stale || t.blocked_on_instrumentation ? { color: 'var(--thesis-amber)' } : undefined}>
          {metaParts.join(' · ')}
        </div>
      )}
    </div>
  );
}
