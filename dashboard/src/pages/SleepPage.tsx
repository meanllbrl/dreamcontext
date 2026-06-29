import type { ComponentType } from 'react';
import {
  useSleep,
  getSleepLevel,
  getSleepLevelKey,
  getSleepMood,
  type SessionRecord,
  type DashboardChange,
} from '../hooks/useSleep';
import { useChangelog, type ChangelogEntry } from '../hooks/useChangelog';
import { useI18n } from '../context/I18nContext';
import { SleepyMascot } from '../components/sleepy/SleepyMascot';
import {
  TasksIcon,
  KnowledgeIcon,
  FeaturesIcon,
  CoreIcon,
  MemoryIcon,
} from '../components/sleepy/TypeIcons';
import { tagHue } from '../lib/tagColor';
import './SleepPage.css';

const CHANGELOG_LIMIT = 25;

/** Dashboard-change entities → the page icon + i18n label they map to. */
type DashEntity = DashboardChange['entity'];
const ENTITY_META: Record<DashEntity, { icon: ComponentType<{ size?: number }>; labelKey: string }> = {
  task: { icon: TasksIcon, labelKey: 'sleep.entity.task' },
  knowledge: { icon: KnowledgeIcon, labelKey: 'sleep.entity.knowledge' },
  feature: { icon: FeaturesIcon, labelKey: 'sleep.entity.feature' },
  core: { icon: CoreIcon, labelKey: 'sleep.entity.core' },
  sleep: { icon: MemoryIcon, labelKey: 'sleep.entity.sleep' },
};

/** ISO timestamp → a compact `YYYY-MM-DD HH:MM` for the activity rows. */
function shortTime(iso: string | null): string {
  if (!iso) return '';
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]}` : iso.slice(0, 16);
}

/** One changelog entry card — shared by the cloud's captured group and history. */
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

/** A counter pill in the cloud's stat row. Only rendered when count > 0. */
function CloudStat({ icon: Icon, count, label }: { icon: ComponentType<{ size?: number }>; count: number; label: string }) {
  return (
    <div className="cloud-stat">
      <span className="cloud-stat-icon"><Icon size={16} /></span>
      <span className="cloud-stat-count">{count}</span>
      <span className="cloud-stat-label">{label}</span>
    </div>
  );
}

/** A labelled group of activity rows inside the cloud. */
function CloudGroup({ title, hint, count, children }: { title: string; hint: string; count: number; children: React.ReactNode }) {
  return (
    <div className="cloud-group">
      <div className="cloud-group-head">
        <h3 className="cloud-group-title">{title}</h3>
        <span className="cloud-group-count">{count}</span>
      </div>
      <p className="cloud-group-hint">{hint}</p>
      <div className="cloud-rows">{children}</div>
    </div>
  );
}

/** One work-session row (coding session scored into the debt meter). */
function SessionRow({ session }: { session: SessionRecord }) {
  const { t } = useI18n();
  return (
    <div className="cloud-row">
      <div className="cloud-row-meta">
        <span className="cloud-row-time">{shortTime(session.stopped_at) || t('sleep.cloud.active')}</span>
        {session.score !== null && <span className="session-score">+{session.score}</span>}
        {session.change_count !== null && (
          <span className="session-changes">{session.change_count} changes</span>
        )}
        {session.tool_count != null && (
          <span className="session-changes">{session.tool_count} tools</span>
        )}
      </div>
      {session.last_assistant_message && (
        <p className="cloud-row-text">
          {session.last_assistant_message.slice(0, 160)}
          {session.last_assistant_message.length > 160 ? '…' : ''}
        </p>
      )}
    </div>
  );
}

/** One dashboard-activity row (a manual edit you made in the dashboard). */
function DashRow({ change }: { change: DashboardChange }) {
  const { t } = useI18n();
  const meta = ENTITY_META[change.entity];
  const Icon = meta?.icon ?? MemoryIcon;
  return (
    <div className="cloud-row">
      <div className="cloud-row-meta">
        <span className="cloud-entity">
          <Icon size={14} />
          {meta ? t(meta.labelKey) : change.entity}
        </span>
        <span className={`cloud-action cloud-action--${change.action}`}>{change.action}</span>
        <span className="cloud-row-time">{shortTime(change.timestamp)}</span>
      </div>
      <p className="cloud-row-text">{change.summary}</p>
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
  const mood = getSleepMood(sleep.debt);

  // Split the changelog: entries dated after the last sleep will fold into the
  // next consolidation (surfaced up front, before the history); the rest is the
  // shipped history grouped by day, like the chronological core files.
  const lastSleep = sleep.last_sleep;
  const entries = changelog?.entries ?? [];
  const pending = lastSleep ? entries.filter((e) => e.date > lastSleep) : [];
  const history = lastSleep ? entries.filter((e) => e.date <= lastSleep) : entries;
  const historyShown = history.slice(0, CHANGELOG_LIMIT);
  const historyDays = groupByDay(historyShown);
  const historyHidden = history.length - historyShown.length;

  // The sleep cloud: everything the next consolidation will ingest — the manual
  // dashboard edits, the coding sessions, the auto-tagged highlights, and the
  // changelog notes captured since the last sleep. Dashboard activity is grouped
  // by entity so task-management work reads as one cluster.
  const sessions = sleep.sessions;
  const dashChanges = sleep.dashboard_changes;
  const bookmarks = sleep.bookmarks ?? [];
  const dashByEntity = dashChanges.reduce<Record<string, DashboardChange[]>>((acc, c) => {
    (acc[c.entity] ??= []).push(c);
    return acc;
  }, {});
  const cloudTotal = sessions.length + dashChanges.length + bookmarks.length + pending.length;

  return (
    <div className="sleep-page">
      {/* One card: the Sleepy companion up top, then the sleep cloud flowing on
          inside the same surface — everything the next consolidation will weave in. */}
      <section className={`sleep-card sleep-card--${levelKey}`}>
        {/* Hero band — the companion, its mood mirroring the project's rest. */}
        <div className="sleep-hero">
          <div className="sleep-hero-stage">
            <div className="sleep-hero-aura" aria-hidden />
            <SleepyMascot mood={mood} size={148} />
          </div>

          <div className="sleep-hero-body">
            <div className="sleep-hero-headline">
              <span className="sleep-hero-level">{level}</span>
              <span className="sleep-hero-debt">
                <span className="sleep-hero-debt-num">{sleep.debt}</span>
                <span className="sleep-hero-debt-unit">{t('sleep.debt')}</span>
              </span>
              {cloudTotal > 0 && (
                <span className="sleep-hero-cloud-count">
                  {cloudTotal} {cloudTotal === 1 ? t('sleep.cloud.item') : t('sleep.cloud.items')}
                </span>
              )}
            </div>

            <p className="sleep-hero-tagline">{t(`sleep.tagline.${levelKey}`)}</p>

            <div className="sleep-hero-meta">
              <div className="sleep-hero-meta-item">
                <span className="sleep-hero-meta-label">{t('sleep.last_sleep')}</span>
                <span className="sleep-hero-meta-value">{sleep.last_sleep ?? t('sleep.never')}</span>
              </div>
              {sleep.last_sleep_summary && (
                <div className="sleep-hero-meta-item sleep-hero-meta-item--summary">
                  <span className="sleep-hero-meta-label">{t('sleep.summary')}</span>
                  <span className="sleep-hero-meta-value sleep-hero-meta-value--summary">
                    {sleep.last_sleep_summary.slice(0, 220)}
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* The sleep cloud — continues inside the same card, no second header. */}
        {cloudTotal === 0 ? (
          <div className="sleep-cloud sleep-cloud--empty">
            <div className="sleep-cloud-empty">
              <p className="sleep-cloud-empty-title">{t('sleep.cloud.empty.title')}</p>
              <p className="sleep-cloud-empty-sub">{t('sleep.cloud.empty.sub')}</p>
            </div>
          </div>
        ) : (
          <div className="sleep-cloud">
            <div className="sleep-cloud-stats">
              {dashChanges.length > 0 && (
                <CloudStat icon={TasksIcon} count={dashChanges.length} label={t('sleep.cloud.stat.dashboard')} />
              )}
              {sessions.length > 0 && (
                <CloudStat icon={CoreIcon} count={sessions.length} label={t('sleep.cloud.stat.sessions')} />
              )}
              {bookmarks.length > 0 && (
                <CloudStat icon={MemoryIcon} count={bookmarks.length} label={t('sleep.cloud.stat.highlights')} />
              )}
              {pending.length > 0 && (
                <CloudStat icon={FeaturesIcon} count={pending.length} label={t('sleep.cloud.stat.changelog')} />
              )}
            </div>

            <div className="sleep-cloud-body">
              {dashChanges.length > 0 && (
                <CloudGroup
                  title={t('sleep.cloud.group.dashboard')}
                  hint={t('sleep.cloud.group.dashboard.hint')}
                  count={dashChanges.length}
                >
                  {Object.entries(dashByEntity).flatMap(([, items]) =>
                    items.map((change, i) => <DashRow key={`${change.entity}-${i}`} change={change} />),
                  )}
                </CloudGroup>
              )}

              {sessions.length > 0 && (
                <CloudGroup
                  title={t('sleep.cloud.group.sessions')}
                  hint={t('sleep.cloud.group.sessions.hint')}
                  count={sessions.length}
                >
                  {sessions.map((session, i) => (
                    <SessionRow key={i} session={session} />
                  ))}
                </CloudGroup>
              )}

              {bookmarks.length > 0 && (
                <CloudGroup
                  title={t('sleep.cloud.group.highlights')}
                  hint={t('sleep.cloud.group.highlights.hint')}
                  count={bookmarks.length}
                >
                  {bookmarks.map((bk) => (
                    <div key={bk.id} className="cloud-row">
                      <div className="cloud-row-meta">
                        <span className="cloud-salience" data-salience={bk.salience}>
                          {'★'.repeat(Math.max(1, Math.min(3, bk.salience)))}
                        </span>
                        <span className="cloud-row-time">{shortTime(bk.created_at)}</span>
                      </div>
                      <p className="cloud-row-text">{bk.text}</p>
                    </div>
                  ))}
                </CloudGroup>
              )}

              {pending.length > 0 && (
                <CloudGroup
                  title={t('sleep.cloud.group.changelog')}
                  hint={t('sleep.cloud.group.changelog.hint')}
                  count={pending.length}
                >
                  {pending.map((entry, i) => (
                    <ChangelogItem key={`p-${i}`} entry={entry} />
                  ))}
                </CloudGroup>
              )}
            </div>
          </div>
        )}
      </section>

      {history.length > 0 && (
        <div className="sleep-section">
          <h2 className="sleep-section-title">{t('sleep.changelog')} ({history.length})</h2>

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
    </div>
  );
}
