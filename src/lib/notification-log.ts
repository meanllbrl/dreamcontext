import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * The machine's recent banners, newest last on disk: `~/.dreamcontext/notifications.jsonl`.
 *
 * WHY IT EXISTS. A macOS banner is gone the moment it slides away, and Notification Centre is
 * not something this process can read back. The dashboard's Notifications window is the place a
 * banner with no in-app target lands, and it lists what was posted from here. Machine-local and
 * never synced: these are this Mac's announcements, not project state.
 *
 * Capped at {@link NOTIFICATION_LOG_CAP} lines. The append is a single `O_APPEND` write (atomic
 * for a line this size); the trim rewrites through a temp file and a rename, so a reader never
 * sees a half-written file. Two posters trimming in the same instant can drop one entry, which
 * is the honest price of not taking a lock on a best-effort history.
 */

export const NOTIFICATION_LOG_CAP = 200;

export interface NotificationEntry {
  id: string;
  /** ISO timestamp of the post. */
  at: string;
  title: string;
  body: string;
  /** The `dreamcontext://` link the banner's click opens, or null when it has none. */
  link: string | null;
  /** The absolute file the click falls back to when no app claims the link, or null. */
  file: string | null;
}

export function notificationsLogPath(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'notifications.jsonl');
}

function newNotificationId(now: Date): string {
  return `n_${now.getTime().toString(36)}_${randomBytes(4).toString('hex')}`;
}

/**
 * Record one posted banner. Best-effort by design: a history write must never cost the banner
 * itself, so a failure is reported through the return value (null) and not thrown.
 */
export function recordNotification(
  entry: { title: string; body: string; link?: string | null; file?: string | null },
  home: string = homedir(),
  now: Date = new Date(),
): NotificationEntry | null {
  const record: NotificationEntry = {
    id: newNotificationId(now),
    at: now.toISOString(),
    title: entry.title,
    body: entry.body,
    link: entry.link ?? null,
    file: entry.file ?? null,
  };
  const path = notificationsLogPath(home);
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf-8');
    trimLog(path);
    return record;
  } catch {
    return null;
  }
}

function trimLog(path: string): void {
  const lines = readFileSync(path, 'utf-8').split('\n').filter((l) => l.trim() !== '');
  if (lines.length <= NOTIFICATION_LOG_CAP) return;
  const tmp = `${path}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  writeFileSync(tmp, `${lines.slice(-NOTIFICATION_LOG_CAP).join('\n')}\n`, 'utf-8');
  renameSync(tmp, path);
}

function isEntry(value: unknown): value is NotificationEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && typeof v.at === 'string'
    && typeof v.title === 'string' && typeof v.body === 'string'
    && (v.link === null || typeof v.link === 'string')
    && (v.file === null || typeof v.file === 'string');
}

/** The newest `limit` banners, NEWEST FIRST. A missing file is an empty history; a torn or
 *  foreign line is skipped rather than failing the whole read. */
export function readNotifications(limit = 50, home: string = homedir()): NotificationEntry[] {
  let raw = '';
  try {
    raw = readFileSync(notificationsLogPath(home), 'utf-8');
  } catch {
    return [];
  }
  const out: NotificationEntry[] = [];
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isEntry(parsed)) out.push(parsed);
    } catch { /* a torn line from a concurrent trim; the rest of the history still reads */ }
  }
  return out;
}
