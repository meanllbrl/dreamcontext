import { useState, useMemo } from 'react';
import { useKnowledgeList, useKnowledge, useToggleKnowledgePin } from '../hooks/useKnowledge';
import { useI18n } from '../context/I18nContext';
import { MarkdownPreview } from '../components/core/MarkdownPreview';
import { SqlPreview } from '../components/core/SqlPreview';
import { ExcalidrawPreview } from '../components/core/ExcalidrawPreview';
import { isExcalidrawSlug } from '../lib/excalidraw';
import { tagHue } from '../lib/tagColor';
import './KnowledgePage.css';

// Data-structures knowledge files store their schema as a fenced ```sql block.
// Extract the raw SQL so it can be rendered as a relational/ER view (like the
// Core page does for standalone .sql files) instead of plain syntax highlighting.
const SQL_FENCE = /```sql\s*\n([\s\S]*?)```/i;

function extractSchemaSql(slug: string, content: string): string | null {
  if (!slug.startsWith('data-structures/')) return null;
  const match = content.match(SQL_FENCE);
  return match ? match[1] : null;
}

type KnowledgeListEntry = { slug: string; name: string; description: string; tags: string[]; pinned: boolean };

// "data-structures" -> "Data Structures", "diagrams" -> "Diagrams".
function prettyFolder(folder: string): string {
  return folder
    .split(/[-_]/)
    .map(w => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/**
 * Compute the display leaf name for a card inside a folder group.
 *
 * For Excalidraw boards in a depth-2 nested folder (e.g. slug =
 * `diagrams/my-board/my-board.excalidraw`), using the last path segment
 * collapses the redundant `<title>/<title>.excalidraw` pattern to just
 * `my-board.excalidraw`. This is basename logic, NOT the old prefix-strip
 * which left `my-board/my-board.excalidraw` intact at depth-2.
 *
 * Flat boards (`diagrams/recall.excalidraw`) have no sub-segment — the slug
 * has exactly one `/`, so the last segment IS the plain leaf.
 *
 * For non-Excalidraw entries, we still strip the `<folder>/` prefix when the
 * name is still the raw slug path (no custom frontmatter name), so the card
 * reads "default" instead of "data-structures/default".
 */
export function leafName(entry: KnowledgeListEntry, folder: string | null): string {
  if (!folder) return entry.name;
  if (isExcalidrawSlug(entry.slug)) {
    // Use the last path segment: `diagrams/my-board/my-board.excalidraw`
    // → `my-board.excalidraw`. Works for both flat and nested layouts.
    const lastSlash = entry.slug.lastIndexOf('/');
    return lastSlash >= 0 ? entry.slug.slice(lastSlash + 1) : entry.slug;
  }
  // Non-Excalidraw: strip the `<folder>/` prefix when the name matches the slug path.
  if (entry.name.startsWith(`${folder}/`)) return entry.name.slice(folder.length + 1);
  return entry.name;
}

export function KnowledgePage() {
  const { t } = useI18n();
  const { data: entries, isLoading, isError, error } = useKnowledgeList();
  const togglePin = useToggleKnowledgePin();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [viewTab, setViewTab] = useState<'file' | 'preview'>('preview');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

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

  // Group entries whose slug carries a folder path (e.g. `diagrams/recall`) into
  // collapsible folders. Root-level files render flat below the folders.
  const { rootEntries, folders } = useMemo(() => {
    const roots: KnowledgeListEntry[] = [];
    const map = new Map<string, KnowledgeListEntry[]>();
    for (const e of filtered) {
      const idx = e.slug.indexOf('/');
      if (idx === -1) { roots.push(e); continue; }
      const folder = e.slug.slice(0, idx);
      const bucket = map.get(folder);
      if (bucket) bucket.push(e);
      else map.set(folder, [e]);
    }
    const grouped = [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([folder, items]) => ({ folder, label: prettyFolder(folder), entries: items }));
    return { rootEntries: roots, folders: grouped };
  }, [filtered]);

  // While searching, auto-expand every folder so matches are visible.
  const searching = search.trim().length > 0;
  const isOpen = (folder: string) => searching || expanded.has(folder);
  const toggleFolder = (folder: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });
  };

  const renderCard = (entry: KnowledgeListEntry, folder: string | null = null) => (
    <button
      key={entry.slug}
      className={`knowledge-card ${selected === entry.slug ? 'knowledge-card--active' : ''}`}
      onClick={() => { setSelected(entry.slug); setViewTab('preview'); }}
    >
      <div className="knowledge-card-header">
        <span className="knowledge-card-name">{leafName(entry, folder)}</span>
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
  );

  if (isLoading) return <div className="loading">{t('common.loading')}</div>;
  if (isError) return <div className="error-state">Failed to load knowledge. {error?.message}</div>;

  return (
    <div className="knowledge-page">
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

          {folders.map(group => (
            <div key={group.folder} className="knowledge-folder">
              <button
                className="knowledge-folder-header"
                onClick={() => toggleFolder(group.folder)}
                aria-expanded={isOpen(group.folder)}
              >
                <span className="knowledge-folder-chevron">{isOpen(group.folder) ? '▾' : '▸'}</span>
                <span className="knowledge-folder-name">{group.label}</span>
                <span className="knowledge-folder-count">{group.entries.length}</span>
              </button>
              {isOpen(group.folder) && (
                <div className="knowledge-folder-items">
                  {group.entries.map(entry => renderCard(entry, group.folder))}
                </div>
              )}
            </div>
          ))}

          {rootEntries.map(entry => renderCard(entry))}
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
                (() => {
                  if (isExcalidrawSlug(detail.slug)) {
                    return <ExcalidrawPreview content={detail.content} />;
                  }
                  const schemaSql = extractSchemaSql(detail.slug, detail.content);
                  return schemaSql
                    ? <SqlPreview content={schemaSql} />
                    : <MarkdownPreview content={detail.content} />;
                })()
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
