import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../context/VaultContext';
import { CardHeader } from './molecules';
import { APP_FAILURE, decide, type AppCard, type DecideOutcome } from '../../assistant/ProposalList';
import type { AppRequestViewSpec } from '../../../lib/chatViewSpec';

type RequestState = 'pending' | 'approved' | 'rejected' | 'expired' | 'stale' | 'replaced' | 'used';

const STATE_LINE: Record<Exclude<RequestState, 'pending'>, string> = {
  approved: 'Onaylandı. Claude şimdi yapıyor.',
  used: 'Onaylandı ve yapıldı.',
  rejected: 'Reddedildi. Hiçbir şey çalışmadı.',
  expired: 'Süresi doldu. Claude yeniden sorar.',
  stale: 'App bu kart açıldıktan sonra değişti; onaylanmadı. Claude yeniden sorar.',
  replaced: 'Yerine daha yeni bir kart geldi.',
};

/**
 * ORGANISM — the `dream-view` APP-REQUEST card (owner 2026-11-13, app-kurulum-claude ek-3/ek-4):
 * an app install, publish, update or logo an agent asked for, answered IN the chat that asked,
 * with one tap. Before this the card lived only on the notch and on Telegram while he was away,
 * and an agent said "the card is on your screen" when it was on neither.
 *
 * DERIVED, like `automation`: the block names the card id; the plan is the server's
 * (`GET /api/apps/requests/card/:id`). Onayla and Reddet go through the very route the notch uses
 * (`decide`, the proposal id plus the plan's hash), so one yes anywhere closes every copy, and the
 * card follows the request's state while it waits.
 *
 * On mount it tells the server the card is DRAWN here (`shown`), which is the only thing that lets
 * the agent say where the card is.
 */
export function AppRequestCard({ spec, report }: { spec: AppRequestViewSpec; report?: (text: string) => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const key = ['apps', 'request-card', spec.id];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.get<{ state: RequestState; card: AppCard }>(`/apps/requests/card/${encodeURIComponent(spec.id)}`),
    retry: false,
    // While it waits, follow a decision made elsewhere (the notch, Telegram).
    refetchInterval: (query) => (query.state.data?.state === 'pending' ? 3000 : false),
  });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<DecideOutcome | null>(null);
  const told = useRef(false);
  const pending = q.data?.state === 'pending';

  useEffect(() => {
    if (!pending || told.current) return;
    told.current = true;
    void api.post(`/apps/requests/card/${encodeURIComponent(spec.id)}/shown`, { where: 'chat' }).catch(() => { told.current = false; });
  }, [api, pending, spec.id]);

  const act = async (action: 'approve' | 'reject') => {
    const card = q.data?.card;
    if (!card || busy) return;
    setBusy(true);
    setFailure(null);
    const outcome = await decide(spec.id, action, undefined, card.hash);
    setBusy(false);
    if (outcome === 'ok' || outcome === 'gone' || outcome === 'stale') {
      await queryClient.invalidateQueries({ queryKey: key });
      if (outcome === 'ok' && action === 'reject') report?.(`[app request turned down · ${card.appName}] The owner said no on its card. Nothing ran. Do not ask again unless something changed.`);
      return;
    }
    setFailure(outcome);
  };

  if (q.isLoading) return <div className="chat-viewcard chat-autocard" data-view-kind="app-request"><CardHeader glyph="✋" title="Onay kartı yükleniyor" /></div>;
  if (q.isError || !q.data) {
    return (
      <div className="chat-viewcard chat-autocard" data-view-kind="app-request" data-state="missing">
        <CardHeader glyph="✋" title="Onay kartı" />
        <p className="chat-autocard-note">Bu kart artık yok (karar verildi, süresi doldu ya da uygulama yeniden başladı). Claude gerekirse yeniden sorar.</p>
      </div>
    );
  }

  const { state, card } = q.data;
  const image = card.image ? `${card.image}?vault=${encodeURIComponent(card.vault)}` : null;
  const tone = state === 'approved' || state === 'used' ? 'approved' : state === 'pending' ? 'waiting' : 'off';
  return (
    <div className="chat-viewcard chat-autocard" data-view-kind="app-request" data-state={state}>
      <CardHeader
        glyph="✋"
        title={card.title}
        aside={<span className="chat-autocard-state" data-state={tone}>{state === 'pending' ? (card.renewal ? 'Süresi doldu' : 'Onayını bekliyor') : card.appName}</span>}
      />
      {image && <img className="chat-appreq-image" src={image} alt={`${card.appName} için yeni logo`} />}
      <dl className="chat-autocard-facts">
        {card.lines.map((l, i) => (
          <div key={i} style={{ display: 'contents' }} data-tone={l.tone}>
            <dt>{l.label}</dt>
            <dd className={l.tone ? `chat-appreq-${l.tone}` : undefined}>{l.value}</dd>
          </div>
        ))}
      </dl>
      {card.warn && <p className="chat-autocard-error" role="note">{card.warn}</p>}
      {state !== 'pending' && <p className="chat-autocard-note" data-decided={state}>{STATE_LINE[state]}</p>}
      {failure && APP_FAILURE[failure] && <p className="chat-autocard-error" role="alert">{APP_FAILURE[failure]}</p>}
      {state === 'pending' && (
        <div className="chat-autocard-foot">
          <p className="chat-autocard-note">Onaylarsan Claude bunu bir kez yapar.</p>
          <button type="button" className="chat-btn pill" disabled={busy} onClick={() => { void act('reject'); }}>Reddet</button>
          {failure !== 'refused' && (
            <button type="button" className="chat-btn pill primary" disabled={busy} onClick={() => { void act('approve'); }}>Onayla</button>
          )}
        </div>
      )}
    </div>
  );
}
