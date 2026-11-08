/**
 * Named chat windows inside ONE project's chat surface (the new shell's W3, plan D8). Pure, so
 * the model is testable without React; `AgentSurface` holds the state and draws it.
 *
 * The SELECTED window's panes are the surface's live `panes` state (every existing pane action
 * keeps working on it unchanged). The other windows are PARKED here: their panes keep the tabs'
 * conversation ids (`claudeId`), never the surface's session ids, because a respawn (a mode
 * switch, a resume, a park) swaps a tab's session id in place but keeps its conversation. Their
 * sessions stay mounted and running; only their placement is parked.
 *
 * On disk (`state/.agent-sessions.json`) each tab carries its `window`, and `pane` stays ONE
 * index across the whole surface, window after window: an app that knows nothing of windows
 * still lays every tab out in its own pane (the downgrade rule of D8).
 */

export interface WinPane {
  id: string;
  /** Session ids in the live window; conversation ids in a parked one. */
  tabs: string[];
  active: string;
}

export interface ChatWindow {
  id: string;
  name: string;
  /** Parked placement (conversation ids). Stale, and ignored, for the selected window. */
  panes: WinPane[];
  /** The parked window's focused pane id. */
  activePaneId: string;
}

export interface WindowsState {
  list: ChatWindow[];
  activeId: string;
}

/** A tab as the window model needs it: its session id and its conversation. */
export interface WinTab {
  id: string;
  claudeId: string;
}

export const DEFAULT_WINDOW_ID = 'main';
/** The stored name of the window a roster from before windows reads as (agent-sessions.ts). */
export const DEFAULT_WINDOW_NAME = 'Chat';
export const WINDOW_ID_RE = /^[a-z0-9-]{1,24}$/;
export const MAX_WINDOW_NAME = 60;
/** A project's tab ceiling, the server's `MAX_SESSIONS` (drift test: agent-windows-surface). */
export const TAB_CAP = 40;

export function initialWindows(): WindowsState {
  return { list: [{ id: DEFAULT_WINDOW_ID, name: DEFAULT_WINDOW_NAME, panes: [], activePaneId: '' }], activeId: DEFAULT_WINDOW_ID };
}

/** A fresh window id, unique in `list`, within the server's id rule. */
export function newWindowId(list: readonly { id: string }[], now = Date.now()): string {
  const taken = new Set(list.map((w) => w.id));
  for (let n = 0; ; n++) {
    const id = `w${now.toString(36)}${n ? `-${n}` : ''}`.slice(0, 24);
    if (!taken.has(id)) return id;
  }
}

/** The name a renamed window keeps: trimmed, capped; null = blank, so the rename reverts. */
export function cleanWindowName(raw: string): string | null {
  const name = raw.trim().slice(0, MAX_WINDOW_NAME);
  return name ? name : null;
}

/** Live panes (session ids) → parked panes (conversation ids). A tab with no session is dropped. */
export function parkPanes(panes: readonly WinPane[], tabs: readonly WinTab[]): WinPane[] {
  const keyOf = new Map(tabs.map((t) => [t.id, t.claudeId] as const));
  return panes
    .map((p) => {
      const keys = p.tabs.map((t) => keyOf.get(t)).filter((k): k is string => !!k);
      return { id: p.id, tabs: keys, active: keyOf.get(p.active) ?? keys[0] ?? '' };
    })
    .filter((p) => p.tabs.length > 0);
}

/** Parked panes (conversation ids) → live panes (session ids). A closed conversation is dropped. */
export function unparkPanes(panes: readonly WinPane[], tabs: readonly WinTab[]): WinPane[] {
  const idOf = new Map(tabs.map((t) => [t.claudeId, t.id] as const));
  return panes
    .map((p) => {
      const ids = p.tabs.map((k) => idOf.get(k)).filter((k): k is string => !!k);
      return { id: p.id, tabs: ids, active: idOf.get(p.active) ?? ids[0] ?? '' };
    })
    .filter((p) => p.tabs.length > 0);
}

/** Every conversation parked in a window other than the selected one, with its window. */
export function parkedHomes(state: WindowsState): Map<string, string> {
  const out = new Map<string, string>();
  for (const w of state.list) {
    if (w.id === state.activeId) continue;
    for (const p of w.panes) for (const k of p.tabs) out.set(k, w.id);
  }
  return out;
}

/** Which window holds a tab: a parked window by its conversation, else the selected one. */
export function windowOfTab(state: WindowsState, claudeId: string): string {
  return parkedHomes(state).get(claudeId) ?? state.activeId;
}

/**
 * Show another window: the selected one's live panes are parked, the target's come back live.
 * Returns the new state and the panes to make live, or null when there is nothing to switch.
 */
export function switchWindow(
  state: WindowsState,
  targetId: string,
  live: { panes: readonly WinPane[]; activePaneId: string },
  tabs: readonly WinTab[],
): { state: WindowsState; panes: WinPane[]; activePaneId: string } | null {
  if (targetId === state.activeId) return null;
  const target = state.list.find((w) => w.id === targetId);
  if (!target) return null;
  const list = state.list.map((w) => (w.id === state.activeId
    ? { ...w, panes: parkPanes(live.panes, tabs), activePaneId: live.activePaneId }
    : w));
  const panes = unparkPanes(target.panes, tabs);
  const activePaneId = panes.some((p) => p.id === target.activePaneId) ? target.activePaneId : panes[0]?.id ?? '';
  return {
    state: { list: list.map((w) => (w.id === targetId ? { ...w, panes: [], activePaneId: '' } : w)), activeId: targetId },
    panes,
    activePaneId,
  };
}

/** A new, empty window right after the selected one, selected. */
export function addWindow(
  state: WindowsState,
  name: string,
  live: { panes: readonly WinPane[]; activePaneId: string },
  tabs: readonly WinTab[],
  now = Date.now(),
): { state: WindowsState; id: string } {
  const id = newWindowId(state.list, now);
  const at = state.list.findIndex((w) => w.id === state.activeId);
  const list = state.list.map((w) => (w.id === state.activeId
    ? { ...w, panes: parkPanes(live.panes, tabs), activePaneId: live.activePaneId }
    : w));
  list.splice(at + 1, 0, { id, name, panes: [], activePaneId: '' });
  return { state: { list, activeId: id }, id };
}

/** `template`'s name for window number `n` ("Chat {n}" → "Chat 3"). */
function numbered(template: string, n: number): string {
  return template.replace('{n}', String(n));
}

/**
 * The numbered name ("Chat 3") a window gets when it starts empty: one the other windows do not
 * already carry. `own` = an existing window starting over (it is already counted); without it,
 * the name of a window about to be added. `template` is the localized "Chat {n}".
 */
export function freshWindowName(list: readonly { id: string; name: string }[], template: string, own?: string): string {
  const taken = new Set(list.filter((w) => w.id !== own).map((w) => w.name));
  for (let n = own ? list.length : list.length + 1; ; n++) {
    const name = numbered(template, n);
    if (!taken.has(name)) return name;
  }
}

/** A name nobody chose: the first window's "Chat", or a numbered "Chat 3". */
function isDefaultWindowName(name: string, template: string): boolean {
  if (name === DEFAULT_WINDOW_NAME) return true;
  const [head, tail = ''] = template.split('{n}');
  return name.length > head.length + tail.length && name.startsWith(head) && name.endsWith(tail)
    && /^\d+$/.test(name.slice(head.length, name.length - tail.length));
}

/**
 * An empty window taking its next chat starts clean: a name the owner gave it goes back to a fresh
 * numbered one. An empty window has no row in the drawer, so that name is one the owner can no
 * longer see, and keeping it brought a closed chat's name back on a brand-new chat (owner, 0.36.9).
 * A name nobody chose stays as it is, unless another window carries it too. Same state when the
 * window is unknown or nothing changes.
 */
export function freshenWindow(state: WindowsState, id: string, template: string): WindowsState {
  const w = state.list.find((x) => x.id === id);
  if (!w) return state;
  const shared = state.list.some((x) => x.id !== id && x.name === w.name);
  if (isDefaultWindowName(w.name, template) && !shared) return state;
  const name = freshWindowName(state.list, template, id);
  return w.name === name ? state : { ...state, list: state.list.map((x) => (x.id === id ? { ...x, name } : x)) };
}

export function renameWindow(state: WindowsState, id: string, raw: string): WindowsState {
  const name = cleanWindowName(raw);
  if (!name) return state;
  return { ...state, list: state.list.map((w) => (w.id === id ? { ...w, name } : w)) };
}

/** `id` moved right before `before` (null = the end); the rest keep their order. An unknown
 *  `id` or `before` changes nothing. */
export function moveBefore<T extends { id: string }>(list: readonly T[], id: string, before: string | null): T[] {
  const moved = list.find((w) => w.id === id);
  if (!moved || id === before) return [...list];
  const rest = list.filter((w) => w.id !== id);
  const at = before === null ? rest.length : rest.findIndex((w) => w.id === before);
  if (at < 0) return [...list];
  return [...rest.slice(0, at), moved, ...rest.slice(at)];
}

/** The drawer's drag: this order is the roster's `windows`, so a save keeps it. */
export function moveWindow(state: WindowsState, id: string, before: string | null): WindowsState {
  const list = moveBefore(state.list, id, before);
  return list.every((w, i) => w === state.list[i]) ? state : { ...state, list };
}

/** The windows in the saved order (a re-hydrate): one the roster does not list yet stays, at
 *  the end. Without this, a surface told to re-read would write its old order straight back. */
export function adoptWindowOrder(state: WindowsState, saved: readonly { id: string }[]): WindowsState {
  const at = new Map(saved.map((w, i) => [w.id, i] as const));
  const named = state.list.filter((w) => at.has(w.id)).sort((a, b) => at.get(a.id)! - at.get(b.id)!);
  const list = [...named, ...state.list.filter((w) => !at.has(w.id))];
  return list.every((w, i) => w === state.list[i]) ? state : { ...state, list };
}

/** Drop a window from the list (its tabs are closed by the caller). The last one stays. */
export function dropWindow(state: WindowsState, id: string): WindowsState {
  if (state.list.length <= 1 || state.activeId === id) return state;
  return { ...state, list: state.list.filter((w) => w.id !== id) };
}

/** After a window closes: with no chat left in the project, its Super Agent comes up (if any). */
export function landsOnSuper(chatsLeft: number, superEnabled: boolean): boolean {
  return chatsLeft === 0 && superEnabled;
}

/** The window to show when `id` closes: the one after it, else the one before. */
export function neighbourOf(state: WindowsState, id: string): string | null {
  const i = state.list.findIndex((w) => w.id === id);
  if (i < 0 || state.list.length <= 1) return null;
  return (state.list[i + 1] ?? state.list[i - 1]).id;
}

/** Parked conversations that no longer have a tab are dropped; an emptied pane goes with them. */
export function pruneParked(state: WindowsState, known: ReadonlySet<string>): WindowsState {
  let changed = false;
  const list = state.list.map((w) => {
    if (w.id === state.activeId) return w;
    const panes = w.panes
      .map((p) => {
        const tabs = p.tabs.filter((k) => known.has(k));
        if (tabs.length === p.tabs.length) return p;
        changed = true;
        return { ...p, tabs, active: tabs.includes(p.active) ? p.active : tabs[0] ?? '' };
      })
      .filter((p) => p.tabs.length > 0);
    if (panes.length !== w.panes.length) changed = true;
    return panes === w.panes ? w : { ...w, panes };
  });
  return changed ? { ...state, list } : state;
}

/** Apply a pane change to a PARKED window (a window verb from a chat that is not on screen). */
export function updateParked(state: WindowsState, id: string, fn: (panes: WinPane[], activePaneId: string) => { panes: WinPane[]; activePaneId?: string }): WindowsState {
  if (id === state.activeId) return state;
  return {
    ...state,
    list: state.list.map((w) => {
      if (w.id !== id) return w;
      const out = fn(w.panes, w.activePaneId);
      return { ...w, panes: out.panes.filter((p) => p.tabs.length > 0), activePaneId: out.activePaneId ?? w.activePaneId };
    }),
  };
}

/* ── Pure pane moves (the same shapes the live surface's own actions make) ── */

function without(p: WinPane, key: string): WinPane {
  if (!p.tabs.includes(key)) return p;
  const tabs = p.tabs.filter((t) => t !== key);
  return { ...p, tabs, active: p.active === key ? tabs[0] ?? '' : p.active };
}

/** Move a tab into a new pane right of the one it is in. */
export function splitOut(panes: readonly WinPane[], key: string, newPaneId: string): WinPane[] {
  const at = panes.findIndex((p) => p.tabs.includes(key));
  if (at < 0) return [...panes];
  const next = panes.map((p) => without(p, key));
  next.splice(at + 1, 0, { id: newPaneId, tabs: [key], active: key });
  return next.filter((p) => p.tabs.length > 0);
}

/** Move a tab into another pane, as its visible tab. */
export function joinInto(panes: readonly WinPane[], key: string, paneId: string): WinPane[] {
  return panes
    .map((p) => (p.id === paneId ? p : without(p, key)))
    .map((p) => (p.id === paneId ? { ...p, tabs: p.tabs.includes(key) ? p.tabs : [...p.tabs, key], active: key } : p))
    .filter((p) => p.tabs.length > 0);
}

/** Add a tab to a window: into its focused pane, or into a new pane after it. */
export function placeTab(panes: readonly WinPane[], activePaneId: string, key: string, split: boolean, newPaneId: string): { panes: WinPane[]; activePaneId: string } {
  const at = panes.findIndex((p) => p.id === activePaneId);
  if (!panes.length || split) {
    const next = [...panes];
    next.splice(at < 0 ? next.length : at + 1, 0, { id: newPaneId, tabs: [key], active: key });
    return { panes: next, activePaneId: newPaneId };
  }
  const target = at < 0 ? panes[0].id : activePaneId;
  return { panes: panes.map((p) => (p.id === target ? { ...p, tabs: [...p.tabs, key], active: key } : p)), activePaneId: target };
}

/* ── The roster: what is saved, and what a restore rebuilds ── */

export interface SavedWindowMeta {
  id: string;
  name: string;
  /** Surface-wide index of the window's focused pane. */
  activePane?: number;
}

export interface TabPlacement {
  window: string;
  pane?: number;
  active?: boolean;
}

/**
 * The placement every tab is saved with (new shell): windows in order, each window's panes left
 * to right, ONE pane index running across the whole surface. A tab in no pane (minimized) is
 * saved in the selected window with no pane, as it always was.
 */
export function savePlacement(
  state: WindowsState,
  live: { panes: readonly WinPane[]; activePaneId: string },
  tabs: readonly WinTab[],
): { placement: Map<string, TabPlacement>; windows: SavedWindowMeta[]; activePane?: number } {
  const placement = new Map<string, TabPlacement>();
  const windows: SavedWindowMeta[] = [];
  let index = 0;
  let activePane: number | undefined;
  for (const w of state.list) {
    const selected = w.id === state.activeId;
    const panes = selected ? live.panes : unparkPanes(w.panes, tabs);
    const focus = selected ? live.activePaneId : w.activePaneId;
    let winActive: number | undefined;
    for (const p of panes) {
      for (const t of p.tabs) placement.set(t, { window: w.id, pane: index, ...(p.active === t ? { active: true } : {}) });
      if (p.id === focus) {
        winActive = index;
        if (selected) activePane = index;
      }
      index++;
    }
    windows.push({ id: w.id, name: w.name, ...(winActive !== undefined ? { activePane: winActive } : {}) });
  }
  for (const t of tabs) if (!placement.has(t.id)) placement.set(t.id, { window: state.activeId });
  return { placement, windows, ...(activePane !== undefined ? { activePane } : {}) };
}

export interface RestoredTab {
  /** The new session id. */
  id: string;
  claudeId: string;
  window?: string;
  pane?: number;
  active?: boolean;
}

/**
 * Rebuild the windows from a saved roster (new shell). Each tab lands in its saved window (an
 * unknown or missing one = the first), each window's panes regrouped by the saved index (gaps
 * close). The selected window is the one holding the saved focused pane, else the first. A
 * roster from before windows (no `windows`) is one window holding every tab.
 */
export function restoreWindows(
  saved: readonly SavedWindowMeta[] | undefined,
  tabs: readonly RestoredTab[],
  activePane: number | undefined,
  mintPaneId: () => string,
): { state: WindowsState; live: WinPane[]; activePaneId: string } {
  const metas = saved && saved.length ? saved : [{ id: DEFAULT_WINDOW_ID, name: DEFAULT_WINDOW_NAME }];
  const ids = new Set(metas.map((w) => w.id));
  const groups = new Map<string, Map<number, RestoredTab[]>>();
  for (const t of tabs) {
    const win = t.window && ids.has(t.window) ? t.window : metas[0].id;
    const byPane = groups.get(win) ?? new Map<number, RestoredTab[]>();
    const idx = Math.max(0, Math.floor(t.pane ?? 0));
    byPane.set(idx, [...(byPane.get(idx) ?? []), t]);
    groups.set(win, byPane);
  }
  let selected = metas[0].id;
  const built = metas.map((m) => {
    const ordered = [...(groups.get(m.id) ?? new Map<number, RestoredTab[]>()).entries()].sort((a, b) => a[0] - b[0]);
    const panes = ordered.map(([, list]) => ({ id: mintPaneId(), tabs: list.map((t) => t.id), active: (list.find((t) => t.active) ?? list[0]).id }));
    const at = (want: number | undefined) => (want === undefined ? -1 : ordered.findIndex(([idx]) => idx === want));
    if (activePane !== undefined && at(activePane) >= 0) selected = m.id;
    const focusAt = at(activePane) >= 0 ? at(activePane) : at(m.activePane);
    return { meta: m, panes, focus: focusAt >= 0 ? panes[focusAt].id : panes[0]?.id ?? '' };
  });
  const keyOf = new Map(tabs.map((t) => [t.id, t.claudeId] as const));
  const toKeys = (panes: WinPane[]) => panes.map((p) => ({ ...p, tabs: p.tabs.map((t) => keyOf.get(t) ?? t), active: keyOf.get(p.active) ?? p.active }));
  const live = built.find((b) => b.meta.id === selected)!;
  return {
    state: {
      list: built.map((b) => ({ id: b.meta.id, name: b.meta.name, panes: b.meta.id === selected ? [] : toKeys(b.panes), activePaneId: b.meta.id === selected ? '' : b.focus })),
      activeId: selected,
    },
    live: live.panes,
    activePaneId: live.focus,
  };
}

/** What a window row in the drawer shows: its name and the rollup of its own tabs. */
export interface WindowFact {
  id: string;
  name: string;
  working: number;
  asking: number;
  flagged: number;
  other: number;
  /** Every tab it holds, saved ones too. */
  tabs: number;
}

/** Group session rows by the window that holds them (the selected one for anything unparked). */
export function rowsByWindow<R extends { id: string; claudeId?: string }>(state: WindowsState, rows: readonly R[], claudeIdOf: (id: string) => string | undefined): Map<string, R[]> {
  const homes = parkedHomes(state);
  const out = new Map<string, R[]>(state.list.map((w) => [w.id, []]));
  for (const r of rows) {
    const key = r.claudeId ?? claudeIdOf(r.id);
    const win = (key && homes.get(key)) || state.activeId;
    out.get(win)?.push(r);
  }
  return out;
}

/**
 * Where a chat picked in History opens (owner 2026-11-03): in its OWN window, never in the one
 * already holding other chats. A chat that already has a tab brings that tab's window forward
 * (`focus`); a window on screen with no chat in it takes it (`here`), so does any other empty
 * window (`reuse`, never a pile of empty windows); otherwise a new window opens (`new`). A Super
 * Agent session never reaches this rule: its own door (`openInSuperWindow`) runs first.
 */
export type HistoryPickPlan = { kind: 'focus' } | { kind: 'here' } | { kind: 'reuse'; windowId: string } | { kind: 'new' };

export function historyPickPlan(state: WindowsState, hasTab: boolean, chatsIn: (windowId: string) => number): HistoryPickPlan {
  if (hasTab) return { kind: 'focus' };
  if (chatsIn(state.activeId) === 0) return { kind: 'here' };
  const empty = state.list.find((w) => w.id !== state.activeId && chatsIn(w.id) === 0);
  return empty ? { kind: 'reuse', windowId: empty.id } : { kind: 'new' };
}
