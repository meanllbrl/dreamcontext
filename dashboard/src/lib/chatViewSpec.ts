/**
 * The `dream-view` fence payload — one JSON object, discriminated by `type`, that an
 * assistant answer can ask the Chat view to render.
 *
 * WHAT THIS FILE IS *NOT* ANYMORE, and why that matters when reading it. It used to also
 * carry `chart` (five typed renders) and `page` (a seven-widget tree), on the principle that
 * "the agent emits DATA, never code". Both were retired on 2026-08-26: the vocabulary could
 * only ever express what we had pre-built, so anything outside it — a flow, a tabbed
 * comparison, a timeline, two candidate designs side by side — fell back to prose or cost a
 * new widget. The agent now writes the presentation itself in a ```dream-html block
 * (`chat/chatHtmlKit.ts`), drawn in a network-less sandboxed iframe wearing dreamcontext's
 * own CSS. What remains here is everything HTML CANNOT be:
 *
 *   • `insight`   — a tracked metric has ONE canonical rendering; retyping its numbers into
 *                   markup would fork the truth, so the agent names the slug and we draw it.
 *   • `checklist` — an always-on-top OS window, outside the transcript entirely.
 *   • `pin` / `progress` — the shelf docked to the composer, which never scrolls away.
 *
 * Pure and defensive by design: `parseViewBlock` runs on every streamed token via
 * `chatActions.ts`, so it NEVER throws, and it never lets a malformed payload blank a
 * message — a rejected block just yields `view: null` plus a human-readable notice. Every
 * cap breach is reported the same way: loud, never a silent truncation.
 *
 * No React, no CSS, no `api/client` — this file must stay importable by root vitest with a
 * `.js` specifier (see `tests/unit/chat-actions.test.ts`).
 */

// ---------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------

export const VIEW_TYPES = ['insight', 'checklist', 'pin', 'progress', 'checkout'] as const;
export type ChatViewType = typeof VIEW_TYPES[number];

export type ChatViewSpec =
  InsightViewSpec | ChecklistViewSpec | PinViewSpec | ProgressViewSpec | CheckoutViewSpec;

/**
 * `type: "insight"` — a Lab insight drawn BY SLUG, with no markup from the agent at all.
 *
 * This is the deliberate hole in "the agent writes the presentation". A tracked metric
 * already has a canonical rendering: the synced cache, the render its manifest declares, the
 * staleness the board shows. An agent retyping those numbers into a `dream-html` block would
 * fork the truth — two spellings of one figure, one of them a transcription. So for anything
 * the Lab already tracks, the agent names it and the app draws it.
 *
 * `view` picks the card body or the fuller detail body. `breakdown` mirrors the report-item
 * contract (`src/lib/lab/reports-store.ts`) so the two composition surfaces stay one idea:
 * it selects pivot axes on a matrix insight and never mutates the insight's stored tweaks —
 * a chat message must not silently re-configure a board card.
 */
export interface InsightViewSpec {
  type: 'insight';
  /** The insight slug, as `dreamcontext lab list` prints it. */
  id: string;
  /** `card` (default) is the board's thumbnail body; `full` is the detail body. */
  view?: 'card' | 'full';
  /** Pivot selection for a matrix (`render: breakdown`) insight. */
  breakdown?: { rows?: string; cols?: string; filter?: Record<string, string> };
}

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

/**
 * `type: "checkout"` — which checkout this session's WORK belongs to, when it is not the one
 * the session is standing in.
 *
 * The odd one out on this surface: nothing is drawn for it. It is applied by the SERVER, off
 * the same stream it reads tool frames on (src/server/checkout-directive.ts), and the visible
 * result is the shelf's branch chip changing plus one banner naming the outcome. It is parsed
 * here for two reasons and no others: so a legitimate block does not fall through to the
 * unknown-type notice, and so the pane can refresh its session facts at once instead of
 * waiting out the 15s poll.
 *
 * `path` is absolute; `reset: true` withdraws a previous claim and carries no path. The
 * validator is deliberately thin — the SERVER decides whether the directory may be pointed
 * at, and a second opinion here would be a rule that can drift from the one that matters.
 */
export interface CheckoutViewSpec {
  type: 'checkout';
  /** Absolute path, or null for a withdrawal. */
  path: string | null;
  reset?: true;
}

// ---------------------------------------------------------------------------------------
// Caps (§1.3) — every breach here degrades loudly: the excess is dropped and a notice
// names what happened. Never a silent truncation.
// ---------------------------------------------------------------------------------------

export const MAX_VIEW_BYTES = 64 * 1024;
export const MAX_VIEWS_PER_MESSAGE = 4;
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

/** Every byte a browser silently drops before it acts on a URL. Stripped from the WHOLE
 *  string, not just the ends: a tab hidden inside `java\tscript:` is exactly the
 *  obfuscation a naive scheme check misses, and we have to see what the browser sees. */
const CONTROL_OR_WHITESPACE_RE = /[\x00-\x20\x7f]/g;
const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
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
// type: "insight"
// ---------------------------------------------------------------------------------------

/** An insight slug. Same grammar the CLI and the API accept, bounded so a runaway string
 *  can never ride into a request path. */
const INSIGHT_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const INSIGHT_VIEWS = new Set(['card', 'full']);
/** Pivot axes and filter values are dimension KEYS, not prose — a short, boring grammar. */
const DIM_KEY_RE = /^[A-Za-z0-9 ._:/-]{1,60}$/;

function validateInsight(obj: Record<string, unknown>, notices: string[]): { view: ChatViewSpec | null; notices: string[] } {
  const id = typeof obj.id === 'string' ? obj.id.trim().toLowerCase() : '';
  if (!id || !INSIGHT_SLUG_RE.test(id)) {
    notices.push('An insight block was skipped — its "id" is missing or is not an insight slug (lowercase letters, digits and "-").');
    return { view: null, notices };
  }

  const view: InsightViewSpec = { type: 'insight', id };

  if (obj.view !== undefined) {
    if (typeof obj.view === 'string' && INSIGHT_VIEWS.has(obj.view)) {
      view.view = obj.view as InsightViewSpec['view'];
    } else {
      notices.push(`An insight asked for a view this app doesn't have (${JSON.stringify(obj.view)}) — the card was shown instead.`);
    }
  }

  if (isRecord(obj.breakdown)) {
    const b: NonNullable<InsightViewSpec['breakdown']> = {};
    const rows = optStr(obj.breakdown.rows, 60);
    const cols = optStr(obj.breakdown.cols, 60);
    if (rows && DIM_KEY_RE.test(rows)) b.rows = rows;
    if (cols && DIM_KEY_RE.test(cols)) b.cols = cols;
    if (isRecord(obj.breakdown.filter)) {
      const filter: Record<string, string> = {};
      for (const [k, v] of Object.entries(obj.breakdown.filter)) {
        const value = optStr(v, 60);
        if (DIM_KEY_RE.test(k) && value && DIM_KEY_RE.test(value)) filter[k] = value;
      }
      if (Object.keys(filter).length > 0) b.filter = filter;
    }
    if (Object.keys(b).length > 0) view.breakdown = b;
  }

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

/**
 * `type: "checkout"` — a path, or a withdrawal. Anything else is a notice, because a block
 * that says neither is an agent that meant to move the shelf and did not.
 */
function validateCheckout(obj: Record<string, unknown>, notices: string[]): { view: ChatViewSpec | null; notices: string[] } {
  if (obj.reset === true) return { view: { type: 'checkout', path: null, reset: true }, notices };

  const path = optStr(obj.path, 1024);
  if (!path) {
    notices.push('A checkout block was skipped — it needs an absolute "path", or "reset": true.');
    return { view: null, notices };
  }
  if (!path.startsWith('/')) {
    notices.push(`A checkout block was skipped — "${path}" is not an absolute path.`);
    return { view: null, notices };
  }
  return { view: { type: 'checkout', path, reset: undefined }, notices };
}

// ---------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------

/**
 * Validate one `dream-view` fence body. Never throws: invalid JSON, `null`, an array, an
 * unrecognized `type`, or any cap breach all resolve to `{ view: null, notices }` rather
 * than an exception — this runs on every render commit of a still-streaming message.
 */
export function parseViewBlock(json: string): { view: ChatViewSpec | null; notices: string[] } {
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
      case 'insight': return validateInsight(parsed, notices);
      case 'checklist': return validateChecklist(parsed, notices);
      case 'pin': return validatePin(parsed, notices);
      case 'progress': return validateProgress(parsed, notices);
      case 'checkout': return validateCheckout(parsed, notices);
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
