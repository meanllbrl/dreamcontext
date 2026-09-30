import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { parseJsonBody, sendError, sendJson } from '../middleware.js';
import { isDesktop } from '../desktop.js';
import { notifyViaBundle } from '../../lib/automations/notifier.js';
import { readNotifications, NOTIFICATION_LOG_CAP } from '../../lib/notification-log.js';
import { buildAppLink, isValidAppLink } from '../../lib/app-link.js';

/**
 * The app's own banners, and the history its Notifications window lists.
 *
 *   GET  /api/notifications?limit=50  → { notifications: NotificationEntry[] }, newest first
 *   POST /api/notify {title, body, link?, sound?} → { posted: boolean }
 *
 * WHY THE APP POSTS THROUGH HERE rather than through Tauri's notification plugin: a banner
 * posted by the branded applet carries a click that `open`s a `dreamcontext://` link, so it
 * lands in the exact chat. The plugin's banner can only raise the app. `posted:false` (no
 * applet on this machine, or not macOS) is the caller's cue to use the plugin instead.
 *
 * Desktop-gated exactly like `POST /api/agent/drop`: both read and write machine-local state
 * (`~/.dreamcontext/`), and outside the desktop app there is no window to route a click to.
 * Vault-agnostic: the history belongs to the machine and a link names its own vault. This route
 * NEVER builds the applet; `dreamcontext notify` and `automations install` do that where a
 * human can see the permission prompt.
 */

const TITLE_MAX_CHARS = 200;
const BODY_MAX_CHARS = 2000;
/** A banner body macOS will not truncate mid-word (the runner's own cap). */
const BANNER_BODY_CHARS = 240;
/** `/System/Library/Sounds` names: letters, digits, spaces. Anything else is not a sound. */
const SOUND_RE = /^[A-Za-z0-9 _-]{1,64}$/;
const DEFAULT_LIMIT = 50;

export interface NotificationRouteDeps {
  home?: string;
  /** Injected in tests so no real banner is posted. Mirrors `notifyViaBundle`. */
  post?: (title: string, body: string, home: string, opts: { sound?: string; link?: string | null }) => boolean;
}

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

function refuseOutsideDesktop(res: ServerResponse): boolean {
  if (isDesktop()) return false;
  sendError(res, 403, 'desktop_only', 'Notifications are only available in the desktop app.');
  return true;
}

function parseLimit(req: IncomingMessage): number {
  try {
    const raw = new URL(req.url || '/', 'http://localhost').searchParams.get('limit');
    const n = raw === null ? DEFAULT_LIMIT : Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
    return Math.min(n, NOTIFICATION_LOG_CAP);
  } catch {
    return DEFAULT_LIMIT;
  }
}

function capBody(body: string): string {
  const flat = body.trim();
  return flat.length <= BANNER_BODY_CHARS ? flat : `${flat.slice(0, BANNER_BODY_CHARS - 1).trimEnd()}…`;
}

type NotifyRequest = { title: string; body: string; link: string; sound?: string };

/** The validated request, or the message for a 400. */
function readNotifyRequest(payload: Record<string, unknown> | null): NotifyRequest | string {
  if (!payload) return 'A JSON body is required.';
  const { title, body, link, sound } = payload;
  if (typeof title !== 'string' || !title.trim() || title.length > TITLE_MAX_CHARS) {
    return `title must be a non-empty string of at most ${TITLE_MAX_CHARS} characters.`;
  }
  if (typeof body !== 'string' || body.length > BODY_MAX_CHARS) {
    return `body must be a string of at most ${BODY_MAX_CHARS} characters.`;
  }
  if (link !== undefined && link !== null && (typeof link !== 'string' || !isValidAppLink(link))) {
    return 'link must be a valid dreamcontext:// link.';
  }
  if (sound !== undefined && sound !== null && (typeof sound !== 'string' || !SOUND_RE.test(sound))) {
    return 'sound must be a system sound name.';
  }
  return {
    title: title.trim(),
    body: capBody(body),
    // A banner with no in-app place still lands somewhere: the Notifications window.
    link: typeof link === 'string' ? link : buildAppLink({ kind: 'inbox' }),
    sound: typeof sound === 'string' ? sound : undefined,
  };
}

export function createNotificationRoutes(deps: NotificationRouteDeps = {}): {
  handleNotificationsGet: Handler;
  handleNotifyPost: Handler;
} {
  const home = (): string => deps.home ?? homedir();
  const post = deps.post ?? ((title, body, h, opts) => notifyViaBundle(title, body, h, opts));

  const handleNotificationsGet: Handler = async (req, res) => {
    if (refuseOutsideDesktop(res)) return;
    sendJson(res, 200, { notifications: readNotifications(parseLimit(req), home()) });
  };

  const handleNotifyPost: Handler = async (req, res) => {
    if (refuseOutsideDesktop(res)) return;
    const parsed = readNotifyRequest(await parseJsonBody(req));
    if (typeof parsed === 'string') {
      sendError(res, 400, 'invalid_notification', parsed);
      return;
    }
    const posted = post(parsed.title, parsed.body, home(), { sound: parsed.sound, link: parsed.link });
    sendJson(res, 200, { posted });
  };

  return { handleNotificationsGet, handleNotifyPost };
}

export const { handleNotificationsGet, handleNotifyPost } = createNotificationRoutes();
