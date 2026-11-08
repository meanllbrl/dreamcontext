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
 * `*.json` FILES directly in that folder are legacy. Nothing is followed: a
 * symlink is unlinked as a link (its target is never touched), a directory is
 * never entered. Idempotent: once the files are gone it does nothing.
 */
import { lstatSync, readdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** A legacy per-slug file name: the old store's `isSafeAutomationSlug` shape + `.json`. */
const LEGACY_FILE_RE = /^[a-z0-9][a-z0-9-]{0,63}\.json$/;

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
    if (LEGACY_FILE_RE.test(name)) unlinkIfLegacy(join(dir, name));
  }
  return removed;
}
