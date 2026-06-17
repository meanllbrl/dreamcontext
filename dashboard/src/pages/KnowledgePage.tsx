import { useState, useMemo } from 'react';
import { useKnowledgeList, useKnowledge, useToggleKnowledgePin } from '../hooks/useKnowledge';
import { useI18n } from '../context/I18nContext';
import { FullscreenOverlay } from '../components/layout/FullscreenOverlay';
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

// ─── Nested folder tree ──────────────────────────────────────────────────────
//
// Knowledge slugs are full relative paths (`diagrams/competitors/acme/acme.excalidraw`,
// `data-structures/default`). The old grouping split on the FIRST `/` only, so
// every diagram collapsed into one flat "Diagrams" folder. We build a recursive
// tree instead, so category subfolders (e.g. Competitors) nest under Diagrams.
//
// Board self-wrapper collapse: by convention a board lives in a folder named
// after itself (`<title>/<title>.excalidraw`). That wrapper segment is noise in
// the tree, so we drop it — the board renders as a card directly under its
// category, labeled `<title>.excalidraw` (via leafName).

export interface KnowledgeTreeNode {
  name: string;   // last path segment, e.g. "competitors"
  path: string;   // full folder path, e.g. "diagrams/competitors"
  label: string;  // prettyFolder(name)
  folders: KnowledgeTreeNode[];
  cards: KnowledgeListEntry[];
}

/** Total cards in this subtree (including descendants) — shown as the folder count. */
export function countTreeCards(node: KnowledgeTreeNode): number {
  return node.cards.length + node.folders.reduce((sum, f) => sum + countTreeCards(f), 0);
}

/**
 * Build a nested folder tree from a flat entry list. Root-level files (no `/`)
 * are returned separately so they render flat below the folders.
 */
export function buildKnowledgeTree(
  entries: KnowledgeListEntry[],
): { roots: KnowledgeListEntry[]; folders: KnowledgeTreeNode[] } {
  const roots: KnowledgeListEntry[] = [];
  const top: KnowledgeTreeNode = { name: '', path: '', label: '', folders: [], cards: [] };

  const childFolder = (parent: KnowledgeTreeNode, seg: string): KnowledgeTreeNode => {
    let child = parent.folders.find(f => f.name === seg);
    if (!child) {
      const path = parent.path ? `${parent.path}/${seg}` : seg;
      child = { name: seg, path, label: prettyFolder(seg), folders: [], cards: [] };
      parent.folders.push(child);
    }
    return child;
  };

  for (const e of entries) {
    const segments = e.slug.split('/');
    const leaf = segments[segments.length - 1];
    let chain = segments.slice(0, -1);
    // Collapse the board's self-named wrapper folder (`<title>/<title>.excalidraw`).
    if (isExcalidrawSlug(e.slug) && chain.length > 0) {
      const base = leaf.replace(/\.excalidraw$/, '');
      if (chain[chain.length - 1] === base) chain = chain.slice(0, -1);
    }
    if (chain.length === 0) { roots.push(e); continue; }
    let node = top;
    for (const seg of chain) node = childFolder(node, seg);
    node.cards.push(e);
  }

  const sortNode = (n: KnowledgeTreeNode) => {
    n.folders.sort((a, b) => a.label.localeCompare(b.label));
    n.cards.sort((a, b) => leafName(a, n.path).localeCompare(leafName(b, n.path)));
    n.folders.forEach(sortNode);
  };
  sortNode(top);
  return { roots, folders: top.folders };
}

export function KnowledgePage() {
  const { t } = useI18n();
  const { data: entries, isLoading, isError, error } = useKnowledgeList();
  const togglePin = useToggleKnowledgePin();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [viewTab, setViewTab] = useState<'file' | 'preview'>('preview');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [fullscreen, setFullscreen] = useState(false);

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

  // Group entries whose slug carries a folder path (e.g. `diagrams/competitors/acme`)
  // into a recursive collapsible tree. Root-level files render flat below the folders.
  const { roots: rootEntries, folders } = useMemo(() => buildKnowledgeTree(filtered), [filtered]);

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
        <span className="knowledge-card-title">
          {isExcalidrawSlug(entry.slug) && (
            <span className="knowledge-card-icon" title="Diagram / sketch" aria-label="Diagram">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
              </svg>
            </span>
          )}
          <span className="knowledge-card-name">{leafName(entry, folder)}</span>
        </span>
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

  // Recursive: a folder renders its child folders first, then its own cards.
  // Indentation comes from `.knowledge-folder-items` (margin + left border),
  // which nests naturally at each level.
  const renderFolder = (node: KnowledgeTreeNode) => (
    <div key={node.path} className="knowledge-folder">
      <button
        className="knowledge-folder-header"
        onClick={() => toggleFolder(node.path)}
        aria-expanded={isOpen(node.path)}
      >
        <span className="knowledge-folder-chevron">{isOpen(node.path) ? '▾' : '▸'}</span>
        <span className="knowledge-folder-name">{node.label}</span>
        <span className="knowledge-folder-count">{countTreeCards(node)}</span>
      </button>
      {isOpen(node.path) && (
        <div className="knowledge-folder-items">
          {node.folders.map(renderFolder)}
          {node.cards.map(entry => renderCard(entry, node.path))}
        </div>
      )}
    </div>
  );

  // Shared between the inline pane and the full-screen overlay so the active
  // tab and rendered content stay identical in both surfaces.
  const renderTabs = () => (
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
  );

  const renderContent = (detailDoc: NonNullable<typeof detail>) => {
    if (viewTab === 'preview' && detailDoc.content) {
      if (isExcalidrawSlug(detailDoc.slug)) {
        return <ExcalidrawPreview content={detailDoc.content} />;
      }
      const schemaSql = extractSchemaSql(detailDoc.slug, detailDoc.content);
      return schemaSql
        ? <SqlPreview content={schemaSql} />
        : <MarkdownPreview content={detailDoc.content} />;
    }
    return <pre className="core-viewer-content">{detailDoc.content}</pre>;
  };

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

          {folders.map(renderFolder)}

          {rootEntries.map(entry => renderCard(entry))}
        </div>

        <div className="knowledge-detail">
          {!selected && <div className="core-empty">Select a knowledge file to view.</div>}
          {selected && detail && (
            <div className="core-viewer">
              <div className="core-viewer-header">
                <h2 className="core-viewer-title">{detail.name}</h2>
                <div className="core-viewer-actions">
                  {renderTabs()}
                  <button
                    className="core-expand-btn"
                    onClick={() => setFullscreen(true)}
                    title={t('knowledge.fullscreen')}
                    aria-label={t('knowledge.fullscreen')}
                  >
                    ⛶
                  </button>
                </div>
              </div>
              {/* One render site for the content: the fixed-position overlay
                  replaces the pane copy, so the doc is never mounted twice —
                  that would double the heavy excalidraw export and duplicate
                  mermaid element ids. */}
              {fullscreen ? (
                <FullscreenOverlay
                  label={detail.name}
                  actions={renderTabs()}
                  onClose={() => setFullscreen(false)}
                >
                  {renderContent(detail)}
                </FullscreenOverlay>
              ) : (
                renderContent(detail)
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
