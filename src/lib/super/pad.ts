/**
 * The agenda notepad keeps itself true (owner 2026-10-27: "the agenda goes stale" — a job
 * finished before noon and its Now line stayed until he asked). Two structural rules, pure, run
 * on every write of the record (`writeSuper`) and when an event batch is written:
 *
 * - A line linked to a job (`for`: a child's session id) FOLLOWS that job while it is the
 *   server's to move: Done once the job is done, ended or gone (`by: 'auto'`, `why`), back to
 *   Now when the job works again. A line the owner moved by hand (`by: 'owner'`) is never moved
 *   by the server again; a line the super moved itself (`note done`) is its own.
 * - A Now line with NO job behind it that has not changed for PAD_STALE_MS is stale: `super
 *   state` flags it and the next event batch asks the super to keep it or close it.
 *
 * Every auto move and every stale line is told to the super once, in the next event batch
 * (`padNotice`), so it can reverse a wrong move (`note keep` / `note add`); the owner sees the
 * move on the card and can put it back with one press.
 */
import { PAD_STALE_MS, type PadAutoWhy, type SuperPadItem, type SuperState } from './types.js';

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** Why the job a line is about is over, or null while it still runs (or waits). */
export function padJobOver(s: Pick<SuperState, 'children'>, sid: string): PadAutoWhy | null {
  if (!own(s.children, sid)) return 'gone';
  const ch = s.children[sid];
  if (ch.endedAt !== undefined) return 'ended';
  if (ch.row === 'done') return 'done';
  if (ch.row === 'gone') return 'gone';
  return null;
}

/** A Now line nobody has touched for PAD_STALE_MS and no job keeps true: one with no job, or
 *  one the owner put back by hand (the server no longer moves it, so only this flag can). */
export function padStale(p: SuperPadItem, now: number): boolean {
  return p.section === 'now' && (!p.for || p.by === 'owner') && now - p.at >= PAD_STALE_MS;
}

/** The job is plainly running again: a row that is only cleared for a moment (a gone child
 *  starting again) is not, so a closed line never flips back and forth. */
const WORKS = new Set(['working', 'asking', 'waiting', 'stuck']);

/** Move linked lines with their jobs. Mutates `s`; true when the pad changed. */
export function settlePad(s: SuperState, now = Date.now()): boolean {
  const pad = s.pad;
  if (!pad?.length) return false;
  const stay: SuperPadItem[] = [];
  const moved: SuperPadItem[] = [];
  for (const p of pad) {
    if (!p.for || p.by === 'owner') { stay.push(p); continue; }
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
  if (!moved.length) return false;
  s.pad = [...stay, ...moved];
  return true;
}

/** What the super must hear about its pad in the next event batch: each auto move not yet told,
 *  and each stale line not told within the last PAD_STALE_MS. Empty = nothing. */
export function padNotice(s: Pick<SuperState, 'pad'>, now = Date.now()): { lines: string[]; ids: string[] } {
  const lines: string[] = [];
  const ids: string[] = [];
  for (const p of s.pad ?? []) {
    const told = p.toldAt !== undefined && p.toldAt >= p.at;
    if (p.by === 'auto' && p.section === 'done' && !told) {
      lines.push(`- note=${p.id} moved Now -> Done by itself: its job (child=${p.for}) is ${p.why}. Line: "${p.text}"`);
      ids.push(p.id);
    } else if (padStale(p, now) && !(p.toldAt !== undefined && now - p.toldAt < PAD_STALE_MS)) {
      lines.push(`- note=${p.id} has stood in Now unchanged for ${Math.floor((now - p.at) / 60_000)} min and nothing moves it by itself. Line: "${p.text}"`);
      ids.push(p.id);
    }
  }
  if (!lines.length) return { lines, ids };
  return {
    lines: [
      '[agenda] The owner reads these lines on his agenda card:',
      ...lines,
      'For each: a line moved to Done whose work really goes on → `dreamcontext super note drop <id>`, then write it again without a job, `super note add now "<line>"`; a stale line that still holds → `dreamcontext super note keep <id>`; one that is over → `super note done <id>` (or `drop <id>`). No text to the owner for this.',
    ],
    ids,
  };
}

/** Stamp the lines a delivered batch told the super about. Mutates `s`. */
export function markPadTold(s: SuperState, ids: readonly string[], now = Date.now()): void {
  if (!ids.length || !s.pad) return;
  const set = new Set(ids);
  s.pad = s.pad.map((p) => (set.has(p.id) ? { ...p, toldAt: Math.max(now, p.at) } : p));
}
