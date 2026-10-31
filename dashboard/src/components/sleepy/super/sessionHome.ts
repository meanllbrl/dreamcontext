/**
 * Which window a session belongs to, in the new shell (owner 2026-10-31): every session has ONE
 * home. The Super Agent's sessions (the ones it started, the ones it adopted, live or ended) live in
 * the Super Agent's window and never enter a chat window; everything else is the owner's and lives
 * in its chat window. This file is the rule, read by every door: the tab strip, the drawer's rows
 * and counts, History, links and the window verbs.
 *
 * It is a VIEW. Nothing here removes a session from the roster, the panes or a transcript: a tab
 * the rule hides is still saved, so absence never deletes, and the classic shell shows it as ever.
 * The record's `formerChildren` keeps ownership past the hand-over that prunes an ended child.
 */
import type { SuperState } from '../../../lib/superTypes';
import { isSuperSession, ownerQueueCount } from './superHandover';

export type SessionHome = 'super' | 'chat';

type Owned = Pick<SuperState, 'session' | 'children'> & { formerChildren?: readonly string[] };

/** Every conversation the record says is the Super Agent's, with the children being opened now. */
export function superOwnedIds(
  state: Owned | null | undefined,
  delegated: ReadonlyMap<string, number> = new Map(),
): Set<string> {
  const ids = new Set<string>(delegated.keys());
  if (!state) return ids;
  if (state.session) ids.add(state.session);
  for (const id of Object.keys(state.children)) ids.add(id);
  for (const id of state.formerChildren ?? []) ids.add(id);
  return ids;
}

export function sessionHome(
  meta: { mode?: string; claudeId?: string } | null | undefined,
  owned: ReadonlySet<string>,
  superSession?: string | null,
): SessionHome {
  if (!meta) return 'chat';
  if (isSuperSession(meta, superSession)) return 'super';
  return meta.claudeId && owned.has(meta.claudeId) ? 'super' : 'chat';
}

export interface HomePane { id: string; tabs: string[]; active: string }

/** A window's panes as a chat window draws them: only the tabs that live there. A pane left empty
 *  is not drawn; a pane whose focused tab left falls back to its first own tab. */
export function chatWindowPanes<P extends HomePane>(panes: readonly P[], livesHere: (tabId: string) => boolean): P[] {
  const out: P[] = [];
  for (const p of panes) {
    const tabs = p.tabs.filter(livesHere);
    if (!tabs.length) continue;
    out.push(tabs.length === p.tabs.length ? p : { ...p, tabs, active: tabs.includes(p.active) ? p.active : tabs[0] });
  }
  return out;
}

/**
 * Where a pick of a Super session lands (History, a link, a notification): its card on the stage,
 * or the stage with its transcript read-only when it has no card any more. Never a chat window.
 */
export function superLanding(
  claudeId: string,
  state: Pick<SuperState, 'session' | 'containers'> | null | undefined,
): 'centre' | 'card' | 'transcript' {
  if (state?.session === claudeId) return 'centre';
  return state?.containers.some((c) => c.kind === 'chat' && c.ref === claudeId) ? 'card' : 'transcript';
}

/** The Super Agent row's two marks, from the record alone. A child counts while it works (never an
 *  ended one, never a finished one); `asking`: the Super or a child waits on the owner. */
export function superRowMarks(state: Pick<SuperState, 'children' | 'queue'> | null | undefined): { working: number; asking: boolean } {
  if (!state) return { working: 0, asking: false };
  const working = Object.values(state.children).filter((c) => c?.endedAt === undefined && c.row === 'working').length;
  return { working, asking: ownerQueueCount(state) > 0 };
}

/**
 * The corner of a page (owner 2026-10-31): in the new shell only the Super Agent's pill stands
 * there. Chats are reached from the rail and the drawer, never from a floating list.
 */
export function pageCorner(o: { newShell: boolean; superPill: boolean; superDock: boolean; chips: number }): 'super' | 'fab' | 'chips' | 'none' {
  if (o.superPill) return 'super';
  if (o.newShell || o.superDock) return 'none';
  return o.chips === 0 ? 'fab' : 'chips';
}
