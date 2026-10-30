import type { SuperAskSpec } from './types.js';

/**
 * A `super ask` that asks the owner to start or approve something must carry what he says yes to
 * (owner 2026-10-29: "plan hazır başlasın mı diyor ama planı hiç özetlemiyor"). Field evidence
 * (Tilki super session, same day): cards whose description held 150-330 characters of prose
 * still got "Bana özetle" back; the answer he accepted was a bulleted summary. A description is
 * one line (`askLine` folds newlines, at most 600 characters), so the summary lives in an option's
 * `preview`, and only a preview with some substance counts.
 *
 * Advisory only: the card is sent either way, the route adds the warning to its answer. A false
 * positive costs one line in the Super's tool output, so the start patterns stay broad.
 */

/** Turkish stems (no `\b`: it does not see ş/ı/ç) and English words that mark a start/approve question. */
const START_RE = /\b(?:start|begin|approve|proceed|go ahead|kick off|implement)|plan|başla|onay|geliştir/i;
/** A preview's text (tags dropped) at least this long counts as a summary: four short bullets measure ~150. */
export const MIN_PREVIEW_SUMMARY = 100;

const textOf = (html: string) => html.replace(/<[^<>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();

export const START_ASK_WARNING = 'This card asks the owner to start or approve something but carries no summary of it. It went as it is; now write him the summary in this turn\'s text (the problem in one sentence, what will be done in 3-6 short bullets, the decisions that are his, cost or risk in money). Next time put it in the card: the yes option\'s `preview`.';

/** The warning for a start/approve question with no summary on its card, else null. Pure. */
export function startAskWarning(spec: SuperAskSpec): string | null {
  const asksStart = spec.questions.some((q) => START_RE.test(q.question)) || START_RE.test(spec.title ?? '');
  if (!asksStart) return null;
  const summarised = spec.questions.some((q) => q.options.some((o) => !!o.preview && textOf(o.preview).length >= MIN_PREVIEW_SUMMARY));
  return summarised ? null : START_ASK_WARNING;
}
