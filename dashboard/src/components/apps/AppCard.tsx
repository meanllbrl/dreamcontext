import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useApi, useVault } from '../../context/VaultContext';
import { useI18n } from '../../context/I18nContext';
import { ConfigSheet, ConfirmSheet, Sheet, UpdateSheet, useShareT } from './ShareSheets';
import { AppIcon } from './AppIcon';
import { About, CanList, FactStrip, ProductTop, Shots, WhatsNew, shortDate, type CanLine, type StoreEntry } from './StorePage';
import { askAgent } from './askAgent';
import { publishPrompt } from './publishPrompt';
import { preparePrompt } from '../../lib/agentPrompt';
import { requestDelegateAgent } from '../../lib/delegateAgent';
import { confirmAction } from '../../lib/desktop';
import { AppDataLine, AppDataTileLine, type AppDataView } from './AppDataNotice';

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
  /** The owner's own logo from Settings, and its stamp (busts the card's image cache). */
  logo?: boolean;
  iconStamp?: number | null;
  /** Still the letter `apps new` drew: drawn as the monogram fallback. */
  iconPlaceholder?: boolean;
  actions?: Array<{ id: string; title: string }>;
  /** What its tools do and whether the backend serves them (app-araclari §5, `publicStatus`). */
  tools?: { count: number; change: number; audit: 'ok' | 'drift' | 'unaudited' | 'unknown' | string; missing: string[] } | null;
  schedules?: Array<{ id: string; enabled: boolean; next: string | null; last: { at: string; status: string; code: string | null } | null }>;
  mcp?: Array<{ name: string; state: string; source: string | null; message?: string }>;
  /** Shared apps (src/server/routes/apps-share.ts `shareStatus`). */
  origin?: 'own' | 'installed';
  source?: { fullName: string; owner: string; mode?: 'following' | 'own'; public: boolean; autoUpdate: boolean; available: string | null; problem: 'no_access' | 'moved' | 'not_forward' | null; lastCheck?: string | null; lastUpdate?: { to: string; at: string; auto: boolean; depsFailed?: string } | null } | null;
  provenance?: { fullName: string } | null;
  publish?: { fullName: string; public: boolean; at: string } | null;
  /** Own published app whose files differ from the last publish (app-onay-karti D11). */
  unpublished?: boolean;
  configCount?: number;
  configMissing?: string[];
  /** Its team data (app-veri-ortak K9): mode, counts, the paths awaiting the owner, a pull landing. */
  data?: AppDataView;
}

type ShareOpen = 'config' | 'update' | 'detach' | 'uninstall' | null;

function when(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const STATE_TONE: Record<string, string> = {
  running: 'good', starting: 'busy', updating: 'busy', error: 'bad', stopped: 'idle',
};

/** The icon URL the page may draw: a raster the app really has, never the placeholder letter. */
export function appIconSrc(app: Pick<AppRow, 'slug' | 'hasIcon' | 'iconPlaceholder' | 'iconStamp'>, vault: string, canLaunch: boolean): string | null {
  // `r` busts the image cache when the owner's logo changes (the URL stays the same otherwise).
  return app.hasIcon && !app.iconPlaceholder && canLaunch ? `/api/apps/${encodeURIComponent(app.slug)}/icon?vault=${encodeURIComponent(vault)}${app.iconStamp ? `&r=${app.iconStamp}` : ''}` : null;
}

function stateOf(app: AppRow): string {
  return app.stoppedByOwner ? 'stopped' : app.state;
}

/** One small badge per tile, the most useful first: settings missing, an update, my own copy. */
function tileBadge(app: AppRow): { key: string; tone: 'warn' | 'accent' | 'plain' } | null {
  if ((app.configMissing?.length ?? 0) > 0) return { key: 'store.badge.settings', tone: 'warn' };
  if (app.state === 'error') return { key: 'store.badge.problem', tone: 'warn' };
  if (app.origin === 'installed' && app.source?.available) return { key: 'store.badge.update', tone: 'accent' };
  if (app.origin === 'installed' && !app.source && app.provenance) return { key: 'store.badge.ownCopy', tone: 'plain' };
  if (app.publish) return { key: app.publish.public ? 'store.badge.public' : 'store.badge.shared', tone: 'plain' };
  return null;
}

/** Launch or stop: the tile's Open and the page's Open/Stop share it. */
function useRun(slug: string, onChanged: () => void) {
  const api = useApi();
  const [busy, setBusy] = useState<'launch' | 'stop' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = async (kind: 'launch' | 'stop') => {
    setBusy(kind); setErr(null);
    try { await api.post(`/apps/${encodeURIComponent(slug)}/${kind}`, kind === 'launch' ? { owner: true } : {}); onChanged(); } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };
  return { busy, err, setErr, run };
}

/**
 * A tile on the Apps shelf (app-paylasim-magaza r2 section 2): the icon carries it, then the name,
 * one line (its state, or who it came from), at most one badge, and Open. The tile opens the app's
 * own page, where everything else lives.
 */
export function AppTile({ app, vault, canLaunch, onOpen, onChanged }: { app: AppRow; vault: string; canLaunch: boolean; onOpen: () => void; onChanged: () => void }) {
  const { t } = useI18n();
  const ts = useShareT();
  const state = stateOf(app);
  const live = (app.windows ?? 0) > 0;
  const { busy, err, run } = useRun(app.slug, onChanged);
  const badge = tileBadge(app);
  const sub = app.origin === 'installed' && app.source ? ts('store.by', { who: app.source.owner }) : `${t(`apps.state.${state}`)}${live ? ` · ${t('apps.windowOpen')}` : ''}`;
  return (
    <article className="app-tile" data-state={state}>
      <button type="button" className="app-tile__open" onClick={onOpen} aria-label={ts('store.openPage', { name: app.name })}>
        <AppIcon src={appIconSrc(app, vault, canLaunch)} name={app.name} slug={app.slug} size={64} running={state === 'running'} />
        <span className="app-tile__text">
          <span className="app-tile__name">{app.name}</span>
          <span className={`app-tile__sub app-card__state--${STATE_TONE[state] ?? 'idle'}`}>{sub}</span>
        </span>
      </button>
      <div className="app-tile__foot">
        {badge ? <span className={`app-chip app-chip--${badge.tone}`}>{t(badge.key)}</span> : <span />}
        {canLaunch ? (
          <button type="button" className={state === 'running' || live ? 'app-tile__btn app-tile__btn--primary' : 'app-tile__btn'} disabled={busy !== null} onClick={() => void run('launch')}>
            {busy === 'launch' ? t('apps.opening') : live ? t('apps.focus') : t('store.open')}
          </button>
        ) : <span className="app-card__mac-only">{t('apps.macOnly')}</span>}
      </div>
      {/* Its data is not decided yet (app-veri-ortak K9): said here on its own tile, never as a row above the shelves. */}
      <AppDataTileLine app={app} canLaunch={canLaunch} />
      {err && <p className="app-card__note app-card__note--bad">{err}</p>}
    </article>
  );
}

interface OwnStore { tagline: string | null; category: string | null; about: string | null; whatsNew: StoreEntry[]; shots: Array<{ alt: string; src: string }>; can: CanLine[] }

/**
 * An app's own page: the same store page an installer sees, with Open and the rare actions
 * (share, settings, updates, my own copy, uninstall) and every note the old card carried.
 */
export function AppPage({ app, vault, canLaunch, onClose, onChanged }: { app: AppRow; vault: string; canLaunch: boolean; onClose: () => void; onChanged: () => void }) {
  const api = useApi();
  const { bus } = useVault();
  const { t } = useI18n();
  const ts = useShareT();
  const [sheet, setSheet] = useState<ShareOpen>(null);
  const installed = app.origin === 'installed';
  const following = installed && !!app.source;
  const state = stateOf(app);
  const live = (app.windows ?? 0) > 0;
  const { busy, err, setErr, run } = useRun(app.slug, onChanged);
  const [undoing, setUndoing] = useState(false);
  const store = useQuery({ queryKey: ['app-store', vault, app.slug], queryFn: () => api.get<OwnStore>(`/apps/${encodeURIComponent(app.slug)}/store`), staleTime: 10_000, enabled: canLaunch });
  const s = store.data;

  const undoUpdate = async () => {
    if (undoing) return;
    setErr(null); setUndoing(true);
    try { await api.ownerPost(`/apps/${encodeURIComponent(app.slug)}/update/undo`, {}); onChanged(); } catch (e) { setErr((e as Error).message); } finally { setUndoing(false); }
  };
  // Its error stands under Manage, beside the switch the owner just used.
  const [manageErr, setManageErr] = useState<string | null>(null);
  // The band's own error: it stands under the band's button, where the owner clicked.
  const [bandErr, setBandErr] = useState<string | null>(null);
  /**
   * Share (Publish) hands the publish to Claude (owner 2026-11-06): no form. The click opens the
   * one-hour grant for this app, then a develop chat on screen gets the prompt that has Claude
   * clean, write the store page, run the gate and publish with the CLI. Never the Super (app
   * onay karti): a publish is work for a chat of its own, so with the Super on screen a new chat
   * opens. `update`: the band's "Publish the update"; its error shows in the band.
   */
  const [handing, setHanding] = useState(false);
  const handToClaude = async (visibility: 'private' | 'public', update = false) => {
    if (handing) return;
    const fail = update ? setBandErr : setManageErr;
    // Public is for good: the owner's own yes, one line, before anything is handed over. A new
    // version of an app that is already public asks nothing: it changes no one's access.
    if (visibility === 'public' && !(update && app.publish?.public) && !(await confirmAction({ title: ts('share.public.confirmTitle', { name: app.name }), body: t('share.public.confirmBody'), confirmLabel: t('share.card.sharePublic') }))) return;
    setBandErr(null); setManageErr(null); setHanding(true);
    try {
      const g = await api.ownerPost<{ grant: string; visibility: 'private' | 'public' }>(`/apps/${encodeURIComponent(app.slug)}/publish/grant`, { visibility });
      const prompt = publishPrompt({ slug: app.slug, name: app.name, grant: g.grant, visibility: g.visibility, published: app.publish ?? null, update });
      askAgent(bus, prompt, {
        notSuper: true,
        taken: () => { setHanding(false); onClose(); },
        // No chat on screen can take it (none open, or its box holds a draft): a new chat starts
        // with the prompt, shown, the way a delegated task does.
        missed: () => {
          void preparePrompt(vault, prompt).then((pp) => {
            setHanding(false);
            if (requestDelegateAgent(bus, { title: ts('store.publish.tab', { name: app.name }), prompt: pp.inline, promptToken: pp.token, bypass: false, reveal: true })) onClose();
            else fail(t('store.publish.missed'));
          }, (e) => { setHanding(false); fail((e as Error).message); });
        },
      });
    } catch (e) { setHanding(false); fail((e as Error).message); }
  };
  const toggleAuto = async (on: boolean) => {
    setManageErr(null);
    try { await api.ownerPost(`/apps/${encodeURIComponent(app.slug)}/auto-update`, { enabled: on }); onChanged(); } catch (e) { setManageErr((e as Error).message); }
  };

  const by = following ? ts('store.by', { who: app.source!.owner })
    : app.provenance ? ts('share.card.ownCopy', { repo: app.provenance.fullName })
    : t('store.madeHere');
  const top = s?.whatsNew[0];
  const facts = [
    app.tools && app.tools.count > 0
      ? { value: String(app.tools.count), label: t(app.tools.count === 1 ? 'apps.tools.count.one' : 'apps.tools.count').replace('{n}', '').trim() }
      : { value: String(app.actions?.length ?? 0), label: t((app.actions?.length ?? 0) === 1 ? 'store.fact.action' : 'store.fact.actions') },
    { value: String(app.schedules?.length ?? 0), label: t((app.schedules?.length ?? 0) === 1 ? 'store.fact.schedule' : 'store.fact.schedules') },
    { value: app.agent ?? t('apps.noAgent'), label: t('apps.agent') },
    ...(top ? [{ value: `v${top.version}`, label: shortDate(top.date) || t('store.version.label') }] : []),
  ];

  return (
    <Sheet page title={app.name} onClose={onClose}>
      <ProductTop
        icon={appIconSrc(app, vault, canLaunch)}
        name={app.name}
        slug={app.slug}
        running={state === 'running'}
        by={<>{by} · <span className={`app-card__state--${STATE_TONE[state] ?? 'idle'}`}>{t(`apps.state.${state}`)}{live ? ` · ${t('apps.windowOpen')}` : ''}</span></>}
        tagline={s?.tagline}
        actions={canLaunch ? (
          <>
            <button type="button" className="app-card__launch pp-btn-lg" disabled={busy !== null} onClick={() => void run('launch')}>{busy === 'launch' ? t('apps.opening') : live ? t('apps.focus') : t('store.open')}</button>
            {app.hasBackend && state !== 'stopped' && <button type="button" className="app-card__stop" disabled={busy !== null} onClick={() => void run('stop')}>{t('apps.stop')}</button>}
            {app.publish && <span className="app-chip">{ts(app.publish.public ? 'share.card.publishedPublic' : 'share.card.published', { repo: app.publish.fullName })}</span>}
            {s?.category && <span className="app-chip">{s.category}</span>}
          </>
        ) : <span className="app-card__mac-only">{t('apps.macOnly')}</span>}
      />
      <FactStrip facts={facts} />
      <div className="pp-notes-block">
        <AppDataLine app={app} canLaunch={canLaunch} onChanged={onChanged} />
        {!following && app.publish && app.unpublished && canLaunch && (
          <div className="app-card__note app-card__note--accent app-card__mcp">
            <span>{t('share.card.unpublished')}</span>
            <button type="button" className="app-card__stop" disabled={handing} onClick={() => void handToClaude(app.publish!.public ? 'public' : 'private', true)}>{t('share.card.publishUpdate')}</button>
          </div>
        )}
        {/* Only while the band stands: once the publish went, its old failure is not news. */}
        {bandErr && !following && app.publish && app.unpublished && <p className="app-card__note app-card__note--bad" role="alert">{bandErr}</p>}
        {following && app.source!.available && (
          <div className="app-card__note app-card__note--accent app-card__mcp">
            <span>{t('share.card.updateReady')}</span>
            {canLaunch && <button type="button" className="app-card__stop" onClick={() => setSheet('update')}>{t('share.card.update')}</button>}
          </div>
        )}
        {following && app.source!.lastUpdate && (
          <div className={`app-card__mcp ${app.source!.lastUpdate.depsFailed ? 'app-card__note app-card__note--bad' : 'app-card__origin'}`}>
            <span>
              {ts(app.source!.lastUpdate.auto ? 'share.card.updatedAuto' : 'share.card.updated', { when: when(app.source!.lastUpdate.at) })}
              {app.source!.lastUpdate.depsFailed ? ` ${ts('share.card.depsFailed', { why: app.source!.lastUpdate.depsFailed })}` : ''}
            </span>
            {canLaunch && <button type="button" className="share-link" disabled={undoing} onClick={() => void undoUpdate()}>{t('share.update.undo')}</button>}
          </div>
        )}
        {following && app.source!.problem && <p className="app-card__note app-card__note--warn">{t(`share.card.problem.${app.source!.problem}`)}</p>}
        {(app.configMissing?.length ?? 0) > 0 && (
          <div className="app-card__note app-card__note--warn app-card__mcp">
            <span>{t('share.card.settingsNeeded')}</span>
            {canLaunch && <button type="button" className="app-card__stop" onClick={() => setSheet('config')}>{t('share.card.settings')}</button>}
          </div>
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
        {app.tools && app.tools.audit === 'drift' && (
          <p className="app-card__note app-card__note--warn"><span aria-hidden="true">⚠ </span>{t('apps.tools.drift')}{app.tools.missing.length > 0 && `: ${app.tools.missing.join(', ')}`}</p>
        )}
        {app.tools && app.tools.audit === 'unaudited' && <p className="app-card__muted">{t('apps.tools.unaudited')}</p>}
        {app.agentState === 'needs_approval' && <p className="app-card__note app-card__note--warn">{t('apps.agentNeedsApproval')}</p>}
        {app.agentState === 'missing' && <p className="app-card__note app-card__note--warn">{t('apps.agentMissing')}</p>}
        {app.iconIssue && <p className="app-card__note app-card__note--warn">{t(`apps.icon.${app.iconIssue.code}`)}</p>}
        {!installed && app.iconPlaceholder && (
          <div className="app-card__note app-card__note--warn app-card__mcp">
            <span>{t('store.icon.placeholder')}</span>
            <button type="button" className="app-card__stop" onClick={() => { onClose(); askAgent(bus, ts('store.ask.icon', { slug: app.slug }), { fallback: { vault, title: app.name } }); }}>{t('store.ask')}</button>
          </div>
        )}
        {app.unguarded && <p className="app-card__note app-card__note--warn">{t('apps.unguarded')}</p>}
        {app.portFallback && <p className="app-card__note app-card__note--warn">{t('apps.portFallback')}</p>}
        {state === 'error' && app.lastError && (
          <div className="app-card__note app-card__note--bad app-card__mcp">
            <span>{app.lastError}</span>
            {canLaunch && <button type="button" className="app-card__stop" onClick={() => { onClose(); askAgent(bus, ts('store.ask.startFailed', { slug: app.slug, error: app.lastError! }), { fallback: { vault, title: app.name } }); }}>{t('store.ask')}</button>}
          </div>
        )}
        {err && <p className="app-card__note app-card__note--bad">{err}</p>}
      </div>
      <Shots shots={s?.shots ?? []} />
      <About text={s?.about} />
      <CanList lines={s?.can ?? []} extra={(app.schedules?.length ?? 0) > 0 ? (
        <ul className="app-card__list pp-runs">
          {app.schedules!.map((sc) => (
            <li key={sc.id}>
              <span className="app-card__list-name">{sc.id}</span>
              <span className="app-card__list-meta">
                {!sc.enabled ? t('apps.schedule.off') : `${t('apps.schedule.next')} ${when(sc.next)}`}
                {' · '}
                {sc.last ? `${t('apps.schedule.last')} ${when(sc.last.at)} (${sc.last.code === 'app_stopped' ? t('apps.schedule.skippedStopped') : sc.last.status})` : t('apps.schedule.never')}
              </span>
            </li>
          ))}
        </ul>
      ) : undefined} />
      <WhatsNew entry={top} />
      {canLaunch && (
        <section className="pp-sec" aria-label={t('store.manage')}>
          <h3>{t('store.manage')}</h3>
          {following && !app.source!.public && (
            <label className="share-link share-link--check"><input type="checkbox" checked={app.source!.autoUpdate} onChange={(e) => void toggleAuto(e.target.checked)} /> {t('share.card.autoUpdate')}</label>
          )}
          <div className="app-card__share">
            {(!installed || !following) && <button type="button" className="share-link" disabled={handing} onClick={() => void handToClaude('private')}>{t('share.card.share')}</button>}
            {(!installed || !following) && !app.publish?.public && <button type="button" className="share-link" disabled={handing} onClick={() => void handToClaude('public')}>{t('share.card.sharePublic')}</button>}
            {/* Every app has Settings now: the owner's own logo is one of them. */}
            <button type="button" className="share-link" onClick={() => setSheet('config')}>{t('share.card.settings')}</button>
            {following && <button type="button" className="share-link" onClick={() => setSheet('update')}>{t('share.card.checkUpdate')}</button>}
            {following && <button type="button" className="share-link" onClick={() => setSheet('detach')}>{t('share.card.makeOwn')}</button>}
            {installed && <button type="button" className="share-link" onClick={() => setSheet('uninstall')}>{t('share.card.uninstall')}</button>}
          </div>
          {manageErr && <p className="app-card__note app-card__note--bad" role="alert">{manageErr}</p>}
        </section>
      )}
      {sheet === 'config' && <ConfigSheet slug={app.slug} name={app.name} iconSrc={appIconSrc(app, vault, canLaunch)} onClose={() => setSheet(null)} onDone={onChanged} />}
      {sheet === 'update' && <UpdateSheet slug={app.slug} name={app.name} from={app.source?.fullName ?? ''} onClose={() => setSheet(null)} onDone={() => { onChanged(); void store.refetch(); }} onDetach={() => setSheet('detach')} />}
      {(sheet === 'detach' || sheet === 'uninstall') && <ConfirmSheet kind={sheet} slug={app.slug} name={app.name} onClose={() => setSheet(null)} onDone={() => { onChanged(); if (sheet === 'uninstall') onClose(); }} />}
    </Sheet>
  );
}

/** Mac setup a schedule or a banner needs: one line on top of the page, never on every tile. */
export function SetupLine({ setup, apps, onChanged }: { setup?: { scheduler: boolean; notifications: boolean }; apps: AppRow[]; onChanged: () => void }) {
  const api = useApi();
  const { t } = useI18n();
  const [notes, setNotes] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!setup || !apps.length) return null;
  const needScheduler = !setup.scheduler && apps.some((a) => (a.schedules?.length ?? 0) > 0);
  const needNotify = !setup.notifications;
  if (!needScheduler && !needNotify && !notes.length && !err) return null;
  const install = async () => {
    setBusy(true); setErr(null); setNotes([]);
    try { const r = await api.post<{ warnings?: string[] }>('/automations/dispatcher/install', {}); setNotes(r.warnings ?? []); onChanged(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="apps-setup" role="note">
      {(needScheduler || needNotify) && (
        <div className="apps-setup__row">
          <span>{needScheduler && needNotify ? t('store.setup.both') : needScheduler ? t('apps.setup.scheduler') : t('apps.setup.notifications')}</span>
          <button type="button" className="app-card__stop" disabled={busy} onClick={() => void install()}>{needScheduler ? t('apps.setup.install') : t('apps.setup.turnOn')}</button>
        </div>
      )}
      {notes.map((n) => <p key={n} className="app-card__note app-card__note--warn">{n}</p>)}
      {err && <p className="app-card__note app-card__note--bad">{err}</p>}
    </div>
  );
}
