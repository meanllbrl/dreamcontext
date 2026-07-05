import { useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import { useTeamUpdates, useTeamFetch } from '../../hooks/useBrainStatus';
import './TeamUpdatesBadge.css';

interface TeamUpdatesBadgeProps {
  /** Scope to one vault (the Launcher per-project chip). Absent = aggregate every vault. */
  vaultName?: string;
  /** Compact rendering for the sidebar rail (icon + count, no "Check now" label). */
  compact?: boolean;
}

/**
 * B6 — the team-updates pill. Polls the CACHE-ONLY `team/updates` endpoint (zero
 * network in its request path) on the app's default tick; "Check now" triggers a
 * real in-process pull-only fetch. Reuses the `UpdateBadge` pill visual
 * (`.update-badge*` classes) so it reads as the same family of nudges.
 */
export function TeamUpdatesBadge({ vaultName, compact }: TeamUpdatesBadgeProps) {
  const { t } = useI18n();
  const { data: vaults } = useTeamUpdates();
  const teamFetch = useTeamFetch();
  const [expanded, setExpanded] = useState(false);

  const relevant = vaultName ? (vaults ?? []).filter((v) => v.name === vaultName) : (vaults ?? []);
  const totalUpdates = relevant.reduce((sum, v) => sum + (v.updates ?? 0), 0);
  const anyPending = relevant.some((v) => v.pendingAgentMerge);

  if (totalUpdates === 0 && !anyPending) return null;

  const handleCheckNow = () => teamFetch.mutate(vaultName);

  return (
    <div className="update-badge team-updates-badge">
      <button
        type="button"
        className="update-badge-trigger"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        title={t('brain.team.title')}
      >
        <span className="update-badge-dot" />
        {!compact && (
          <span className="update-badge-label">
            {anyPending ? t('brain.team.pending') : t('brain.team.updates').replace('{n}', String(totalUpdates))}
          </span>
        )}
        {compact && <span className="update-badge-label">{totalUpdates}</span>}
      </button>
      {expanded && (
        <div className="update-badge-popover team-updates-popover">
          <div className="update-badge-popover-header">
            <span className="update-badge-popover-title">{t('brain.team.title')}</span>
            <button className="update-badge-dismiss" onClick={() => setExpanded(false)} aria-label={t('update.dismiss')}>×</button>
          </div>
          <div className="update-badge-content">
            <ul className="team-updates-list">
              {relevant.map((v) => (
                <li key={v.name} className="team-updates-item">
                  <span className="team-updates-vault">{v.name}</span>
                  <span className="team-updates-count">
                    {v.pendingAgentMerge ? t('brain.team.awaitingAgent') : `${v.updates} ${t('brain.team.updatesShort')}`}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <button
            className="update-badge-action"
            onClick={handleCheckNow}
            disabled={teamFetch.isPending}
          >
            {teamFetch.isPending ? t('brain.team.checking') : t('brain.team.checkNow')}
          </button>
        </div>
      )}
    </div>
  );
}
