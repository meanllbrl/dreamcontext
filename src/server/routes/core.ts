import { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readFrontmatter, writeFrontmatter } from '../../lib/frontmatter.js';
import { listSections, readSection } from '../../lib/markdown.js';
import { parseJsonBody, sendJson, sendError } from '../middleware.js';
import { safeChildPath } from '../safe-path.js';
import { recordDashboardChange } from '../change-tracker.js';
import {
  PeopleStoreError,
  isSafePersonSlug,
  listPeople,
  peopleDir,
  type Person,
} from '../../lib/people-store.js';
import { resolveActivePerson } from '../../lib/people-resolve.js';

function getCoreDir(contextRoot: string): string {
  return join(contextRoot, 'core');
}

/**
 * GET /api/core - List all core files
 */
export async function handleCoreList(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const coreDir = getCoreDir(contextRoot);
  if (!existsSync(coreDir)) {
    sendJson(res, 200, { files: [] });
    return;
  }

  const entries = readdirSync(coreDir, { withFileTypes: true });
  const files = entries
    .filter(e => e.isFile() && (e.name.endsWith('.md') || e.name.endsWith('.sql') || e.name.endsWith('.json')))
    .map(e => {
      const filePath = join(coreDir, e.name);
      let frontmatter: Record<string, unknown> = {};
      if (e.name.endsWith('.md')) {
        try {
          const { data } = readFrontmatter(filePath);
          frontmatter = data;
        } catch { /* not a frontmatter file */ }
      }
      return {
        filename: e.name,
        name: frontmatter.name ?? e.name.replace(/^\d+\./, '').replace(/\.[^.]+$/, '').replace(/_/g, ' '),
        type: frontmatter.type ?? (e.name.endsWith('.json') ? 'json' : e.name.endsWith('.sql') ? 'sql' : 'markdown'),
      };
    })
    .sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }));

  sendJson(res, 200, { files });
}

/**
 * GET /api/core/:filename - Read a single core file
 */
export async function handleCoreGet(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const { filename } = params;
  const filePath = safeChildPath(getCoreDir(contextRoot), filename);
  if (!filePath) {
    sendError(res, 400, 'invalid_path', 'Invalid filename.');
    return;
  }

  if (!existsSync(filePath)) {
    sendError(res, 404, 'not_found', `Core file not found: ${filename}`);
    return;
  }

  if (filename.endsWith('.json')) {
    const raw = readFileSync(filePath, 'utf-8');
    try {
      const data = JSON.parse(raw);
      sendJson(res, 200, { filename, type: 'json', data });
    } catch {
      sendJson(res, 200, { filename, type: 'json', data: null, raw });
    }
    return;
  }

  if (filename.endsWith('.md')) {
    const { data: frontmatter, content } = readFrontmatter(filePath);
    let sections: string[] = [];
    try {
      sections = listSections(filePath);
    } catch { /* no sections */ }

    const sectionContents: Record<string, string> = {};
    for (const section of sections) {
      try {
        const sectionContent = readSection(filePath, section);
        if (sectionContent) sectionContents[section] = sectionContent;
      } catch { /* skip */ }
    }

    sendJson(res, 200, {
      filename,
      type: 'markdown',
      frontmatter,
      content,
      sections,
      sectionContents,
    });
    return;
  }

  // Other file types (e.g., .sql)
  const raw = readFileSync(filePath, 'utf-8');
  sendJson(res, 200, { filename, type: 'text', content: raw });
}

/**
 * PUT /api/core/:filename - Write a core file
 */
export async function handleCoreUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const { filename } = params;
  const filePath = safeChildPath(getCoreDir(contextRoot), filename);
  if (!filePath) {
    sendError(res, 400, 'invalid_path', 'Invalid filename.');
    return;
  }

  if (!existsSync(filePath)) {
    sendError(res, 404, 'not_found', `Core file not found: ${filename}`);
    return;
  }

  const body = await parseJsonBody(req);
  if (!body) {
    sendError(res, 400, 'invalid_body', 'Request body must be JSON.');
    return;
  }

  const changedParts: string[] = [];

  if (filename.endsWith('.md')) {
    const frontmatter = (body.frontmatter as Record<string, unknown>) ?? undefined;
    const content = body.content as string;

    if (content === undefined && !frontmatter) {
      sendError(res, 400, 'no_changes', 'Provide frontmatter and/or content to update.');
      return;
    }

    // Read existing file ONCE for both writing and change tracking
    const existing = readFrontmatter(filePath);

    if (frontmatter) {
      const changedKeys = Object.keys(frontmatter).filter(
        k => JSON.stringify(existing.data[k]) !== JSON.stringify(frontmatter[k]),
      );
      if (changedKeys.length > 0) changedParts.push(`frontmatter (${changedKeys.join(', ')})`);
    }
    if (content !== undefined && content !== existing.content) {
      changedParts.push('content');
    }

    if (frontmatter && content !== undefined) {
      writeFrontmatter(filePath, frontmatter, content);
    } else if (frontmatter) {
      writeFrontmatter(filePath, { ...existing.data, ...frontmatter }, existing.content);
    } else {
      writeFrontmatter(filePath, existing.data, content);
    }
  } else {
    // Non-markdown files: write raw content
    if (typeof body.content !== 'string') {
      sendError(res, 400, 'missing_content', 'Content string is required for non-markdown files.');
      return;
    }
    changedParts.push('content');
    writeFileSync(filePath, body.content as string, 'utf-8');
  }

  const what = changedParts.length > 0 ? changedParts.join(' and ') : 'file';
  recordDashboardChange(contextRoot, {
    entity: 'core',
    action: 'update',
    target: `core/${filename}`,
    summary: `core '${filename}': updated ${what}`,
  });

  sendJson(res, 200, { success: true });
}

// ─── People (constitutions + roster) ─────────────────────────────────────────
//
// Three ADDITIVE routes (D6). They are deliberately NOT an extension of
// `handleCoreGet/Update`: those root their `safeChildPath` at `core/`, and
// serving `people/` through them would mean re-rooting at `contextRoot` — which
// widens the dashboard's writable surface from one directory to the whole vault.
// Separate handlers keep each traversal guard tight and leave every existing
// core consumer byte-identical.
//
// Slug discipline: `isSafePersonSlug` runs BEFORE any filesystem access, so a
// hostile `:slug` never even reaches `safeChildPath` (which then re-checks the
// resolved path — defense in depth, two independent gates).

/**
 * Resolve `people/<slug>.md`, or null when the slug is not a legal person slug
 * or the resolved path escapes `people/`. The charset check is first and
 * standalone: it means no request-shaped string is ever passed to `join`.
 */
function personConstitutionPath(contextRoot: string, slug: string): string | null {
  if (!isSafePersonSlug(slug)) return null;
  return safeChildPath(peopleDir(contextRoot), `${slug}.md`);
}

/** Character count of a constitution — `String.length`, matching `auditCoreFileSizes`. Absent/unreadable ⇒ 0. */
function constitutionChars(filePath: string): number {
  try {
    return readFileSync(filePath, 'utf-8').length;
  } catch {
    return 0; // missing or unreadable file is a doctor problem, not a 500
  }
}

/**
 * GET /api/core/people — the roster plus who is active on THIS machine.
 *
 * D17 read-path rule: a present-but-corrupt `people.json` degrades to an empty
 * roster with the parse error attached, at 200 — the dashboard must render, and
 * `doctor` is the loud channel. The `error` key is OMITTED on the happy path, so
 * a healthy vault's payload carries no apology field.
 */
export async function handlePeopleList(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  let roster: Array<Person & { slug: string }>;
  try {
    roster = listPeople(contextRoot);
  } catch (err) {
    if (!(err instanceof PeopleStoreError)) throw err;
    sendJson(res, 200, { activeSlug: null, source: 'none', people: [], error: err.message });
    return;
  }

  // `resolveActivePerson` never throws and re-reads the same (now known-good)
  // roster, so it cannot disagree with the list above.
  const active = resolveActivePerson(contextRoot);
  const dir = peopleDir(contextRoot);

  sendJson(res, 200, {
    activeSlug: active.slug,
    source: active.source,
    people: roster.map((person) => ({
      slug: person.slug,
      name: person.name,
      ...(person.role ? { role: person.role } : {}),
      active: person.slug === active.slug,
      chars: constitutionChars(join(dir, `${person.slug}.md`)),
    })),
  });
}

/**
 * The roster display name for `slug`, or null when the roster has no entry (or
 * cannot be read). Never throws — the constitution FILE is the thing being
 * served here; the roster only supplies a nicer label.
 */
function rosterName(contextRoot: string, slug: string): string | null {
  try {
    return listPeople(contextRoot).find((p) => p.slug === slug)?.name ?? null;
  } catch (err) {
    if (!(err instanceof PeopleStoreError)) throw err;
    return null;
  }
}

/**
 * GET /api/core/people/:slug — one person's constitution.
 *
 * `content` is the RAW file, frontmatter included, because the response carries
 * no separate `frontmatter` key: whole-file in, whole-file out is what makes the
 * GET → edit → PUT round trip lossless.
 */
export async function handlePersonGet(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const { slug } = params;
  const filePath = personConstitutionPath(contextRoot, slug);
  if (!filePath) {
    sendError(res, 400, 'invalid_path', 'Invalid person slug.');
    return;
  }
  if (!existsSync(filePath)) {
    sendError(res, 404, 'not_found', `No constitution for person: ${slug}`);
    return;
  }

  sendJson(res, 200, {
    slug,
    name: rosterName(contextRoot, slug) ?? slug,
    content: readFileSync(filePath, 'utf-8'),
  });
}

/**
 * PUT /api/core/people/:slug — replace one person's constitution.
 *
 * Writes the body VERBATIM (the mirror of the GET above). Like
 * `handleCoreUpdate`, it only ever overwrites an existing file: creating a
 * person is `dreamcontext people add`'s job, which also writes the roster entry
 * — a constitution with no roster entry is exactly the orphan `doctor` errors on.
 */
export async function handlePersonUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const { slug } = params;
  const filePath = personConstitutionPath(contextRoot, slug);
  if (!filePath) {
    sendError(res, 400, 'invalid_path', 'Invalid person slug.');
    return;
  }
  if (!existsSync(filePath)) {
    sendError(res, 404, 'not_found', `No constitution for person: ${slug}`);
    return;
  }

  const body = await parseJsonBody(req);
  if (!body) {
    sendError(res, 400, 'invalid_body', 'Request body must be JSON.');
    return;
  }
  if (typeof body.content !== 'string') {
    sendError(res, 400, 'missing_content', 'Content string is required.');
    return;
  }

  writeFileSync(filePath, body.content, 'utf-8');

  recordDashboardChange(contextRoot, {
    entity: 'core',
    action: 'update',
    target: `people/${slug}.md`,
    summary: `person '${slug}': updated constitution`,
  });

  sendJson(res, 200, { ok: true });
}
