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
 * PARTS (owner 2026-10-24): a message with two or more references (`partRefs`) also answers to one
 * ref per part, so a section can name ONE chip inside it. A part ref resolves to its message with
 * that part's number; the message's own ref resolves as before (a Super still on rev 11). Stacked
 * marks naming parts of one message are one section with several parts.
 *
 * Two owner messages with the same words share a ref; "nearest preceding" may then point an
 * out-of-order answer at the later copy. Accepted: same words, same strip.
 *
 * Runs ONCE per render over the whole conversation (`[...history, ...items]`), so a window cut,
 * the history divider or a notice never changes the answer; the render only looks it up.
 */
import { msgRef, partRefs } from '../../../lib/superTypes';
import type { ChatItem, ChatUserItem } from '../chatSession';
import { splitAbout, splitAboutParts, superEventOf, type AgendaAbout, type MessageAbout } from '../super/superHandover';

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
  /** The parts of its single target it names (1-based, in mark order), when every ref was a
   *  part ref of that one message: the strip shows those chips. */
  parts?: number[];
  /** On a SECTIONED text's own entry: each section's start in its text and the owner messages
   *  it answers ([] when its refs resolve to nothing), with `parts` as above. */
  sections?: Array<{ at: number; targets: string[]; parts?: number[] }>;
}

interface Building {
  groupId: string; members: string[]; targets: string[]; strip: boolean; parts?: number[];
  sections?: { id: string; list: Array<{ at: number; targets: string[]; parts?: number[] }> };
}

const isStep = (it: ChatItem) => it.kind === 'tool' || it.kind === 'thinking';
const sameTargets = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export function replyGroups(entries: readonly ChatItem[]): Map<string, ReplyGroup> {
  const groups: Building[] = [];
  /** Every owner message so far, oldest first, with its reference and its parts' refs. */
  const owners: Array<{ id: string; ref: string; parts: string[] }> = [];
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

  /** Refs to owner messages: the nearest preceding message whose ref, or one of whose part
   *  refs, it is (`part` then its number); unresolved refs drop. */
  const hits = (refs: readonly string[]): Array<{ id: string; part?: number }> => {
    const out: Array<{ id: string; part?: number }> = [];
    for (const ref of refs) {
      for (let i = owners.length - 1; i >= 0; i -= 1) {
        const part = owners[i].parts.indexOf(ref);
        if (owners[i].ref !== ref && part < 0) continue;
        out.push(part < 0 ? { id: owners[i].id } : { id: owners[i].id, part: part + 1 });
        break;
      }
    }
    return out;
  };
  const resolve = (refs: readonly string[]): string[] => [...new Set(hits(refs).map((h) => h.id))];
  /** The parts named, when every resolved ref is a part of the same one message. */
  const partsOf = (refs: readonly string[]): number[] | undefined => {
    const h = hits(refs);
    if (!h.length || h.some((x) => !x.part || x.id !== h[0].id)) return undefined;
    return [...new Set(h.map((x) => x.part as number))];
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
        owners.push({ id: it.id, ref: msgRef(it.text), parts: partRefs(it.text) });
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
        sections: {
          id: it.id,
          list: sections.map((s) => {
            const parts = partsOf(s.refs);
            return { at: s.at, targets: resolve(s.refs), ...(parts ? { parts } : {}) };
          }),
        },
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
      const parts = refs?.length ? partsOf(refs) : undefined;
      last = { groupId: `rg-${it.id}`, members: [...pending, it.id], targets, strip: it.done && targets.length > 0 && !adjacent, ...(parts ? { parts } : {}) };
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
      groupId: g.groupId, first: i === 0, targets: g.targets, strip: g.strip, ...(g.parts ? { parts: g.parts } : {}),
      ...(g.sections?.id === id ? { sections: g.sections.list } : {}),
    }));
  }
  return out;
}

/**
 * What one section's head shows (owner 2026-10-24, pick A), as plain data: the chip of the
 * message it answers. `about` when that message was written about an agenda line (the pink dot
 * and the line), `reply` otherwise (↩ "To your message" or "To N messages"). No translated text:
 * the head translates itself, so a language switch redraws it.
 */
export interface ReplyHead {
  /** Where its section starts in the text (`replySections[i].at`). */
  at: number;
  kind: 'about' | 'reply';
  about?: AgendaAbout;
  count: number;
  /** His words, at most three, clipped. */
  quotes: string[];
  /** The message a click lands on. */
  targetId: string;
  /** A head naming PARTS of that message (rev 12): their numbers, in mark order; the first is
   *  the one a click flashes. Each part's chip wears the slot of its number. */
  parts?: number[];
  /** What each of those parts is about, in the same order. */
  partAbouts?: MessageAbout[];
}

/** One part of an owner message as a head or strip reads it: what it is about and his words
 *  (a stacked part shares the words of the part it is stacked on). */
export function messagePart(it: ChatItem | undefined, part: number): { about: MessageAbout; words: string } | null {
  if (!it || it.kind !== 'user') return null;
  const parts = splitAboutParts(it.text).parts;
  if (parts.length < 2 || part < 1 || part > parts.length) return null;
  let words = '';
  for (let j = part - 1; j < parts.length && !words; j += 1) words = parts[j].words;
  return { about: parts[part - 1].about, words };
}

const clipWords = (s: string, max: number) => {
  const flat = s.replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : flat;
};

/** A SECTIONED text's heads: one per section whose refs resolved (an unresolved one keeps only
 *  its divider). `quoteOf(id, max)` reads his words for a message. */
export function sectionHeads(
  sections: ReadonlyArray<{ at: number; targets: string[]; parts?: number[] }>,
  items: ReadonlyMap<string, ChatItem>,
  quoteOf: (id: string, max: number) => string,
): ReplyHead[] {
  return sections.flatMap((s): ReplyHead[] => {
    if (!s.targets.length) return [];
    const first = items.get(s.targets[0]);
    const named = s.parts?.map((j) => messagePart(first, j));
    if (s.parts && named && named.every(Boolean)) {
      const ps = named as Array<{ about: MessageAbout; words: string }>;
      const words = ps.map((p) => p.words).filter((w, i, all) => w && all.indexOf(w) === i).join(' · ');
      return [{
        at: s.at, kind: ps[0].about.kind === 'reply' ? 'reply' as const : 'about' as const, count: 1,
        quotes: [clipWords(words, 80)], targetId: s.targets[0], parts: s.parts, partAbouts: ps.map((p) => p.about),
      }];
    }
    const about = s.targets.length === 1 && first?.kind === 'user' ? splitAbout(first.text).about : null;
    const agenda = about && (about.kind === 'note' || about.kind === 'item') ? about : null;
    const many = s.targets.length > 1;
    return [{
      at: s.at, kind: agenda ? 'about' as const : 'reply' as const, ...(agenda ? { about: agenda } : {}),
      count: s.targets.length, quotes: s.targets.slice(0, 3).map((id) => quoteOf(id, many ? 40 : 80)), targetId: s.targets[0],
    }];
  });
}

const headsKey = (heads: readonly ReplyHead[]) => heads.map((h) => (
  `${h.at}:${h.kind}:${h.count}:${h.targetId}:${h.quotes.join('\u0001')}:${h.about ? `${h.about.kind}/${h.about.id}/${h.about.line ?? ''}` : ''}:${h.parts?.join(',') ?? ''}`
)).join('|');

/**
 * Every SECTIONED text's heads, by text id. An array keeps its identity while its content is
 * unchanged (`cache` is the previous call's result), so the memoized row of a sectioned answer
 * is not re-rendered by anything but its own text or heads.
 */
export function replyHeadsById(
  replyMap: ReadonlyMap<string, ReplyGroup>,
  items: ReadonlyMap<string, ChatItem>,
  quoteOf: (id: string, max: number) => string,
  cache: ReadonlyMap<string, ReplyHead[]> = new Map(),
): Map<string, ReplyHead[]> {
  const out = new Map<string, ReplyHead[]>();
  for (const [id, g] of replyMap) {
    if (!g.sections) continue;
    const heads = sectionHeads(g.sections, items, quoteOf);
    const prev = cache.get(id);
    out.set(id, prev && headsKey(prev) === headsKey(heads) ? prev : heads);
  }
  return out;
}

