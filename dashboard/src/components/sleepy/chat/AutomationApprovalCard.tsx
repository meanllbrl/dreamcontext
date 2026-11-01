import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../context/VaultContext';
import { useI18n } from '../../../context/I18nContext';
import { RequestError } from '../../../api/client';
import { CardHeader } from './molecules';
import type { AutomationViewSpec } from '../../../lib/chatViewSpec';
import type { ChatSession } from '../chatSession';

/** MIRROR of `ApprovalCardFacts` (src/lib/automations/approval-card.ts): the dashboard bundle
 *  cannot import that module (it reads the filesystem). `automation-approval-card.test.ts` pins
 *  the key set. */
export interface ApprovalCardFacts {
  slug: string;
  title: string;
  agentTitle: string | null;
  does: string;
  cadence: string;
  mode: 'sched' | 'call';
  until: 'until-turned-off' | 'only-when-called';
  reach: 'computer' | 'project' | 'board';
  tool: 'claude' | 'codex' | 'antigravity';
  board: string | null;
  mcp: string[];
  review: 'off' | 'agent' | 'output';
  approved: boolean;
  approvalReason: string | null;
  enabled: boolean;
  nextFireAt: string | null;
}

/**
 * ORGANISM — the `dream-view` AUTOMATION card: the owner's yes or no on an automation an agent or
 * the Super Agent set up and may not approve itself (owner 2026-11-01).
 *
 * DERIVED, NEVER AUTHORED, like `agent-thread`: the block names a slug, and every line here comes
 * from `GET /api/automations/:slug/card`, read from the manifest. What he approves is what the
 * file says, not what the agent wrote about it.
 *
 * Short and standalone: what it does, how often, until when, what it can reach, whether it can
 * change things. Capability, not intent: a scheduled run can write files and run commands unless
 * it lives on a board, so the card says so beside the prompt's own words.
 *
 * One tap each way. Approve (and turn on, when it is off) or Turn down (it is turned off, never
 * deleted). Both routes take the owner's page only; an agent's call is refused. When the card
 * sits in the Super Agent's chat the server tells the super (`told`); anywhere else the decision
 * is reported into this conversation, so the agent that asked carries on.
 */
type Phase = 'idle' | 'busy' | 'failed' | 'refused';

const SLOT = (s: string, vars: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');

function fireTime(iso: string | null, locale: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(locale === 'tr' ? 'tr-TR' : undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** The line the agent reads when the card is not in a Super Agent's chat. English, like every
 *  receipt a card posts (`MCP connected:`, `[ran in chat]`): it is the agent's input. */
export function decisionReport(f: ApprovalCardFacts, decision: 'approved' | 'rejected'): string {
  if (decision === 'rejected') {
    return `[automation turned down · ${f.slug}] The owner said no on its card: "${f.title}" is not approved and is off. Do not create it again unless he asks.`;
  }
  const next = f.nextFireAt ? ` Next run: ${f.nextFireAt}.` : '';
  return `[automation approved · ${f.slug}] The owner approved "${f.title}" on its card. ${f.enabled ? `It runs by itself: ${f.cadence}.${next}` : 'It is approved but off.'}`;
}

export function AutomationApprovalCard({ spec, session, report }: {
  spec: AutomationViewSpec;
  session?: ChatSession;
  report?: (text: string) => void;
}) {
  const api = useApi();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const key = ['automations', spec.slug, 'card'];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.get<{ card: ApprovalCardFacts; owned: boolean }>(`/automations/${encodeURIComponent(spec.slug)}/card`),
    retry: false,
  });
  const [phase, setPhase] = useState<Phase>('idle');
  const [decided, setDecided] = useState<'approved' | 'rejected' | null>(null);

  const decide = useCallback(async (decision: 'approved' | 'rejected') => {
    const f = q.data?.card;
    if (!f || phase === 'busy') return;
    setPhase('busy');
    try {
      const res = await api.post<{ card: ApprovalCardFacts; told: boolean }>(
        `/automations/${encodeURIComponent(spec.slug)}/${decision === 'approved' ? 'approve' : 'reject'}`,
        { enable: decision === 'approved', sessionId: session?.claudeId },
      );
      queryClient.setQueryData(key, { card: res.card, owned: true });
      void queryClient.invalidateQueries({ queryKey: ['automations'] });
      setDecided(decision);
      setPhase('idle');
      if (!res.told) report?.(decisionReport(res.card, decision));
    } catch (err) {
      setPhase(err instanceof RequestError && err.code === 'owner_page_only' ? 'refused' : 'failed');
    }
    // `key` is rebuilt every render from the slug; the slug is what it depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, phase, q.data, queryClient, report, session, spec.slug]);

  if (q.isLoading) {
    return <div className="chat-viewcard chat-autocard" data-view-kind="automation"><CardHeader glyph="⏱" title={t('chat.autocard.loading')} /></div>;
  }
  if (q.isError || !q.data) {
    const gone = q.error instanceof RequestError && q.error.status === 404;
    return (
      <div className="chat-viewcard chat-autocard" data-view-kind="automation" data-state="missing">
        <CardHeader glyph="⏱" title={spec.slug} />
        <p className="chat-autocard-note">{t(gone ? 'chat.autocard.gone' : 'chat.autocard.unreadable')}</p>
      </div>
    );
  }

  const { card: f, owned } = q.data;
  const state: 'approved' | 'off' | 'changed' | 'waiting' = f.approved
    ? 'approved'
    : !f.enabled ? 'off' : f.approvalReason === 'never-approved' ? 'waiting' : 'changed';
  const stateLabel = t(`chat.autocard.state.${state}`);
  const next = f.approved && f.enabled ? fireTime(f.nextFireAt, locale) : '';
  const canAct = owned && (state !== 'approved' || !f.enabled);
  const approveLabel = t(f.enabled ? 'chat.autocard.approve' : 'chat.autocard.approveOn');

  return (
    <div className="chat-viewcard chat-autocard" data-view-kind="automation" data-state={state}>
      <CardHeader glyph="⏱" title={f.title} aside={<span className="chat-autocard-state" data-state={state}>{stateLabel}</span>} />
      <dl className="chat-autocard-facts">
        {f.does && (<><dt>{t('chat.autocard.does')}</dt><dd>{f.does}</dd></>)}
        {f.agentTitle && (<><dt>{t('chat.autocard.as')}</dt><dd>{f.agentTitle}</dd></>)}
        <dt>{t('chat.autocard.often')}</dt><dd>{f.cadence}</dd>
        <dt>{t('chat.autocard.until')}</dt>
        <dd>{t(f.until === 'only-when-called' ? 'chat.autocard.until.call' : 'chat.autocard.until.off')}</dd>
        <dt>{t('chat.autocard.reach')}</dt>
        <dd>
          {f.reach === 'board'
            ? SLOT(t('chat.autocard.reach.board'), { board: f.board ?? '' })
            : t(f.reach === 'project' ? 'chat.autocard.reach.project' : 'chat.autocard.reach.computer')}
          {f.mcp.length > 0 && <span className="chat-autocard-sub">{SLOT(t('chat.autocard.reach.mcp'), { list: f.mcp.join(', ') })}</span>}
        </dd>
        <dt>{t('chat.autocard.changes')}</dt>
        <dd>
          {t(f.reach === 'board' ? 'chat.autocard.changes.board' : 'chat.autocard.changes.computer')}
          {f.review !== 'off' && <span className="chat-autocard-sub">{t(`chat.autocard.review.${f.review}`)}</span>}
        </dd>
      </dl>
      {next && <p className="chat-autocard-next">{SLOT(t('chat.autocard.next'), { time: next })}</p>}
      {decided === 'rejected' && <p className="chat-autocard-note">{t('chat.autocard.rejected')}</p>}
      {phase === 'refused' && <p className="chat-autocard-error">{t('chat.autocard.refused')}</p>}
      {phase === 'failed' && <p className="chat-autocard-error">{t('chat.autocard.failed')}</p>}
      {!owned && <p className="chat-autocard-note">{t('chat.autocard.teammate')}</p>}
      {canAct && (
        <div className="chat-autocard-foot">
          <p className="chat-autocard-note">{t('chat.autocard.fallback')}</p>
          {state !== 'off' && (
            <button type="button" className="chat-btn pill danger" disabled={phase === 'busy'} onClick={() => { void decide('rejected'); }}>
              {t('chat.autocard.reject')}
            </button>
          )}
          <button type="button" className="chat-btn pill primary" disabled={phase === 'busy'} onClick={() => { void decide('approved'); }}>
            {approveLabel}
          </button>
        </div>
      )}
    </div>
  );
}
