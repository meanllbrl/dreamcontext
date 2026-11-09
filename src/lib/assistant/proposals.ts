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

/** Not an assistant verb: a dreamcontext App asking to use a project `.mcp.json` server
 *  (src/lib/apps/mcp-bridge.ts). Never in ASSISTANT_VERBS, never in the assistant brief. */
export type ProposalVerb = AssistantVerb | 'app-mcp-accept' | AppRequestVerb;

/** An agent asks for one app action; the owner's Onayla mints a one-time grant (app-onay-karti C4).
 *  Decided by a click only, with the owner key for approve AND reject, and the card's hash. */
export const APP_REQUEST_VERBS = ['app-publish', 'app-update', 'app-install', 'app-logo'] as const;
export type AppRequestVerb = typeof APP_REQUEST_VERBS[number];
export const APP_PROPOSAL_TIMEOUT_MS = 24 * 3600_000;

export function isAppRequestVerb(v: unknown): v is AppRequestVerb {
  return typeof v === 'string' && (APP_REQUEST_VERBS as readonly string[]).includes(v);
}

/** One line of an app request card: the server's label, a value (agent words only ever here). */
export interface AppCardLine { label: string; value: string; tone?: 'warn' | 'bad' }

/** What an app request card shows; its hash is the action plan's (C3). No request id here: any
 *  local process can read the proposal list. */
export interface AppCardView {
  action: 'publish' | 'update' | 'install' | 'logo';
  appName: string;
  vault: string;
  title: string;
  lines: AppCardLine[];
  warn?: string;
  /** The snapshotted logo (`/api/apps/requests/<proposal id>/logo`), for a logo card. */
  image?: string;
  renewal?: boolean;
  hash: string;
}

export interface ProposalView {
  id: string;
  verb: ProposalVerb;
  target: string;
  text: string;
  /** Why it is a proposal: `ask` level, taint, or a tool-permission answer. */
  provenance: string;
  createdAt: string;
  /** Present on an app request card only. */
  app?: AppCardView;
}

export type ProposalDecision =
  | { outcome: 'approved'; text: string }
  | { outcome: 'declined'; reason: 'rejected' | 'timeout' | 'shutdown' | 'abandoned' | 'withdrawn' };

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

/** The app request module settles its own card (Onayla, Reddet, a Telegram tap, a newer request,
 *  a stale plan). Its decision promise mints nothing: the request module does. */
export function closeProposal(id: string, d: ProposalDecision): boolean {
  return settle(id, d);
}

/** The app request module fills its card's view once the proposal id exists (the image path). */
export function setProposalApp(id: string, app: AppCardView): void {
  const p = pending.get(id);
  if (p) p.view = { ...p.view, app };
}

export function getProposal(id: string): ProposalView | null {
  const p = pending.get(id);
  return p ? { ...p.view } : null;
}

export function listProposals(): ProposalView[] {
  return [...pending.values()].map((p) => ({ ...p.view }));
}

export function declineAllProposals(): void {
  for (const id of [...pending.keys()]) settle(id, { outcome: 'declined', reason: 'shutdown' });
}
