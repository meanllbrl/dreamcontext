/**
 * The project's drop folder (`_dream_context/tmp/agent-drops/`): files handed to an agent by
 * path (a pasted or dropped file on the Mac, a photo from the phone, a file sent to a Telegram
 * bot). Shared by `src/server/routes/agent-drop.ts` and `src/lib/telegram/inbound.ts`, so every
 * way in keeps the same folder, the same self-ignoring tmp, the same prune.
 */
import { readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DROP_TTL_MS = 7 * 24 * 60 * 60 * 1000; // prune drops older than ~7 days

/** `<contextRoot>/tmp/agent-drops` (contextRoot is already `<vault>/_dream_context`). */
export function agentDropsDir(contextRoot: string): string {
  return join(contextRoot, 'tmp', 'agent-drops');
}

/**
 * Make the vault's `_dream_context/tmp/` directory git-ignored in EVERY project, so a
 * dropped image is never accidentally committed regardless of the project's own root
 * `.gitignore`. Writes a self-ignoring `tmp/.gitignore` containing `*` (which also
 * ignores the file itself). Idempotent (the content is constant) and best-effort — a
 * write failure must never abort a drop, so errors are swallowed.
 */
export function ensureTmpGitignored(contextRoot: string): void {
  try {
    writeFileSync(join(contextRoot, 'tmp', '.gitignore'), '*\n');
  } catch { /* best-effort: a read-only/locked tmp dir just means drops aren't auto-ignored */ }
}

/** Delete drops older than the TTL (best-effort; never throws into the request path). */
export function pruneDrops(dir: string, now: number = Date.now()): void {
  try {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      try {
        const st = statSync(p);
        if (st.isFile() && now - st.mtimeMs > DROP_TTL_MS) unlinkSync(p);
      } catch { /* a single unstattable/locked entry shouldn't abort the prune */ }
    }
  } catch { /* dir missing/unreadable — nothing to prune */ }
}
