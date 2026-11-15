/**
 * How every agent writes for Telegram (owner 2026-11-14, "B2: zengin, her öğenin tek işi"): ONE
 * rule, read by every surface whose words reach a bot. The Super's and every AI Team member's own
 * Super briefing (`chat-modes.ts` SUPER_TELEGRAM_LINE) and a routine whose results go to its
 * member's bot (`runner.ts`). Claude, Codex and Antigravity sessions get it through those briefings
 * alike. Each element has ONE job, and the converter (`format.ts`) draws exactly these shapes:
 *  - the answer in one bold line first; a bold head on its own line before each group;
 *  - `- ` bullets under a head, a blank line between groups (the converter keeps it);
 *  - `inline code` for a path, command, file name or anything he copies;
 *  - a `>` quote for someone's own words, the speaker as its bold first line;
 *  - a fenced block with its language for a command he runs;
 *  - a quote opening with `**Ayrıntı**` for detail he did not ask for (it opens folded);
 *  - no tables, no `#` headings, lists one level deep.
 * The native "reply" header the hub adds when an answer is to an older message of his replaces
 * repeating his words.
 */
export const TELEGRAM_WRITING_RULE =
  'Write for his phone, every element with one job. The answer first, in ONE bold line. Then the facts in groups: '
  + 'a bold head on its own line, short `- ` bullets under it, ONE blank line between groups, a closing line apart. '
  + 'Bold only that answer line and the heads, never words inside a sentence. '
  + 'A path, command, file name or anything he would copy goes in `inline code`. '
  + "Someone's own words (a source you read, a message you cite) go in a `>` quote whose bold first line names the speaker. "
  + 'A command he should run is a fenced code block with its language. '
  + 'Detail he did not ask for goes last, in a `>` quote whose first line is `**Ayrıntı**` (it opens folded on his phone); '
  + 'never a code block or another quote inside it. '
  + 'No tables, no `#` headings, lists one level deep. '
  + 'Answering an older message of his: do not repeat it, his phone shows what you reply to.';
