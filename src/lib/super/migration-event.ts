import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { defaultCatchUpCli } from '../project-catch-up.js';
import { countEvent, newQueueId, pumpSuper, superSanitizeOpts, writeSuper } from './inbox.js';
import { readSuperState } from './store.js';
import type { SuperState } from './types.js';
import { MAX_MIGRATION_IDS, MIGRATION_ID_RE } from './migration-ids.js';

export { cleanMigrationIds, MAX_MIGRATION_IDS, MIGRATION_ID_RE, MIGRATION_CHILD_PROMPT, migrationChildBrief, migrationChildPrompt, migrationEventLine } from './migration-ids.js';

/**
 * Agent migrations after an update (task her-ozellik-eski-kullaniciyi-..., C4).
 *
 * When the project's ledger has agent work waiting (`migrations pending --json`, read from the
 * INSTALLED CLI, never this server's own registry: the server can be older than the CLI on disk),
 * the project's MAIN Super gets ONE `migration` event and starts ONE child for it
 * (`super delegate --migration`). Never for a member's Super. While a migration child is live,
 * starting or held in the pool, or a migration item is still open, nothing more is queued.
 */

import type { DueMigration } from './migration-ids.js';
export type { DueMigration } from './migration-ids.js';

const VERSION_RE = /^\d+\.\d+\.\d+$/;
export const MAX_MIGRATION_TITLE = 80;
const PENDING_TIMEOUT_MS = 30_000;

/**
 * The CLI's `migrations pending --json`, schema-checked. Anything malformed (not JSON, not an
 * array, a field of the wrong shape) is `[]`: nothing due. Pure.
 */
export function parseDueMigrations(stdout: string): DueMigration[] {
  let raw: unknown;
  try { raw = JSON.parse(stdout.trim()); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  const out: DueMigration[] = [];
  for (const d of raw) {
    if (!d || typeof d !== 'object') return [];
    const { version, id, title } = d as Record<string, unknown>;
    if (typeof version !== 'string' || !VERSION_RE.test(version)) return [];
    if (typeof id !== 'string' || !MIGRATION_ID_RE.test(id)) return [];
    // eslint-disable-next-line no-control-regex
    if (typeof title !== 'string' || !title.trim() || title.length > MAX_MIGRATION_TITLE || /[\u0000-\u001f\u007f]/.test(title)) return [];
    if (out.some((x) => x.id === id)) continue;
    out.push({ version, id, title });
  }
  // More than one child's worth is still work: the first MAX_MIGRATION_IDS go now, the rest next time.
  return out.slice(0, MAX_MIGRATION_IDS);
}

export type DueReader = (contextRoot: string) => Promise<DueMigration[]>;

/**
 * D9: run the installed CLI's `migrations pending --json` in the project. The entry is the one the
 * catch-up uses (`defaultCatchUpCli`: the app's own or the global install), else this process's
 * own entry (`DREAMCONTEXT_CLI` or argv[1]), never a binary looked up on PATH or in the project.
 */
export const readDueFromCli: DueReader = (contextRoot) => {
  const entry = defaultCatchUpCli()?.entry ?? (process.env.DREAMCONTEXT_CLI || process.argv[1]);
  if (!entry) return Promise.resolve([]);
  return new Promise((done) => {
    execFile(
      process.execPath,
      [entry, 'migrations', 'pending', '--json'],
      {
        cwd: dirname(contextRoot),
        timeout: PENDING_TIMEOUT_MS,
        maxBuffer: 256 * 1024,
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      },
      (err, stdout) => {
        if (err) { console.warn(`[super] ${contextRoot}: migrations pending failed: ${err.message.split('\n')[0]}`); done([]); return; }
        const due = parseDueMigrations(String(stdout));
        if (!due.length && String(stdout).trim() !== '[]') console.warn(`[super] ${contextRoot}: migrations pending printed no readable list`);
        done(due);
      },
    );
  });
};

let reader: DueReader = readDueFromCli;
/** Test seam: how due work is read (null = the installed CLI). */
export function _setDueReaderForTests(r: DueReader | null): void { reader = r ?? readDueFromCli; }
export function readDueMigrations(contextRoot: string): Promise<DueMigration[]> {
  return reader(contextRoot).catch(() => []);
}

/** Starts of a migration child the window has not answered yet, per vault (in memory). */
const starting = new Map<string, number>();
export function noteMigrationStarting(contextRoot: string, until: number): void { starting.set(resolve(contextRoot), until); }
export function clearMigrationStarting(contextRoot: string): void { starting.delete(resolve(contextRoot)); }
export function isMigrationStarting(contextRoot: string, now = Date.now()): boolean {
  return migrationStarting(contextRoot, now);
}
function migrationStarting(contextRoot: string, now: number): boolean {
  const until = starting.get(resolve(contextRoot));
  if (until === undefined) return false;
  if (until > now) return true;
  starting.delete(resolve(contextRoot));
  return false;
}

/**
 * The migration child of this record that still runs, or holds the job: live (not ended, its row
 * not finished), or a pool row that carries the marker. Null = none. Pure.
 */
export function openMigrationWork(s: Pick<SuperState, 'children' | 'pool'>): { child?: string; pooled?: string } | null {
  for (const [sid, c] of Object.entries(s.children)) {
    if (!c.migration?.length || c.endedAt !== undefined) continue;
    if (c.row === 'done' || c.row === 'gone') continue;
    return { child: sid };
  }
  const p = s.pool.find((x) => x.migration?.length);
  return p ? { pooled: p.id } : null;
}

/**
 * Queue ONE `migration` event for the project's main Super when work is due and nothing about it
 * is open. The "nothing open" test and the push are ONE write, so two triggers firing together add
 * one item. Returns whether an item was queued. Never throws.
 */
export async function checkMigrationDue(contextRoot: string, now = Date.now()): Promise<boolean> {
  try {
    const before = await readSuperState(contextRoot, superSanitizeOpts());
    // Cheap gate first: a Super that is off spawns no CLI.
    if (!before.enabled || !before.session) return false;
    const due = await readDueMigrations(contextRoot);
    if (!due.length) return false;
    let added = false;
    await writeSuper(contextRoot, (s) => {
      if (!s.enabled || !s.session) return;
      if (openMigrationWork(s) || migrationStarting(contextRoot, now)) return;
      if (s.queue.some((q) => q.kind === 'migration' && q.state !== 'done')) return;
      s.queue.push({ id: newQueueId(), sessionId: s.session, kind: 'migration', state: 'pending', createdAt: now, migration: due.map((d) => d.id) });
      countEvent(s);
      added = true;
    });
    if (added) void pumpSuper(contextRoot);
    return added;
  } catch (err) {
    console.warn(`[super] ${contextRoot}: the migration check failed: ${(err as Error).message}`);
    return false;
  }
}
