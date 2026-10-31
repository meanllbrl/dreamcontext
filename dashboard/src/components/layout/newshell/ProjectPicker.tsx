import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { VaultLogo } from '../VaultLogo';

export interface PickerRow {
  name: string;
  logo: boolean;
  logoStamp: number | null;
  /** On screen in this window. */
  active: boolean;
  /** Held by this window but put to sleep at the ceiling. */
  asleep: boolean;
  /** Held by another OS window: a pick brings that window forward. */
  otherWindow: boolean;
}

interface ProjectPickerProps {
  anchor: HTMLElement | null;
  rows: readonly PickerRow[];
  onPick: (name: string) => void;
  onClose: () => void;
  onNewProject: () => void;
}

/**
 * The title bar's project picker (⌘P): every registered project in the owner's order, no
 * "All projects" row. A pick switches the project in THIS window, or brings forward the OS
 * window that already holds it. Arrow keys move, Enter picks, Esc closes.
 */
export function ProjectPicker({ anchor, rows, onPick, onClose, onNewProject }: ProjectPickerProps) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [focused, setFocused] = useState(() => Math.max(0, rows.findIndex((r) => r.active)));

  useLayoutEffect(() => {
    const menu = ref.current;
    if (!anchor || !menu) return;
    const a = anchor.getBoundingClientRect();
    const m = menu.getBoundingClientRect();
    const gap = 8;
    const left = Math.max(gap, Math.min(a.left, window.innerWidth - m.width - gap));
    const top = Math.min(a.bottom + 6, Math.max(gap, window.innerHeight - m.height - gap));
    setPos({ left, top });
  }, [anchor]);

  useEffect(() => { ref.current?.focus(); }, []);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || anchor?.contains(target)) return;
      onClose();
    };
    // Esc closes it wherever focus is (the chat can hold focus while the picker is open).
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [anchor, onClose]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setFocused((i) => Math.min(rows.length - 1, i + 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setFocused((i) => Math.max(0, i - 1)); return; }
    if (e.key === 'Enter' && rows[focused]) { e.preventDefault(); onPick(rows[focused].name); }
  };

  return (
    <div
      ref={ref}
      className="ns-menu ns-picker"
      role="listbox"
      aria-label={t('shell.picker.label')}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      data-testid="ns-picker"
      data-no-drag
      style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden' }}
    >
      <div className="ns-menu-head">{t('shell.picker.label')}</div>
      <div className="ns-picker-list">
        {rows.map((r, i) => (
          <button
            key={r.name}
            type="button"
            role="option"
            aria-selected={r.active}
            className="ns-menu-row"
            data-on={r.active ? 'true' : undefined}
            data-focus={i === focused ? 'true' : undefined}
            data-testid={`ns-picker-${r.name}`}
            onMouseEnter={() => setFocused(i)}
            onClick={() => onPick(r.name)}
          >
            <VaultLogo name={r.name} hasLogo={r.logo} stamp={r.logoStamp} size={18} className="ns-menu-logo" />
            <span className="ns-menu-label">{r.name}</span>
            {r.otherWindow && <span className="ns-menu-note">{t('shell.picker.otherWindow')}</span>}
            {!r.otherWindow && r.asleep && <span className="ns-menu-note">{t('shell.picker.asleep')}</span>}
            {i < 9 && <kbd className="ns-menu-kbd">⌘{i + 1}</kbd>}
          </button>
        ))}
      </div>
      <button type="button" className="ns-menu-row ns-picker-new" data-testid="ns-picker-new-project" onClick={onNewProject}>
        <span className="ns-menu-logo ns-picker-new-mark" aria-hidden="true">+</span>
        <span className="ns-menu-label">{t('shell.drawer.newProject')}</span>
      </button>
    </div>
  );
}
