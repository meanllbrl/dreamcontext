/**
 * What the Super sent that never reached the owner, told back to the Super (Doc's 7-day friction
 * report, 2026-11-18, finding 4: 51 "it is ready / I sent it" claims in a week for a voice, a
 * picture or a card he never got; "onay kartı falan yok tekrar yalan söylüyor", "Gelmedi",
 * "fotoğraflar gözükmüyor").
 *
 * The Telegram side always knew: it logged `pictures 0/3 NOT ALL SENT`, fell back from a voice to
 * text, told the owner "Bu kart Telegram'a gitmedi". Only the Super never heard it, so it kept
 * saying "sent". Every such failure is noted here by the sender, and the Super's chat hands the
 * lines to the Super as one hidden note: at its turn's end, or at once when it is idle (a voice
 * fails seconds after the turn ended).
 *
 * In memory and bounded by time: a line is kept an hour at most. The SAME line (kind + words) is
 * told at most once per ten minutes, so a Super that re-sends one thing and fails again never loops
 * on its own notes; a line inside that window is deferred (kept for a later take), never dropped,
 * and a different failure of the same kind is told at once (review r1, undelivered-dedupe-by-kind).
 */

export type UndeliveredKind = 'text' | 'voice' | 'picture' | 'card';

/** The same line is told again only after this long (a re-send that fails again). */
export const UNDELIVERED_TELL_MS = 10 * 60_000;
/** A line nobody took within this long is history. */
export const UNDELIVERED_KEEP_MS = 60 * 60_000;

interface Entry { kind: UndeliveredKind; line: string; at: number }

const pending = new Map<string, Entry[]>();
const lastTold = new Map<string, number>();
const listeners = new Set<(sessionId: string) => void>();

function prune(now: number): void {
  for (const [sid, list] of pending) {
    const fresh = list.filter((e) => now - e.at < UNDELIVERED_KEEP_MS);
    if (fresh.length) pending.set(sid, fresh); else pending.delete(sid);
  }
  for (const [k, at] of lastTold) if (now - at >= UNDELIVERED_TELL_MS) lastTold.delete(k);
}

/** One line's identity for the ten-minute window: the session, its kind and its words. */
const toldKey = (sessionId: string, e: Entry): string => `${sessionId}\u0000${e.kind}\u0000${e.line}`;

/** A sender's failure: what of the Super's answer did not reach him, in one line. */
export function noteUndelivered(sessionId: string | null | undefined, kind: UndeliveredKind, line: string, now = Date.now()): void {
  const clean = line.trim().slice(0, 300);
  if (!sessionId || !clean) return;
  prune(now);
  const list = pending.get(sessionId) ?? [];
  const same = list.find((e) => e.kind === kind && e.line === clean);
  if (same) same.at = now; else list.push({ kind, line: clean, at: now });
  pending.set(sessionId, list);
  for (const fn of [...listeners]) {
    try { fn(sessionId); } catch { /* a listener's failure is its own */ }
  }
}

/** The lines to tell the Super now, taken. A line told within `UNDELIVERED_TELL_MS` stays pending
 *  for a later take: deferred, never lost. */
export function takeUndelivered(sessionId: string, now = Date.now()): string[] {
  prune(now);
  const list = pending.get(sessionId);
  if (!list) return [];
  const out: string[] = [];
  const later: Entry[] = [];
  for (const e of list) {
    const k = toldKey(sessionId, e);
    if (lastTold.has(k)) { later.push(e); continue; }
    lastTold.set(k, now);
    out.push(e.line);
  }
  if (later.length) pending.set(sessionId, later); else pending.delete(sessionId);
  return out;
}

/** Be told a failure was noted (the Super's chat, to tell an idle Super at once). */
export function onUndelivered(fn: (sessionId: string) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export const UNDELIVERED_TAG = 'super-undelivered';

/** The hidden note's part for these lines, or null. */
export function undeliveredNote(lines: readonly string[]): string | null {
  if (!lines.length) return null;
  return [
    `<${UNDELIVERED_TAG}>`,
    'Part of what you sent did NOT reach the owner:',
    // A line can carry the Super's own words (a drawing's title): never a tag of its own.
    ...lines.map((l) => `- ${l.replace(/</g, '‹')}`),
    'Never say it was sent, is ready or is there. Tell him in one short line what did not arrive, then send it again in a way that reaches him, or say where it is (the Mac). Do not mention this note itself.',
    `</${UNDELIVERED_TAG}>`,
  ].join('\n');
}

/** Test-only. */
export function _resetUndelivered(): void {
  pending.clear();
  lastTold.clear();
  listeners.clear();
}
