/**
 * Which Super answer is to which owner message (owner 2026-10-23: "Super'e art arda 5 mesaj
 * atınca hangi cevabın hangi mesaja olduğu kayboluyor"). Pure: the transcript in, a map out;
 * ChatPane draws a strip above each group and a thin line beside its rows (pick 1A).
 *
 *  - A TURN is what lies between two user items (an owner message or an injected event turn).
 *  - Within a turn a GROUP is the step rows (tool calls, thinking) since the previous Super
 *    text, plus that text; rows after a turn's last text join its last group.
 *  - A group's targets: the text's `replyTo` refs (its `<!-- re:<ref> -->` head), each resolved
 *    to the NEAREST preceding owner message whose `msgRef` matches; unresolved refs drop.
 *  - No mark (pick 2A): the one owner message that arrived since the previous Super text, when
 *    there is exactly one; none otherwise, and never in an event turn (its notes answer no
 *    message of his, and they leave his waiting messages waiting). A later text in the same turn that is unmarked (or
 *    names the same messages) with no new message between continues the previous group.
 *  - The strip shows only when it tells something: hidden when the group's single target is the
 *    message directly above it (nothing but this turn's rows between), so a plain
 *    one-message-one-answer exchange stays as it was.
 *
 * SECTIONED (owner 2026-10-24, pick A): a text with two or more sections (`replySections`, one per
 * line-start mark) answers several messages part by part. It always opens its own group, never
 * draws a strip, and carries each section's targets so the transcript heads every part with the
 * chip of the message it answers. A strip is drawn only once its group's first text is done: a
 * streaming text could still gain a second section, and a strip shown then would have to vanish.
 * Everything else is as before. While a text streams, its refs are read from its sections, so a
 * closed mark with no words under it yet moves nothing.
 *
 * Two owner messages with the same words share a ref; "nearest preceding" may then point an
 * out-of-order answer at the later copy. Accepted: same words, same strip.
 *
 * Runs ONCE per render over the whole conversation (`[...history, ...items]`), so a window cut,
 * the history divider or a notice never changes the answer; the render only looks it up.
 */
import { msgRef } from '../../../lib/superTypes';
import type { ChatItem, ChatUserItem } from '../chatSession';
import { superEventOf } from '../super/superHandover';

/** An owner message: a user item that is not an injected super event turn, live (`superEvent`)
 *  or replayed (its `[super …]` prefix). A question card's answer is his words too. */
export function isOwnerMessage(it: ChatItem): it is ChatUserItem {
  return it.kind === 'user' && !it.superEvent && !superEventOf(it.text);
}

export interface ReplyGroup {
  /** Stable for the group's life: `rg-<its first text's id>`. */
  groupId: string;
  /** The group's first row (the strip is drawn above the first one a slice shows). */
  first: boolean;
  /** The owner messages it answers, as user item ids, in the order the mark named them. */
  targets: string[];
  /** Draw the strip: there are targets, they are not just the message right above, and the
   *  group's first text is done. Never on a SECTIONED group. */
  strip: boolean;
  /** On a SECTIONED text's own entry: each section's start in its text and the owner messages
   *  it answers ([] when its refs resolve to nothing). */
  sections?: Array<{ at: number; targets: string[] }>;
}

interface Building {
  groupId: string; members: string[]; targets: string[]; strip: boolean;
  sections?: { id: string; list: Array<{ at: number; targets: string[] }> };
}

const isStep = (it: ChatItem) => it.kind === 'tool' || it.kind === 'thinking';
const sameTargets = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export function replyGroups(entries: readonly ChatItem[]): Map<string, ReplyGroup> {
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

  /** Refs to owner message ids: the nearest preceding message with that ref; unresolved drop. */
  const resolve = (refs: readonly string[]): string[] => {
    const targets: string[] = [];
    for (const ref of refs) {
      for (let i = owners.length - 1; i >= 0; i -= 1) {
        if (owners[i].ref !== ref) continue;
        if (!targets.includes(owners[i].id)) targets.push(owners[i].id);
        break;
      }
    }
    return targets;
  };

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
    const sections = it.replySections ?? [];
    if (sections.length >= 2) {
      // SECTIONED: its own group, no strip. Rows before it stay in the group it was continuing
      // while it had one section, so that group's line never shrinks back.
      const was: Building | null = last;
      const continuing = !!was && waiting.length === 0 && sameTargets(resolve(sections[0].refs), was.targets);
      if (was && continuing) was.members.push(...pending);
      const members: string[] = continuing ? [it.id] : [...pending, it.id];
      last = {
        groupId: `rg-${it.id}`, members, targets: resolve(it.replyTo ?? []), strip: false,
        sections: { id: it.id, list: sections.map((s) => ({ at: s.at, targets: resolve(s.refs) })) },
      };
      groups.push(last);
      pending = [];
      if (!eventTurn) waiting = [];
      textSinceUser = true;
      continue;
    }
    // Streaming: only the refs of sections that have words (a closed mark alone moves nothing).
    const refs = !it.done && sections.length ? sections.flatMap((s) => s.refs) : it.replyTo;
    let targets: string[];
    if (refs?.length) {
      targets = resolve(refs);
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
      last = { groupId: `rg-${it.id}`, members: [...pending, it.id], targets, strip: it.done && targets.length > 0 && !adjacent };
      groups.push(last);
    }
    pending = [];
    if (!eventTurn) waiting = [];
    textSinceUser = true;
  }
  closeTurn();

  const out = new Map<string, ReplyGroup>();
  for (const g of groups) {
    g.members.forEach((id, i) => out.set(id, {
      groupId: g.groupId, first: i === 0, targets: g.targets, strip: g.strip,
      ...(g.sections?.id === id ? { sections: g.sections.list } : {}),
    }));
  }
  return out;
}
