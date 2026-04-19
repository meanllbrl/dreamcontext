import { type CSSProperties } from 'react';
import type { GraphGroup, GraphNode } from '../../hooks/useGraph';
import { useNodeContent } from '../../hooks/useNodeContent';
import { MarkdownPreview } from '../core/MarkdownPreview';

const DEFAULT_GROUP_COLORS: Record<GraphGroup, string> = {
  soul: '#4fb3e6',
  user: '#4fb3e6',
  memory: '#4fb3e6',
  core: '#4fb3e6',
  feature: '#10b981',
  task: '#f59e0b',
  knowledge: '#a78bfa',
  release: '#e11d74',
  inbox: '#9ca3af',
  tag: '#10b981',
};

const GROUP_LABEL: Record<GraphGroup, string> = {
  soul: 'Soul',
  user: 'User',
  memory: 'Memory',
  core: 'Core',
  feature: 'Feature',
  task: 'Task',
  knowledge: 'Knowledge',
  release: 'Release',
  inbox: 'Inbox',
  tag: 'Tag',
};

const LINK_KIND_LABEL: Record<string, string> = {
  related_feature: 'feature',
  parent_task: 'parent',
  release_includes: 'released',
  sibling_core: 'spine',
  has_tag: 'tag',
};

export type BrainNavigatePage = 'tasks' | 'features' | 'knowledge' | 'core';

function groupForNavigate(group: GraphGroup): BrainNavigatePage | null {
  if (group === 'task') return 'tasks';
  if (group === 'feature') return 'features';
  if (group === 'knowledge') return 'knowledge';
  if (group === 'soul' || group === 'user' || group === 'memory' || group === 'core') return 'core';
  return null;
}

interface NodeDrawerProps {
  node: GraphNode | null;
  onClose: () => void;
  onSelectRelated: (id: string) => void;
  relatedNodes: Array<{ node: GraphNode; kind: string }>;
  inDegree: number;
  totalDegree: number;
  onNavigate?: (page: BrainNavigatePage, nodeId: string) => void;
}

export function NodeDrawer({
  node,
  onClose,
  onSelectRelated,
  relatedNodes,
  inDegree,
  totalDegree,
  onNavigate,
}: NodeDrawerProps) {
  const hasFile = !!node?.path;
  const contentQuery = useNodeContent(hasFile ? node : null);

  if (!node) {
    return <aside className="brain-drawer" />;
  }

  const navigateTarget = groupForNavigate(node.group);
  const content = contentQuery.data;

  return (
    <aside className="brain-drawer brain-drawer--open">
      <button className="brain-drawer-close" onClick={onClose} aria-label="Close">
        ×
      </button>
      <div className="brain-drawer-header">
        <span className="brain-drawer-group-badge">
          <span
            className="brain-related-dot"
            style={{ background: DEFAULT_GROUP_COLORS[node.group] } as CSSProperties}
          />
          {GROUP_LABEL[node.group]}
        </span>
        <h2 className="brain-drawer-title">{node.label}</h2>
        {node.path && <span className="brain-drawer-id">{node.path}</span>}
      </div>

      <div className="brain-drawer-body">
        {/* File content (markdown / json / text) */}
        {hasFile && contentQuery.isLoading && (
          <p className="brain-description">Loading…</p>
        )}
        {hasFile && contentQuery.error && (
          <p className="brain-description">
            Failed to load file: {String(contentQuery.error)}
          </p>
        )}

        {content?.type === 'markdown' && (
          <MarkdownPreview content={content.content} frontmatter={content.frontmatter} />
        )}

        {content?.type === 'json' && (
          <pre className="brain-codeblock">
            {content.data !== undefined
              ? JSON.stringify(content.data, null, 2)
              : content.raw ?? '(empty)'}
          </pre>
        )}

        {content?.type === 'text' && (
          <pre className="brain-codeblock">{content.content}</pre>
        )}

        {/* For nodes without a file (tags, some releases) — show a summary. */}
        {!hasFile && node.group === 'tag' && (
          <p className="brain-description">
            Tag <code>#{node.label.replace(/^#/, '')}</code> — {relatedNodes.length}{' '}
            {relatedNodes.length === 1 ? 'file' : 'files'} reference this tag.
          </p>
        )}
        {!hasFile && node.group !== 'tag' && (
          <p className="brain-description">{node.meta.description ?? 'No file content.'}</p>
        )}

        {/* Connections — always useful */}
        {relatedNodes.length > 0 && (
          <section className="brain-drawer-section">
            <h3 className="brain-drawer-section-title">
              Connections ({relatedNodes.length}) · in {inDegree} · total {totalDegree}
            </h3>
            <div className="brain-related-list">
              {relatedNodes.map(({ node: n, kind }) => (
                <button
                  key={`${n.id}-${kind}`}
                  className="brain-related-item"
                  onClick={() => onSelectRelated(n.id)}
                >
                  <span
                    className="brain-related-dot"
                    style={{ background: DEFAULT_GROUP_COLORS[n.group] } as CSSProperties}
                  />
                  <span>{n.label}</span>
                  <span className="brain-related-kind">{LINK_KIND_LABEL[kind] ?? kind}</span>
                </button>
              ))}
            </div>
          </section>
        )}
      </div>

      {navigateTarget && onNavigate && (
        <div className="brain-drawer-footer">
          <button
            className="brain-btn"
            onClick={() => onNavigate(navigateTarget, node.id)}
          >
            Open in {navigateTarget.charAt(0).toUpperCase() + navigateTarget.slice(1)} to edit →
          </button>
        </div>
      )}
    </aside>
  );
}
