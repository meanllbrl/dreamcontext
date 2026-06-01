import { useSleep, getSleepLevel, getSleepLevelKey } from '../hooks/useSleep';
import { useChangelog, type ChangelogEntry } from '../hooks/useChangelog';
import { useI18n } from '../context/I18nContext';
import { tagHue } from '../lib/tagColor';
import './SleepPage.css';

const CHANGELOG_LIMIT = 25;

/** One changelog entry card — shared by the pending group and the day groups. */
function ChangelogItem({ entry }: { entry: ChangelogEntry }) {
  const { t } = useI18n();
  return (
    <div className="changelog-item">
      <div className="changelog-meta">
        <span className="task-tag" data-hue={tagHue(entry.type)}>{entry.type}</span>
        {entry.scope && <span className="changelog-scope">{entry.scope}</span>}
        {entry.breaking && (
          <span className="changelog-breaking">{t('sleep.changelog.breaking')}</span>
        )}
      </div>
      <p className="changelog-summary">{entry.summary}</p>
      {entry.description && <p className="changelog-desc">{entry.description}</p>}
    </div>
  );
}

/** Group consecutive entries by their date, preserving the newest-first order. */
function groupByDay(entries: ChangelogEntry[]): { date: string; items: ChangelogEntry[] }[] {
  const groups: { date: string; items: ChangelogEntry[] }[] = [];
  for (const entry of entries) {
    const last = groups[groups.length - 1];
    if (last && last.date === entry.date) last.items.push(entry);
    else groups.push({ date: entry.date, items: [entry] });
  }
  return groups;
}

export function SleepPage() {
  const { t } = useI18n();
  const { data: sleep, isLoading, isError, error } = useSleep();
  const { data: changelog } = useChangelog();

  if (isLoading || !sleep) {
    return <div className="loading">{t('common.loading')}</div>;
  }
  if (isError) {
    return <div className="error-state">Failed to load sleep state. {error?.message}</div>;
  }

  const level = getSleepLevel(sleep.debt);
  const levelKey = getSleepLevelKey(sleep.debt);

  // Split the changelog: entries dated after the last sleep will fold into the
  // next consolidation (shown separately); the rest is history grouped by day,
  // like the chronological layout of the core files.
  const lastSleep = sleep.last_sleep;
  const entries = changelog?.entries ?? [];
  const pending = lastSleep ? entries.filter((e) => e.date > lastSleep) : [];
  const history = lastSleep ? entries.filter((e) => e.date <= lastSleep) : entries;
  const historyShown = history.slice(0, CHANGELOG_LIMIT);
  const historyDays = groupByDay(historyShown);
  const historyHidden = history.length - historyShown.length;

  return (
    <div className="sleep-page">
      <h1 className="page-title">{t('sleep.title')}</h1>

      <div className="sleep-overview">
        <div className={`sleep-gauge sleep-gauge--${levelKey}`}>
          <span className="sleep-gauge-number">{sleep.debt}</span>
          <span className="sleep-gauge-label">{level}</span>
        </div>

        <div className="sleep-details">
          <div className="sleep-detail">
            <span className="sleep-detail-label">{t('sleep.last_sleep')}</span>
            <span className="sleep-detail-value">{sleep.last_sleep ?? 'Never'}</span>
          </div>
          {sleep.last_sleep_summary && (
            <div className="sleep-detail">
              <span className="sleep-detail-label">Summary</span>
              <span className="sleep-detail-value sleep-detail-value--summary">
                {sleep.last_sleep_summary.slice(0, 200)}
              </span>
            </div>
          )}
        </div>
      </div>

      {entries.length > 0 && (
        <div className="sleep-section">
          <h2 className="sleep-section-title">{t('sleep.changelog')} ({entries.length})</h2>

          {pending.length > 0 && (
            <div className="changelog-group changelog-group--pending">
              <h3 className="changelog-group-title">
                {t('sleep.changelog.pending')} ({pending.length})
              </h3>
              <div className="changelog-list">
                {pending.map((entry, i) => (
                  <ChangelogItem key={`p-${i}`} entry={entry} />
                ))}
              </div>
            </div>
          )}

          {historyDays.map((group) => (
            <div key={group.date} className="changelog-group">
              <h3 className="changelog-group-title changelog-group-title--day">{group.date}</h3>
              <div className="changelog-list">
                {group.items.map((entry, i) => (
                  <ChangelogItem key={`${group.date}-${i}`} entry={entry} />
                ))}
              </div>
            </div>
          ))}

          {historyHidden > 0 && (
            <p className="changelog-more">
              {historyHidden} {t('sleep.changelog.earlier')}
            </p>
          )}
        </div>
      )}

      {sleep.sessions.length > 0 && (
        <div className="sleep-section">
          <h2 className="sleep-section-title">{t('sleep.sessions')} ({sleep.sessions.length})</h2>
          <div className="session-list">
            {sleep.sessions.map((session, i) => (
              <div key={i} className="session-item">
                <div className="session-header">
                  <span className="session-time">{session.stopped_at ?? 'Active'}</span>
                  {session.score !== null && (
                    <span className="session-score">+{session.score}</span>
                  )}
                  {session.change_count !== null && (
                    <span className="session-changes">{session.change_count} changes</span>
                  )}
                  {session.tool_count != null && (
                    <span className="session-changes">{session.tool_count} tools</span>
                  )}
                </div>
                {session.last_assistant_message && (
                  <p className="session-message">
                    {session.last_assistant_message.slice(0, 150)}
                    {session.last_assistant_message.length > 150 ? '...' : ''}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {sleep.dashboard_changes.length > 0 && (
        <div className="sleep-section">
          <h2 className="sleep-section-title">Dashboard Changes ({sleep.dashboard_changes.length})</h2>
          <div className="session-list">
            {sleep.dashboard_changes.map((change, i) => (
              <div key={i} className="session-item">
                <div className="session-header">
                  <span className="session-time">{change.timestamp}</span>
                  <span className="session-changes">{change.entity} / {change.action}</span>
                </div>
                <p className="session-message">{change.summary}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
