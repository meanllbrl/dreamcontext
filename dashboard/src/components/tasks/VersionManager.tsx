import { useState } from 'react';
import { useVersions, useCreateVersion, useUpdateVersion } from '../../hooks/useVersions';
import type { Task } from '../../hooks/useTasks';
import './VersionManager.css';

interface VersionManagerProps {
  onClose: () => void;
  tasks: Task[];
}

export function VersionManager({ onClose, tasks }: VersionManagerProps) {
  const { data: versions, isLoading } = useVersions();
  const createVersion = useCreateVersion();
  const updateVersion = useUpdateVersion();
  const [newVersion, setNewVersion] = useState('');
  const [newSummary, setNewSummary] = useState('');

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newVersion.trim()) return;
    createVersion.mutate(
      { version: newVersion.trim(), summary: newSummary.trim() || undefined },
      { onSuccess: () => { setNewVersion(''); setNewSummary(''); } },
    );
  };

  const taskCountByVersion = (version: string) =>
    tasks.filter(t => t.version === version).length;

  const planning = (versions ?? []).filter(v => v.status === 'planning');
  const released = (versions ?? []).filter(v => v.status === 'released');

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal version-manager-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Versions &amp; Releases</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body version-manager-body">
          {/* Stats header */}
          <div className="version-stats">
            <div className="version-stat">
              <span className="version-stat-count">{planning.length}</span>
              <span className="version-stat-label">Planning</span>
            </div>
            <div className="version-stat">
              <span className="version-stat-count">{released.length}</span>
              <span className="version-stat-label">Released</span>
            </div>
          </div>

          {isLoading && <p className="version-manager-loading">Loading...</p>}

          {/* Planning versions */}
          {planning.length > 0 && (
            <div className="version-section">
              <h3 className="version-section-title">Planning</h3>
              {planning.map(v => {
                const count = taskCountByVersion(v.version);
                return (
                  <div key={v.version} className="version-item">
                    <div className="version-item-info">
                      <span className="version-status-badge version-status-badge--planning">
                        planning
                      </span>
                      <span className="version-item-name">{v.version}</span>
                      <span className="version-item-count">{count} task{count !== 1 ? 's' : ''}</span>
                    </div>
                    {v.summary && (
                      <p className="version-item-desc">{v.summary}</p>
                    )}
                    <div className="version-item-actions">
                      <button
                        className="btn btn--primary version-release-btn"
                        onClick={() => updateVersion.mutate({
                          version: v.version,
                          updates: { status: 'released' },
                        })}
                      >
                        Release
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Released versions */}
          {released.length > 0 && (
            <div className="version-section">
              <h3 className="version-section-title">Released</h3>
              {released.map(v => {
                const count = taskCountByVersion(v.version);
                return (
                  <div key={v.version} className="version-item version-item--released">
                    <div className="version-item-info">
                      <span className="version-status-badge version-status-badge--released">
                        released
                      </span>
                      <span className="version-item-name">{v.version}</span>
                      <span className="version-item-count">{count} task{count !== 1 ? 's' : ''}</span>
                      {v.date && <span className="version-item-date">{v.date}</span>}
                    </div>
                    {v.summary && (
                      <p className="version-item-desc">{v.summary}</p>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {(versions ?? []).length === 0 && !isLoading && (
            <p className="version-manager-empty">No versions yet. Create one below.</p>
          )}

          {/* Create form */}
          <form onSubmit={handleCreate} className="version-create-form">
            <h3 className="version-section-title">New Version</h3>
            <input
              className="field-input"
              value={newVersion}
              onChange={e => setNewVersion(e.target.value)}
              placeholder="Version name (e.g. v0.2.0)"
              required
            />
            <input
              className="field-input"
              value={newSummary}
              onChange={e => setNewSummary(e.target.value)}
              placeholder="Summary (optional)"
            />
            <button
              type="submit"
              className="btn btn--primary"
              disabled={!newVersion.trim() || createVersion.isPending}
            >
              {createVersion.isPending ? '...' : 'Create Planning Version'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
