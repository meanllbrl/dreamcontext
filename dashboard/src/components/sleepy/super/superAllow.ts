/**
 * The window half of `super allow` (the Super Agent answering its Bypass child's residual
 * permission) and of the owner's Allow/Deny from the phone (`by: 'owner'`, relayed by
 * POST /api/agent/super-permission). The server already checked who may answer; the window
 * re-checks what only it can see: the child is this Super's, its tab is open, and the request
 * is a PERMISSION card still pending. A question or a plan approval is never answered here.
 */
import type { PendingItem } from '../chatSession';

export type SuperAllowResult = { ok: true } | { ok: false; error: string };

/** The part of a ChatSession this needs (kept narrow so it can be tested without a socket). */
export interface AllowTarget {
  getModel(): { pending: readonly PendingItem[] };
  answer(requestId: string, opts: { behavior: 'allow' | 'deny'; updatedInput?: unknown; message?: string }): boolean;
}

export function superAllow(
  args: Record<string, unknown>,
  isChild: (child: string) => boolean,
  chatOf: (child: string) => AllowTarget | null | undefined,
): SuperAllowResult {
  const child = typeof args.child === 'string' ? args.child : '';
  const requestId = typeof args.requestId === 'string' ? args.requestId : '';
  const behavior = args.behavior === 'allow' || args.behavior === 'deny' ? args.behavior : null;
  if (!behavior || !requestId) return { ok: false, error: 'bad_request' };
  if (!child || !isChild(child)) return { ok: false, error: 'not_a_child' };
  const cs = chatOf(child);
  if (!cs) return { ok: false, error: 'child_not_open' };
  const p = cs.getModel().pending.find((x) => x.kind === 'permission' && x.requestId === requestId);
  if (!p || p.kind !== 'permission') return { ok: false, error: 'no_such_permission' };
  const message = typeof args.message === 'string' && args.message.trim()
    ? args.message
    : (args.by === 'owner' ? 'Declined by the owner.' : 'Declined by the Super Agent.');
  const written = behavior === 'allow'
    ? cs.answer(requestId, { behavior: 'allow', updatedInput: p.input })
    : cs.answer(requestId, { behavior: 'deny', message });
  // Not written (the child's socket is down): the card stays, and saying so is the honest
  // answer, never a reported answer nobody received.
  return written ? { ok: true } : { ok: false, error: 'not_connected' };
}
