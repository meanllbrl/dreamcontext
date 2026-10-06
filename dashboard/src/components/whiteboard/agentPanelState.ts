import { useSyncExternalStore } from 'react';
import type { AutomationSummary } from '../../hooks/useAutomations';
import { readPanelOpen, writePanelOpen } from './boardPlace';

/**
 * Whether a project's board agent panel is open: the page draws the panel, and the home
 * agent's card on the canvas steps aside while it is (one conversation, one place on screen).
 * Per project, since one window can hold several; remembered per machine (boardPlace.ts), so
 * the page reopens the way it was left.
 */
const open = new Map<string, boolean>();
/** The home agent the owner picked in the panel, per `<vault>|<board>` (this app run only). */
const picked = new Map<string, string>();
const listeners = new Set<() => void>();

function isOpen(vault: string | null): boolean {
  if (!vault) return false;
  let v = open.get(vault);
  if (v === undefined) { v = readPanelOpen(vault); open.set(vault, v); }
  return v;
}

function notify(): void {
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function setAgentPanelOpen(vault: string | null, next: boolean): void {
  if (!vault || isOpen(vault) === next) return;
  open.set(vault, next);
  writePanelOpen(vault, next);
  notify();
}

export function useAgentPanelOpen(vault: string | null): boolean {
  return useSyncExternalStore(subscribe, () => isOpen(vault));
}

/** The agents living on `board` (their manifest's `whiteboard`), by title. */
export function homeAgentsOf(automations: readonly AutomationSummary[] | undefined, board: string): AutomationSummary[] {
  return (automations ?? []).filter((a) => a.whiteboard === board).sort((a, b) => a.title.localeCompare(b.title));
}

/** The home agent the panel shows on `board`: the one picked there, else the first by title. */
export function panelAgentOf(homes: readonly AutomationSummary[], pick: string | null): AutomationSummary | null {
  return homes.find((a) => a.slug === pick) ?? homes[0] ?? null;
}

export function setPanelAgent(vault: string | null, board: string, slug: string): void {
  if (!vault || picked.get(`${vault}|${board}`) === slug) return;
  picked.set(`${vault}|${board}`, slug);
  notify();
}

/** The slug picked in the panel for `board`, or null when the owner never picked. */
export function usePanelPick(vault: string | null, board: string | undefined): string | null {
  return useSyncExternalStore(subscribe, () => (vault && board ? picked.get(`${vault}|${board}`) ?? null : null));
}
