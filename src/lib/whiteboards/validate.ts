import {
  WIDGET_KINDS,
  WIDGET_SIZES,
  REF_KINDS,
  isWidgetKind,
  isWidgetSize,
  isCardColor,
  CARD_COLORS,
  isValidPageRef,
  isLabCardRef,
  isAgentSlugShape,
  type WidgetKind,
  type WidgetPayload,
  type WhiteboardElement,
} from './widgets.js';
import { WhiteboardValidationError, WhiteboardTooLargeError } from './errors.js';
import { validateNav } from './nav.js';

/**
 * The one validator every whiteboard write goes through — the CLI, the store's changed-element
 * check, and the Wave 2 PUT route. Security invariants from the plan live here, not in the
 * callers, so a new write path cannot forget one.
 */

export {
  WhiteboardCorruptError,
  WhiteboardValidationError,
  WhiteboardTooLargeError,
  WhiteboardNotFoundError,
  WhiteboardLockError,
  WhiteboardError,
} from './errors.js';

/** PUT body cap (security invariants). */
export const WHITEBOARD_MAX_BODY_BYTES = 5 * 1024 * 1024;

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const REF_RE = /^[a-z0-9][a-z0-9\-/]{0,200}$/;
const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Payload text fields are capped so one widget cannot carry the whole body budget. */
const MAX_TEXT_CHARS = 1024 * 1024;
const MAX_ITEMS = 500;

export function isValidWhiteboardSlug(slug: unknown): slug is string {
  return typeof slug === 'string' && SLUG_RE.test(slug);
}

export function isValidRef(ref: unknown): ref is string {
  return typeof ref === 'string' && REF_RE.test(ref) && !ref.split('/').includes('..');
}

/**
 * A widget ref for this kind: a `knowledge` widget is a page, so its ref may be a knowledge
 * slug OR a project-relative .md/.pdf/.html path; a `lab-card` names `<board>/<card-id>`;
 * an `agent` names an automation slug; insight and task refs stay slugs.
 */
export function isValidWidgetRef(kind: WidgetKind, ref: unknown): ref is string {
  if (kind === 'lab-card') return isLabCardRef(ref);
  if (kind === 'agent') return isAgentSlugShape(ref);
  return kind === 'knowledge' ? isValidPageRef(ref) : isValidRef(ref);
}

export function isValidTag(tag: unknown): tag is string {
  return typeof tag === 'string' && TAG_RE.test(tag);
}

/**
 * D7: what a web widget may show (owner, 2026-10-06: local files and dev servers too). MIRRORED
 * from `dashboard/src/components/whiteboard/webUrl.ts` (`validateWebUrl`), which re-checks it
 * at render time; a drift test runs the same cases through both. A target is an `https:` page,
 * an `http:` page on this machine (`localhost`, `127.0.0.1`, `[::1]`; `localhost:5173` without
 * a scheme means `http://localhost:5173`), or a file the board's reader draws (.html, .pdf, a
 * picture), project-relative or absolute (`/…`, `file:///…`). Never userinfo, never a `..`
 * step, and (when the caller knows its own origin: the server does, the CLI does not) never
 * the dashboard itself, which on loopback means any spelling of its host on its port.
 */
export type WebTarget =
  | { ok: true; kind: 'url'; href: string }
  | { ok: true; kind: 'file'; path: string; absolute: boolean }
  | { ok: false; reason: 'empty' | 'invalid' | 'not-https' | 'userinfo' | 'own-origin' | 'file-type' | 'file-path' };

export const WEB_FILE_EXTENSIONS: readonly string[] = ['.html', '.htm', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'];

const MAX_WEB_PATH = 1024;
const LOOPBACK_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '[::1]'];
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const BARE_LOOPBACK_RE = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i;

const isLoopback = (hostname: string) => LOOPBACK_HOSTS.includes(hostname.toLowerCase());

function isOwnOrigin(u: URL, selfOrigin: string | undefined): boolean {
  if (!selfOrigin) return false;
  if (u.origin === selfOrigin) return true;
  let own: URL;
  try { own = new URL(selfOrigin); } catch { return false; }
  const port = (x: URL) => x.port || (x.protocol === 'https:' ? '443' : '80');
  return isLoopback(own.hostname) && isLoopback(u.hostname) && port(own) === port(u);
}

function fileTarget(path: string, absolute: boolean): WebTarget {
  // eslint-disable-next-line no-control-regex
  if (path.length > MAX_WEB_PATH || /[\u0000-\u001f\\]/.test(path)) return { ok: false, reason: 'file-path' };
  const segments = (absolute ? path.slice(1) : path).split('/');
  if (segments.some((seg) => seg === '..' || seg === '')) return { ok: false, reason: 'file-path' };
  const name = segments[segments.length - 1];
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { ok: false, reason: 'invalid' };
  if (!WEB_FILE_EXTENSIONS.includes(name.slice(dot).toLowerCase())) return { ok: false, reason: 'file-type' };
  return { ok: true, kind: 'file', path, absolute };
}

export function classifyWebTarget(raw: unknown, selfOrigin?: string): WebTarget {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: 'empty' };
  let text = raw.trim();
  if (BARE_LOOPBACK_RE.test(text)) text = `http://${text}`;
  if (!SCHEME_RE.test(text)) {
    const rel = text.replace(/^(\.\/)+/, '');
    return fileTarget(rel, rel.startsWith('/'));
  }
  let u: URL;
  try { u = new URL(text); } catch { return { ok: false, reason: 'invalid' }; }
  if (u.protocol === 'file:') {
    if (u.host && !isLoopback(u.hostname)) return { ok: false, reason: 'file-path' };
    let path: string;
    try { path = decodeURIComponent(u.pathname); } catch { return { ok: false, reason: 'invalid' }; }
    return fileTarget(path, true);
  }
  const local = u.protocol === 'http:' && isLoopback(u.hostname);
  if (u.protocol !== 'https:' && !local) return { ok: false, reason: 'not-https' };
  if (u.username || u.password) return { ok: false, reason: 'userinfo' };
  if (isOwnOrigin(u, selfOrigin)) return { ok: false, reason: 'own-origin' };
  return { ok: true, kind: 'url', href: u.href };
}

const WEB_TARGET_REASON: Record<Exclude<WebTarget, { ok: true }>['reason'], string> = {
  empty: 'web widget needs a url or a file path',
  invalid: 'not a web address or a file path',
  'not-https': 'web widget shows https: pages, http: pages on this machine (localhost, 127.0.0.1) and files',
  userinfo: 'web widget URL must not carry a username or password',
  'own-origin': 'web widget URL must not point at this dashboard',
  'file-type': `web widget files must be one of ${WEB_FILE_EXTENSIONS.join(' ')}`,
  'file-path': 'web widget file path must not contain a ".." step, an empty step or a backslash',
};

/** The web widget's target, normalized (a page's href, a file's path), or a validation error. */
export function checkWebUrl(raw: unknown, selfOrigin?: string): string {
  const t = classifyWebTarget(raw, selfOrigin);
  if (!t.ok) throw new WhiteboardValidationError(`${WEB_TARGET_REASON[t.reason]}${t.reason === 'empty' ? '' : `: ${String(raw)}`}`);
  return t.kind === 'url' ? t.href : t.path;
}

function optString(dc: Record<string, unknown>, key: string, max = MAX_TEXT_CHARS): void {
  const v = dc[key];
  if (v === undefined) return;
  if (typeof v !== 'string') throw new WhiteboardValidationError(`widget ${key} must be a string`);
  if (v.length > max) throw new WhiteboardValidationError(`widget ${key} is too long (${v.length} chars, max ${max})`);
}

/** Validate `customData.dc`. Throws {@link WhiteboardValidationError}; returns the typed payload. */
export function validateWidgetPayload(raw: unknown, opts: { selfOrigin?: string } = {}): WidgetPayload {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new WhiteboardValidationError('widget payload must be an object');
  }
  const dc = raw as Record<string, unknown>;
  if (dc.v !== 1) throw new WhiteboardValidationError(`unsupported widget payload version: ${String(dc.v)}`);
  if (!isWidgetKind(dc.kind)) {
    throw new WhiteboardValidationError(`unknown widget kind '${String(dc.kind)}' (expected one of ${WIDGET_KINDS.join(', ')})`);
  }
  const kind = dc.kind;
  if (dc.ref !== undefined && !isValidWidgetRef(kind, dc.ref)) throw new WhiteboardValidationError(`invalid widget ref: ${String(dc.ref)}`);
  if (REF_KINDS.includes(kind) && dc.ref === undefined) throw new WhiteboardValidationError(`${kind} widget needs a ref`);
  if (dc.tag !== undefined && !isValidTag(dc.tag)) throw new WhiteboardValidationError(`invalid tag: ${String(dc.tag)}`);
  if (dc.size !== undefined && !isWidgetSize(dc.size)) {
    throw new WhiteboardValidationError(`invalid widget size '${String(dc.size)}' (expected one of ${Object.keys(WIDGET_SIZES).join(', ')})`);
  }
  if (dc.color !== undefined && !isCardColor(dc.color)) {
    throw new WhiteboardValidationError(`invalid card color '${String(dc.color)}' (expected one of ${CARD_COLORS.join(', ')})`);
  }
  optString(dc, 'title', 500);
  optString(dc, 'markdown');
  optString(dc, 'html');
  if (dc.url !== undefined || kind === 'web') {
    // Validate, but keep the stored string as written — normalizing here would make an
    // unchanged widget look changed to the byte-level no-op check.
    checkWebUrl(dc.url, opts.selfOrigin);
  }
  if (dc.items !== undefined) {
    if (!Array.isArray(dc.items)) throw new WhiteboardValidationError('todo items must be an array');
    if (dc.items.length > MAX_ITEMS) throw new WhiteboardValidationError(`too many todo items (max ${MAX_ITEMS})`);
    for (const it of dc.items) {
      const item = it as Record<string, unknown>;
      if (!item || typeof item !== 'object' || typeof item.id !== 'string' || typeof item.text !== 'string' || typeof item.done !== 'boolean') {
        throw new WhiteboardValidationError('each todo item must be {id: string, text: string, done: boolean}');
      }
    }
  }
  if (dc.sections !== undefined) {
    if (kind !== 'wiki') throw new WhiteboardValidationError(`sections apply to wiki widgets, not ${kind}`);
    // The same rules the CLI's nav ops write by: ids, limits, page refs (slug or project path).
    // Stored lists are complete: a section without its `pages` array is refused, never stored
    // half-formed (readers still treat one that reached disk another way as empty: nav.ts).
    try {
      if (Array.isArray(dc.sections)) {
        for (const sec of dc.sections) {
          if (sec && typeof sec === 'object' && !Array.isArray((sec as Record<string, unknown>).pages)) {
            throw new WhiteboardValidationError(`section '${String((sec as Record<string, unknown>).id)}' needs a pages array (use [] for none)`);
          }
        }
      }
      validateNav({ sections: dc.sections });
    } catch (err) {
      throw new WhiteboardValidationError(`wiki card: ${(err as Error).message}`);
    }
  }
  return dc as unknown as WidgetPayload;
}

/** An Excalidraw file id (nanoid, or the sha1 the CLI uses): never a path. */
export const FILE_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

export function isValidFileId(id: unknown): id is string {
  return typeof id === 'string' && FILE_ID_RE.test(id);
}

/**
 * Validate ONE element: an object with a string `id` and `type` and a numeric `version`; an
 * `image` names its picture by a valid `fileId` (the bytes live beside the board, `files.ts`);
 * a `customData.dc` must be a valid widget payload.
 */
export function validateElement(raw: unknown, opts: { selfOrigin?: string } = {}): WhiteboardElement {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new WhiteboardValidationError('every element must be an object');
  const el = raw as Record<string, unknown>;
  if (typeof el.id !== 'string' || !el.id) throw new WhiteboardValidationError('every element needs a string id');
  if (typeof el.type !== 'string' || !el.type) throw new WhiteboardValidationError(`element ${el.id} needs a string type`);
  if (typeof el.version !== 'number' || !Number.isFinite(el.version)) {
    throw new WhiteboardValidationError(`element ${el.id} needs a numeric version`);
  }
  if (el.type === 'image' && el.isDeleted !== true && !isValidFileId(el.fileId)) {
    throw new WhiteboardValidationError(`image ${el.id} needs a valid fileId`);
  }
  if (el.customData !== undefined && el.customData !== null) {
    if (typeof el.customData !== 'object' || Array.isArray(el.customData)) {
      throw new WhiteboardValidationError(`element ${el.id} customData must be an object`);
    }
    const cd = el.customData as Record<string, unknown>;
    // A tombstone has its heavy payload stripped (D14) and never renders, so its remains are
    // not re-validated; reviving it takes a live copy at a higher version, which is.
    if (cd.dc !== undefined && el.isDeleted !== true) validateWidgetPayload(cd.dc, opts);
    if (cd.dcTag !== undefined && !isValidTag(cd.dcTag)) throw new WhiteboardValidationError(`invalid tag: ${String(cd.dcTag)}`);
  }
  return el as WhiteboardElement;
}

/** Validate a whole incoming element list (PUT body, CLI import). */
export function validateIncomingElements(raw: unknown, opts: { selfOrigin?: string } = {}): WhiteboardElement[] {
  if (!Array.isArray(raw)) throw new WhiteboardValidationError('elements must be an array');
  const seen = new Set<string>();
  const out: WhiteboardElement[] = [];
  for (const r of raw) {
    const el = validateElement(r, opts);
    if (seen.has(el.id)) throw new WhiteboardValidationError(`duplicate element id: ${el.id}`);
    seen.add(el.id);
    out.push(el);
  }
  return out;
}

/**
 * Strict-pick a PUT body to `{elements}`. Any other key (notably `files`: a picture's bytes go
 * up on their own route, never inside a board body) is a 400; the body is never spread.
 * `byteLength`, when the caller measured the raw body, enforces the cap.
 */
export function validatePutBody(
  body: unknown,
  opts: { byteLength?: number; selfOrigin?: string } = {},
): { elements: WhiteboardElement[] } {
  if (opts.byteLength !== undefined && opts.byteLength > WHITEBOARD_MAX_BODY_BYTES) {
    throw new WhiteboardTooLargeError(`request body is ${opts.byteLength} bytes (max ${WHITEBOARD_MAX_BODY_BYTES})`);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new WhiteboardValidationError('body must be an object {elements}');
  const keys = Object.keys(body);
  if (keys.includes('files')) {
    throw new WhiteboardValidationError('a board body never carries files: pictures are uploaded on their own (POST /api/whiteboards/<slug>/files/<id>)');
  }
  const extra = keys.filter((k) => k !== 'elements');
  if (extra.length > 0) throw new WhiteboardValidationError(`unexpected body keys: ${extra.join(', ')}`);
  return { elements: validateIncomingElements((body as { elements?: unknown }).elements, opts) };
}
