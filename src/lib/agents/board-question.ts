import { dirname } from 'node:path';
import { AutomationError } from '../automations/types.js';
import { getRunTarget } from '../automations/store.js';
import { liftBoardHold } from '../automations/registry.js';
import { boardEnvelopeView, type BoardEnvelopeView } from '../automations/board-scope.js';
import type { AutomationManifest } from '../automations/types.js';
import { ownerEdit } from './amendments.js';
import { getAgent, restampTargets } from './store.js';

/**
 * THE ONE QUESTION an old home-board agent owes the owner (owner 2026-11-07): "Should <title> still
 * be limited to its board?". Until this version a home board limited every agent on it; now it
 * only presents, and the limit is the opt-in `scope: board`. An agent approved before that change
 * is held limited on this Mac (`registry.ts` `boardHoldIn`) until the owner answers here:
 *
 *  - keep: `scope: board` is written into its file, by the owner's own edit, so it stamps; the
 *    limit is now its own, visible in its Edit dialog, and syncs with the file;
 *  - lift: every held approval of it (its call target, its legacy record, its routines) is marked
 *    `open` on this Mac, so it runs under its autonomy level like any member.
 *
 * Owner-only: the CLI verb and the route refuse a session and an agent run, as `approve` does.
 */
export function answerBoardScope(
  contextRoot: string,
  slug: string,
  keep: boolean,
  opts: { home?: string; now?: Date } = {},
): { title: string; kept: boolean } {
  const agent = getAgent(contextRoot, slug, opts.home);
  const target = getRunTarget(contextRoot, slug, 'agent');
  if (!agent || !target) throw new AutomationError(`No agent named "${slug}" in this project.`);
  const projectRoot = dirname(contextRoot);
  const view = agentBoardView(contextRoot, slug, target, opts.home);
  if (!view.question) {
    throw new AutomationError(`${agent.title} has no open question about its board: ${view.board ? (view.limited ? 'it is limited by its own scope: board' : 'it already runs under its autonomy level') : 'it has no home board'}.`);
  }
  if (keep) {
    ownerEdit(contextRoot, slug, { boardOnly: true }, { home: opts.home, now: opts.now, why: 'kept on its board when asked once' });
    return { title: agent.title, kept: true };
  }
  const moved = liftBoardHold(projectRoot, restampTargets(contextRoot, slug).map(({ kind, target: t }) => ({ kind, slug: t.slug })), opts.home);
  // Nothing held moved (a concurrent answer got there first): never report a lift that did not happen.
  if (moved === 0) throw new AutomationError(`${agent.title} has no open question about its board any more.`);
  return { title: agent.title, kept: false };
}

/**
 * The board view of agent `slug` as the owner is asked about it: its call target's, plus the
 * question when any routine of it is still held. A routine approved before this version keeps its
 * own unmarked entry, while its agent may have been approved (open) since, so the agent's entry
 * alone would never ask, and the routine would stay limited with no way to lift it.
 */
export function agentBoardView(contextRoot: string, slug: string, target: AutomationManifest, home?: string): BoardEnvelopeView {
  const projectRoot = dirname(contextRoot);
  const view = boardEnvelopeView(projectRoot, target, home);
  if (view.question || !view.board || target.boardOnly === true) return view;
  const routineHeld = restampTargets(contextRoot, slug).some(({ kind, target: t }) => kind === 'automation' && boardEnvelopeView(projectRoot, t, home).question);
  return routineHeld ? { ...view, question: true } : view;
}
