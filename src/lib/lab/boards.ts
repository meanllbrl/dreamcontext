import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { acquireFileLock, releaseFileLock } from '../file-lock.js';
import { BLOCK_CATALOG, isBlockType, RENDER_DEFAULT_SPAN, type BlockOptionSchema, type BlockType } from './blocks.js';
import {
  ensureContainedLabDir,
  getLibraryBlock,
  isSafeInputName,
  parseSafeFrontmatter,
  revOf,
  stringifySafeFrontmatter,
  writeContainedLabFile,
} from './block-library.js';
import { parseDataRef } from './frames.js';
import { clampRect, findOverlaps, GRID_COLUMNS, isValidRect, resolveOverlaps, type GridRect } from './grid.js';
import { isSafeInsightSlug, labDir, listInsights, readCache, resolveContainedLabFile } from './store.js';
import { LabError, MAX_HTML_BYTES, type InsightManifest } from './types.js';
import type { Frame } from './frameOps.js';

/**
 * Board store: `lab/boards/<slug>.md`, frontmatter = the board spec, body =
 * optional prose. A board holds cards on a 12-column grid; a card holds
 * blocks from the catalog (blocks.ts) or, with no blocks, renders its insight
 * exactly as v1 did.
 *
 * READS ARE LENIENT: geometry is clamped, overlaps and duplicate ids are
 * resolved in memory (a view never writes back), a missing insight is a
 * warning, and an unparseable or conflict-marked file becomes an ERROR BOARD
 * (edit refused, 423 at the route) instead of a throw.
 * WRITES ARE STRICT: `validateBoardSpec` rejects overlaps, duplicate ids,
 * unsafe slugs and bad options with diagnostics naming the card id, the block
 * path and the fix. Every write is rev-checked, atomic (tmp + rename) and runs
 * under the shared board lock `state/.locks/lab-boards.lock` (the server and
 * the CLI take the same one).
 *
 * With no `lab/boards/` (or an empty one) boards are DERIVED from the legacy
 * manifests (`deriveBoardsFromLegacy`) and nothing is written. The first write
 * materializes EVERY board at once: all files go into
 * `lab/.boards-staging-<pid>-<random>/`, then one directory rename makes them
 * live. A failure leaves no `lab/boards/` and derivation keeps working; losing
 * the rename to another writer discards the staging dir, re-reads and
 * re-applies the edit.
 */

// ─── Types (mirrored in dashboard/src/components/lab/board/boardTypes.ts) ───

export interface BlockTab {
  label: string;
  blocks: Block[];
}

export interface Block {
  type: BlockType;
  /** `<insight>` or `<insight>/<datasetKey>` (binding blocks, optional on `insight`). */
  data?: string;
  options: Record<string, unknown>;
  /** `tabs` blocks only; one level, never nested. */
  tabs?: BlockTab[];
}

export interface Card {
  /** Unique within the board: the React key and the brain-sync merge key. */
  id: string;
  at: GridRect;
  /** Defaults to the primary insight's title. */
  title?: string;
  /** Primary insight: detail panel, refresh, range, tweaks. */
  insight?: string;
  /** Absent = one legacy `insight` block. */
  blocks?: Block[];
}

export interface BoardSpec {
  title: string;
  /** i18n key the dashboard localizes the title with (derived "Other"/"Insights" boards). */
  titleKey?: string;
  order: number;
  cards: Card[];
  body: string;
}

export interface BoardError {
  kind: 'parse' | 'conflict';
  message: string;
}

export interface BoardDiagnostic {
  /** The card the problem is on, or null for a board-level problem. */
  cardId: string | null;
  /** e.g. `cards[1].blocks[0].line.color`. */
  path: string;
  message: string;
  fix: string;
}

export interface Board extends BoardSpec {
  slug: string;
  /** Content hash of the file (or of the derived spec's serialization). */
  rev: string;
  derived: boolean;
  error: BoardError | null;
  /** Lenient-read repairs and missing insights. */
  warnings: BoardDiagnostic[];
}

export interface BoardResponse {
  board: Board;
  /** Resolved frames for block cards, keyed by `frameKey`. */
  frames: Record<string, Frame>;
  /** Per-insight summaries (freshness, latest, error) for every insight the board shows. */
  summaries: Record<string, unknown>;
  /** Insights on no board (materialized vaults only). */
  unplaced: string[];
}

export interface BoardListResponse {
  boards: Board[];
  derived: boolean;
  unplaced: string[];
}

// ─── Errors ─────────────────────────────────────────────────────────────────

export type BoardStoreErrorCode = 'invalid' | 'rev-conflict' | 'error-board' | 'busy' | 'not-found' | 'exists';

const STATUS: Record<BoardStoreErrorCode, number> = {
  invalid: 400,
  'rev-conflict': 409,
  'error-board': 423,
  busy: 503,
  'not-found': 404,
  exists: 409,
};

export class BoardStoreError extends LabError {
  readonly code: BoardStoreErrorCode;
  readonly status: number;
  readonly diagnostics: BoardDiagnostic[];
  constructor(code: BoardStoreErrorCode, message: string, diagnostics: BoardDiagnostic[] = []) {
    super(message);
    this.name = 'BoardStoreError';
    this.code = code;
    this.status = STATUS[code];
    this.diagnostics = diagnostics;
  }
}

export function formatDiagnostic(d: BoardDiagnostic): string {
  const where = d.cardId ? `card "${d.cardId}" at ${d.path}` : d.path;
  return `${where}: ${d.message} Fix: ${d.fix}`;
}

// ─── Paths ──────────────────────────────────────────────────────────────────

export function boardsDir(contextRoot: string): string {
  return join(labDir(contextRoot), 'boards');
}

export function boardsLockPath(contextRoot: string): string {
  return join(contextRoot, 'state', '.locks', 'lab-boards.lock');
}

const STAGING_PREFIX = '.boards-staging-';
const STAGING_RE = /^\.boards-staging-(\d+)-[a-z0-9]+$/;
const LOCK_STALE_MS = 30_000;
/** Room for `h-<60-char board slug>-<60-char group slug>` and `c-<insight slug>`. */
const CARD_ID_RE = /^[a-z0-9][a-z0-9-]{0,199}$/;
/** Sorts error boards (no readable order) after every real board. */
const ERROR_BOARD_ORDER = Number.MAX_SAFE_INTEGER;

function boardFileSlugs(contextRoot: string): string[] {
  const dir = boardsDir(contextRoot);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => basename(f, '.md'))
      .filter(isSafeInsightSlug)
      .sort();
  } catch {
    return [];
  }
}

/** Boards are materialized once `lab/boards/` holds at least one board file. Empty = absent. */
export function isMaterialized(contextRoot: string): boolean {
  return boardFileSlugs(contextRoot).length > 0;
}

// ─── Spec walker (one code path for the lenient read and the strict write) ──

interface WalkCtx {
  strict: boolean;
  errors: BoardDiagnostic[];
  warnings: BoardDiagnostic[];
  insightExists: ((slug: string) => boolean) | null;
  blockExists: ((slug: string) => boolean) | null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** A strict error, or (lenient) a repair recorded as a warning. */
function problem(ctx: WalkCtx, cardId: string | null, path: string, message: string, fix: string): void {
  (ctx.strict ? ctx.errors : ctx.warnings).push({ cardId, path, message, fix });
}

function warn(ctx: WalkCtx, cardId: string | null, path: string, message: string, fix: string): void {
  ctx.warnings.push({ cardId, path, message, fix });
}

function show(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s.length > 60 ? `${s.slice(0, 57)}...` : s;
  } catch {
    return String(v);
  }
}

function checkInsightRef(ctx: WalkCtx, cardId: string | null, path: string, ref: string): void {
  const parsed = parseDataRef(ref);
  if (parsed && ctx.insightExists && !ctx.insightExists(parsed.insight)) {
    warn(ctx, cardId, path, `insight "${parsed.insight}" does not exist; the block shows "missing insight".`, `create it with \`dreamcontext lab create ${parsed.insight}\` or remove the card.`);
  }
}

function isStringList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === 'string' && s.trim() !== '');
}

/** Validate one option value against its schema. Returns a problem message + fix, or null. */
function optionProblem(schema: BlockOptionSchema, v: unknown): { message: string; fix: string } | null {
  const got = `(got ${show(v)})`;
  switch (schema.type) {
    case 'boolean':
      return typeof v === 'boolean' ? null : { message: `must be true or false ${got}.`, fix: `set ${schema.key}: true or false.` };
    case 'enum':
      return schema.enum && schema.enum.includes(v as string | number)
        ? null
        : { message: `must be one of ${(schema.enum ?? []).join(', ')} ${got}.`, fix: `set ${schema.key} to one of ${(schema.enum ?? []).join(', ')}.` };
    case 'number': {
      const lo = schema.min ?? Number.MIN_SAFE_INTEGER;
      const hi = schema.max ?? Number.MAX_SAFE_INTEGER;
      return typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi
        ? null
        : { message: `must be a whole number from ${lo} to ${hi} ${got}.`, fix: `set ${schema.key} to a whole number from ${lo} to ${hi}.` };
    }
    case 'string':
    case 'markdown':
      return typeof v === 'string' ? null : { message: `must be text ${got}.`, fix: `quote the value of ${schema.key}.` };
    case 'html':
      if (typeof v !== 'string') return { message: `must be text ${got}.`, fix: 'put the markup in a YAML block string (html: |).' };
      return Buffer.byteLength(v, 'utf-8') > MAX_HTML_BYTES
        ? { message: `is over ${MAX_HTML_BYTES} bytes.`, fix: 'move data into inputs instead of inlining it, or save the block to the library.' }
        : null;
    case 'string-list':
      return isStringList(v) ? null : { message: `must be a list of names ${got}.`, fix: `write ${schema.key}: [name-a, name-b].` };
    case 'where': {
      const r = asRecord(v);
      const ok = r !== null && Object.values(r).every((x) =>
        typeof x === 'string' || typeof x === 'number' || (Array.isArray(x) && x.every((y) => typeof y === 'string' || typeof y === 'number')));
      return ok ? null : { message: `must map a dimension to a value or a list of values ${got}.`, fix: 'write where: {country: [TR, DE]}.' };
    }
    case 'sort': {
      if (typeof v === 'string' && /^-?[^\s-][^\s]*$/.test(v)) return null;
      const r = asRecord(v);
      if (r && typeof r.by === 'string' && r.by.trim() && (r.dir === undefined || r.dir === 'asc' || r.dir === 'desc')) return null;
      return { message: `must be a column name, "-name" for descending, or {by, dir} ${got}.`, fix: 'write sort: "-v" (largest first) or sort: {by: country, dir: asc}.' };
    }
    case 'inputs': {
      const r = asRecord(v);
      if (!r) return { message: `must map input names to bindings ${got}.`, fix: 'write inputs: {signups: daily-signups}.' };
      for (const [name, ref] of Object.entries(r)) {
        if (!isSafeInputName(name)) return { message: `input name "${name}" is not an identifier.`, fix: 'use letters, digits, _ or -, starting with a letter.' };
        if (!parseDataRef(ref)) return { message: `input "${name}" binding ${show(ref)} is not a safe "<insight>" or "<insight>/<dataset>".`, fix: 'bind it to a kebab-case insight slug.' };
      }
      return null;
    }
    case 'tabs':
      return null; // walked structurally
  }
}

function walkBlock(
  ctx: WalkCtx,
  raw: unknown,
  path: string,
  card: { id: string; insight?: string },
  nested: boolean,
): Block | null {
  const r = asRecord(raw);
  let type: unknown;
  let body: Record<string, unknown>;
  if (r && isBlockType(r.type) && Object.keys(r).every((k) => ['type', 'data', 'options', 'tabs'].includes(k))) {
    // Normalized form (what the dashboard PUTs): {type, data?, options?, tabs?}.
    type = r.type;
    body = { ...(asRecord(r.options) ?? {}) };
    if (r.data !== undefined) body.data = r.data;
    if (r.tabs !== undefined) body.tabs = r.tabs;
  } else if (r && Object.keys(r).length === 1) {
    // File form: `- line: {data: x, area: true}`.
    type = Object.keys(r)[0];
    const value = r[type as string];
    if (typeof value === 'string' && (type === 'text' || type === 'callout')) body = { markdown: value };
    else body = { ...(asRecord(value) ?? {}) };
    if (value !== null && value !== undefined && typeof value !== 'string' && !asRecord(value)) {
      problem(ctx, card.id, path, `the ${String(type)} block's settings must be a mapping (got ${show(value)}).`, `write - ${String(type)}: {option: value}.`);
    }
  } else {
    problem(ctx, card.id, path, `a block must be one "<type>: {options}" entry (got ${show(raw)}).`, 'write e.g. - line: {data: my-insight}.');
    return null;
  }
  if (!isBlockType(type)) {
    problem(ctx, card.id, path, `unknown block type "${String(type)}".`, `use one of ${Object.keys(BLOCK_CATALOG).join(', ')} (see \`dreamcontext lab block list\`).`);
    return null;
  }
  const entry = BLOCK_CATALOG[type];
  const bpath = `${path}.${type}`;
  const block: Block = { type, options: {} };

  // data
  const data = body.data;
  delete body.data;
  if (entry.data === 'binding') {
    if (typeof data !== 'string' || !parseDataRef(data)) {
      problem(ctx, card.id, `${bpath}.data`, data === undefined ? 'is required.' : `${show(data)} is not a safe "<insight>" or "<insight>/<dataset>" binding.`, 'set data to a kebab-case insight slug, optionally /<datasetKey>.');
      if (typeof data === 'string') block.data = data; // lenient: kept, resolves to an unsafe-ref frame
    } else {
      block.data = data.trim();
      checkInsightRef(ctx, card.id, `${bpath}.data`, block.data);
    }
  } else if (entry.data === 'insight') {
    if (data !== undefined) {
      const parsed = parseDataRef(data);
      if (!parsed || parsed.dataset !== null) {
        problem(ctx, card.id, `${bpath}.data`, `${show(data)} is not an insight slug.`, 'set data to a kebab-case insight slug, or drop it to use the card insight.');
      } else {
        block.data = parsed.insight;
        checkInsightRef(ctx, card.id, `${bpath}.data`, block.data);
      }
    }
    if (block.data === undefined && !card.insight) {
      problem(ctx, card.id, `${bpath}.data`, 'has no insight to render (no data and no card insight).', 'set data: <insight> on the block or insight: <insight> on the card.');
    }
  } else if (data !== undefined) {
    problem(ctx, card.id, `${bpath}.data`, `${type} blocks take no data.`, entry.data === 'inputs' ? 'bind data through inputs: {name: <insight>}.' : 'remove data.');
  }

  // tabs (structure, one level)
  const tabsRaw = body.tabs;
  delete body.tabs;
  if (type === 'tabs') {
    if (nested) {
      problem(ctx, card.id, bpath, 'tabs do not nest.', 'move the inner tabs block out to the card, or flatten its blocks.');
      return null;
    }
    if (!Array.isArray(tabsRaw) || tabsRaw.length === 0) {
      problem(ctx, card.id, `${bpath}.tabs`, 'needs at least one tab.', 'write tabs: [{label: Overview, blocks: [...]}].');
    }
    const tabs: BlockTab[] = [];
    (Array.isArray(tabsRaw) ? tabsRaw : []).forEach((t, ti) => {
      const tr = asRecord(t);
      const tpath = `${bpath}.tabs[${ti}]`;
      if (!tr || typeof tr.label !== 'string' || !tr.label.trim()) {
        problem(ctx, card.id, `${tpath}.label`, 'a tab needs a label.', 'add label: <name> to the tab.');
        if (!tr) return;
      }
      if (tr.blocks !== undefined && !Array.isArray(tr.blocks)) {
        problem(ctx, card.id, `${tpath}.blocks`, 'must be a list of blocks.', 'write blocks: [- text: ...].');
      }
      const blocks = (Array.isArray(tr.blocks) ? tr.blocks : [])
        .map((b, bi) => walkBlock(ctx, b, `${tpath}.blocks[${bi}]`, card, true))
        .filter((b): b is Block => b !== null);
      tabs.push({ label: typeof tr.label === 'string' && tr.label.trim() ? tr.label.trim() : `Tab ${ti + 1}`, blocks });
    });
    block.tabs = tabs;
  } else if (tabsRaw !== undefined) {
    problem(ctx, card.id, `${bpath}.tabs`, `only tabs blocks take tabs.`, 'remove tabs.');
  }

  // options
  const known = new Map(entry.options.filter((o) => o.type !== 'tabs').map((o) => [o.key, o]));
  for (const [key, value] of Object.entries(body)) {
    const schema = known.get(key);
    if (!schema) {
      problem(ctx, card.id, `${bpath}.${key}`, `unknown option "${key}" for ${type}.`, known.size > 0 ? `use one of ${[...known.keys()].join(', ')}.` : `${type} takes no options; remove it.`);
      continue;
    }
    if (value === null || value === undefined) continue;
    const p = optionProblem(schema, value);
    if (p) {
      problem(ctx, card.id, `${bpath}.${key}`, p.message, p.fix);
      continue;
    }
    block.options[key] = value;
  }

  // block-specific rules
  if (type === 'html') {
    const hasHtml = typeof block.options.html === 'string' && block.options.html.trim() !== '';
    const ref = block.options.ref;
    if (hasHtml === (ref !== undefined)) {
      problem(ctx, card.id, bpath, 'needs exactly one of html (inline markup) or ref (a library block).', 'keep html: | ... or ref: <library-slug>, not both.');
    }
    if (ref !== undefined) {
      if (typeof ref !== 'string' || !isSafeInsightSlug(ref)) {
        problem(ctx, card.id, `${bpath}.ref`, `${show(ref)} is not a safe library slug.`, 'use the kebab-case slug of a lab/blocks/<slug>.md entry.');
        delete block.options.ref;
      } else if (ctx.blockExists && !ctx.blockExists(ref)) {
        warn(ctx, card.id, `${bpath}.ref`, `library block "${ref}" does not exist.`, `save it with \`dreamcontext lab block save ${ref} --file <html>\`.`);
      }
    }
    const inputs = asRecord(block.options.inputs);
    if (inputs) for (const [name, ref2] of Object.entries(inputs)) checkInsightRef(ctx, card.id, `${bpath}.inputs.${name}`, String(ref2));
  }
  if (type === 'filter' && (typeof block.options.dim !== 'string' || !block.options.dim.trim())) {
    problem(ctx, card.id, `${bpath}.dim`, 'is required.', 'set dim to the dimension key whose values become the chips.');
  }
  return block;
}

const CARD_KEYS = ['id', 'at', 'title', 'insight', 'blocks'];
const ROOT_KEYS = ['title', 'titleKey', 'order', 'cards'];
/** Board metadata a client may echo back; ignored, never written. */
const IGNORED_ROOT_KEYS = ['slug', 'rev', 'derived', 'error', 'warnings', 'body'];

function walkSpec(ctx: WalkCtx, raw: unknown, slug: string, body: string): BoardSpec {
  const root = asRecord(raw);
  if (!root) {
    problem(ctx, null, 'board', `the board spec must be a mapping (got ${show(raw)}).`, 'write title: and cards: at the top level.');
    return { title: slug, order: 0, cards: [], body };
  }
  for (const key of Object.keys(root)) {
    if (!ROOT_KEYS.includes(key) && !IGNORED_ROOT_KEYS.includes(key)) {
      problem(ctx, null, key, `unknown board field "${key}".`, `remove it; a board has ${ROOT_KEYS.join(', ')}.`);
    }
  }
  let title = slug;
  if (typeof root.title === 'string' && root.title.trim()) title = root.title.trim();
  else problem(ctx, null, 'title', 'is required.', 'add title: <board name>.');
  let order = 0;
  if (root.order !== undefined) {
    if (typeof root.order === 'number' && Number.isInteger(root.order)) order = root.order;
    else problem(ctx, null, 'order', `must be a whole number (got ${show(root.order)}).`, 'set order: 1 (boards sort by order, then slug).');
  }
  const spec: BoardSpec = { title, order, cards: [], body };
  if (typeof root.titleKey === 'string' && root.titleKey.trim()) spec.titleKey = root.titleKey.trim();

  if (root.cards !== undefined && !Array.isArray(root.cards)) {
    problem(ctx, null, 'cards', 'must be a list.', 'write cards: [] or a list of - id: ... entries.');
  }
  const rawCards = Array.isArray(root.cards) ? root.cards : [];
  const ids = new Set<string>();
  rawCards.forEach((rawCard, i) => {
    const path = `cards[${i}]`;
    const c = asRecord(rawCard);
    if (!c) {
      problem(ctx, null, path, `a card must be a mapping (got ${show(rawCard)}).`, 'write - id: c-my-card with at: and insight: or blocks:.');
      return;
    }
    // id
    let id = typeof c.id === 'string' ? c.id.trim() : '';
    if (!CARD_ID_RE.test(id)) {
      problem(ctx, id || null, `${path}.id`, `${show(c.id)} is not a valid card id.`, 'use a kebab-case id, e.g. c-<insight-slug>.');
      id = `card-${i + 1}`;
    }
    if (ids.has(id)) {
      const original = id;
      let n = 2;
      while (ids.has(`${original}-${n}`)) n++;
      problem(ctx, original, `${path}.id`, `duplicate card id "${original}".`, `rename it, e.g. to "${original}-${n}".`);
      id = `${original}-${n}`;
    }
    ids.add(id);
    for (const key of Object.keys(c)) {
      if (!CARD_KEYS.includes(key)) problem(ctx, id, `${path}.${key}`, `unknown card field "${key}".`, `remove it; a card has ${CARD_KEYS.join(', ')}.`);
    }
    // at
    const clamped = clampRect(c.at);
    const atRaw = asRecord(c.at);
    const exact = atRaw ? { x: atRaw.x, y: atRaw.y, w: atRaw.w, h: atRaw.h } as unknown as GridRect : null;
    if (!exact || !isValidRect(exact)) {
      problem(ctx, id, `${path}.at`, `${show(c.at)} is not a legal grid position (12 columns: w 1..12, x 0..12-w, h 1..24, whole numbers).`, `set at: {x: ${clamped.x}, y: ${clamped.y}, w: ${clamped.w}, h: ${clamped.h}}.`);
    }
    const card: Card = { id, at: clamped };
    if (c.title !== undefined && c.title !== null) {
      if (typeof c.title === 'string') card.title = c.title;
      else problem(ctx, id, `${path}.title`, `must be text (got ${show(c.title)}).`, 'quote the title.');
    }
    if (c.insight !== undefined && c.insight !== null) {
      if (typeof c.insight === 'string' && isSafeInsightSlug(c.insight.trim())) {
        card.insight = c.insight.trim();
        checkInsightRef(ctx, id, `${path}.insight`, card.insight);
      } else {
        problem(ctx, id, `${path}.insight`, `${show(c.insight)} is not a kebab-case insight slug.`, 'set insight to an existing insight slug.');
      }
    }
    if (c.blocks !== undefined && c.blocks !== null) {
      if (!Array.isArray(c.blocks)) {
        problem(ctx, id, `${path}.blocks`, 'must be a list of blocks.', 'write blocks: [- stat: {data: <insight>}].');
      } else {
        card.blocks = c.blocks
          .map((b, bi) => walkBlock(ctx, b, `${path}.blocks[${bi}]`, card, false))
          .filter((b): b is Block => b !== null);
      }
    }
    if (!card.insight && (!card.blocks || card.blocks.length === 0)) {
      problem(ctx, id, path, 'has neither an insight nor blocks, so it has nothing to show.', 'add insight: <slug> or at least one block.');
      if (!ctx.strict) return;
    }
    spec.cards.push(card);
  });

  const overlaps = findOverlaps(spec.cards);
  if (overlaps.length > 0) {
    if (ctx.strict) {
      for (const [a, b] of overlaps) {
        const i = spec.cards.findIndex((c) => c.id === b);
        problem(ctx, b, `cards[${i}].at`, `overlaps card "${a}".`, `move "${b}" below "${a}" or make one of them narrower.`);
      }
    } else {
      const resolved = resolveOverlaps(spec.cards);
      resolved.forEach((card, i) => {
        if (card.at.y !== spec.cards[i].at.y) {
          warn(ctx, card.id, `cards[${i}].at`, 'overlapped another card; shown moved down.', 'save the board to keep the new position.');
        }
      });
      spec.cards = resolved;
    }
  }
  return spec;
}

export interface ValidateOptions {
  /** When given, missing insights / library blocks become warnings. */
  contextRoot?: string;
  body?: string;
}

export interface BoardValidation {
  ok: boolean;
  spec: BoardSpec;
  errors: BoardDiagnostic[];
  warnings: BoardDiagnostic[];
}

function existsCheckers(contextRoot: string | undefined): Pick<WalkCtx, 'insightExists' | 'blockExists'> {
  if (!contextRoot) return { insightExists: null, blockExists: null };
  return {
    insightExists: (slug) => resolveContainedLabFile(contextRoot, 'insight', slug) !== null,
    blockExists: (slug) => getLibraryBlock(contextRoot, slug) !== null,
  };
}

/** STRICT validation (writes, `lab board set/validate`). Accepts the file form and the normalized form. */
export function validateBoardSpec(raw: unknown, slug: string, opts: ValidateOptions = {}): BoardValidation {
  const ctx: WalkCtx = { strict: true, errors: [], warnings: [], ...existsCheckers(opts.contextRoot) };
  const body = typeof opts.body === 'string' ? opts.body : typeof asRecord(raw)?.body === 'string' ? String(asRecord(raw)!.body) : '';
  const spec = walkSpec(ctx, raw, slug, body);
  return { ok: ctx.errors.length === 0, spec, errors: ctx.errors, warnings: ctx.warnings };
}

/** LENIENT normalization (reads): never throws, repairs are warnings. */
export function readBoardSpec(raw: unknown, slug: string, opts: ValidateOptions = {}): { spec: BoardSpec; warnings: BoardDiagnostic[] } {
  const ctx: WalkCtx = { strict: false, errors: [], warnings: [], ...existsCheckers(opts.contextRoot) };
  const spec = walkSpec(ctx, raw, slug, opts.body ?? '');
  return { spec, warnings: ctx.warnings };
}

// ─── Serialization ──────────────────────────────────────────────────────────

function blockToFile(block: Block): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  if (block.data !== undefined) value.data = block.data;
  Object.assign(value, block.options);
  if (block.tabs) value.tabs = block.tabs.map((t) => ({ label: t.label, blocks: t.blocks.map(blockToFile) }));
  return { [block.type]: value };
}

/** The frontmatter object a spec is written as (the file form). */
export function boardSpecToFile(spec: BoardSpec): Record<string, unknown> {
  const out: Record<string, unknown> = { title: spec.title };
  if (spec.titleKey) out.titleKey = spec.titleKey;
  out.order = spec.order;
  out.cards = spec.cards.map((card) => {
    const c: Record<string, unknown> = { id: card.id, at: { x: card.at.x, y: card.at.y, w: card.at.w, h: card.at.h } };
    if (card.title !== undefined) c.title = card.title;
    if (card.insight !== undefined) c.insight = card.insight;
    if (card.blocks !== undefined) c.blocks = card.blocks.map(blockToFile);
    return c;
  });
  return out;
}

export function serializeBoardSpec(spec: BoardSpec): string {
  return stringifySafeFrontmatter(boardSpecToFile(spec), spec.body);
}

// ─── Reads ──────────────────────────────────────────────────────────────────

const CONFLICT_RE = /^(<{7}|>{7})(\s|$)|^={7}\s*$/m;

function errorBoard(slug: string, text: string, kind: BoardError['kind'], message: string): Board {
  return {
    slug,
    title: slug,
    order: ERROR_BOARD_ORDER,
    cards: [],
    body: '',
    rev: revOf(text),
    derived: false,
    error: { kind, message },
    warnings: [],
  };
}

/** Parse one board file's text. Conflict markers or unparseable YAML -> an error board. */
export function parseBoardText(slug: string, text: string, contextRoot?: string): Board {
  if (CONFLICT_RE.test(text)) {
    return errorBoard(slug, text, 'conflict', 'The board file has unresolved merge conflict markers.');
  }
  let parsed: { data: Record<string, unknown>; content: string };
  try {
    parsed = parseSafeFrontmatter(text);
  } catch (err) {
    return errorBoard(slug, text, 'parse', err instanceof Error ? err.message.split('\n')[0] : String(err));
  }
  const { spec, warnings } = readBoardSpec(parsed.data, slug, { contextRoot, body: parsed.content.trim() });
  return { ...spec, slug, rev: revOf(text), derived: false, error: null, warnings };
}

/** A materialized board file, read through the contained-path gate. */
export function readBoardFile(contextRoot: string, slug: string): Board | null {
  const path = resolveContainedLabFile(contextRoot, 'board', slug);
  if (!path) return null;
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
  return parseBoardText(slug, text, contextRoot);
}

function sortBoards<T extends { order: number; slug: string }>(boards: T[]): T[] {
  return boards.sort((a, b) => a.order - b.order || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

function derivedAsBoards(contextRoot: string): Board[] {
  return deriveBoards(contextRoot).map(({ slug, spec }) => ({
    ...spec,
    slug,
    rev: revOf(serializeBoardSpec(spec)),
    derived: true,
    error: null,
    warnings: [],
  }));
}

/** Every board: the files when materialized, else the derivation. Nothing is written. */
export function listBoards(contextRoot: string): { boards: Board[]; derived: boolean } {
  if (!isMaterialized(contextRoot)) return { boards: derivedAsBoards(contextRoot), derived: true };
  const boards = boardFileSlugs(contextRoot)
    .map((slug) => readBoardFile(contextRoot, slug))
    .filter((b): b is Board => b !== null);
  return { boards: sortBoards(boards), derived: false };
}

export function getBoard(contextRoot: string, slug: string): Board | null {
  if (!isSafeInsightSlug(slug)) return null;
  if (isMaterialized(contextRoot)) return readBoardFile(contextRoot, slug);
  return derivedAsBoards(contextRoot).find((b) => b.slug === slug) ?? null;
}

/** Every insight slug a board references (card insight, block data, html inputs, tabs). */
export function boardInsightSlugs(board: Pick<BoardSpec, 'cards'>): string[] {
  const out = new Set<string>();
  const visit = (blocks: readonly Block[] | undefined): void => {
    for (const b of blocks ?? []) {
      const ref = b.data !== undefined ? parseDataRef(b.data) : null;
      if (ref) out.add(ref.insight);
      const inputs = asRecord(b.options.inputs);
      if (inputs) for (const v of Object.values(inputs)) { const r = parseDataRef(v); if (r) out.add(r.insight); }
      for (const t of b.tabs ?? []) visit(t.blocks);
    }
  };
  for (const card of board.cards) {
    if (card.insight) out.add(card.insight);
    visit(card.blocks);
  }
  return [...out].sort();
}

/** Insights on no board. Always empty while boards are derived (derivation places everything). */
export function unplacedInsights(contextRoot: string, boards: readonly Board[]): string[] {
  const placed = new Set(boards.flatMap((b) => boardInsightSlugs(b)));
  return listInsights(contextRoot).map((m) => m.slug).filter((s) => !placed.has(s));
}

// ─── Derivation from the legacy category/group board ────────────────────────

/** The legacy fields derivation reads (a manifest satisfies it). */
export type LegacyInsight = Pick<InsightManifest, 'slug' | 'title' | 'category' | 'group' | 'render' | 'size' | 'width' | 'height'> & {
  /** The cache carries an html/v1 body (drawn in a sandboxed cell, default h 6). */
  hasHtmlBody?: boolean;
};

/** The subset of `state/.lab-prefs.json` derivation honours. */
export interface LegacyLabPrefs {
  order?: Record<string, string[]>;
  catOrder?: string[];
}

export interface DerivedBoard {
  slug: string;
  spec: BoardSpec;
}

const OTHER = 'Other';
const UNGROUPED = 'Ungrouped';
const HEIGHT_ROWS: Record<string, number> = { s: 3, m: 4, l: 6, xl: 8 };

const TURKISH_FOLD: Record<string, string> = {
  ç: 'c', Ç: 'c', ğ: 'g', Ğ: 'g', ı: 'i', İ: 'i', ö: 'o', Ö: 'o', ş: 's', Ş: 's', ü: 'u', Ü: 'u',
  ß: 'ss', æ: 'ae', Æ: 'ae', ø: 'o', Ø: 'o', đ: 'd', Đ: 'd', ł: 'l', Ł: 'l',
};

/** ASCII kebab slug of a title (Turkish folded, diacritics stripped, <= 60 chars). '' when nothing survives. */
export function slugifyTitle(title: string): string {
  const folded = title.replace(/[çÇğĞıİöÖşŞüÜßæÆøØđĐłŁ]/g, (c) => TURKISH_FOLD[c] ?? c);
  const ascii = folded.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  return ascii.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '');
}

/**
 * Deterministic distinct slugs for `titles`, assigned in the order given: the
 * title's slug, `-2`, `-3`... on a collision, `<fallback>-<n>` (1-based
 * position) when the title has no ASCII left.
 */
export function dedupeSlugs(titles: readonly string[], fallback: string): string[] {
  const used = new Set<string>();
  return titles.map((title, i) => {
    const base = slugifyTitle(title) || `${fallback}-${i + 1}`;
    let slug = base;
    for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`;
    used.add(slug);
    return slug;
  });
}

function legacyWidth(m: LegacyInsight): number {
  const span = m.width === 1 || m.width === 2 || m.width === 3
    ? m.width
    : m.size === 'l' ? 2 : m.size === 's' || m.size === 'm' ? 1 : RENDER_DEFAULT_SPAN[m.render] ?? 1;
  return (span * GRID_COLUMNS) / 3;
}

function legacyHeight(m: LegacyInsight): number {
  if (m.height && HEIGHT_ROWS[m.height]) return HEIGHT_ROWS[m.height];
  if (m.size === 's') return HEIGHT_ROWS.s;
  if (m.size === 'l') return HEIGHT_ROWS.l;
  if (m.render === 'app' || m.hasHtmlBody) return 6;
  return HEIGHT_ROWS.m;
}

/** Listed keys first in listed order, the rest after in their existing order. */
function applyListOrder<T>(items: T[], keyOf: (t: T) => string, order: readonly string[] | undefined): T[] {
  if (!order || order.length === 0) return items;
  const pos = new Map(order.map((k, i) => [k, i]));
  return items
    .map((item, idx) => ({ item, key: pos.get(keyOf(item)) ?? order.length + idx }))
    .sort((a, b) => a.key - b.key)
    .map((e) => e.item);
}

/**
 * The boards a legacy vault opens with (PURE: no reads, no writes): one board
 * per manifest `category` (uncategorized -> "Other"; no category anywhere ->
 * one "Insights" board), board order from `catOrder`, each `group` a
 * full-width text heading (w 12, h 1) followed by its cards in `order[...]`
 * order, width 1/2/3 -> w 4/8/12, height s/m/l/xl -> h 3/4/6/8.
 *
 * Ids are deterministic across machines: card `c-<insight>`, heading
 * `h-<boardSlug>-<groupSlug>`; board slugs are deduped in SORTED category
 * order, never prefs order, so two machines with different prefs derive the
 * same slugs and ids.
 */
export function deriveBoardsFromLegacy(insights: readonly LegacyInsight[], prefs: LegacyLabPrefs = {}): DerivedBoard[] {
  if (insights.length === 0) return [];
  const sorted = [...insights].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const byCat = new Map<string, LegacyInsight[]>();
  for (const m of sorted) {
    const key = m.category ?? OTHER;
    const bucket = byCat.get(key);
    if (bucket) bucket.push(m);
    else byCat.set(key, [m]);
  }
  const named = [...byCat.keys()].filter((k) => k !== OTHER).sort();
  const noCategories = named.length === 0;

  // Slugs: assigned over the SORTED category keys (machine independent).
  const sortedKeys = [...byCat.keys()].sort();
  const slugList = noCategories ? ['insights'] : dedupeSlugs(sortedKeys, 'board');
  const slugOf = new Map(sortedKeys.map((k, i) => [k, slugList[i]]));

  // Display order: named alphabetical, Other last, then the saved tab order.
  const defaultOrder = byCat.has(OTHER) && !noCategories ? [...named, OTHER] : noCategories ? [OTHER] : named;
  const ordered = applyListOrder(defaultOrder, (k) => k, prefs.catOrder);

  return ordered.map((cat, boardIdx) => {
    const boardSlug = slugOf.get(cat)!;
    const items = byCat.get(cat)!;
    const keyPrefix = cat === OTHER ? null : cat;

    const byGroup = new Map<string, LegacyInsight[]>();
    for (const m of items) {
      const g = m.group ?? UNGROUPED;
      const bucket = byGroup.get(g);
      if (bucket) bucket.push(m);
      else byGroup.set(g, [m]);
    }
    const namedGroups = [...byGroup.keys()].filter((g) => g !== UNGROUPED).sort();
    const groups = byGroup.has(UNGROUPED) ? [...namedGroups, UNGROUPED] : namedGroups;
    const groupSlugs = dedupeSlugs(groups, 'group');

    const cards: Card[] = [];
    let y = 0;
    groups.forEach((group, gi) => {
      if (namedGroups.length > 0) {
        cards.push({
          id: `h-${boardSlug}-${groupSlugs[gi]}`,
          at: { x: 0, y, w: GRID_COLUMNS, h: 1 },
          blocks: [{ type: 'text', options: { markdown: `### ${group}` } }],
        });
        y += 1;
      }
      const sectionKey = keyPrefix ? `${keyPrefix} / ${group}` : group;
      const members = applyListOrder(byGroup.get(group)!, (m) => m.slug, prefs.order?.[sectionKey]);
      let x = 0;
      let rowH = 0;
      for (const m of members) {
        const w = legacyWidth(m);
        const h = legacyHeight(m);
        if (x + w > GRID_COLUMNS) {
          y += rowH;
          x = 0;
          rowH = 0;
        }
        cards.push({ id: `c-${m.slug}`, at: { x, y, w, h }, insight: m.slug });
        x += w;
        rowH = Math.max(rowH, h);
      }
      y += rowH;
    });

    const spec: BoardSpec = {
      title: noCategories ? 'Insights' : cat,
      order: boardIdx + 1,
      cards,
      body: '',
    };
    if (noCategories) spec.titleKey = 'lab.board.insights';
    else if (cat === OTHER) spec.titleKey = 'lab.board.other';
    return { slug: boardSlug, spec };
  });
}

/** `state/.lab-prefs.json`, leniently (absent or malformed = no opinion). */
export function readLegacyLabPrefs(contextRoot: string): LegacyLabPrefs {
  try {
    const raw = JSON.parse(readFileSync(join(contextRoot, 'state', '.lab-prefs.json'), 'utf-8'));
    const r = asRecord(raw);
    if (!r) return {};
    const out: LegacyLabPrefs = {};
    const order = asRecord(r.order);
    if (order) {
      out.order = {};
      for (const [k, v] of Object.entries(order)) {
        if (Array.isArray(v)) out.order[k] = v.filter((s): s is string => typeof s === 'string');
      }
    }
    if (Array.isArray(r.catOrder)) out.catOrder = r.catOrder.filter((s): s is string => typeof s === 'string');
    return out;
  } catch {
    return {};
  }
}

/** The derivation for this vault: manifests + prefs (+ html/v1 detection on script insights). */
export function deriveBoards(contextRoot: string): DerivedBoard[] {
  const insights: LegacyInsight[] = listInsights(contextRoot).map((m) => ({
    slug: m.slug,
    title: m.title,
    category: m.category,
    group: m.group,
    render: m.render,
    size: m.size,
    width: m.width,
    height: m.height,
    // html/v1 bodies only ever come from script adapters; skip the cache read otherwise.
    hasHtmlBody: m.source?.adapter === 'script' && m.render !== 'app'
      ? typeof readCache(contextRoot, m.slug)?.html === 'string'
      : false,
  }));
  return deriveBoardsFromLegacy(insights, readLegacyLabPrefs(contextRoot));
}

// ─── Lock ───────────────────────────────────────────────────────────────────

/**
 * Run `fn` holding the shared board lock (`state/.locks/lab-boards.lock`,
 * PID-verified, 30 s stale). Waits up to `waitMs` (default 2 s), then throws
 * `busy` (503 at the route). The lock is released in a `finally` around the
 * whole async body.
 */
export async function withBoardsLock<T>(contextRoot: string, fn: () => T | Promise<T>, waitMs = 2000): Promise<T> {
  const lockPath = boardsLockPath(contextRoot);
  const deadline = Date.now() + Math.max(0, waitMs);
  for (;;) {
    if (acquireFileLock(lockPath, Date.now(), LOCK_STALE_MS, { verifyPidLiveness: true })) break;
    if (Date.now() >= deadline) throw new BoardStoreError('busy', 'The boards are being written by another process; try again.');
    await new Promise((r) => { setTimeout(r, 25); });
  }
  try {
    return await fn();
  } finally {
    releaseFileLock(lockPath);
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code !== 'ESRCH';
  }
}

/**
 * Remove `lab/.boards-staging-<pid>-*` dirs whose pid is dead (a crashed
 * materialize). Runs only when the board lock is free right now (never waits).
 * Returns how many were removed.
 */
export function sweepBoardStaging(contextRoot: string): number {
  const dir = labDir(contextRoot);
  if (!existsSync(dir)) return 0;
  const lockPath = boardsLockPath(contextRoot);
  if (!acquireFileLock(lockPath, Date.now(), LOCK_STALE_MS, { verifyPidLiveness: true })) return 0;
  let removed = 0;
  try {
    for (const name of readdirSync(dir)) {
      const m = STAGING_RE.exec(name);
      if (!m) continue;
      const pid = Number(m[1]);
      if (pid === process.pid || pidAlive(pid)) continue;
      rmSync(join(dir, name), { recursive: true, force: true });
      removed++;
    }
  } finally {
    releaseFileLock(lockPath);
  }
  return removed;
}

// ─── Writes ─────────────────────────────────────────────────────────────────

/** Returns the next spec for the board, or null to delete it. `current` is null when it does not exist. */
export type BoardEdit = (current: Board | null) => unknown | null;

export interface BoardWriteOptions {
  /** The rev the caller last saw; null = the board must not exist yet; undefined = no check. */
  expectedRev?: string | null;
  /** Lock wait (ms). */
  waitMs?: number;
  /** Test seams: fault injection around the materialize rename. */
  hooks?: {
    afterStagingFile?: (slug: string, stagingDir: string) => void;
    afterStrayMove?: (name: string, stagingDir: string) => void;
    beforeRename?: (stagingDir: string) => void;
  };
}

function checkRev(slug: string, current: Board | null, expectedRev: string | null | undefined): void {
  if (expectedRev === undefined) return;
  const rev = current ? current.rev : null;
  if (rev !== expectedRev) {
    throw new BoardStoreError(
      rev === null ? 'not-found' : 'rev-conflict',
      rev === null ? `Board "${slug}" does not exist.` : `Board "${slug}" changed elsewhere (rev ${rev}, expected ${expectedRev ?? 'none'}); reload and retry.`,
    );
  }
}

/** Strict-validate an edit's result. Returns the normalized spec (null = delete). */
function validated(contextRoot: string, slug: string, next: unknown): BoardSpec | null {
  if (next === null) return null;
  const body = typeof asRecord(next)?.body === 'string' ? String(asRecord(next)!.body) : '';
  const v = validateBoardSpec(next, slug, { contextRoot, body });
  if (!v.ok) {
    throw new BoardStoreError('invalid', `Board "${slug}" is invalid:\n- ${v.errors.map(formatDiagnostic).join('\n- ')}`, v.errors);
  }
  return v.spec;
}

function isRenameCollision(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === 'ENOTEMPTY' || code === 'EEXIST';
}

/**
 * Materialize every derived board with `slug` edited, in one rename.
 * Returns 'lost' when another writer materialized first (the caller re-reads
 * and re-applies), else the written board.
 */
function materializeWithEdit(
  contextRoot: string,
  slug: string,
  edit: BoardEdit,
  opts: BoardWriteOptions,
): Board | null | 'lost' {
  const derived = derivedAsBoards(contextRoot);
  const current = derived.find((b) => b.slug === slug) ?? null;
  checkRev(slug, current, opts.expectedRev);
  const next = validated(contextRoot, slug, edit(current));

  const files = new Map<string, string>();
  for (const b of derived) files.set(b.slug, serializeBoardSpec(b));
  if (next) files.set(slug, serializeBoardSpec(next));
  else files.delete(slug);

  const lab = ensureContainedLabDir(contextRoot, '');
  const staging = join(lab, `${STAGING_PREFIX}${process.pid}-${randomBytes(6).toString('hex')}`);
  const target = boardsDir(contextRoot);
  // Entries of a board-less lab/boards/ (.gitkeep, .DS_Store, a non-kebab .md):
  // carried through staging so ONE rename still makes every board live at once.
  const strays: string[] = [];
  let committed = false;
  try {
    mkdirSync(staging);
    for (const [s, text] of files) {
      writeFileSync(join(staging, `${s}.md`), text, 'utf-8');
      opts.hooks?.afterStagingFile?.(s, staging);
    }
    if (existsSync(target)) {
      for (const name of readdirSync(target)) {
        renameSync(join(target, name), join(staging, name));
        strays.push(name);
        opts.hooks?.afterStrayMove?.(name, staging);
      }
    }
    opts.hooks?.beforeRename?.(staging);
    try {
      if (existsSync(target)) rmdirSync(target); // empty unless another writer just filled it
      renameSync(staging, target);
      committed = true;
    } catch (err) {
      if (isRenameCollision(err)) return 'lost';
      throw err;
    }
  } finally {
    let restored = true;
    if (!committed && strays.length > 0) {
      try {
        restoreStrays(staging, target, strays);
      } catch {
        restored = false; // leave staging in place rather than delete the user's files
      }
    }
    if (restored) rmSync(staging, { recursive: true, force: true });
  }
  return next ? readBoardFile(contextRoot, slug) : null;
}

/** Put a failed materialize's carried entries back into lab/boards/, never clobbering a file there. */
function restoreStrays(staging: string, target: string, strays: readonly string[]): void {
  mkdirSync(target, { recursive: true });
  for (const name of strays) {
    const from = join(staging, name);
    if (!existsSync(from)) continue;
    const to = existsSync(join(target, name)) ? join(target, `${name}.stray-${process.pid}`) : join(target, name);
    renameSync(from, to);
  }
}

/**
 * THE board write. Under the shared lock: materialize-all if needed (atomic,
 * with the edit applied), else read the current file, refuse an error board
 * (423), rev-check (409), strict-validate (400) and write atomically.
 * Returns the written board, or null when the edit deleted it.
 */
export async function editBoard(
  contextRoot: string,
  slug: string,
  edit: BoardEdit,
  opts: BoardWriteOptions = {},
): Promise<Board | null> {
  if (!isSafeInsightSlug(slug)) {
    throw new BoardStoreError('invalid', `Invalid board slug "${slug}": use kebab-case.`, [
      { cardId: null, path: 'slug', message: `"${slug}" is not kebab-case.`, fix: 'use e.g. growth or board-2.' },
    ]);
  }
  return withBoardsLock(contextRoot, () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!isMaterialized(contextRoot)) {
        const result = materializeWithEdit(contextRoot, slug, edit, opts);
        if (result === 'lost') continue; // re-read the winner's files and re-apply
        return result;
      }
      const current = readBoardFile(contextRoot, slug);
      if (current?.error) {
        throw new BoardStoreError('error-board', `Board "${slug}" cannot be edited: ${current.error.message} Fix the file first.`);
      }
      checkRev(slug, current, opts.expectedRev);
      const next = validated(contextRoot, slug, edit(current));
      if (!next) {
        const path = resolveContainedLabFile(contextRoot, 'board', slug);
        if (path) unlinkSync(path);
        return null;
      }
      writeContainedLabFile(contextRoot, 'board', 'boards', slug, '.md', serializeBoardSpec(next));
      return readBoardFile(contextRoot, slug);
    }
    throw new BoardStoreError('busy', 'The boards kept changing while saving; try again.');
  }, opts.waitMs);
}

/** Replace a board's whole spec (PUT). `expectedRev` null = create. */
export function putBoard(contextRoot: string, slug: string, spec: unknown, opts: BoardWriteOptions = {}): Promise<Board | null> {
  return editBoard(contextRoot, slug, () => spec, opts);
}

/** Create an empty board after the last one. */
export async function createBoard(contextRoot: string, slug: string, title: string, opts: Omit<BoardWriteOptions, 'expectedRev'> = {}): Promise<Board> {
  const order = listBoards(contextRoot).boards.reduce((max, b) => (b.order < ERROR_BOARD_ORDER ? Math.max(max, b.order) : max), 0) + 1;
  const board = await editBoard(contextRoot, slug, (current) => {
    if (current) throw new BoardStoreError('exists', `Board "${slug}" already exists.`);
    return { title, order, cards: [] };
  }, opts);
  return board!;
}

/** Delete a board (materializes the others first when still derived). */
export async function deleteBoard(contextRoot: string, slug: string, opts: BoardWriteOptions = {}): Promise<void> {
  await editBoard(contextRoot, slug, (current) => {
    if (!current) throw new BoardStoreError('not-found', `Board "${slug}" does not exist.`);
    return null;
  }, opts);
}
