import { useState, useCallback, useEffect } from 'react';
import { useProject } from '../context/ProjectContext';

const STORAGE_PREFIX = 'dreamcontext:';

export function usePersistedState<T>(key: string, defaultValue: T): [T, (value: T | ((prev: T) => T)) => void] {
  const { projectId, ready } = useProject();

  // Project-scoped key: dreamcontext:{projectId}:{key}
  const storageKey = projectId
    ? `${STORAGE_PREFIX}${projectId}:${key}`
    : `${STORAGE_PREFIX}${key}`;

  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored !== null) {
        return JSON.parse(stored) as T;
      }
      // Fallback: try legacy key (without projectId) for migration
      if (projectId) {
        const legacy = localStorage.getItem(`${STORAGE_PREFIX}${key}`);
        if (legacy !== null) {
          return JSON.parse(legacy) as T;
        }
      }
    } catch {
      // Corrupted or missing
    }
    return defaultValue;
  });

  // Re-read from storage when projectId becomes available
  useEffect(() => {
    if (!ready || !projectId) return;
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored !== null) {
        setValue(JSON.parse(stored) as T);
        return;
      }
      // Migrate legacy key to scoped key
      const legacyKey = `${STORAGE_PREFIX}${key}`;
      const legacy = localStorage.getItem(legacyKey);
      if (legacy !== null) {
        localStorage.setItem(storageKey, legacy);
        localStorage.removeItem(legacyKey);
        setValue(JSON.parse(legacy) as T);
      }
    } catch {
      // Corrupted
    }
  }, [storageKey, ready, projectId, key]);

  useEffect(() => {
    if (!ready) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(value));
    } catch {
      // Storage full or unavailable
    }
  }, [storageKey, value, ready]);

  const setPersistedValue = useCallback((newValue: T | ((prev: T) => T)) => {
    setValue(newValue);
  }, []);

  return [value, setPersistedValue];
}
