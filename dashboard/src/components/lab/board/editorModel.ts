import { findFreeSlot } from '../../../generated/grid';
import type { InsightSummary } from '../../../hooks/useLab';
import type {
  Block, BlockCatalog, BlockCatalogEntry, BlockOptionSchema, BlockTab, BlockType, Board, Card, GridRect,
  LibraryBlock, LibraryBlockInput,
} from './boardTypes';

/**
 * The editors' pure half: every edit the block inspector, the add-card menu and
 * the save-to-library dialog make is a function here from the current card (or
 * board) to the NEXT one. The components only collect input and hand the
 * result to `InspectorProps.onChange` / `AddCardMenuProps.onAdd`, so the page's
 * save queue and undo stack see one whole card per edit.
 *
 * The inspector form is GENERATED from the catalog's options schema
 * (`fieldsFor`): a new option in `src/lib/lab/blocks.ts` shows up here with
 * no edit. Client checks (`cardProblems`) mirror the engine's strict write
 * rules the editors can break, so an edit that would 400 on PUT stays a local
 * draft with its problem shown instead of reaching the save queue.
 *
 * Block paths follow the frame keys: `[i]` for a card block, `[i, tab, j]`
 * for block `j` of tab `tab` inside the tabs block `i` (tabs are ONE level).
 */

// ─── Slugs and bindings (engine mirrors: store.ts, frames.ts, block-library.ts) ──

/** `isSafeInsightSlug`: kebab-case, no `--`, no trailing `-`. Library slugs follow it too. */
export function isSafeSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(slug) && !slug.includes('--') && !slug.endsWith('-');
}

/** `isSafeInputName`: what `lab.data(name)` may ask for. */
export function isSafeInputName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(name);
}

/** `parseDataRef`: `<insight>` or `<insight>/<datasetKey>`, else null. */
export function parseBinding(ref: unknown): { insight: string; dataset: string | null } | null {
  if (typeof ref !== 'string') return null;
  const s = ref.trim();
  const slash = s.indexOf('/');
  const insight = slash === -1 ? s : s.slice(0, slash);
  if (!isSafeSlug(insight)) return null;
  if (slash === -1) return { insight, dataset: null };
  const dataset = s.slice(slash + 1);
  if (!dataset || dataset.length > 128 || /[\u0000-\u001f]/.test(dataset)) return null;
  return { insight, dataset };
}

export function formatBinding(insight: string, dataset: string | null): string {
  const d = dataset?.trim() ?? '';
  return d ? `${insight}/${d}` : insight;
}

/** A card id the board does not use yet: `base`, else `base-2`, `base-3`, ... */
export function uniqueCardId(board: Pick<Board, 'cards'>, base: string): string {
  const clean = base.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 180) || 'card';
  const taken = new Set(board.cards.map((c) => c.id));
  if (!taken.has(clean)) return clean;
  let n = 2;
  while (taken.has(`${clean}-${n}`)) n++;
  return `${clean}-${n}`;
}

// ─── Catalog lookups ────────────────────────────────────────────────────────

export function entryOf(catalog: BlockCatalog, type: BlockType): BlockCatalogEntry {
  const hit = catalog.blocks.find((b) => b.type === type);
  if (!hit) throw new Error(`block type "${type}" is not in the catalog`);
  return hit;
}

// ─── The generated form ─────────────────────────────────────────────────────

export type FieldControl =
  | 'toggle' | 'select' | 'number' | 'text' | 'textarea' | 'list' | 'where' | 'sort' | 'tabs' | 'inputs' | 'html' | 'library-ref';

export interface FieldSpec {
  key: string;
  control: FieldControl;
  labelKey: string;
  schema: BlockOptionSchema;
}

const CONTROL_OF: Record<BlockOptionSchema['type'], FieldControl> = {
  boolean: 'toggle',
  enum: 'select',
  number: 'number',
  string: 'text',
  markdown: 'textarea',
  'string-list': 'list',
  where: 'where',
  sort: 'sort',
  tabs: 'tabs',
  inputs: 'inputs',
  html: 'html',
};

/** One field per catalog option, in catalog order. An html block's `ref` is the library picker. */
export function fieldsFor(entry: BlockCatalogEntry): FieldSpec[] {
  return entry.options.map((schema) => ({
    key: schema.key,
    control: entry.type === 'html' && schema.key === 'ref' ? 'library-ref' : CONTROL_OF[schema.type],
    labelKey: schema.labelKey,
    schema,
  }));
}

/** The i18n key an enum value's label lives under. */
export function enumLabelKey(optionKey: string, value: string | number): string {
  return `lab.editor.enum.${optionKey}.${String(value)}`;
}

// ─── Type change in place ───────────────────────────────────────────────────

/**
 * Whether a block of type `from` may become `to` without re-binding: the same
 * data mode, and for bound blocks at least one frame kind in common (a series
 * line can become a bar; a funnel only a funnel). `tabs` carries structure, so
 * it only ever matches itself (which also keeps tabs out of a tab).
 */
export function canChangeType(catalog: BlockCatalog, from: BlockType, to: BlockType): boolean {
  if (from === to) return true;
  if (from === 'tabs' || to === 'tabs') return false;
  const a = entryOf(catalog, from);
  const b = entryOf(catalog, to);
  if (a.data !== b.data) return false;
  if (a.data === 'binding') return a.frames.some((k) => b.frames.includes(k));
  return a.frames.length === 0 && b.frames.length === 0;
}

export function typeChoices(catalog: BlockCatalog, from: BlockType): BlockType[] {
  return catalog.types.filter((to) => canChangeType(catalog, from, to));
}

/** A value the schema accepts (the engine's `optionProblem`, minus byte caps). */
export function optionAccepts(schema: BlockOptionSchema, v: unknown): boolean {
  switch (schema.type) {
    case 'boolean': return typeof v === 'boolean';
    case 'enum': return !!schema.enum && schema.enum.includes(v as string | number);
    case 'number':
      return typeof v === 'number' && Number.isInteger(v)
        && v >= (schema.min ?? Number.MIN_SAFE_INTEGER) && v <= (schema.max ?? Number.MAX_SAFE_INTEGER);
    case 'string': case 'markdown': case 'html': return typeof v === 'string';
    case 'string-list': return Array.isArray(v) && v.every((s) => typeof s === 'string' && s.trim() !== '');
    case 'where': return parseWhereValue(v) !== null;
    case 'sort': return sortParts(v) !== null;
    case 'inputs': return inputsRecord(v) !== null;
    case 'tabs': return true;
  }
}

/** Change a block's type in place: the binding stays, options the new type also accepts carry over. */
export function changeType(catalog: BlockCatalog, block: Block, to: BlockType): Block {
  if (block.type === to) return block;
  const next = entryOf(catalog, to);
  const options: Record<string, unknown> = {};
  for (const schema of next.options) {
    if (schema.type === 'tabs') continue;
    const v = block.options[schema.key];
    if (v !== undefined && optionAccepts(schema, v)) options[schema.key] = v;
  }
  const out: Block = { type: to, options };
  if (block.data !== undefined && next.data !== 'none' && next.data !== 'inputs') out.data = block.data;
  return out;
}

// ─── Option values ──────────────────────────────────────────────────────────

/** Set one option; `undefined` (or an empty text/list) removes it so the file stays minimal. */
export function setOption(block: Block, key: string, value: unknown): Block {
  const options = { ...block.options };
  const emptyRecord = !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
  const empty = value === undefined || value === null || value === ''
    || (Array.isArray(value) && value.length === 0)
    // An html block's inputs stay declared even when empty; an empty where is no filter at all.
    || (emptyRecord && key !== 'inputs');
  if (empty) delete options[key];
  else options[key] = value;
  return { ...block, options };
}

/** A number field's text as the option value: a whole number clamped into range, empty = unset. */
export function parseNumberField(text: string, schema: Pick<BlockOptionSchema, 'min' | 'max'>): number | undefined {
  const s = text.trim();
  if (s === '') return undefined;
  const n = Math.round(Number(s));
  if (!Number.isFinite(n)) return undefined;
  return Math.min(schema.max ?? Number.MAX_SAFE_INTEGER, Math.max(schema.min ?? Number.MIN_SAFE_INTEGER, n));
}

/** `a, b ,c` -> `['a', 'b', 'c']`. */
export function parseListField(text: string): string[] {
  return text.split(',').map((s) => s.trim()).filter((s) => s !== '');
}

export function formatListField(v: unknown): string {
  return Array.isArray(v) ? v.join(', ') : '';
}

type WhereValue = Record<string, string | number | Array<string | number>>;

function parseWhereValue(v: unknown): WhereValue | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  for (const x of Object.values(v as Record<string, unknown>)) {
    const ok = typeof x === 'string' || typeof x === 'number'
      || (Array.isArray(x) && x.every((y) => typeof y === 'string' || typeof y === 'number'));
    if (!ok) return null;
  }
  return v as WhereValue;
}

/** The where editor's text: one `dim: a, b` line per dimension. */
export function formatWhereField(v: unknown): string {
  const w = parseWhereValue(v);
  if (!w) return '';
  return Object.entries(w).map(([dim, x]) => `${dim}: ${Array.isArray(x) ? x.join(', ') : String(x)}`).join('\n');
}

/** `country: TR, DE` lines -> `{country: ['TR', 'DE']}`; a single value stays a scalar. Blank lines skipped. */
export function parseWhereField(text: string): WhereValue {
  const out: WhereValue = {};
  for (const line of text.split('\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const dim = line.slice(0, colon).trim();
    const values = parseListField(line.slice(colon + 1));
    if (!dim || values.length === 0) continue;
    out[dim] = values.length === 1 ? values[0] : values;
  }
  return out;
}

function sortParts(v: unknown): { by: string; dir: 'asc' | 'desc' } | null {
  if (typeof v === 'string' && /^-?[^\s-][^\s]*$/.test(v)) {
    return v.startsWith('-') ? { by: v.slice(1), dir: 'desc' } : { by: v, dir: 'asc' };
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const r = v as Record<string, unknown>;
    if (typeof r.by === 'string' && r.by.trim() && (r.dir === undefined || r.dir === 'asc' || r.dir === 'desc')) {
      return { by: r.by.trim(), dir: r.dir === 'desc' ? 'desc' : 'asc' };
    }
  }
  return null;
}

/** The sort editor's parts from either stored form. */
export function formatSortField(v: unknown): { by: string; dir: 'asc' | 'desc' } {
  return sortParts(v) ?? { by: '', dir: 'desc' };
}

/** `{by, dir}` -> the short file form (`"-v"` for descending), or undefined when `by` is blank. */
export function parseSortField(by: string, dir: 'asc' | 'desc'): string | { by: string; dir: 'asc' | 'desc' } | undefined {
  const b = by.trim();
  if (!b) return undefined;
  // The short form cannot hold spaces or a leading dash.
  if (/\s/.test(b) || b.startsWith('-')) return { by: b, dir };
  return dir === 'desc' ? `-${b}` : b;
}

export function inputsRecord(v: unknown): Record<string, string> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (typeof x !== 'string') return null;
    out[k] = x;
  }
  return out;
}

/** The inputs editor's rows, in declaration order. */
export function inputRows(block: Block): Array<{ name: string; binding: string }> {
  return Object.entries(inputsRecord(block.options.inputs) ?? {}).map(([name, binding]) => ({ name, binding }));
}

/** Rows back to `inputs: {name: binding}`; rows with a blank name are dropped. Order kept. */
export function setInputs(block: Block, rows: ReadonlyArray<{ name: string; binding: string }>): Block {
  const inputs: Record<string, string> = {};
  for (const r of rows) {
    const name = r.name.trim();
    if (name) inputs[name] = r.binding.trim();
  }
  return { ...block, options: { ...block.options, inputs } };
}

// ─── Bindings ───────────────────────────────────────────────────────────────

/** Bind a block to an insight (optionally one of its datasets). `insight` null = unbind (insight blocks fall back to the card insight). */
export function setBinding(block: Block, insight: string | null, dataset: string | null = null): Block {
  const out: Block = { ...block };
  if (!insight) delete out.data;
  else out.data = formatBinding(insight, dataset);
  return out;
}

/** The dataset keys an insight's cache offers (dataset/v1 bundles only). */
export function datasetKeys(cache: { datasets?: { bundle?: { datasets?: Array<{ key: string }> } } } | null | undefined): string[] {
  return (cache?.datasets?.bundle?.datasets ?? []).map((d) => d.key).filter((k) => typeof k === 'string' && k !== '');
}

// ─── Block tree ─────────────────────────────────────────────────────────────

/**
 * The blocks a card shows. A card with an insight and no `blocks` draws one
 * legacy `insight` block; the first structural edit writes that block out, so
 * adding a stat beside a legacy chart keeps the chart.
 */
export function effectiveBlocks(card: Card): Block[] {
  if (card.blocks && card.blocks.length > 0) return card.blocks;
  return card.insight ? [{ type: 'insight', options: {} }] : [];
}

export function pathKey(path: readonly number[]): string {
  return path.join('.');
}

export function getBlock(card: Card, path: readonly number[]): Block | null {
  const top = effectiveBlocks(card)[path[0]];
  if (!top) return null;
  if (path.length === 1) return top;
  if (path.length !== 3) return null;
  return top.tabs?.[path[1]]?.blocks[path[2]] ?? null;
}

/** True when the block at `path` sits inside a tab. */
export function isNested(path: readonly number[]): boolean {
  return path.length === 3;
}

function withBlocks(card: Card, blocks: Block[]): Card {
  const next: Card = { ...card };
  if (blocks.length === 0 && card.insight) delete next.blocks;
  else next.blocks = blocks;
  return next;
}

/** The list holding `path`'s block, edited by `fn`; the rest of the tree is shared, not copied. */
function editContainer(card: Card, path: readonly number[], fn: (list: Block[]) => Block[]): Card {
  const blocks = effectiveBlocks(card);
  if (path.length === 1) return withBlocks(card, fn([...blocks]));
  const [i, t] = path;
  const host = blocks[i];
  if (!host?.tabs?.[t]) return card;
  const tabs = host.tabs.map((tab, ti) => (ti === t ? { ...tab, blocks: fn([...tab.blocks]) } : tab));
  return withBlocks(card, blocks.map((b, bi) => (bi === i ? { ...host, tabs } : b)));
}

export function updateBlock(card: Card, path: readonly number[], fn: (block: Block) => Block): Card {
  if (!getBlock(card, path)) return card;
  const at = path[path.length - 1];
  return editContainer(card, path, (list) => list.map((b, i) => (i === at ? fn(b) : b)));
}

/** Whether removing `path` leaves the card something to show (the engine refuses an empty card). */
export function canRemoveBlock(card: Card, path: readonly number[]): boolean {
  if (!getBlock(card, path)) return false;
  if (isNested(path)) return true;
  return effectiveBlocks(card).length > 1 || !!card.insight;
}

export function removeBlock(card: Card, path: readonly number[]): Card {
  if (!canRemoveBlock(card, path)) return card;
  const at = path[path.length - 1];
  return editContainer(card, path, (list) => list.filter((_, i) => i !== at));
}

/** Move the block at `path` one place up (-1) or down (+1) within its list; out of range = unchanged. */
export function moveBlock(card: Card, path: readonly number[], delta: -1 | 1): Card {
  const at = path[path.length - 1];
  let moved = false;
  const next = editContainer(card, path, (list) => {
    const to = at + delta;
    if (to < 0 || to >= list.length) return list;
    [list[at], list[to]] = [list[to], list[at]];
    moved = true;
    return list;
  });
  return moved ? next : card;
}

/** The path a moved block lands on. */
export function movedPath(path: readonly number[], delta: -1 | 1): number[] {
  return [...path.slice(0, -1), path[path.length - 1] + delta];
}

/**
 * Append `block` to the card (`tab` null) or to tab `tab.tab` of the tabs
 * block at `tab.at`. A tabs block never goes inside a tab. Returns the card
 * and the new block's path, or null when refused.
 */
export function addBlock(card: Card, block: Block, tab: { at: number; tab: number } | null = null): { card: Card; path: number[] } | null {
  const blocks = effectiveBlocks(card);
  if (!tab) return { card: withBlocks(card, [...blocks, block]), path: [blocks.length] };
  if (block.type === 'tabs') return null;
  const host = blocks[tab.at];
  if (host?.type !== 'tabs' || !host.tabs?.[tab.tab]) return null;
  const length = host.tabs[tab.tab].blocks.length;
  const next = editContainer(card, [tab.at, tab.tab, 0], (list) => [...list, block]);
  return { card: next, path: [tab.at, tab.tab, length] };
}

export function addTab(card: Card, at: number, label: string): Card {
  return updateBlock(card, [at], (b) => ({ ...b, tabs: [...(b.tabs ?? []), { label, blocks: [] }] }));
}

export function renameTab(card: Card, at: number, tab: number, label: string): Card {
  return updateBlock(card, [at], (b) => ({ ...b, tabs: (b.tabs ?? []).map((tb, i) => (i === tab ? { ...tb, label } : tb)) }));
}

/** Remove a tab (and its blocks). The last tab stays: a tabs block needs one. */
export function removeTab(card: Card, at: number, tab: number): Card {
  return updateBlock(card, [at], (b) => {
    const tabs = b.tabs ?? [];
    return tabs.length <= 1 ? b : { ...b, tabs: tabs.filter((_, i) => i !== tab) };
  });
}

export function moveTab(card: Card, at: number, tab: number, delta: -1 | 1): Card {
  return updateBlock(card, [at], (b) => {
    const tabs = [...(b.tabs ?? [])];
    const to = tab + delta;
    if (to < 0 || to >= tabs.length) return b;
    [tabs[tab], tabs[to]] = [tabs[to], tabs[tab]];
    return { ...b, tabs };
  });
}

// ─── New blocks ─────────────────────────────────────────────────────────────

export interface NewBlockContext {
  /** The insight a bound block starts on (card insight, else the menu's pick). */
  insight: string | null;
  /** First tab's label (localized by the caller). */
  tabLabel: string;
  /** Blank html's starter markup (localized by the caller). */
  htmlStarter: string;
}

/** A fresh block of `type` with the catalog's required parts filled in; options otherwise left to defaults. */
export function newBlock(catalog: BlockCatalog, type: BlockType, ctx: NewBlockContext): Block {
  const entry = entryOf(catalog, type);
  const block: Block = { type, options: {} };
  if (entry.data === 'binding' && ctx.insight) block.data = ctx.insight;
  if (type === 'tabs') block.tabs = [{ label: ctx.tabLabel, blocks: [] }];
  if (type === 'html') block.options = { html: ctx.htmlStarter, inputs: {} };
  return block;
}

/** Escape text for the blank html block's starter markup. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Client checks (the strict write rules an editor can break) ─────────────

export type ProblemCode =
  | 'data-required' | 'data-unsafe' | 'insight-missing' | 'filter-dim' | 'html-source' | 'ref-unsafe'
  | 'input-name' | 'input-binding' | 'tabs-empty' | 'tab-label' | 'tabs-nested' | 'card-empty' | 'option-invalid';

export interface EditorProblem {
  /** `pathKey` of the block, or '' for the card. */
  path: string;
  code: ProblemCode;
  /** The option or input the problem is about, when there is one. */
  key?: string;
}

function blockProblems(catalog: BlockCatalog, card: Card, block: Block, path: number[], out: EditorProblem[]): void {
  const at = pathKey(path);
  const entry = entryOf(catalog, block.type);
  if (entry.data === 'binding') {
    if (block.data === undefined || block.data === '') out.push({ path: at, code: 'data-required' });
    else if (!parseBinding(block.data)) out.push({ path: at, code: 'data-unsafe' });
  } else if (entry.data === 'insight') {
    if (block.data !== undefined && parseBinding(block.data)?.dataset !== null) out.push({ path: at, code: 'data-unsafe' });
    if (block.data === undefined && !card.insight) out.push({ path: at, code: 'insight-missing' });
  }
  for (const schema of entry.options) {
    const v = block.options[schema.key];
    if (v === undefined || schema.type === 'tabs') continue;
    if (!optionAccepts(schema, v)) out.push({ path: at, code: 'option-invalid', key: schema.key });
  }
  if (block.type === 'filter' && !(typeof block.options.dim === 'string' && block.options.dim.trim())) {
    out.push({ path: at, code: 'filter-dim', key: 'dim' });
  }
  if (block.type === 'html') {
    const hasHtml = typeof block.options.html === 'string' && block.options.html.trim() !== '';
    const ref = block.options.ref;
    if (hasHtml === (ref !== undefined)) out.push({ path: at, code: 'html-source' });
    if (ref !== undefined && (typeof ref !== 'string' || !isSafeSlug(ref))) out.push({ path: at, code: 'ref-unsafe', key: 'ref' });
    for (const [name, binding] of Object.entries(inputsRecord(block.options.inputs) ?? {})) {
      if (!isSafeInputName(name)) out.push({ path: at, code: 'input-name', key: name });
      else if (!parseBinding(binding)) out.push({ path: at, code: 'input-binding', key: name });
    }
  }
  if (block.type === 'tabs') {
    if (path.length > 1) out.push({ path: at, code: 'tabs-nested' });
    const tabs = block.tabs ?? [];
    if (tabs.length === 0) out.push({ path: at, code: 'tabs-empty' });
    tabs.forEach((tab: BlockTab, ti) => {
      if (!tab.label.trim()) out.push({ path: at, code: 'tab-label', key: String(ti) });
      tab.blocks.forEach((child, ci) => blockProblems(catalog, card, child, [path[0], ti, ci], out));
    });
  }
}

/** Every problem the engine's strict write would refuse, in block order. Empty = safe to save. */
export function cardProblems(catalog: BlockCatalog, card: Card): EditorProblem[] {
  const out: EditorProblem[] = [];
  if (!card.insight && (!card.blocks || card.blocks.length === 0)) out.push({ path: '', code: 'card-empty' });
  (card.blocks ?? []).forEach((b, i) => blockProblems(catalog, card, b, [i], out));
  return out;
}

// ─── Add-card menu ──────────────────────────────────────────────────────────

export interface InsightChoice {
  slug: string;
  title: string;
  unplaced: boolean;
}

/** Unplaced insights first (in the server's order), then the rest in list order. Unknown unplaced slugs still show. */
export function insightChoices(insights: readonly InsightSummary[], unplaced: readonly string[]): InsightChoice[] {
  const bySlug = new Map(insights.map((i) => [i.slug, i]));
  const lead = [...new Set(unplaced)].map((slug) => ({ slug, title: bySlug.get(slug)?.title ?? slug, unplaced: true }));
  const set = new Set(lead.map((c) => c.slug));
  const rest = insights.filter((i) => !set.has(i.slug)).map((i) => ({ slug: i.slug, title: i.title, unplaced: false }));
  return [...lead, ...rest];
}

const WIDTH_W: Record<string, number> = { '1': 4, '2': 8, '3': 12 };
const HEIGHT_H: Record<string, number> = { s: 3, m: 4, l: 6, xl: 8 };

/** A legacy insight card's footprint: the manifest's width/height, else the render's default span (D2). */
export function insightCardSize(catalog: BlockCatalog, summary: Pick<InsightSummary, 'render' | 'width' | 'height'> | undefined): { w: number; h: number } {
  const span = summary?.width ?? catalog.renderDefaultSpan[summary?.render ?? ''] ?? 1;
  const w = WIDTH_W[String(span)] ?? 4;
  const tall = summary?.render === 'app' || summary?.render === 'raw';
  const h = (summary?.height ? HEIGHT_H[String(summary.height)] : undefined) ?? (tall ? 6 : 4);
  return { w, h };
}

type NewCard = Omit<Card, 'at'> & { at: GridRect };

/** "From an insight": one legacy card (no blocks = rendered exactly as v1), placed in the first free slot. */
export function cardFromInsight(catalog: BlockCatalog, board: Pick<Board, 'cards'>, slug: string, summary?: InsightSummary): NewCard {
  const { w, h } = insightCardSize(catalog, summary);
  return { id: uniqueCardId(board, `c-${slug}`), insight: slug, at: findFreeSlot(board.cards, w, h) };
}

/** "From the library: block types": one block of `type` on `insight` (the card's primary insight when bound). */
export function cardFromBlockType(
  catalog: BlockCatalog,
  board: Pick<Board, 'cards'>,
  type: BlockType,
  ctx: NewBlockContext,
): NewCard {
  const entry = entryOf(catalog, type);
  const block = newBlock(catalog, type, ctx);
  const card: NewCard = {
    id: uniqueCardId(board, ctx.insight && entry.data === 'binding' ? `c-${ctx.insight}-${type}` : `c-${type}`),
    blocks: [block],
    at: findFreeSlot(board.cards, entry.defaultSize.w, entry.defaultSize.h),
  };
  if (entry.data === 'binding' && ctx.insight) card.insight = ctx.insight;
  if (type === 'insight' && ctx.insight) card.insight = ctx.insight;
  return card;
}

/** A library block reused by ref: `html: {ref, inputs}`, each declared input bound to `insight` when given. */
export function refBlock(entry: Pick<LibraryBlock, 'slug' | 'inputs'>, insight: string | null, keep?: Record<string, string>): Block {
  const inputs: Record<string, string> = {};
  for (const inp of entry.inputs) {
    const kept = keep?.[inp.name];
    if (kept) inputs[inp.name] = kept;
    else if (insight) inputs[inp.name] = insight;
  }
  return { type: 'html', options: { ref: entry.slug, inputs } };
}

/** "Custom HTML": a library entry by ref, or (entry null) a blank inline block. */
export function cardFromHtml(
  catalog: BlockCatalog,
  board: Pick<Board, 'cards'>,
  entry: Pick<LibraryBlock, 'slug' | 'inputs'> | null,
  ctx: NewBlockContext,
): NewCard {
  const size = entryOf(catalog, 'html').defaultSize;
  const block = entry ? refBlock(entry, ctx.insight) : newBlock(catalog, 'html', ctx);
  const card: NewCard = {
    id: uniqueCardId(board, entry ? `c-${entry.slug}` : 'c-html'),
    blocks: [block],
    at: findFreeSlot(board.cards, size.w, size.h),
  };
  if (ctx.insight && entry && entry.inputs.length > 0) card.insight = ctx.insight;
  return card;
}

/**
 * The block types the library section offers: everything but the legacy
 * `insight` block (the insight section), `html` (its own section) and `filter`
 * (it needs a dimension and filters the blocks beside it, so it is added
 * inside a card from the inspector, never as a card of its own).
 */
export function libraryBlockTypes(catalog: BlockCatalog): BlockType[] {
  return catalog.types.filter((t) => t !== 'insight' && t !== 'html' && t !== 'filter');
}

// ─── Save to library ────────────────────────────────────────────────────────

export interface LibraryDraft {
  slug: string;
  title: string;
  description: string;
  inputs: LibraryBlockInput[];
}

export type LibraryDraftProblem = 'slug' | 'title' | 'html' | 'input-name' | 'input-duplicate';

/** The dialog's first values: the inline block's declared input names, kinds unset. */
export function libraryDraftFrom(block: Block): LibraryDraft {
  return {
    slug: '',
    title: '',
    description: '',
    inputs: Object.keys(inputsRecord(block.options.inputs) ?? {}).map((name) => ({ name, kind: null })),
  };
}

/** A title as a slug suggestion: ASCII kebab (Turkish letters folded), like board slugs. */
export function slugSuggestion(title: string): string {
  const folded = title
    .replace(/[ıİ]/g, 'i').replace(/[şŞ]/g, 's').replace(/[ğĞ]/g, 'g').replace(/[üÜ]/g, 'u').replace(/[öÖ]/g, 'o').replace(/[çÇ]/g, 'c')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase();
  return folded.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
}

/** Client mirror of `validateLibraryBlock`. */
export function libraryDraftProblems(draft: LibraryDraft, html: string): LibraryDraftProblem[] {
  const out: LibraryDraftProblem[] = [];
  if (!isSafeSlug(draft.slug.trim())) out.push('slug');
  if (!draft.title.trim()) out.push('title');
  if (!html.trim()) out.push('html');
  const seen = new Set<string>();
  for (const inp of draft.inputs) {
    if (!isSafeInputName(inp.name)) out.push('input-name');
    else if (seen.has(inp.name)) out.push('input-duplicate');
    seen.add(inp.name);
  }
  return [...new Set(out)];
}

export interface LibraryPutRequest {
  path: string;
  body: {
    title: string;
    description: string | null;
    inputs: LibraryBlockInput[];
    html: string;
    /** The rev last read when replacing an entry; null = must not exist yet. */
    rev: string | null;
  };
}

/** `PUT /api/lab/blocks/:slug`. `existing` = the entry being replaced (its rev guards the write). */
export function libraryPutRequest(draft: LibraryDraft, html: string, existing: Pick<LibraryBlock, 'rev'> | null): LibraryPutRequest {
  const slug = draft.slug.trim();
  return {
    path: `/lab/blocks/${encodeURIComponent(slug)}`,
    body: {
      title: draft.title.trim(),
      description: draft.description.trim() || null,
      inputs: draft.inputs.map((i) => ({ name: i.name.trim(), kind: i.kind })),
      html,
      rev: existing ? existing.rev : null,
    },
  };
}

/**
 * After a save: the inline block becomes a library reference, `html: {ref,
 * inputs}` in the file. Bindings for names the entry still declares are kept.
 */
export function inlineToRef(block: Block, saved: Pick<LibraryBlock, 'slug' | 'inputs'>): Block {
  return refBlock(saved, null, inputsRecord(block.options.inputs) ?? {});
}

/** "Edit a copy": a library reference back to inline markup, bindings kept. */
export function refToInline(block: Block, entry: Pick<LibraryBlock, 'html'>): Block {
  const options: Record<string, unknown> = { ...block.options, html: entry.html };
  delete options.ref;
  if (!options.inputs) options.inputs = {};
  return { ...block, options };
}
