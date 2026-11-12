/**
 * What the quick edit's model may name when it adds a widget (it has no tools, so it cannot look
 * anything up): a compact list of this vault's insights, tasks, knowledge pages, lab cards and
 * agents, slug + title. It rides in the user message, OUTSIDE the cached system prompt, bounded
 * by {@link QUICK_CATALOG_MAX}. It is a hint only: the server resolves every name the model picks
 * against the vault itself (`widgetRefExists`), so a name missing here is refused, never guessed.
 */
import { basename, join } from 'node:path';
import { existsSync, lstatSync, statSync } from 'node:fs';
import fg from 'fast-glob';
import { readFrontmatter } from '../frontmatter.js';
import { listInsights } from '../lab/store.js';
import { listBoards } from '../lab/boards.js';
import { listAgents } from '../agents/store.js';
import { buildKnowledgeIndex } from '../knowledge-index.js';

export const QUICK_CATALOG_MAX = 16_000;
const TITLE_MAX = 80;
const CACHE_MS = 30_000;
const CACHE_KEYS = 8;

type Row = [string, string] | [string, string, string];
export interface QuickCatalog {
  insights: Row[];
  tasks: Row[];
  knowledge: Row[];
  labCards: Row[];
  agents: Row[];
}

// eslint-disable-next-line no-control-regex
const clean = (s: unknown): string => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, TITLE_MAX);
const CLOSED = new Set(['completed', 'cancelled', 'done']);

function safe<T>(fn: () => T[]): T[] {
  try { return fn(); } catch { return []; }
}

function readTasks(root: string): Row[] {
  const dir = join(root, 'state');
  if (!existsSync(dir)) return [];
  const rows: { slug: string; title: string; status: string; updated: string }[] = [];
  for (const file of fg.sync('*.md', { cwd: dir, absolute: true })) {
    try {
      if (lstatSync(file).isSymbolicLink()) continue;
      const { data } = readFrontmatter<Record<string, unknown>>(file);
      rows.push({ slug: basename(file, '.md'), title: clean(data.name ?? data.description), status: clean(data.status), updated: clean(data.updated_at ?? data.created_at) });
    } catch { /* skipped */ }
  }
  // Open work first, newest first: the owner names what he is working on.
  rows.sort((a, b) => Number(CLOSED.has(a.status)) - Number(CLOSED.has(b.status)) || b.updated.localeCompare(a.updated));
  return rows.map((t) => [t.slug, t.title, `${t.status} ${t.updated}`.trim()]);
}

/** The catalog as data (uncapped), from the vault. */
export function readQuickCatalog(root: string): QuickCatalog {
  return {
    insights: safe(() => listInsights(root).map((i): Row => [i.slug, clean(i.title)])),
    tasks: safe(() => readTasks(root)),
    knowledge: safe(() => buildKnowledgeIndex(root).sort((a, b) => b.mtime - a.mtime).map((k): Row => [k.slug, clean(k.name)])),
    labCards: safe(() => listBoards(root).boards.flatMap((b) => b.cards.map((c): Row => [`${b.slug}/${c.id}`, clean(c.title ?? c.insight ?? c.id)]))),
    agents: safe(() => listAgents(root).map((a): Row => [a.slug, clean(a.title)])),
  };
}

/** The catalog as one JSON line, at most `max` characters: the longest lists halve first. */
export function catalogText(cat: QuickCatalog, max = QUICK_CATALOG_MAX): string {
  const c: QuickCatalog = { ...cat };
  let out = JSON.stringify(c);
  let guard = 0;
  while (out.length > max && guard++ < 64) {
    const key = (Object.keys(c) as (keyof QuickCatalog)[]).reduce((a, b) => (c[a].length >= c[b].length ? a : b));
    if (c[key].length === 0) break;
    c[key] = c[key].slice(0, Math.floor(c[key].length / 2));
    out = JSON.stringify(c);
  }
  return out.length > max ? JSON.stringify({ insights: [], tasks: [], knowledge: [], labCards: [], agents: [] }) : out;
}

const cache = new Map<string, { at: number; sig: string; text: string }>();

/** The folders' modification times: a file added or removed there is a new catalog at once. */
function signature(root: string): string {
  return ['lab/insights', 'lab/boards', 'state', 'knowledge', 'automations'].map((d) => {
    try { return statSync(join(root, d)).mtimeMs; } catch { return 0; }
  }).join(':');
}

/** The bounded catalog text for a vault, kept {@link CACHE_MS} while its folders are unchanged. */
export function quickCatalogText(root: string, now = Date.now()): string {
  for (const [k, v] of cache) if (now - v.at >= CACHE_MS) cache.delete(k);
  const sig = signature(root);
  const hit = cache.get(root);
  if (hit && hit.sig === sig) return hit.text;
  const text = catalogText(readQuickCatalog(root));
  cache.delete(root);
  if (cache.size >= CACHE_KEYS) cache.delete(cache.keys().next().value as string);
  cache.set(root, { at: now, sig, text });
  return text;
}

export function resetQuickCatalogForTests(): void { cache.clear(); }
