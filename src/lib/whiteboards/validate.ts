import {
  WIDGET_KINDS,
  WIDGET_SIZES,
  REF_KINDS,
  isWidgetKind,
  isWidgetSize,
  isValidPageRef,
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
 * slug OR a project-relative .md/.pdf/.html path; insight and task refs stay slugs.
 */
export function isValidWidgetRef(kind: WidgetKind, ref: unknown): ref is string {
  return kind === 'knowledge' ? isValidPageRef(ref) : isValidRef(ref);
}

export function isValidTag(tag: unknown): tag is string {
  return typeof tag === 'string' && TAG_RE.test(tag);
}

/**
 * D7: a web widget URL must be `https:`, carry no userinfo, and (when the caller knows its own
 * origin — the server does, the CLI does not) must not point back at the dashboard itself.
 * Returns the normalized href.
 */
export function checkWebUrl(raw: unknown, selfOrigin?: string): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new WhiteboardValidationError('web widget needs a url');
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new WhiteboardValidationError(`not a valid URL: ${raw}`);
  }
  if (u.protocol !== 'https:') throw new WhiteboardValidationError(`web widget URL must be https: (got ${u.protocol})`);
  if (u.username || u.password) throw new WhiteboardValidationError('web widget URL must not carry a username or password');
  if (selfOrigin && u.origin === selfOrigin) throw new WhiteboardValidationError('web widget URL must not point at this dashboard');
  return u.href;
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

/**
 * Validate ONE element: an object with a string `id` and `type` and a numeric `version`;
 * never an `image` (D10); a `customData.dc` must be a valid widget payload.
 */
export function validateElement(raw: unknown, opts: { selfOrigin?: string } = {}): WhiteboardElement {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new WhiteboardValidationError('every element must be an object');
  const el = raw as Record<string, unknown>;
  if (typeof el.id !== 'string' || !el.id) throw new WhiteboardValidationError('every element needs a string id');
  if (typeof el.type !== 'string' || !el.type) throw new WhiteboardValidationError(`element ${el.id} needs a string type`);
  if (typeof el.version !== 'number' || !Number.isFinite(el.version)) {
    throw new WhiteboardValidationError(`element ${el.id} needs a numeric version`);
  }
  if (el.type === 'image') {
    throw new WhiteboardValidationError('Images are not supported on whiteboards yet (they come in a later version)');
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
 * Strict-pick a PUT body to `{elements}`. Any other key (notably `files`, D10) is a 400; the
 * body is never spread. `byteLength`, when the caller measured the raw body, enforces the cap.
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
    throw new WhiteboardValidationError('Images are not supported on whiteboards yet: a body carrying files is refused');
  }
  const extra = keys.filter((k) => k !== 'elements');
  if (extra.length > 0) throw new WhiteboardValidationError(`unexpected body keys: ${extra.join(', ')}`);
  return { elements: validateIncomingElements((body as { elements?: unknown }).elements, opts) };
}
