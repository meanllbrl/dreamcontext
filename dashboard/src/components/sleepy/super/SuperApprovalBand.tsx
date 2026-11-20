import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../context/VaultContext';
import { useI18n } from '../../../context/I18nContext';
import { RequestError } from '../../../api/client';
import { useAgent } from '../../../hooks/useAgents';
import { isConditionUnseen, useApproveAutomation, useAutomation } from '../../../hooks/useAutomations';
import { useApproveAgent } from '../../../hooks/useAgents';
import { ConditionScript, conditionView } from '../../automations/ConditionScript';
import { TeamIcon } from '../../aiteam/TeamIcons';
import { OPEN_APPROVAL_EVENT, superApprovalSentence, type SuperApproval } from './superApprovals';
import { appRequestTitle, useTellShown } from '../chat/AppRequestCard';
import type { AppCard } from '../../assistant/ProposalList';
import { phoneAllows } from '../../../lib/phoneSurface';
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
 *
 * APP CARDS (owner 2026-11-13: "onay kartı yok, onay kartına basman gerekir diyor"): every app
 * install, publish, update or logo waiting in this project, whoever asked (the Super, one of its
 * jobs, any chat). It is here because the request exists, never because an agent remembered to
 * paste a block. Since 2026-11-16 ("bu istek pop up olarak gelsin") the card itself opens as a
 * pop-up (`AppRequestPopup`); here each one is ONE line that opens it again, so a pop-up he
 * closed without deciding is never lost and the band no longer covers the chat.
 */
export function SuperApprovalBand({ items, appCards = [], onOpenApp, superId, toast, onToast }: {
  items: SuperApproval[];
  /** Proposal ids of this project's waiting app cards (`useWaitingAppCards`). */
  appCards?: readonly string[];
  /** Opens a waiting app card's pop-up. */
  onOpenApp?: (id: string) => void;
  superId: string | null;
  /** The last decision's answer. Held by the stage, so it outlives the last row it answers. */
  toast: string;
  onToast: (msg: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState<string | null>(null);
  // A member card's Approve opens that member's row here (super-v3 Ü4): the same witnessed review.
  useEffect(() => {
    const on = (e: Event) => {
      const member = (e as CustomEvent<{ member?: string }>).detail?.member;
      const row = items.find((it) => it.key === `agent:${member}`) ?? items.find((it) => it.member === member);
      if (row) setOpen(row.key);
    };
    window.addEventListener(OPEN_APPROVAL_EVENT, on);
    return () => window.removeEventListener(OPEN_APPROVAL_EVENT, on);
  }, [items]);
  const count = items.length + appCards.length;
  if (count === 0 && !toast) return null;
  return (
    <div className="super-member-band super-approvals" data-testid="super-approvals" role="region" aria-label={t('super.approvals.title')}>
      {count > 0 && (
        <p className="super-approvals-head">{t('super.approvals.title')}<span className="super-approvals-n">{count}</span></p>
      )}
      {appCards.length > 0 && (
        <div className="super-approvals-apps" data-testid="super-app-cards">
          {appCards.map((id) => <AppRequestRow key={id} id={id} onOpen={() => onOpenApp?.(id)} />)}
        </div>
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

/** One waiting app card as one line: what it asks, and Open (the pop-up). Reads the same cached
 *  card the pop-up draws; it decides nothing itself. */
function AppRequestRow({ id, onOpen }: { id: string; onOpen: () => void }) {
  const { t } = useI18n();
  const api = useApi();
  const here = phoneAllows('GET', `/api/apps/requests/card/${encodeURIComponent(id)}`);
  const q = useQuery({
    enabled: here,
    queryKey: ['apps', 'request-card', id],
    queryFn: () => api.get<{ state: string; card: AppCard }>(`/apps/requests/card/${encodeURIComponent(id)}`),
    retry: false,
  });
  const card = q.data?.card;
  // The row is the card drawn on the Super's screen, pop-up or not: the agent hears it is here.
  useTellShown(id, q.data?.state === 'pending', 'super');
  return (
    <div className="aiteam-approval-row super-approval-row super-app-row" data-testid="super-app-row" data-app-request={id}>
      <div className="aiteam-approval-line">
        <span className="aiteam-approval-mark" aria-hidden="true">✋</span>
        <span className="aiteam-approval-text">{card ? appRequestTitle(card, t) : t('appreq.card')}</span>
        <span className="super-approval-actions">
          <button type="button" className="agent-btn agent-btn--primary" onClick={onOpen} data-testid="super-app-row-open">{t('super.approvals.appOpen')}</button>
        </span>
      </div>
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
  // The condition (kosullu-otomasyon C6), drawn whole above the review; one that cannot run is
  // never offered an approve. Approve sends the hash of what this opening drew.
  const condition = conditionView(item.kind === 'agent' ? agentDetail.data : routineDetail.data?.automation);
  const shownHash = item.kind === 'agent' ? agentDetail.data?.manifestHash : routineDetail.data?.manifestHash;
  const approveRoutine = useApproveAutomation();
  const approveAgent = useApproveAgent();
  // Proof of looking: Approve only once this opening's own read has landed.
  const ready = !!review && !detail.isFetching && detail.isFetchedAfterMount && !condition.conditionError;
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
      if (decision === 'approved') {
        // THE approve every door uses: it sends the shown hash and re-reads a moved script.
        if (item.kind === 'routine') await approveRoutine.mutateAsync({ slug: item.slug, shownHash, sessionId });
        else await approveAgent.mutateAsync({ slug: item.slug, shownHash, sessionId });
      } else if (item.kind === 'routine') {
        await api.post(`/automations/${slug}/reject`, { sessionId });
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
      setError(t(err instanceof RequestError && err.code === 'owner_page_only' ? 'super.approvals.refused'
        : isConditionUnseen(err) ? 'chat.autocard.condition.unseen' : 'super.approvals.failed'));
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
          {review && <ConditionScript view={condition} label />}
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
