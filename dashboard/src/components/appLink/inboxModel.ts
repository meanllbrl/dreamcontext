/**
 * The Notifications window's data rules, framework-free so they are tested on their own:
 * what a row of `GET /api/notifications` may look like, their order, and how old each one reads.
 */

/** One banner dreamcontext posted (`~/.dreamcontext/notifications.jsonl`). */
export interface InboxNotification {
  id: string;
  /** ISO timestamp of the post. */
  at: string;
  title: string;
  body: string;
  /** The `dreamcontext://` link the banner carried, or null. */
  link: string | null;
  /** The file the banner fell back to opening, or null. */
  file: string | null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/**
 * The route's answer as rows, newest first. Accepts the list bare or under `notifications` /
 * `items`; a row without an id, a title or a readable time is dropped rather than drawn wrong.
 */
export function normalizeNotifications(payload: unknown): InboxNotification[] {
  const obj = payload as { notifications?: unknown; items?: unknown } | null;
  const list = Array.isArray(payload) ? payload
    : Array.isArray(obj?.notifications) ? obj!.notifications as unknown[]
      : Array.isArray(obj?.items) ? obj!.items as unknown[] : [];
  const rows: InboxNotification[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const id = str(r.id);
    const at = str(r.at);
    const title = str(r.title);
    if (!id || !at || !title || Number.isNaN(Date.parse(at))) continue;
    rows.push({ id, at, title, body: str(r.body) ?? '', link: str(r.link) || null, file: str(r.file) || null });
  }
  return rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** "just now" / "5m ago" / "3h ago" / "2d ago", then the date. */
export function relativeTime(at: string, now: number = Date.now()): string {
  const then = Date.parse(at);
  if (Number.isNaN(then)) return '';
  const mins = Math.floor(Math.max(0, now - then) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days <= 6) return `${days}d ago`;
  return new Date(then).toLocaleDateString([], { day: 'numeric', month: 'short' });
}
