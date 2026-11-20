import type { Page } from '../components/layout/Sidebar';

/**
 * The window's places (navigation B, C1): one back/forward list for the whole window, across
 * projects, plus what each project remembers (the last item opened on each page, where the owner
 * was, the places he visited lately). Pure: no timers, no React. Only the window's recorder
 * (`components/layout/navRecorder.ts`) writes to it.
 *
 * A chat place is the PROJECT's Chat (A1): one per project, never a window or a member.
 */
export type PagePlace = { vault: string; kind: 'page'; page: Page; id: string | null; label: string | null };
export type ChatPlace = { vault: string; kind: 'chat' };
export type Place = PagePlace | ChatPlace;

/** Equal places: same project and kind; on a page also the same page and equal ids, a null id
 *  matching any (the page settled before its item was published). */
export function samePlace(a: Place | null | undefined, b: Place | null | undefined): boolean {
  if (!a || !b || a.vault !== b.vault || a.kind !== b.kind) return false;
  if (a.kind === 'chat' || b.kind === 'chat') return true;
  return a.page === b.page && (a.id === null || b.id === null || a.id === b.id);
}

/** A stable key for "this exact place" (the recent list's distinct rows). */
export function placeKey(p: Place): string {
  return p.kind === 'chat' ? `${p.vault}\u0000chat` : `${p.vault}\u0000${p.page}\u0000${p.id ?? ''}`;
}

/** Pages that already reopen their own last item (Whiteboards' last board): no last item is
 *  handed to them, they land on what they remember. */
const SELF_REMEMBERING: ReadonlySet<Page> = new Set<Page>(['whiteboards']);

/** How long a remembered item or visit is kept. */
export const PLACE_MEMORY_MS = 7 * 24 * 60 * 60 * 1000;

/** The window-global localStorage key (read-merge-written: two windows share it). */
export const PLACE_MEMORY_KEY = 'dreamcontext.nav.places';

interface Remembered { id: string; label: string | null; at: number }
interface Visit { place: Place; at: number }
export interface PlaceMemory {
  /** vault → page → the last item opened there. */
  items: Record<string, Record<string, Remembered>>;
  /** placeKey → the newest visit of that place. */
  visits: Record<string, Visit>;
}

export interface PlaceStorage {
  read(): string | null;
  write(raw: string): void;
}

/** `localStorage` under {@link PLACE_MEMORY_KEY}; null where there is none. */
export function localPlaceStorage(): PlaceStorage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    const ls = window.localStorage;
    return {
      read: () => { try { return ls.getItem(PLACE_MEMORY_KEY); } catch { return null; } },
      write: (raw) => { try { ls.setItem(PLACE_MEMORY_KEY, raw); } catch { /* full or blocked: memory only */ } },
    };
  } catch {
    return null;
  }
}

function isPlace(v: unknown): v is Place {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  if (typeof p.vault !== 'string' || !p.vault) return false;
  if (p.kind === 'chat') return true;
  return p.kind === 'page' && typeof p.page === 'string' && (p.id === null || typeof p.id === 'string')
    && (p.label === null || typeof p.label === 'string');
}

function parseMemory(raw: string | null): PlaceMemory {
  const out: PlaceMemory = { items: {}, visits: {} };
  if (!raw) return out;
  try {
    const j = JSON.parse(raw) as Partial<PlaceMemory>;
    for (const [vault, pages] of Object.entries(j.items ?? {})) {
      if (!pages || typeof pages !== 'object') continue;
      for (const [page, r] of Object.entries(pages)) {
        if (r && typeof r.id === 'string' && typeof r.at === 'number') {
          (out.items[vault] ??= {})[page] = { id: r.id, label: typeof r.label === 'string' ? r.label : null, at: r.at };
        }
      }
    }
    for (const [k, v] of Object.entries(j.visits ?? {})) {
      if (v && isPlace(v.place) && typeof v.at === 'number') out.visits[k] = { place: v.place, at: v.at };
    }
  } catch { /* unreadable: start empty */ }
  return out;
}

/** Newest wins per key; anything older than {@link PLACE_MEMORY_MS} is dropped. */
export function mergeMemory(a: PlaceMemory, b: PlaceMemory, now: number): PlaceMemory {
  const out: PlaceMemory = { items: {}, visits: {} };
  const fresh = (at: number) => now - at <= PLACE_MEMORY_MS;
  // `b` wins a tie (the write being made now over what was read).
  for (const src of [a, b]) {
    const wins = (at: number, cur: number) => (src === b ? at >= cur : at > cur);
    for (const [vault, pages] of Object.entries(src.items)) {
      for (const [page, r] of Object.entries(pages)) {
        if (!fresh(r.at)) continue;
        const cur = out.items[vault]?.[page];
        if (!cur || wins(r.at, cur.at)) (out.items[vault] ??= {})[page] = r;
      }
    }
    for (const [k, v] of Object.entries(src.visits)) {
      if (!fresh(v.at)) continue;
      const cur = out.visits[k];
      if (!cur || wins(v.at, cur.at)) out.visits[k] = v;
    }
  }
  return out;
}

export interface StepState { target: Place; previous: number }

export interface PlaceHistory {
  /** Settled on `place`: equal to the entry at the cursor fills it in place (a null id never
   *  overwrites a known one), else forward entries go and it is appended, like a browser. */
  record(place: Place): void;
  /** Move the cursor one entry back (-1) or forward (1), past entries `skip` rejects. A step
   *  begun while another is still pending walks on from it and keeps the first one's origin. */
  beginStep(direction: -1 | 1, skip: (p: Place) => boolean): StepState | null;
  commitStep(): void;
  /** Commit, filling the entry with what actually settled (same project and kind). */
  commitStepAt(place: Place): void;
  /** The step did not land: the cursor goes back to where it was. */
  abortStep(): void;
  stepPending(): boolean;
  peekBack(skip: (p: Place) => boolean): Place | null;
  peekForward(skip: (p: Place) => boolean): Place | null;
  /** The last item opened on `page` in `vault` (null for a page that remembers its own). */
  lastItemOn(vault: string, page: Page): { id: string; label: string | null } | null;
  lastHere(vault: string): Place | null;
  /** Distinct places of `vault` from the last 7 days, newest first, `lastHere` excluded. */
  recent(vault: string): Place[];
  /** Tests and diagnostics. */
  entries(): { list: Place[]; cursor: number };
}

export function createPlaceHistory(opts: { now: () => number; storage: PlaceStorage | null }): PlaceHistory {
  const { now, storage } = opts;
  let list: Place[] = [];
  let cursor = -1;
  let step: { previous: number } | null = null;
  let memory: PlaceMemory = mergeMemory(parseMemory(storage?.read() ?? null), { items: {}, visits: {} }, now());

  const remember = (place: Place) => {
    const at = now();
    const delta: PlaceMemory = { items: {}, visits: {} };
    if (place.kind === 'page' && place.id) delta.items[place.vault] = { [place.page]: { id: place.id, label: place.label, at } };
    delta.visits[placeKey(place)] = { place, at };
    // Read-merge-write: another window may have written since this one last read.
    const stored = storage ? parseMemory(storage.read()) : { items: {}, visits: {} };
    memory = mergeMemory(mergeMemory(memory, stored, at), delta, at);
    // A page visit with an id supersedes the same page's id-less visit.
    if (place.kind === 'page' && place.id) delete memory.visits[placeKey({ ...place, id: null })];
    storage?.write(JSON.stringify(memory));
  };

  const fill = (index: number, place: Place) => {
    const cur = list[index];
    if (!cur || cur.kind !== 'page' || place.kind !== 'page') return;
    // Equal places have equal ids or one null: a null never overwrites a known id or its label.
    list[index] = { ...cur, id: place.id ?? cur.id, label: place.id ? (place.label ?? cur.label) : cur.label };
  };

  const walk = (from: number, direction: -1 | 1, skip: (p: Place) => boolean): number => {
    for (let i = from + direction; i >= 0 && i < list.length; i += direction) {
      if (!skip(list[i])) return i;
    }
    return -1;
  };

  const lastHere = (vault: string): Place | null => {
    let best: Visit | null = null;
    for (const v of Object.values(memory.visits)) {
      if (v.place.vault === vault && now() - v.at <= PLACE_MEMORY_MS && (!best || v.at > best.at)) best = v;
    }
    return best?.place ?? null;
  };

  return {
    record(place) {
      if (cursor >= 0 && samePlace(list[cursor], place)) {
        fill(cursor, place);
      } else {
        list = [...list.slice(0, cursor + 1), place];
        cursor = list.length - 1;
      }
      remember(cursor >= 0 ? list[cursor] : place);
    },
    beginStep(direction, skip) {
      const found = walk(cursor, direction, skip);
      if (found < 0) return null;
      const previous = step ? step.previous : cursor;
      step = { previous };
      cursor = found;
      return { target: list[found], previous };
    },
    commitStep() {
      if (step && cursor >= 0) remember(list[cursor]);
      step = null;
    },
    commitStepAt(place) {
      if (step && cursor >= 0 && list[cursor].vault === place.vault) {
        // The same place fills in place; a neighbour of the same kind (another page) replaces it.
        if (samePlace(list[cursor], place)) fill(cursor, place);
        else if (list[cursor].kind === place.kind) list[cursor] = place;
        remember(list[cursor]);
      }
      step = null;
    },
    abortStep() {
      if (step) cursor = step.previous;
      step = null;
    },
    stepPending: () => step !== null,
    peekBack: (skip) => { const i = walk(cursor, -1, skip); return i < 0 ? null : list[i]; },
    peekForward: (skip) => { const i = walk(cursor, 1, skip); return i < 0 ? null : list[i]; },
    lastItemOn(vault, page) {
      if (SELF_REMEMBERING.has(page)) return null;
      const r = memory.items[vault]?.[page];
      return r && now() - r.at <= PLACE_MEMORY_MS ? { id: r.id, label: r.label } : null;
    },
    lastHere,
    recent(vault) {
      const last = lastHere(vault);
      return Object.values(memory.visits)
        .filter((v) => v.place.vault === vault && now() - v.at <= PLACE_MEMORY_MS && !(last && placeKey(last) === placeKey(v.place)))
        .sort((a, b) => b.at - a.at)
        .map((v) => v.place);
    },
    entries: () => ({ list: [...list], cursor }),
  };
}
