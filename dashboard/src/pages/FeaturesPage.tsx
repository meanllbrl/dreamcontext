import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { useI18n } from '../context/I18nContext';
import { MarkdownPreview } from '../components/core/MarkdownPreview';
import { tagHue } from '../lib/tagColor';
import './FeaturesPage.css';

interface FeatureFreshness {
  level: 'fresh' | 'stale' | 'unknown';
  daysSinceUpdate: number | null;
  note: string;
}

interface Feature {
  slug: string;
  id: string;
  status: string;
  created: string;
  updated: string;
  tags: string[];
  related_tasks: string[];
  freshness?: FeatureFreshness;
}

interface FeatureDetail extends Feature {
  content: string;
  sections: string[];
  sectionContents: Record<string, string>;
}

export function FeaturesPage() {
  const { t } = useI18n();
  const [selected, setSelected] = useState<string | null>(null);
  const [viewTab, setViewTab] = useState<'file' | 'preview'>('preview');
  const [search, setSearch] = useState('');

  const { data: featuresData, isLoading, isError, error } = useQuery({
    queryKey: ['features'],
    queryFn: () => api.get<{ features: Feature[] }>('/features'),
  });

  const allFeatures = featuresData?.features ?? [];
  const filtered = useMemo(() => {
    if (!search.trim()) return allFeatures;
    const q = search.toLowerCase();
    return allFeatures.filter(f =>
      f.slug.toLowerCase().includes(q) ||
      f.status.toLowerCase().includes(q) ||
      f.tags.some(tag => tag.toLowerCase().includes(q))
    );
  }, [allFeatures, search]);

  const { data: featureDetail } = useQuery({
    queryKey: ['features', selected],
    queryFn: () => api.get<{ feature: FeatureDetail }>(`/features/${selected}`),
    enabled: !!selected,
    select: (data) => data.feature,
  });

  if (isLoading) return <div className="loading">{t('common.loading')}</div>;
  if (isError) return <div className="error-state">Failed to load features. {error?.message}</div>;

  return (
    <div className="features-page">
      <input
        className="features-search"
        placeholder={t('features.search')}
        value={search}
        onChange={e => setSearch(e.target.value)}
      />

      <div className="features-layout">
        <div className="features-list">
          {filtered.length === 0 && <div className="core-empty">{t('common.empty')}</div>}
          {filtered.map((feature, index) => (
            <button
              key={feature.slug}
              className={`feature-card ${selected === feature.slug ? 'feature-card--active' : ''} animate-stagger animate-stagger-${Math.min(index + 1, 8)}`}
              onClick={() => { setSelected(feature.slug); setViewTab('preview'); }}
            >
              <div className="feature-card-header">
                <span className="feature-card-name">{feature.slug}</span>
                <div className="feature-card-badges">
                  {feature.freshness?.level === 'stale' && (
                    <span className="feature-freshness feature-freshness--stale">stale</span>
                  )}
                  <span className={`feature-status feature-status--${feature.status}`}>
                    {feature.status}
                  </span>
                </div>
              </div>
              <div className="knowledge-card-tags">
                {feature.tags.map(tag => (
                  <span key={tag} className="task-tag" data-hue={tagHue(tag)}>{tag}</span>
                ))}
              </div>
            </button>
          ))}
        </div>

        <div className="features-detail">
          {!selected && <div className="core-empty">Select a feature to view.</div>}
          {selected && featureDetail && (
            <div className="core-viewer">
              <div className="core-viewer-header">
                <h2 className="core-viewer-title">{featureDetail.slug}</h2>
                <div className="core-viewer-actions">
                  <div className="core-tabs">
                    <button
                      className={`core-tab ${viewTab === 'file' ? 'core-tab--active' : ''}`}
                      onClick={() => setViewTab('file')}
                    >
                      File
                    </button>
                    <button
                      className={`core-tab ${viewTab === 'preview' ? 'core-tab--active' : ''}`}
                      onClick={() => setViewTab('preview')}
                    >
                      Preview
                    </button>
                  </div>
                </div>
              </div>

              <div className="feature-meta">
                <span>Status: {featureDetail.status}</span>
                <span>Created: {featureDetail.created}</span>
                <span>Updated: {featureDetail.updated}</span>
              </div>
              {featureDetail.related_tasks.length > 0 && (
                <div className="feature-tasks">
                  Related tasks: {featureDetail.related_tasks.join(', ')}
                </div>
              )}

              {viewTab === 'preview' && featureDetail.content ? (
                <MarkdownPreview content={featureDetail.content} />
              ) : (
                <div className="feature-viewer">
                  {featureDetail.sections.map(section => (
                    <div key={section} className="feature-section">
                      <h3 className="feature-section-title">{section}</h3>
                      <pre className="feature-section-content">
                        {featureDetail.sectionContents[section] || '(empty)'}
                      </pre>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
