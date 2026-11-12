/**
 * A Plan-mode question carries the plan (owner, 2026-11-12: "plan hazır, soru soruyor ama bana
 * önce planı hiç söylemedi"). A Plan child asked him four design decisions on a card that held
 * only the options: lifted to his bar, the Super's chat and Telegram, it reached him cold, and an
 * option between two designs cannot be judged without knowing what the plan does.
 *
 * The earlier fix (`super/ask-summary.ts`) covered only the Super's own `super ask`. The class is
 * every card a PLANNING session puts in front of him, so the gate sits where every tool's
 * question passes: the chat's `can_use_tool` frame (Claude's AskUserQuestion and the Codex /
 * Antigravity questions the T3 bridge turns into the same frame), beside the off-card gate
 * (`card-standalone.ts`). A card with no summary goes back to the agent with exactly what to add
 * (`pattern-diagnostic-repair-loop`); the Plan briefing says the same (the other half,
 * `pattern-hook-delivered-must-not-miss-rules`).
 *
 * The summary is the FIRST question's own text: the problem in one sentence, then 3-6 short
 * bullets of what the plan does, in its `description` (Claude) or in the lines above the question
 * (a tool whose question has no description; the bridge moves them into one, to-wire.ts). The
 * first question, because it is the one every surface shows first: the Mac card's first page, the
 * first Telegram message, the agenda row.
 */

/** A bullet line: `- `, `* `, `• `, `– `, or `1.` / `1)`. */
const BULLET_LINE = /^\s*(?:[-*•–]|\d{1,2}[.)])\s+\S/u;
/** Fewer than this many bullets is not "what the plan does". */
export const MIN_PLAN_BULLETS = 3;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * Does this AskUserQuestion input carry a plan summary on its first question? An unrecognised
 * shape counts as carrying it (never refuse what we cannot read,
 * `pattern-unrecognized-shape-returns-null`).
 */
export function carriesPlanSummary(ask: unknown): boolean {
  if (!ask || typeof ask !== 'object') return true;
  const questions = (ask as { questions?: unknown }).questions;
  if (!Array.isArray(questions) || questions.length === 0) return true;
  const first = questions[0];
  if (!first || typeof first !== 'object') return true;
  const q = first as { question?: unknown; description?: unknown };
  const text = `${str(q.question)}\n${str(q.description)}`;
  return text.split(/\r?\n/).filter((l) => BULLET_LINE.test(l)).length >= MIN_PLAN_BULLETS;
}

/** The words handed back instead of showing the card. Plain English: the agent reads it, never the owner. */
export const PLAN_SUMMARY_REFUSAL = [
  'Not shown to the owner: you are planning, and this card asks him to decide without telling him the plan.',
  'He reads it cold (the bar, his phone), without your chat or the plan file, so he cannot judge an option.',
  `Open the FIRST question's description with the problem in one sentence, then ${MIN_PLAN_BULLETS}-6 short "- " bullets of what the plan does (no plan yet: what you are planning and what you know so far);`,
  'a tool whose question has no description: put those lines above the question. Then ask again with the same options.',
].join(' ');

/**
 * A Plan chat's question frame (`control_request{can_use_tool}` for AskUserQuestion) with no
 * plan summary: the request to deny and the words to deny it with. Null = show it as usual,
 * including for every shape this does not recognise and every chat that is not planning.
 */
export function planQuestionFrame(frame: Record<string, unknown> | null, mode: string): { requestId: string; message: string } | null {
  if (mode !== 'plan') return null;
  if (!frame || frame.type !== 'control_request' || typeof frame.request_id !== 'string') return null;
  const req = frame.request as Record<string, unknown> | undefined;
  if (!req || req.subtype !== 'can_use_tool' || req.tool_name !== 'AskUserQuestion') return null;
  return carriesPlanSummary(req.input) ? null : { requestId: frame.request_id, message: PLAN_SUMMARY_REFUSAL };
}
