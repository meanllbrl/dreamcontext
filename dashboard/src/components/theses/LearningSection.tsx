import { useMemo } from 'react';
import { useTheses } from '../../hooks/useTheses';
import { useLabInsights } from '../../hooks/useLab';
import { fmtMetricValue } from '../roadmap/chrome';
import { ConfidenceBar } from './ConfidenceBar';
import './LearningSection.css';

/**
 * Objective-detail "Learning" panel (design §Learning). What we tried, and what
 * we learned toward this objective — the hypotheses tied to it (`objectives:`
 * link) plus the union of insights those hypotheses feed from. Renders nothing
 * when the layer is disabled (`useTheses().enabled === false`) — the embedding
 * page never needs its own gate.
 */

interface LearningSectionProps {
  objectiveSlug: string;
  onOpenThesis: (slug: string) => void;
  onOpenBoard: (objectiveSlug: string) => void;
}

export function LearningSection({ objectiveSlug, onOpenThesis, onOpenBoard }: LearningSectionProps) {
  const { data } = useTheses();
  const { data: insightSummaries = [] } = useLabInsights();

  const theses = useMemo(
    () => (data?.theses ?? []).filter((t) => t.objectives.includes(objectiveSlug)),
    [data, objectiveSlug],
  );
  const insightSlugs = useMemo(
    () => Array.from(new Set(theses.flatMap((t) => t.insights))),
    [theses],
  );
  const insightBySlug = useMemo(() => new Map(insightSummaries.map((i) => [i.slug, i])), [insightSummaries]);

  if (!data?.enabled) return null;

  return (
    <div className="ls">
      <div className="ls-header">
        <span className="ls-flask" aria-hidden="true">⚗</span>
        <span className="ls-title">Learning</span>
      </div>
      <div className="ls-intro">
        What we tried, and what we learned toward this objective — the hypotheses tied to it and the insights feeding them.
      </div>

      <div className="ls-section-label">HYPOTHESES · {theses.length}</div>
      {theses.length === 0 ? (
        <div className="ls-empty">No hypotheses linked yet.</div>
      ) : (
        <div className="ls-cards">
          {theses.map((t) => (
            <div
              key={t.slug}
              className={`ls-card ls-card--${t.status}`}
              onClick={() => onOpenThesis(t.slug)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenThesis(t.slug); } }}
            >
              <div className="ls-card-claim">{t.claim}</div>
              <div className="ls-card-meta">
                <span className={`ls-card-status thesis-status--${t.status}`}>{t.status}</span>
                <ConfidenceBar
                  confidence={t.confidence}
                  ws={t.confidenceBreakdown.ws}
                  wc={t.confidenceBreakdown.wc}
                  variant="mini"
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {insightSlugs.length > 0 && (
        <>
          <div className="ls-section-label">INSIGHTS FEEDING THEM · {insightSlugs.length}</div>
          <div className="ls-insight-chips">
            {insightSlugs.map((slug) => {
              const summary = insightBySlug.get(slug);
              return (
                <span key={slug} className="ls-insight-chip" title={slug}>
                  <span className="ls-insight-chip-icon">◈</span>
                  <span className="ls-insight-chip-label">{summary?.title ?? slug}</span>
                  {summary && summary.latest !== null && (
                    <span className="ls-insight-chip-value">{fmtMetricValue(summary.latest, summary.unit)}</span>
                  )}
                </span>
              );
            })}
          </div>
        </>
      )}

      <button type="button" className="ls-footer-btn" onClick={() => onOpenBoard(objectiveSlug)}>
        Open Hypothesis board for this objective →
      </button>
    </div>
  );
}
