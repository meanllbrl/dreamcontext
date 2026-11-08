/**
 * The cards a Super turn put on the stage, read back from the turn itself (owner 2026-11-08: "the
 * presentation gets lost; show it visually under the answer, open it on click").
 *
 * The record of what a turn opened is the turn's own transcript: every `dreamcontext super open …`,
 * `super present …` and `super ask … --show` is a Bash call whose result is the server's JSON
 * (`open`: the cards it made or brought back, whole; `present`: the view's card ids; `ask`: the
 * card ids its `show` put up). Nothing new is stored: a tile is derived from that record, so it
 * survives the card going to Others, a reload and a fresh Super session (pattern
 * a-record-kept-by-habit-goes-stale-derive-it-from-facts), and the live stage record only says
 * where the card is now, or that it is gone.
 *
 * A turn runs from one owner (or event) message to the next; its cards go under the LAST text the
 * Super wrote in it, which is its answer. Cards of a turn that wrote no answer go under the next one.
 */

/** What a turn's own record says about one card it showed. */
export interface KnownCard { id: string; kind: string; ref: string; title?: string }

/** What one Super turn showed on the stage, in the order it showed it. */
export interface TurnCards {
  /** Card ids, first-shown order, no repeats. */
  ids: string[];
  /** The cards `open` returned whole (present and ask only name ids). */
  known: Record<string, KnownCard>;
  /** The group an `open` put a card into, by card id. */
  groupOf: Record<string, string>;
}

/** The slice of a transcript item this module reads (chatSession's ChatItem fits). */
export type TurnItem =
  | { kind: 'user'; id: string; text?: string; stageMedia?: unknown }
  | { kind: 'text'; id: string; text?: string }
  | { kind: 'tool'; id: string; name: string; input: unknown; status: string; result?: unknown }
  | { kind: string; id: string };

/** A Super stage verb that shows cards, as the CLI spells it (any prefix: `npx`, an env, `&&`). */
const SHOW_VERB = /\bsuper\s+(?:open|present|ask|queue\s+ask)\b/;

/** At most this many tiles under one answer: a turn that opened a whole folder still reads. */
export const MAX_TURN_CARDS = 8;

function commandOf(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const c = (input as Record<string, unknown>).command;
  return typeof c === 'string' ? c : null;
}

function resultText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) {
    return result.map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : '')).join('\n');
  }
  return '';
}

/** Every top-level JSON object in `text` (the CLI prints each verb's result pretty, one after
 *  another when the Super chains verbs with `&&`). Strings are skipped so a brace inside a title
 *  never unbalances the scan; an object that does not parse is left out. */
export function jsonObjectsIn(text: string): Record<string, unknown>[] {
  return scanObjects(text).whole;
}

/**
 * The scan behind `jsonObjectsIn`. `nested` holds the complete objects found INSIDE a top-level
 * object that never closed: a reopened conversation replays each tool result cut at 4000
 * characters (transcript-history.ts), so a long `open` keeps its first cards whole even though
 * the result as a whole no longer parses.
 */
export function scanObjects(text: string): { whole: Record<string, unknown>[]; nested: Record<string, unknown>[] } {
  const whole: Record<string, unknown>[] = [];
  let nested: Record<string, unknown>[] = [];
  const parse = (from: number, to: number): Record<string, unknown> | null => {
    try {
      const v = JSON.parse(text.slice(from, to + 1));
      return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
    } catch { return null; }
  };
  const starts: number[] = [];
  let inner: Record<string, unknown>[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { if (starts.length) inString = true; continue; }
    if (ch === '{') { starts.push(i); continue; }
    if (ch === '}' && starts.length) {
      const from = starts.pop()!;
      const v = parse(from, i);
      if (!starts.length) {
        if (v) whole.push(v);
        inner = [];
      } else if (v) inner.push(v);
    }
  }
  // A top-level object still open at the end: what closed inside it is all there is.
  if (starts.length) nested = inner;
  return { whole, nested };
}

/** The stage record itself (`super state`), never a show verb's answer: its cards are not this turn's. */
const isStateDump = (r: Record<string, unknown>) => 'queue' in r || 'children' in r || 'enabled' in r;

const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 80;

function knownOf(v: unknown): KnownCard | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (!isId(o.id) || typeof o.kind !== 'string' || typeof o.ref !== 'string') return null;
  return { id: o.id, kind: o.kind, ref: o.ref, ...(typeof o.title === 'string' && o.title ? { title: o.title } : {}) };
}

/** Fold one verb's result object into the turn. */
function addResult(turn: TurnCards, r: Record<string, unknown>): void {
  const add = (id: string) => { if (!turn.ids.includes(id)) turn.ids.push(id); };
  if (isStateDump(r)) return;
  // `open`: the cards whole (it answers `container` beside `containers`), and the group they went into.
  if (Array.isArray(r.containers) && r.container && typeof r.container === 'object') {
    const group = r.group && typeof r.group === 'object' ? (r.group as Record<string, unknown>).id : undefined;
    for (const raw of r.containers) {
      const k = knownOf(raw);
      if (!k) continue;
      turn.known[k.id] = k;
      if (isId(group)) turn.groupOf[k.id] = group;
      add(k.id);
    }
  }
  // `present`: the view it set.
  const view = r.view && typeof r.view === 'object' ? r.view as Record<string, unknown> : null;
  if (view && view.mode === 'present' && Array.isArray(view.cards) && !Array.isArray(r.containers) && Object.keys(r).every((k) => k === 'view' || k === 'kept')) {
    for (const id of view.cards) if (isId(id)) add(id);
  }
  // `ask --show`: the cards its question put up.
  const show = r.show && typeof r.show === 'object' ? r.show as Record<string, unknown> : null;
  if (show && Array.isArray(show.cards)) for (const id of show.cards) if (isId(id)) add(id);
}

/** What one finished tool call showed, or null when it is not a stage verb that showed anything. */
export function cardsOfCall(item: { name: string; input: unknown; status: string; result?: unknown }): TurnCards | null {
  if (item.status !== 'done' || item.result === undefined) return null;
  const command = commandOf(item.input);
  if (!command || !SHOW_VERB.test(command)) return null;
  const turn: TurnCards = { ids: [], known: {}, groupOf: {} };
  const { whole, nested } = scanObjects(resultText(item.result));
  for (const r of whole) addResult(turn, r);
  // A result cut short on replay: its complete cards (and a group naming them) still count.
  if (nested.length && /\bsuper\s+open\b/.test(command)) {
    for (const r of nested) {
      if (isStateDump(r)) continue;
      const k = knownOf(r);
      if (k && !/^grp-/.test(k.id)) { turn.known[k.id] = k; if (!turn.ids.includes(k.id)) turn.ids.push(k.id); }
    }
    for (const r of nested) {
      if (isId(r.id) && /^grp-/.test(r.id) && Array.isArray(r.cards)) {
        for (const id of r.cards) if (isId(id) && turn.known[id]) turn.groupOf[id] = r.id;
      }
    }
  }
  return turn.ids.length ? turn : null;
}

/** A finished call's result never changes: read once per item object (a re-render reads none). */
const callCache = new WeakMap<object, TurnCards | null>();
function cachedCardsOfCall(item: { name: string; input: unknown; status: string; result?: unknown }): TurnCards | null {
  if (item.status !== 'done') return null;
  if (callCache.has(item)) return callCache.get(item) ?? null;
  const found = cardsOfCall(item);
  callCache.set(item, found);
  return found;
}

function merge(into: TurnCards, add: TurnCards): void {
  for (const id of add.ids) if (!into.ids.includes(id)) into.ids.push(id);
  Object.assign(into.known, add.known);
  Object.assign(into.groupOf, add.groupOf);
}

/** A turn's boundary: what the owner (or the server, for an event) sent. A stage strip is not one,
 *  nor a steer (his words folded into the turn that is running). */
function startsTurn(it: TurnItem): boolean {
  const u = it as { stageMedia?: unknown; steered?: unknown };
  return it.kind === 'user' && !u.stageMedia && !u.steered;
}

/**
 * Each answer that showed cards, by its text item's id. `items` is the whole conversation in
 * order (history then live). A card's record (`known`) is read from anywhere earlier in the
 * conversation too, so a `present` of a card an earlier turn opened still has its name.
 */
export function turnCardsByAnswer(items: readonly TurnItem[]): Map<string, TurnCards> {
  const out = new Map<string, TurnCards>();
  const everKnown: Record<string, KnownCard> = {};
  let turn: TurnCards | null = null;
  let answer: string | null = null;
  // A stretch that showed cards but wrote no answer yet (a steer replayed as a plain message after
  // a reload, an event turn that only opened) keeps its cards for the next answer: never dropped.
  const flush = () => {
    if (!turn || !answer) { answer = null; return; }
    if (turn.ids.length) {
      for (const id of turn.ids) if (!turn.known[id] && everKnown[id]) turn.known[id] = everKnown[id];
      turn.ids = turn.ids.slice(0, MAX_TURN_CARDS);
      out.set(answer, turn);
    }
    turn = null;
    answer = null;
  };
  for (const it of items) {
    if (startsTurn(it)) { flush(); continue; }
    if (it.kind === 'text') {
      if ((it as { text?: string }).text?.trim()) answer = it.id;
      continue;
    }
    if (it.kind !== 'tool') continue;
    const found = cachedCardsOfCall(it as { name: string; input: unknown; status: string; result?: unknown });
    if (!found) continue;
    Object.assign(everKnown, found.known);
    if (!turn) turn = { ids: [], known: {}, groupOf: {} };
    merge(turn, found);
  }
  flush();
  return out;
}

// ─── Tiles: the turn's cards against the stage as it is now ─────────────────────────────────

/** The slice of the live stage record a tile reads. */
export interface StageNow {
  containers: ReadonlyArray<{ id: string; kind: string; ref: string; title?: string; place: string }>;
  groups: ReadonlyArray<{ id: string; name: string; cards: readonly string[]; place: string }>;
}

export type TurnTile =
  /** One card, on the record (`live`) or only in the turn's own record (no live stage known). */
  | { kind: 'card'; key: string; card: KnownCard; place?: string }
  /** Cards of one group the turn showed: one tile, the group's first shown card as its face. */
  | { kind: 'group'; key: string; group: { id: string; name: string; place: string }; cards: KnownCard[] }
  /** Cards the stage no longer holds (the owner closed them): drawn from the turn's own record, a
   *  click opens them again; cards the turn grouped come back as one tile. Only when the file
   *  behind it is gone does the window draw a quiet "closed" line instead. */
  | { kind: 'reopen'; key: string; cards: KnownCard[]; name?: string };

/**
 * The tiles under an answer. With the live record (`now`), a card still there is drawn as it is
 * now (its title, its place), cards still together in one group become that group's tile, and
 * cards gone from the record become `reopen` tiles (one per group the turn put them in). Without
 * one (a surface that holds no stage record), the turn's own record draws each card it knows.
 * A card the turn cannot name (a `present` of a card opened before this conversation) is left out.
 */
export function turnTiles(turn: TurnCards, now: StageNow | null): TurnTile[] {
  const tiles: TurnTile[] = [];
  const doneGroups = new Set<string>();
  const reopenAt = new Map<string, number>(); // the turn's group id -> index of its reopen tile
  for (const id of turn.ids) {
    const known = turn.known[id];
    if (!now) {
      if (known) tiles.push({ kind: 'card', key: id, card: known });
      continue;
    }
    const live = now.containers.find((k) => k.id === id);
    if (!live) {
      if (!known) continue;
      const g = turn.groupOf[id];
      const at = g !== undefined ? reopenAt.get(g) : undefined;
      if (at !== undefined) { (tiles[at] as Extract<TurnTile, { kind: 'reopen' }>).cards.push(known); continue; }
      if (g !== undefined) reopenAt.set(g, tiles.length);
      tiles.push({ kind: 'reopen', key: `reopen:${g ?? id}`, cards: [known] });
      continue;
    }
    const card: KnownCard = { id, kind: live.kind, ref: live.ref, ...(live.title || known?.title ? { title: live.title || known?.title } : {}) };
    const group = now.groups.find((g) => g.cards.includes(id));
    // A group tile only for cards the turn showed together (two or more still in it).
    const together = group ? turn.ids.filter((x) => group.cards.includes(x) && now.containers.some((k) => k.id === x)) : [];
    if (group && together.length >= 2) {
      if (doneGroups.has(group.id)) continue;
      doneGroups.add(group.id);
      const cards = together.map((x) => {
        const k = now.containers.find((c) => c.id === x)!;
        return { id: x, kind: k.kind, ref: k.ref, ...(k.title ? { title: k.title } : {}) };
      });
      tiles.push({ kind: 'group', key: group.id, group: { id: group.id, name: group.name, place: group.place }, cards });
      continue;
    }
    tiles.push({ kind: 'card', key: id, card, place: live.place });
  }
  return tiles;
}

/** What the owner's own open (`POST /api/super/open`) takes to bring a closed card back: a kind
 *  and a ref, or a project file by its path. Null for a card he cannot open himself (a chat, a
 *  browser, a member): those never come back from a tile. */
export function reopenBody(card: KnownCard): { kind: 'web' | 'knowledge' | 'task' | 'insight' | 'whiteboard'; ref: string } | { path: string } | null {
  if (card.kind === 'web' || card.kind === 'knowledge' || card.kind === 'task' || card.kind === 'insight' || card.kind === 'whiteboard') return { kind: card.kind, ref: card.ref };
  if (card.kind === 'image' || card.kind === 'pdf' || card.kind === 'video' || card.kind === 'board') return { path: card.ref };
  return null;
}

/** A card that stands on a file of the project (its file can be gone): a picture, a PDF, a clip,
 *  a board, a project page. A web page off this machine, a task or an insight is not. */
export function isProjectFileCard(card: Pick<KnownCard, 'kind' | 'ref'>): boolean {
  if (card.kind === 'image' || card.kind === 'pdf' || card.kind === 'video' || card.kind === 'board') return true;
  return card.kind === 'web' && !/^[a-z][a-z0-9+.-]*:/i.test(card.ref);
}

/** A tile's own name: the card's title, else its file name, else what it points at. */
export function cardName(card: KnownCard): string {
  if (card.title) return card.title;
  const tail = card.ref.split(/[?#]/)[0].split('/').filter(Boolean).pop();
  return tail || card.ref;
}

/** The same cards, named the same: an answer can keep its object (and skip a re-render). */
export function sameTurnCards(a: TurnCards, b: TurnCards): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The stage move a tile's click asks for (the layout patch AgentSurface applies). */
export type BringPatch =
  | { cards?: Array<{ id: string; place: 'float' }>; view: { mode: 'half'; card: string } }
  | { cards?: Array<{ id: string; place: 'float' }>; view: { mode: 'present'; cards: string[] } };

/**
 * What bringing a tile back does: a card is shown side by side, a group presented whole (its first
 * cards, as its "Open all"), and either one comes out of Others first. Null when the stage no
 * longer holds it: the click then does nothing, and the tile already reads "closed".
 * `presentable` is the group's present set (superTypes `groupPresentCards`).
 */
export function bringPatch(
  target: { card: string } | { group: string }, now: StageNow,
  presentable: (g: StageNow['groups'][number]) => string[],
): BringPatch | null {
  if ('group' in target) {
    const g = now.groups.find((x) => x.id === target.group);
    const cards = g ? presentable(g) : [];
    if (!g || !cards.length) return null;
    return { ...(g.place === 'others' ? { cards: [{ id: g.id, place: 'float' as const }] } : {}), view: { mode: 'present', cards } };
  }
  const c = now.containers.find((k) => k.id === target.card);
  if (!c) return null;
  return { ...(c.place === 'others' ? { cards: [{ id: c.id, place: 'float' as const }] } : {}), view: { mode: 'half', card: c.id } };
}
