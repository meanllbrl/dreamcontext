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
 * - a chat whose child works, asks, is stuck or waits on the owner, has any open queue item (a
 *   waiting question), or whose process the registry says is busy, whatever its row still says
 *   (live.ts: a LIVE job is always a floating card, owner 2026-10-23).
 * A finished job (done), an ended child, or a gone one moves on the idle clock counted from when
 * its row last moved: a child gone after an app restart that registers again is live (and its
 * card comes back, live.ts); one that never does leaves the stage 45 minutes later.
 * A group moves only when every card in it may.
 *
 * "Touched" = opened by the super (`super open`), changed by anyone (place, size, position,
 * title, group, view), opened by the owner (a group panel, full screen: the window's `touch`), or
 * for a chat its child's row moving. Kept in memory per vault: a server restart starts every
 * card's clock again, so nothing is swept at once after one.
 */
import { resolve } from 'node:path';
import type { SuperState } from './types.js';
import { chatIsBusy, childIsLive, type BusyTest } from './live.js';

export const TIDY_IDLE_MS = 45 * 60_000;
export const TIDY_TICK_MS = 60_000;

/** Verify only: a shorter idle bar and tick (scripts/verify/super-image-group.mjs). */
function envMs(name: string): number | null {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 ? v : null;
}
const idleMs = () => envMs('DREAMCONTEXT_SUPER_TIDY_IDLE_MS') ?? TIDY_IDLE_MS;
const tickMs = () => envMs('DREAMCONTEXT_SUPER_TIDY_TICK_MS') ?? TIDY_TICK_MS;

interface Mark { sig: string; at: number }
/** Per vault: each card's and group's last seen signature and when it last changed. */
const marks = new Map<string, Map<string, Mark>>();

/** One key per vault, however its root was spelled. */
const keyOf = (root: string) => resolve(root);

function marksOf(root: string): Map<string, Mark> {
  const key = keyOf(root);
  let m = marks.get(key);
  if (!m) { m = new Map(); marks.set(key, m); }
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
export function planTidy(s: SuperState, touched: (id: string) => number | undefined, now: number, busy: BusyTest = chatIsBusy): string[] {
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
      if (openFor.has(c.ref) || childIsLive(s, c.ref, busy)) return undefined;
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

// ─── The clock ─────────────────────────────────────────────────────────────────────

export interface TidyIo {
  read: (root: string) => Promise<SuperState>;
  write: (root: string, fn: (s: SuperState) => void) => Promise<unknown>;
}

const vaults = new Set<string>();
let timer: ReturnType<typeof setInterval> | null = null;
let io: TidyIo | null = null;

/** One pass over one vault: marks up to date, then what is due goes to Others. */
export async function tidyOnce(root: string, how: TidyIo, now = Date.now()): Promise<string[]> {
  const s = await how.read(root);
  if (!s.enabled) { vaults.delete(keyOf(root)); return []; }
  const m = refreshMarks(marksOf(root), s, now);
  const touched = (id: string) => m.get(id)?.at;
  if (!planTidy(s, touched, now).length) return [];
  let moved: string[] = [];
  await how.write(root, (d) => {
    if (!d.enabled) return;
    // What changed since the read above (a card the owner brought back, one the super opened)
    // counts as touched before anything moves.
    refreshMarks(m, d, now);
    moved = planTidy(d, touched, now);
    applyTidy(d, moved);
  });
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
  io = null;
}
