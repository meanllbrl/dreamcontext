import { useEffect, useState } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { useAutomationQuestions, useAutomations } from '../../../hooks/useAutomations';
import { AgentQuestionBlock } from '../../agents/AgentQuestionBlock';
import { memberRoutineQuestions } from './memberStageModel';
import './TaskStrip.css';

/**
 * The member's routine (headless) questions on its stage (end review M4): a scheduled run of this
 * member asked the owner something (a flow's hitl step). The Ekip row counts it and opens this
 * stage, so the stage answers it, with the same card the routine's thread uses
 * (`AgentQuestionBlock`, the thread's answer route). One line until opened.
 */
export function MemberRoutineQuestions({ slug }: { slug: string }) {
  const { t } = useI18n();
  const questions = useAutomationQuestions().data;
  const automations = useAutomations().data;
  const [open, setOpen] = useState(false);
  const [toast, setToast] = useState('');
  useEffect(() => {
    if (!toast) return undefined;
    const id = window.setTimeout(() => setToast(''), 4000);
    return () => window.clearTimeout(id);
  }, [toast]);
  const mine = memberRoutineQuestions(questions ?? [], automations ?? [], slug);
  if (mine.length === 0 && !toast) return null;
  return (
    <div className="super-member-band member-routine-questions" data-testid="member-routine-questions" data-count={mine.length}>
      {mine.length > 0 && (
        <button type="button" className="member-routine-questions-bar" aria-expanded={open} data-testid="member-routine-questions-toggle" onClick={() => setOpen((v) => !v)}>
          <span className="member-routine-questions-line">{mine[0].question.split('\n')[0]}{mine.length > 1 ? ` +${mine.length - 1}` : ''}</span>
          <span className="member-routine-questions-go">{t(open ? 'aiteam.run.hideQuestion' : 'aiteam.run.answer')}</span>
        </button>
      )}
      {open && mine.map((q) => (
        <AgentQuestionBlock
          key={q.id}
          slug={q.slug}
          title={automations?.find((a) => a.slug === q.slug)?.title ?? q.slug}
          question={{ id: q.id, text: q.question, choices: q.choices }}
          onToast={setToast}
        />
      ))}
      {toast && <p role="status" className="super-member-note">{toast}</p>}
    </div>
  );
}
