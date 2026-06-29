import { useState, type CSSProperties } from 'react';
import type { Task } from '../../hooks/useTasks';
import {
  useVersions, useActiveVersion, useSetActiveVersion, useCompleteVersion, useCreateVersion,
  useRenameVersion, useDeleteVersion,
} from '../../hooks/useVersions';

interface VersionsPopoverProps {
  tasks: Task[];
  /** Position override — defaults to anchoring below-right of its trigger chip.
      The overflow "More" panel passes a left-flyout anchor instead. */
  style?: CSSProperties;
}

interface Row {
  version: string;
  summary: string;
  status: 'current' | 'planning' | 'released';
  exists: boolean;
  date?: string;
  count: number;
}

const sectionLabel: CSSProperties = { padding: '8px 8px 5px', fontSize: 10, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)' };
const iconBtn = (on: boolean, color = 'var(--color-accent)'): CSSProperties => ({ flex: '0 0 auto', width: 22, height: 22, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, cursor: 'pointer', color: on ? '#fff' : 'var(--color-text-tertiary)', background: on ? color : 'transparent', border: `1px solid ${on ? color : 'var(--color-border)'}`, transition: 'all .1s' });

export function VersionsPopover({ tasks, style }: VersionsPopoverProps) {
  const { data: versions = [] } = useVersions();
  const active = useActiveVersion().data ?? null;
  const setActive = useSetActiveVersion();
  const complete = useCompleteVersion();
  const create = useCreateVersion();
  const rename = useRenameVersion();
  const del = useDeleteVersion();
  const [newVer, setNewVer] = useState('');
  const [newSummary, setNewSummary] = useState('');
  // The version currently being renamed inline, plus the draft text.
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const registered = new Map(versions.map((v) => [v.version, v]));
  const count = (ver: string) => tasks.filter((t) => t.version === ver).length;

  // Unregistered = a version string used on tasks but with no RELEASES.json entry.
  const taskVersions = Array.from(new Set(tasks.map((t) => t.version).filter((v): v is string => !!v)));
  const unregistered = taskVersions.filter((v) => !registered.has(v) && v !== active);

  const currentRow: Row | null = active
    ? (() => { const e = registered.get(active); return { version: active, summary: e?.summary ?? '', status: 'current' as const, exists: !!e, count: count(active) }; })()
    : null;

  const planningRows: Row[] = versions
    .filter((v) => v.status === 'planning' && v.version !== active)
    .map((v): Row => ({ version: v.version, summary: v.summary, status: 'planning', exists: true, count: count(v.version) }))
    .concat(unregistered.map((v): Row => ({ version: v, summary: '', status: 'planning', exists: false, count: count(v) })))
    .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));

  const releasedRows: Row[] = versions
    .filter((v) => v.status === 'released')
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .map((v): Row => ({ version: v.version, summary: v.summary, status: 'released', exists: true, date: v.date, count: count(v.version) }));

  const busy = setActive.isPending || complete.isPending || create.isPending || rename.isPending || del.isPending;

  const onCreate = () => {
    const nm = newVer.trim();
    if (!nm) return;
    create.mutate({ version: nm, summary: newSummary.trim() || undefined });
    setNewVer(''); setNewSummary('');
  };

  const startEdit = (ver: string) => { setEditing(ver); setDraft(ver); };
  const cancelEdit = () => { setEditing(null); setDraft(''); };
  const commitEdit = (from: string) => {
    const to = draft.trim();
    if (to && to !== from) rename.mutate({ from, to });
    cancelEdit();
  };

  const onDelete = (r: Row) => {
    if (busy) return;
    const taskNote = r.count > 0
      ? ` ${r.count} task${r.count === 1 ? '' : 's'} pointing at it will have their version cleared (the tasks are kept).`
      : '';
    const regNote = r.exists ? 'This removes the version entry.' : 'This is an unregistered version (no release entry).';
    if (!window.confirm(`Delete version "${r.version}"? ${regNote}${taskNote}`)) return;
    del.mutate(r.version);
  };

  const renderRow = (r: Row) => {
    const isCurrent = r.status === 'current';
    const isReleased = r.status === 'released';
    const icon = isCurrent ? '★' : isReleased ? '✓' : '○';
    const iconColor = isCurrent ? 'var(--color-accent)' : isReleased ? 'var(--color-status-completed)' : 'var(--color-text-tertiary)';
    const isEditing = editing === r.version;
    return (
      <div key={r.status + ':' + r.version} className="bd-row" style={{ display: 'flex', alignItems: 'flex-start', gap: 9, padding: '8px 9px', borderRadius: 8 }}>
        <span style={{ flex: '0 0 auto', width: 16, textAlign: 'center', fontSize: 12, color: iconColor, marginTop: 1 }}>{icon}</span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            {isEditing ? (
              <input
                autoFocus
                className="bd-input"
                value={draft}
                disabled={busy}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') commitEdit(r.version); else if (e.key === 'Escape') cancelEdit(); }}
                onBlur={() => commitEdit(r.version)}
                spellCheck={false}
                style={{ flex: 1, minWidth: 0, height: 24, padding: '0 7px', borderRadius: 6, border: '1px solid var(--color-accent)', background: 'var(--color-bg-secondary)', color: 'var(--color-text)', fontSize: 12.5, fontFamily: 'var(--font-mono)', outline: 'none' }}
              />
            ) : (
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--color-text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.version}</span>
            )}
            {!isEditing && !r.exists && <span style={{ fontSize: 9.5, color: 'var(--color-text-tertiary)', border: '1px solid var(--color-border)', borderRadius: 5, padding: '0 5px' }}>unregistered</span>}
            {!isEditing && r.date && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-tertiary)' }}>{r.date.slice(0, 10)}</span>}
          </span>
          {r.summary && <span style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', lineHeight: 1.4, marginTop: 2, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const }}>{r.summary}</span>}
        </span>
        {!isEditing && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--color-text-tertiary)', marginTop: 3, flex: '0 0 auto' }}>{r.count}</span>}
        {/* set-current toggle (not for released) */}
        {!isEditing && !isReleased && (
          <span title={isCurrent ? 'Clear current' : 'Set as current'} onClick={() => !busy && setActive.mutate(isCurrent ? null : r.version)} style={iconBtn(isCurrent)}>★</span>
        )}
        {/* complete (planning → released) */}
        {!isEditing && !isReleased && (
          <span title="Mark completed (released)" onClick={() => !busy && complete.mutate({ version: r.version, exists: r.exists })} style={iconBtn(false, 'var(--color-status-completed)')}>✓</span>
        )}
        {/* rename — re-points every task on this version */}
        {!isEditing && (
          <span title="Rename version" onClick={() => !busy && startEdit(r.version)} style={iconBtn(false)}>✎</span>
        )}
        {/* delete — drops the entry and clears the version off its tasks */}
        {!isEditing && (
          <span title="Delete version" onClick={() => onDelete(r)} style={iconBtn(false, 'var(--color-error)')}>🗑</span>
        )}
      </div>
    );
  };

  return (
    <div
      className="bd-pop bd-scroll"
      onClick={(e) => e.stopPropagation()}
      style={{ position: 'absolute', top: 42, right: 0, width: 320, maxHeight: 'min(520px, 72vh)', overflowY: 'auto', background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)', borderRadius: 11, boxShadow: 'var(--shadow-lg)', padding: 6, zIndex: 40, ...style }}
    >
      {/* Create */}
      <div style={{ padding: '2px 4px 8px', borderBottom: '1px solid var(--color-border)', marginBottom: 4 }}>
        <div style={sectionLabel}>New version</div>
        <div style={{ display: 'flex', gap: 6, padding: '0 5px' }}>
          <input className="bd-input" value={newVer} onChange={(e) => setNewVer(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') onCreate(); }} placeholder="e.g. v0.2.0" spellCheck={false}
            style={{ flex: '0 0 110px', minWidth: 0, height: 30, padding: '0 10px', borderRadius: 8, border: '1px solid var(--color-border)', background: 'var(--color-bg-secondary)', color: 'var(--color-text)', fontSize: 12.5, fontFamily: 'var(--font-mono)', outline: 'none' }} />
          <input className="bd-input" value={newSummary} onChange={(e) => setNewSummary(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') onCreate(); }} placeholder="summary (optional)" spellCheck={false}
            style={{ flex: 1, minWidth: 0, height: 30, padding: '0 10px', borderRadius: 8, border: '1px solid var(--color-border)', background: 'var(--color-bg-secondary)', color: 'var(--color-text)', fontSize: 12.5, fontFamily: 'var(--font-family-text)', outline: 'none' }} />
          <span onClick={onCreate} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 30, padding: '0 12px', borderRadius: 8, background: 'var(--color-accent)', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer', flex: '0 0 auto' }}>Add</span>
        </div>
      </div>

      {/* Current */}
      <div style={sectionLabel}>Current sprint</div>
      {currentRow ? renderRow(currentRow) : <div style={{ padding: '4px 9px 8px', fontSize: 12, color: 'var(--color-text-tertiary)' }}>No current sprint — set one with the ★ below.</div>}

      {/* Backlog */}
      {planningRows.length > 0 && <div style={{ ...sectionLabel, borderTop: '1px solid var(--color-border)', marginTop: 4 }}>Backlog</div>}
      {planningRows.map(renderRow)}

      {/* Completed */}
      {releasedRows.length > 0 && <div style={{ ...sectionLabel, borderTop: '1px solid var(--color-border)', marginTop: 4 }}>Completed</div>}
      {releasedRows.map(renderRow)}

      {versions.length === 0 && unregistered.length === 0 && !active && (
        <div style={{ padding: '6px 9px 4px', fontSize: 12, color: 'var(--color-text-tertiary)' }}>No versions yet. Add one above.</div>
      )}
    </div>
  );
}
