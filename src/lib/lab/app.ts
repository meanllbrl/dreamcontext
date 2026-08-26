import {
  LabError,
  type AppPage,
  type AppShell,
  type AppSpec,
} from './types.js';

/**
 * App contract (`app/v1`) — validation, caps, page lookup.
 *
 * A script may return `{ data, app? }` (never `app` bare — `data` stays
 * mandatory, and never `app` alongside `html`, both enforced by sync.ts, not
 * here). `app` declares a multi-page, bridge-driven body: an ordered list of
 * pages, each its own sandboxed html fragment, wired to the host via
 * labAppRuntime's postMessage bridge (dashboard side — this module only
 * validates and caps the SHAPE). `data` stays the queryable numbers (often a
 * `dataset/v1` bundle for dimensional pages) — `app` never substitutes for it.
 *
 * Everything here is pure — no fs, no fetch, no DOM — so the CLI, the sync
 * engine, the routes, and tests all share one implementation. Mirrors
 * matrix.ts throughout.
 */

export const APP_SPEC_KIND = 'app/v1';

// ─── Caps (structural — enforced, not advised; every hit is a loud reject.
// An app spec is presentation CODE, not data: unlike a matrix row there is
// nothing safe to silently collapse — dropping a page breaks a route and
// every deep link into it, so caps here reject rather than truncate). ──
export const MAX_APP_PAGES = 12;
/** Byte cap on the whole serialized spec (every page's html + shell). */
export const MAX_APP_BYTES = 300_000;
/** Page id charset — used in URLs (`/lab/<slug>/p/<pageId>`) and as bridge
 *  `navigate` targets, so it is kept URL-safe and predictable. */
export const APP_PAGE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface ParsedAppSpec {
  spec: AppSpec;
  /** Human-readable coercion notices — surfaced, never swallowed. */
  notices: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parsePage(raw: unknown, index: number, notices: string[]): AppPage {
  if (!isRecord(raw)) {
    throw new LabError(`App spec pages[${index}] must be an object with { id, title, html }.`);
  }
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id || !APP_PAGE_ID_RE.test(id)) {
    throw new LabError(`App spec pages[${index}].id "${String(raw.id)}" must match ${APP_PAGE_ID_RE} (lowercase letters, digits, hyphens, 1-64 chars).`);
  }
  const html = typeof raw.html === 'string' ? raw.html : '';
  if (!html.trim()) {
    throw new LabError(`App spec pages[${index}] ("${id}") has no \`html\`.`);
  }
  let title: string;
  if (typeof raw.title === 'string' && raw.title.trim()) {
    title = raw.title.trim();
  } else {
    title = id;
    notices.push(`pages[${index}] ("${id}") has no \`title\` — used the id.`);
  }
  const page: AppPage = { id, title, html };
  if (typeof raw.dataset === 'string' && raw.dataset.trim()) page.dataset = raw.dataset.trim();
  return page;
}

function parseShell(raw: unknown): AppShell | undefined {
  if (!isRecord(raw)) return undefined;
  const shell: AppShell = {};
  if (typeof raw.style === 'string' && raw.style.trim()) shell.style = raw.style;
  if (typeof raw.script === 'string' && raw.script.trim()) shell.script = raw.script;
  return shell.style !== undefined || shell.script !== undefined ? shell : undefined;
}

/**
 * Validate + cap a raw app spec. Every violation is STRUCTURAL and throws
 * `LabError` — unlike a matrix row, a malformed page cannot degrade to a
 * notice and keep rendering: a missing/colliding/unreachable page id breaks
 * routing and deep links, not just one cell of a pivot.
 */
export function parseAppSpec(raw: unknown): ParsedAppSpec {
  if (!isRecord(raw) || raw.kind !== APP_SPEC_KIND) {
    throw new LabError(`App payload must be an object with kind "${APP_SPEC_KIND}".`);
  }
  if (!Array.isArray(raw.pages) || raw.pages.length === 0) {
    throw new LabError('App payload must have a non-empty `pages` array.');
  }
  if (raw.pages.length > MAX_APP_PAGES) {
    throw new LabError(`App payload declares ${raw.pages.length} pages — the cap is ${MAX_APP_PAGES}. Split into a linked set of insights, or cut unused pages.`);
  }

  const notices: string[] = [];
  const pages = raw.pages.map((p, i) => parsePage(p, i, notices));

  const seen = new Set<string>();
  for (const page of pages) {
    if (seen.has(page.id)) throw new LabError(`App payload has two pages with id "${page.id}" — ids must be unique.`);
    seen.add(page.id);
  }

  const entry = typeof raw.entry === 'string' ? raw.entry.trim() : '';
  if (!entry) throw new LabError('App payload must declare `entry` — the page id shown at /lab/<slug>.');
  if (!seen.has(entry)) throw new LabError(`App payload's \`entry\` ("${entry}") is not one of the declared pages[].id.`);

  const spec: AppSpec = { kind: APP_SPEC_KIND, entry, pages };

  if (raw.card !== undefined) {
    const card = typeof raw.card === 'string' ? raw.card.trim() : '';
    if (!card || !seen.has(card)) {
      throw new LabError(`App payload's \`card\` ("${String(raw.card)}") is not one of the declared pages[].id.`);
    }
    spec.card = card;
  }

  const shell = parseShell(raw.shell);
  if (shell) spec.shell = shell;

  if (JSON.stringify(spec).length > MAX_APP_BYTES) {
    throw new LabError(`App payload exceeds the ${MAX_APP_BYTES}-byte cap — slim the markup (host-served data via lab.data() means the body should not need to embed numbers).`);
  }

  return { spec, notices };
}

/** The page to render: `id` when it names a declared page, else the spec's
 *  `entry` — the fallback a stale deep link or an unset `pageId` hits. */
export function findAppPage(spec: AppSpec, id: string | null | undefined): AppPage | null {
  if (id) {
    const found = spec.pages.find((p) => p.id === id);
    if (found) return found;
  }
  return spec.pages.find((p) => p.id === spec.entry) ?? null;
}

/** Declared page ids, in spec order — the page-tab list / route enumeration. */
export function appPageIds(spec: AppSpec): string[] {
  return spec.pages.map((p) => p.id);
}
