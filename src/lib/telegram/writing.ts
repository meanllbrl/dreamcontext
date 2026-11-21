/**
 * How every agent writes for Telegram (owner 2026-11-21, "Hepsini uygula" on Doc's Telegram
 * diagnosis; it replaces the 2026-11-14 B2 report shape of bold heads and bullet groups, which
 * made every reply a report: 4.4 bubbles and ~1,300 characters per owner message). ONE rule, read
 * by every surface whose words reach a bot: the Super's and every AI Team member's own Super
 * briefing (`chat-modes.ts` SUPER_TELEGRAM_LINE) and a routine whose results go to its member's
 * bot (`runner.ts`). Claude, Codex and Antigravity sessions get it through those briefings alike.
 *  - the answer in one bold line, then at most three short sentences, each on its own line with a
 *    blank line between them; no heads, no bullet groups;
 *  - what he did not ask for but may need goes in a `**Ayrıntı**` quote (it opens folded), never
 *    dropped: short is for the answer, never at the cost of what he needs to know;
 *  - `inline code` for what he copies, a fenced block for a command he runs, a `>` quote for
 *    someone's own words;
 *  - no "still working", no echo of a card, no reassurance or footnote lines.
 * The converter (`format.ts`) folds whatever stays open past ~450 visible characters by itself
 * (`foldAnswer`), so a reply that breaks the rule still reads short on his phone.
 */
export const TELEGRAM_WRITING_RULE =
  'Write for his phone, short. The answer first, in ONE bold line. Then at most three short sentences, each on its own line with ONE blank line between them. '
  + 'No heads, no bullet groups, no report shape: what he did not ask for but may need goes last, in a `>` quote whose first line is `**Ayrıntı**` (it opens folded on his phone); '
  + 'detail he needs is never dropped, it goes there. Never a code block or another quote inside that quote. '
  + 'Bold only that answer line, never words inside a sentence. '
  + 'A path, command, file name or anything he would copy goes in `inline code`; a command he should run is a fenced code block with its language. '
  + "Someone's own words (a source you read, a message you cite) go in a `>` quote whose bold first line names the speaker. "
  + 'No tables, no `#` headings. '
  + 'Never a line that only says you are still working, looking or will write later; never a reassurance or footnote line ("nothing was sent", "say undo if wrong"). '
  + 'Answering an older message of his: do not repeat it, his phone shows what you reply to.';
