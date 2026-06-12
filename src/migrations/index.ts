import { compareVersions } from '../lib/version-check.js';
import { migration070 } from './0.7.0.js';
import { migration072 } from './0.7.2.js';
import type { Migration } from './types.js';

/**
 * The ordered registry of all versioned migrations.
 * Adding a new release migration: add src/migrations/<version>.ts,
 * export its Migration object, and push it here.
 * See CONTRIBUTING.md §"Shipping a migration" for the full checklist.
 */
export const REGISTRY: Migration[] = [migration070, migration072];

/**
 * Return all migrations whose version falls in the half-open range (from, to].
 * Equal `from === to` → empty (nothing to do on a same-version run).
 * Sorted ascending by version so they apply in the correct order.
 *
 * Reuses compareVersions from src/lib/version-check.ts.
 */
export function pendingMigrations(from: string, to: string): Migration[] {
  return REGISTRY.filter(
    (m) =>
      compareVersions(m.version, from) > 0 &&
      compareVersions(m.version, to) <= 0,
  ).sort((a, b) => compareVersions(a.version, b.version));
}
