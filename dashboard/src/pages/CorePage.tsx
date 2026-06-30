import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useFocusTarget, type FocusTarget } from '../hooks/useFocusTarget';
import { useI18n } from '../context/I18nContext';
import { SqlPreview } from '../components/core/SqlPreview';
import { JsonPreview } from '../components/core/JsonPreview';
import { MarkdownPreview } from '../components/core/MarkdownPreview';
import './CorePage.css';

interface CoreFile {
  filename: string;
  name: string;
  type: string;
}

interface CoreFileDetail {
  filename: string;
  type: string;
  frontmatter?: Record<string, unknown>;
  content?: string;
  sections?: string[];
  sectionContents?: Record<string, string>;
  data?: unknown;
}

function hasPreview(filename: string): boolean {
  return filename.endsWith('.sql') || filename.endsWith('.json') || filename.endsWith('.md');
}

interface CorePageProps {
  onNavigateTaxonomy?: () => void;
  focus?: FocusTarget;
}

export function CorePage({ onNavigateTaxonomy, focus }: CorePageProps = {}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [editContent, setEditContent] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [viewTab, setViewTab] = useState<'file' | 'preview'>('preview');

  // Open the core file the ⌘K palette / Brain map navigated to (e.g. a memory or
  // changelog hit resolves to `2.memory.md` / `CHANGELOG.json`). An empty id is
  // ignored by useFocusTarget, so Core keeps its default first-file selection.
  useFocusTarget(focus, (filename) => { setSelected(filename); setIsEditing(false); setViewTab('preview'); });

  const { data: filesData, isLoading, isError, error } = useQuery({
    queryKey: ['core'],
    queryFn: () => api.get<{ files: CoreFile[] }>('/core'),
  });

  // Land on the first file instead of an empty pane. `selected` only holds an
  // explicit user choice; until then `active` falls back to the first file.
  const active = selected ?? filesData?.files?.[0]?.filename ?? null;

  const { data: fileDetail } = useQuery({
    queryKey: ['core', active],
    queryFn: () => api.get<CoreFileDetail>(`/core/${active}`),
    enabled: !!active,
  });

  const saveFile = useMutation({
    mutationFn: ({ filename, content }: { filename: string; content: string }) =>
      api.put(`/core/${filename}`, { content }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['core'] });
      setIsEditing(false);
    },
  });

  const handleEdit = () => {
    if (fileDetail?.content !== undefined) {
      setEditContent(fileDetail.content);
      setIsEditing(true);
    }
  };

  const handleSave = () => {
    if (active && editContent !== null) {
      saveFile.mutate({ filename: active, content: editContent });
    }
  };

  if (isLoading) return <div className="loading">{t('common.loading')}</div>;
  if (isError) return <div className="error-state">Failed to load core files. {error?.message}</div>;

  const files = filesData?.files ?? [];

  const renderContent = () => {
    if (!active || !fileDetail) return null;

    // taxonomy.json has a dedicated page — short-circuit with a navigation prompt.
    if (active === 'taxonomy.json' && onNavigateTaxonomy) {
      return (
        <div className="core-taxonomy-link">
          <p className="core-taxonomy-link-hint">
            This file is managed by the Taxonomy system.
          </p>
          <button className="btn btn--primary" onClick={onNavigateTaxonomy}>
            Open Taxonomy page
          </button>
        </div>
      );
    }

    if (viewTab === 'preview') {
      if (active.endsWith('.sql') && fileDetail.content) {
        return <SqlPreview content={fileDetail.content} />;
      }
      if (active.endsWith('.json') && fileDetail.data) {
        return <JsonPreview data={fileDetail.data} filename={active} />;
      }
      if (active.endsWith('.md') && fileDetail.content) {
        return <MarkdownPreview content={fileDetail.content} frontmatter={fileDetail.frontmatter} />;
      }
    }

    return (
      <pre className="core-viewer-content">
        {fileDetail.content ?? JSON.stringify(fileDetail.data, null, 2)}
      </pre>
    );
  };

  return (
    <div className="core-page">
      <div className="core-layout">
        <div className="core-list">
          {files.map((file, index) => (
            <button
              key={file.filename}
              className={`core-list-item ${active === file.filename ? 'core-list-item--active' : ''} animate-stagger animate-stagger-${Math.min(index + 1, 8)}`}
              onClick={() => { setSelected(file.filename); setIsEditing(false); setViewTab('preview'); }}
            >
              <span className="core-list-name">{file.name}</span>
              <span className="core-list-type">{file.type}</span>
            </button>
          ))}
        </div>

        <div className="core-detail">
          {!active && (
            <div className="core-empty">Select a file to view.</div>
          )}
          {active && fileDetail && !isEditing && (
            <div className="core-viewer">
              <div className="core-viewer-header">
                <h2 className="core-viewer-title">{fileDetail.filename}</h2>
                <div className="core-viewer-actions">
                  {hasPreview(active) && (
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
                  )}
                  {fileDetail.type === 'markdown' && (
                    <button className="btn btn--ghost" onClick={handleEdit}>Edit</button>
                  )}
                </div>
              </div>
              {renderContent()}
            </div>
          )}
          {active && isEditing && (
            <div className="core-editor">
              <div className="core-editor-header">
                <h2 className="core-viewer-title">Editing: {active}</h2>
                <div className="core-editor-actions">
                  <button className="btn btn--ghost" onClick={() => setIsEditing(false)}>Cancel</button>
                  <button className="btn btn--primary" onClick={handleSave} disabled={saveFile.isPending}>
                    {saveFile.isPending ? 'Saving...' : 'Save'}
                  </button>
                </div>
              </div>
              <div className="core-editor-split">
                <textarea
                  className="core-editor-textarea"
                  value={editContent ?? ''}
                  onChange={e => setEditContent(e.target.value)}
                />
                <pre className="core-editor-preview">{editContent}</pre>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
