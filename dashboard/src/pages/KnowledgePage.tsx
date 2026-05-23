import { useState, useMemo } from 'react';
import { useKnowledgeList, useKnowledge, useToggleKnowledgePin } from '../hooks/useKnowledge';
import { useI18n } from '../context/I18nContext';
import { MarkdownPreview } from '../components/core/MarkdownPreview';
import { tagHue } from '../lib/tagColor';
import './KnowledgePage.css';

export function KnowledgePage() {
  const { t } = useI18n();
  const { data: entries, isLoading, isError, error } = useKnowledgeList();
  const togglePin = useToggleKnowledgePin();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [viewTab, setViewTab] = useState<'file' | 'preview'>('preview');

  const { data: detail } = useKnowledge(selected ?? '');

  const filtered = useMemo(() => {
    if (!entries) return [];
    if (!search.trim()) return entries;
    const q = search.toLowerCase();
    return entries.filter(e =>
      e.name.toLowerCase().includes(q) ||
      e.description.toLowerCase().includes(q) ||
      e.tags.some(t => t.toLowerCase().includes(q))
    );
  }, [entries, search]);

  if (isLoading) return <div className="loading">{t('common.loading')}</div>;
  if (isError) return <div className="error-state">Failed to load knowledge. {error?.message}</div>;

  return (
    <div className="knowledge-page">
      <h1 className="page-title">{t('knowledge.title')}</h1>

      <input
        className="knowledge-search"
        placeholder={t('knowledge.search')}
        value={search}
        onChange={e => setSearch(e.target.value)}
      />

      <div className="knowledge-layout">
        <div className="knowledge-list">
          {filtered.length === 0 && (
            <div className="core-empty">{t('common.empty')}</div>
          )}
          {filtered.map(entry => (
            <button
              key={entry.slug}
              className={`knowledge-card ${selected === entry.slug ? 'knowledge-card--active' : ''}`}
              onClick={() => { setSelected(entry.slug); setViewTab('preview'); }}
            >
              <div className="knowledge-card-header">
                <span className="knowledge-card-name">{entry.name}</span>
                <button
                  className={`pin-btn ${entry.pinned ? 'pin-btn--active' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    togglePin.mutate({ slug: entry.slug, pinned: !entry.pinned });
                  }}
                  title={entry.pinned ? t('knowledge.unpin') : t('knowledge.pin')}
                >
                  {entry.pinned ? '◆' : '◇'}
                </button>
              </div>
              {entry.description && (
                <p className="knowledge-card-desc">{entry.description}</p>
              )}
              <div className="knowledge-card-tags">
                {entry.tags.map(tag => (
                  <span key={tag} className="task-tag" data-hue={tagHue(tag)}>{tag}</span>
                ))}
              </div>
            </button>
          ))}
        </div>

        <div className="knowledge-detail">
          {!selected && <div className="core-empty">Select a knowledge file to view.</div>}
          {selected && detail && (
            <div className="core-viewer">
              <div className="core-viewer-header">
                <h2 className="core-viewer-title">{detail.name}</h2>
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
              {viewTab === 'preview' && detail.content ? (
                <MarkdownPreview content={detail.content} />
              ) : (
                <pre className="core-viewer-content">{detail.content}</pre>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
