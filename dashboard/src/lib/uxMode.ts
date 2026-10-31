/**
 * The new shell's ONE gate: which shell this window draws, `classic` (today's) or `new` (the
 * Codex-style one: a title bar with a project picker, a left rail, a card frame).
 *
 * The switch is Settings → This machine → "New layout", stored in
 * `~/.dreamcontext/launcher-ui.json` (`lib/launcherPrefs.ts`). It is settled ONCE per window,
 * from the server, and then frozen: flipping it mid-session would swap the layout under live
 * project instances, so the Settings row says "Restart the app to switch".
 *
 * This module is the only reader of `shell` (source guard: new-shell-gate.test.ts). Every
 * new-shell branch reads `useShellMode()` / `ShellModeContext`, never the pref.
 *
 * It is `classic` whatever the switch says on the phone (a narrow touch screen at mount), on
 * the Mac phone surface (Mac mode's tunnel), and in the notch, viewer, inbox and checklist
 * windows (their `App.tsx` branches never provide this context).
 */
import { createContext, createElement, useContext, useEffect, useState, type ReactNode } from 'react';
import { isMacPhoneSurface } from './phoneSurface';
import { readIsMobile } from '../hooks/useIsMobile';
import { DEFAULT_SHELL_PREF, initLauncherPrefsFromServer, readShellPrefAnswered, readShellPrefSettled } from './launcherPrefs';

export type ShellMode = 'pending' | 'new' | 'classic';

/** The switch ships ON (W3): an install that never chose opens in the new shell. An explicit
 *  `classic` stays classic, and a server that cannot answer still means today's shell (it may be
 *  holding exactly that `classic`). */
export const DEFAULT_SHELL: 'classic' | 'new' = DEFAULT_SHELL_PREF;

let frozen: 'new' | 'classic' | null = null;

/** How long a window waits for the stored switch before it settles on the default. */
export const SETTLE_CAP_MS = 3_000;

/** Surfaces that keep today's UI whatever the switch says. Read at mount, then frozen. */
export function shellForcedClassic(): boolean {
  if (typeof window === 'undefined') return true;
  return isMacPhoneSurface() || readIsMobile();
}

/** The frozen answer, or null while it is still settling. */
export function readShellModeFrozen(): 'new' | 'classic' | null {
  return frozen;
}

/** Settle the gate once (idempotent). */
export async function settleShellMode(): Promise<'new' | 'classic'> {
  if (frozen) return frozen;
  if (shellForcedClassic()) {
    frozen = 'classic';
    return frozen;
  }
  // A server that never answers must not leave a blank window: after the cap, today's shell.
  await Promise.race([initLauncherPrefsFromServer(), new Promise<void>((r) => { setTimeout(r, SETTLE_CAP_MS); })]);
  // Never chosen = the default, but only when the server ANSWERED: an unread file may hold an
  // explicit `classic`, and a guess must never override it.
  const answered = readShellPrefAnswered();
  if (!frozen) frozen = (answered ? readShellPrefSettled() ?? DEFAULT_SHELL : 'classic') === 'new' ? 'new' : 'classic';
  return frozen;
}

/** Tests only. */
export function resetShellModeForTests(): void {
  frozen = null;
}

/** What a component under a window root sees. No provider (notch, viewer, inbox, checklist,
 *  tests) = classic. */
export const ShellModeContext = createContext<ShellMode>('classic');

export function useShellMode(): ShellMode {
  return useContext(ShellModeContext);
}

/** True only once settled to the new shell: every branch draws classic while pending. */
export function useIsNewShell(): boolean {
  return useContext(ShellModeContext) === 'new';
}

/** Wraps a window root (the launcher and `?vault=` windows). Children render only once the
 *  gate is settled, so no window ever draws one shell and then swaps to the other. */
export function ShellModeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ShellMode>(() => frozen ?? 'pending');
  useEffect(() => {
    if (mode !== 'pending') return;
    let live = true;
    void settleShellMode().then((m) => { if (live) setMode(m); });
    return () => { live = false; };
  }, [mode]);
  if (mode === 'pending') return null;
  return createElement(ShellModeContext.Provider, { value: mode }, children);
}

/**
 * Space, embedded on the new shell's Project Relations page: opening a project there must land
 * in THIS window (`addTab`), never in a new one. Null (the real launcher window) keeps its own
 * `openVaultWindow` exactly as today.
 */
export const LauncherOpenContext = createContext<((name: string, start?: 'initializer') => void) | null>(null);

/** A page's drawer toggle (⌘B / the title-bar button) on a page that has its own drawer
 *  (Whiteboards' explorer). Emitted on the instance bus by `PageDrawerToggleBridge`. */
export const TOGGLE_PAGE_DRAWER_EVENT = 'dc-toggle-page-drawer';

/** The pages whose side panel can be shown and hidden: the title-bar button and ⌘B drive it. */
export const PAGES_WITH_PANEL: ReadonlySet<string> = new Set(['whiteboards', 'brain']);

/** What the title-bar drawer button and ⌘B toggle here: the page's own panel, or the chat drawer. */
export function drawerTogglePanel(o: { chatOpen: boolean; page: string }): 'page' | 'chat-drawer' {
  return !o.chatOpen && PAGES_WITH_PANEL.has(o.page) ? 'page' : 'chat-drawer';
}

/** A board that draws its own card (Tasks, Roadmap, Hypotheses), inside the new shell's frame:
 *  no second border, radius or shadow, and the frame's height instead of the viewport's. */
export const NEW_SHELL_BOARD = { height: '100%', maxHeight: '100%', border: 'none', borderRadius: 0, boxShadow: 'none' } as const;
