import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../context/VaultContext';
import { useOwnerCardT } from '../../../context/I18nContext';
import { CardHeader } from './molecules';
import { APP_FAILURE, decide, type AppCard, type DecideOutcome } from '../../assistant/ProposalList';
import type { AppRequestViewSpec } from '../../../lib/chatViewSpec';
import { phoneAllows } from '../../../lib/phoneSurface';

type RequestState = 'pending' | 'approved' | 'running' | 'failed' | 'rejected' | 'expired' | 'stale' | 'replaced' | 'used';
type Line = AppCard['lines'][number];

/** The server's card titles and warnings are Turkish (the notch and Telegram draw them as they
 *  are); the chat card says them in the UI's language. An unknown one is shown as it came. */
const TITLE_KEY: Record<string, string> = {
  'Kur': 'appreq.title.install',
  'Daveti kabul et ve kur': 'appreq.title.installInvite',
  'Yayınla': 'appreq.title.publish',
  'Herkese açık yayınla': 'appreq.title.publishPublic',
  'Yeni sürümü yayınla': 'appreq.title.publishNew',
  'Güncellemeyi uygula': 'appreq.title.update',
  'Logoyu değiştir': 'appreq.title.logo',
};
const WARN_KEY: Record<string, string> = {
  'Herkese açık yayın geri alınamaz.': 'appreq.warn.public',
  'Bu güncelleme app\'in yapabileceklerini değiştiriyor.': 'appreq.warn.permissions',
  'Bu davet tanımadığın bir GitHub hesabından geliyor.': 'appreq.warn.unknownInviter',
};

/** Polls while the work is still moving: waiting, handed over, or running. */
const MOVING: ReadonlySet<RequestState> = new Set(['pending', 'approved', 'running']);

/**
 * ORGANISM — the `dream-view` APP-REQUEST card (owner 2026-11-13, app-kurulum-claude ek-3/ek-4;
 * app-ux-genel K4, K5): an app install, publish, update or logo an agent asked for, answered IN the
 * chat that asked, with one tap.
 *
 * DERIVED, like `automation`: the block names the card id; the plan is the server's
 * (`GET /api/apps/requests/card/:id`). Onayla and Reddet go through the very route the notch uses
 * (`decide`, the proposal id plus the plan's hash), so one yes anywhere closes every copy.
 *
 * The card follows the REAL work, not the decision: approved = being handed to Claude, running =
 * its grant is held, used = done, failed = the run's own plain reason (K4). When the yes came from
 * anywhere and the "[app onayı]" line did not reach the asking chat (no notch to relay it), this
 * card claims the receipt once and posts it into its own chat.
 *
 * On mount it tells the server the card is DRAWN here (`shown`), which is the only thing that lets
 * the agent say where the card is.
 */
export function AppRequestCard({ spec, report }: { spec: AppRequestViewSpec; report?: (text: string) => void }) {
  const api = useApi();
  const t = useOwnerCardT();
  const say = (key: string, vars: Record<string, string> = {}) => Object.entries(vars).reduce((s, [k, v]) => s.split(`{${k}}`).join(v), t(key));
  const queryClient = useQueryClient();
  const key = ['apps', 'request-card', spec.id];
  // The card's routes are laptop-only: on the phone it is never read, and says where it waits
  // (review r1: "this card is gone" there was false while it waited on the Mac).
  const here = phoneAllows('GET', `/api/apps/requests/card/${encodeURIComponent(spec.id)}`);
  const q = useQuery({
    enabled: here,
    queryKey: key,
    queryFn: () => api.get<{ state: RequestState; card: AppCard; failed?: string; stopped?: string; receiptOwed?: boolean }>(`/apps/requests/card/${encodeURIComponent(spec.id)}`),
    retry: false,
    refetchInterval: (query) => (query.state.data && MOVING.has(query.state.data.state) ? 3000 : false),
  });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<DecideOutcome | null>(null);
  const told = useRef(false);
  const claimed = useRef(false);
  const pending = q.data?.state === 'pending';

  useEffect(() => {
    if (!pending || told.current) return;
    told.current = true;
    void api.post(`/apps/requests/card/${encodeURIComponent(spec.id)}/shown`, { where: 'chat' }).catch(() => { told.current = false; });
  }, [api, pending, spec.id]);

  // K4: the yes did not reach the asking chat: this card posts the receipt, once (the server's
  // claim is atomic; a second card gets 409 and posts nothing).
  const owed = !!q.data?.receiptOwed && q.data.state === 'approved';
  useEffect(() => {
    if (!owed || claimed.current || !report) return;
    claimed.current = true;
    void api.post<{ line: string }>(`/apps/requests/card/${encodeURIComponent(spec.id)}/receipt`, {}).then((r) => { if (r?.line) report(r.line); }, () => {});
  }, [api, owed, report, spec.id]);

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

  if (!here) {
    return (
      <div className="chat-viewcard chat-autocard" data-view-kind="app-request" data-state="elsewhere">
        <CardHeader glyph="✋" title={t('appreq.card')} />
        <p className="chat-autocard-note">{t('appreq.elsewhere')}</p>
      </div>
    );
  }
  if (q.isLoading) return <div className="chat-viewcard chat-autocard" data-view-kind="app-request"><CardHeader glyph="✋" title={t('appreq.loading')} /></div>;
  if (q.isError || !q.data) {
    return (
      <div className="chat-viewcard chat-autocard" data-view-kind="app-request" data-state="missing">
        <CardHeader glyph="✋" title={t('appreq.card')} />
        <p className="chat-autocard-note">{t('appreq.missing')}</p>
      </div>
    );
  }

  const { state, card } = q.data;
  const install = card.action === 'install';
  const image = card.image ? `${card.image}?vault=${encodeURIComponent(card.vault)}` : null;
  const tone = state === 'used' && !q.data.stopped ? 'approved' : state === 'pending' || state === 'approved' || state === 'running' ? 'waiting' : 'off';
  const stateLine = state === 'pending' ? null
    : state === 'running' ? t(install ? 'appreq.state.running.install' : 'appreq.state.running')
    // Used, but only in part (an invitation accepted, its install held back): never "installed".
    : state === 'used' && q.data.stopped ? say('appreq.state.held', { why: q.data.stopped })
    : state === 'used' ? t(install ? 'appreq.state.used.install' : 'appreq.state.used')
    : state === 'failed' ? say('appreq.state.failed', { why: q.data.failed ?? '' })
    : t(`appreq.state.${state}`);
  const label = (l: Line) => {
    if (!l.key) return l.label;
    if (l.key === 'setting') return `${t('appreq.label.setting')}: ${l.label.replace(/^Ayar:\s*/, '')}`;
    const k = `appreq.label.${l.key}`;
    const v = t(k);
    return v === k ? l.label : v;
  };
  const value = (l: Line) => {
    if (l.key === 'invitedByUnknown') return `${l.value.replace(/\s*\([^)]*\)\s*$/, '')} (${t('appreq.value.unknownInviter')})`;
    if (!l.valueKey) return l.value;
    if (l.valueKey === 'licence.open') return say('appreq.value.licence.open', { kind: l.value.replace(/\s*\(.*$/, '') });
    const k = `appreq.value.${l.valueKey}`;
    const v = t(k);
    return v === k ? l.value : v;
  };
  const row = (l: Line, i: number) => (
    <div key={i} className="chat-appreq-line" data-tone={l.tone}>
      <dt>{label(l)}</dt>
      <dd>{value(l)}</dd>
    </div>
  );
  const main = card.lines.filter((l) => !l.detail);
  const details = card.lines.filter((l) => l.detail);
  const title = TITLE_KEY[card.title] ? t(TITLE_KEY[card.title]!) : card.title;
  const warn = card.warn ? (WARN_KEY[card.warn] ? t(WARN_KEY[card.warn]!) : card.warn) : null;
  return (
    <div className="chat-viewcard chat-autocard" data-view-kind="app-request" data-state={state}>
      <CardHeader
        glyph="✋"
        title={`${title} · ${card.appName}`}
        aside={state === 'pending' ? <span className="chat-autocard-state" data-state={tone}>{card.renewal ? t('appreq.expiredChip') : t('appreq.pending')}</span> : undefined}
      />
      {image && <img className="chat-appreq-image" src={image} alt={card.appName} />}
      <dl className="chat-autocard-facts">{main.map(row)}</dl>
      {details.length > 0 && (
        <details className="chat-appreq-details">
          <summary>{t('appreq.details')}</summary>
          <dl className="chat-autocard-facts">{details.map(row)}</dl>
        </details>
      )}
      {warn && <p className="chat-autocard-error" role="note">{warn}</p>}
      {stateLine && <p className="chat-autocard-note" data-decided={state} role="status">{stateLine}</p>}
      {failure && APP_FAILURE[failure] && <p className="chat-autocard-error" role="alert">{APP_FAILURE[failure]}</p>}
      {state === 'pending' && (
        <div className="chat-autocard-foot">
          <p className="chat-autocard-note">{t('appreq.once')}</p>
          <button type="button" className="chat-btn pill" disabled={busy} onClick={() => { void act('reject'); }}>{t('appreq.reject')}</button>
          {failure !== 'refused' && (
            <button type="button" className="chat-btn pill primary" disabled={busy} onClick={() => { void act('approve'); }}>{t('appreq.approve')}</button>
          )}
        </div>
      )}
    </div>
  );
}
