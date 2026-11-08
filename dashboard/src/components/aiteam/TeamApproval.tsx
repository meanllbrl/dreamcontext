import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useI18n } from '../../context/I18nContext';
import { useAgent, useAnswerBoardScope, useApproveAgent } from '../../hooks/useAgents';
import { useApproveAutomation, useAutomation } from '../../hooks/useAutomations';
import type { PendingApproval } from './teamModel';
import { TeamIcon } from './TeamIcons';

/**
 * WHAT WAITS FOR YOUR APPROVAL, at the top of the conversation: the member's ONE approval card.
 * Whatever is made on this Mac stamps itself (owner 2026-11-07, `localWriteStamps`); this card is
 * only for what came new or changed by team sync, or text a background run wrote with an injection
 * sign (a new address, a command, a secret path, a hidden character). Each row names the fields
 * that moved (`changedFields`, from the machine-local field hashes of the last stamp) when this Mac
 * knows them. The card says the rule in one line under its rows.
 *
 * The rule is unchanged: nothing runs on this Mac until the owner approved exactly what it is
 * (a machine-local SHA-256 of every hashed field). Only where it is said moved: one line per
 * pending item, above the conversation, never at the bottom of the profile. "Review" opens the
 * very text Approve grants (the CLI's own `approve` review), and Approve is only offered once
 * that text is on screen and freshly read.
 */
export function TeamApproval({
  agentTitle,
  pending,
  onToast,
}: {
  agentTitle: string;
  pending: PendingApproval[];
  onToast: (msg: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState<string | null>(null);
  if (pending.length === 0) return null;
  return (
    <div className="aiteam-approval" data-team-approval role="region" aria-label={t('aiteam.approval.aria').replace('{name}', agentTitle)}>
      {pending.map((p) => p.kind === 'board-scope' ? (
        <BoardScopeRow key={`${p.kind}:${p.slug}`} item={p} agentTitle={agentTitle} onToast={onToast} />
      ) : (
        <ApprovalRow
          key={`${p.kind}:${p.slug}`}
          item={p}
          agentTitle={agentTitle}
          open={open === `${p.kind}:${p.slug}`}
          onOpen={(on) => setOpen(on ? `${p.kind}:${p.slug}` : null)}
          onToast={onToast}
        />
      ))}
      <p className="aiteam-approval-lead" data-approval-rule>{t('agents.approval.rule')}</p>
    </div>
  );
}

/** The one sentence a pending item is said in. */
export function approvalSentence(p: PendingApproval, agentTitle: string, t: (k: string) => string): string {
  const changed = p.reason === 'manifest-changed' || p.reason === 'payload-format-changed';
  const key = p.kind === 'routine'
    ? (changed ? 'aiteam.approval.routineChanged' : 'aiteam.approval.routineNew')
    : p.blocksTalk
      ? (changed ? 'aiteam.approval.talkChanged' : 'aiteam.approval.talkNew')
      : 'aiteam.approval.runOnly';
  return t(key).replace('{name}', agentTitle).replace('{routine}', p.title);
}

/**
 * The ONE question an older home-board agent owes (owner 2026-11-07): boards stopped limiting
 * their agents, and an agent that was limited before stays limited until the owner says which it
 * is. Keep writes `scope: board` into its file (his own edit); Let it work opens it on this Mac.
 * Nothing waits on it: the agent keeps working, limited, until he answers.
 */
function BoardScopeRow({ item, agentTitle, onToast }: { item: PendingApproval; agentTitle: string; onToast: (msg: string) => void }) {
  const { t } = useI18n();
  const answer = useAnswerBoardScope();
  const [error, setError] = useState<string | null>(null);
  const send = (keep: boolean) => {
    if (answer.isPending) return;
    setError(null);
    answer.mutate({ slug: item.slug, keep }, {
      onSuccess: () => onToast(t(keep ? 'aiteam.boardScope.kept' : 'aiteam.boardScope.lifted').replace('{name}', agentTitle)),
      onError: (err: unknown) => setError((err as Error).message),
    });
  };
  return (
    <div className="aiteam-approval-row" data-approval-item={`board-scope:${item.slug}`}>
      <div className="aiteam-approval-line">
        <span className="aiteam-approval-mark" aria-hidden="true"><TeamIcon name="lock" size={12} /></span>
        <span className="aiteam-approval-text">
          {t('aiteam.boardScope.question').replace('{name}', agentTitle)}
          <span className="aiteam-approval-fields"> {t('aiteam.boardScope.why')}</span>
        </span>
      </div>
      {error && <p className="agp-error" role="alert">{error}</p>}
      <div className="aiteam-approval-foot">
        <button type="button" className="agent-btn" onClick={() => send(true)} disabled={answer.isPending} data-board-scope="keep">
          {t('aiteam.boardScope.keep')}
        </button>
        <button type="button" className="agent-btn agent-btn--primary" onClick={() => send(false)} disabled={answer.isPending} data-board-scope="lift">
          {t('aiteam.boardScope.lift')}
        </button>
      </div>
    </div>
  );
}

function ApprovalRow({
  item, agentTitle, open, onOpen, onToast,
}: {
  item: PendingApproval;
  agentTitle: string;
  open: boolean;
  onOpen: (open: boolean) => void;
  onToast: (msg: string) => void;
}) {
  const { t } = useI18n();
  // Read only while open, and fresh: Approve must grant what is on disk NOW.
  const agentDetail = useAgent(open && item.kind === 'agent' ? item.slug : null, { fresh: true });
  const routineDetail = useAutomation(open && item.kind === 'routine' ? item.slug : null, { fresh: true });
  const approveAgent = useApproveAgent();
  const approveRoutine = useApproveAutomation();
  const queryClient = useQueryClient();
  // Which fields moved since this Mac last stamped it: read whether or not the row is open.
  const agentFacts = useAgent(item.kind === 'agent' ? item.slug : null);
  const routineFacts = useAutomation(item.kind === 'routine' ? item.slug : null);
  const changedFields = ((item.kind === 'agent' ? agentFacts.data : routineFacts.data) as { changedFields?: string[] | null } | undefined)?.changedFields ?? null;
  const [error, setError] = useState<string | null>(null);

  const detail = item.kind === 'agent' ? agentDetail : routineDetail;
  const review = item.kind === 'agent' ? agentDetail.data?.review : routineDetail.data?.review;
  const pendingWrite = approveAgent.isPending || approveRoutine.isPending;
  const ready = !!review && !detail.isFetching && detail.isFetchedAfterMount;

  const toggle = () => {
    setError(null);
    // Every opening re-reads: the row stays mounted between openings, so `refetchOnMount` alone
    // would show a cached copy. Approve stays off until this read lands (`isFetching`).
    if (!open) {
      void queryClient.invalidateQueries({ queryKey: item.kind === 'agent' ? ['agents', item.slug] : ['automations', item.slug], exact: true });
    }
    onOpen(!open);
  };
  const approve = () => {
    if (!ready || pendingWrite) return;
    const done = {
      onSuccess: () => {
        // A routine's approval also lends its agent the right to talk: re-read both.
        void queryClient.invalidateQueries({ queryKey: ['agents'] });
        onOpen(false);
        onToast(t('aiteam.approval.done').replace('{name}', item.kind === 'routine' ? item.title : agentTitle));
      },
      onError: (err: unknown) => setError((err as Error).message),
    };
    if (item.kind === 'agent') approveAgent.mutate(item.slug, done);
    else approveRoutine.mutate(item.slug, done);
  };

  return (
    <div className={`aiteam-approval-row${open ? ' aiteam-approval-row--open' : ''}`} data-approval-item={`${item.kind}:${item.slug}`}>
      <div className="aiteam-approval-line">
        <span className="aiteam-approval-mark" aria-hidden="true"><TeamIcon name="lock" size={12} /></span>
        <span className="aiteam-approval-text">
          {approvalSentence(item, agentTitle, t)}
          {changedFields && changedFields.length > 0 && (
            <span className="aiteam-approval-fields" data-approval-fields> {t('agents.approval.synced').replace('{fields}', changedFields.join(', '))}</span>
          )}
        </span>
        <button type="button" className="agent-btn aiteam-approval-btn" onClick={toggle} aria-expanded={open}>
          {open ? t('aiteam.approval.hide') : t('aiteam.approval.review')}
        </button>
      </div>
      {open && (
        <div className="aiteam-approval-review" data-approval-review>
          <p className="aiteam-approval-lead">{t('agents.approval.reviewLead')}</p>
          <pre className="aiteam-approval-pre">
            {review ?? (detail.isError ? t('agents.page.loadFailed') : t('agents.page.loading'))}
          </pre>
          {error && <p className="agp-error" role="alert">{error}</p>}
          <div className="aiteam-approval-foot">
            <button type="button" className="agent-btn" onClick={toggle} disabled={pendingWrite}>{t('agents.approval.cancel')}</button>
            <button type="button" className="agent-btn agent-btn--primary" onClick={approve} disabled={!ready || pendingWrite}>
              {pendingWrite ? t('agents.approval.approving') : t('agents.approval.approve')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
