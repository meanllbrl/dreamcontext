import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { VaultLogo } from '../VaultLogo';
import { routeSwitcherKey } from '../../../lib/switcherKeys';
import { shortcutFor, visiblePickerRows } from '../../../lib/pickerRows';

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
  /** In the drawer's Hidden group: not listed, no ⌘ number; a typed name still finds it. */
  hidden?: boolean;
}

interface ProjectPickerProps {
  anchor: HTMLElement | null;
  rows: readonly PickerRow[];
  onPick: (name: string) => void;
  onClose: () => void;
  /** Absent on a device shell: it administers no projects. */
  onNewProject?: () => void;
}

/**
 * The title bar's project picker (⌘P): every registered project in the owner's order, no
 * "All projects" row. A pick switches the project in THIS window, or brings forward the OS
 * window that already holds it. Arrow keys move, Enter picks, Esc closes.
 */
export function ProjectPicker({ anchor, rows: allRows, onPick, onClose, onNewProject }: ProjectPickerProps) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [q, setQ] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const needle = q.trim().toLowerCase();
  // Typing filters (a typed name finds a hidden project too); the keyboard hint (⌘N) stays the
  // project's place among the shown ones.
  const rows = visiblePickerRows(allRows, needle);
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

  // Focus the filter in the commit that mounts it: a passive effect leaves a frame in which the
  // first letters still land in the composer behind.
  useLayoutEffect(() => { inputRef.current?.focus(); }, []);

  // Keys aimed at the page behind (the Super/Chat/member composer, the whiteboard) are the
  // picker's while it is open: routed in, never delivered there.
  const live = useRef({ rows, focused, onPick });
  live.current = { rows, focused, onPick };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inside = e.target instanceof Element && !!e.target.closest('.ns-picker');
      const r = routeSwitcherKey({ key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, inside, composing: e.isComposing,
        otherModal: !inside && e.target instanceof Element && !!e.target.closest('[aria-modal="true"], .cmd-modal') });
      if (r.kind === 'pass') return;
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      inputRef.current?.focus();
      if (r.kind === 'type') { setQ((v) => v + r.text); setFocused(0); }
      else if (r.kind === 'backspace') { setQ((v) => v.slice(0, -1)); setFocused(0); }
      else if (r.kind === 'move') setFocused((i) => Math.max(0, Math.min(live.current.rows.length - 1, i + r.dir)));
      else if (r.kind === 'enter') { const row = live.current.rows[live.current.focused]; if (row) live.current.onPick(row.name); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

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
      style={pos ? { left: pos.left, top: pos.top } : { opacity: 0 }}
    >
      <div className="ns-menu-head">{t('shell.picker.label')}</div>
      <input
        ref={inputRef}
        className="ns-picker-filter"
        value={q}
        onChange={(e) => { setQ(e.target.value); setFocused(0); }}
        placeholder={t('shell.picker.label')}
        aria-label={t('shell.picker.label')}
        spellCheck={false}
        autoComplete="off"
        data-testid="ns-picker-filter"
        style={{ margin: '0 8px 6px', padding: '6px 8px', border: '1px solid var(--color-border)', borderRadius: 6, background: 'transparent', color: 'inherit', font: 'inherit', width: 'calc(100% - 16px)' }}
      />
      <div className="ns-picker-list">
        {rows.map((r, i) => (
          <button
            key={r.name}
            type="button"
            role="option"
            aria-selected={r.active}
            className="ns-menu-row"
            data-on={r.active ? 'true' : undefined}
            data-hidden-project={r.hidden ? 'true' : undefined}
            data-focus={i === focused ? 'true' : undefined}
            data-testid={`ns-picker-${r.name}`}
            data-move={r.active ? undefined : 'true'}
            onMouseEnter={() => setFocused(i)}
            onClick={() => onPick(r.name)}
          >
            <VaultLogo name={r.name} hasLogo={r.logo} stamp={r.logoStamp} size={18} className="ns-menu-logo" />
            <span className="ns-menu-label">{r.name}</span>
            {r.otherWindow && <span className="ns-menu-note">{t('shell.picker.otherWindow')}</span>}
            {!r.otherWindow && r.asleep && <span className="ns-menu-note">{t('shell.picker.asleep')}</span>}
            {shortcutFor(allRows, r.name) !== null && <kbd className="ns-menu-kbd">⌘{shortcutFor(allRows, r.name)}</kbd>}
          </button>
        ))}
      </div>
      {onNewProject && (
      <button type="button" className="ns-menu-row ns-picker-new" data-testid="ns-picker-new-project" onClick={onNewProject}>
        <span className="ns-menu-logo ns-picker-new-mark" aria-hidden="true">+</span>
        <span className="ns-menu-label">{t('shell.drawer.newProject')}</span>
      </button>
      )}
    </div>
  );
}
