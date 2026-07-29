import { useMemo, useState } from 'react';
import './JsonPreview.css';

// ── Changelog types ──

interface ChangelogEntry {
  date: string;
  type: string;
  scope: string;
  description: string;
  breaking: boolean;
}

// ── Release types ──

interface ReleaseEntry {
  id?: string;
  version: string;
  date: string;
  summary: string;
  breaking: boolean;
  features?: string[];
  tasks?: string[];
  changelog?: ChangelogEntry[];
  /**
   * Person slugs derived at record time from the release's changelog `authors`
   * and its tasks' `person:` tags. Absent (never `[]`) on a vault with no
   * roster, and on every release recorded before 0.23.0 — so the section below
   * renders only when there is something true to say.
   */
  contributors?: string[];
}

// ── Type badge colors ──

const TYPE_COLORS: Record<string, string> = {
  feat: 'type--feat',
  fix: 'type--fix',
  refactor: 'type--refactor',
  chore: 'type--chore',
  docs: 'type--docs',
  test: 'type--test',
  perf: 'type--perf',
};

function TypeBadge({ type }: { type: string }) {
  return (
    <span className={`json-type-badge ${TYPE_COLORS[type] ?? ''}`}>
      {type}
    </span>
  );
}

function BreakingBadge() {
  return <span className="json-breaking-badge">BREAKING</span>;
}

// ── Changelog Preview ──

function ChangelogPreview({ data }: { data: ChangelogEntry[] }) {
  const [filter, setFilter] = useState<string>('all');
  const [expandedIdx, setExpandedIdx] = useState<Set<number>>(new Set());

  const dateGroups = useMemo(() => {
    const filtered = filter === 'all' ? data : data.filter(e => e.type === filter);
    const groups = new Map<string, { entry: ChangelogEntry; index: number }[]>();
    for (let i = 0; i < filtered.length; i++) {
      const entry = filtered[i];
      const list = groups.get(entry.date) || [];
      list.push({ entry, index: i });
      groups.set(entry.date, list);
    }
    return groups;
  }, [data, filter]);

  const toggle = (idx: number) => {
    setExpandedIdx(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const stats = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const e of data) {
      counts[e.type] = (counts[e.type] || 0) + 1;
    }
    return counts;
  }, [data]);

  return (
    <div className="json-preview">
      <div className="json-preview-header">
        <div className="json-preview-stats">
          <span className="json-preview-total">{data.length} entries</span>
          {Object.entries(stats).sort((a, b) => b[1] - a[1]).map(([type, count]) => (
            <button
              key={type}
              className={`json-stat-chip ${filter === type ? 'json-stat-chip--active' : ''}`}
              onClick={() => setFilter(f => f === type ? 'all' : type)}
            >
              <TypeBadge type={type} /> {count}
            </button>
          ))}
        </div>
      </div>

      <div className="json-timeline">
        {Array.from(dateGroups.entries()).map(([date, items]) => (
          <div key={date} className="json-date-group">
            <div className="json-date-marker">
              <span className="json-date-dot" />
              <span className="json-date-label">{date}</span>
              <span className="json-date-count">{items.length}</span>
            </div>
            <div className="json-date-entries">
              {items.map(({ entry, index }) => {
                const isExpanded = expandedIdx.has(index);
                const scopeShort = entry.scope.length > 50
                  ? entry.scope.slice(0, 47) + '...'
                  : entry.scope;
                return (
                  <div
                    key={index}
                    className={`json-entry ${isExpanded ? 'json-entry--expanded' : ''}`}
                    onClick={() => toggle(index)}
                  >
                    <div className="json-entry-header">
                      <TypeBadge type={entry.type} />
                      {entry.breaking && <BreakingBadge />}
                      <span className="json-entry-scope" title={entry.scope}>{scopeShort}</span>
                    </div>
                    <div className={`json-entry-desc ${isExpanded ? '' : 'json-entry-desc--clamped'}`}>
                      {entry.description}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Release Preview ──

function ReleasePreview({ data }: { data: ReleaseEntry[] }) {
  const [expandedIdx, setExpandedIdx] = useState<Set<number>>(new Set([0]));

  const toggle = (idx: number) => {
    setExpandedIdx(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  return (
    <div className="json-preview">
      <div className="json-preview-header">
        <span className="json-preview-total">{data.length} release{data.length !== 1 ? 's' : ''}</span>
      </div>

      <div className="json-releases">
        {data.map((release, idx) => {
          const isExpanded = expandedIdx.has(idx);
          return (
            <div key={release.version} className={`json-release ${isExpanded ? 'json-release--expanded' : ''}`}>
              <div className="json-release-header" onClick={() => toggle(idx)}>
                <span className="json-release-version">{release.version}</span>
                <span className="json-release-date">{release.date}</span>
                {release.breaking && <BreakingBadge />}
                <span className="json-release-meta">
                  {release.features?.length ? `${release.features.length} features` : ''}
                  {release.features?.length && release.tasks?.length ? ' / ' : ''}
                  {release.tasks?.length ? `${release.tasks.length} task${release.tasks.length !== 1 ? 's' : ''}` : ''}
                </span>
                <span className={`json-release-chevron ${isExpanded ? 'json-release-chevron--open' : ''}`}>
                  &#9654;
                </span>
              </div>

              {isExpanded && (
                <div className="json-release-body">
                  <div className="json-release-summary">{release.summary}</div>

                  {release.contributors && release.contributors.length > 0 && (
                    <div className="json-release-section">
                      <div className="json-release-section-title">Contributors</div>
                      <div className="json-release-ids">
                        {release.contributors.map(slug => (
                          <span key={slug} className="json-id-chip json-id-chip--person">{slug}</span>
                        ))}
                      </div>
                    </div>
                  )}

                  {release.features && release.features.length > 0 && (
                    <div className="json-release-section">
                      <div className="json-release-section-title">Features</div>
                      <div className="json-release-ids">
                        {release.features.map(id => (
                          <span key={id} className="json-id-chip json-id-chip--feature">{id}</span>
                        ))}
                      </div>
                    </div>
                  )}

                  {release.tasks && release.tasks.length > 0 && (
                    <div className="json-release-section">
                      <div className="json-release-section-title">Tasks</div>
                      <div className="json-release-ids">
                        {release.tasks.map(id => (
                          <span key={id} className="json-id-chip json-id-chip--task">{id}</span>
                        ))}
                      </div>
                    </div>
                  )}

                  {release.changelog && release.changelog.length > 0 && (
                    <div className="json-release-section">
                      <div className="json-release-section-title">
                        Changelog ({release.changelog.length})
                      </div>
                      <div className="json-release-changelog">
                        {release.changelog.map((entry, i) => (
                          <div key={i} className="json-release-cl-entry">
                            <TypeBadge type={entry.type} />
                            {entry.breaking && <BreakingBadge />}
                            <span className="json-release-cl-scope">{entry.scope}</span>
                            <span className="json-release-cl-desc">{entry.description}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Main export ──

export function JsonPreview({ data, filename }: { data: unknown; filename: string }) {
  if (!Array.isArray(data) || data.length === 0) {
    return (
      <div className="json-preview">
        <div className="json-preview-empty">No data found in this file.</div>
      </div>
    );
  }

  const isChangelog = filename.toLowerCase().includes('changelog');
  const isRelease = filename.toLowerCase().includes('release');

  if (isChangelog && data[0]?.type && data[0]?.description) {
    return <ChangelogPreview data={data as ChangelogEntry[]} />;
  }

  if (isRelease && data[0]?.version) {
    return <ReleasePreview data={data as ReleaseEntry[]} />;
  }

  // Fallback: generic JSON array as cards
  return (
    <div className="json-preview">
      <div className="json-preview-header">
        <span className="json-preview-total">{data.length} items</span>
      </div>
      <div className="json-generic-list">
        {data.map((item, i) => (
          <pre key={i} className="json-generic-item">
            {JSON.stringify(item, null, 2)}
          </pre>
        ))}
      </div>
    </div>
  );
}
