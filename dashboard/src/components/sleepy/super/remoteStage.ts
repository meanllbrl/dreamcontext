/**
 * The Super Agent's stage on a REMOTE screen (hands-free sekmeler W2, D5-D7): a computer or a
 * landscape tablet on Mac mode's tunnel draws the same stage the Mac does, from the server's
 * allowlisted view (`GET /api/agent/super-stage` and the `super_stage` frames on the Super's
 * mirror), never the record. It reads and arranges; the Mac window stays the Super's bridge, so
 * hand-over, take-back, a fresh session, ending a child, closing, grouping or parking a card stay
 * on the Mac (their keys are refused remotely, and the stage does not offer them).
 *
 * The view is widened into the stage's own state type (`SuperStateView`) with empty defaults and
 * read through the same `readSuperStateView` the Mac's pushes go through. A card the remote
 * cannot show (a loopback web page, the live browser, an absolute path) arrives with no address:
 * its `ref` is empty here, and the card draws the "on the Mac" placeholder.
 */
import type { ApiClient } from '../../../api/client';
import { RequestError } from '../../../api/client';
import type { SuperRemoteView } from '../../handsfree/macContract';
import { SUPER_STATE_VERSION, readSuperStateView, type SuperStateView } from '../../../lib/superTypes';
import type { LayoutPatch } from './superLayout';

/** The stage's state from the remote view. Null when the view is not one. */
export function remoteStageState(view: unknown): SuperStateView | null {
  if (!view || typeof view !== 'object') return null;
  const v = view as Partial<SuperRemoteView>;
  if (!Array.isArray(v.containers) || !Array.isArray(v.groups) || !v.view || typeof v.vault !== 'string') return null;
  const children: Record<string, unknown> = {};
  for (const [sid, ch] of Object.entries(v.children ?? {})) {
    children[sid] = { ...ch, sessionId: sid, brief: '', adopted: false };
  }
  return readSuperStateView({
    v: SUPER_STATE_VERSION,
    vault: v.vault,
    session: v.session ?? null,
    enabled: v.enabled === true,
    containers: v.containers.map((c) => ({ ...c, ref: c.blocked ? '' : (c.ref ?? '') })),
    groups: v.groups,
    view: v.view,
    children,
    // What waits on the owner, as the queue items the agenda and the question bar read.
    queue: (v.waiting ?? []).map((w) => ({ id: w.id, sessionId: w.sessionId, kind: w.kind, state: w.state, createdAt: w.createdAt, ...(w.text ? { ownerText: w.text } : {}) })),
    notes: {},
    away: { since: null, events: 0 },
    dismissed: [],
    pool: [],
    ownerBatches: v.ownerBatches ?? [],
    team: [],
    pad: v.pad ?? [],
    ...(v.rotating ? { rotating: true } : {}),
  });
}

/** `GET /api/agent/super-stage`: the stage, or `'off'` (the project is not handed over: a 409 that
 *  is an answer, never an error, e.g. during a take-back), or null (unreachable). */
export async function fetchRemoteStage(api: ApiClient): Promise<SuperStateView | 'off' | null> {
  try {
    return remoteStageState(await api.get<unknown>('/agent/super-stage'));
  } catch (err) {
    if (err instanceof RequestError && err.status === 409) return 'off';
    return null;
  }
}

/** The keys a remote screen may send (the server's allowlist, super-remote.ts). */
const REMOTE_KEYS = new Set(['cards', 'presentLayout', 'chat', 'exit', 'agenda', 'view']);

/**
 * The part of a stage gesture a remote screen may send, or null when nothing is left. Closing,
 * grouping, ungrouping, parking a card in Others and the look reports stay on the Mac; a view is
 * sent only in the shapes the server checks (float, half on a card, present on cards). The stage
 * offers none of the refused gestures remotely; this is the second guard.
 */
export function remoteLayoutPatch(patch: LayoutPatch): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(patch)) {
    if (!REMOTE_KEYS.has(k) || val === undefined) continue;
    if (k === 'cards') {
      const cards = (val as NonNullable<LayoutPatch['cards']>).filter((c) => c.place !== 'others')
        .map((c) => ({ id: c.id, ...(c.pos !== undefined ? { pos: c.pos } : {}), ...(c.size !== undefined ? { size: c.size } : {}), ...(c.order ? { order: c.order } : {}), ...(c.place ? { place: c.place } : {}) }));
      if (cards.length) out.cards = cards;
      continue;
    }
    if (k === 'exit') { out.exit = { cards: (val as { cards: string[] }).cards, closing: [] }; continue; }
    if (k === 'view') {
      const vw = val as { mode?: string; card?: string; cards?: string[] };
      if (vw.mode === 'float') out.view = { mode: 'float' };
      else if (vw.mode === 'half' && vw.card) out.view = { mode: 'half', card: vw.card };
      else if (vw.mode === 'present' && vw.cards?.length) out.view = { mode: 'present', cards: vw.cards };
      continue;
    }
    out[k] = val;
  }
  return Object.keys(out).length ? out : null;
}

/** `POST /api/agent/super-stage/layout`: the stage after the gesture (null: nothing to send). */
export async function postRemoteLayout(api: ApiClient, patch: LayoutPatch): Promise<SuperStateView | null> {
  const body = remoteLayoutPatch(patch);
  if (!body) return null;
  const r = await api.post<{ state?: unknown }>('/agent/super-stage/layout', body);
  return remoteStageState(r?.state);
}
