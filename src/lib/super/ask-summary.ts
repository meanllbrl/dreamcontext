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

export const PLAN_REPORT_REFUSAL = `This is a plan child's question about its plan, and it reaches the owner only through you: as a card in your chat that shows the plan whole. Not sent. First ${REPORT_HOW}; write him the same summary in this turn's text; then ask again with \`--show <its card>\`.`;

/**
 * Refuse a `super queue ask` of a plan child's question that names no report card (owner
 * 2026-11-13: the Super said "the summary is on the stage" while the stage held only the child's
 * own chat, and the card itself never reached his chat). Pure. `readShown`: how many of the
 * `--show` cards are there to be READ (a page, a task, knowledge, a board). Null = may go.
 */
export function planReportRefusal(childMode: string | undefined, readShown: number): string | null {
  return childMode === 'plan' && readShown === 0 ? PLAN_REPORT_REFUSAL : null;
}

/** A summary in the text: 3+ bullet or numbered lines, or a long paragraph (a few sentences). */
const BULLET_RE = /^\s*(?:[-*\u2022]|\d+[.)])\s+\S/;
export const MIN_PLAN_TEXT = 400;

export const PLAN_TEXT_WARNING = `Your card went, but this turn's text gave him no summary of the plan (the problem in one sentence, what will be done in 3-6 short bullets, his decisions, cost or risk in money). Write it now, as long as it needs: the card stays at the end of your turn.`;

/**
 * The warning for a plan question escalated after a text with no summary in it, else null. Pure.
 * `text`: the Super's newest text, the one written before the call (the rule: the line first,
 * then the ask as the last act). A pointer like "the summary is on the stage" is no summary.
 */
export function planTextWarning(childMode: string | undefined, text: string | undefined): string | null {
  if (childMode !== 'plan') return null;
  const t = (text ?? '').trim();
  const bullets = t.split('\n').filter((l) => BULLET_RE.test(l)).length;
  return bullets >= 3 || t.length >= MIN_PLAN_TEXT ? null : PLAN_TEXT_WARNING;
}
