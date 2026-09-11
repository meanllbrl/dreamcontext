import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import fg from 'fast-glob';
import { readFrontmatter, writeFrontmatter, updateFrontmatterFields } from '../frontmatter.js';
import { ensureGitignoreEntries } from '../gitignore.js';
import { today } from '../id.js';
import {
  CONNECTOR_KINDS,
  ConnectorError,
  DEFAULT_EVERY_CYCLES,
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_EVENTS,
  type ClickUpListRef,
  type ConnectorCache,
  type ConnectorCadence,
  type ConnectorCaps,
  type ConnectorManifest,
  type ConnectorSource,
} from './types.js';

/**
 * Sleep-connector store — mirrors lab/store.ts. Markdown-first: one manifest
 * per connector under `connectors/<slug>.md`, event cache under
 * `connectors/cache/<slug>.json`. Reads are LENIENT (malformed sub-blocks
 * degrade, never throw); writes are STRICT (throw ConnectorError).
 *
 * The cache holds RAW pulled text from the source — it is gitignored
 * (gitignore-first, like the secrets store) so external content never syncs
 * into the brain repo. The manifest, which holds only the agreement, is
 * tracked and recall-indexable.
 */

/** The .gitignore entry covering every connector cache. */
export const CONNECTORS_CACHE_GITIGNORE_ENTRY = 'connectors/cache/';

export function connectorsDir(contextRoot: string): string {
  return join(contextRoot, 'connectors');
}
export function connectorsCacheDir(contextRoot: string): string {
  return join(connectorsDir(contextRoot), 'cache');
}
export function connectorPath(contextRoot: string, slug: string): string {
  return join(connectorsDir(contextRoot), `${slug}.md`);
}
export function connectorCachePath(contextRoot: string, slug: string): string {
  return join(connectorsCacheDir(contextRoot), `${slug}.json`);
}

/** Kebab-case, path-safe slug (same shape insights/objectives/tasks use). */
export function isSafeConnectorSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(slug) && !slug.includes('--') && !slug.endsWith('-');
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function strOrNull(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' || s === 'null' ? null : s;
}

function posNumOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** LENIENT list parse: entries without an id are skipped. */
export function parseLists(v: unknown): ClickUpListRef[] {
  if (!Array.isArray(v)) return [];
  const out: ClickUpListRef[] = [];
  for (const raw of v) {
    const r = asRecord(raw);
    const id = r ? strOrNull(r.id) : typeof raw === 'string' || typeof raw === 'number' ? strOrNull(raw) : null;
    if (!id) continue;
    out.push({ id, name: r ? strOrNull(r.name) : null });
  }
  return out;
}

/** LENIENT source parse: unknown kind → null (the connector lists as broken). */
export function parseConnectorSource(v: unknown): ConnectorSource | null {
  const r = asRecord(v);
  if (!r) return null;
  const kind = typeof r.kind === 'string' ? r.kind.trim() : '';
  if (kind === 'clickup') {
    return { kind: 'clickup', lists: parseLists(r.lists) };
  }
  return null;
}

export function parseCadence(v: unknown): ConnectorCadence {
  const r = asRecord(v) ?? {};
  const every = posNumOrNull(r.every_cycles);
  const ttl = posNumOrNull(r.ttl_hours);
  // Neither trigger set ⇒ the default cadence: pull every sleep.
  if (every === null && ttl === null) return { every_cycles: DEFAULT_EVERY_CYCLES, ttl_hours: null };
  return { every_cycles: every, ttl_hours: ttl };
}

export function parseCaps(v: unknown): ConnectorCaps {
  const r = asRecord(v) ?? {};
  return {
    max_events: posNumOrNull(r.max_events) ?? DEFAULT_MAX_EVENTS,
    max_chars: posNumOrNull(r.max_chars) ?? DEFAULT_MAX_CHARS,
  };
}

export function readConnectorFile(filePath: string): ConnectorManifest {
  const { data, content } = readFrontmatter<Record<string, unknown>>(filePath);
  const slug = basename(filePath, '.md');
  return {
    slug,
    title: typeof data.title === 'string' && data.title.trim() ? data.title : slug,
    source: parseConnectorSource(data.source) ?? { kind: 'clickup', lists: [] },
    cadence: parseCadence(data.cadence),
    caps: parseCaps(data.caps),
    path: filePath,
    body: content.trim(),
  };
}

/** All connectors, sorted by slug. Missing directory → empty list. */
export function listConnectors(contextRoot: string): ConnectorManifest[] {
  const dir = connectorsDir(contextRoot);
  if (!existsSync(dir)) return [];
  const files = fg.sync('*.md', { cwd: dir, absolute: true }).sort();
  const out: ConnectorManifest[] = [];
  for (const file of files) {
    try {
      out.push(readConnectorFile(file));
    } catch {
      // skip a manifest that won't parse as frontmatter
    }
  }
  return out;
}

export function getConnector(contextRoot: string, slug: string): ConnectorManifest | null {
  const path = connectorPath(contextRoot, slug);
  if (!isSafeConnectorSlug(slug) || !existsSync(path)) return null;
  try {
    return readConnectorFile(path);
  } catch {
    return null;
  }
}

// ─── Cache read/write (atomic) ──────────────────────────────────────────────

export function freshCache(slug: string): ConnectorCache {
  return {
    slug,
    pulledAt: null,
    pulledCycle: null,
    cursors: {},
    events: [],
    consumedAt: null,
    history: [],
    error: null,
    errorAt: null,
  };
}

export function readConnectorCache(contextRoot: string, slug: string): ConnectorCache {
  const path = connectorCachePath(contextRoot, slug);
  if (!existsSync(path)) return freshCache(slug);
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return freshCache(slug);
    const c = parsed as Partial<ConnectorCache>;
    return {
      ...freshCache(slug),
      ...c,
      cursors: asRecord(c.cursors) ? (c.cursors as Record<string, number>) : {},
      events: Array.isArray(c.events) ? c.events : [],
      history: Array.isArray(c.history) ? c.history : [],
    };
  } catch {
    return freshCache(slug);
  }
}

export function writeConnectorCache(contextRoot: string, cache: ConnectorCache): void {
  // ORDERING GUARANTEE (mirrors the secrets store): pulled external content
  // must never be committable — gitignore first, abort the write on failure.
  ensureGitignoreEntries(contextRoot, [CONNECTORS_CACHE_GITIGNORE_ENTRY], {
    comment: 'dreamcontext connector caches (raw pulled content — never commit)',
  });
  mkdirSync(connectorsCacheDir(contextRoot), { recursive: true });
  const path = connectorCachePath(contextRoot, cache.slug);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2) + '\n', 'utf-8');
  renameSync(tmp, path); // atomic replace
}

// ─── Create / edit ──────────────────────────────────────────────────────────

export interface CreateConnectorInput {
  slug: string;
  title: string;
  kind?: string;
  lists?: ClickUpListRef[];
  every_cycles?: number;
  ttl_hours?: number;
  learn?: string | null;
}

/** STRICT validation for writes (throws ConnectorError). Reads stay lenient. */
export function validateConnectorForWrite(input: CreateConnectorInput): void {
  if (!isSafeConnectorSlug(input.slug.trim())) {
    throw new ConnectorError(`Invalid connector slug "${input.slug}" — use kebab-case (e.g. clickup-product-lists).`);
  }
  if (!input.title || !input.title.trim()) {
    throw new ConnectorError('A connector title is required.');
  }
  const kind = (input.kind ?? 'clickup').trim();
  if (!(CONNECTOR_KINDS as readonly string[]).includes(kind)) {
    throw new ConnectorError(`kind must be one of: ${CONNECTOR_KINDS.join(', ')}.`);
  }
  if (!input.lists || input.lists.length === 0) {
    throw new ConnectorError('A ClickUp connector needs at least one list (--list <id> — repeatable).');
  }
  const ids = input.lists.map((l) => l.id.trim());
  if (ids.some((id) => !id)) throw new ConnectorError('List ids must be non-empty.');
  if (new Set(ids).size !== ids.length) throw new ConnectorError('Duplicate list ids.');
  if (input.every_cycles !== undefined && (!Number.isFinite(input.every_cycles) || input.every_cycles <= 0)) {
    throw new ConnectorError('every_cycles must be a positive number.');
  }
  if (input.ttl_hours !== undefined && (!Number.isFinite(input.ttl_hours) || input.ttl_hours <= 0)) {
    throw new ConnectorError('ttl_hours must be a positive number.');
  }
}

export function createConnector(contextRoot: string, input: CreateConnectorInput): ConnectorManifest {
  validateConnectorForWrite(input);
  const slug = input.slug.trim();
  const path = connectorPath(contextRoot, slug);
  if (existsSync(path)) throw new ConnectorError(`Connector already exists: ${slug}`);

  const frontmatter: Record<string, unknown> = {
    title: input.title.trim(),
    source: {
      kind: input.kind ?? 'clickup',
      lists: (input.lists ?? []).map((l) => ({ id: l.id.trim(), name: l.name })),
    },
    cadence: {
      every_cycles: input.every_cycles ?? (input.ttl_hours ? null : DEFAULT_EVERY_CYCLES),
      ttl_hours: input.ttl_hours ?? null,
    },
    caps: { max_events: DEFAULT_MAX_EVENTS, max_chars: DEFAULT_MAX_CHARS },
    created_at: today(),
    updated_at: today(),
  };

  const body = [
    '## Learn',
    '',
    input.learn?.trim()
      || '(What should the sleep agent extract from these lists — and what should it ignore? e.g. "decisions, blockers, and spec changes from the comments; ignore routine status pings.")',
    '',
  ].join('\n');

  mkdirSync(connectorsDir(contextRoot), { recursive: true });
  writeFrontmatter(path, frontmatter, body);
  return readConnectorFile(path);
}

/** Add a list to an existing connector. Idempotent on the list id. */
export function addConnectorList(contextRoot: string, slug: string, list: ClickUpListRef): ConnectorManifest {
  const manifest = getConnector(contextRoot, slug);
  if (!manifest) throw new ConnectorError(`Connector not found: ${slug}`);
  const id = list.id.trim();
  if (!id) throw new ConnectorError('List id must be non-empty.');
  if (manifest.source.lists.some((l) => l.id === id)) {
    throw new ConnectorError(`List ${id} is already on connector ${slug}.`);
  }
  const lists = [...manifest.source.lists, { id, name: list.name }];
  updateFrontmatterFields(manifest.path, {
    source: { kind: manifest.source.kind, lists },
    updated_at: today(),
  });
  return readConnectorFile(manifest.path);
}

/** Remove a list; its cursor is dropped so a re-add starts fresh. */
export function removeConnectorList(contextRoot: string, slug: string, listId: string): ConnectorManifest {
  const manifest = getConnector(contextRoot, slug);
  if (!manifest) throw new ConnectorError(`Connector not found: ${slug}`);
  const id = listId.trim();
  const lists = manifest.source.lists.filter((l) => l.id !== id);
  if (lists.length === manifest.source.lists.length) {
    throw new ConnectorError(`List ${id} is not on connector ${slug}.`);
  }
  updateFrontmatterFields(manifest.path, {
    source: { kind: manifest.source.kind, lists },
    updated_at: today(),
  });
  const cache = readConnectorCache(contextRoot, slug);
  if (id in cache.cursors) {
    delete cache.cursors[id];
    writeConnectorCache(contextRoot, cache);
  }
  return readConnectorFile(manifest.path);
}

export function removeConnector(contextRoot: string, slug: string): void {
  const manifest = getConnector(contextRoot, slug);
  if (!manifest) throw new ConnectorError(`Connector not found: ${slug}`);
  rmSync(manifest.path, { force: true });
  rmSync(connectorCachePath(contextRoot, slug), { force: true });
}

// ─── Due check + consume ────────────────────────────────────────────────────

export interface DueStatus {
  due: boolean;
  reason: string;
}

/**
 * A connector is due when EITHER cadence trigger fires. `currentCycle` is the
 * number of COMPLETED sleep cycles (sleep-history length); `nowMs` is
 * injectable for tests.
 */
export function connectorDue(
  manifest: ConnectorManifest,
  cache: ConnectorCache,
  currentCycle: number,
  nowMs: number,
): DueStatus {
  if (cache.pulledAt === null) return { due: true, reason: 'never pulled' };
  const { every_cycles, ttl_hours } = manifest.cadence;
  if (every_cycles !== null && cache.pulledCycle !== null && currentCycle - cache.pulledCycle >= every_cycles) {
    return { due: true, reason: `${currentCycle - cache.pulledCycle} cycle(s) since last pull (cadence ${every_cycles})` };
  }
  if (ttl_hours !== null) {
    const ageMs = nowMs - Date.parse(cache.pulledAt);
    if (Number.isFinite(ageMs) && ageMs >= ttl_hours * 3_600_000) {
      return { due: true, reason: `${Math.floor(ageMs / 3_600_000)}h since last pull (ttl ${ttl_hours}h)` };
    }
  }
  return { due: false, reason: 'not due' };
}

/**
 * Mark pending events as distilled: clears them and stamps `consumedAt`.
 * Called by the sleep flow AFTER canonical docs are updated — an aborted cycle
 * that never consumes re-offers the same events on the next pull.
 */
export function consumeConnectorEvents(contextRoot: string, slug: string): number {
  if (!getConnector(contextRoot, slug)) throw new ConnectorError(`Connector not found: ${slug}`);
  const cache = readConnectorCache(contextRoot, slug);
  const consumed = cache.events.length;
  cache.events = [];
  cache.consumedAt = new Date().toISOString();
  writeConnectorCache(contextRoot, cache);
  return consumed;
}
