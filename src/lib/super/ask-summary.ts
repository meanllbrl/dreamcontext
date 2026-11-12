import type { SuperAskSpec } from './types.js';

/**
 * A `super ask` that asks the owner to start or approve something must carry what he says yes to
 * (owner 2026-10-29: "plan hazır başlasın mı diyor ama planı hiç özetlemiyor"), and that summary
 * is READ on its own card, never packed into the question (owner 2026-10-30, "bilgi vermeyi bile
 * soru sorarak veriyor, okuyamıyorum"): a 7-item plan in the yes option's preview landed in a
 * half-width tile at the chat's 17 px, cut after three items, beside an empty "No preview" twin.
 * So the summary is a report card on the stage (an .html page, `super open web <path>`) the
 * question shows (`--show <card>`), and the card asks the decision in one line, pointing at it.
 *
 * Advisory only: the card is sent either way, the route adds the warning to its answer. A false
 * positive costs one line in the Super's tool output, so the start patterns stay broad.
 */

/** Turkish stems (no `\b`: it does not see ş/ı/ç) and English words that mark a start/approve question. */
const START_RE = /\b(?:start|begin|approve|proceed|go ahead|kick off|implement)|plan|başla|onay|geliştir/i;
/** A preview's text (tags dropped) past this is information to READ, not a look at an option:
 *  four short bullets measure ~150, a mockup's labels stay well under it. */
export const MAX_PREVIEW_TEXT = 200;

const textOf = (html: string) => html.replace(/<[^<>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();

const REPORT_HOW = 'write the summary as a page (the problem in one sentence, what will be done in 3-6 short bullets, the decisions that are his, cost or risk in money), `super open web <that .html> --title "<name>"`, then ask the decision in one short line with `--show <its card>`';

export const START_ASK_WARNING = `This card asks the owner to start or approve something but shows him no report card of it. It went as it is; now write him the summary in this turn's text. Next time ${REPORT_HOW}.`;

export const LONG_PREVIEW_WARNING = `A preview on this card is information to read (over ${MAX_PREVIEW_TEXT} characters of text), which a question card cannot hold readably. It went as it is. Next time ${REPORT_HOW}; a preview is only for a look at an option (a mockup, a picture).`;

/**
 * The warning for a Super `ask`, else null. Pure. `readCards`: how many report cards the question
 * shows (`SuperQueueItem.read`). A start/approve question needs one; any question with a preview
 * that is really a text to read is told where that text goes.
 */
export function askWarning(spec: SuperAskSpec, readCards: number): string | null {
  const asksStart = spec.questions.some((q) => START_RE.test(q.question)) || START_RE.test(spec.title ?? '');
  if (asksStart && readCards === 0) return START_ASK_WARNING;
  const long = spec.questions.some((q) => q.options.some((o) => !!o.preview && textOf(o.preview).length > MAX_PREVIEW_TEXT));
  return long ? LONG_PREVIEW_WARNING : null;
}

export const PLAN_QUEUE_ASK_WARNING = `This escalates a plan child's question with no report card of its plan. It went as it is (its own card opens with the plan's summary); now give him the plan in this turn's text. Next time ${REPORT_HOW}.`;

/**
 * The warning for a `super queue ask` of a child's question, else null. Pure. A plan child asks
 * about its plan (owner 2026-11-12): the Super's escalation shows the plan whole, as a report card.
 */
export function queueAskWarning(childMode: string | undefined, readCards: number): string | null {
  return childMode === 'plan' && readCards === 0 ? PLAN_QUEUE_ASK_WARNING : null;
}
