import { useSyncExternalStore } from 'react';
import type { AutomationSummary } from '../../hooks/useAutomations';
import { readPanelOpen, writePanelOpen } from './boardPlace';
import { isValidRefFor, readWidgetPayload } from './widgetModel';

/**
 * The board agent panel's client state, per project (one window can hold several):
 *  - whether the panel is open, remembered per machine (boardPlace.ts);
 *  - which agent it shows on each board (this app run only);
 *  - the agent cards on each open board, so the panel knows every agent there, not only the
 *    ones whose manifest names the board (owner, 2026-10-06);
 *  - a drag's drop target (a card or the panel), so both can say "drop here" while it hovers;
 *  - the card the panel asked to point at, briefly flashed;
 *  - the open canvas's "show this card" handle, for the panel's Locate button.
 */
const open = new Map<string, boolean>();
/** The agent the owner picked in the panel, per `<vault>|<board>` (this app run only). */
const picked = new Map<string, string>();
const listeners = new Set<() => void>();

const key = (vault: string, board: string) => `${encodeURIComponent(vault)}|${board}`;

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

// ── the agents on a board ─────────────────────────────────────────────────────────────────

/** One agent card on a board: its element and the agent it names. */
export interface BoardCard {
  elementId: string;
  agent: string;
}

const NO_CARDS: readonly BoardCard[] = [];
const cardsByBoard = new Map<string, readonly BoardCard[]>();

/** The live agent cards in a scene (or a board file's elements), in scene order. */
export function agentCardsOf(elements: readonly unknown[] | undefined): BoardCard[] {
  const out: BoardCard[] = [];
  for (const el of Array.isArray(elements) ? elements : []) {
    const e = el as { id?: unknown; isDeleted?: boolean; customData?: unknown } | null;
    const payload = readWidgetPayload(e);
    if (!e || e.isDeleted || typeof e.id !== 'string' || payload?.kind !== 'agent' || !isValidRefFor('agent', payload.ref)) continue;
    out.push({ elementId: e.id, agent: payload.ref });
  }
  return out;
}

const sameCards = (a: readonly BoardCard[], b: readonly BoardCard[]) =>
  a.length === b.length && a.every((c, i) => c.elementId === b[i]!.elementId && c.agent === b[i]!.agent);

/** The open board's agent cards changed (its file loaded, or the scene changed). Heard only
 *  when the list really differs: the scene changes on every pointer move of a drag. */
export function setBoardCards(vault: string | null, board: string, cards: readonly BoardCard[]): void {
  if (!vault) return;
  const k = key(vault, board);
  if (sameCards(cardsByBoard.get(k) ?? NO_CARDS, cards)) return;
  cardsByBoard.set(k, cards.length ? cards : NO_CARDS);
  notify();
}

export function boardCardsOf(vault: string | null, board: string | undefined): readonly BoardCard[] {
  return vault && board ? cardsByBoard.get(key(vault, board)) ?? NO_CARDS : NO_CARDS;
}

export function useBoardCards(vault: string | null, board: string | undefined): readonly BoardCard[] {
  return useSyncExternalStore(subscribe, () => boardCardsOf(vault, board));
}

/** A board's home agents: the ones whose manifest names it. */
export function homeAgentsOf(automations: readonly AutomationSummary[] | undefined, board: string): AutomationSummary[] {
  return (automations ?? []).filter((a) => a.whiteboard === board).sort((a, b) => a.title.localeCompare(b.title));
}

/** Every agent on `board`, by title: its home agents and every agent with a card there. A card
 *  naming an agent this project does not have is left out (its card says so). */
export function boardAgentsOf(
  automations: readonly AutomationSummary[] | undefined,
  board: string,
  cards: readonly BoardCard[],
): AutomationSummary[] {
  const carded = new Set(cards.map((c) => c.agent));
  return (automations ?? []).filter((a) => a.whiteboard === board || carded.has(a.slug)).sort((a, b) => a.title.localeCompare(b.title));
}

/** The agent the panel shows on `board`: the one picked there, else the first by title. */
export function panelAgentOf(agents: readonly AutomationSummary[], pick: string | null): AutomationSummary | null {
  return agents.find((a) => a.slug === pick) ?? agents[0] ?? null;
}

export function setPanelAgent(vault: string | null, board: string, slug: string): void {
  if (!vault || picked.get(key(vault, board)) === slug) return;
  picked.set(key(vault, board), slug);
  notify();
}

/** The slug picked in the panel for `board`, or null when the owner never picked. */
export function usePanelPick(vault: string | null, board: string | undefined): string | null {
  return useSyncExternalStore(subscribe, () => (vault && board ? picked.get(key(vault, board)) ?? null : null));
}

/** The agent the panel shows on `board` while it is open, read outside React (the canvas's drop). */
export function panelAgentSlug(vault: string | null, board: string, automations: readonly AutomationSummary[] | undefined): string | null {
  if (!vault || !isOpen(vault)) return null;
  return panelAgentOf(boardAgentsOf(automations, board, boardCardsOf(vault, board)), picked.get(key(vault, board)) ?? null)?.slug ?? null;
}

/** Open the panel on `agent` (a click on its card, a drop on it). */
export function showAgentInPanel(vault: string | null, board: string | undefined, agent: string): void {
  if (!vault || !board) return;
  setPanelAgent(vault, board, agent);
  setAgentPanelOpen(vault, true);
}

// ── a drag's drop target ──────────────────────────────────────────────────────────────────

/** Where the element being dragged would land if released now. */
export type DropTarget = (
  | { kind: 'card'; elementId: string; agent: string }
  | { kind: 'panel'; agent: string }
) & {
  /** What would land, as its chip reads ("Note · Pricing idea", "+2" for more): the panel cannot
   *  see the element, which stays in the canvas beside it. */
  what?: string;
};

const targets = new Map<string, DropTarget>();

const sameTarget = (a: DropTarget | undefined, b: DropTarget | null) =>
  (!a && !b) || (!!a && !!b && a.kind === b.kind && a.agent === b.agent && a.what === b.what
    && (a.kind !== 'card' || (b.kind === 'card' && a.elementId === b.elementId)));

export function setDropTarget(vault: string | null, board: string, target: DropTarget | null): void {
  if (!vault) return;
  const k = key(vault, board);
  if (sameTarget(targets.get(k), target)) return;
  if (target) targets.set(k, target); else targets.delete(k);
  notify();
}

export function useDropTarget(vault: string | null, board: string | undefined): DropTarget | null {
  return useSyncExternalStore(subscribe, () => (vault && board ? targets.get(key(vault, board)) ?? null : null));
}

/** The panel's element per project, hit-tested by the canvas while a drag is on. */
const panels = new Map<string, HTMLElement>();

export function registerPanelElement(vault: string | null, el: HTMLElement | null): void {
  if (!vault) return;
  if (el) panels.set(vault, el); else panels.delete(vault);
}

/** Whether a viewport point is over this project's open panel. */
export function pointOverPanel(vault: string | null, clientX: number, clientY: number): boolean {
  const el = vault ? panels.get(vault) : undefined;
  if (!el?.isConnected) return false;
  const r = el.getBoundingClientRect();
  return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
}

/** The panel's composer (or, before it mounts, the panel), where a dropped chip flies to. */
export function panelLandingOf(vault: string | null): DOMRect | null {
  const el = vault ? panels.get(vault) : undefined;
  if (!el?.isConnected) return null;
  const box = el.querySelector('.chat-cmp-input') ?? el.querySelector('.wb-agent-panel-body') ?? el;
  return box.getBoundingClientRect();
}

// ── pointing at a card ────────────────────────────────────────────────────────────────────

/** How long a located card stays flashed. */
export const CARD_FLASH_MS = 1600;

const flashes = new Map<string, string>();
const flashTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Flash one card on a board (the panel's Locate, a drop on it). */
export function flashCard(vault: string | null, board: string, elementId: string): void {
  if (!vault) return;
  const k = key(vault, board);
  clearTimeout(flashTimers.get(k));
  flashes.delete(k);
  notify();
  // A frame apart, so a second flash of the same card restarts its animation.
  requestAnimationFrame(() => {
    flashes.set(k, elementId);
    notify();
    flashTimers.set(k, setTimeout(() => {
      flashTimers.delete(k);
      if (flashes.get(k) === elementId) { flashes.delete(k); notify(); }
    }, CARD_FLASH_MS));
  });
}

export function useCardFlash(vault: string | null, board: string | undefined, elementId: string): boolean {
  return useSyncExternalStore(subscribe, () => !!vault && !!board && flashes.get(key(vault, board)) === elementId);
}

type Locator = (elementId: string) => void;
const locators = new Map<string, Locator>();

/** The open canvas registers how it brings a card into view. Returns the unregister. */
export function registerCardLocator(vault: string | null, board: string, fn: Locator): () => void {
  if (!vault) return () => {};
  const k = key(vault, board);
  locators.set(k, fn);
  return () => { if (locators.get(k) === fn) locators.delete(k); };
}

/** Bring a card into view and flash it. False when no canvas for that board is open. */
export function locateCard(vault: string | null, board: string, elementId: string): boolean {
  const fn = vault ? locators.get(key(vault, board)) : undefined;
  if (!fn) return false;
  fn(elementId);
  flashCard(vault, board, elementId);
  return true;
}
