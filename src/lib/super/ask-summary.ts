import { ASK_HIS_KINDS } from '../ask-rules.js';
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
 *
 * 2026-11-18 (owner: "aynı özet üç kez", "Uygula, plan onayı da kalksın"): the summary stands in
 * ONE place, the report card, so the Super's text no longer repeats it (the text warning that
 * asked for a second copy is gone), and work he asked for or approved gets no start card at
 * all: both warnings now open with that (`lib/ask-rules.ts`).
 */

/** Turkish stems (no `\b`: it does not see ş/ı/ç) and English words that mark a start/approve question. */
const START_RE = /\b(?:start|begin|approve|proceed|go ahead|kick off|implement)|plan|başla|onay|geliştir/i;
/** A question that only asks to start or go on (never "approve": a drawing's yes is his by kind). */
const GO_ON_RE = /\b(?:start|begin|proceed|go ahead|kick off|continue|next wave)\b|başla|devam e|sıradaki dalga/i;
/** A preview's text (tags dropped) past this is information to READ, not a look at an option:
 *  four short bullets measure ~150, a mockup's labels stay well under it. */
export const MAX_PREVIEW_TEXT = 200;

const textOf = (html: string) => html.replace(/<[^<>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();

const REPORT_HOW = 'write the summary as a page (the problem in one sentence, what will be done in 3-6 short bullets, the decisions that are his, cost or risk in money), `super open web <that .html> --title "<name>"`, then ask the decision in one short line with `--show <its card>`';

/** Said with every start/approve card: most of them should not have been a card. */
export const NO_START_CARD = `Work he asked for or approved starts and goes on without a card, and a plan that changes no screen is built without his yes: start it and tell him in your text. Only a yes that is his by kind is asked (${ASK_HIS_KINDS}).`;

export const START_ASK_WARNING = `This card asks the owner to start or approve something but shows him no report card of it. It went as it is; now write him the summary in this turn's text. ${NO_START_CARD} Next time such a yes is his: ${REPORT_HOW}; the report carries the summary, your text does not repeat it.`;

/** A start/approve card that does show its report: sent as it is, the rule said once. */
export const START_ASK_NOTE = `This card asks the owner to start or approve something. ${NO_START_CARD} If this one was not his by kind, do not ask it next time.`;

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
  if (long) return LONG_PREVIEW_WARNING;
  // Only a start-or-go-on question hears the note: an approval of a drawing is his by kind (end review r1).
  const goOn = spec.questions.some((q) => GO_ON_RE.test(q.question)) || GO_ON_RE.test(spec.title ?? '');
  return goOn ? START_ASK_NOTE : null;
}

export const PLAN_REPORT_REFUSAL = `This is a plan child's question about its plan, and it reaches the owner only through you: as a card in your chat that shows the plan whole. Not sent. A question that is yours (it changes no screen and stays on his machine) you answer yourself with \`super answer\`. One that is his: first ${REPORT_HOW}; then ask again with \`--show <its card>\`. The report carries the summary: your text does not repeat it.`;

/**
 * Refuse a `super queue ask` of a plan child's question that names no report card (owner
 * 2026-11-13: the Super said "the summary is on the stage" while the stage held only the child's
 * own chat, and the card itself never reached his chat). Pure. `readShown`: how many of the
 * `--show` cards are there to be READ (a page, a task, knowledge, a board). Null = may go.
 */
export function planReportRefusal(childMode: string | undefined, readShown: number): string | null {
  return childMode === 'plan' && readShown === 0 ? PLAN_REPORT_REFUSAL : null;
}
