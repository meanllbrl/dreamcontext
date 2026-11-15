/**
 * The owner sets an agenda line's status by hand (the card's status circle, Done and Put back,
 * and Telegram's /gundem **Bitti**, plan N6/P4): `by: 'owner'`, so the server never moves it again
 * (pad.ts; pattern: the agent must not undo what the owner did). Moved to the end of the pad,
 * stamped now when its status changed (a stage-only change too: it is an update).
 *
 * `mark`: the request is proven his (the shell's owner key, or the Telegram owner): the change is
 * recorded for his next message to the Super IN THE SAME WRITE (owner-marks.ts). Done on a line
 * whose job still runs closes the line and leaves the job alone; no event turn is queued.
 */
import { writeSuper } from './inbox.js';
import { padStatus, withPadStatus } from './pad.js';
import { tryOwnerMark } from './owner-marks.js';
import { PAD_ID_RE, type PadStatus, type SuperId, type SuperState } from './types.js';

export async function padMove(
  contextRoot: string,
  id: string,
  status: PadStatus,
  superId: SuperId = 'main',
  opts: { mark?: boolean } = {},
): Promise<{ found: boolean; state: SuperState | null }> {
  if (!PAD_ID_RE.test(id)) return { found: false, state: null };
  let found = false;
  const state = await writeSuper(contextRoot, superId, (s) => {
    const have = (s.pad ?? []).find((p) => p.id === id);
    if (!have) return;
    found = true;
    const from = padStatus(have);
    const now = Date.now();
    const { why: _w, toldAt: _t, ...rest } = have;
    const moved = from === status ? { ...rest, by: 'owner' as const } : { ...withPadStatus(rest, status, now), by: 'owner' as const };
    s.pad = [...(s.pad ?? []).filter((p) => p.id !== id), moved];
    if (opts.mark && from !== status) tryOwnerMark(s, { key: `pad:${id}`, kind: 'pad-status', text: have.text, from, to: status, at: now });
  });
  return { found, state: (state as SuperState | undefined) ?? null };
}
