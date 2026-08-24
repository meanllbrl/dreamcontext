/**
 * The pinned shelf's rules — what occupies the one open row, what demotes to a tag, what
 * folds, and what a re-sent `id` does. Every rule the shelf has lives here.
 *
 * PURE by construction: no React, no DOM, no `api/client`, no `Date.now()`. Two reasons,
 * and the second is the load-bearing one:
 *   • root vitest runs under the plain Node environment (there is no jsdom in this repo), so
 *     logic that lives in a component is logic no unit test can reach — and the shelf's
 *     rules are exactly the kind that must not be verified by eye;
 *   • the ceiling is a SAFETY property. "No sequence of agent blocks, however many pins it
 *     sends, produces a third row" is only true if one function decides it, and that
 *     function is `layoutShelf`.
 *
 * ── The four rules this file encodes (board: knowledge/diagrams/product/chat-pinned-surface) ──
 *   WEIGHT     A pin ASKS for `tag` or `row`; the surface may demote. `effectiveWeight`.
 *   CEILING    Two rows, hard, and the tag line counts as one — so at most ONE open row.
 *              `layoutShelf` returns a single `row`, never a list.
 *   OVERFLOW   Past the ceiling the oldest ROW demotes to a `⌃` tag. Tags themselves never
 *              overflow: they are always visible, and the tag area wraps to as many lines as
 *              it needs.
 *   EXPANSION  A user-opened detail may pass the ceiling (the ceiling binds what the AGENT
 *              can force, not what the USER opens), capped at `SHELF_DETAIL_PANE_FRACTION`
 *              of the pane and scrolling inside itself past that.
 *
 * ── There is no tag fold, and that is a decision, not an omission ────────────────────────
 * An earlier cut folded tags past the line's width behind a `+N` chip, with the count as the
 * affordance. Live testing killed it (owner, 2026-08-23): a fact you have to press a button
 * to see is not a pinned fact, and the measurement that decided WHEN to fold misfired at full
 * width — four tags hidden behind a lone `−4` chip on a line with room to spare. Wrapping has
 * neither failure mode: nothing to measure, nothing to get wrong, nothing hidden. The tag area
 * costs a second line when it needs one, and the tag line is BELOW the rows, so growing it
 * moves nothing the user was reading. `foldAt` and `overflowTags` are gone — do not
 * reintroduce a fold without re-deriving why the count would be better than the fact.
 */
import {
  MAX_PIN_LEDE_CHARS, MAX_PINS_PER_CONVERSATION, MAX_TAG_LABEL_CHARS,
  type ChatViewSpec, type PinWeight,
} from './chatViewSpec';

// ---------------------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------------------

export interface ShelfFact {
  label: string;
  /** Already through `sanitizeLoopbackUrl` (agent facts) or server-derived. */
  url?: string;
  /** A state, not a value — rendered as the design's `.pin-chip.is-marker`. */
  marker?: boolean;
  /** Which glyph the chip draws, when it draws one. */
  icon?: 'branch' | 'worktree' | 'link';
}

/**
 * One thing the shelf is holding. `updatedAt` is supplied by the caller (never read from a
 * clock in here) and is what orders demotion: the newest row-weight pin keeps the row, the
 * rest demote oldest-first.
 */
export type ShelfEntry =
  | {
      kind: 'pin';
      id: string;
      weight: PinWeight;
      facts: ShelfFact[];
      lede?: string;
      detail?: string;
      /** Set ONLY here, by `foldViews` → `clampLede`. Never carried over from the agent. */
      ledeClamped?: boolean;
      updatedAt: number;
    }
  | { kind: 'progress'; id: string; task: string; updatedAt: number };

export interface ShelfTag {
  /** Unique within one layout — used as the render key. */
  id: string;
  label: string;
  url?: string;
  marker?: boolean;
  icon?: ShelfFact['icon'];
  /** This tag is a row that lost the slot: it carries `⌃` and clicking promotes it back. */
  demoted?: boolean;
  /** Server-derived session facts are NOT dismissable — a polled fact would return on the
   *  next tick, so an `×` on it would be a button that doesn't work. */
  dismissable: boolean;
}

export interface ShelfLayout {
  /** At most ONE. This is the ceiling, expressed as a type rather than as a check. */
  row: ShelfEntry | null;
  /** The tag line, in render order: server facts, then agent facts, then demoted rows.
   *  ALL of them — nothing is held back. The renderer wraps rather than folding. */
  tags: ShelfTag[];
  /** Entries that lost the row slot, oldest first. */
  demotedIds: string[];
  notices: string[];
}

/** Rows the shelf may occupy INCLUDING the tag line — so exactly one may open above it. */
export const SHELF_MAX_ROWS = 2;

/** Share of the PANE height a user-opened detail may occupy before it scrolls inside itself.
 *  Applied by measuring `.chat-pane` and writing `--pin-detail-max`: `cqh` cannot be used
 *  because no ancestor declares a size container (`.chat-pane` declares none; `.agent-pane`
 *  is `inline-size` only). Same idiom as the composer's own `COMPOSER_PANE_FRACTION`. */
export const SHELF_DETAIL_PANE_FRACTION = 0.4;

/**
 * Share of the PANE height the wrapped tag area may occupy before it scrolls inside itself.
 *
 * Tags never fold and never hide behind a count — but wrapping is unbounded, and measured on a
 * 470px pane an expanded detail plus ~29 tags pushed the composer past the bottom edge. The
 * composer outranks the tag area: a composer you cannot reach is a worse failure than a tag
 * you have to scroll to. In the ordinary one-to-three-row case this never engages.
 */
export const SHELF_TAGS_PANE_FRACTION = 0.25;

// ---------------------------------------------------------------------------------------
// Weight — a request, not a command
// ---------------------------------------------------------------------------------------

/**
 * What this entry ACTUALLY renders as, whatever it asked for.
 *
 * A `row` earns its row by having something a row is for: prose to open (`detail`), or a
 * lede too long to sit in a chip. A `row` carrying neither is a tag wearing a row's clothes,
 * and honouring it would spend the whole two-row ceiling on a label — which is precisely how
 * the tag line gets pushed off screen. Progress is always a row: it has a track and a live
 * criterion, which no chip can hold.
 */
export function effectiveWeight(e: ShelfEntry): PinWeight {
  if (e.kind === 'progress') return 'row';
  if (e.weight !== 'row') return 'tag';
  if (e.detail) return 'row';
  // "Tag-sized" is not a new number: it is exactly what a tag chip can hold.
  return e.lede && e.lede.length > MAX_TAG_LABEL_CHARS ? 'row' : 'tag';
}

/**
 * A one-line lede cut from prose, and an honest flag saying it was cut.
 *
 * Cuts at the first line break too, not only at the character budget: a pin whose detail
 * opens with a short heading has a natural lede, and running the two together would produce
 * a line that reads as one sentence and isn't.
 */
export function clampLede(text: string): { lede: string; clamped: boolean } {
  const trimmed = text.trim();
  const firstBreak = trimmed.indexOf('\n');
  const firstLine = firstBreak === -1 ? trimmed : trimmed.slice(0, firstBreak).trim();
  if (firstLine.length <= MAX_PIN_LEDE_CHARS) {
    return { lede: firstLine, clamped: firstLine.length < trimmed.length };
  }
  return { lede: firstLine.slice(0, MAX_PIN_LEDE_CHARS).trimEnd(), clamped: true };
}

// ---------------------------------------------------------------------------------------
// Layout — the ceiling, the demotion order, the count cap
// ---------------------------------------------------------------------------------------

/** The label a demoted row wears on the tag line — its lede, or its first fact. */
function demotedLabel(e: ShelfEntry): string {
  if (e.kind === 'progress') return 'Run progress';
  return e.lede ?? e.facts[0]?.label ?? e.id;
}

function factTag(entryId: string, fact: ShelfFact, index: number): ShelfTag {
  const tag: ShelfTag = { id: `${entryId}#${index}`, label: fact.label, dismissable: true };
  if (fact.url) tag.url = fact.url;
  if (fact.marker) tag.marker = true;
  if (fact.icon) tag.icon = fact.icon;
  return tag;
}

/**
 * Everything the shelf shows this frame.
 *
 * `facts` are the SERVER-derived session facts (branch, worktree marker) — they lead the tag
 * line and are never dismissable. Agent tags follow in entry order (oldest first, so a new
 * pin appends rather than reshuffling the line under the user's cursor), then the demoted
 * rows.
 *
 * The row slot goes to progress if a run is live, otherwise to the newest row-weight pin.
 * Everything else that wanted a row demotes, OLDEST FIRST — "it demoted, it did not close".
 */
export function layoutShelf(entries: ShelfEntry[], facts: ShelfFact[]): ShelfLayout {
  const notices: string[] = [];
  const byAge = [...entries].sort((a, b) => a.updatedAt - b.updatedAt);

  const wantRow = byAge.filter((e) => effectiveWeight(e) === 'row');
  const progress = wantRow.filter((e) => e.kind === 'progress');
  // A live run owns the row. Between two progress entries the newest wins, same as pins.
  const row = progress.length > 0
    ? progress[progress.length - 1]
    : wantRow.length > 0 ? wantRow[wantRow.length - 1] : null;

  const demoted = wantRow.filter((e) => e !== row); // already oldest-first
  const demotedIds = demoted.map((e) => e.id);

  const serverTags: ShelfTag[] = facts.map((f, i) => {
    const tag: ShelfTag = { id: `fact#${i}`, label: f.label, dismissable: false };
    if (f.url) tag.url = f.url;
    if (f.marker) tag.marker = true;
    if (f.icon) tag.icon = f.icon;
    return tag;
  });

  const agentTags: ShelfTag[] = byAge
    .filter((e) => effectiveWeight(e) === 'tag' && e.kind === 'pin')
    .flatMap((e) => (e.kind === 'pin' ? e.facts.map((f, i) => factTag(e.id, f, i)) : []));

  const demotedTags: ShelfTag[] = demoted.map((e) => ({
    id: e.id, label: demotedLabel(e), demoted: true, dismissable: true,
  }));

  // Every tag, in one list. No count cap and no width fold: the renderer wraps. The only
  // bound on how many tags a conversation can accumulate is `MAX_PINS_PER_CONVERSATION`
  // eviction in `foldViews`, which is loud and stays.
  const tags = [...serverTags, ...agentTags, ...demotedTags];

  return { row, tags, demotedIds, notices };
}

// ---------------------------------------------------------------------------------------
// Folding a message's views into the shelf
// ---------------------------------------------------------------------------------------

/** A progress block is keyed by its task, so re-reporting the same run updates one row. */
function progressId(task: string): string {
  return `progress:${task}`;
}

function entryFromView(view: ChatViewSpec, at: number): ShelfEntry | null {
  if (view.type === 'progress') {
    return { kind: 'progress', id: progressId(view.task), task: view.task, updatedAt: at };
  }
  if (view.type !== 'pin') return null;

  const entry: ShelfEntry = {
    kind: 'pin',
    id: view.id,
    weight: view.weight,
    facts: view.facts.map((f) => {
      const fact: ShelfFact = { label: f.label };
      if (f.url) { fact.url = f.url; fact.icon = 'link'; }
      if (f.marker) fact.marker = true;
      return fact;
    }),
    updatedAt: at,
  };

  if (view.lede) entry.lede = view.lede;
  else if (view.detail) {
    // The author wrote prose and no lede, so the SHELF makes one — and says it did. This is
    // the only place `ledeClamped` is ever set; `validatePin` strips whatever the agent sent.
    const { lede, clamped } = clampLede(view.detail);
    if (lede) { entry.lede = lede; if (clamped) entry.ledeClamped = true; }
  }
  if (view.detail) entry.detail = view.detail;
  return entry;
}

/**
 * Fold one message's views into the shelf's entries.
 *
 * ID-KEYED: re-sending an `id` UPDATES that entry in place and never appends a second — the
 * contract `checklist` already established, and the reason the agent can keep a pin current
 * instead of stacking a new card every turn. An updated entry keeps its POSITION in the list
 * (so the tag line doesn't reshuffle under the cursor) but takes the new `updatedAt`, which
 * is what lets it win the row slot.
 *
 * Past `MAX_PINS_PER_CONVERSATION` the oldest entries are evicted and COUNTED — the caller
 * reports the number, so a conversation that pinned 200 things says so instead of quietly
 * forgetting 176 of them.
 */
export function foldViews(
  prev: ShelfEntry[],
  views: ChatViewSpec[],
  at: number,
): { entries: ShelfEntry[]; evicted: number } {
  const entries = [...prev];
  const indexById = new Map(entries.map((e, i) => [e.id, i]));

  for (const view of views) {
    const next = entryFromView(view, at);
    if (!next) continue;
    const existing = indexById.get(next.id);
    if (existing === undefined) {
      indexById.set(next.id, entries.length);
      entries.push(next);
    } else {
      entries[existing] = next;
    }
  }

  if (entries.length <= MAX_PINS_PER_CONVERSATION) return { entries, evicted: 0 };
  const evicted = entries.length - MAX_PINS_PER_CONVERSATION;
  return { entries: entries.slice(evicted), evicted };
}
