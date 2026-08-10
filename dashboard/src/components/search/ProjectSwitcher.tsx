import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLauncherStatus, type VaultStatus } from '../../hooks/useLauncher';
import { goToProject, openLauncherHome, openVaultWindow } from '../../lib/desktop';
import { useChrome } from '../layout/WindowChrome';
import { CommandModal, useListKeyboardNav } from './CommandModal';
import { VaultDot } from '../layout/VaultDot';
import './ProjectSwitcher.css';

/**
 * ⌘P "Go to Project" — a fast, tab-like project switcher, mounted once per window.
 *
 * A window used to hold exactly one project, so picking one from here meant opening
 * or focusing that project's OWN window. Now a vault window holds several LIVE
 * projects as chips, so the default action is to add (or focus) a chip in THIS
 * window instead (`useChrome().addTab`) — `openVaultWindow` remains as the
 * ⇧-click / ⇧+Enter escape hatch for anyone who wants a real second OS window.
 *
 * The launcher window has no chips to add to (it renders no `WindowChrome`), so it
 * keeps the old behaviour untouched: picking a project opens/focuses that project's
 * window. `useChrome()` tells the two apart — see `inLauncher` below.
 */

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
  const chrome = useChrome();
  // A real `WindowChrome` always seeds a non-empty `activeVault` (the launcher's
  // `?vault=`, read once at boot). The only way to see '' is `DETACHED_CHROME` —
  // the context's default with no provider above it, i.e. this mount is the
  // launcher window, which renders no chrome at all.
  const inLauncher = chrome.activeVault === '';
  const active = inLauncher ? null : chrome.activeVault;

  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  /** Why the last `addTab` attempt didn't open anything — cleared on any successful pick. */
  const [blockedReason, setBlockedReason] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Fetch ONLY while open. Without this gate the query inherits the app-wide 15s
  // refetch interval and would poll `/api/launcher/status` in every vault window
  // forever, since this component is always mounted. react-query keeps the last
  // result cached, so a reopen within the cache window renders instantly.
  const { data } = useLauncherStatus(open);
  const vaults = useMemo(() => data?.vaults ?? [], [data]);

  // Existing projects, in listed order — the launcher's ⌘1-9 target set (a gone
  // folder can't be opened).
  const openable = useMemo(() => vaults.filter((v) => v.exists), [vaults]);

  // The ⌘1-9 quick-jump set: in a vault window it's THIS WINDOW'S CHIPS in chip
  // order (not registry order — chip order and registry order are unrelated once a
  // window can hold several projects); in the launcher it's every registered
  // project, exactly as before.
  const quickTargets = useMemo(
    () => (inLauncher ? openable.map((v) => v.name) : chrome.open.map((p) => p.vault)),
    [inLauncher, openable, chrome.open],
  );

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return vaults;
    return vaults.filter(
      (v) => v.name.toLowerCase().includes(needle) || v.path.toLowerCase().includes(needle),
    );
  }, [vaults, q]);

  const pick = useCallback((v: VaultStatus, opts?: { newWindow?: boolean }) => {
    if (!v.exists) return; // gone folder — nothing to open

    // The escape hatch: a real second OS window, regardless of chip state or window.
    if (opts?.newWindow) {
      setOpen(false);
      setBlockedReason(null);
      void openVaultWindow(v.name);
      return;
    }

    if (inLauncher) {
      setOpen(false);
      setBlockedReason(null);
      void goToProject(v.name);
      return;
    }

    void chrome.addTab(v.name).then((result) => {
      if (result === 'refused-ceiling') {
        // Every open project has a live session, so a new tab would have to evict
        // one and there's nothing safe to evict. Don't close silently — the user
        // needs to know why nothing happened, and how to get it anyway.
        setBlockedReason(
          `Every open project has a live session — close one first, or ⇧-click ${v.name} to open it in its own window.`,
        );
        return;
      }
      setBlockedReason(null);
      setOpen(false);
    });
  }, [inLauncher, chrome]);

  const goHome = useCallback(() => {
    setOpen(false);
    void openLauncherHome();
  }, []);

  // Stable close for the shell (so its topmost-Esc effect doesn't re-register per render).
  const close = useCallback(() => setOpen(false), []);

  // One flat, keyboard-navigable list. Row 0 is the "Launcher" home action (only
  // shown in a vault window); the rest are the filtered projects. Building a
  // single array is what lets ↑/↓ traverse EVERYTHING (home included) and Enter
  // fire the right action per row.
  type Row =
    | { kind: 'home' }
    | { kind: 'vault'; vault: VaultStatus; quickIdx: number };
  const rows = useMemo<Row[]>(() => {
    const list: Row[] = [];
    if (!inLauncher) list.push({ kind: 'home' });
    for (const v of filtered) list.push({ kind: 'vault', vault: v, quickIdx: quickTargets.indexOf(v.name) });
    return list;
  }, [inLauncher, filtered, quickTargets]);

  const activate = useCallback((i: number, opts?: { newWindow?: boolean }) => {
    const row = rows[i];
    if (!row) return;
    if (row.kind === 'home') goHome();
    else pick(row.vault, opts);
  }, [rows, goHome, pick]);

  // Shared ↑/↓/Enter list nav (+ length clamp). Esc is owned by <CommandModal>.
  const { focused, setFocused, onKeyDown } = useListKeyboardNav({
    length: rows.length,
    onEnter: activate,
  });

  // Shift+Enter is the same escape hatch as ⇧-click. The shared nav hook has no
  // notion of modifier keys, so it's intercepted here and everything else falls
  // through to it unchanged.
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      activate(focused, { newWindow: true });
      return;
    }
    onKeyDown(e);
  }, [activate, focused, onKeyDown]);

  // Keep the keyboard-focused row scrolled into view as ↑/↓ move past the fold.
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-row-index="${focused}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [focused]);

  // Global keys: ⌘P toggles the palette; ⌘1-9 jump to the Nth quick target.
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
        const idx = Number(e.key) - 1;
        if (inLauncher) {
          const target = openable[idx];
          if (!target) return;
          e.preventDefault();
          if (target.name !== active) void goToProject(target.name);
        } else {
          const target = chrome.open[idx];
          if (!target) return;
          e.preventDefault();
          chrome.activate(target.vault);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openable, active, inLauncher, chrome]);

  // Reset + focus each time it opens.
  useEffect(() => {
    if (!open) return;
    setQ('');
    setBlockedReason(null);
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
          onChange={(e) => { setQ(e.target.value); setFocused(0); setBlockedReason(null); }}
          onKeyDown={handleKeyDown}
        />
        <kbd className="psw-kbd">esc</kbd>
      </div>

      {blockedReason && (
        <div
          className="psw-blocked-notice"
          role="status"
          style={{
            padding: '8px 16px',
            fontSize: 12,
            lineHeight: 1.4,
            color: 'var(--color-text-secondary)',
            borderBottom: '1px solid var(--color-border)',
          }}
        >
          {blockedReason}
        </div>
      )}

      <div className="psw-list" role="listbox" aria-label="Projects" ref={listRef}>
        {rows.map((row, i) => {
          const isFocused = i === focused;
          if (row.kind === 'home') {
            return (
              <button
                key="__home__"
                type="button"
                role="option"
                aria-selected={isFocused}
                data-row-index={i}
                className={`psw-row psw-row--home${isFocused ? ' psw-row--focused' : ''}`}
                onClick={goHome}
                onMouseEnter={() => setFocused(i)}
              >
                <span className="psw-home-glyph" aria-hidden="true">←</span>
                <span className="psw-row-main"><span className="psw-row-name">Launcher</span></span>
                <span className="psw-row-hint">home</span>
              </button>
            );
          }
          const { vault: v, quickIdx } = row;
          // "current" = the one active chip; "open" = any other chip already in this
          // window. Both reuse the existing dimmed treatment so an already-open
          // project reads as "nothing to do here" at a glance; only the active one
          // gets the accent-coloured label.
          const isActiveChip = !inLauncher && v.name === active;
          const isOpenChip = !inLauncher && chrome.open.some((p) => p.vault === v.name);
          return (
            <button
              key={v.name}
              type="button"
              role="option"
              aria-selected={isFocused}
              data-row-index={i}
              disabled={!v.exists}
              className={`psw-row${isFocused ? ' psw-row--focused' : ''}${isOpenChip ? ' psw-row--current' : ''}`}
              onClick={(e) => pick(v, { newWindow: e.shiftKey })}
              onMouseEnter={() => setFocused(i)}
            >
              <VaultDot exists={v.exists} needsUpdate={v.needsUpdate} />
              <span className="psw-row-main">
                <span className="psw-row-name">{v.name}</span>
                <span className="psw-row-path">{v.path}</span>
              </span>
              {isActiveChip ? (
                <span className="psw-row-hint psw-row-hint--current">current</span>
              ) : isOpenChip ? (
                <span className="psw-row-hint">open</span>
              ) : quickIdx >= 0 && quickIdx < 9 ? (
                <kbd className="psw-row-num">⌘{quickIdx + 1}</kbd>
              ) : null}
            </button>
          );
        })}

        {rows.length === 0 && (
          <div className="psw-empty">
            {vaults.length === 0 ? 'No projects registered yet.' : `No projects match “${q.trim()}”.`}
          </div>
        )}
      </div>

      <div className="psw-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
        <span><kbd>↵</kbd> open</span>
        <span><kbd>⌘</kbd><kbd>1-9</kbd> jump</span>
        <span><kbd>esc</kbd> close</span>
      </div>
    </CommandModal>
  );
}
