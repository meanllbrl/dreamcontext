/**
 * The answer to a request a child's process holds open (a tool permission or an AskUserQuestion
 * card), ONE module for every surface that writes one: the window's card (re-exported by the
 * dashboard: `superAnswerPicks`, `buildQuestionAnswer`) and the server's own delivery when no
 * window answers (field 2026-11-13: with the app in the background its window took no `super
 * allow`, `super send` or `super answer` for minutes). Pure: no I/O, importable by both builds.
 */

// ─── The open request, read from the raw `can_use_tool` line the chat process keeps ───

export interface OpenRequest {
  toolName: string;
  input: Record<string, unknown>;
}

/** The request `requestId` names, from its raw line; null for any other line or request. */
export function openRequest(line: string | undefined, requestId: string): OpenRequest | null {
  if (!line || !requestId) return null;
  let o: { type?: unknown; request_id?: unknown; request?: { subtype?: unknown; tool_name?: unknown; input?: unknown } };
  try { o = JSON.parse(line) as typeof o; } catch { return null; }
  if (o?.type !== 'control_request' || o.request_id !== requestId) return null;
  const req = o.request;
  if (req?.subtype !== 'can_use_tool' || typeof req.tool_name !== 'string') return null;
  const input = req.input && typeof req.input === 'object' && !Array.isArray(req.input) ? req.input as Record<string, unknown> : null;
  return input ? { toolName: req.tool_name, input } : null;
}

/** What goes back to the CLI, as the window's `answer` frame carries it. */
export type RequestResponse =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

/** A tool permission's answer: an allow runs the call exactly as asked. Never a question. */
export function permissionResponse(req: OpenRequest, behavior: 'allow' | 'deny', message?: string): RequestResponse | null {
  if (req.toolName === 'AskUserQuestion') return null;
  return behavior === 'allow'
    ? { behavior, updatedInput: req.input }
    : { behavior, message: message?.trim() ? message : 'Denied' };
}

/** An AskUserQuestion's answer from the Super's labels and text, exactly as the window's card
 *  builds it (`superAnswerPicks` + `buildQuestionAnswer`). Never a permission. */
export function questionResponse(req: OpenRequest, choices: readonly string[], text?: string): RequestResponse | null {
  if (req.toolName !== 'AskUserQuestion' || !Array.isArray(req.input.questions)) return null;
  const questions = (req.input.questions as unknown[]).filter(isQuestionLike);
  if (questions.length !== req.input.questions.length) return null;
  const picks = superAnswerPicks(questions, choices, text);
  if (!picks.ok) return null;
  return { behavior: 'allow', updatedInput: buildQuestionAnswer(questions, picks.picked, { input: req.input, notes: picks.notes }) as Record<string, unknown> };
}

function isQuestionLike(q: unknown): q is QuestionLike {
  const x = q as QuestionLike | null;
  return !!x && typeof x.question === 'string' && Array.isArray(x.options) && x.options.every((o) => !!o && typeof o.label === 'string');
}

// ─── The card's answer shape (moved from the dashboard: one copy for both builds) ───

export interface QuestionLike {
  question: string;
  options: Array<{ label: string }>;
  multiSelect?: boolean;
}

/**
 * Map the agent's `choices` (option labels, one per question in order; a multi-select
 * question's labels joined) and optional free `text` onto the `picked` record
 * `buildQuestionAnswer` takes. A label the question does not offer is refused, so the agent
 * cannot put words in the owner's mouth through a fake option.
 */
export function superAnswerPicks(
  questions: readonly QuestionLike[],
  choices: readonly string[],
  text?: string,
): { ok: true; picked: Record<string, string>; notes?: Record<string, string> } | { ok: false; error: string } {
  if (questions.length === 0) return { ok: false, error: 'no_question' };
  const picked: Record<string, string> = {};
  const clean = choices.filter((c) => typeof c === 'string' && c.trim()).map((c) => c.trim());
  if (questions.length === 1) {
    const q = questions[0];
    const labels = new Set(q.options.map((o) => o.label));
    if (clean.some((c) => !labels.has(c))) return { ok: false, error: 'unknown_choice' };
    if (clean.length > 1 && !q.multiSelect) return { ok: false, error: 'one_choice_only' };
    if (clean.length) picked[q.question] = clean.join(', ');
  } else {
    if (clean.length > questions.length) return { ok: false, error: 'too_many_choices' };
    for (let i = 0; i < clean.length; i++) {
      const q = questions[i];
      if (!q.options.some((o) => o.label === clean[i])) return { ok: false, error: 'unknown_choice' };
      picked[q.question] = clean[i];
    }
  }
  const free = typeof text === 'string' ? text.trim().slice(0, 4000) : '';
  if (!free && Object.keys(picked).length === 0) return { ok: false, error: 'empty_answer' };
  if (!free) return { ok: true, picked };
  const first = questions[0].question;
  // Free text with no pick IS the answer; beside a pick it rides as the question's note.
  if (!picked[first]) { picked[first] = free; return { ok: true, picked }; }
  return { ok: true, picked, notes: { [first]: free } };
}

/** The AskUserQuestion `updatedInput`: the request echoed with `answers` (and `annotations`). */
export function buildQuestionAnswer(
  questions: ReadonlyArray<{ question: string }>,
  picked: Record<string, string>,
  extra: { input?: unknown; notes?: Record<string, string> } = {},
): unknown {
  const answers: Record<string, string> = {};
  const annotations: Record<string, { notes: string }> = {};
  for (const q of questions) {
    const answer = picked[q.question];
    if (typeof answer === 'string' && answer.length > 0) answers[q.question] = answer;
    const note = extra.notes?.[q.question]?.trim();
    if (note) annotations[q.question] = { notes: note };
  }
  const input = extra.input;
  const echoed = input && typeof input === 'object' && !Array.isArray(input) && Array.isArray((input as { questions?: unknown }).questions)
    ? { ...(input as Record<string, unknown>) }
    : { questions };
  return Object.keys(annotations).length ? { ...echoed, answers, annotations } : { ...echoed, answers };
}
