import type { ServerResponse } from 'node:http';
import { sendError } from '../middleware.js';
import { ConditionNeedsWitness, manifestHash, type ConditionWitness } from '../../lib/automations/registry.js';
import type { AutomationManifest } from '../../lib/automations/types.js';

/**
 * The ONE witness rule of every owner-page approve door (kosullu-otomasyon C2): the routine's
 * approve and the agent's approve alike. The page sends `shownHash`, the `manifestHash` of the
 * detail it drew; a condition is stamped only on that, and a disk that moved since he looked is
 * refused with 409 `condition_unseen`, stamping nothing. It proves the hash is fresh, not who
 * sent it: the owner-page check in front of each door is the boundary.
 */

/** What a detail payload carries so a door can draw the script and send its hash back. */
export function conditionFacts(m: AutomationManifest): {
  condition: string | null;
  conditionWake: boolean;
  conditionError: string | null;
  manifestHash: string;
} {
  return {
    condition: m.condition ?? null,
    conditionWake: m.conditionWake !== false,
    conditionError: m.conditionError ?? null,
    manifestHash: manifestHash(m),
  };
}

/** The witness a body brings, or a 409 already sent (null) when a condition came unseen. */
export function shownWitness(res: ServerResponse, m: AutomationManifest, body: Record<string, unknown>): ConditionWitness | undefined | null {
  const shownHash = typeof body.shownHash === 'string' ? body.shownHash : '';
  if (m.condition && !shownHash) {
    sendError(res, 409, 'condition_unseen', 'Not approved: it has a condition script. Read the script on its card again and approve what you see.');
    return null;
  }
  return shownHash ? { kind: 'shown', hash: shownHash } : undefined;
}

/** A stamp the registry refused for want of a witness: 409, so the page re-reads. */
export function sendIfConditionUnseen(res: ServerResponse, err: unknown): boolean {
  if (!(err instanceof ConditionNeedsWitness)) return false;
  sendError(res, 409, 'condition_unseen', err.message);
  return true;
}
