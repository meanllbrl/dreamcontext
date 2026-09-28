import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureGitignoreEntries } from './gitignore.js';
import { UUID_RE } from './agent-session-map.js';

/**
 * Per-vault, machine-local memory of the NAME each Claude conversation carried in its tab,
 * keyed by the conversation UUID — so "Past chats" can list a closed conversation under the
 * name you saw on its tab rather than under its first prompt.
 *
 * The roster (`state/.agent-sessions.json`) already holds that name, but only for tabs that
 * are still OPEN: closing a tab drops its entry, and with it the only record of the title the
 * agent gave it. The tab→session map (`state/.agent-session-map/`) is no home for it either —
 * it is keyed by TAB, pruned at 40, and deliberately drops an entry when its conversation
 * moves to another tab. This file outlives both: one entry per conversation, written whenever
 * the roster is saved, read by the history listing.
 *
 * Stored as ONE small JSON blob (titles only — ~100 bytes a conversation), capped at
 * {@link MAX_TITLES}, oldest-updated evicted first. Best-effort throughout: a failed read is
 * "no stored titles" and the picker falls back to first prompts, which is what it did before.
 */

const TITLES_REL_PATH = join('state', '.session-titles.json');
const MAX_TITLES = 2000;
const MAX_TITLE = 200;

interface TitleEntry {
  title: string;
  /** ISO timestamp of the last change — eviction order only. */
  updated: string;
}

type TitleStore = Record<string, TitleEntry>;

function storePath(contextRoot: string): string {
  return join(contextRoot, TITLES_REL_PATH);
}

function readStore(contextRoot: string): TitleStore {
  try {
    const raw = JSON.parse(readFileSync(storePath(contextRoot), 'utf-8')) as unknown;
    const titles = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as { titles?: unknown }).titles
      : undefined;
    if (!titles || typeof titles !== 'object' || Array.isArray(titles)) return {};
    const out: TitleStore = {};
    for (const [id, v] of Object.entries(titles as Record<string, unknown>)) {
      if (!UUID_RE.test(id) || !v || typeof v !== 'object') continue;
      const { title, updated } = v as { title?: unknown; updated?: unknown };
      if (typeof title !== 'string' || !title.trim()) continue;
      out[id] = { title: title.trim().slice(0, MAX_TITLE), updated: typeof updated === 'string' ? updated : '' };
    }
    return out;
  } catch {
    return {};
  }
}

/** Every stored conversation title, keyed by conversation UUID. Never throws. */
export function readSessionTitles(contextRoot: string): Map<string, string> {
  return new Map(Object.entries(readStore(contextRoot)).map(([id, e]) => [id, e.title]));
}

/**
 * Remember `title` for each conversation id in `updates`. Invalid ids and blank titles are
 * skipped; an unchanged title costs no write (the roster is saved on every tab change, so
 * this runs often and must be a no-op in the steady state). Best-effort, never throws.
 */
export function recordSessionTitles(contextRoot: string, updates: ReadonlyArray<{ sessionId: string; title: string }>): void {
  try {
    const store = readStore(contextRoot);
    const now = new Date().toISOString();
    let changed = false;
    for (const { sessionId, title } of updates) {
      const t = title.trim().slice(0, MAX_TITLE);
      if (!UUID_RE.test(sessionId) || !t || store[sessionId]?.title === t) continue;
      store[sessionId] = { title: t, updated: now };
      changed = true;
    }
    if (!changed) return;

    const ids = Object.keys(store);
    if (ids.length > MAX_TITLES) {
      ids
        .sort((a, b) => (store[a].updated < store[b].updated ? -1 : store[a].updated > store[b].updated ? 1 : a < b ? -1 : 1))
        .slice(0, ids.length - MAX_TITLES)
        .forEach((id) => { delete store[id]; });
    }

    // Same symlink guard as the session map: a cloned vault could commit `state` as a
    // symlink, redirecting this write outside the vault.
    const stateDir = join(contextRoot, 'state');
    if (existsSync(stateDir) && !lstatSync(stateDir).isDirectory()) return;
    const path = storePath(contextRoot);
    if (existsSync(path) && !lstatSync(path).isFile()) return;
    if (!existsSync(path)) {
      try {
        ensureGitignoreEntries(dirname(contextRoot), ['_dream_context/state/.session-titles.json'], {
          comment: 'dreamcontext: machine-local Claude conversation titles (Past chats)',
        });
      } catch { /* best-effort — titles are not a secret */ }
    }
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
    const tmp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify({ titles: store }, null, 2) + '\n', 'utf-8');
    renameSync(tmp, path);
  } catch { /* best-effort — the picker falls back to first prompts */ }
}
