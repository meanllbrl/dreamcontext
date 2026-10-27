/**
 * The stage tidies itself (owner 2026-10-22: "Kullanılmayan, artık önemli olmayan kartlar
 * kalabalık oluşturuyor"). A floating card or group nobody touched for TIDY_IDLE_MS, or a
 * finished child's card the owner has seen in the agenda, goes to Others. Never closed.
 *
 * Never moved:
 * - what the owner placed (a drop position) or sized himself;
 * - what the view shows (side by side, presented);
 * - a card the server opened on its own (a dev server, a live browser: they follow their child);
 * - the agenda card (the super's notepad: it lives on the stage until the owner moves it);
 * - a chat whose child works, asks or is stuck, or has any open queue item (a waiting question).
 * A group moves only when every card in it may.
 *
 * "Touched" = opened by the super (`super open`), changed by anyone (place, size, position,
 * title, group, view), opened by the owner (a group panel, full screen: the window's `touch`), or
 * for a chat its child's row moving. Kept in memory per vault: a server restart starts every
 * card's clock again, so nothing is swept at once after one.
 */
import { resolve } from 'node:path';
import type { SuperState } from './types.js';

/**
 * The same clock also ENDS finished jobs (owner 2026-10-27: "buradaki eski sessionlar da
 * kapanmıyor"; six told results sat in Others as parked chats for hours because the super forgot
 * `super end`). A delegated child whose job is done, whose result reached the super (its `done`
 * event was delivered) or the owner (he saw it in the agenda), with nothing open, untouched for
 * RETIRE_IDLE_MS since the latest of its finish, his last touch of its card (opening it, his
 * focus on its tab, dormant or not), his seen click in the agenda and his focus on its process, is ended exactly as `super end` ends one: the process closes through
 * the park primitive, the card goes, the transcript stays and `super resume` reopens it.
 *
 * One hour, longer than the 45-minute stack: a finished card goes stage -> Others -> ended, and
 * the 10-minute idle park has long freed its process. Never ended: a child working, asking,
 * stuck or waiting on the owner, one with an open queue item, the owner's own chat (adopted), a
 * card he placed or sized, or one the view shows.
 */
export const RETIRE_IDLE_MS = 60 * 60_000;

export const TIDY_IDLE_MS = 45 * 60_000;
export const TIDY_TICK_MS = 60_000;

/** Verify only: a shorter idle bar and tick (scripts/verify/super-image-group.mjs). */
function envMs(name: string): number | null {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 ? v : null;
}
const idleMs = () => envMs('DREAMCONTEXT_SUPER_TIDY_IDLE_MS') ?? TIDY_IDLE_MS;
const tickMs = () => envMs('DREAMCONTEXT_SUPER_TIDY_TICK_MS') ?? TIDY_TICK_MS;
/** Verify only: a shorter retire bar (scripts/verify/super-retire.mjs). */
export const retireMs = () => envMs('DREAMCONTEXT_SUPER_RETIRE_MS') ?? RETIRE_IDLE_MS;

interface Mark { sig: string; at: number }
/** Per vault: each card's and group's last seen signature and when it last changed. */
const marks = new Map<string, Map<string, Mark>>();
/** Per vault: when this process first saw it. Nothing is older than this to the retire clock,
 *  so a server restart ends nothing at once (the owner's touches before it are not known). */
const since = new Map<string, number>();

/** One key per vault, however its root was spelled. */
const keyOf = (root: string) => resolve(root);

function marksOf(root: string): Map<string, Mark> {
  const key = keyOf(root);
  let m = marks.get(key);
  if (!m) { m = new Map(); marks.set(key, m); since.set(key, Date.now()); }
  return m;
}

const shownIds = (s: Pick<SuperState, 'view'>): string[] =>
  s.view.mode === 'half' && s.view.card ? [s.view.card] : s.view.mode === 'present' ? s.view.cards ?? [] : [];

/** What anyone changing a card or a group changes. */
function signatures(s: SuperState): Map<string, string> {
  const shown = new Set(shownIds(s));
  const groupOf = new Map(s.groups.flatMap((g) => g.cards.map((id) => [id, g.id] as const)));
  const out = new Map<string, string>();
  for (const c of s.containers) {
    out.set(c.id, JSON.stringify([c.place, c.size ?? '', c.sizeBy ?? '', c.pos ?? null, c.title ?? '', groupOf.get(c.id) ?? '', shown.has(c.id)]));
  }
  for (const g of s.groups) out.set(g.id, JSON.stringify([g.place, g.pos ?? null, g.name, g.cards]));
  return out;
}

/** Bring the marks up to the record: a new or changed card or group was touched `now`. Pure on
 *  the map it is handed (returned for tests). */
export function refreshMarks(m: Map<string, Mark>, s: SuperState, now: number): Map<string, Mark> {
  const sigs = signatures(s);
  for (const [id, sig] of sigs) {
    const had = m.get(id);
    if (!had || had.sig !== sig) m.set(id, { sig, at: now });
  }
  for (const id of [...m.keys()]) if (!sigs.has(id)) m.delete(id);
  return m;
}

/** The super or the owner opened these: touched now. */
export function touchCards(root: string, ids: readonly string[], now = Date.now()): void {
  const m = marksOf(root);
  for (const id of ids) {
    const had = m.get(id);
    m.set(id, { sig: had?.sig ?? '', at: now });
  }
}

/**
 * The top-level floating items (ungrouped cards, groups) to put in Others now. Pure: `touched`
 * answers when a card or a group was last touched (undefined: just now).
 */
export function planTidy(s: SuperState, touched: (id: string) => number | undefined, now: number): string[] {
  const shown = new Set(shownIds(s));
  const grouped = new Set(s.groups.flatMap((g) => g.cards));
  const openFor = new Set(s.queue.filter((q) => q.state !== 'done').map((q) => q.sessionId));
  const bar = idleMs();
  const idle = (id: string) => now - (touched(id) ?? now) >= bar;
  const at = (id: string) => touched(id) ?? now;
  /** When each 'seen' card's job was seen: a group goes on that path only if untouched since. */
  const seenWhen = new Map<string, number>();
  /** undefined: this card holds its place; 'seen': a finished job he saw, and the card not
   *  touched since (he brought it back: it stays, on the idle clock); 'idle': untouched. */
  const verdict = (id: string): 'seen' | 'idle' | undefined => {
    const c = s.containers.find((k) => k.id === id);
    if (!c || shown.has(id) || c.by === 'auto' || c.sizeBy === 'owner' || c.kind === 'agenda') return undefined;
    if (c.kind === 'chat' || c.kind === 'browser') {
      const ch = s.children[c.ref];
      if (openFor.has(c.ref)) return undefined;
      if (ch) {
        if (ch.row !== 'done' && ch.row !== 'gone' && ch.endedAt === undefined) return undefined;
        if (ch.finishedAt !== undefined && ch.seenAt !== undefined && ch.seenAt >= ch.finishedAt && at(id) < ch.seenAt) {
          seenWhen.set(id, ch.seenAt);
          return 'seen';
        }
        const active = Math.max(at(id), ch.rowAt ?? ch.startedAt);
        return now - active >= bar ? 'idle' : undefined;
      }
    }
    return idle(id) ? 'idle' : undefined;
  };
  const out: string[] = [];
  for (const c of s.containers) {
    if (c.place !== 'float' || grouped.has(c.id) || c.pos) continue;
    if (verdict(c.id)) out.push(c.id);
  }
  for (const g of s.groups) {
    if (g.place !== 'float' || g.pos) continue;
    const vs = g.cards.map(verdict);
    if (!vs.every((v) => v)) continue;
    const seen = g.cards.filter((id) => seenWhen.has(id)).map((id) => seenWhen.get(id)!);
    if (idle(g.id) || (seen.length && at(g.id) < Math.min(...seen))) out.push(g.id);
  }
  return out;
}

/** Put them in Others (in place: the caller's locked write). */
export function applyTidy(s: SuperState, ids: readonly string[]): void {
  for (const id of ids) {
    const c = s.containers.find((k) => k.id === id);
    if (c) { c.place = 'others'; continue; }
    const g = s.groups.find((k) => k.id === id);
    if (g) g.place = 'others';
  }
}

// ─── Retire: finished, told, untouched jobs end ────────────────────────────────────

/** What only the live registry knows about a child's process. */
export interface RetireLive {
  /** The registry's activity (`idle`, `working`, `asking`, `starting`, `stale`) or `gone`. */
  status: string;
  /** The owner's last sign of attention to it (0 = none): a focus frame from its live tab, or
   *  his seen click in the agenda ({@link noteSeenClick}). */
  ownerAt: number;
}

/** Why one child is kept, or null when it is due. Pure. `clockFrom`: nothing is older than it. */
export function retireKeep(
  s: SuperState, sid: string, touched: (id: string) => number | undefined, live: RetireLive, now: number, clockFrom = 0,
): string | null {
  const ch = s.children[sid];
  if (!ch || sid === s.session) return 'unknown';
  if (ch.endedAt !== undefined) return 'ended';
  if (ch.adopted) return 'adopted';
  if (ch.row !== 'done' && ch.row !== 'gone') return ch.row ?? 'no_row';
  if (ch.finishedAt === undefined) return 'no_row';
  if (live.status !== 'idle' && live.status !== 'gone') return live.status;
  if (s.queue.some((q) => q.sessionId === sid && q.state !== 'done')) return 'open_item';
  // Told: its done event reached the super after this finish (a gone row keeps the finish of
  // the done before it, so a chat that died mid-work never counts), or the owner saw it. Only a
  // DELIVERED item counts: delivery stamps its batch, a stale item dropped unsent has none.
  const told = s.queue.some((q) => q.sessionId === sid && q.kind === 'done' && q.state === 'done' && q.batch !== undefined && q.createdAt >= ch.finishedAt!)
    || (ch.row === 'done' && ch.seenAt !== undefined && ch.seenAt >= ch.finishedAt);
  if (!told) return 'untold';
  const shown = new Set(shownIds(s));
  const cards = s.containers.filter((c) => c.kind === 'chat' && c.ref === sid);
  if (cards.some((c) => shown.has(c.id))) return 'shown';
  if (cards.some((c) => c.pos || c.sizeBy === 'owner')) return 'owner_placed';
  const last = Math.max(clockFrom, ch.finishedAt, ch.seenAt ?? 0, live.ownerAt, ...cards.map((c) => touched(c.id) ?? now));
  return now - last >= retireMs() ? null : 'recent';
}

/** The children to end now. Pure. */
export function planRetire(
  s: SuperState, touched: (id: string) => number | undefined, live: (sid: string) => RetireLive, now: number, clockFrom = 0,
): string[] {
  return Object.keys(s.children).filter((sid) => retireKeep(s, sid, touched, live(sid), now, clockFrom) === null);
}

/** Per vault: when the owner last clicked a job seen in the agenda (`POST /api/super/seen`).
 *  Its own clock, not a card touch: the tidy's "seen goes to Others" path compares card touches
 *  with `seenAt`, and a touch after it would hold the card on the stage. */
const seenClicks = new Map<string, Map<string, number>>();

export function noteSeenClick(root: string, sids: readonly string[], now = Date.now()): void {
  const key = keyOf(root);
  let m = seenClicks.get(key);
  if (!m) { m = new Map(); seenClicks.set(key, m); }
  for (const sid of sids) m.set(sid, now);
}

export function seenClickAt(root: string, sid: string): number {
  return seenClicks.get(keyOf(root))?.get(sid) ?? 0;
}

/** When the retire clock of this vault started (this process first ticked it). */
export function retireClockFrom(root: string): number {
  marksOf(root);
  return since.get(keyOf(root)) ?? Date.now();
}

/** A card's last touch, as the tidy clock knows it (undefined: never seen yet). */
export function touchedAt(root: string, id: string): number | undefined {
  return marks.get(keyOf(root))?.get(id)?.at;
}

// ─── The clock ─────────────────────────────────────────────────────────────────────

export interface TidyIo {
  read: (root: string) => Promise<SuperState>;
  write: (root: string, fn: (s: SuperState) => void) => Promise<unknown>;
  /** The server's half of retiring (absent: the clock only tidies). `live` reads the registry;
   *  `end` ends the planned children the way `super end` does, re-checking each under the lock. */
  retire?: { live: (root: string, sid: string) => RetireLive; end: (root: string, sids: string[]) => Promise<unknown> };
}

const vaults = new Set<string>();
let timer: ReturnType<typeof setInterval> | null = null;
let io: TidyIo | null = null;

/** One pass over one vault: marks up to date, then what is due goes to Others. */
export async function tidyOnce(root: string, how: TidyIo, now = Date.now()): Promise<string[]> {
  let s = await how.read(root);
  if (!s.enabled) { vaults.delete(keyOf(root)); return []; }
  const m = refreshMarks(marksOf(root), s, now);
  const touched = (id: string) => m.get(id)?.at;
  let moved: string[] = [];
  if (planTidy(s, touched, now).length) {
    await how.write(root, (d) => {
      if (!d.enabled) return;
      // What changed since the read above (a card the owner brought back, one the super opened)
      // counts as touched before anything moves.
      refreshMarks(m, d, now);
      moved = planTidy(d, touched, now);
      applyTidy(d, moved);
      // Its own move is not a touch: the moved cards keep their clock (the retire bar reads it).
      const sigs = signatures(d);
      for (const id of moved) { const had = m.get(id); const sig = sigs.get(id); if (had && sig) had.sig = sig; }
    });
    if (how.retire) s = await how.read(root);
  }
  if (how.retire && s.enabled) {
    const due = planRetire(s, touched, (sid) => how.retire!.live(root, sid), now, retireClockFrom(root));
    // A failed end is logged and retried next tick; it never stops this vault's tidying.
    if (due.length) await how.retire.end(root, due).catch((err: unknown) => { console.warn(`[super] ${root}: ending finished children failed: ${(err as Error)?.message ?? err}`); });
  }
  return moved;
}

/** A vault's stage is in use: keep it tidy (one shared, unref'd clock for every vault). */
export function ensureTidy(root: string, how: TidyIo): void {
  io = how;
  vaults.add(keyOf(root));
  if (timer) return;
  timer = setInterval(() => {
    for (const r of [...vaults]) void tidyOnce(r, io!).catch(() => { vaults.delete(r); });
  }, tickMs());
  timer.unref?.();
}

/** Tests only. */
export function _resetTidy(): void {
  if (timer) clearInterval(timer);
  timer = null;
  vaults.clear();
  marks.clear();
  since.clear();
  seenClicks.clear();
  io = null;
}
