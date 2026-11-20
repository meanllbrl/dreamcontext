import { useState } from 'react';
import type { SuperQueueItem } from '../../../lib/superTypes';
import type { ChatSession } from '../chatSession';
import type { Rect } from './superLayout';
import { askQuestionsOf, askSpecOf, decisionChoices, sendToSuper, superAnswerText } from './superQuestions';
import { noteOwnerWrote } from '../../../lib/ownerAtMac';
import { useI18n } from '../../../context/I18nContext';

/**
 * The Super's question about the document the window shows: a thin decision strip at the foot of
 * the window, under the page (approved frame D-sunum-karar; super-v3 K8, D7; owner 2026-11-20:
 * "o sağdaki raporda mı sorsa bunları", then "Maket D'yi birebir yap"). What it decides, which job
 * it is from, and the choices as one-tap chips: a tap answers. The chat holds one row for it
 * meanwhile. Only a question the strip can carry docks here (`decisionChoices`); a richer one
 * stays the chat's full card.
 */
export function ReportAskDock({ rect, item, from, session }: { rect: Rect; item: SuperQueueItem; from: string; session: ChatSession }) {
  const { t } = useI18n();
  const [sent, setSent] = useState<string | null>(null);
  const decision = decisionChoices(item);
  if (!decision) return null;
  const pick = (label: string) => {
    if (sent) return;
    const questions = askQuestionsOf(askSpecOf(item));
    if (!sendToSuper(session, superAnswerText(item, questions, { [decision.question]: label }))) return;
    noteOwnerWrote();
    setSent(label);
  };
  return (
    <div className="super-ask-dock super-decide" data-testid="super-ask-dock" data-item={item.id} role="group"
      aria-label={t('super.decide.label').replace('{question}', decision.question)}
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}>
      <div className="super-decide-l">
        <span className="super-decide-dot" aria-hidden />
        <div className="super-decide-text">
          <b title={decision.question}>{t('super.decide.decides').replace('{question}', decision.question)}</b>
          {from && <span>{t('super.decide.from').replace('{job}', from)}</span>}
        </div>
      </div>
      <div className="super-decide-opts">
        {decision.choices.map((label, i) => (
          <button key={label} type="button" className="super-decide-chip" data-primary={i === 0 ? 'true' : undefined}
            data-picked={sent === label ? 'true' : undefined} disabled={!!sent} data-testid="super-decide-chip"
            onClick={() => pick(label)}>
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
