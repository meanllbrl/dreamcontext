import { useMemo, useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import { useAnswerQuestion } from '../../hooks/useAutomations';
import type { QuestionSpec } from '../../lib/chatProtocol';
import { MIN_FOLDED_SECTIONS, splitReport } from '../../lib/reportSections';
import type { PendingQuestion } from '../sleepy/chatSession';
import { SurveyCard, type SurveyHost } from '../sleepy/chat/SurveyCard';
import { FoldedReport } from './FoldedReport';
import '../sleepy/chat/cards.css';

/**
 * THE QUESTION A RUN STOPPED TO ASK, asked the way Chat asks.
 *
 * The owner's call (2026-09-26): "instead of a separate way of asking, it should ask the way
 * questions are normally asked". So this is NOT a second question UI. It mounts Chat's own
 * `SurveyCard` (the AskUserQuestion card: context strip, the question, why it is asked,
 * lettered option rows, one free-text field that is always there, "Unclear — ask again")
 * over an automation's question, through a two-method adapter (`SurveyHost`).
 *
 * THE MAPPING, from an `AutomationQuestion`:
 *   • context strip ← the agent's name: the reader meets this in a channel of many agents;
 *   • question ← the first paragraph of the question text;
 *   • the rest of the text is either a REPORT (it has sections: the document sign-off carries
 *     the whole report) drawn folded ABOVE the card, or a short body, which becomes the
 *     card's "why" line;
 *   • options ← `choices`. The runner's sign-off values `approve` / `reject` get faces and a
 *     line saying what each does; a run's own `propose --choice` labels are shown as written;
 *   • no choices ← a text question.
 *
 * WHAT GOES BACK is prose, because every `flow-hitl` answer resumes the asking session as a
 * message: the picked choice's VALUE (a face maps back to `approve`, never "Approve"), plus
 * the note under it when one was typed; with nothing picked, the typed text is the answer.
 * "Unclear" sends a sentence asking the agent to re-ask with `propose`.
 *
 * A FAILED SEND REOPENS THE CARD. SurveyCard shows its receipt the instant it submits; if the
 * route then refuses, the card is remounted (`attempt`) so the question is answerable again.
 * A receipt that outlived a failed send would say the run was answered while it still waits.
 */

/** The runner's document sign-off offers these VALUES; the face and the line are the reader's. */
const SIGN_OFF: Record<string, { face: string; line: string }> = {
  approve: { face: 'agents.question.approve', line: 'agents.question.approveLine' },
  reject: { face: 'agents.question.reject', line: 'agents.question.rejectLine' },
};

/** A question's own words, then (after the first blank line) what it is about. */
function splitQuestion(text: string): { ask: string; rest: string } {
  const at = text.search(/\n\s*\n/);
  if (at < 0) return { ask: text.trim(), rest: '' };
  return { ask: text.slice(0, at).trim(), rest: text.slice(at).trim() };
}

/** Long or sectioned text is a report to fold; a short paragraph is the card's "why" line. */
function isReport(text: string): boolean {
  return splitReport(text).sections.length >= MIN_FOLDED_SECTIONS || text.length > 320;
}

export function AgentQuestionBlock({
  slug,
  title,
  question,
  onToast,
}: {
  slug: string;
  title: string;
  question: { id: string; text: string; choices: string[] };
  onToast: (msg: string) => void;
}) {
  const { t } = useI18n();
  const answerQuestion = useAnswerQuestion();
  /** Bumped when a send fails, remounting the card so it can be answered again. */
  const [attempt, setAttempt] = useState(0);

  const { ask, rest } = splitQuestion(question.text);
  const report = rest && isReport(rest) ? rest : '';
  const why = rest && !report ? rest : undefined;

  /** face → value, so a pick on "Approve" answers `approve`. */
  const valueOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of question.choices) {
      const s = SIGN_OFF[c.toLowerCase()];
      m.set(s ? t(s.face) : c, c);
    }
    return m;
  }, [question.choices, t]);

  const spec: QuestionSpec = question.choices.length > 0
    ? {
      question: ask,
      description: why,
      options: question.choices.map((c) => {
        const s = SIGN_OFF[c.toLowerCase()];
        return s ? { label: t(s.face), description: t(s.line) } : { label: c };
      }),
    }
    : { question: ask, description: why, options: [], kind: 'text', placeholder: t('agents.question.answer') };

  const item: PendingQuestion = {
    kind: 'question',
    requestId: question.id,
    toolName: 'AskUserQuestion',
    questions: [spec],
    title,
  };

  const send = (text: string) => {
    const body = text.trim();
    if (!body) return;
    // `flow-hitl` ALWAYS: an `approval` question (the manifest-diff ask) never reaches a
    // run's thread, and the answer route's two kinds are not interchangeable.
    answerQuestion.mutate({ id: question.id, kind: 'flow-hitl', answer: body }, {
      onError: (err) => {
        setAttempt((a) => a + 1);
        onToast(t('agents.question.failed').replace('{name}', title).replace('{reason}', (err as Error).message));
      },
    });
  };

  const host: SurveyHost = {
    answerQuestion: (_id, questions, picked, notes) => {
      const q = questions[0];
      if (!q) return;
      const raw = picked[q.question] ?? '';
      const value = raw.split(', ').map((v) => valueOf.get(v) ?? v).join(', ');
      const note = notes?.[q.question]?.trim();
      send(value && note && note !== value ? `${value}\n\n${note}` : value || note || '');
    },
    answer: (_id, opts) => {
      // "Unclear — ask again". The chat's wording names AskUserQuestion, which a headless run
      // does not have; an agent re-asks with `propose`.
      send((opts.message ?? 'I did not understand this question.')
        .replace('Ask again with AskUserQuestion', 'Ask again with `dreamcontext automations propose`'));
    },
  };

  return (
    // `--chat-card-width` is what the card sizes itself by inside a chat pane; here it takes
    // the message's column.
    <div className="agent-msg-ask" data-slug={slug} style={{ ['--chat-card-width' as string]: '100%' }}>
      {report && <FoldedReport text={report} />}
      <SurveyCard key={`${question.id}:${attempt}`} item={item} session={host} />
    </div>
  );
}
