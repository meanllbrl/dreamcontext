/**
 * The `dream-ui` component vocabulary — ONE definition, two consumers.
 *
 * This module is the single source of truth for the OpenUI experiment, and that is its whole
 * reason to exist. `OpenUiRenderer` renders against it; `tests/unit/openui-briefing.test.ts`
 * generates the agent's instructions FROM it. A component added here appears in the briefing
 * and renders, or it does neither — there is no second list to keep in step.
 *
 * That is a lesson this surface already paid for once. `dream-html`'s class vocabulary lives
 * in the briefing as prose and in `chat-html-kit.css` as rules, and keeping them honest took
 * a dedicated lockstep test (`chat-surface-lockstep.test.ts`) whose comment says it plainly:
 * a class named in the briefing that the kit does not define renders as unstyled markup —
 * "exactly the broken promise this file's standing rule forbids". Here the two cannot
 * disagree, because there is only one of them.
 *
 * WHAT IS DELIBERATELY LEFT OUT, and why it is a design cut rather than a budget one:
 *
 *   • FORMS (`Form`, `Input`, `Select`, `Slider`, `DatePicker`, the checkbox/radio/switch
 *     groups) and ACTIONS (`Button`, `Buttons`, `FollowUpBlock`). These are the genuinely new
 *     capability OpenUI brings and the reason to want it — but a submitted form or a clicked
 *     button only means something once the round trip back into the conversation exists, and
 *     a submitted form has nowhere to go: the host would have to accept arbitrary structured
 *     state back from agent-authored UI, which is a much larger decision than a follow-up
 *     question and is not part of this experiment. `Button` is excluded for a sharper
 *     reason: it accepts `Action([@OpenUrl(...)])`, a second and ungated route to opening a
 *     URL, where `dream-actions` gates its `url` kind to https on the client AND in Rust.
 *     One gate or none.
 *
 *     `FollowUpBlock`/`FollowUpItem` DID come back in Wave 5, because their action carries
 *     text and nothing else — see the note beside them below.
 *   • `Image`/`ImageBlock`/`ImageGallery` — the surface already draws images from markdown,
 *     and a second way to do it is a way for the agent to get it wrong.
 *   • `MarkDownRenderer` — prose belongs OUTSIDE the block on this surface. The briefing's
 *     standing rule is that a block carries structure and the prose around it carries the
 *     explanation; a markdown component inside the block invites the answer to move in.
 *   • The scatter, radar, radial and stacked-bar chart families, and `Carousel`, `Accordion`,
 *     `SectionBlock`. Each is a real component; none is reachable from a question this
 *     surface actually gets asked, and every one of them is prompt the model must read
 *     before writing the answer it IS being asked for.
 *
 * MEASURED (2026-09-05, `openui-briefing.test.ts` asserts these do not drift silently):
 * the full shipped chat library generates a 15,052-character prompt. This subset (19 components)
 * generates 5,890 after the generator narrows the child unions and drops the Action section. The whole of today's `dream-html` briefing section is 5,395.
 */
import { createLibrary } from '@openuidev/react-lang';
import { openuiChatLibrary } from '@openuidev/react-ui';

/**
 * The kept components, grouped by the job they do — the order is the order the generated
 * prompt presents them in, so it is also the order the agent reads them.
 *
 * Every name is REUSED from the shipped library rather than redefined: these are their
 * renderers, their prop schemas and their descriptions, filtered. Defining our own would
 * mean owning the render of a bar chart, which is precisely the work this experiment exists
 * to avoid doing.
 */
export const OPENUI_COMPONENT_NAMES = [
  // The frame. `Card` is the root every program must define.
  'Card', 'CardHeader', 'TextContent', 'Callout', 'Separator',
  // Structure — the shapes `dream-html` already draws, so the mode is not a downgrade.
  'Table', 'Col', 'ListBlock', 'ListItem', 'Steps', 'StepsItem', 'Tabs', 'TabItem',
  // Charts — the capability `dream-html` does NOT have, where every chart is hand-rolled SVG.
  'BarChart', 'HorizontalBarChart', 'LineChart', 'Series', 'PieChart', 'Slice',
  // The ONE interactive component, added in Wave 5 with the round trip that makes it mean
  // something. A follow-up carries TEXT and nothing else: its action type is
  // `continue_conversation`, which the host converts into an ordinary `ask` — the same
  // validated path a `dream-actions` button takes. There is deliberately no `Button` here,
  // because `Button` can carry `Action([@OpenUrl(...)])` and a second, ungated way to open a
  // URL is exactly what the generated Action section was stripped to prevent.
  'FollowUpBlock', 'FollowUpItem',
] as const;

/** Every component name the SHIPPED chat library defines — ours plus the ones we dropped.
 *  Exported because the briefing generator needs to recognise a component name when it sees
 *  one (to narrow the child-type unions) and cannot import `@openuidev` itself: this module
 *  lives under `dashboard/`, so its bare imports resolve against the dashboard's own
 *  `node_modules`, and `scripts/` has no such copy. */
export const OPENUI_SHIPPED_COMPONENT_NAMES: readonly string[] =
  Object.keys(openuiChatLibrary.components as Record<string, unknown>);

/** The trimmed library. Built once at module scope: it is pure data + component references,
 *  and both consumers want the same object. */
export const openUiChatLibrary = createLibrary({
  components: OPENUI_COMPONENT_NAMES.map((name) => {
    const component = (openuiChatLibrary.components as Record<string, unknown>)[name];
    // Loud rather than lenient: a rename in a 0.13.x dependency must fail the build and the
    // drift test, not silently shrink the vocabulary the agent was promised.
    if (!component) throw new Error(`openuiLibrary: '${name}' is not in @openuidev/react-ui's chat library`);
    return component;
  }) as never,
  root: 'Card',
} as never);

/**
 * The preamble handed to `Library.prompt()`, REPLACING the package's own.
 *
 * This override is not cosmetic. The shipped preamble opens with "Your ENTIRE response must
 * be valid openui-lang code — no markdown, no explanations, just openui-lang", which is
 * true for a product whose whole answer IS the generated UI and flatly false here: on this
 * surface the answer is markdown prose, and the block is one fenced part of it. Left in
 * place it would tell the agent to stop writing sentences.
 */
export const OPENUI_PREAMBLE = [
  'Inside a ```dream-ui fence you write openui-lang, a small declarative UI language, and',
  'the app draws it as real components. This is the ONLY place it is valid: the rest of your',
  'answer is ordinary markdown prose, and the rules below apply to the fence body alone.',
].join('\n');

/** Extra rules the LIBRARY cannot know, because they are about this surface rather than
 *  about the grammar. Kept short on purpose — every line here is read before every answer. */
export const OPENUI_ADDITIONAL_RULES = [
  'Never put the explanation inside the block. The block carries structure; the sentences around it carry the meaning.',
  'One block, one idea, about one screen. An answer needing a second block usually needed one clearer block.',
  'A short answer takes no block at all. One fact, one number, one yes is prose.',
  'Code, commands and file paths stay in the prose, where they get a copy button and a clickable chip.',
  'A chart needs real numbers from the conversation. Never invent data to fill a shape.',
  'The block draws AS YOU WRITE IT, so put the frame first: `root = Card([...])` on line one, then fill in the parts it names.',
  'A FollowUpItem is a question the reader might ask next. Clicking one sends its text as their next message, so write it in their voice and only when there is a real next step.',
];
