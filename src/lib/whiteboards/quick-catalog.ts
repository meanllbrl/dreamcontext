/**
 * What the quick edit's model may name when it adds a widget (it has no tools, so it cannot look
 * anything up): a compact list of this vault's insights, tasks, knowledge pages, lab cards and
 * agents, slug + title. It rides in the user message, OUTSIDE the cached system prompt, bounded
 * by {@link QUICK_CATALOG_MAX}. It is a hint only: the server resolves every name the model picks
 * against the vault itself (`widgetRefExists`, then {@link resolveByTitle}: an exact, unique title
 * across the WHOLE vault), so a name cut from this list still resolves, and nothing is guessed.
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

const KEYS = ['insights', 'tasks', 'knowledge', 'labCards', 'agents'] as const;

/**
 * The catalog as one JSON line, at most `max` characters. Over budget, the longest list loses its
 * tail (oldest rows) a little at a time, so the budget stays filled; a list that lost rows is named
 * in `cut` (shown, total), so the model never presents a slice as the whole (review r1).
 */
export function catalogText(cat: QuickCatalog, max = QUICK_CATALOG_MAX): string {
  const c: QuickCatalog = { ...cat };
  const text = () => {
    const cut = Object.fromEntries(KEYS.filter((k) => c[k].length < cat[k].length).map((k) => [k, [c[k].length, cat[k].length]]));
    return JSON.stringify(Object.keys(cut).length ? { ...c, cut } : c);
  };
  let out = text();
  while (out.length > max) {
    const key = KEYS.reduce((a, b) => (c[a].length >= c[b].length ? a : b));
    if (c[key].length === 0) break;
    // Shed in proportion to the overshoot (at least one row): few steps, no budget left unused.
    const over = (out.length - max) / out.length;
    c[key] = c[key].slice(0, Math.max(0, c[key].length - Math.max(1, Math.ceil(c[key].length * over))));
    out = text();
  }
  return out.length > max ? JSON.stringify({ insights: [], tasks: [], knowledge: [], labCards: [], agents: [] }) : out;
}

const KIND_LIST: Record<string, keyof QuickCatalog> = { insight: 'insights', task: 'tasks', knowledge: 'knowledge', 'lab-card': 'labCards', agent: 'agents' };
// Case folded both ways for Turkish: I/ı and İ/i meet, so "ÖDEME SAYFASI" is "Ödeme sayfası" and "LOGIN" is "login".
const norm = (s: string): string => s.normalize('NFC').toLowerCase().replace(/i\u0307/g, 'i').replace(/ı/g, 'i').replace(/\s+/g, ' ').trim();

/**
 * A widget name the catalog did not carry, read against the whole vault: the slug whose title is
 * exactly that name (case and spacing aside), when exactly one has it. Null otherwise: no near
 * match, no guess.
 */
export function resolveByTitle(root: string, kind: string, name: string): string | null {
  const list = KIND_LIST[kind];
  if (!list) return null;
  // The catalog's titles are cut at TITLE_MAX: a longer name is compared as the catalog holds it.
  const want = norm(clean(name));
  if (!want) return null;
  const hits = readQuickCatalog(root)[list].filter((r) => norm(r[1]) === want || norm(r[0]) === want);
  return hits.length === 1 ? hits[0][0] : null;
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
