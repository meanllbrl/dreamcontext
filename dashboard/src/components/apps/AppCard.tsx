import { useState } from 'react';
import { useApi } from '../../context/VaultContext';
import { useI18n } from '../../context/I18nContext';

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
  schedules?: Array<{ id: string; enabled: boolean; next: string | null; last: { at: string; status: string; code: string | null } | null }>;
  mcp?: Array<{ name: string; state: string; source: string | null; message?: string }>;
}

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
        {(app.actions?.length ?? 0) > 0 && <div><dt>{t('apps.actions')}</dt><dd>{app.actions!.length}</dd></div>}
        {(app.schedules?.length ?? 0) > 0 && <div><dt>{t('apps.schedules')}</dt><dd>{app.schedules!.length}</dd></div>}
      </dl>
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
    </article>
  );
}
