import type { ServerResponse } from 'node:http';
import { sendError } from '../middleware.js';
import { foreignOwner, isNotOwnerError, NotOwnerError, type OwnedTarget } from '../../lib/agents/owner.js';

/**
 * The server half of "only the owner writes" (AI Team v2 B1-4). A teammate's agent or automation
 * arrives by the brain sync and is read-only here: every write route answers 403 `not_owner`,
 * naming the owner, before it touches anything. The stores and the approval registry refuse on
 * their own too (`assertOwned`); this only turns that into one status and one code.
 */

/** Send 403 `not_owner` and return true when `m` is someone else's. */
export function refuseNotOwner(res: ServerResponse, m: OwnedTarget & { slug: string; title?: string; agentTitle?: string }): boolean {
  const owner = foreignOwner(m);
  if (!owner) return false;
  const err = new NotOwnerError(owner, m.agentTitle || m.title || m.slug);
  sendError(res, 403, 'not_owner', err.message);
  return true;
}

/** In a catch: send 403 `not_owner` and return true when `err` is the owner refusal. */
export function sendIfNotOwner(res: ServerResponse, err: unknown): boolean {
  if (!isNotOwnerError(err)) return false;
  sendError(res, 403, 'not_owner', err.message);
  return true;
}
