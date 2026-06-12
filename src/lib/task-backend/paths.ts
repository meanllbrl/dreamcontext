import { ensureGitignoreEntries } from '../gitignore.js';
import { SECRETS_GITIGNORE_ENTRY } from './secrets.js';

/**
 * Derived-file layout for remote task backends — issue #11 ledger split.
 *
 * COMMITTED:  state/.tasks-map.json   (stable slug ↔ remoteId map)
 * GITIGNORED: state/*.md              (derived mirror — remote is the truth)
 *             state/.tasks-sync.json  (watermarks, base snapshots, local hashes)
 *             state/.tasks-queue.json (offline write-ahead queue)
 *             state/.conflicts/       (preserved losing copies)
 *             state/.secrets.json     (API keys)
 */

export const TASKS_MAP_REL = 'state/.tasks-map.json';
export const TASKS_SYNC_REL = 'state/.tasks-sync.json';
export const TASKS_QUEUE_REL = 'state/.tasks-queue.json';
export const TASKS_LOCK_REL = 'state/.tasks-sync.lock';
export const CONFLICTS_DIR_REL = 'state/.conflicts';

/** .gitignore entries required when a remote backend owns the tasks. */
export const REMOTE_BACKEND_GITIGNORE_ENTRIES = [
  '_dream_context/state/*.md',
  '_dream_context/state/.tasks-sync.lock',
  '_dream_context/state/.tasks-sync.json',
  '_dream_context/state/.tasks-queue.json',
  '_dream_context/state/.conflicts/',
  SECRETS_GITIGNORE_ENTRY,
];

/** Idempotently gitignore every derived file of a remote task backend. */
export function ensureRemoteBackendGitignore(projectRoot: string): string[] {
  return ensureGitignoreEntries(projectRoot, REMOTE_BACKEND_GITIGNORE_ENTRIES, {
    comment: 'dreamcontext remote task backend (derived mirror + sync state)',
  });
}
