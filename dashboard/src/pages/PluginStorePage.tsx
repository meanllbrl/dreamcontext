import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useApi, useVault } from '../context/VaultContext';
import { useI18n } from '../context/I18nContext';
import { useFocusTarget, type FocusTarget } from '../hooks/useFocusTarget';
import { usePluginActions, usePlugins } from '../hooks/usePlugins';
import { RequestError } from '../api/client';
import { askAgent } from '../components/apps/askAgent';
import { copyPreservingUnicode } from '../lib/clipboard';
import { PluginIcon } from '../components/plugins/PluginIcon';
import { PluginRemoveConfirm } from '../components/plugins/PluginRemoveConfirm';
import type { SharedList } from '../components/apps/ShareSheets';
import { isDesktop } from '../lib/desktop';
import { isPhoneSurface } from '../lib/phoneSurface';
import {
  PLUGINS, PLUGIN_CATEGORIES, isPluginId, pluginById, pluginGives,
  type PluginCategory, type PluginId, type PluginMirror, type PluginState, type PluginStatus,
} from '../lib/plugins';
import type { Page } from '../components/layout/Sidebar';
import './PluginStorePage.css';

/**
 * Mağaza (D1 C7, approved drawing magaza-v3): the plugins by category, a category page and a
 * plugin's own page with Kur, three example prompts, "Kurunca gelenler" and "Bilgiler". Also
 * rendered IN PLACE of a plugin page whose plugin is not installed (`inPlaceOf`), so every route
 * to an uninstalled plugin lands here; an install then shows the original page again.
 */
type View = { kind: 'home' } | { kind: 'cat'; cat: PluginCategory } | { kind: 'plugin'; id: PluginId };

function isCategory(v: unknown): v is PluginCategory {
  return typeof v === 'string' && (PLUGIN_CATEGORIES as readonly string[]).includes(v);
}

/** `plugin:<id>`, `cat:<category>`, `home`; anything unknown falls back to the store home. */
export function parseStoreFocus(id: string | null | undefined): View {
  if (!id) return { kind: 'home' };
  if (id.startsWith('plugin:')) {
    const p = id.slice('plugin:'.length);
    return isPluginId(p) ? { kind: 'plugin', id: p } : { kind: 'home' };
  }
  if (id.startsWith('cat:')) {
    const c = id.slice('cat:'.length);
    return isCategory(c) ? { kind: 'cat', cat: c } : { kind: 'home' };
  }
  return { kind: 'home' };
}

/** The window URL's `&plugin=` / `&cat=`, read once and only by the first instance. */
function urlView(instanceId: string): View | null {
  if (instanceId !== 'inst-1' || typeof window === 'undefined') return null;
  try {
    const q = new URLSearchParams(window.location.search);
    if (q.get('page') !== 'store') return null;
    const p = q.get('plugin');
    if (p) return parseStoreFocus(`plugin:${p}`);
    const c = q.get('cat');
    if (c) return parseStoreFocus(`cat:${c}`);
  } catch { /* unparseable URL: the store home */ }
  return null;
}

let urlRead = false;

export function PluginStorePage({ focus, onNavigate, inPlaceOf }: {
  focus?: FocusTarget;
  onNavigate: (page: Page, id?: string | null) => void;
  inPlaceOf?: PluginId;
}) {
  const { t } = useI18n();
  const { instanceId } = useVault();
  const [view, setView] = useState<View>(() => {
    if (inPlaceOf) return { kind: 'plugin', id: inPlaceOf };
    if (!urlRead) {
      const v = urlView(instanceId);
      urlRead = true;
      if (v) return v;
    }
    return parseStoreFocus(focus?.id);
  });
  useFocusTarget(focus, (id) => { if (!inPlaceOf) setView(parseStoreFocus(id)); });

  const { set, pluginState } = usePlugins();
  const statusOf = (id: string): PluginStatus | undefined => set?.plugins.find((p) => p.id === id);
  const { install, remove } = usePluginActions();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; text: string } | null>(null);
  const [confirm, setConfirm] = useState<PluginId | null>(null);

  const errText = (e: unknown) => {
    if (e instanceof RequestError && e.code === 'plugin_entry_conflict') {
      return t('plugin.conflict').replace('{file}', e.file ?? e.message);
    }
    return t('plugin.failed').replace('{error}', e instanceof Error ? e.message : String(e));
  };
  const doInstall = (id: PluginId) => {
    setBusy(id);
    setError(null);
    install.mutate(id, {
      onError: (e) => setError({ id, text: errText(e) }),
      onSettled: () => setBusy(null),
    });
  };
  const doRemove = (id: PluginId) => {
    setBusy(id);
    setError(null);
    remove.mutate(id, {
      onSuccess: () => setConfirm(null),
      onError: (e) => setError({ id, text: errText(e) }),
      onSettled: () => setBusy(null),
    });
  };

  const goHome = () => (inPlaceOf ? onNavigate('store', 'home') : setView({ kind: 'home' }));
  const goCat = (cat: PluginCategory) => (inPlaceOf ? onNavigate('store', `cat:${cat}`) : setView({ kind: 'cat', cat }));
  const goPlugin = (id: PluginId) => (inPlaceOf ? onNavigate('store', `plugin:${id}`) : setView({ kind: 'plugin', id }));

  const name = (id: string) => t(`plugin.${id}.name`);
  const confirmPlugin = confirm ? pluginById(confirm) : undefined;

  return (
    <div className="plg-store" data-testid="plugin-store" data-view={view.kind}>
      {view.kind === 'plugin' ? (
        <PluginPage
          plugin={pluginById(view.id)!}
          state={pluginState(view.id)}
          status={statusOf(view.id)}
          version={set?.version ?? ''}
          busy={busy === view.id}
          error={error?.id === view.id ? error.text : null}
          onHome={goHome}
          onCat={goCat}
          onInstall={() => doInstall(view.id)}
          onRemove={() => { setError(null); setConfirm(view.id); }}
          onOpen={(page) => onNavigate(page)}
        />
      ) : (
        <StoreList
          view={view}
          pluginState={pluginState}
          statusOf={statusOf}
          busy={busy}
          error={error}
          onHome={goHome}
          onCat={goCat}
          onPlugin={goPlugin}
          onInstall={doInstall}
          onLaunchpadShared={() => onNavigate('apps', 'tab:shared')}
        />
      )}
      {confirmPlugin && (
        <PluginRemoveConfirm
          name={name(confirmPlugin.id)}
          status={statusOf(confirmPlugin.id)}
          busy={busy === confirmPlugin.id}
          error={error?.id === confirmPlugin.id ? error.text : null}
          onConfirm={() => doRemove(confirmPlugin.id)}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}

// ─── Home and category ────────────────────────────────────────────────────────

function StoreList({ view, pluginState, statusOf, busy, error, onHome, onCat, onPlugin, onInstall, onLaunchpadShared }: {
  view: { kind: 'home' } | { kind: 'cat'; cat: PluginCategory };
  pluginState: (id: string) => PluginState;
  statusOf: (id: string) => PluginStatus | undefined;
  busy: string | null;
  error: { id: string; text: string } | null;
  onHome: () => void;
  onCat: (c: PluginCategory) => void;
  onPlugin: (id: PluginId) => void;
  onInstall: (id: PluginId) => void;
  onLaunchpadShared: () => void;
}) {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const needle = q.trim().toLocaleLowerCase();
  const matches = (p: PluginMirror) => !needle
    || `${t(`plugin.${p.id}.name`)} ${t(`plugin.${p.id}.tagline`)}`.toLocaleLowerCase().includes(needle);
  const cats = view.kind === 'cat' ? [view.cat] : PLUGIN_CATEGORIES;
  const sections = cats
    .map((cat) => ({ cat, rows: PLUGINS.filter((p) => p.category === cat && matches(p)) }))
    .filter((s) => s.rows.length > 0);
  const shared = useSharedShelf(view.kind === 'home');
  const sharedRows = (shared ?? []).filter((s) => !needle || `${s.name ?? s.fullName} ${s.tagline ?? ''}`.toLocaleLowerCase().includes(needle));

  return (
    <>
      <nav className="plg-crumbs" aria-label={t('plugin.store.title')}>
        {view.kind === 'cat'
          ? <><button type="button" className="plg-crumb" onClick={onHome}>{t('plugin.store.title')}</button><span aria-hidden="true">›</span><span className="plg-crumb plg-crumb--here">{t(`plugin.category.${view.cat}`)}</span></>
          : <span className="plg-crumb plg-crumb--here">{t('plugin.store.title')}</span>}
      </nav>
      <header className="plg-head">
        <div className="plg-head__text">
          <h1 className="plg-title">{view.kind === 'cat' ? t(`plugin.category.${view.cat}`) : t('plugin.store.title')}</h1>
          <p className="plg-lede">{view.kind === 'cat' ? t(`plugin.category.${view.cat}.sub`) : t('plugin.store.lede')}</p>
        </div>
        <label className="plg-search">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></svg>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('plugin.store.search')} aria-label={t('plugin.store.search')} data-testid="plugin-search" />
        </label>
      </header>
      {sections.map((s) => (
        <section key={s.cat} className="plg-sec" aria-label={t(`plugin.category.${s.cat}`)}>
          {view.kind === 'home' && (
            <h2 className="plg-sec__h">
              <button type="button" className="plg-sec__link" onClick={() => onCat(s.cat)} data-testid={`plugin-cat-${s.cat}`}>
                {t(`plugin.category.${s.cat}`)} <span aria-hidden="true">›</span>
              </button>
            </h2>
          )}
          <div className="plg-rows">
            {s.rows.map((p) => (
              <PluginRow
                key={p.id}
                plugin={p}
                state={pluginState(p.id)}
                status={statusOf(p.id)}
                busy={busy === p.id}
                error={error?.id === p.id ? error.text : null}
                onOpen={() => onPlugin(p.id)}
                onInstall={() => onInstall(p.id)}
              />
            ))}
          </div>
        </section>
      ))}
      {view.kind === 'home' && sharedRows.length > 0 && (
        <section className="plg-sec" aria-label={t('plugin.store.shared')}>
          <h2 className="plg-sec__h">
            <button type="button" className="plg-sec__link" onClick={onLaunchpadShared}>{t('plugin.store.shared')} <span aria-hidden="true">›</span></button>
            <small className="plg-sec__sub">{t('plugin.store.sharedSub')}</small>
          </h2>
          <div className="plg-rows">
            {sharedRows.map((s) => (
              <button key={s.fullName} type="button" className="plg-row" onClick={onLaunchpadShared}>
                <span className="plg-row__ic plg-row__ic--app" aria-hidden="true">{(s.name ?? s.fullName.split('/')[1] ?? '?').slice(0, 2)}</span>
                <span className="plg-row__text">
                  <span className="plg-row__name">{s.name ?? s.fullName}</span>
                  {s.tagline && <span className="plg-row__tag">{s.tagline}</span>}
                </span>
                {s.installed && <span className="plg-row__state plg-row__state--on" aria-label={t('plugin.installed')}><Check /></span>}
              </button>
            ))}
          </div>
        </section>
      )}
      {sections.length === 0 && sharedRows.length === 0 && (
        <p className="plg-empty" role="status">{t('plugin.store.empty').replace('{q}', q.trim())}</p>
      )}
    </>
  );
}

/** "Seninle paylaşılanlar": the Shared Apps list, where Launchpad shows it (the Mac app). */
function useSharedShelf(enabled: boolean) {
  const api = useApi();
  const { vault } = useVault();
  const canLaunch = isDesktop() && !isPhoneSurface();
  const q = useQuery({
    queryKey: ['apps-shared-store', vault],
    queryFn: () => api.get<SharedList>('/apps/shared'),
    enabled: enabled && canLaunch,
    staleTime: 60_000,
    retry: 0,
  });
  return canLaunch && q.data?.signedIn ? q.data.shared : null;
}

function Check() {
  return <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>;
}

function Plus() {
  return <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>;
}

function PluginRow({ plugin, state, status, busy, error, onOpen, onInstall }: {
  plugin: PluginMirror;
  state: PluginState;
  status: PluginStatus | undefined;
  busy: boolean;
  error: string | null;
  onOpen: () => void;
  onInstall: () => void;
}) {
  const { t } = useI18n();
  const name = t(`plugin.${plugin.id}.name`);
  const conflict = !!status?.conflict;
  return (
    <div className="plg-row-wrap">
      {/* Two sibling buttons, never one inside the other: opening the page and installing are
          separate controls, each with its own keyboard and accessible name. */}
      <div className="plg-row">
        <button type="button" className="plg-row__open" onClick={onOpen} data-testid={`plugin-row-${plugin.id}`}>
          <PluginIcon id={plugin.id} size={34} />
          <span className="plg-row__text">
            <span className="plg-row__name">{name}</span>
            <span className="plg-row__tag">{conflict ? t('plugin.conflict').replace('{file}', status?.file ?? '') : t(`plugin.${plugin.id}.tagline`)}</span>
          </span>
        </button>
        {state === 'installed' ? (
          <span className="plg-row__state plg-row__state--on" aria-label={t('plugin.installed')} data-testid={`plugin-installed-${plugin.id}`}><Check /></span>
        ) : state === 'not-installed' ? (
          <button
            type="button"
            className="plg-row__state plg-row__add"
            disabled={busy || conflict}
            aria-label={t('plugin.installA11y').replace('{name}', name)}
            data-testid={`plugin-add-${plugin.id}`}
            onClick={onInstall}
          >
            <Plus />
          </button>
        ) : null}
      </div>
      {error && <p className="plg-error plg-row__err" role="alert">{error}</p>}
    </div>
  );
}

// ─── A plugin's page ──────────────────────────────────────────────────────────

function PluginPage({ plugin, state, status, version, busy, error, onHome, onCat, onInstall, onRemove, onOpen }: {
  plugin: PluginMirror;
  state: PluginState;
  status: PluginStatus | undefined;
  version: string;
  busy: boolean;
  error: string | null;
  onHome: () => void;
  onCat: (c: PluginCategory) => void;
  onInstall: () => void;
  onRemove: () => void;
  onOpen: (page: Page) => void;
}) {
  const { t } = useI18n();
  const { bus } = useVault();
  const id = plugin.id;
  const name = t(`plugin.${id}.name`);
  const conflict = !!status?.conflict;
  const [menu, setMenu] = useState(false);
  // A prompt no empty composer took (Chat holds a draft, or did not open in time) never vanishes
  // and the page never claims what did not happen: it stays here as text, unsent, with a Copy
  // button the owner presses himself (a click, so the copy is allowed, through the UTF-8-safe
  // helper), and "Copied" shows only when that copy really succeeded.
  const [missed, setMissed] = useState<{ text: string; copied: boolean | null } | null>(null);
  const ask = (p: string) => {
    setMissed(null);
    askAgent(bus, p, { missed: () => setMissed({ text: p, copied: null }) });
  };
  const copyMissed = () => {
    if (!missed) return;
    const text = missed.text;
    void copyPreservingUnicode(text).then((ok) => setMissed((m) => (m && m.text === text ? { ...m, copied: ok } : m)));
  };
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return undefined;
    const down = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenu(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false); };
    window.addEventListener('mousedown', down, true);
    window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('mousedown', down, true); window.removeEventListener('keydown', key, true); };
  }, [menu]);
  const gives = useMemo(() => pluginGives(plugin), [plugin]);
  const prompts = [1, 2, 3].map((n) => t(`plugin.${id}.prompt${n}`));
  const giveSub = (g: string) => g === 'screen' ? t('plugin.give.screenSub').replace('{name}', name)
    : g === 'command' ? `dreamcontext ${plugin.command ?? ''}`
      : g === 'agent' ? t(`plugin.${id}.agent`) : t(`plugin.${id}.sleep`);

  return (
    <div className="plg-page" data-testid={`plugin-page-${id}`} data-state={state}>
      <nav className="plg-crumbs" aria-label={t('plugin.store.title')}>
        <button type="button" className="plg-crumb" onClick={onHome}>{t('plugin.store.title')}</button>
        <span aria-hidden="true">›</span>
        <button type="button" className="plg-crumb" onClick={() => onCat(plugin.category)}>{t(`plugin.category.${plugin.category}`)}</button>
        <span aria-hidden="true">›</span>
        <span className="plg-crumb plg-crumb--here">{name}</span>
      </nav>
      <header className="plg-phead">
        <PluginIcon id={id} size={56} />
        <div className="plg-phead__id">
          <h1 className="plg-phead__name">{name} <span className="plg-tag">{t('plugin.official')}</span></h1>
          <p className="plg-phead__by">{t('plugin.by')} · {t(`plugin.${id}.tagline`)}</p>
        </div>
        <div className="plg-phead__acts">
          {state === 'installed' && (
            <div className="plg-more" ref={menuRef}>
              <button type="button" className="plg-btn plg-btn--icon" aria-label={t('plugin.more')} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)} data-testid="plugin-more">⋯</button>
              {menu && (
                <div className="plg-menu" role="menu">
                  <button type="button" role="menuitem" className="plg-menu__row plg-menu__row--danger" disabled={conflict} onClick={() => { setMenu(false); onRemove(); }} data-testid="plugin-remove">
                    {t('plugin.remove')}<span className="plg-muted">{t('plugin.dataStays')}</span>
                  </button>
                </div>
              )}
            </div>
          )}
          {state === 'installed' && plugin.page && (
            <button type="button" className="plg-btn plg-btn--primary" onClick={() => onOpen(plugin.page!)} data-testid="plugin-open">{t('plugin.open')}</button>
          )}
          {state === 'installed' && !plugin.page && <span className="plg-installed"><Check /> {t('plugin.installed')}</span>}
          {state === 'not-installed' && (
            <button type="button" className="plg-btn plg-btn--primary" disabled={busy || conflict} onClick={onInstall} data-testid="plugin-install">
              <Plus /> {t('plugin.install')}
            </button>
          )}
          {state === 'unknown' && <span className="plg-muted">{t('plugin.unknown')}</span>}
        </div>
      </header>
      {conflict && <p className="plg-error" role="status">{t('plugin.conflict').replace('{file}', status?.file ?? '')}</p>}
      {error && <p className="plg-error" role="alert">{error}</p>}

      <section className="plg-prompts" aria-label={t('plugin.prompts')}>
        {prompts.map((p, i) => (
          <button key={i} type="button" className="plg-prompt" onClick={() => ask(p)} data-testid={`plugin-prompt-${i + 1}`}>
            <span className="plg-prompt__who">{name}</span>
            <span className="plg-prompt__text">{p}</span>
            <span className="plg-prompt__go" aria-hidden="true">→</span>
          </button>
        ))}
        {missed && (
          <div className="plg-missed" role="status" data-testid="plugin-prompt-missed">
            <p className="plg-missed__why">{t('plugin.promptMissed')}</p>
            <p className="plg-missed__text">{missed.text}</p>
            <div className="plg-missed__acts">
              <button type="button" className="plg-btn" onClick={copyMissed} data-testid="plugin-prompt-copy">{t('plugin.promptCopy')}</button>
              {missed.copied === true && <span className="plg-muted">{t('plugin.promptCopied')}</span>}
              {missed.copied === false && <span className="plg-muted">{t('plugin.promptCopyFailed')}</span>}
            </div>
          </div>
        )}
      </section>

      <p className="plg-desc">{t(`plugin.${id}.desc`)}</p>

      <section className="plg-psec" aria-label={t('plugin.gives')}>
        <h2 className="plg-psec__h">{t('plugin.gives')}</h2>
        <div className="plg-gives">
          {gives.map((g) => (
            <div key={g} className="plg-give" data-testid={`plugin-give-${g}`}>
              <span className="plg-give__k">{t(`plugin.give.${g}`)}</span>
              <span className="plg-give__v">{giveSub(g)}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="plg-psec" aria-label={t('plugin.info')}>
        <h2 className="plg-psec__h">{t('plugin.info')}</h2>
        <dl className="plg-info">
          <dt>{t('plugin.info.can')}</dt><dd>{plugin.sleepStep ? t('plugin.info.canSleep') : t('plugin.info.canRead')}</dd>
          <dt>{t('plugin.info.dev')}</dt><dd>{t('plugin.by')}</dd>
          <dt>{t('plugin.info.category')}</dt><dd>{t(`plugin.category.${plugin.category}`)}</dd>
          {version && <><dt>{t('plugin.info.version')}</dt><dd>{version}</dd></>}
          <dt>{t('plugin.info.data')}</dt><dd>{t('plugin.info.dataText')}</dd>
        </dl>
      </section>
    </div>
  );
}
