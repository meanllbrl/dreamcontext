import { containerIdFor } from './inbox.js';
import type { SuperChild, SuperState } from './types.js';

/**
 * One job, one owner (field 2026-10-20: a child that handed its work on kept working on it too,
 * two sessions edited one task, and the super forgot the old child's card).
 *
 * `super delegate --succeeds <old>` makes the new child the old one's SUCCESSOR: the old card
 * becomes the new child's (same place, group and view slot), the brief and the task link pass
 * on, and the old child is marked `succeededBy` and ended. While it still runs, `super state`
 * says so, and it says so too when two live children hold one task.
 */

/** The child's task link. `task` comes with the job list (super-board-build); read through a
 *  typed cast until then, so this works the moment it lands (pattern forward-compatible-field). */
export function taskOf(ch: SuperChild | undefined): string | null {
  const t = (ch as (SuperChild & { task?: unknown }) | undefined)?.task;
  return typeof t === 'string' && t ? t : null;
}

/**
 * Pass `from`'s card, brief and task to `to`, in the record (call inside `writeSuper`). The card
 * keeps its place, group and view slot under its new id. Returns the successor's card id, or
 * null when `from` had no card (the caller then makes one as for any child).
 */
export function succeedChild(s: SuperState, from: string, to: string, opts: { brief?: string } = {}): string | null {
  const old = s.children[from];
  const next = s.children[to];
  if (!old || !next || from === to) return null;
  if (!opts.brief && old.brief) next.brief = old.brief;
  const task = taskOf(old);
  if (task && !taskOf(next)) (next as SuperChild & { task?: string }).task = task;
  old.succeededBy = to;

  const card = s.containers.find((k) => k.kind === 'chat' && k.ref === from);
  if (!card) return null;
  // The successor may already have a card of its own (delegate makes one): the old one wins,
  // it is where the owner put the work.
  const own = s.containers.find((k) => k.kind === 'chat' && k.ref === to);
  if (own) {
    s.containers = s.containers.filter((k) => k !== own);
    for (const g of s.groups) g.cards = g.cards.filter((id) => id !== own.id);
  }
  const was = card.id;
  const id = containerIdFor('chat', to);
  card.ref = to;
  card.id = id;
  if (opts.brief) card.title = opts.brief;
  for (const g of s.groups) g.cards = g.cards.map((c) => (c === was ? id : c));
  if (s.view.card === was) s.view.card = id;
  if (s.view.cards) s.view.cards = s.view.cards.map((c) => (c === was ? id : c));
  return id;
}

export type OwnershipWarning =
  | { kind: 'same-task'; task: string; children: string[]; message: string }
  | { kind: 'succeeded-still-live'; child: string; by: string; message: string };

/**
 * What `super state` warns about: two live children on one task, and a succeeded child still
 * running. `live` = the children a process runs right now.
 */
export function ownershipWarnings(s: Pick<SuperState, 'children'>, live: (sid: string) => boolean): OwnershipWarning[] {
  const out: OwnershipWarning[] = [];
  const byTask = new Map<string, string[]>();
  for (const [sid, ch] of Object.entries(s.children)) {
    if (!live(sid)) continue;
    if (ch.succeededBy) {
      out.push({
        kind: 'succeeded-still-live', child: sid, by: ch.succeededBy,
        message: `${sid} handed its work to ${ch.succeededBy} but still runs: \`dreamcontext super end ${sid}\` once its turn ends`,
      });
    }
    const task = taskOf(ch);
    if (task) byTask.set(task, [...(byTask.get(task) ?? []), sid]);
  }
  for (const [task, children] of byTask) {
    if (children.length < 2) continue;
    out.push({
      kind: 'same-task', task, children,
      message: `${children.length} live children work on task ${task}: one job has one owner, end the others (\`dreamcontext super end\`)`,
    });
  }
  return out;
}

/** What the old child hears when it is still busy as its successor takes over. */
export const SUCCESSOR_STOP_TEXT = 'Stop now: a successor session has taken over this work. Make no more changes, '
  + 'start nothing new, and end your turn with one line saying where you stopped.';
