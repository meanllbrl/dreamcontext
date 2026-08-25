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

export const VIEW_TYPES = ['chart', 'page', 'checklist', 'pin', 'progress'] as const;
export type ChatViewType = typeof VIEW_TYPES[number];

export type ChatViewSpec =
  ChartViewSpec | PageViewSpec | ChecklistViewSpec | PinViewSpec | ProgressViewSpec;

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

/**
 * `type: "pin"` — a fact the agent wants kept OUT of the transcript, on the shelf docked to
 * the composer's top edge.
 *
 * `weight` is a REQUEST, not a command: the agent asks for a `tag` (one short label sharing
 * the tag line) or a `row` (a lede plus openable detail), and the surface is free to demote
 * a `row` whose content is tag-sized. That is what keeps the shelf's two-row ceiling
 * enforceable no matter what an agent sends — see `lib/shelfModel.ts`'s `effectiveWeight`.
 */
export type PinWeight = 'tag' | 'row';

export interface PinFactSpec {
  label: string;
  /** A loopback http(s) URL, and ONLY loopback — see {@link sanitizeLoopbackUrl}. */
  url?: string;
  /** A marker chip (`worktree`) rather than a value chip: no value, just a state. */
  marker?: boolean;
}

export interface PinViewSpec {
  type: 'pin';
  id: string;
  weight: PinWeight;
  facts: PinFactSpec[];
  lede?: string;
  detail?: string;
  /**
   * True when the SURFACE produced the lede by clamping `detail` — the `…` chip the design
   * calls `.pin-clamp`, which means "the shelf cut this line", not "the author was brief".
   * `validatePin` ALWAYS strips this from author input and never sets it; only the shelf
   * model (`foldViews` → `clampLede`) may. A truncated pin presented as complete is the one
   * dishonesty this flag exists to prevent, so the agent must not be able to fake it.
   */
  ledeClamped?: boolean;
  /**
   * A RETIREMENT rather than a fact: the shelf is asked to forget `id` and to show nothing.
   *
   * Without it the agent could correct a pin forever but never take one down — `foldViews` is
   * id-keyed UPDATE-only and the shelf has no expiry — so a fact that had stopped being true
   * (a port that moved, a blocker that cleared) stood until the USER noticed and pressed `×`.
   * Only `true` ever reaches here; `validatePin` reports any other value and ignores it.
   */
  drop?: true;
}

/**
 * `type: "progress"` — a run's progress, DERIVED FROM DISK. The payload carries only the
 * task slug: percent comes from that task file's ticked acceptance criteria (the same
 * counter `tasks doctor` uses), so it cannot be wrong in a way the user can't check. A
 * percent supplied by the agent is not a fallback, it is a bug — `validateProgress` drops it
 * and says so.
 */
export interface ProgressViewSpec {
  type: 'progress';
  task: string;
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

// Shelf caps. The first four are enforced HERE (a payload the agent sent); the last two are
// enforced by `lib/shelfModel.ts`, which owns how many entries a conversation keeps and how
// many chips one tag line may carry. Both halves degrade loudly, never silently.
export const MAX_PINS_PER_CONVERSATION = 24;
export const MAX_PIN_FACTS = 6;
export const MAX_PIN_LEDE_CHARS = 160;
export const MAX_PIN_DETAIL_CHARS = 4000;
export const MAX_TAG_LABEL_CHARS = 48;
export const MAX_TAGS_PER_LINE = 12;

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
// Loopback URLs (pin facts only) — the DELIBERATE carve-out to this surface's https-only rule
// ---------------------------------------------------------------------------------------

/** Exactly the hosts a pinned dev-server URL may name, AFTER WHATWG normalization. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The one place `http:` is allowed on this surface: a pin fact naming the dev server the
 * work can be tested on. It is scoped to PIN FACTS on purpose — the `url` ACTION
 * (`chat/chatActions.ts`) stays https-only, because nothing asked for it and a narrower
 * carve-out is a smaller thing to get wrong.
 *
 * The gate is POST-PARSE, and that is a deliberate choice with a consequence worth stating.
 * WHATWG `URL` normalizes every alternative spelling of loopback to the canonical host:
 * `127.1`, `0177.0.0.1`, `0x7f000001`, `2130706433` and the IDNA forms `①27.0.0.1` /
 * `127。0。0。1` all become `127.0.0.1`, and `[0:0:0:0:0:0:0:1]` becomes `[::1]`. Those are
 * therefore ACCEPTED, and that is safe by construction: the browser and the OS opener
 * resolve the identical normalized host we compared against, so an obfuscated spelling of
 * loopback cannot reach anywhere loopback does not. A pre-parse string match would have been
 * the UNSAFE design — it would reject the obfuscated spellings while the browser happily
 * resolved them, which is a filter that only stops honest input.
 *
 * Rejected, each for its own reason:
 *   • any host that does not normalize into {@link LOOPBACK_HOSTS} — `localhost.evil.com`
 *     and `127.0.0.1.evil.com` are ordinary public names that merely LOOK local;
 *   • `0.0.0.0` — it is not loopback, but a connection to it lands on loopback on Linux and
 *     Windows, so it is the one non-loopback host that behaves like one. Rejected by its own
 *     explicit check rather than left to the host compare, so the intent survives a refactor;
 *   • `[::ffff:127.0.0.1]`, which normalizes to `[::ffff:7f00:1]` and so fails the host
 *     compare. That is FAIL-CLOSED ON PURPOSE: an IPv4-mapped IPv6 literal is a form no user
 *     types. Do not "fix" it into the accept list without first re-deriving the safety
 *     argument above for it;
 *   • userinfo (`http://user:pass@localhost/`) — same rule `sanitizeImageSrc` applies;
 *   • protocol-relative `//host`, and any scheme but http/https.
 *
 * `search` and `hash` are STRIPPED (mirroring `sanitizeImageSrc`), and the caller reports it.
 * That is not only tidiness: the hosts this function permits include the dashboard's OWN
 * loopback port, so a pinned chip carrying `?vault=…` or `?token=…` would be a same-origin
 * request the agent authored. A pinned link is an address, never a payload.
 */
export function sanitizeLoopbackUrl(raw: string): { url: string | null; strippedQuery: boolean } {
  const NOTHING = { url: null, strippedQuery: false };
  if (typeof raw !== 'string') return NOTHING;

  // Same strip as sanitizeImageSrc, and for the same reason: the browser drops these bytes
  // before it acts on the URL, so we have to see what it sees.
  const cleaned = raw.replace(CONTROL_OR_WHITESPACE_RE, '');
  if (!cleaned || cleaned.startsWith('//')) return NOTHING;

  const schemeMatch = SCHEME_RE.exec(cleaned);
  if (!schemeMatch) return NOTHING; // a bare `localhost:5173` is a scheme-less path, not a URL
  const scheme = schemeMatch[1].toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') return NOTHING;

  let url: URL;
  try {
    url = new URL(cleaned);
  } catch {
    return NOTHING;
  }

  if (url.username || url.password) return NOTHING;
  if (url.hostname === '0.0.0.0') return NOTHING;
  if (!LOOPBACK_HOSTS.has(url.hostname)) return NOTHING;

  const strippedQuery = url.search !== '' || url.hash !== '';
  url.search = '';
  url.hash = '';
  return { url: url.toString(), strippedQuery };
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
// type: "pin"
// ---------------------------------------------------------------------------------------

/** The same grammar {@link CHECKLIST_ID_RE} uses, and for the same reason rather than by
 *  accident: both ids become part of a `localStorage` key built by joining hex-encoded
 *  parts, so neither may contain the separators those keys join on. Kept as its own constant
 *  so a future change to one surface's ids can't silently move the other's. */
const PIN_ID_RE = /^[a-zA-Z0-9._-]+$/;
const PIN_WEIGHTS = new Set(['tag', 'row']);
/** A task slug as `dreamcontext` writes one. Longer than a pin id because a task slug is a
 *  whole sentence kebab-cased (`two-new-agent-actions-pinned-session-facts-…`). */
const PROGRESS_SLUG_RE = /^[A-Za-z0-9._-]{1,120}$/;
/** Keys that would mean the agent is ASSERTING progress instead of letting it be derived. */
const ASSERTED_PROGRESS_KEYS = ['percent', 'pct', 'done', 'total'] as const;

/** One fact, or null when it has no label to show. A rejected `url` costs the fact its LINK,
 *  never its label — a dropped link is a chip you can't click, a dropped fact is one you
 *  can't read. */
function validatePinFact(raw: unknown, counts: { clamped: number; badUrl: number; stripped: number }): PinFactSpec | null {
  if (!isRecord(raw)) return null;
  const rawLabel = optStr(raw.label);
  if (!rawLabel) return null;

  const label = rawLabel.length > MAX_TAG_LABEL_CHARS ? rawLabel.slice(0, MAX_TAG_LABEL_CHARS) : rawLabel;
  if (label !== rawLabel) counts.clamped++;

  const fact: PinFactSpec = { label };
  if (raw.marker === true) fact.marker = true;

  if (typeof raw.url === 'string' && raw.url.trim()) {
    const { url, strippedQuery } = sanitizeLoopbackUrl(raw.url);
    if (!url) counts.badUrl++;
    else {
      fact.url = url;
      if (strippedQuery) counts.stripped++;
    }
  }
  return fact;
}

function validatePin(obj: Record<string, unknown>, notices: string[]): { view: ChatViewSpec | null; notices: string[] } {
  const idRaw = typeof obj.id === 'string' ? obj.id.trim() : '';
  if (!idRaw || idRaw.length > 64 || !PIN_ID_RE.test(idRaw)) {
    notices.push('A pin was skipped — its "id" is missing or contains characters other than letters, digits, ".", "_" and "-".');
    return { view: null, notices };
  }

  // A drop is read BEFORE anything else, and it wins whatever rode along with it. A payload
  // that says "remove this" and also carries facts is an agent contradicting itself, and the
  // half worth honouring is the removal: the defect this field exists to end is a pin that
  // cannot be taken down, so it must not be defeated by a stray leftover key. What the drop
  // does NOT do is invent state — `facts` is empty and `weight` is the default, because a
  // retired pin is never rendered (see `shelfModel.foldViews`).
  if (obj.drop !== undefined) {
    if (obj.drop === true) {
      const carried = ['facts', 'lede', 'detail'].filter((k) => obj[k] !== undefined);
      if (carried.length > 0) {
        notices.push(`A pin asked to be dropped and also carried ${carried.join(', ')} — it was dropped and the rest ignored. A drop takes an "id" and nothing else.`);
      }
      return { view: { type: 'pin', id: idRaw, weight: 'tag', facts: [], drop: true }, notices };
    }
    if (obj.drop !== false) {
      notices.push(`A pin's "drop" was ${JSON.stringify(obj.drop)}, which is neither true nor false — it was ignored and the pin read as an ordinary one.`);
    }
  }

  // Absent `weight` is the documented default, so it is silent; a weight this app doesn't
  // have is a promise it can't keep, so it is not.
  let weight: PinWeight = 'tag';
  if (obj.weight !== undefined) {
    if (typeof obj.weight === 'string' && PIN_WEIGHTS.has(obj.weight)) weight = obj.weight as PinWeight;
    else notices.push(`A pin asked for a weight this app doesn't have (${JSON.stringify(obj.weight)}) — it was shown as a tag.`);
  }

  const counts = { clamped: 0, badUrl: 0, stripped: 0 };
  const rawFacts = Array.isArray(obj.facts) ? obj.facts : [];
  let facts = rawFacts.map((f) => validatePinFact(f, counts)).filter((f): f is PinFactSpec => f !== null);
  if (facts.length > MAX_PIN_FACTS) {
    const extra = facts.length - MAX_PIN_FACTS;
    facts = facts.slice(0, MAX_PIN_FACTS);
    notices.push(`A pin had more than ${MAX_PIN_FACTS} facts — ${extra} were dropped.`);
  }
  if (counts.clamped > 0) {
    notices.push(`A pin had ${counts.clamped} fact label(s) longer than ${MAX_TAG_LABEL_CHARS} characters — they were shortened.`);
  }
  if (counts.badUrl > 0) {
    notices.push(`A pin had ${counts.badUrl} fact URL(s) that aren't allowed — a pinned link must be https, or http on localhost / 127.0.0.1 / [::1]. The fact is still shown, without the link.`);
  }
  if (counts.stripped > 0) {
    notices.push("A pinned URL's query string was removed — a pinned link is an address, not a payload.");
  }

  const view: PinViewSpec = { type: 'pin', id: idRaw, weight, facts };

  const ledeRaw = optStr(obj.lede);
  if (ledeRaw) {
    view.lede = ledeRaw.length > MAX_PIN_LEDE_CHARS ? ledeRaw.slice(0, MAX_PIN_LEDE_CHARS) : ledeRaw;
    if (view.lede !== ledeRaw) notices.push(`A pin's lede was longer than ${MAX_PIN_LEDE_CHARS} characters — it was shortened.`);
  }
  const detailRaw = optStr(obj.detail);
  if (detailRaw) {
    view.detail = detailRaw.length > MAX_PIN_DETAIL_CHARS ? detailRaw.slice(0, MAX_PIN_DETAIL_CHARS) : detailRaw;
    if (view.detail !== detailRaw) notices.push(`A pin's detail was longer than ${MAX_PIN_DETAIL_CHARS} characters — it was shortened.`);
  }
  // `ledeClamped` is never copied across, whatever the agent sent: it means "the SHELF cut
  // this line", and only the shelf may say so. See PinViewSpec's field doc.

  if (facts.length === 0 && !view.lede && !view.detail) {
    notices.push('A pin was skipped — it has no facts, lede or detail to show.');
    return { view: null, notices };
  }
  return { view, notices };
}

// ---------------------------------------------------------------------------------------
// type: "progress"
// ---------------------------------------------------------------------------------------

function validateProgress(obj: Record<string, unknown>, notices: string[]): { view: ChatViewSpec | null; notices: string[] } {
  const task = typeof obj.task === 'string' ? obj.task.trim() : '';
  if (!task || !PROGRESS_SLUG_RE.test(task)) {
    notices.push('A progress block was skipped — its "task" is missing or is not a task slug.');
    return { view: null, notices };
  }

  // Loud, not silent: the whole point of this block is that the user can TRUST the number,
  // so an agent that supplied one is told its number was thrown away rather than left to
  // believe the bar it drew is the bar the user sees.
  if (ASSERTED_PROGRESS_KEYS.some((k) => obj[k] !== undefined)) {
    notices.push("A progress block supplied its own percent — it was ignored. The number is read from the task file's acceptance criteria.");
  }

  return { view: { type: 'progress', task }, notices };
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
      case 'pin': return validatePin(parsed, notices);
      case 'progress': return validateProgress(parsed, notices);
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
