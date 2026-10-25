/**
 * `replyGroups` exactly as 0.34.5 shipped it (840414ec, dashboard/src/components/sleepy/chat/
 * replyLinks.ts), frozen. The oracle for the rule "a block that ends with fewer than two sections
 * renders exactly as 0.34.5" (task super-in-tek-cevabi…, AC4): the tests compare the live map
 * with this one instead of re-deriving it. Never edit it to make a test pass.
 */
import { msgRef } from '../../../dashboard/src/lib/superTypes.js';
import { isOwnerMessage } from '../../../dashboard/src/components/sleepy/chat/replyLinks.js';
import type { ChatItem } from '../../../dashboard/src/components/sleepy/chatSession.js';

export interface ReplyGroup0345 { groupId: string; first: boolean; targets: string[]; strip: boolean }
interface Building { groupId: string; members: string[]; targets: string[]; strip: boolean }
const isStep = (it: ChatItem) => it.kind === 'tool' || it.kind === 'thinking';
const sameTargets = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export function replyGroups0345(entries: readonly ChatItem[]): Map<string, ReplyGroup0345> {
  const groups: Building[] = [];
  /** Every owner message so far, oldest first, with its reference. */
  const owners: Array<{ id: string; ref: string }> = [];
  /** Owner messages since the previous non-empty Super text (pick 2A). */
  let waiting: string[] = [];
  /** Step rows waiting for the text they lead to. */
  let pending: string[] = [];
  /** This turn's last group, which trailing rows (and a continuation) join. */
  let last: Building | null = null;
  /** The latest user item, and whether a Super text came after it: "directly above". */
  let lastUser: string | null = null;
  let textSinceUser = false;
  /** The turn was opened by an injected event, not by him. */
  let eventTurn = false;

  const closeTurn = () => {
    if (last && pending.length) last.members.push(...pending);
    pending = [];
    last = null;
  };

  for (const it of entries) {
    if (it.kind === 'user') {
      closeTurn();
      lastUser = it.id;
      textSinceUser = false;
      eventTurn = !isOwnerMessage(it);
      if (!eventTurn) {
        owners.push({ id: it.id, ref: msgRef(it.text) });
        waiting.push(it.id);
      }
      continue;
    }
    if (isStep(it)) { pending.push(it.id); continue; }
    if (it.kind !== 'text' || !it.text.trim()) continue;
    // A Super text: who it answers.
    let targets: string[];
    if (it.replyTo?.length) {
      targets = [];
      for (const ref of it.replyTo) {
        for (let i = owners.length - 1; i >= 0; i -= 1) {
          if (owners[i].ref !== ref) continue;
          if (!targets.includes(owners[i].id)) targets.push(owners[i].id);
          break;
        }
      }
    } else if (eventTurn) {
      targets = last ? last.targets : [];
    } else if (waiting.length === 1) {
      targets = [waiting[0]];
    } else if (waiting.length === 0 && last) {
      targets = last.targets;
    } else {
      targets = [];
    }
    if (last && waiting.length === 0 && sameTargets(targets, last.targets)) {
      last.members.push(...pending, it.id);
    } else {
      const adjacent = targets.length === 1 && targets[0] === lastUser && !textSinceUser;
      last = { groupId: `rg-${it.id}`, members: [...pending, it.id], targets, strip: targets.length > 0 && !adjacent };
      groups.push(last);
    }
    pending = [];
    if (!eventTurn) waiting = [];
    textSinceUser = true;
  }
  closeTurn();

  const out = new Map<string, ReplyGroup0345>();
  for (const g of groups) {
    g.members.forEach((id, i) => out.set(id, { groupId: g.groupId, first: i === 0, targets: g.targets, strip: g.strip }));
  }
  return out;
}
