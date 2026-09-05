/**
 * The `chatRender: 'openui'` variant of the surface briefing — EXPERIMENTAL.
 *
 * Same surface, one channel swapped: where the default briefing teaches `dream-html` (write
 * markup, we draw it in a sandboxed frame), this one teaches `dream-ui` (write openui-lang,
 * we draw it as typed components). Everything else the surface can do — media, boards,
 * clickable paths, sub-agent cards, PDFs, the highlighter, buttons, and the typed
 * `dream-view` blocks — is true in both modes and is not restated here; it comes from the
 * shared tail.
 *
 * WHY THE VOCABULARY IS GENERATED RATHER THAN WRITTEN. The `dream-html` section is prose a
 * human wrote listing classes a human also wrote into a stylesheet, and keeping those two in
 * step needs a dedicated lockstep test. Here the component vocabulary has ONE definition
 * (`openuiLibrary.ts`), the renderer renders from it, and the instructions are produced from
 * it by `Library.prompt()`. The generated text is committed (`chat-surface-openui.generated.ts`)
 * so the server never imports React to build a system prompt, and a drift test regenerates
 * it and fails on any difference.
 *
 * That decision has evidence behind it rather than taste: the first hand-written openui-lang
 * sample in this project used named arguments (`TextContent(content="…")`), which the grammar
 * does not accept — and it rendered NOTHING, silently, no error. A human reading an example
 * got the syntax wrong; a model will too. The instructions have to come from the machine that
 * owns the grammar.
 */
import { CHAT_BRIEFING_PARTS } from './chat-surface.js';
import { OPENUI_GENERATED_BRIEFING } from './chat-surface-openui.generated.js';

/**
 * The judgement the library cannot generate: WHEN to draw, and when drawing makes the answer
 * worse. Deliberately parallel to the `dream-html` section's own opening rules — the two
 * modes disagree about the notation, not about what a good answer looks like.
 */
const OPENUI_WHEN = `## Draw it, don't narrate it

Long flat prose is this surface's failure mode. You draw real components inline: when what
you explain has STRUCTURE — an architecture, a sequence, a trade-off, a plan, a set of
numbers — put it in a \`dream-ui\` block instead of writing paragraphs about it.

- **A decision goes on screen, not into a question.** When you would ask the user to choose,
  draw the candidates with what each costs, your recommendation marked. They decide by
  LOOKING, then you ask.
- **Numbers want a chart.** This is the one thing this mode does that prose cannot: a series,
  a ranking, a share of a whole. Use real numbers from the conversation, never invented ones.

Two things stay OUT, because drawing them makes the answer worse:

- **A short answer.** One fact, one number, one yes — a card around a sentence is ceremony.
- **Anything the user will copy or click.** Code, commands and file paths belong in the
  prose: a code block gets its own copy button, a backticked path becomes a chip that opens
  the file. Inside the block they are just text.

**In a nutshell, not a report** — one block, one idea, about one screen. The block carries
the structure, the prose around it says what to notice and what you want back.

EXPERIMENTAL: this notation is new and the components below are the WHOLE vocabulary. A name
that is not listed does not exist and its block will not draw. When in doubt, write prose.`;

/**
 * The tail names `dream-html` once, in the line introducing the typed `dream-view` blocks
 * ("the five things HTML must NOT be"). Substituted rather than left alone, because in this
 * mode that phrase points at a channel the agent was never taught — and rather than rewritten
 * by hand, because the tail is shared and must not fork into two maintained copies.
 */
const REST_FOR_OPENUI = CHAT_BRIEFING_PARTS.rest.replace(
  '## `dream-view` — the five things HTML must NOT be',
  '## `dream-view` — the five things a drawn block must NOT be',
);

export const CHAT_SURFACE_BRIEFING_OPENUI = `${CHAT_BRIEFING_PARTS.head}
${OPENUI_WHEN}

## \`dream-ui\` — the notation

${OPENUI_GENERATED_BRIEFING}
${REST_FOR_OPENUI}`;
