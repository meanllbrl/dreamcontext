import type { UnreleasedPayload, Version } from '../../hooks/useVersions';
import { useI18n } from '../../context/I18nContext';

/** The work that is done but in no release yet: tasks, features and changelog entries. */
export function UnreleasedBlock({ data, onOpenTask }: { data: UnreleasedPayload; onOpenTask: (slug: string) => void }) {
  const { t } = useI18n();
  const empty = data.tasks.length === 0 && data.features.length === 0 && data.changelog.length === 0;
  if (empty) return <p className="rel-empty">{t('releases.unreleased.empty')}</p>;
  return (
    <div className="rel-unreleased">
      {data.tasks.length > 0 && (
        <div className="rel-group">
          <h3 className="rel-group-title">{t('releases.tasks').replace('{n}', String(data.tasks.length))}</h3>
          <ul className="rel-items">
            {data.tasks.map((x) => (
              <li key={x.slug}>
                <button type="button" className="rel-link" onClick={() => onOpenTask(x.slug)} lang="und">{x.name || x.slug}</button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {data.features.length > 0 && (
        <div className="rel-group">
          <h3 className="rel-group-title">{t('releases.features').replace('{n}', String(data.features.length))}</h3>
          <ul className="rel-items">
            {data.features.map((f) => <li key={f.slug} className="rel-text">{`${f.slug} · ${f.status}`}</li>)}
          </ul>
        </div>
      )}
      {data.changelog.length > 0 && (
        <div className="rel-group">
          <h3 className="rel-group-title">{t('releases.changelog').replace('{n}', String(data.changelog.length))}</h3>
          <ul className="rel-items">
            {data.changelog.map((c) => (
              <li key={c.index} className="rel-text">
                <span className="rel-tag">{c.entry.type}</span>
                {c.entry.scope && <span className="rel-meta">{c.entry.scope}</span>}
                <span>{c.entry.description}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * The project's releases, newest first: version, date, status and summary, with how many
 * tasks and features each carries. Read-only: they change through the CLI and the release routes, not here.
 */
export function ReleaseList({ releases }: { releases: Version[] }) {
  const { t } = useI18n();
  if (releases.length === 0) return <p className="rel-empty">{t('releases.list.empty')}</p>;
  const ordered = releases.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return (
    <ul className="rel-list">
      {ordered.map((r) => (
        <li key={r.id || r.version} className="rel-release" data-release={r.version}>
          <div className="rel-release-head">
            <span className="rel-version">{r.version}</span>
            <span className="rel-tag">{t(r.status === 'planning' ? 'releases.status.planning' : 'releases.status.released')}</span>
            {r.breaking && <span className="rel-tag rel-tag--warn">{t('releases.breaking')}</span>}
            {r.date && <span className="rel-meta">{r.date}</span>}
          </div>
          {r.summary && <p className="rel-text">{r.summary}</p>}
          <p className="rel-meta">
            {t('releases.counts').replace('{tasks}', String(r.tasks?.length ?? 0)).replace('{features}', String(r.features?.length ?? 0))}
          </p>
        </li>
      ))}
    </ul>
  );
}
