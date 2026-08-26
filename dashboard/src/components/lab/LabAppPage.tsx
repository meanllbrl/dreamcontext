import { useEffect, useMemo } from 'react';
import { useApplyTweaks, useLabInsight, useSyncInsight } from '../../hooks/useLab';
import { useVault } from '../../context/VaultContext';
import { copyPreservingUnicode } from '../../lib/clipboard';
import { RangeControl } from './RangeControl';
import { LabAppFrame } from './LabAppFrame';
import { findAppPage } from './appModel';
import { currentDeepLink, pushLabAppPath, readAppParams, useLabSearchParams } from './funnel/labRoute';
import './LabAppPage.css';

/**
 * `app/v1` insight page — the routed, multi-page, full-screen-capable
 * counterpart to `FunnelOverviewPage`/`FunnelDetailPage` for a script-authored
 * app body. Mounted at `/lab/<slug>` (entry page, `pageId` null) and
 * `/lab/<slug>/p/<pageId>`.
 *
 * Full-screen is a URL-driven CSS overlay (`?fs=1` + `.lab-app-page--fullscreen`),
 * NOT the native Fullscreen API — so it deep-links, survives reload, and is
 * Playwright-drivable, matching the same contract the task doc pins.
 */
export function LabAppPage({ slug, pageId, onBack, onToast }: {
  slug: string;
  pageId: string | null;
  onBack: () => void;
  onToast: (msg: string) => void;
}) {
  const { bus } = useVault();
  const detail = useLabInsight(slug);
  const sync = useSyncInsight();
  const applyTweaks = useApplyTweaks();
  const [searchParams, updateSearchParams] = useLabSearchParams();

  const sanitizedAppParams = useMemo(() => readAppParams(searchParams), [searchParams]);
  const appParams = sanitizedAppParams.params;
  const fullscreen = searchParams.get('fs') === '1';
  const applying = applyTweaks.isPending;

  const exitFullscreen = () => updateSearchParams((p) => p.delete('fs'));

  // Escape exits full screen. Only reaches key presses on the HOST document —
  // a sandboxed iframe without `allow-same-origin` dispatches its own key
  // events inside its own document, never bubbling to the parent — so the
  // visible "Exit full screen" button stays the reliable affordance when
  // focus has moved into the app body itself.
  useEffect(() => {
    if (!fullscreen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') exitFullscreen();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullscreen]);

  // `readAppParams` already caps what THIS render hands `<LabAppFrame>` — but
  // an over-cap URL (hand-typed, bookmarked, or shared by someone else,
  // never touching `pushLabAppPath`) would otherwise stay in the address bar
  // exactly as written, so Copy-link would echo params the app never
  // actually received. Normalize it away: a `replaceSearch` (no history
  // entry — this is a correction, not a navigation), converging in one pass
  // since the rewritten URL re-sanitizes to `dropped: []` on the next render.
  useEffect(() => {
    if (sanitizedAppParams.dropped.length === 0) return;
    updateSearchParams((p) => {
      for (const key of [...p.keys()]) {
        if (key.startsWith('p.')) p.delete(key);
      }
      for (const [key, value] of Object.entries(sanitizedAppParams.params)) p.set(`p.${key}`, value);
    });
  }, [sanitizedAppParams, updateSearchParams]);

  if (detail.isLoading) {
    return <div className="lab-app-page"><div className="lab-app-page-state">Loading…</div></div>;
  }
  if (detail.isError || !detail.data) {
    return (
      <div className="lab-app-page">
        <AppBreadcrumb onBack={onBack} title={slug} />
        <div className="lab-app-page-state lab-app-page-state--error">
          Failed to load the insight. {(detail.error as Error)?.message}
        </div>
      </div>
    );
  }

  const title = detail.data.insight.title;
  const cache = detail.data.cache;
  const spec = cache?.app?.spec ?? null;
  const datasets = cache?.datasets?.bundle ?? null;
  const tweaks = detail.data.insight.tweaks ?? [];

  if (!spec || spec.pages.length === 0) {
    return (
      <div className="lab-app-page">
        <AppBreadcrumb onBack={onBack} title={title} />
        <div className="lab-app-page-state">
          No app body yet — sync this insight to build it.
          <button
            className="lab-app-page-syncbtn"
            onClick={() => sync.mutate(slug, { onError: (e) => onToast(`Sync failed — ${(e as Error).message}`) })}
            disabled={sync.isPending}
          >{sync.isPending ? 'Syncing…' : 'Sync now'}</button>
        </div>
      </div>
    );
  }

  const page = findAppPage(spec, pageId);
  const activePageId = page?.id ?? spec.entry;
  const stale = !!(detail.data.insight.refresh
    && cache?.fetchedAt
    && (Date.now() - Date.parse(cache.fetchedAt)) / 60_000 >= detail.data.insight.refresh.ttl_minutes);

  const applyRange = (values: Record<string, string>, label: string) => {
    applyTweaks.mutate({ slug, tweaks: values }, {
      onSuccess: ({ synced, error }) => onToast(
        synced ? `${label} applied.` : `${label} saved, but the re-fetch failed — ${error}`,
      ),
      onError: (err) => onToast(`${label} failed — ${(err as Error).message}`),
    });
  };

  const handleRefresh = () => sync.mutate(slug, {
    onSuccess: (data) => {
      const result = data.results[0];
      onToast(result?.status === 'failed' ? `Refresh failed — ${result.error ?? 'unknown error'}` : 'Refreshed.');
    },
    onError: (e) => onToast(`Refresh failed — ${(e as Error).message}`),
  });

  // The ONLY writer of a `navigate` request into the URL — `onNavigate` fires
  // from a `postMessage` handler inside `LabAppFrame`, not a direct click, so
  // it MUST pass the bus (labRoute.ts's own documented rule for anything that
  // can fire without a click).
  const handleNavigate = (nextPageId: string, nextParams: Record<string, string>) => {
    pushLabAppPath(slug, nextPageId, nextParams, bus);
  };

  const copyLink = () => {
    void copyPreservingUnicode(currentDeepLink(bus)).then((ok) => onToast(ok ? 'Deep link copied.' : 'Copy failed.'));
  };

  const frame = (
    // Keyed by slug+pageId (never params): a page change must remount
    // LabAppFrame (fresh nonce, fresh load count — see its own contract);
    // in-page param changes are pushed over the bridge instead.
    <LabAppFrame
      key={`${slug}:${activePageId}`}
      slug={slug}
      spec={spec}
      pageId={pageId}
      params={appParams}
      datasets={datasets}
      mode={fullscreen ? 'full' : 'page'}
      title={title}
      onNavigate={handleNavigate}
      onToast={onToast}
    />
  );

  if (fullscreen) {
    return (
      <div className="lab-app-page lab-app-page--fullscreen">
        <div className="lab-app-page-fs-bar">
          <span className="lab-app-page-fs-title">
            {title}{spec.pages.length > 1 && page ? ` · ${page.title}` : ''}
          </span>
          <button className="lab-app-page-fs-exit" onClick={exitFullscreen}>Exit full screen (Esc)</button>
        </div>
        <div className="lab-app-page-fs-body">{frame}</div>
      </div>
    );
  }

  return (
    <div className="lab-app-page">
      <AppBreadcrumb onBack={onBack} title={title} />

      <div className="lab-app-page-toolbar">
        <RangeControl tweaks={tweaks} disabled={applying || sync.isPending} onApply={applyRange} />
        {applying && <span className="lab-badge lab-badge--loading">loading…</span>}
        {stale && !applying && <span className="lab-badge lab-badge--stale">stale</span>}
        <div className="lab-app-page-toolbar-spacer" />
        <button className="lab-app-page-action" onClick={copyLink} title="Copy a link to this page">Copy link</button>
        <button className="lab-app-page-action" onClick={() => updateSearchParams((p) => p.set('fs', '1'))} title="Open full screen">
          ⛶ Full screen
        </button>
        <button className="lab-app-page-action" onClick={handleRefresh} disabled={sync.isPending || applying}>
          {sync.isPending || applying ? 'Syncing…' : '↻ Refresh'}
        </button>
      </div>

      {spec.pages.length > 1 && (
        <div className="lab-app-page-tabs" role="tablist" aria-label="Pages">
          {spec.pages.map((p) => (
            <button
              key={p.id}
              role="tab"
              aria-selected={p.id === activePageId}
              className={`lab-app-page-tab${p.id === activePageId ? ' lab-app-page-tab--active' : ''}`}
              onClick={() => p.id !== activePageId && pushLabAppPath(slug, p.id, {}, bus)}
            >{p.title}</button>
          ))}
        </div>
      )}

      <div className="lab-app-page-body">{frame}</div>
    </div>
  );
}

/** A local, self-contained breadcrumb — `FunnelOverviewPage`'s `Breadcrumb` is
 *  unexported (private to that module, which this task does not own), so this
 *  is a small twin rather than a cross-file reach. Styled independently in
 *  `LabAppPage.css`. */
function AppBreadcrumb({ onBack, title }: { onBack: () => void; title: string }) {
  return (
    <nav className="lab-app-crumbs" aria-label="Breadcrumb">
      <button className="lab-app-crumb-link" onClick={onBack}>Insights</button>
      <span className="lab-app-crumb-sep" aria-hidden>/</span>
      <span className="lab-app-crumb-here" aria-current="page">{title}</span>
    </nav>
  );
}
