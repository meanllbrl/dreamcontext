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

/** One roster entry from GET /api/core/people. */
interface PersonSummary {
  slug: string;
  name: string;
  role?: string;
  active: boolean;
  chars: number;
}

interface PeopleList {
  activeSlug: string | null;
  source: string;
  people: PersonSummary[];
  /** Present ONLY when people.json exists but could not be parsed (D17). */
  error?: string;
}

/** GET /api/core/people/:slug — `content` is the RAW file, frontmatter included. */
interface PersonDetail {
  slug: string;
  name: string;
  content: string;
}

/**
 * What the detail pane is showing. A person and a core file can share a name, so
 * selection carries its KIND rather than a bare string.
 */
type Selection = { kind: 'file'; id: string } | { kind: 'person'; id: string };

function hasPreview(filename: string): boolean {
  return filename.endsWith('.sql') || filename.endsWith('.json') || filename.endsWith('.md');
}

/**
 * Split a leading `---` frontmatter block off a raw markdown file so the body
 * can go to MarkdownPreview. The person route serves the WHOLE file (that is
 * what makes the edit round trip lossless), so the preview does the stripping.
 */
function stripFrontmatter(raw: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(raw);
  return match ? raw.slice(match[0].length) : raw;
}

interface CorePageProps {
  onNavigateTaxonomy?: () => void;
  focus?: FocusTarget;
}

export function CorePage({ onNavigateTaxonomy, focus }: CorePageProps = {}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Selection | null>(null);
  const [editContent, setEditContent] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [viewTab, setViewTab] = useState<'file' | 'preview'>('preview');

  // Open the core file the ⌘K palette / Brain map navigated to (e.g. a memory or
  // changelog hit resolves to `2.memory.md` / `CHANGELOG.json`). An empty id is
  // ignored by useFocusTarget, so Core keeps its default first-file selection.
  useFocusTarget(focus, (filename) => {
    setSelected({ kind: 'file', id: filename });
    setIsEditing(false);
    setViewTab('preview');
  });

  const { data: filesData, isLoading, isError, error } = useQuery({
    queryKey: ['core'],
    queryFn: () => api.get<{ files: CoreFile[] }>('/core'),
  });

  // The roster. A vault with no `people/` answers an empty list, so this group
  // simply does not render there — nothing regresses on an un-migrated vault.
  const { data: peopleData } = useQuery({
    queryKey: ['core', 'people'],
    queryFn: () => api.get<PeopleList>('/core/people'),
  });
  const people = peopleData?.people ?? [];

  // Land on the first file instead of an empty pane. `selected` only holds an
  // explicit user choice; until then `active` falls back to the first file.
  const active: Selection | null =
    selected ?? (filesData?.files?.[0] ? { kind: 'file', id: filesData.files[0].filename } : null);
  const activeFile = active?.kind === 'file' ? active.id : null;
  const activePerson = active?.kind === 'person' ? active.id : null;

  const { data: fileDetail } = useQuery({
    queryKey: ['core', activeFile],
    queryFn: () => api.get<CoreFileDetail>(`/core/${activeFile}`),
    enabled: !!activeFile,
  });

  const { data: personDetail } = useQuery({
    queryKey: ['core', 'people', activePerson],
    queryFn: () => api.get<PersonDetail>(`/core/people/${activePerson}`),
    enabled: !!activePerson,
  });

  const saveFile = useMutation({
    mutationFn: ({ filename, content }: { filename: string; content: string }) =>
      api.put(`/core/${filename}`, { content }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['core'] });
      setIsEditing(false);
    },
  });

  const savePerson = useMutation({
    mutationFn: ({ slug, content }: { slug: string; content: string }) =>
      api.put(`/core/people/${slug}`, { content }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['core'] });
      setIsEditing(false);
    },
  });

  const isSaving = saveFile.isPending || savePerson.isPending;

  const handleEdit = () => {
    // A person is edited as the RAW file (frontmatter included) — that is what
    // the PUT writes back, so what you see is exactly what is stored.
    const source = activePerson ? personDetail?.content : fileDetail?.content;
    if (source !== undefined) {
      setEditContent(source);
      setIsEditing(true);
    }
  };

  const handleSave = () => {
    if (editContent === null) return;
    if (activePerson) savePerson.mutate({ slug: activePerson, content: editContent });
    else if (activeFile) saveFile.mutate({ filename: activeFile, content: editContent });
  };

  const select = (next: Selection) => {
    setSelected(next);
    setIsEditing(false);
    setViewTab('preview');
  };

  if (isLoading) return <div className="loading">{t('common.loading')}</div>;
  if (isError) return <div className="error-state">Failed to load core files. {error?.message}</div>;

  const files = filesData?.files ?? [];
  const title = activePerson ? `people/${activePerson}.md` : fileDetail?.filename ?? '';
  const canEdit = activePerson ? !!personDetail : fileDetail?.type === 'markdown';
  const hasDetail = activePerson ? !!personDetail : !!fileDetail;

  const renderContent = () => {
    if (activePerson) {
      if (!personDetail) return null;
      return viewTab === 'preview'
        ? <MarkdownPreview content={stripFrontmatter(personDetail.content)} />
        : <pre className="core-viewer-content">{personDetail.content}</pre>;
    }

    if (!activeFile || !fileDetail) return null;

    // taxonomy.json has a dedicated page — short-circuit with a navigation prompt.
    if (activeFile === 'taxonomy.json' && onNavigateTaxonomy) {
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
      if (activeFile.endsWith('.sql') && fileDetail.content) {
        return <SqlPreview content={fileDetail.content} />;
      }
      if (activeFile.endsWith('.json') && fileDetail.data) {
        return <JsonPreview data={fileDetail.data} filename={activeFile} />;
      }
      if (activeFile.endsWith('.md') && fileDetail.content) {
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
          {/* People sit ABOVE Core Files: a constitution answers "who is at the
              keyboard", which frames everything below it. The group headers only
              appear once there IS a roster, so a vault without `people/` looks
              exactly as it did before. */}
          {people.length > 0 && (
            <>
              <div className="core-list-group">People</div>
              {people.map((person) => (
                <button
                  key={person.slug}
                  className={`core-list-item ${activePerson === person.slug ? 'core-list-item--active' : ''}`}
                  onClick={() => select({ kind: 'person', id: person.slug })}
                >
                  <span className="core-list-name">{person.name}</span>
                  <span className="core-list-meta">
                    {person.role && <span className="core-list-type">{person.role}</span>}
                    {person.active && <span className="core-person-badge">● active</span>}
                  </span>
                </button>
              ))}
              <div className="core-list-group">Core Files</div>
            </>
          )}
          {peopleData?.error && (
            <div className="core-list-note" title={peopleData.error}>
              Roster unreadable — run <code>dreamcontext doctor</code>.
            </div>
          )}
          {files.map((file, index) => (
            <button
              key={file.filename}
              className={`core-list-item ${activeFile === file.filename ? 'core-list-item--active' : ''} animate-stagger animate-stagger-${Math.min(index + 1, 8)}`}
              onClick={() => select({ kind: 'file', id: file.filename })}
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
          {active && hasDetail && !isEditing && (
            <div className="core-viewer">
              <div className="core-viewer-header">
                <h2 className="core-viewer-title">{title}</h2>
                <div className="core-viewer-actions">
                  {(activePerson || (activeFile && hasPreview(activeFile))) && (
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
                  {canEdit && (
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
                <h2 className="core-viewer-title">Editing: {title}</h2>
                <div className="core-editor-actions">
                  <button className="btn btn--ghost" onClick={() => setIsEditing(false)}>Cancel</button>
                  <button className="btn btn--primary" onClick={handleSave} disabled={isSaving}>
                    {isSaving ? 'Saving...' : 'Save'}
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
