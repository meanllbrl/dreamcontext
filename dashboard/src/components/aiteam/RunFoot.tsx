import { useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import { useAutomationQuestions, useAutomations, useReplyDelivery } from '../../hooks/useAutomations';
import { AgentQuestionBlock } from '../agents/AgentQuestionBlock';
import { runFootOf, type FeedMeta } from '../sleepy/chat/chatFeed';
import { RunReport, RunView } from './RunView';
import { TeamIcon } from './TeamIcons';

/** Under a run's last row: its steps, its full report, and Continue. */
export function RunFoot({ meta, steps, report, onSteps, onReport, onContinue, onOpenFile }: {
  meta: FeedMeta;
  steps: boolean;
  report: boolean;
  onSteps: () => void;
  onReport: () => void;
  /** Absent on a member this machine cannot talk to. */
  onContinue?: () => void;
  onOpenFile?: (path: string) => void;
}) {
  const { t } = useI18n();
  const foot = runFootOf(meta);
  const any = foot.steps || foot.report || foot.noReport || foot.canContinue || foot.line;
  if (!any) return null;
  return (
    <div className="run-foot" data-run-foot={meta.sessionKey}>
      <div className="run-foot-row">
        {foot.steps && (
          <button type="button" className="chat-feed-link" aria-expanded={steps} data-run-steps={meta.sessionKey} onClick={onSteps}>
            {t(steps ? 'aiteam.run.hideSteps' : 'aiteam.run.steps')}
          </button>
        )}
        {foot.report && (
          <button type="button" className="chat-feed-link" aria-expanded={report} data-feed-report={meta.sessionKey} onClick={onReport}>
            {t(report ? 'aiteam.run.hideReport' : 'aiteam.history.fullReport')}
          </button>
        )}
        {foot.canContinue && onContinue && (
          <button type="button" className="chat-feed-link" data-run-continue={meta.sessionKey} onClick={onContinue}>{t('aiteam.run.continue')}</button>
        )}
        {foot.noReport && <span data-run-no-report={meta.sessionKey}>{t('aiteam.run.noReport')}</span>}
        {foot.line && <span data-run-line={foot.line}>{t(foot.line === 'otherMac' ? 'aiteam.run.otherMac' : 'aiteam.run.noSession')}</span>}
      </div>
      {steps && meta.claudeId && <RunView claudeId={meta.claudeId} live={meta.status === 'running'} />}
      {report && meta.runId && <RunReport slug={meta.source} runId={meta.runId} onOpenFile={onOpenFile} />}
    </div>
  );
}

export interface RunPin { slug: string; runId: string; title: string; startedAt: string; running: boolean }

/** Above the box: the run this box now writes to, what a refusal said, and the way out. */
export function RunPinLine({ pin, note, onClose }: { pin: RunPin; note: string | null; onClose: () => void }) {
  const { t } = useI18n();
  const delivery = useReplyDelivery(pin.slug, pin.runId).data;
  const refused = delivery && delivery.status !== 'ok' && delivery.status !== 'running' ? delivery.reason ?? t('agents.thread.unknown') : null;
  const at = new Date(pin.startedAt);
  const time = Number.isNaN(at.getTime()) ? '' : at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <div className="run-pin" data-run-pin={`${pin.slug}::${pin.runId}`}>
      <div className="run-pin-row">
        <TeamIcon name="clock" size={12} />
        <span className="run-pin-text">{t('aiteam.run.continuing').replace('{title}', pin.title).replace('{time}', time)}</span>
        <button type="button" className="aiteam-iconbtn run-pin-x" aria-label={t('aiteam.run.endPin')} title={t('aiteam.run.endPin')} onClick={onClose} data-run-pin-close>×</button>
      </div>
      {pin.running && <p className="run-pin-note" data-run-pin-queues>{t('aiteam.run.queues')}</p>}
      {(note ?? refused) && <p className="run-pin-note run-pin-note--bad" role="alert" data-run-pin-refused>{note ?? refused}</p>}
    </div>
  );
}

/** Every open question of this agent's routines, pinned above the box: an old run outside the
 *  loaded pages still shows, because this reads the questions, not the feed. */
export function StageQuestions({ agent, onToast }: { agent: string; onToast: (msg: string) => void }) {
  const { t } = useI18n();
  const questions = useAutomationQuestions().data;
  const automations = useAutomations().data;
  // One line until the owner opens it: a question card would otherwise take the flow's room.
  const [open, setOpen] = useState(false);
  const mine = (questions ?? []).filter((q) => {
    if (q.kind !== 'flow-hitl' || q.state !== 'pending') return false;
    if (q.slug === agent) return true;
    return (automations ?? []).some((a) => a.slug === q.slug && a.agent === agent);
  });
  if (mine.length === 0) return null;
  return (
    <div className="stage-questions" data-stage-questions>
      <button type="button" className="stage-questions-bar" aria-expanded={open} data-stage-questions-toggle onClick={() => setOpen((v) => !v)}>
        <span className="stage-questions-line">{mine[0].question.split('\n')[0]}{mine.length > 1 ? ` +${mine.length - 1}` : ''}</span>
        <span className="stage-questions-go">{t(open ? 'aiteam.run.hideQuestion' : 'aiteam.run.answer')}</span>
      </button>
      {open && mine.map((q) => (
        <AgentQuestionBlock
          key={q.id}
          slug={q.slug}
          title={automations?.find((a) => a.slug === q.slug)?.title ?? q.slug}
          question={{ id: q.id, text: q.question, choices: q.choices }}
          onToast={onToast}
        />
      ))}
    </div>
  );
}
