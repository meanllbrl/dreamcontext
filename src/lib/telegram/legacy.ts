/**
 * One-time removal of the RETIRED per-routine Telegram token files.
 *
 * The old channel kept one bot token per automation at
 * `~/.dreamcontext/telegram/<slug>.json` (and, before that, one global
 * `~/.dreamcontext/telegram.json`). That code is gone; a token left on disk is a
 * live credential nobody reads any more, so it goes.
 *
 * The new bindings live in DIRECTORIES under the same folder
 * (`~/.dreamcontext/telegram/<scope>/<target>/bot.json`), so only regular
 * `*.json` FILES directly in that folder that hold the old `botToken` shape are legacy;
 * `managed-history.json` (the new core's re-adopt record) is never touched. Nothing is followed: a
 * symlink is unlinked as a link (its target is never touched), a directory is
 * never entered. Idempotent: once the files are gone it does nothing.
 */
import { lstatSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** A legacy per-slug file name: the old store's `isSafeAutomationSlug` shape (no length cap) + `.json`. */
const LEGACY_FILE_RE = /^[a-z0-9][a-z0-9-]*\.json$/;

/** Files the NEW core keeps directly in the folder: never legacy, whatever they hold. */
const CURRENT_FILES = new Set(['managed-history.json']);

/** The retired binding's shape: a JSON object carrying a `botToken` string. A symlink is never read. */
function holdsOldToken(path: string): boolean {
  try {
    if (lstatSync(path).isSymbolicLink()) return true;
    const v = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    return !!v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { botToken?: unknown }).botToken === 'string';
  } catch {
    return false;
  }
}

/** Removes the retired token files; returns the paths it removed. Never throws. */
export function removeLegacyTelegramFiles(home: string = homedir()): string[] {
  const removed: string[] = [];
  const base = join(home, '.dreamcontext');
  const unlinkIfLegacy = (path: string): void => {
    try {
      const st = lstatSync(path);
      if (!st.isFile() && !st.isSymbolicLink()) return;
      unlinkSync(path);
      removed.push(path);
    } catch {
      /* absent or unreadable: nothing to remove */
    }
  };
  unlinkIfLegacy(join(base, 'telegram.json'));
  const dir = join(base, 'telegram');
  let names: string[] = [];
  try {
    const st = lstatSync(dir);
    if (!st.isDirectory()) return removed;
    names = readdirSync(dir);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!LEGACY_FILE_RE.test(name) || CURRENT_FILES.has(name)) continue;
    const path = join(dir, name);
    if (holdsOldToken(path)) unlinkIfLegacy(path);
  }
  return removed;
}
