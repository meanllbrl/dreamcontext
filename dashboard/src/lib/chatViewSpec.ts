/**
 * The `dream-view` fence payload — one JSON object, discriminated by `type`, that an
 * assistant answer can ask the Chat view to render as a chart, a widget page, or a pinned
 * checklist. See `_dream_context/state/assets/chat-interactive-views-plan-v2.md` §1.2 for
 * the authored schemas and §1.3 for the cap table this module enforces.
 *
 * Pure and defensive by design: `parseViewBlock` runs on every streamed token via
 * `chatActions.ts`, so it NEVER throws, and it never lets a malformed payload blank a
 * message — a rejected block just yields `view: null` plus a human-readable notice. Every
 * cap breach is reported the same way: loud, never a silent truncation.
 *
 * No React, no CSS, no `api/client` — this file must stay importable by root vitest with a
 * `.js` specifier (see `tests/unit/chat-actions.test.ts`).
 */
import type { Series, SeriesPoint } from '../hooks/useLab';
import type { ChatAction } from '../components/sleepy/chat/chatActions';

// ---------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------

export const VIEW_TYPES = ['chart', 'page', 'checklist'] as const;
export type ChatViewType = typeof VIEW_TYPES[number];

export type ChatViewSpec = ChartViewSpec | PageViewSpec | ChecklistViewSpec;

export interface ChartViewSpec {
  type: 'chart';
  render: 'line' | 'pie' | 'number' | 'table' | 'funnel';
  title?: string;
  unit?: string | null;
  series: Series[];
}

export interface PageViewSpec {
  type: 'page';
  title?: string;
  subtitle?: string;
  body: PageWidget[];
}

export type PageWidget =
  | StackWidget | RailWidget | CardWidget | TableWidget | TextWidget | StatWidget | ImageWidget | DividerWidget;

export interface StackWidget { kind: 'stack'; title?: string; items: PageWidget[] }
export interface RailWidget { kind: 'rail'; title?: string; items: PageWidget[] }

export interface CardWidget {
  kind: 'card';
  title: string;
  subtitle?: string;
  image?: { src: string; alt: string };
  price?: { amount: string; note?: string };
  badges?: string[];
  specs?: { label: string; value: string }[];
  body?: string;
  actions?: ChatAction[];
}

/** The N-column comparison grid — new in rev. 2 (B8). Rows shorter than `headers` are
 *  padded with `''`; longer rows are truncated with a notice. */
export interface TableWidget { kind: 'table'; headers: string[]; rows: string[][]; caption?: string }

export interface TextWidget { kind: 'text'; text: string }
export interface StatWidget { kind: 'stat'; items: { value: string; label: string; note?: string }[] }
export interface ImageWidget { kind: 'image'; src: string; alt: string; caption?: string }
export interface DividerWidget { kind: 'divider'; label?: string }

export interface ChecklistViewSpec {
  type: 'checklist';
  id: string;
  title: string;
  intro?: string;
  submitLabel?: string;
  items: ChecklistItemSpec[];
}

export interface ChecklistItemSpec {
  id: string;
  text: string;
  hint?: string;
  wants?: 'note' | 'file' | 'secret';
}

// ---------------------------------------------------------------------------------------
// Caps (§1.3) — every breach here degrades loudly: the excess is dropped and a notice
// names what happened. Never a silent truncation.
// ---------------------------------------------------------------------------------------

export const MAX_VIEW_BYTES = 64 * 1024;
export const MAX_VIEWS_PER_MESSAGE = 4;
export const MAX_CHART_SERIES = 8;
export const MAX_CHART_POINTS = 365;
export const MAX_CHART_TOTAL_POINTS = 2000;
export const MAX_PAGE_WIDGETS = 60;
export const MAX_RAIL_ITEMS = 20;
export const MAX_PAGE_DEPTH = 2;
export const MAX_CARD_BADGES = 4;
export const MAX_CARD_SPECS = 8;
export const MAX_CARD_ACTIONS = 3;
export const MAX_TABLE_COLS = 8;
export const MAX_TABLE_ROWS = 50;
export const MAX_TABLE_CELL_CHARS = 120;
export const MAX_CHECKLIST_ITEMS = 40;

// ---------------------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** A trimmed, non-empty string capped at `maxLen`, or `null` for anything else — used for
 *  every optional/required string field that isn't given its own validation rule. */
function optStr(v: unknown, maxLen = Infinity): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t) return null;
  return t.length > maxLen ? t.slice(0, maxLen) : t;
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

// ---------------------------------------------------------------------------------------
// Remote image URLs (§1.15) — https-only, query + fragment stripped, credentials rejected.
// Stricter than the plan prose: the scheme is normalized before matching (so `HTTPS:`
// isn't missed), and every control character or whitespace byte is stripped from the WHOLE
// string — not just the ends — before that match runs. A tab or newline hidden inside
// `java\tscript:` is exactly the kind of obfuscation a naive scheme check would miss, and
// the browser strips those same bytes before it acts on the URL, so we have to see what it
// sees.
// ---------------------------------------------------------------------------------------

const CONTROL_OR_WHITESPACE_RE = /[\x00-\x20\x7f]/g;
const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

export function sanitizeImageSrc(raw: string): { src: string | null; strippedQuery: boolean } {
  if (typeof raw !== 'string') return { src: null, strippedQuery: false };

  const cleaned = raw.replace(CONTROL_OR_WHITESPACE_RE, '');
  if (!cleaned) return { src: null, strippedQuery: false };
  // Protocol-relative (`//host/x.png`) inherits whatever scheme the page is on — reject it
  // outright rather than trying to guess what it would resolve to.
  if (cleaned.startsWith('//')) return { src: null, strippedQuery: false };

  const schemeMatch = SCHEME_RE.exec(cleaned);
  if (!schemeMatch) {
    // No scheme at all — a project-relative path. Passed through unchanged.
    return { src: cleaned, strippedQuery: false };
  }

  if (schemeMatch[1].toLowerCase() !== 'https') return { src: null, strippedQuery: false };

  let url: URL;
  try {
    url = new URL(cleaned);
  } catch {
    return { src: null, strippedQuery: false };
  }
  // `https://user:pass@host/x.png` — reject embedded credentials outright.
  if (url.username || url.password) return { src: null, strippedQuery: false };

  const strippedQuery = url.search !== '' || url.hash !== '';
  url.search = '';
  url.hash = '';
  return { src: url.toString(), strippedQuery };
}

// ---------------------------------------------------------------------------------------
// type: "chart"
// ---------------------------------------------------------------------------------------

const CHART_RENDERS = new Set(['line', 'pie', 'number', 'table', 'funnel']);

function validatePoint(raw: unknown): SeriesPoint | null {
  if (!isRecord(raw)) return null;
  const t = optStr(raw.t, 40);
  const v = typeof raw.v === 'number' && Number.isFinite(raw.v) ? raw.v : null;
  return t && v !== null ? { t, v } : null;
}

function validateSeries(raw: unknown, notices: string[]): Series | null {
  if (!isRecord(raw)) return null;
  const name = optStr(raw.name, 60);
  if (!name) return null;

  const rawPoints = Array.isArray(raw.points) ? raw.points : [];
  let points = rawPoints.map(validatePoint).filter((p): p is SeriesPoint => p !== null);
  if (points.length === 0) return null;

  if (points.length > MAX_CHART_POINTS) {
    const extra = points.length - MAX_CHART_POINTS;
    points = points.slice(0, MAX_CHART_POINTS);
    notices.push(`Series "${name}" had more than ${MAX_CHART_POINTS} points — ${extra} were dropped.`);
  }
  return { name, points };
}

function validateChart(obj: Record<string, unknown>, notices: string[]): { view: ChatViewSpec | null; notices: string[] } {
  const render = typeof obj.render === 'string' ? obj.render : '';
  if (!CHART_RENDERS.has(render)) {
    notices.push(`This answer asked for a chart render type this app doesn't have (${JSON.stringify(obj.render ?? null)}).`);
    return { view: null, notices };
  }

  const rawSeries = Array.isArray(obj.series) ? obj.series : [];
  let series = rawSeries.map((s) => validateSeries(s, notices)).filter((s): s is Series => s !== null);
  if (series.length === 0) {
    notices.push('A chart was skipped — it has no valid series.');
    return { view: null, notices };
  }

  if (series.length > MAX_CHART_SERIES) {
    const extra = series.length - MAX_CHART_SERIES;
    series = series.slice(0, MAX_CHART_SERIES);
    notices.push(`A chart had more than ${MAX_CHART_SERIES} series — ${extra} were dropped.`);
  }

  // Enforced AFTER the per-series/per-point caps above, so a chart that only breaches the
  // total once already trimmed to the individual caps still gets the whole-block notice
  // rather than two overlapping ones.
  const totalPoints = series.reduce((n, s) => n + s.points.length, 0);
  if (totalPoints > MAX_CHART_TOTAL_POINTS) {
    notices.push(`A chart was skipped — it has ${totalPoints} points total across all series, over the ${MAX_CHART_TOTAL_POINTS} limit.`);
    return { view: null, notices };
  }

  const view: ChartViewSpec = { type: 'chart', render: render as ChartViewSpec['render'], series };
  const title = optStr(obj.title, 120);
  if (title) view.title = title;
  if (obj.unit === null) {
    view.unit = null;
  } else {
    const unit = optStr(obj.unit, 16);
    if (unit) view.unit = unit;
  }
  return { view, notices };
}

// ---------------------------------------------------------------------------------------
// type: "page"
// ---------------------------------------------------------------------------------------

type ContainerKind = 'stack' | 'rail';

/** Threaded through the whole widget tree so `MAX_PAGE_WIDGETS` counts every widget in the
 *  page, containers and leaves alike, not just the top-level list. A slot is only consumed
 *  for a widget that is otherwise fully valid — an invalid widget dropped for its own
 *  reasons (a card with no title, say) never eats into the budget a sibling could use. */
interface WidgetBudget { count: number; overflowDropped: number }

function takeBudget(budget: WidgetBudget): boolean {
  if (budget.count >= MAX_PAGE_WIDGETS) {
    budget.overflowDropped++;
    return false;
  }
  budget.count++;
  return true;
}

function validateCard(o: Record<string, unknown>, toAction: (raw: unknown) => ChatAction | null, notices: string[]): CardWidget | null {
  const title = optStr(o.title);
  if (!title) {
    notices.push('A card was dropped — it has no title.');
    return null;
  }
  const card: CardWidget = { kind: 'card', title };

  const subtitle = optStr(o.subtitle);
  if (subtitle) card.subtitle = subtitle;

  if (isRecord(o.image)) {
    const alt = optStr(o.image.alt);
    const srcRaw = typeof o.image.src === 'string' ? o.image.src : '';
    if (!alt || !srcRaw) {
      notices.push('A card image was dropped — it needs both "src" and "alt".');
    } else {
      const { src, strippedQuery } = sanitizeImageSrc(srcRaw);
      if (!src) {
        notices.push("A card image was dropped — its URL isn't allowed (https or a project-relative path only).");
      } else {
        card.image = { src, alt };
        if (strippedQuery) notices.push("An image URL's query string was removed — remote images can't carry parameters.");
      }
    }
  }

  if (isRecord(o.price)) {
    const amount = optStr(o.price.amount, 24);
    if (amount) {
      const price: NonNullable<CardWidget['price']> = { amount };
      const note = optStr(o.price.note);
      if (note) price.note = note;
      card.price = price;
    }
  }

  if (Array.isArray(o.badges)) {
    let badges = o.badges.filter((b): b is string => typeof b === 'string' && b.trim().length > 0).map((b) => b.trim());
    if (badges.length > MAX_CARD_BADGES) {
      const extra = badges.length - MAX_CARD_BADGES;
      badges = badges.slice(0, MAX_CARD_BADGES);
      notices.push(`A card had more than ${MAX_CARD_BADGES} badges — ${extra} were dropped.`);
    }
    if (badges.length) card.badges = badges;
  }

  if (Array.isArray(o.specs)) {
    let specs = o.specs
      .map((s) => {
        if (!isRecord(s)) return null;
        const label = optStr(s.label);
        const value = optStr(s.value);
        return label && value ? { label, value } : null;
      })
      .filter((s): s is { label: string; value: string } => s !== null);
    if (specs.length > MAX_CARD_SPECS) {
      const extra = specs.length - MAX_CARD_SPECS;
      specs = specs.slice(0, MAX_CARD_SPECS);
      notices.push(`A card had more than ${MAX_CARD_SPECS} specs — ${extra} were dropped.`);
    }
    if (specs.length) card.specs = specs;
  }

  const body = optStr(o.body);
  if (body) card.body = body;

  if (Array.isArray(o.actions)) {
    let actions = o.actions.map(toAction).filter((a): a is ChatAction => a !== null);
    if (actions.length > MAX_CARD_ACTIONS) {
      const extra = actions.length - MAX_CARD_ACTIONS;
      actions = actions.slice(0, MAX_CARD_ACTIONS);
      notices.push(`A card had more than ${MAX_CARD_ACTIONS} actions — ${extra} were dropped.`);
    }
    if (actions.length) card.actions = actions;
  }

  return card;
}

function clampCell(s: string, tooLong: { n: number }): string {
  if (s.length <= MAX_TABLE_CELL_CHARS) return s;
  tooLong.n++;
  return s.slice(0, MAX_TABLE_CELL_CHARS);
}

function validateTableWidget(o: Record<string, unknown>, notices: string[]): TableWidget | null {
  const tooLong = { n: 0 };

  let headers = Array.isArray(o.headers) ? o.headers.filter((h): h is string => typeof h === 'string') : [];
  if (headers.length > MAX_TABLE_COLS) {
    const extra = headers.length - MAX_TABLE_COLS;
    headers = headers.slice(0, MAX_TABLE_COLS);
    notices.push(`A table had more than ${MAX_TABLE_COLS} columns — ${extra} were dropped.`);
  }
  if (headers.length === 0) {
    notices.push('A table widget was dropped — it has no headers.');
    return null;
  }
  headers = headers.map((h) => clampCell(h, tooLong));

  let rawRows = Array.isArray(o.rows) ? o.rows.filter((r): r is unknown[] => Array.isArray(r)) : [];
  if (rawRows.length > MAX_TABLE_ROWS) {
    const extra = rawRows.length - MAX_TABLE_ROWS;
    rawRows = rawRows.slice(0, MAX_TABLE_ROWS);
    notices.push(`A table had more than ${MAX_TABLE_ROWS} rows — ${extra} were dropped.`);
  }
  if (rawRows.length === 0) {
    notices.push('A table widget was dropped — it has no rows.');
    return null;
  }

  let rowsTruncated = 0;
  const rows = rawRows.map((r) => {
    const cells = r.map((c) => (typeof c === 'string' ? c : ''));
    if (cells.length > headers.length) rowsTruncated++;
    const row = cells.slice(0, headers.length).map((c) => clampCell(c, tooLong));
    while (row.length < headers.length) row.push('');
    return row;
  });

  if (rowsTruncated > 0) {
    notices.push(`A table had ${rowsTruncated} row(s) with more cells than headers — the extra cells were dropped.`);
  }
  if (tooLong.n > 0) {
    notices.push(`A table had ${tooLong.n} cell(s) longer than ${MAX_TABLE_CELL_CHARS} characters — they were shortened.`);
  }

  const widget: TableWidget = { kind: 'table', headers, rows };
  const caption = optStr(o.caption);
  if (caption) widget.caption = caption;
  return widget;
}

function validateTextWidget(o: Record<string, unknown>, notices: string[]): TextWidget | null {
  const text = optStr(o.text);
  if (!text) {
    notices.push('A text widget was dropped — it has no text.');
    return null;
  }
  return { kind: 'text', text };
}

function validateStatWidget(o: Record<string, unknown>, notices: string[]): StatWidget | null {
  const rawItems = Array.isArray(o.items) ? o.items : [];
  const items = rawItems
    .map((it) => {
      if (!isRecord(it)) return null;
      const value = optStr(it.value);
      const label = optStr(it.label);
      if (!value || !label) return null;
      const out: { value: string; label: string; note?: string } = { value, label };
      const note = optStr(it.note);
      if (note) out.note = note;
      return out;
    })
    .filter((it): it is { value: string; label: string; note?: string } => it !== null);

  if (items.length === 0) {
    notices.push('A stat widget was dropped — it has no valid items.');
    return null;
  }
  return { kind: 'stat', items };
}

function validateImageWidget(o: Record<string, unknown>, notices: string[]): ImageWidget | null {
  const alt = optStr(o.alt);
  const srcRaw = typeof o.src === 'string' ? o.src : '';
  if (!alt || !srcRaw) {
    notices.push('An image widget was dropped — it needs both "src" and "alt".');
    return null;
  }
  const { src, strippedQuery } = sanitizeImageSrc(srcRaw);
  if (!src) {
    notices.push("An image widget was dropped — its URL isn't allowed (https or a project-relative path only).");
    return null;
  }
  if (strippedQuery) notices.push("An image URL's query string was removed — remote images can't carry parameters.");

  const widget: ImageWidget = { kind: 'image', src, alt };
  const caption = optStr(o.caption);
  if (caption) widget.caption = caption;
  return widget;
}

function validateDividerWidget(o: Record<string, unknown>): DividerWidget {
  const widget: DividerWidget = { kind: 'divider' };
  const label = optStr(o.label);
  if (label) widget.label = label;
  return widget;
}

/** `depth` is 1 for the widgets living directly in `body` (the page root is an implicit,
 *  uncounted stack). A `rail`'s children can only ever be leaves — that's a containment
 *  rule, not a depth one, so it's checked independently of `MAX_PAGE_DEPTH`. */
function validateWidget(
  raw: unknown,
  depth: number,
  parentKind: ContainerKind,
  toAction: (raw: unknown) => ChatAction | null,
  notices: string[],
  budget: WidgetBudget,
): PageWidget | null {
  if (!isRecord(raw)) return null;
  const kind = typeof raw.kind === 'string' ? raw.kind : '';

  if (kind === 'stack' || kind === 'rail') {
    if (parentKind === 'rail') {
      notices.push(`A "${kind}" nested inside a rail was dropped — a rail can only hold leaf widgets.`);
      return null;
    }
    if (depth > MAX_PAGE_DEPTH) {
      notices.push(`A "${kind}" was dropped — it is nested deeper than ${MAX_PAGE_DEPTH} levels.`);
      return null;
    }
    const rawItems = Array.isArray(raw.items) ? raw.items : [];
    let items = validateWidgetList(rawItems, depth + 1, kind, toAction, notices, budget);
    if (kind === 'rail' && items.length > MAX_RAIL_ITEMS) {
      const extra = items.length - MAX_RAIL_ITEMS;
      items = items.slice(0, MAX_RAIL_ITEMS);
      notices.push(`A rail had more than ${MAX_RAIL_ITEMS} items — ${extra} were dropped.`);
    }
    const title = optStr(raw.title);
    const container: StackWidget | RailWidget = kind === 'stack'
      ? { kind: 'stack', items }
      : { kind: 'rail', items };
    if (title) container.title = title;
    return takeBudget(budget) ? container : null;
  }

  let widget: PageWidget | null;
  switch (kind) {
    case 'card': widget = validateCard(raw, toAction, notices); break;
    case 'table': widget = validateTableWidget(raw, notices); break;
    case 'text': widget = validateTextWidget(raw, notices); break;
    case 'stat': widget = validateStatWidget(raw, notices); break;
    case 'image': widget = validateImageWidget(raw, notices); break;
    case 'divider': widget = validateDividerWidget(raw); break;
    default:
      notices.push(`A widget with an unknown kind ("${kind || 'unspecified'}") was dropped.`);
      return null;
  }
  if (!widget) return null;
  return takeBudget(budget) ? widget : null;
}

function validateWidgetList(
  list: unknown[],
  depth: number,
  parentKind: ContainerKind,
  toAction: (raw: unknown) => ChatAction | null,
  notices: string[],
  budget: WidgetBudget,
): PageWidget[] {
  const out: PageWidget[] = [];
  for (const raw of list) {
    const widget = validateWidget(raw, depth, parentKind, toAction, notices, budget);
    if (widget) out.push(widget);
  }
  return out;
}

function validatePage(
  obj: Record<string, unknown>,
  toAction: (raw: unknown) => ChatAction | null,
  notices: string[],
): { view: ChatViewSpec | null; notices: string[] } {
  const rawBody = Array.isArray(obj.body) ? obj.body : null;
  if (!rawBody) {
    notices.push('A page was skipped — it has no body.');
    return { view: null, notices };
  }

  const budget: WidgetBudget = { count: 0, overflowDropped: 0 };
  const body = validateWidgetList(rawBody, 1, 'stack', toAction, notices, budget);
  if (budget.overflowDropped > 0) {
    notices.push(`The page had more than ${MAX_PAGE_WIDGETS} widgets — ${budget.overflowDropped} were dropped.`);
  }

  const view: PageViewSpec = { type: 'page', body };
  const title = optStr(obj.title);
  if (title) view.title = title;
  const subtitle = optStr(obj.subtitle);
  if (subtitle) view.subtitle = subtitle;
  return { view, notices };
}

// ---------------------------------------------------------------------------------------
// type: "checklist"
// ---------------------------------------------------------------------------------------

const CHECKLIST_ID_RE = /^[a-zA-Z0-9._-]+$/;
const WANTS_VALUES = new Set(['note', 'file', 'secret']);

function validateChecklistItem(raw: unknown): ChecklistItemSpec | null {
  if (!isRecord(raw)) return null;
  const id = optStr(raw.id, 64);
  const text = optStr(raw.text, 400);
  if (!id || !text) return null;

  const item: ChecklistItemSpec = { id, text };
  const hint = optStr(raw.hint, 400);
  if (hint) item.hint = hint;
  if (typeof raw.wants === 'string' && WANTS_VALUES.has(raw.wants)) {
    item.wants = raw.wants as ChecklistItemSpec['wants'];
  }
  return item;
}

function validateChecklist(obj: Record<string, unknown>, notices: string[]): { view: ChatViewSpec | null; notices: string[] } {
  const idRaw = typeof obj.id === 'string' ? obj.id.trim() : '';
  if (!idRaw || idRaw.length > 64 || !CHECKLIST_ID_RE.test(idRaw)) {
    notices.push('A checklist was skipped — its "id" is missing or contains characters other than letters, digits, ".", "_" and "-".');
    return { view: null, notices };
  }

  const title = optStr(obj.title, 120);
  if (!title) {
    notices.push('A checklist was skipped — it has no title.');
    return { view: null, notices };
  }

  const rawItems = Array.isArray(obj.items) ? obj.items : [];
  let items = rawItems.map(validateChecklistItem).filter((i): i is ChecklistItemSpec => i !== null);
  if (items.length > MAX_CHECKLIST_ITEMS) {
    const extra = items.length - MAX_CHECKLIST_ITEMS;
    items = items.slice(0, MAX_CHECKLIST_ITEMS);
    notices.push(`A checklist had more than ${MAX_CHECKLIST_ITEMS} items — ${extra} were dropped.`);
  }

  const view: ChecklistViewSpec = { type: 'checklist', id: idRaw, title, items };
  const intro = optStr(obj.intro, 2000);
  if (intro) view.intro = intro;
  const submitLabel = optStr(obj.submitLabel, 40);
  if (submitLabel) view.submitLabel = submitLabel;
  return { view, notices };
}

// ---------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------

/**
 * Validate one `dream-view` fence body. Never throws: invalid JSON, `null`, an array, an
 * unrecognized `type`, or any cap breach all resolve to `{ view: null, notices }` rather
 * than an exception — this runs on every render commit of a still-streaming message.
 *
 * `toAction` is injected rather than imported so this module has no runtime dependency on
 * `chatActions.ts` (only a type-only one) — see plan §1.6. It validates a card's `actions`
 * with the exact same rules a `dream-actions` button already follows.
 */
export function parseViewBlock(
  json: string,
  toAction: (raw: unknown) => ChatAction | null,
): { view: ChatViewSpec | null; notices: string[] } {
  const notices: string[] = [];
  try {
    const sizeBytes = byteLength(json);
    if (sizeBytes > MAX_VIEW_BYTES) {
      notices.push(`A dream-view block was skipped — it is ${sizeBytes} bytes, over the ${MAX_VIEW_BYTES / 1024}KB limit.`);
      return { view: null, notices };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      notices.push("A dream-view block was skipped — it isn't valid JSON.");
      return { view: null, notices };
    }

    if (!isRecord(parsed)) {
      const got = parsed === null ? 'null' : Array.isArray(parsed) ? 'an array' : typeof parsed;
      notices.push(`A dream-view block was skipped — it must be a JSON object, not ${got}.`);
      return { view: null, notices };
    }

    switch (parsed.type) {
      case 'chart': return validateChart(parsed, notices);
      case 'page': return validatePage(parsed, toAction, notices);
      case 'checklist': return validateChecklist(parsed, notices);
      default:
        notices.push(`This answer asked for a view type this app doesn't have (${JSON.stringify(parsed.type ?? null)}).`);
        return { view: null, notices };
    }
  } catch {
    // Defense in depth — none of the above should throw, but a payload this data-driven
    // never gets to blank the message it's attached to.
    notices.push('A dream-view block was skipped — it could not be processed.');
    return { view: null, notices };
  }
}
