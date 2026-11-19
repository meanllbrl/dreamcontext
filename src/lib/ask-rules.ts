/**
 * When an agent asks the person at all (owner, 2026-11-18: "bilgi veriyor ve sürekli hemen
 * arkasından soru sorması biraz baydı beni", "daha az soru kartı", "Uygula, plan onayı da kalksın").
 *
 * Measured on this Mac before the change: 713 Super question cards in 30 days (24 a day), each
 * read one by one. 365 of them (51 %) should never have been a card of their own: 252 were a
 * clear choice the Super should have taken and said, 93 repeated another card, 20 were
 * information. He picked the suggested option in 57 % of what he answered and left 30 % unanswered.
 * No briefing line said when NOT to ask; six pushed towards asking.
 *
 * So the rule is one text, read by every asker on every tool (the Super and a member's Super in
 * `chat-modes.ts`, every chat and a Super's child in `chat-surface.ts`, Plan mode, the server
 * notes an ask answers with, the orchestration guide), and it rules by KIND, never by a count
 * (owner: no count caps anywhere). What stays a card is exactly what he said stays his: a message
 * to a real person, a publish, money, real data, an irreversible step, a screen he will see.
 *
 * "Never twice" holds only while the card is really open (end review r1): the server closes a
 * Super's card on a message written about it, and a member's card on any message of his in its
 * chat (`asksAnswered`, inbox.ts). A card closed that way without a decision, still his by kind,
 * gets ONE reworded card: a decision of his never stays in prose alone.
 */

/** What stays the person's own decision, by kind: one tap each. */
export const ASK_HIS_KINDS = 'a message to a real person, a publish or anything that goes live or leaves his machine (a push, a pull request, a merge to the default branch, a deploy, a release), money, real data (deleted, migrated, overwritten), any other step that cannot be undone, a screen he will see (its drawing first), a choice that grows or contradicts what he asked for';

/** What is never a card, by kind. */
export const ASK_NEVER_KINDS = 'housekeeping (tidying memory, a local commit, a local branch, restarting a stuck job, a screenshot taken again), a technical choice (names, order, libraries, the split, models), starting or going on with work he asked for or approved ("shall I start", "shall I continue", "the next wave?"), a review that only reads, a question whose card is still open or already answered';

/** The words for a clear choice the agent took itself (rule 2): done, said in one line, his to reverse. */
export const ASK_DECIDED_LINE = 'decide, do it, and say in one line what you did and that he can say otherwise';

/**
 * The short form every chat carries (`chat-surface.ts`, which rides in every chat turn and keeps
 * a measured length): the same two kind lists, word for word, and the three habits.
 */
export const ASK_RULES_SHORT = `**Ask less.** A card only when the work is truly blocked: a decision only he can make, or a step only he can do. His, by kind: ${ASK_HIS_KINDS}; those ready together go in ONE card. Never a card: ${ASK_NEVER_KINDS}. Whatever stays on his machine and can be undone: ${ASK_DECIDED_LINE}. One card is one decision, never asked again while it is open or once it is answered, never repeated in your text.`;

/** The whole rule, as the Super reads it (and the orchestration guide says it). */
export const ASK_RULES = `A question card comes only when the work is truly blocked: a decision only he can make, or a step only he can do. By kind, never by count:
- **His, one tap:** ${ASK_HIS_KINDS}. Those ready together on one subject go in ONE card.
- **Yours, never a card:** ${ASK_NEVER_KINDS}. Whatever stays on his machine and can be undone: ${ASK_DECIDED_LINE}.
- **One card, one decision:** the small choices beside it you take as you would recommend and list in your text. An option that is a look: no card before its drawing exists.
- **Never twice:** a card that is still open is never asked again: answer his message, and close it when his words answer it. A card his message closed without deciding (he wrote that he did not understand it, or about something else) and that is still his by kind: explain in plain words, in text, then ONE reworded card, never the same one.
- **Text and card never repeat each other:** no line that a question waits (the card sits right under your text), and what he must read stands in ONE place.
- He corrects a call you made: undo it; the same kind corrected again is a written rule from then on.`;
