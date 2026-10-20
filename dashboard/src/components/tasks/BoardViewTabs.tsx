import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { BoardView } from './boardModel';

interface BoardViewTabsProps {
  views: BoardView[];
  activeViewId: string;
  counts: Record<string, number>;
  isDirty: boolean;
  menuOpenId: string | null;
  onMenuToggle: (id: string | null) => void;
  onApply: (id: string) => void;
  onRequestSave: () => void;
  onReset: () => void;
  /** Create a fresh blank view immediately; returns its id (for inline rename). */
  onCreateBlank: () => string;
  onRename: (id: string, name: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
}

export function BoardViewTabs(p: BoardViewTabsProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState('');
  // The kebab menu must escape the tab bar's overflow-x:auto clipping, so it
  // renders in a portal at these fixed screen coordinates.
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const renameRef = useRef<HTMLInputElement>(null);

  const openMenu = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const opening = p.menuOpenId !== id;
    setMenuPos(opening ? { top: r.bottom + 6, left: Math.max(8, r.right - 156) } : null);
    p.onMenuToggle(opening ? id : null);
  };
  const closeMenu = () => { setMenuPos(null); p.onMenuToggle(null); };
  const openView = p.views.find((v) => v.id === p.menuOpenId) || null;

  useEffect(() => { if (renamingId) { renameRef.current?.focus(); renameRef.current?.select(); } }, [renamingId]);

  // "+ New view" → create a blank view straight away, then enter rename mode on it.
  const startCreate = () => { const id = p.onCreateBlank(); setRenameVal('New view'); setRenamingId(id); };
  const startRename = (v: BoardView) => { setRenameVal(v.name); setRenamingId(v.id); p.onMenuToggle(null); };
  const confirmRename = () => {
    if (renamingId && renameVal.trim()) p.onRename(renamingId, renameVal.trim());
    setRenamingId(null);
  };

  return (
    <div className="bd-scroll" style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 2, padding: '0 14px', height: 46, background: 'var(--color-bg)', borderBottom: '1px solid var(--color-border)', overflowX: 'auto' }}>
      <span style={{ fontSize: 15, color: 'var(--color-text-tertiary)', marginRight: 8, flex: '0 0 auto' }}>⊞</span>

      {p.views.map((v) => {
        const active = v.id === p.activeViewId;
        if (renamingId === v.id) {
          return (
            <input
              key={v.id}
              ref={renameRef}
              className="bd-input"
              value={renameVal}
              onChange={(e) => setRenameVal(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') confirmRename(); else if (e.key === 'Escape') setRenamingId(null); }}
              onBlur={confirmRename}
              spellCheck={false}
              style={{ width: 130, height: 30, padding: '0 10px', borderRadius: 9, border: '1px solid var(--color-accent)', background: 'var(--color-bg-secondary)', color: 'var(--color-text)', fontSize: 13, fontFamily: 'var(--font-family-text)', outline: 'none', flex: '0 0 auto' }}
            />
          );
        }
        return (
          <div
            key={v.id}
            onClick={() => p.onApply(v.id)}
            className="bd-hover-text"
            style={{
              display: 'flex', alignItems: 'center', gap: 7, padding: '6px 9px 6px 11px', borderRadius: 9,
              cursor: 'pointer', fontSize: 13, fontWeight: active ? 600 : 500, fontFamily: 'var(--font-family-text)',
              color: active ? 'var(--color-text)' : 'var(--color-text-tertiary)',
              background: active ? 'var(--color-accent-soft)' : 'transparent',
              border: `1px solid ${active ? 'var(--color-accent)' : 'transparent'}`,
              flex: '0 0 auto', transition: 'all .12s', position: 'relative',
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: active ? 'var(--color-accent)' : 'var(--color-text-tertiary)', flex: '0 0 auto' }} />
            <span style={{ whiteSpace: 'nowrap' }}>{v.name}</span>
            {v.hasLocalOverride && <span title="You have a private override of this shared view" style={{ fontSize: 10, color: 'var(--color-accent)' }}>•yours</span>}
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: active ? 'var(--color-accent)' : 'var(--color-text-tertiary)', background: active ? 'transparent' : 'var(--color-bg-tertiary)', padding: '0 6px', borderRadius: 20 }}>{p.counts[v.id] ?? 0}</span>
            <span
              className="bd-hover bd-hover-text"
              onClick={(e) => openMenu(e, v.id)}
              title="View options"
              style={{ width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 5, fontSize: 13, color: 'var(--color-text-tertiary)', flex: '0 0 auto' }}
            >⋯</span>
          </div>
        );
      })}

      {/* Kebab menu — portal'd to body so the tab bar's overflow-x:auto can't clip it. */}
      {openView && menuPos && createPortal(
        <>
          <div onClick={closeMenu} style={{ position: 'fixed', inset: 0, zIndex: 110 }} />
          <div className="bd-pop" style={{ position: 'fixed', top: menuPos.top, left: menuPos.left, width: 156, background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)', borderRadius: 9, boxShadow: 'var(--shadow-lg)', padding: 5, zIndex: 120 }}>
            <div className="bd-row" onClick={() => { setMenuPos(null); startRename(openView); }} style={menuItem()}><span style={menuGlyph}>✎</span>Rename</div>
            <div className="bd-row" onClick={() => { p.onDuplicate(openView.id); closeMenu(); }} style={menuItem()}><span style={menuGlyph}>⧉</span>Duplicate</div>
            {openView.removable ? (
              <div className="bd-danger" onClick={() => { p.onDelete(openView.id); closeMenu(); }} style={menuItem('var(--color-error)')}><span style={menuGlyph}>🗑</span>Delete</div>
            ) : (
              <div style={{ ...menuItem('var(--color-text-tertiary)'), cursor: 'default' }}><span style={menuGlyph}>🔒</span>Default view</div>
            )}
          </div>
        </>,
        document.body,
      )}

      <div className="bd-hover bd-hover-text" onClick={startCreate} title="Create a new blank view (Kanban, no filters)" style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 8, cursor: 'pointer', color: 'var(--color-text-tertiary)', fontSize: 12.5, fontWeight: 500, flex: '0 0 auto' }}>+ New view</div>

      <div style={{ flex: 1, minWidth: 8 }} />

      {p.isDirty && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, flex: '0 0 auto' }}>
          <span style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-family-text)' }}>Unsaved changes</span>
          <span className="bd-hover" onClick={p.onReset} title="Revert to saved" style={{ padding: '5px 10px', borderRadius: 8, cursor: 'pointer', color: 'var(--color-text-secondary)', fontSize: 12, border: '1px solid var(--color-border)' }}>Reset</span>
          <span className="bd-chip" onClick={p.onRequestSave} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: 8, cursor: 'pointer', background: 'var(--color-accent-soft)', color: 'var(--color-accent)', fontSize: 12, fontWeight: 600, border: '1px solid var(--color-accent)' }}>Save view</span>
        </div>
      )}
    </div>
  );
}

function menuItem(color = 'var(--color-text-secondary)'): React.CSSProperties {
  return { display: 'flex', alignItems: 'center', gap: 9, padding: '8px 9px', borderRadius: 7, cursor: 'pointer', fontSize: 12.5, color };
}
const menuGlyph: React.CSSProperties = { fontSize: 12, width: 15 };
