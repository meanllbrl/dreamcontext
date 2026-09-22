import { useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import { useAnswerQuestion } from '../../hooks/useAutomations';

/**
 * THE QUESTION A RUN STOPPED TO ASK, answered where it was asked.
 *
 * The run is halted on this: its document is unpublished and its session is
 * parked until a human answers. Before this block the only way through was
 * `automations questions <slug>` in a terminal, which is a long way to walk for
 * a two-button decision the channel is already showing you.
 *
 * WHICH CONTROL IS DRAWN IS DECIDED BY THE QUESTION, not by a prop, because the
 * two shapes come from two different producers and both are real:
 *   • `choices.length > 0` — buttons. `review: 'output'` produces
 *     `['approve','reject']`; a run that called `automations propose --choice`
 *     produces its own set (at most 4, each at most 64 chars — capped and
 *     control-stripped in `parseChoices`, so what arrives here is already safe
 *     to put on a button face).
 *   • `choices.length === 0` — a free-text field. A plain `propose`, and every
 *     `flow-hitl` question the graph raises, carries no options at all, and a
 *     block that rendered nothing for them would strand the run silently.
 *
 * THE RECEIPT MACHINE IS `AskBlock`'s (components/automations/AutomationCard.tsx),
 * deliberately: `decided` is set optimistically so the buttons stop being
 * pressable the instant one is, and CLEARED on failure so the block reopens for
 * another try. A receipt that outlived a failed send would be the one lie this
 * surface cannot afford — the run would still be waiting while the channel said
 * it had been answered.
 */
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
  /** What the human answered, kept for the receipt. Null while the block is
   *  still open — see the header on why this is cleared on a failed send. */
  const [decided, setDecided] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const answer = (text: string) => {
    const body = text.trim();
    if (!body || answerQuestion.isPending || decided) return;
    setDecided(body);
    // `flow-hitl` ALWAYS — an `approval` question is the manifest-diff ask the
    // runner raises before a run, it never reaches a run's thread, and the
    // answer route's two kinds are not interchangeable.
    answerQuestion.mutate({ id: question.id, kind: 'flow-hitl', answer: body }, {
      onError: (err) => {
        setDecided(null);
        onToast(`${title}: could not record that — ${(err as Error).message}`);
      },
    });
  };

  if (decided) {
    return (
      <div className="agent-msg-question agent-msg-question--done">
        <p className="agent-msg-question-receipt">
          <span aria-hidden="true">✓</span> {t('agents.question.sent')}
        </p>
      </div>
    );
  }

  return (
    <div className="agent-msg-question" data-slug={slug}>
      <p className="agent-msg-question-text">{question.text}</p>

      {question.choices.length > 0 ? (
        <div className="agent-msg-question-choices">
          {question.choices.map((choice) => (
            <button
              key={choice}
              type="button"
              className="agent-msg-question-choice"
              disabled={answerQuestion.isPending}
              onClick={() => answer(choice)}
            >
              {choice}
            </button>
          ))}
        </div>
      ) : (
        <form
          className="agent-msg-question-free"
          onSubmit={(e) => {
            e.preventDefault();
            answer(draft);
          }}
        >
          <input
            type="text"
            className="agent-msg-question-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t('agents.question.answer')}
            disabled={answerQuestion.isPending}
          />
          <button
            type="submit"
            className="agent-msg-question-send"
            disabled={answerQuestion.isPending || !draft.trim()}
          >
            {t('agents.question.answer')}
          </button>
        </form>
      )}
    </div>
  );
}
