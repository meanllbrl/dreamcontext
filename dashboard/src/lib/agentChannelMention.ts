/**
 * ADDRESSING AN AGENT IN `#agents` — the channel's own `@` rule, as three pure functions.
 *
 * The picker, the keyboard handling and the token rewrite are the chat composer's (the
 * channel mounts the real `<Composer>`), but WHO a draft is addressed to, and what the agent
 * is actually sent, are facts about this channel and stay here.
 *
 * WHY A MENTION IS REQUIRED. A channel you can type into with nobody listening is a worse lie
 * than no field at all: the message would land, sit there, and never be answered. Until an
 * agent can be addressed implicitly (there is no "default agent", and picking one for the
 * user would be guessing), the mention IS the address.
 *
 * WHY EXACTLY ONE. Two mentions means two runs, and two runs means deciding whether they are
 * parallel, sequential, or share a thread — the owner's own call was "one for now". The first
 * match wins rather than the draft being refused, because refusing a second `@` would mean
 * explaining a rule nobody typed on purpose.
 *
 * WHY NOT `addressedPeer` (dashboard/src/lib/agentComposer.ts), which the composer already
 * ships: that one matches a LEADING mention only, because in the chat "bunu @acme gibi
 * yapalım" is a sentence ABOUT a project while "@acme nasıl yapıyor" is a message TO it, and
 * routing the first would be a surprise. This channel has no local agent to be talking to
 * instead — every message here is a message to one of these agents — so the mention is an
 * address wherever it sits in the sentence.
 */

/** One agent as the channel addresses it. */
export interface ComposerAgent {
  slug: string;
  title: string;
  hasPhoto: boolean;
}

/** The mention token as it appears in the field: `@` + the agent's slug. The slug, not the
 *  title — a title has spaces in it and there would be no way to tell where the name ends and
 *  the sentence begins. */
export function mentionOf(a: Pick<ComposerAgent, 'slug'>): string {
  return `@${a.slug}`;
}

/** The one agent this draft addresses, or null. Matches a mention token only at a word
 *  boundary, so `@daily` does not resolve to `daily-insight-digest` while it is still being
 *  typed. */
export function mentionedIn<T extends Pick<ComposerAgent, 'slug'>>(draft: string, agents: T[]): T | null {
  for (const a of agents) {
    const re = new RegExp(`(^|\\s)${mentionOf(a).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`);
    if (re.test(draft)) return a;
  }
  return null;
}

/** What the AGENT is sent: the draft with the address removed. It already knows who it is, and
 *  leaving `@its-own-slug` at the front of the sentence reads as part of the instruction. The
 *  channel shows the same clean text — the row's header already names who was asked. */
export function withoutMention(draft: string, agent: Pick<ComposerAgent, 'slug'>): string {
  return draft.replace(mentionOf(agent), '').replace(/\s+/g, ' ').trim();
}
