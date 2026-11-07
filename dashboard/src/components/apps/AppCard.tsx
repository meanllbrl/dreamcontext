import { useState } from 'react';
import { useApi } from '../../context/VaultContext';
import { useI18n } from '../../context/I18nContext';
import { ConfigSheet, ConfirmSheet, PublishSheet, UpdateSheet, useShareT } from './ShareSheets';

/** One app as `GET /api/apps` returns it (src/server/routes/apps.ts `publicStatus`). */
export interface AppRow {
  slug: string;
  name: string;
  state: 'stopped' | 'starting' | 'running' | 'updating' | 'error' | string;
  stoppedByOwner?: boolean;
  lastError?: string | null;
  warnings?: string[];
  iconIssue?: { code: 'dreamcontext_logo' | 'not_servable' } | null;
  windows?: number;
  hasBackend?: boolean;
  unguarded?: boolean;
  portFallback?: boolean;
  agent?: string | null;
  agentState?: 'ready' | 'needs_approval' | 'missing' | null;
  hasIcon?: boolean;
  actions?: Array<{ id: string; title: string }>;
  /** What its tools do and whether the backend serves them (app-araclari §5, `publicStatus`). */
  tools?: { count: number; change: number; audit: 'ok' | 'drift' | 'unaudited' | 'unknown' | string; missing: string[] } | null;
  schedules?: Array<{ id: string; enabled: boolean; next: string | null; last: { at: string; status: string; code: string | null } | null }>;
  mcp?: Array<{ name: string; state: string; source: string | null; message?: string }>;
  /** Shared apps (src/server/routes/apps-share.ts `shareStatus`). */
  origin?: 'own' | 'installed';
  source?: { fullName: string; owner: string; public: boolean; autoUpdate: boolean; available: string | null; problem: 'no_access' | 'moved' | 'not_forward' | null; lastUpdate?: { to: string; at: string; auto: boolean; depsFailed?: string } | null } | null;
  provenance?: { fullName: string } | null;
  publish?: { fullName: string; public: boolean; at: string } | null;
  configCount?: number;
  configMissing?: string[];
}

type ShareOpen = 'publish' | 'config' | 'update' | 'detach' | 'uninstall' | null;

function when(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const STATE_TONE: Record<string, string> = {
  running: 'good', starting: 'busy', updating: 'busy', error: 'bad', stopped: 'idle',
};

/**
 * The app card (dreamcontext-apps plan r19, "İlk 30 saniye" 2): logo, name, state, assigned
 * agent, Launch. On a phone or outside the Mac app it says the app opens in the Mac app and
 * has no Launch.
 */
export function AppCard({ app, vault, canLaunch, setup, onChanged }: { app: AppRow; vault: string; canLaunch: boolean; setup?: { scheduler: boolean; notifications: boolean }; onChanged: () => void }) {
  const api = useApi();
  const { t } = useI18n();
  const [busy, setBusy] = useState<'launch' | 'stop' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [iconFailed, setIconFailed] = useState(false);
  const [sheet, setSheet] = useState<ShareOpen>(null);
  const ts = useShareT();
  const installed = app.origin === 'installed';
  const following = installed && !!app.source;
  const [undoing, setUndoing] = useState(false);
  const undoUpdate = async () => {
    if (undoing) return;
    setErr(null); setUndoing(true);
    try { await api.ownerPost(`/apps/${encodeURIComponent(app.slug)}/update/undo`, {}); onChanged(); } catch (e) { setErr((e as Error).message); } finally { setUndoing(false); }
  };
  const toggleAuto = async (on: boolean) => {
    setErr(null);
    try { await api.ownerPost(`/apps/${encodeURIComponent(app.slug)}/auto-update`, { enabled: on }); onChanged(); } catch (e) { setErr((e as Error).message); }
  };
  const live = (app.windows ?? 0) > 0;
  const state = app.stoppedByOwner ? 'stopped' : app.state;
  const tone = STATE_TONE[state] ?? 'idle';

  const installSetup = async () => {
    setErr(null);
    setNotes([]);
    try {
      const r = await api.post<{ warnings?: string[] }>('/automations/dispatcher/install', {});
      setNotes(r.warnings ?? []);
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const run = async (kind: 'launch' | 'stop') => {
    setBusy(kind);
    setErr(null);
    try {
      await api.post(`/apps/${encodeURIComponent(app.slug)}/${kind}`, kind === 'launch' ? { owner: true } : {});
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <article className="app-card" data-state={state}>
      <div className="app-card__head">
        {app.hasIcon && canLaunch && !iconFailed ? (
          <img className="app-card__logo" src={`/api/apps/${encodeURIComponent(app.slug)}/icon?vault=${encodeURIComponent(vault)}`} alt="" onError={() => setIconFailed(true)} />
        ) : (
          <div className="app-card__logo app-card__logo--blank" aria-hidden>{app.name.slice(0, 1).toUpperCase()}</div>
        )}
        <div className="app-card__title">
          <h3>{app.name}</h3>
          <span className={`app-card__state app-card__state--${tone}`}>{t(`apps.state.${state}`)}{live ? ` · ${t('apps.windowOpen')}` : ''}</span>
        </div>
      </div>
      <dl className="app-card__meta">
        <div><dt>{t('apps.agent')}</dt><dd>{app.agent ?? t('apps.noAgent')}</dd></div>
        {app.tools && app.tools.count > 0 ? (
          <div>
            <dt>{t('apps.tools')}</dt>
            <dd>
              {t(app.tools.count === 1 ? 'apps.tools.count.one' : 'apps.tools.count').replace('{n}', String(app.tools.count))}
              {app.tools.change > 0 && ` · ${t(app.tools.change === 1 ? 'apps.tools.change.one' : 'apps.tools.change').replace('{n}', String(app.tools.change))}`}
              {app.tools.audit === 'drift' && (
                <span className="app-card__drift">
                  {' · '}<span aria-hidden="true">⚠ </span>{t('apps.tools.drift')}{app.tools.missing.length > 0 && `: ${app.tools.missing.join(', ')}`}
                </span>
              )}
              {app.tools.audit === 'unaudited' && <span className="app-card__muted">{` · ${t('apps.tools.unaudited')}`}</span>}
            </dd>
          </div>
        ) : (app.actions?.length ?? 0) > 0 && <div><dt>{t('apps.actions')}</dt><dd>{app.actions!.length}</dd></div>}
        {(app.schedules?.length ?? 0) > 0 && <div><dt>{t('apps.schedules')}</dt><dd>{app.schedules!.length}</dd></div>}
      </dl>
      {(following || app.provenance || app.publish) && (
        <p className="app-card__origin">
          {following ? ts('share.card.from', { who: app.source!.owner })
            : app.provenance ? ts('share.card.ownCopy', { repo: app.provenance.fullName })
            : ts(app.publish!.public ? 'share.card.publishedPublic' : 'share.card.published', { repo: app.publish!.fullName })}
        </p>
      )}
      {following && app.source!.available && (
        <div className="app-card__note app-card__note--accent app-card__mcp">
          <span>{t('share.card.updateReady')}</span>
          {canLaunch && <button type="button" className="app-card__stop" onClick={() => setSheet('update')}>{t('share.card.update')}</button>}
        </div>
      )}
      {following && app.source!.lastUpdate && (
        <div className={`app-card__mcp ${app.source!.lastUpdate.depsFailed ? 'app-card__note app-card__note--bad' : 'app-card__origin'}`}>
          <span>
            {ts(app.source!.lastUpdate.auto ? 'share.card.updatedAuto' : 'share.card.updated', { when: new Date(app.source!.lastUpdate.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) })}
            {app.source!.lastUpdate.depsFailed ? ` ${ts('share.card.depsFailed', { why: app.source!.lastUpdate.depsFailed })}` : ''}
          </span>
          {canLaunch && <button type="button" className="share-link" disabled={undoing} onClick={() => void undoUpdate()}>{t('share.update.undo')}</button>}
        </div>
      )}
      {following && app.source!.problem && <p className="app-card__note app-card__note--warn">{t(`share.card.problem.${app.source!.problem}`)}</p>}
      {(app.configMissing?.length ?? 0) > 0 && (
        <div className="app-card__note app-card__note--warn app-card__mcp">
          <span>{ts('share.card.settingsNeeded', { keys: app.configMissing!.join(', ') })}</span>
          {canLaunch && <button type="button" className="app-card__stop" onClick={() => setSheet('config')}>{t('share.card.settings')}</button>}
        </div>
      )}
      {(app.schedules?.length ?? 0) > 0 && (
        <ul className="app-card__list">
          {app.schedules!.map((s) => (
            <li key={s.id}>
              <span className="app-card__list-name">{s.id}</span>
              <span className="app-card__list-meta">
                {!s.enabled ? t('apps.schedule.off') : `${t('apps.schedule.next')} ${when(s.next)}`}
                {' · '}
                {s.last ? `${t('apps.schedule.last')} ${when(s.last.at)} (${s.last.code === 'app_stopped' ? t('apps.schedule.skippedStopped') : s.last.status})` : t('apps.schedule.never')}
              </span>
            </li>
          ))}
        </ul>
      )}
      {(app.mcp ?? []).filter((m) => m.state !== 'ok').map((m) => (
        <div key={m.name} className="app-card__note app-card__note--warn app-card__mcp">
          <span>MCP <strong>{m.name}</strong>: {t(`apps.mcp.${m.state}`)}{m.message ? ` (${m.message})` : ''}</span>
          {(m.state === 'needs_owner_ok' || m.state === 'changed') && canLaunch && (
            <button type="button" className="app-card__stop" onClick={async () => {
              try { await api.post(`/apps/${encodeURIComponent(app.slug)}/mcp-request`, { server: m.name }); onChanged(); }
              catch (e) { setErr((e as Error).message); }
            }}>{t('apps.mcp.ask')}</button>
          )}
        </div>
      ))}
      {canLaunch && setup && !setup.scheduler && (app.schedules?.length ?? 0) > 0 && (
        <div className="app-card__note app-card__note--warn app-card__mcp">
          <span>{t('apps.setup.scheduler')}</span>
          <button type="button" className="app-card__stop" onClick={() => void installSetup()}>{t('apps.setup.install')}</button>
        </div>
      )}
      {canLaunch && setup && !setup.notifications && (
        <div className="app-card__note app-card__note--warn app-card__mcp">
          <span>{t('apps.setup.notifications')}</span>
          <button type="button" className="app-card__stop" onClick={() => void installSetup()}>{t('apps.setup.turnOn')}</button>
        </div>
      )}
      {notes.map((n) => <p key={n} className="app-card__note app-card__note--warn">{n}</p>)}
      {app.agentState === 'needs_approval' && <p className="app-card__note app-card__note--warn">{t('apps.agentNeedsApproval')}</p>}
      {app.agentState === 'missing' && <p className="app-card__note app-card__note--warn">{t('apps.agentMissing')}</p>}
      {app.iconIssue && <p className="app-card__note app-card__note--warn">{t(`apps.icon.${app.iconIssue.code}`)}</p>}
      {app.unguarded && <p className="app-card__note app-card__note--warn">{t('apps.unguarded')}</p>}
      {app.portFallback && <p className="app-card__note app-card__note--warn">{t('apps.portFallback')}</p>}
      {state === 'error' && app.lastError && <p className="app-card__note app-card__note--bad">{app.lastError}</p>}
      {err && <p className="app-card__note app-card__note--bad">{err}</p>}
      <div className="app-card__foot">
        {canLaunch ? (
          <>
            <button type="button" className="app-card__launch" disabled={busy !== null} onClick={() => void run('launch')}>
              {busy === 'launch' ? t('apps.opening') : live ? t('apps.focus') : t('apps.launch')}
            </button>
            {app.hasBackend && state !== 'stopped' && (
              <button type="button" className="app-card__stop" disabled={busy !== null} onClick={() => void run('stop')}>{t('apps.stop')}</button>
            )}
          </>
        ) : (
          <span className="app-card__mac-only">{t('apps.macOnly')}</span>
        )}
      </div>
      {canLaunch && (
        <div className="app-card__share">
          {(!installed || !following) && <button type="button" className="share-link" onClick={() => setSheet('publish')}>{t('share.card.share')}</button>}
          {(app.configCount ?? 0) > 0 && <button type="button" className="share-link" onClick={() => setSheet('config')}>{t('share.card.settings')}</button>}
          {following && <button type="button" className="share-link" onClick={() => setSheet('update')}>{t('share.card.checkUpdate')}</button>}
          {following && !app.source!.public && (
            <label className="share-link share-link--check"><input type="checkbox" checked={app.source!.autoUpdate} onChange={(e) => void toggleAuto(e.target.checked)} /> {t('share.card.autoUpdate')}</label>
          )}
          {following && <button type="button" className="share-link" onClick={() => setSheet('detach')}>{t('share.card.makeOwn')}</button>}
          {installed && <button type="button" className="share-link" onClick={() => setSheet('uninstall')}>{t('share.card.uninstall')}</button>}
        </div>
      )}
      {sheet === 'publish' && <PublishSheet slug={app.slug} name={app.name} publishedPublic={app.publish?.public} onClose={() => setSheet(null)} onDone={onChanged} />}
      {sheet === 'config' && <ConfigSheet slug={app.slug} name={app.name} onClose={() => setSheet(null)} onDone={onChanged} />}
      {sheet === 'update' && <UpdateSheet slug={app.slug} name={app.name} from={app.source?.fullName ?? ''} onClose={() => setSheet(null)} onDone={onChanged} onDetach={() => setSheet('detach')} />}
      {(sheet === 'detach' || sheet === 'uninstall') && <ConfirmSheet kind={sheet} slug={app.slug} name={app.name} onClose={() => setSheet(null)} onDone={onChanged} />}
    </article>
  );
}
