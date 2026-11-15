import { dirname } from 'node:path';
import { approveAutomation, registerProject, revokeApproval, type ApprovalEntry, type ConditionWitness } from '../lib/automations/registry.js';
import { setAutomationEnabled } from '../lib/automations/store.js';
import { settleApprovalQuestions } from '../lib/automations/hitl.js';
import { approvalCardFacts, type ApprovalCardFacts } from '../lib/automations/approval-card.js';
import { tellSuperAutomationDecision } from '../lib/super/automation-event.js';
import type { AutomationManifest } from '../lib/automations/types.js';

/**
 * THE owner's yes and no on an automation's approval card, whichever door it came through: the
 * chat card, the AI Team page, the Super's band (all `POST /api/automations/:slug/approve|reject`)
 * and the Telegram card (telegram/automation-approvals.ts). One body, so a Telegram Onayla does
 * exactly what the app's Onayla does.
 *
 * It decides, it does not authorize: every caller has already proved the owner is the one
 * deciding (the owner-page check on the routes, the paired Telegram account on the hub) and that
 * the manifest is his (`refuseNotOwner` / `foreignOwner`). The condition witness is enforced by
 * the registry: a condition is stamped only on the hash the owner was shown, and a moved disk
 * throws `ConditionNeedsWitness` with nothing written.
 */

export interface DecisionResult {
  card: ApprovalCardFacts;
  /** A Super event was queued: the card that sits in its chat need not report it again. */
  told: boolean;
}

/** Queue the decision for the Super Agent when the card sits in its chat (or a child's). */
async function tellSuper(contextRoot: string, sessionId: unknown, slug: string, decision: 'approved' | 'rejected'): Promise<boolean> {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(sessionId)) return false;
  try {
    return await tellSuperAutomationDecision(contextRoot, sessionId, slug, decision);
  } catch {
    // The decision itself is written; a super that cannot hear it reads it from `show`.
    return false;
  }
}

/**
 * Approve: stamp the manifest as the owner's consent (`owner-page`, which covers a Super turn or
 * a Telegram reply too, super-rutin C2), close the approval questions it left open, turn it on
 * when `enable` (the card's "Approve and turn on"; `enabled` is not hashed, so the grant stands),
 * and tell the Super. Throws `ConditionNeedsWitness` when the witness does not cover the script.
 */
export async function approveAsOwner(
  contextRoot: string,
  manifest: AutomationManifest,
  opts: { witness?: ConditionWitness; enable?: boolean; sessionId?: unknown } = {},
): Promise<DecisionResult & { entry: ApprovalEntry }> {
  const projectRoot = dirname(contextRoot);
  registerProject(projectRoot);
  const entry = approveAutomation(projectRoot, manifest, new Date(), undefined, 'owner-page', opts.witness);
  settleApprovalQuestions(contextRoot, manifest.slug);
  const after = opts.enable === true && !manifest.enabled ? setAutomationEnabled(contextRoot, manifest.slug, true) : manifest;
  const told = await tellSuper(contextRoot, opts.sessionId, manifest.slug, 'approved');
  return { entry, card: approvalCardFacts(projectRoot, after), told };
}

/**
 * Reject: any approval it had here is withdrawn and it is turned off, so it neither runs nor
 * asks again on every fire. The file stays: deleting is the AI Team page's explicit step. An
 * approval left standing would let any session's `automations enable` run it on the grant he
 * just withdrew.
 */
export async function rejectAsOwner(contextRoot: string, manifest: AutomationManifest, opts: { sessionId?: unknown } = {}): Promise<DecisionResult> {
  revokeApproval(dirname(contextRoot), manifest.slug);
  const after = manifest.enabled ? setAutomationEnabled(contextRoot, manifest.slug, false) : manifest;
  const told = await tellSuper(contextRoot, opts.sessionId, manifest.slug, 'rejected');
  return { card: approvalCardFacts(dirname(contextRoot), after), told };
}
