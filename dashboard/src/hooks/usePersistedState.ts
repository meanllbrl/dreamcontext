import { useState, useCallback } from 'react';
import { useProject } from '../context/ProjectContext';

const STORAGE_PREFIX = 'dreamcontext:';

/**
 * Project-scoped localStorage state. Write-through on every setter, no useEffect.
 * Safe because <ProjectProvider> blocks rendering until projectId is resolved.
 */
export function usePersistedState<T>(
  key: string,
  defaultValue: T,
): [T, (value: T | ((prev: T) => T)) => void] {
  const { projectId } = useProject();

  const storageKey = projectId
    ? `${STORAGE_PREFIX}${projectId}:${key}`
    : `${STORAGE_PREFIX}${key}`;

  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored !== null) return JSON.parse(stored) as T;

      // One-time migration: copy unscoped legacy key into scoped key.
      if (projectId) {
        const legacyKey = `${STORAGE_PREFIX}${key}`;
        const legacy = localStorage.getItem(legacyKey);
        if (legacy !== null) {
          localStorage.setItem(storageKey, legacy);
          localStorage.removeItem(legacyKey);
          return JSON.parse(legacy) as T;
        }
      }
    } catch {
      // Corrupted JSON — fall through to default
    }
    return defaultValue;
  });

  const setPersistedValue = useCallback((newValue: T | ((prev: T) => T)) => {
    setValue(prev => {
      const next = typeof newValue === 'function'
        ? (newValue as (p: T) => T)(prev)
        : newValue;
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        // quota exceeded or storage disabled
      }
      return next;
    });
  }, [storageKey]);

  return [value, setPersistedValue];
}
