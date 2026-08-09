#!/usr/bin/env node
/**
 * Refresh the dashboard copy the SERVER actually serves.
 *
 * There are two dashboard directories and only one of them is ever rendered:
 *   dashboard/dist   — what `vite build` writes
 *   dist/dashboard   — what `getDashboardDir()` serves (sibling of dist/index.js)
 *
 * Only `tsup` (`npm run build:cli`) ever copied the first into the second, so
 * `npm run build:dashboard` on its own changed nothing a browser could see. Rebuild
 * the UI, reload the app, and you are still looking at whichever build happened to be
 * current the last time the CLI was built — a stale bundle that can be arbitrarily old,
 * including one snapshotted mid-edit. That is not a theoretical drift: it is how a
 * long-fixed `ReferenceError` kept reappearing in a browser run against "the current
 * build" (2026-08-08).
 *
 * REMOVE-then-copy, never merge. Asset filenames are content-hashed, so `cpSync` over a
 * populated directory leaves every previous build's chunks behind — the entry in
 * index.html stays correct, but the directory grows without bound and keeps serving
 * chunks nothing points at. tsup's `clean: true` masks this for the CLI build; a
 * dashboard-only rebuild has no such guard.
 *
 * No-op when `dist/` does not exist yet: there is no CLI build to keep in sync, and
 * tsup's own onSuccess copy will populate it on the next `build:cli`.
 */
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(REPO, 'dashboard', 'dist');
const TARGET = join(REPO, 'dist', 'dashboard');

if (!existsSync(SOURCE)) {
  console.error('sync-dashboard-dist: dashboard/dist is missing — run the dashboard build first.');
  process.exit(1);
}

if (!existsSync(join(REPO, 'dist'))) {
  console.log('sync-dashboard-dist: no dist/ yet — build:cli will copy the dashboard in.');
  process.exit(0);
}

rmSync(TARGET, { recursive: true, force: true });
cpSync(SOURCE, TARGET, { recursive: true });
console.log('sync-dashboard-dist: dist/dashboard now matches dashboard/dist.');
