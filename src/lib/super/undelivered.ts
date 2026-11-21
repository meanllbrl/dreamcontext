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
 * In memory and bounded by time: a line is kept an hour at most. A different failure, even of the
 * same kind, is told at once (review r1, undelivered-dedupe-by-kind). The SAME line (kind + words)
 * failing again within ten minutes of being told is the Super's re-send failing the same way: it
 * already knows, so the repeat is dropped and the window starts again. A thing that fails every
 * time is told once while it keeps failing, never every ten minutes (review r2,
 * undelivered-retell-loop).
 *
 * A refused text names its section's own refs (`refs=abc,def`, super-sessiz-kalmaz D5) and the
 * note says to re-send it under the first one: a marked section goes to his bound chat even from
 * a turn that is not his Telegram turn, an unmarked re-send stays on the Mac (kitup, 21 Nov: "Buradan
 * yaz bitti mi" 40 s after an unmarked re-send). With the refs on the line, the same section failing
 * again under the same refs within ten minutes is dropped as a repeat: the first note told it.
 */

export type UndeliveredKind = 'text' | 'voice' | 'picture' | 'card';

/** The same line is told again only after this long without failing again. */
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
const toldKey = (sessionId: string, kind: UndeliveredKind, line: string): string => `${sessionId}\u0000${kind}\u0000${line}`;

/** A sender's failure: what of the Super's answer did not reach him, in one line. */
export function noteUndelivered(sessionId: string | null | undefined, kind: UndeliveredKind, line: string, now = Date.now()): void {
  const clean = line.trim().slice(0, 300);
  if (!sessionId || !clean) return;
  prune(now);
  // Told within the window and failing again: the Super knows; the window starts again.
  const k = toldKey(sessionId, kind, clean);
  if (lastTold.has(k)) { lastTold.set(k, now); return; }
  const list = pending.get(sessionId) ?? [];
  const same = list.find((e) => e.kind === kind && e.line === clean);
  if (same) same.at = now; else list.push({ kind, line: clean, at: now });
  pending.set(sessionId, list);
  for (const fn of [...listeners]) {
    try { fn(sessionId); } catch { /* a listener's failure is its own */ }
  }
}

/** The lines to tell the Super now, taken: each pending line once. */
export function takeUndelivered(sessionId: string, now = Date.now()): string[] {
  prune(now);
  const list = pending.get(sessionId);
  pending.delete(sessionId);
  if (!list) return [];
  for (const e of list) lastTold.set(toldKey(sessionId, e.kind, e.line), now);
  return list.map((e) => e.line);
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
    'Never say it was sent, is ready or is there. Tell him in one short line what did not arrive, then send it again in a way that reaches him, or say where it is (the Mac). A line with refs=<ref>[,<ref>…]: send that answer again, shorter, in its own section opening `<!-- re:<the first ref> -->` on its first line; only a marked section reaches his phone from this turn. Do not mention this note itself.',
    `</${UNDELIVERED_TAG}>`,
  ].join('\n');
}

/** Test-only. */
export function _resetUndelivered(): void {
  pending.clear();
  lastTold.clear();
  listeners.clear();
}
