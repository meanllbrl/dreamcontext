/**
 * Saved Views store — external state with synchronous localStorage persistence.
 *
 * Uses React 18's `useSyncExternalStore` pattern. No useEffect, no hook order
 * issues, no race conditions: every mutation writes to localStorage and notifies
 * listeners atomically.
 */
import { useSyncExternalStore } from 'react';
import type { FilterState } from '../components/tasks/TaskFilters';

export interface SavedView {
  id: string;
  name: string;
  filters: FilterState;
}

const STORAGE_PREFIX = 'dreamcontext:';
const KEY_SUFFIX = 'kanban-presets';
const LEGACY_UNSCOPED = `${STORAGE_PREFIX}${KEY_SUFFIX}`;

function storageKey(projectId: string): string {
  return projectId ? `${STORAGE_PREFIX}${projectId}:${KEY_SUFFIX}` : LEGACY_UNSCOPED;
}

function readFromStorage(projectId: string): SavedView[] {
  const key = storageKey(projectId);
  try {
    const raw = localStorage.getItem(key);
    if (raw !== null) {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as SavedView[]) : [];
    }
    // One-time migration from unscoped key.
    if (projectId) {
      const legacy = localStorage.getItem(LEGACY_UNSCOPED);
      if (legacy !== null) {
        localStorage.setItem(key, legacy);
        localStorage.removeItem(LEGACY_UNSCOPED);
        const parsed = JSON.parse(legacy);
        return Array.isArray(parsed) ? (parsed as SavedView[]) : [];
      }
    }
  } catch {
    /* corrupted JSON — fall through */
  }
  return [];
}

function writeToStorage(projectId: string, views: SavedView[]): void {
  try {
    localStorage.setItem(storageKey(projectId), JSON.stringify(views));
  } catch {
    /* quota exceeded — silently ignore */
  }
}

// Per-projectId memoized snapshot. Identity must be stable between reads when
// nothing changed, otherwise `useSyncExternalStore` will infinite-loop.
const snapshots = new Map<string, SavedView[]>();

function getSnapshot(projectId: string): SavedView[] {
  let snap = snapshots.get(projectId);
  if (snap === undefined) {
    snap = readFromStorage(projectId);
    snapshots.set(projectId, snap);
  }
  return snap;
}

// Listeners get notified on every mutation. Identity check inside React
// re-renders any component that called useSyncExternalStore.
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(): void {
  for (const l of listeners) l();
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function useSavedViews(projectId: string): SavedView[] {
  return useSyncExternalStore(
    subscribe,
    () => getSnapshot(projectId),
  );
}

export function saveView(projectId: string, name: string, filters: FilterState): SavedView {
  const view: SavedView = {
    id: generateId(),
    name,
    filters,
  };
  const current = getSnapshot(projectId);
  const next = [...current, view];
  snapshots.set(projectId, next);
  writeToStorage(projectId, next);
  emit();
  return view;
}

export function deleteView(projectId: string, id: string): void {
  const current = getSnapshot(projectId);
  const next = current.filter(v => v.id !== id);
  if (next.length === current.length) return; // no change
  snapshots.set(projectId, next);
  writeToStorage(projectId, next);
  emit();
}
