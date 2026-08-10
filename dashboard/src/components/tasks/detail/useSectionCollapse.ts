import { useCallback, useState } from 'react';
import { useVault } from '../../../context/VaultContext';

/**
 * Which property sections are open, remembered per user.
 *
 * Scope is localStorage, not the vault's `overrides/` — the board's "save for all" vs "save for
 * yourself" split exists because a saved VIEW is a shared artifact someone might want the team
 * to inherit. Which accordions you like open is not: it is a reading preference, closer to
 * scroll position than to configuration, and pushing it into a file the team syncs would make
 * one person's habits everyone's default. So it stays on the machine, keyed per vault (the same
 * task slug means different things in different projects).
 *
 * Absent → the caller's default. That matters: it means shipping a NEW section, or changing a
 * default, reaches existing users instead of being frozen out by a stale stored value.
 */
const KEY_PREFIX = 'dreamcontext:task-sections:';

type CollapseMap = Record<string, boolean>;

/** The vault travels as a PARAMETER because these two are module functions called at read/write
 *  time, not from React — `useVault()` cannot be called inside them, and with several projects
 *  live in one window a module-level read would give one project's accordions to another. */
function storageKey(vault: string | null): string {
  return `${KEY_PREFIX}${vault ?? ''}`;
}

function read(vault: string | null): CollapseMap {
  try {
    const raw = localStorage.getItem(storageKey(vault));
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    // Defensive: a hand-edited or half-written value must not crash the whole task view.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: CollapseMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'boolean') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Default-open set — and the single registry of section ids.
 *
 * Earned by what a task view is FOR, not by taste: you open a task to see where it stands
 * (Workflow), when it is due (Timeline), and whose it is (Ownership). Scoring, Labels and System
 * are reference — real, but consulted rather than read. Custom fields default open only because
 * a project that defined them did so deliberately.
 *
 * `satisfies` (not `:`) is what keeps the keys literal, so {@link SectionId} is the exact set of
 * ids and a section that isn't listed here cannot be rendered. That matters: this map is read
 * with `?? DEFAULTS[id]`, so an unregistered id would resolve `undefined` → falsy → silently
 * CLOSED. A whole section vanishing because someone forgot a line in a lookup table is not a
 * failure anyone would think to look for — so it is a compile error instead.
 */
export const DEFAULTS = {
  identity: true,
  workflow: true,
  timeline: true,
  ownership: true,
  custom: true,
  scoring: false,
  labels: false,
  system: false,
} satisfies Record<string, boolean>;

export type SectionId = keyof typeof DEFAULTS;

export interface SectionCollapse {
  /** Is this section open? The user's stored choice, else the section's default. */
  isOpen: (id: SectionId) => boolean;
  toggle: (id: SectionId) => void;
}

export function useSectionCollapse(): SectionCollapse {
  const { vault } = useVault();
  // Seeded from THIS subtree's vault once, exactly as the module-global read did at mount: a
  // mounted task panel belongs to one project for its whole life.
  const [map, setMap] = useState<CollapseMap>(() => read(vault));

  // The default is looked up here rather than passed in by the caller: a caller that could pass
  // the fallback could pass the WRONG one, and then a section's default would depend on which
  // call site rendered it.
  const isOpen = useCallback((id: SectionId) => map[id] ?? DEFAULTS[id], [map]);

  const toggle = useCallback((id: SectionId) => {
    setMap((prev) => {
      // The stored value is the user's explicit choice, so flip against what they SEE. Defaults
      // can change per release; only explicit overrides persist.
      const next = { ...prev, [id]: !(prev[id] ?? DEFAULTS[id]) };
      try { localStorage.setItem(storageKey(vault), JSON.stringify(next)); } catch { /* best-effort */ }
      return next;
    });
  }, [vault]);

  return { isOpen, toggle };
}
