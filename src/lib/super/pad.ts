/**
 * The agenda notepad keeps itself true (owner 2026-10-27: "the agenda goes stale" — a job
 * finished before noon and its Now line stayed until he asked). Two structural rules, pure, run
 * on every write of the record (`writeSuper`) and when an event batch is written:
 *
 * - A line linked to a job (`for`: a child's session id) FOLLOWS that job while it is the
 *   server's to move: Done once the job is done, ended or gone (`by: 'auto'`, `why`), back to
 *   Now when the job works again. A line the owner moved by hand (`by: 'owner'`) is never moved
 *   by the server again; a line the super moved itself (`note done`) is its own.
 * - A Now line with NO job behind it that has not changed for PAD_STALE_MS is stale, and so is
 *   such a Waiting line left from an earlier day: the card folds it (nothing is deleted, the owner
 *   closes it there), `super state` flags it and the super is told ONCE to keep or close it.
 * - A line about a job replaces its unlinked twin; an answered question closes the Waiting line
 *   about it (`padAbout`).
 * - A new day: a Done line from before today drops off by itself (owner 2026-10-28: yesterday's
 *   results still sat on the card as today's) into its day file (pad-archive.ts), his included.
 * - A line the owner wrote himself (`ownerLine`) is his: none of these rules acts on it.
 *
 * Every auto move and every stale line is told to the super once, in the next event batch
 * (`padNotice`), so it can reverse a wrong move (`note keep` / `note add`); the owner sees the
 * move on the card and can put it back with one press.
 */
import { MAX_PAD_REFS, MSG_REF_RE, PAD_STALE_MS, type PadAutoWhy, type PadRef, type PadStatus, type SuperPadItem, type SuperState } from './types.js';

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** A line the owner wrote himself: no automatic rule acts on it (never moved, twin-removed,
 *  answer-closed, folded stale, told about, or cleared by `note clear`). The Super's explicit
 *  note commands still change it. */
export function ownerLine(p: Pick<SuperPadItem, 'author'>): boolean {
  return p.author === 'owner';
}

/** A line's `refs` as stored: valid pairs only (a six-character ref, a finite non-negative
 *  time), oldest first, at most `max` (the oldest go). Undefined when none is left. */
export function cleanPadRefs(raw: unknown, max: number = MAX_PAD_REFS): PadRef[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: PadRef[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const { ref, at } = r as Record<string, unknown>;
    if (typeof ref !== 'string' || !MSG_REF_RE.test(ref)) continue;
    if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) continue;
    out.push({ ref, at });
  }
  out.sort((a, b) => a.at - b.at);
  const kept = out.length > max ? out.slice(out.length - max) : out;
  return kept.length ? kept : undefined;
}

/**
 * ajanda-filtre C1: the owner message `pair` moved the work of the line `note` (by id), or of
 * every line `for` the child `child`. Appended inside the caller's write; an identical pair
 * already on a line is skipped (a retried call), the same words in another turn are a new pair.
 */
export function linkLineRef(s: Pick<SuperState, 'pad'>, target: { note?: string; child?: string }, pair: PadRef): void {
  if (!s.pad || !MSG_REF_RE.test(pair.ref) || !Number.isFinite(pair.at)) return;
  const hit = (p: SuperPadItem) => (target.note !== undefined && p.id === target.note) || (target.child !== undefined && p.for === target.child);
  s.pad = s.pad.map((p) => {
    if (!hit(p)) return p;
    const have = p.refs ?? [];
    if (have.some((r) => r.ref === pair.ref && r.at === pair.at)) return p;
    return { ...p, refs: cleanPadRefs([...have, pair]) };
  });
}

/** A line's status, of five (types.ts PAD_STATUSES), from its stored section and stage. */
export function padStatus(p: Pick<SuperPadItem, 'section' | 'stage'>): PadStatus {
  if (p.section === 'done') return 'done';
  if (p.section === 'waiting') return 'waiting';
  return p.stage === 'todo' ? 'not-started' : p.stage === 'almost' ? 'almost-done' : 'in-progress';
}

/** `p` in `status`, stamped `now` (every change is an update, a stage-only one included). Pure:
 *  `by`, `why` and `toldAt` are the caller's. */
export function withPadStatus(p: SuperPadItem, status: PadStatus, now: number): SuperPadItem {
  const { stage: _s, ...rest } = p;
  const section = status === 'done' ? 'done' : status === 'waiting' ? 'waiting' : 'now';
  const stage = status === 'not-started' ? 'todo' as const : status === 'almost-done' ? 'almost' as const : undefined;
  return { ...rest, section, ...(stage ? { stage } : {}), at: now };
}

/** Why the job a line is about is over, or null while it still runs (or waits). */
export function padJobOver(s: Pick<SuperState, 'children'>, sid: string): PadAutoWhy | null {
  if (!own(s.children, sid)) return 'gone';
  const ch = s.children[sid];
  if (ch.endedAt !== undefined) return 'ended';
  if (ch.row === 'done') return 'done';
  if (ch.row === 'gone') return 'gone';
  return null;
}

/** The start of `now`'s day, local time (the owner's day, on his machine). */
export function padDayStart(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** A line nobody has touched for PAD_STALE_MS and no job keeps true (one with no job, or one the
 *  owner put back by hand: the server no longer moves it, so only this flag can): a Now line, or
 *  a Waiting line left from an earlier day (what he was to do yesterday has often been done). */
export function padStale(p: SuperPadItem, now: number): boolean {
  if (ownerLine(p)) return false;
  if (p.for && p.by !== 'owner') return false;
  if (now - p.at < PAD_STALE_MS) return false;
  return p.section === 'now' || (p.section === 'waiting' && p.at < padDayStart(now));
}

/** A Done line from an earlier day that the server drops: its day is over. His own lines and his
 *  moves too: the store keeps every dropped Done line whole in its day file (pad-archive.ts). */
export function padRolledOff(p: SuperPadItem, now: number): boolean {
  return p.section === 'done' && p.at < padDayStart(now);
}

/** The job is plainly running again: a row that is only cleared for a moment (a gone child
 *  starting again) is not, so a closed line never flips back and forth. */
const WORKS = new Set(['working', 'asking', 'waiting', 'stuck']);

/** Move linked lines with their jobs and drop an earlier day's Done lines. Mutates `s`; true
 *  when the pad changed. */
export function settlePad(s: SuperState, now = Date.now()): boolean {
  const pad = s.pad;
  if (!pad?.length) return false;
  const stay: SuperPadItem[] = [];
  const moved: SuperPadItem[] = [];
  let dropped = false;
  for (const p of pad) {
    if (padRolledOff(p, now)) { dropped = true; continue; }
    if (!p.for || p.by === 'owner' || ownerLine(p)) { stay.push(p); continue; }
    const over = padJobOver(s, p.for);
    if (p.section === 'now' && over) {
      // Done goes to the end of the pad (the newest finished line), stamped now, like `note done`.
      const { toldAt: _t, ...rest } = p;
      moved.push({ ...rest, section: 'done', at: now, by: 'auto', why: over });
    } else if (p.section === 'done' && p.by === 'auto' && !over && WORKS.has(s.children[p.for]?.row ?? '')) {
      // Its job works again (the super sent it more): the line is true in Now again.
      const { by: _b, why: _w, toldAt: _t, ...rest } = p;
      moved.push({ ...rest, section: 'now', at: now });
    } else {
      stay.push(p);
    }
  }
  if (!moved.length && !dropped) return false;
  s.pad = [...stay, ...moved];
  return true;
}

/** What the super must hear about its pad in the next event batch: each auto move and each stale
 *  line not yet told. Once: a stale line it left alone rests folded on the card. Empty = nothing. */
export function padNotice(s: Pick<SuperState, 'pad'>, now = Date.now()): { lines: string[]; ids: string[] } {
  const lines: string[] = [];
  const ids: string[] = [];
  for (const p of s.pad ?? []) {
    if (ownerLine(p)) continue;
    const told = p.toldAt !== undefined && p.toldAt >= p.at;
    if (p.by === 'auto' && p.section === 'done' && !told) {
      lines.push(p.why === 'answered'
        ? `- note=${p.id} moved Waiting -> Done by itself: he answered the question it is about. Line: "${p.text}"`
        : `- note=${p.id} moved Now -> Done by itself: its job (child=${p.for}) is ${p.why}. Line: "${p.text}"`);
      ids.push(p.id);
    } else if (padStale(p, now) && !told) {
      lines.push(`- note=${p.id} has stood in ${p.section === 'now' ? 'Now' : 'Waiting'} unchanged for ${Math.floor((now - p.at) / 60_000)} min and nothing moves it by itself. Line: "${p.text}"`);
      ids.push(p.id);
    }
  }
  if (!lines.length) return { lines, ids };
  return {
    lines: [
      '[agenda] The owner reads these lines on his agenda card:',
      ...lines,
      'For each: a line moved to Done whose work really goes on → `dreamcontext super note drop <id>`, then write it again without a job, `super note add now "<line>"`; a stale line that still holds → `dreamcontext super note keep <id>` (a line that says "today" or "tomorrow" from an earlier day: drop it and write it again with the day or date); one that is over or that he did → `super note done <id>` (or `drop <id>`). No text to the owner for this.',
    ],
    ids,
  };
}

/** The words that carry a line's meaning: no digits, no short fillers. */
function padWords(text: string): Set<string> {
  return new Set(text.toLocaleLowerCase('tr').split(/[^\p{L}]+/u).filter((w) => w.length >= 4));
}

/** Do these two say the same thing? At least 3 shared words, 60 % of the shorter one's. */
export function padAbout(a: string, b: string): boolean {
  const x = padWords(a);
  const y = padWords(b);
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared >= 3 && shared >= 0.6 * Math.min(x.size, y.size);
}

/** A line the super wrote freehand and nothing else keeps true. */
const unlinked = (p: SuperPadItem) => !p.for && p.by !== 'owner' && !ownerLine(p);

/** A job's line arrives: its older unlinked twin in Now goes, the new line says the same. A
 *  Waiting line is his and a stale one rests folded: neither is deleted on a likeness. Pure. */
export function withoutTwins(pad: readonly SuperPadItem[], text: string, now = Date.now()): SuperPadItem[] {
  return pad.filter((p) => ownerLine(p) || !(unlinked(p) && p.section === 'now' && !padStale(p, now) && padAbout(p.text, text)));
}

/** He answered this question: the Waiting line about it moves to Done (seen on the card, told to
 *  the super, reversible). Mutates `s`. */
export function closeAnswered(s: SuperState, question: string, now = Date.now()): void {
  if (!s.pad || !question) return;
  s.pad = s.pad.map((p) => (unlinked(p) && p.section === 'waiting' && padAbout(p.text, question)
    ? { ...p, section: 'done' as const, at: now, by: 'auto' as const, why: 'answered' as const } : p));
}

/** Stamp the lines a delivered batch told the super about. Mutates `s`. */
export function markPadTold(s: SuperState, ids: readonly string[], now = Date.now()): void {
  if (!ids.length || !s.pad) return;
  const set = new Set(ids);
  s.pad = s.pad.map((p) => (set.has(p.id) ? { ...p, toldAt: Math.max(now, p.at) } : p));
}
