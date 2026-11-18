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
 * In memory and bounded by time: a line is kept an hour at most and taken once; the same kind of
 * failure is told at most once per ten minutes, so a Super that re-sends and fails again never
 * loops on its own notes.
 */

export type UndeliveredKind = 'text' | 'voice' | 'picture' | 'card';

/** One kind of failure is told again only after this long (a re-send that fails again). */
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

/** A sender's failure: what of the Super's answer did not reach him, in one line. */
export function noteUndelivered(sessionId: string | null | undefined, kind: UndeliveredKind, line: string, now = Date.now()): void {
  if (!sessionId || !line.trim()) return;
  prune(now);
  const list = pending.get(sessionId) ?? [];
  if (!list.some((e) => e.kind === kind && e.line === line)) list.push({ kind, line: line.trim().slice(0, 300), at: now });
  pending.set(sessionId, list);
  for (const fn of [...listeners]) {
    try { fn(sessionId); } catch { /* a listener's failure is its own */ }
  }
}

/** The lines to tell the Super now (each kind once per `UNDELIVERED_TELL_MS`), taken. */
export function takeUndelivered(sessionId: string, now = Date.now()): string[] {
  prune(now);
  const list = pending.get(sessionId);
  pending.delete(sessionId);
  if (!list) return [];
  const out: string[] = [];
  const toldNow = new Set<UndeliveredKind>();
  for (const e of list) {
    const k = `${sessionId}\u0000${e.kind}`;
    if (lastTold.has(k) && !toldNow.has(e.kind)) continue;
    toldNow.add(e.kind);
    lastTold.set(k, now);
    out.push(e.line);
  }
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
    ...lines.map((l) => `- ${l}`),
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
