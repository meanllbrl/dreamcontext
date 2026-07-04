import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLauncherStatus, type VaultStatus } from '../../hooks/useLauncher';
import { goToProject, openLauncherHome } from '../../lib/desktop';
import { CommandModal, useListKeyboardNav } from './CommandModal';
import { VaultDot } from '../layout/VaultDot';
import './ProjectSwitcher.css';

/**
 * ⌘P "Go to Project" — a fast, tab-like project switcher available in EVERY
 * window (launcher and vault). It removes the two big multi-window pains:
 * hunting for another project's window, and having no quick way back to the
 * launcher.
 *
 * Action is context-aware (see `goToProject`): in a vault window it hops THIS
 * window to the chosen project in place (no new window); in the launcher window
 * it opens/focuses the project's own window. ⌘1…⌘9 jump straight to the Nth
 * project without opening the palette.
 */

/** The vault this window is pinned to (`?vault=`), or null in the launcher. */
function currentVault(): string | null {
  try {
    return new URLSearchParams(window.location.search).get('vault');
  } catch {
    return null;
  }
}

/** Don't hijack ⌘1-9 while the user is typing in a field or the agent terminal. */
function isEditableTarget(el: EventTarget | null): boolean {
  if (!(el instanceof Element)) return false;
  return !!el.closest('input, textarea, select, [contenteditable="true"], .xterm, .agent-surface');
}

/**
 * Don't hijack ⌘P inside the embedded agent terminal: xterm forwards ⌘P to the
 * PTY (its custom key handler only intercepts ⌘C/⌘X/⌘A/⌘⌫), so opening the
 * switcher there would also leak a stray keystroke into Claude Code. Elsewhere
 * (plain inputs) ⌘P is a harmless print-shortcut override, so we still allow it.
 */
function isTerminalTarget(el: EventTarget | null): boolean {
  if (!(el instanceof Element)) return false;
  return !!el.closest('.xterm, .agent-surface');
}

export function ProjectSwitcher() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Fetch ONLY while open. Without this gate the query inherits the app-wide 15s
  // refetch interval and would poll `/api/launcher/status` in every vault window
  // forever, since this component is always mounted. react-query keeps the last
  // result cached, so a reopen within the cache window renders instantly.
  const { data } = useLauncherStatus(open);
  const vaults = useMemo(() => data?.vaults ?? [], [data]);
  const active = currentVault();
  const inLauncher = active === null;

  // Existing projects, in listed order — the target set for both the palette and
  // the ⌘1-9 quick jumps (a gone folder can't be opened).
  const openable = useMemo(() => vaults.filter((v) => v.exists), [vaults]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return vaults;
    return vaults.filter(
      (v) => v.name.toLowerCase().includes(needle) || v.path.toLowerCase().includes(needle),
    );
  }, [vaults, q]);

  const pick = useCallback((v: VaultStatus) => {
    setOpen(false);
    if (!v.exists) return; // gone folder — nothing to open
    if (v.name === active) return; // already here
    void goToProject(v.name);
  }, [active]);

  const goHome = useCallback(() => {
    setOpen(false);
    openLauncherHome();
  }, []);

  // Stable close for the shell (so its topmost-Esc effect doesn't re-register per render).
  const close = useCallback(() => setOpen(false), []);

  // Shared ↑/↓/Enter list nav (+ length clamp). Esc is owned by <CommandModal>.
  const { focused, setFocused, onKeyDown } = useListKeyboardNav({
    length: filtered.length,
    onEnter: (i) => { if (filtered[i]) pick(filtered[i]); },
  });

  // Global keys: ⌘P toggles the palette; ⌘1-9 jump to the Nth openable project.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.altKey) return;
      if (e.key.toLowerCase() === 'p' && !e.shiftKey && !isTerminalTarget(e.target)) {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if (/^[1-9]$/.test(e.key) && !e.shiftKey && !isEditableTarget(e.target)) {
        const target = openable[Number(e.key) - 1];
        if (!target) return;
        e.preventDefault();
        if (target.name !== active) void goToProject(target.name);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openable, active]);

  // Reset + focus each time it opens.
  useEffect(() => {
    if (!open) return;
    setQ('');
    setFocused(0);
    const raf = requestAnimationFrame(() => { try { inputRef.current?.focus(); } catch { /* ignore */ } });
    return () => cancelAnimationFrame(raf);
  }, [open, setFocused]);

  return (
    <CommandModal id="project-switcher" open={open} onClose={close} ariaLabel="Go to project" className="psw-modal">
      <div className="psw-input-row">
        <input
          ref={inputRef}
          className="psw-input"
          value={q}
          placeholder="Go to project…"
          spellCheck={false}
          autoComplete="off"
          aria-label="Go to project"
          onChange={(e) => { setQ(e.target.value); setFocused(0); }}
          onKeyDown={onKeyDown}
        />
        <kbd className="psw-kbd">esc</kbd>
      </div>

      <div className="psw-list" role="listbox" aria-label="Projects">
        {!inLauncher && (
          <button type="button" className="psw-row psw-row--home" onClick={goHome}>
            <span className="psw-home-glyph" aria-hidden="true">←</span>
            <span className="psw-row-main"><span className="psw-row-name">Launcher</span></span>
            <span className="psw-row-hint">home</span>
          </button>
        )}

        {filtered.length === 0 && (
          <div className="psw-empty">
            {vaults.length === 0 ? 'No projects registered yet.' : `No projects match “${q.trim()}”.`}
          </div>
        )}

        {filtered.map((v, i) => {
          const isCurrent = v.name === active;
          const quickIdx = openable.indexOf(v);
          return (
            <button
              key={v.name}
              type="button"
              role="option"
              aria-selected={i === focused}
              disabled={!v.exists}
              className={`psw-row${i === focused ? ' psw-row--focused' : ''}${isCurrent ? ' psw-row--current' : ''}`}
              onClick={() => pick(v)}
              onMouseEnter={() => setFocused(i)}
            >
              <VaultDot exists={v.exists} needsUpdate={v.needsUpdate} />
              <span className="psw-row-main">
                <span className="psw-row-name">{v.name}</span>
                <span className="psw-row-path">{v.path}</span>
              </span>
              {isCurrent ? (
                <span className="psw-row-hint psw-row-hint--current">current</span>
              ) : quickIdx >= 0 && quickIdx < 9 ? (
                <kbd className="psw-row-num">⌘{quickIdx + 1}</kbd>
              ) : null}
            </button>
          );
        })}
      </div>

      <div className="psw-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
        <span><kbd>↵</kbd> {inLauncher ? 'open' : 'switch'}</span>
        <span><kbd>⌘</kbd><kbd>1-9</kbd> jump</span>
        <span><kbd>esc</kbd> close</span>
      </div>
    </CommandModal>
  );
}
