import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../context/VaultContext';
import { useI18n } from '../../../context/I18nContext';
import { RequestError } from '../../../api/client';
import { useAgent } from '../../../hooks/useAgents';
import { useAutomation } from '../../../hooks/useAutomations';
import { TeamIcon } from '../../aiteam/TeamIcons';
import { superApprovalSentence, type SuperApproval } from './superApprovals';
import '../../../pages/AiTeamPage.css';
import './TaskStrip.css';

/**
 * WHAT WAITS FOR YOUR APPROVAL, on the Super Agent's own screen (owner 2026-11-06): every AI Team
 * member and routine that may not run on this Mac until he says so, one row each, above the
 * centre chat. Before this he had to find the member on the AI Team page.
 *
 * Approve lives inside Review, as on the AI Team page: it grants only text that was read fresh and
 * is on screen (re-read on every opening, off until that read lands), never a row he never opened.
 * Decline is one tap from the row: it turns the item off (a routine's approval is withdrawn too, a
 * member's switch goes off), never deletes it. Both decisions go through
 * the owner's page only (`refuseUnlessOwnerPage` on the routes): the Super Agent or a child
 * calling them is refused `owner_page_only`, so nothing here lets an agent approve itself. The
 * super's own session rides along, so it hears the decision as an `automation` event.
 *
 * The rows are derived (`superApprovals`): a decided item leaves when the lists are re-read.
 */
export function SuperApprovalBand({ items, superId, toast, onToast }: {
  items: SuperApproval[];
  superId: string | null;
  /** The last decision's answer. Held by the stage, so it outlives the last row it answers. */
  toast: string;
  onToast: (msg: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState<string | null>(null);
  if (items.length === 0 && !toast) return null;
  return (
    <div className="super-member-band super-approvals" data-testid="super-approvals" role="region" aria-label={t('super.approvals.title')}>
      {items.length > 0 && (
        <p className="super-approvals-head">{t('super.approvals.title')}<span className="super-approvals-n">{items.length}</span></p>
      )}
      {items.length > 0 && (
        <div className="aiteam-approval">
          {items.map((it) => (
            <ApprovalRow
              key={it.key}
              item={it}
              superId={superId}
              open={open === it.key}
              onOpen={(on) => setOpen(on ? it.key : null)}
              onDone={onToast}
            />
          ))}
        </div>
      )}
      {toast && <p role="status" className="super-member-note" data-testid="super-approvals-toast">{toast}</p>}
    </div>
  );
}

function ApprovalRow({ item, superId, open, onOpen, onDone }: {
  item: SuperApproval;
  superId: string | null;
  open: boolean;
  onOpen: (open: boolean) => void;
  onDone: (msg: string) => void;
}) {
  const { t } = useI18n();
  const api = useApi();
  const queryClient = useQueryClient();
  // Read only while open, and fresh: the text on screen is what the file says now.
  const agentDetail = useAgent(open && item.kind === 'agent' ? item.slug : null, { fresh: true });
  const routineDetail = useAutomation(open && item.kind === 'routine' ? item.slug : null, { fresh: true });
  const detail = item.kind === 'agent' ? agentDetail : routineDetail;
  const review = item.kind === 'agent' ? agentDetail.data?.review : routineDetail.data?.review;
  // Proof of looking: Approve only once this opening's own read has landed.
  const ready = !!review && !detail.isFetching && detail.isFetchedAfterMount;
  // Which decision is in flight: each button says its own.
  const [busy, setBusy] = useState<null | 'approved' | 'rejected'>(null);
  const [error, setError] = useState<string | null>(null);

  const toggle = () => {
    // Every opening re-reads: the row stays mounted between openings, so a cached copy would show.
    if (!open) {
      void queryClient.invalidateQueries({ queryKey: item.kind === 'agent' ? ['agents', item.slug] : ['automations', item.slug], exact: true });
    }
    onOpen(!open);
  };

  const decide = async (decision: 'approved' | 'rejected') => {
    if (busy || (decision === 'approved' && !(open && ready))) return;
    setBusy(decision);
    setError(null);
    const slug = encodeURIComponent(item.slug);
    const sessionId = superId ?? undefined;
    try {
      if (item.kind === 'routine') {
        await api.post(`/automations/${slug}/${decision === 'approved' ? 'approve' : 'reject'}`, { sessionId });
      } else if (decision === 'approved') {
        await api.post(`/agents/${slug}/approve`, { sessionId });
      } else {
        await api.post(`/agents/${slug}/enabled`, { enabled: false, sessionId });
      }
      onOpen(false);
      onDone(t(decision === 'approved' ? 'super.approvals.approved' : 'super.approvals.declined').replace('{name}', item.title));
      // A routine's approval also lends its member the right to talk: re-read both lists.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['agents'] }),
        queryClient.invalidateQueries({ queryKey: ['automations'] }),
      ]);
    } catch (err) {
      setError(t(err instanceof RequestError && err.code === 'owner_page_only' ? 'super.approvals.refused' : 'super.approvals.failed'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className={`aiteam-approval-row super-approval-row${open ? ' aiteam-approval-row--open' : ''}`}
      data-super-approval={item.key}
      data-testid="super-approval-row"
    >
      <div className="aiteam-approval-line">
        <span className="aiteam-approval-mark" aria-hidden="true"><TeamIcon name={item.keepsWorking ? 'check' : 'lock'} size={12} /></span>
        <span className="aiteam-approval-text">{superApprovalSentence(item, t)}</span>
        <span className="super-approval-actions">
          <button type="button" className="agent-btn" aria-expanded={open} onClick={toggle} data-testid="super-approval-review">
            {t(open ? 'aiteam.approval.hide' : 'aiteam.approval.review')}
          </button>
          {/* Declining switches the member off or takes its approval back: never on a member that
              keeps working while a newer version waits (owner 2026-11-08). Review and approve only. */}
          {!item.keepsWorking && (
            <button type="button" className="agent-btn" disabled={busy !== null} onClick={() => { void decide('rejected'); }} data-testid="super-approval-decline">
              {t(busy === 'rejected' ? 'super.approvals.declining' : 'super.approvals.decline')}
            </button>
          )}
        </span>
      </div>
      {open && (
        <div className="aiteam-approval-review" data-approval-review>
          <p className="aiteam-approval-lead">{t('agents.approval.reviewLead')}</p>
          <pre className="aiteam-approval-pre">
            {review ?? (detail.isError ? t('agents.page.loadFailed') : t('agents.page.loading'))}
          </pre>
          <div className="aiteam-approval-foot">
            <button type="button" className="agent-btn agent-btn--primary" disabled={busy !== null || !ready} onClick={() => { void decide('approved'); }} data-testid="super-approval-approve">
              {t(busy === 'approved' ? 'agents.approval.approving' : 'agents.approval.approve')}
            </button>
          </div>
        </div>
      )}
      {error && <p className="agp-error super-approval-error" role="alert">{error}</p>}
    </div>
  );
}
