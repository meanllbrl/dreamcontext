import { realpathSync, statSync } from 'node:fs';

/**
 * Was the installed app replaced under this running server (field 2026-11-13, the owner: run cards
 * did not work while 0.41.20 was being installed over the running app)?
 *
 * The CLI ships as a bundle split into hashed chunks that load on first use (`import()` of the
 * terminal, node-pty, ...). An install replaces `dist/` under the running process: the old chunk
 * names are gone, so the first use of anything not loaded yet fails with no useful word. The
 * entry file the server started from is the witness: its identity (inode, mtime, size) at start,
 * compared now. Only a built bundle (`.../dist/index.js`) is watched; a dev server (tsx on src/)
 * never reads as replaced.
 */

/** The line a surface shows instead of a command that cannot run any more. */
export const APP_UPDATED_MESSAGE = 'The app was updated while it was open, so it cannot run commands until it restarts. Quit it (⌘Q), open it again, then press ▶ again.';

export const APP_UPDATED_ERROR = 'app_updated';

type Stat = (path: string) => { ino: number; mtimeMs: number; size: number };

/** A probe over one entry file. `null` entry or a non-bundle path: never replaced. */
export function driftProbe(entry: string | null | undefined, stat: Stat = statSync): () => boolean {
  if (!entry || !/[\\/]dist[\\/]index\.js$/.test(entry)) return () => false;
  const idOf = (): string | null => {
    try { const st = stat(entry); return `${st.ino}:${st.mtimeMs}:${st.size}`; } catch { return null; }
  };
  const born = idOf();
  if (born === null) return () => false;
  return () => idOf() !== born;
}

function entryOfThisProcess(): string | null {
  const a = process.argv[1];
  if (!a) return null;
  try { return realpathSync(a); } catch { return null; }
}

/** This server's probe, taken when the module first loads (at boot: the routes import it). */
export const appReplacedUnderUs: () => boolean = driftProbe(entryOfThisProcess());
