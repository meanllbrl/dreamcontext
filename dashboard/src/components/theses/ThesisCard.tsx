import type { ThesisView } from '../../hooks/useTheses';
import { ConfidenceBar } from './ConfidenceBar';
import { STATUS_META, KIND_META, STALE_DAYS_THRESHOLD, daysSince, isFlippedThisCycle } from './thesis-chrome';
import './theses.css';
import './ThesisBoard.css';

export interface ThesisDisplayProps {
  kind: boolean;
  confidence: boolean;
  evidence: boolean;
  cycles: boolean;
  staleness: boolean;
  links: boolean;
  blocked: boolean;
  createdBy: boolean;
}

export const DEFAULT_THESIS_DISPLAY: ThesisDisplayProps = {
  kind: true, confidence: true, evidence: true, cycles: true, staleness: true, links: true, blocked: true, createdBy: true,
};

interface ThesisCardProps {
  thesis: ThesisView;
  display: ThesisDisplayProps;
  onOpen: (slug: string) => void;
}

export function ThesisCard({ thesis: t, display, onOpen }: ThesisCardProps) {
  const statusMeta = STATUS_META[t.status] ?? STATUS_META.draft;
  const kindMeta = KIND_META[t.kind] ?? KIND_META.observational;
  const flipped = isFlippedThisCycle(t);
  const stale = t.checked_at !== null && daysSince(t.checked_at) >= STALE_DAYS_THRESHOLD;

  const links: { icon: string; n: number; colorVar: string }[] = [
    { icon: '◈', n: t.insights.length, colorVar: 'var(--thesis-open)' },
    { icon: '◇', n: t.objectives.length, colorVar: 'var(--thesis-amber)' },
    { icon: '▦', n: t.related_tasks.length, colorVar: 'var(--thesis-violet)' },
  ].filter((l) => l.n > 0);

  const open = () => onOpen(t.slug);

  return (
    <div
      className="thc-card"
      style={{ borderLeft: `3px solid ${statusMeta.colorVar}` }}
      onClick={open}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}
    >
      {flipped && (
        <div className="thc-flip">
          <span className="thc-flip-glow" aria-hidden="true" />
          <span className="thc-flip-label">⟳ FLIPPED {statusMeta.label.toUpperCase()}</span>
        </div>
      )}

      <div className="thc-top">
        {display.kind && (
          <span className="thc-kind" style={{ color: kindMeta.colorVar }} title={kindMeta.label}>{kindMeta.glyph}</span>
        )}
        <span className="thc-claim">{t.claim}</span>
      </div>

      {display.confidence && (
        <div className="thc-conf">
          <ConfidenceBar confidence={t.confidence} ws={t.confidenceBreakdown.ws} wc={t.confidenceBreakdown.wc} variant="mini" />
        </div>
      )}

      {display.evidence && (
        <div className="thc-evidence">
          <span><span className="thc-evidence-dot" style={{ color: 'var(--thesis-validated)' }}>●</span> {t.confidenceBreakdown.supports} supporting</span>
          <span><span className="thc-evidence-dot" style={{ color: 'var(--thesis-invalidated)' }}>●</span> {t.confidenceBreakdown.contradicts} against</span>
        </div>
      )}

      {(display.cycles || display.staleness) && (
        <div className="thc-meta" style={{ color: display.staleness && stale ? 'var(--thesis-amber)' : 'var(--color-text-tertiary)' }}>
          {display.cycles && <span>{t.cycles_checked} cycle{t.cycles_checked === 1 ? '' : 's'}</span>}
          {display.cycles && display.staleness && <span> · </span>}
          {display.staleness && (
            <span>{t.checked_at ? `checked ${daysSince(t.checked_at)} day${daysSince(t.checked_at) === 1 ? '' : 's'} ago` : 'never checked'}</span>
          )}
        </div>
      )}

      {(display.links && links.length > 0) || (display.blocked && t.blocked_on_instrumentation) || display.createdBy ? (
        <div className="thc-foot">
          {display.links && links.map((l, i) => (
            <span key={i} className="thc-chip" style={{ color: l.colorVar }}>{l.icon} {l.n}</span>
          ))}
          {display.blocked && t.blocked_on_instrumentation && (
            <span className="thc-chip thc-chip--blocked">⚑ Needs metric</span>
          )}
          <span className="thc-spacer" />
          {display.createdBy && (
            <span
              className="thc-avatar"
              style={{ color: t.created_by === 'sleep-learn' ? 'var(--thesis-violet)' : 'var(--color-text-tertiary)' }}
              title={t.created_by === 'sleep-learn' ? 'sleep-learn agent' : 'You'}
            >
              {t.created_by === 'sleep-learn' ? '◑' : '●'}
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}
