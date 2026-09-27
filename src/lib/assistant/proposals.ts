import { randomUUID } from 'node:crypto';
import type { AssistantVerb } from './autonomy.js';

/**
 * Proposals — a gated assistant verb waiting for the owner.
 *
 * The CLI call that produced it BLOCKS on {@link Proposal.decision} until the owner approves,
 * edits or rejects it in the notch, or until {@link PROPOSAL_TIMEOUT_MS} passes
 * (`declined:timeout`). Nothing is persisted: an app quit declines every pending proposal
 * ({@link declineAllProposals}) — nothing is sent that the owner did not see.
 */

export const PROPOSAL_TIMEOUT_MS = 10 * 60_000;

export interface ProposalView {
  id: string;
  verb: AssistantVerb;
  target: string;
  text: string;
  /** Why it is a proposal: `ask` level, taint, or a tool-permission answer. */
  provenance: string;
  createdAt: string;
}

export type ProposalDecision =
  | { outcome: 'approved'; text: string }
  | { outcome: 'declined'; reason: 'rejected' | 'timeout' | 'shutdown' | 'abandoned' };

interface Pending { view: ProposalView; resolve: (d: ProposalDecision) => void; timer: ReturnType<typeof setTimeout> }

const pending = new Map<string, Pending>();

export function createProposal(
  input: Omit<ProposalView, 'id' | 'createdAt'>,
  timeoutMs: number = PROPOSAL_TIMEOUT_MS,
): { view: ProposalView; decision: Promise<ProposalDecision> } {
  const view: ProposalView = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
  const decision = new Promise<ProposalDecision>((resolve) => {
    const timer = setTimeout(() => settle(view.id, { outcome: 'declined', reason: 'timeout' }), timeoutMs);
    timer.unref?.();
    pending.set(view.id, { view, resolve, timer });
  });
  return { view, decision };
}

function settle(id: string, d: ProposalDecision): boolean {
  const p = pending.get(id);
  if (!p) return false;
  clearTimeout(p.timer);
  pending.delete(id);
  p.resolve(d);
  return true;
}

/** Owner's answer from the notch. `edit` approves with the owner's own text. */
export function resolveProposal(id: string, action: 'approve' | 'edit' | 'reject', text?: string): boolean {
  const p = pending.get(id);
  if (!p) return false;
  if (action === 'reject') return settle(id, { outcome: 'declined', reason: 'rejected' });
  const finalText = action === 'edit' && typeof text === 'string' && text.trim() ? text : p.view.text;
  return settle(id, { outcome: 'approved', text: finalText });
}

/**
 * The call waiting on this proposal went away (the CLI was killed — a Bash tool timeout — or
 * its socket closed). Nobody can act on the answer any more, so it must never run: an approval
 * landing after the caller gave up (and maybe retried) would send the text anyway, or twice.
 */
export function abandonProposal(id: string): boolean {
  return settle(id, { outcome: 'declined', reason: 'abandoned' });
}

export function listProposals(): ProposalView[] {
  return [...pending.values()].map((p) => ({ ...p.view }));
}

export function declineAllProposals(): void {
  for (const id of [...pending.keys()]) settle(id, { outcome: 'declined', reason: 'shutdown' });
}
