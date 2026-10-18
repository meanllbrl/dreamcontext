import { useEffect, useMemo, useRef, useState } from 'react';
import { useApplyTweaks, useLabInsight, useSyncInsight } from '../../../hooks/useLab';
import { useLabPrefs } from '../../../hooks/useLabPrefs';
import { copyPreservingUnicode } from '../../../lib/clipboard';
import {
  clientFilters,
  defaultColumnKeys,
  hasActiveFilters,
  overviewColumns,
  overviewRowMarkdown,
  overviewTableMarkdown,
  readColumnKeys,
  readViewState,
  resolveColumnKeys,
  writeColumnKeys,
  writeViewState,
  type FunnelDef,
  type FunnelDimension,
  type FunnelViewState,
} from './funnelModel';
import { labPath, pushLabPath, useLabSearchParams } from './labRoute';
import { useI18n } from '../../../context/I18nContext';
import { humanizeTweakValue } from '../tweakLabels';
import { RangeControl, isRelativeRange, writeRangeParams } from '../RangeControl';
import { FunnelFilterBar } from './FunnelFilterBar';
import { FunnelCompareView } from './FunnelCompareView';
import { ColumnPicker, FUNNEL_TABLE_EN, FunnelSetTable, nextSort, sortFunnels } from './FunnelSetTable';
import './FunnelOverviewPage.css';

/**
 * Funnel insight page 1 — the all-funnels comparison table (A3/A4/A5): metric
 * columns from the payload, stable keyboard-accessible sort, id/name search,
 * date-range presets via the range tweak, Δ-vs-previous-period chips, low-sample
 * de-emphasis, row→detail, multi-select→compare, per-row kebab (deep link / MD).
 *
 * Columns are user-chosen (the Columns popover): the payload's metrics plus the
 * derived step columns funnelModel computes client-side. The selection rides the
 * URL `cols` param and writes through to lab prefs, so a link shows the sender's
 * view and this machine remembers its own.
 */

const MAX_COMPARE = 4;

export function FunnelOverviewPage({ slug, onBack, onToast }: {
  slug: string;
  onBack: () => void;
  onToast: (msg: string) => void;
}) {
  const detail = useLabInsight(slug);
  const sync = useSyncInsight();
  const applyTweaks = useApplyTweaks();
  const { prefs, setColumnKeys } = useLabPrefs();
  const { locale } = useI18n();
  const [params, updateParams] = useLabSearchParams();
  const view = useMemo(() => readViewState(params), [params]);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const appliedUrlRange = useRef(false);

  const cache = detail.data?.cache;
  const entry = cache?.funnel;
  const prev = detail.data?.funnelPrev ?? null;
  const tweaks = detail.data?.insight.tweaks ?? [];
  const rangeTweak = tweaks.find((t) => t.key === 'range' && t.type === 'enum');
  const currentRange = rangeTweak ? (rangeTweak.value ?? rangeTweak.default ?? '') : '';
  const currentFrom = tweaks.find((t) => t.key === 'from')?.value ?? '';
  const currentTo = tweaks.find((t) => t.key === 'to')?.value ?? '';

  const setView = (next: FunnelViewState) => updateParams((p) => writeViewState(p, next));

  /**
   * Save the window and re-fetch as one act (#235) — and NAME THE OUTCOME.
   *
   * `POST /lab/sync` answers 200 with a populated `failed[]` when the adapter
   * throws (a window with no rows, an upstream error), so the old success arm
   * toasted "Custom range applied." over numbers from the window the user had
   * just left. The fused mutation has already read `results[0]`.
   */
  const applyTweaksAndSync = (values: Record<string, string>, label: string) => {
    applyTweaks.mutate({ slug, tweaks: values }, {
      onSuccess: ({ synced, error }) => onToast(
        synced ? `${label} applied.` : `${label} saved, but the re-fetch failed — ${error}`,
      ),
      onError: (err) => onToast(`${label} failed — ${(err as Error).message}`),
    });
  };

  /** True while the numbers on screen do not yet answer for the chosen window. */
  const applying = applyTweaks.isPending;

  // Deep-linked window (A13): a `from`+`to` or `range` URL param that differs
  // from the stored tweak is what the link author was looking at — apply it
  // once. from/to win, the same precedence resolveTweaks uses.
  useEffect(() => {
    if (appliedUrlRange.current || !detail.data) return;
    appliedUrlRange.current = true;
    const urlFrom = params.get('from');
    const urlTo = params.get('to');
    if (urlFrom && urlTo) {
      if (urlFrom !== currentFrom || urlTo !== currentTo) {
        applyTweaksAndSync({ from: urlFrom, to: urlTo }, 'Custom range');
      }
      return;
    }
    const urlRange = params.get('range');
    // A curated enum still governs what a link may select; an insight that
    // declares none accepts any value the engine's range grammar parses.
    const options = rangeTweak?.options ?? [];
    const selectable = !!urlRange && (options.length > 0 ? options.includes(urlRange) : isRelativeRange(urlRange));
    if (urlRange && selectable && urlRange !== currentRange) {
      applyTweaksAndSync({ range: urlRange }, `Date range ${humanizeTweakValue(urlRange, locale)}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.data]);

  /** RangeControl → URL (so the window travels in a deep link) → PATCH → sync. */
  const applyRange = (values: Record<string, string>, label: string) => {
    updateParams((p) => writeRangeParams(p, values));
    applyTweaksAndSync(values, label);
  };

  const applyRefetchDim = (dim: FunnelDimension, value: string | null) => {
    const tweakKey = dim.tweak ?? dim.key;
    if (!tweaks.some((t) => t.key === tweakKey)) {
      onToast(`Dimension "${dim.label}" points at tweak "${tweakKey}", which this insight does not declare.`);
      return;
    }
    applyTweaksAndSync({ [tweakKey]: value ?? '' }, `${dim.label} filter`);
  };

  const refetchValues = useMemo(() => {
    const out: Record<string, string> = {};
    for (const dim of entry?.set.dimensions ?? []) {
      if (dim.mode !== 'refetch') continue;
      const t = tweaks.find((tw) => tw.key === (dim.tweak ?? dim.key));
      out[dim.key] = t?.value ?? '';
    }
    return out;
  }, [entry, tweaks]);

  // ── Loading / error / legacy states ──
  if (detail.isLoading) {
    return <div className="funnel-ovw"><div className="funnel-ovw-state">Loading funnel data…</div></div>;
  }
  if (detail.isError || !detail.data) {
    return (
      <div className="funnel-ovw">
        <Breadcrumb onBack={onBack} title={slug} />
        <div className="funnel-ovw-state error-state">Failed to load the insight. {(detail.error as Error)?.message}</div>
      </div>
    );
  }
  const title = detail.data.insight.title;
  if (!entry) {
    return (
      <div className="funnel-ovw">
        <Breadcrumb onBack={onBack} title={title} />
        <div className="funnel-ovw-state">
          {cache?.series?.length
            ? 'This funnel insight has a legacy series payload — the board card shows it as bars. Return a funnel-set/v1 payload from the adapter for the full table + lane.'
            : 'No funnel data yet — sync this insight to fetch it.'}
          <button className="funnel-ovw-syncbtn" onClick={() => sync.mutate(slug, { onError: (e) => onToast(`Sync failed — ${(e as Error).message}`) })} disabled={sync.isPending}>
            {sync.isPending ? 'Syncing…' : 'Sync now'}
          </button>
        </div>
      </div>
    );
  }

  const set = entry.set;

  // ── Visible columns (F13): URL param > saved prefs > payload metric columns.
  //    Derived step columns are opt-in, so a fresh view is exactly today's.
  const available = overviewColumns(set);
  const defaultKeys = defaultColumnKeys(set);
  const visibleKeys = resolveColumnKeys(available, readColumnKeys(params), prefs.columns[slug], defaultKeys);
  const visible = new Set(visibleKeys);
  const cols = available.filter((c) => visible.has(c.key));
  const colByKey = new Map(available.map((c) => [c.key, c]));

  const applyColumns = (keys: string[]) => {
    updateParams((p) => writeColumnKeys(p, keys, defaultKeys));
    setColumnKeys(slug, keys);
  };

  const activeClientFilters = clientFilters(view.filters, set.dimensions);
  const filtersActive = hasActiveFilters(activeClientFilters);

  // ── Compare view (A11) — deep-linkable via ?cmp=. ──
  if (view.compare.length >= 2) {
    return (
      <div className="funnel-ovw">
        <Breadcrumb onBack={onBack} title={title} crumb={`Compare (${view.compare.length})`} onCrumbBack={() => setView({ ...view, compare: [] })} />
        <FunnelCompareView
          set={set}
          funnelIds={view.compare}
          onClose={() => setView({ ...view, compare: [] })}
          onOpenFunnel={(id) => pushLabPath(slug, id)}
        />
      </div>
    );
  }

  // ── Rows: search → sort (stable). ──
  const q = search.trim().toLowerCase();
  const rows = sortFunnels(
    set.funnels.filter((f) => !q || f.id.toLowerCase().includes(q) || f.name.toLowerCase().includes(q)),
    view.sort,
    colByKey,
  );

  const toggleSort = (key: string) => {
    const next: FunnelViewState = { ...view, sort: nextSort(view.sort, key) };
    setView(next);
  };

  const toggleSelect = (id: string) => {
    setSelected((cur) => cur.includes(id)
      ? cur.filter((x) => x !== id)
      : cur.length >= MAX_COMPARE ? cur : [...cur, id]);
  };

  const openDetail = (id: string) => pushLabPath(slug, id);

  const copyRowLink = (id: string) => {
    const url = `${window.location.origin}${labPath(slug, id)}${window.location.search}`;
    void copyPreservingUnicode(url).then((ok) => onToast(ok ? 'Deep link copied.' : 'Copy failed.'));
    setMenuFor(null);
  };
  const copyRowMarkdown = (funnel: FunnelDef) => {
    void copyPreservingUnicode(overviewRowMarkdown(funnel, cols)).then((ok) => onToast(ok ? 'Row copied as Markdown.' : 'Copy failed.'));
    setMenuFor(null);
  };
  const copyTableMarkdown = () => {
    void copyPreservingUnicode(overviewTableMarkdown(rows, cols)).then((ok) => onToast(ok ? 'Table copied as Markdown.' : 'Copy failed.'));
  };

  const stale = detail.data.insight.refresh
    && cache?.fetchedAt
    && (Date.now() - Date.parse(cache.fetchedAt)) / 60_000 >= detail.data.insight.refresh.ttl_minutes;

  return (
    <div className="funnel-ovw">
      <Breadcrumb onBack={onBack} title={title} />

      <div className="funnel-ovw-toolbar">
        {/* Unconditional: every funnel insight has a window, whether or not its
            manifest declared knobs for one. */}
        <RangeControl
          tweaks={tweaks}
          disabled={applying || sync.isPending}
          onApply={applyRange}
        />
        {/* The label reports the window the DATA is for, which lags the control
            during a re-fetch — say so, rather than letting the two disagree in
            silence for the several seconds a live source takes. */}
        <span
          className={`funnel-ovw-window${applying ? ' funnel-ovw-window--applying' : ''}`}
          title={`Data window ${entry.range.fromISO} → ${entry.range.toISO}`}
        >
          {entry.range.fromISO} → {entry.range.toISO}
        </span>
        {applying && <span className="lab-badge lab-badge--loading">loading…</span>}
        {stale && !applying && <span className="lab-badge lab-badge--stale">stale</span>}
        <div className="funnel-ovw-toolbar-spacer" />
        <input
          className="funnel-ovw-search"
          type="search"
          placeholder="Search funnels…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search funnels by id or name"
        />
        <ColumnPicker
          available={available}
          visibleKeys={visibleKeys}
          isDefault={visibleKeys.length === defaultKeys.length && visibleKeys.every((k) => defaultKeys.includes(k))}
          onToggle={(key) => applyColumns(visible.has(key) ? visibleKeys.filter((k) => k !== key) : [...visibleKeys, key])}
          onReset={() => applyColumns(defaultKeys)}
          copy={FUNNEL_TABLE_EN}
        />
        <button className="funnel-ovw-action" onClick={copyTableMarkdown} title="Copy the visible table as Markdown">Copy MD</button>
        <button
          className="funnel-ovw-action"
          onClick={() => sync.mutate(slug, {
            onSuccess: (data) => {
              const result = data.results[0];
              onToast(result?.status === 'failed'
                ? `Refresh failed — ${result.error ?? 'unknown error'}`
                : 'Refreshed.');
            },
            onError: (e) => onToast(`Refresh failed — ${(e as Error).message}`),
          })}
          disabled={sync.isPending || applying}
        >{sync.isPending || applying ? 'Syncing…' : '↻ Refresh'}</button>
      </div>

      <div className="funnel-ovw-filterrow">
        <FunnelFilterBar
          set={set}
          filters={view.filters}
          refetchValues={refetchValues}
          onChange={(filters) => setView({ ...view, filters })}
          onApplyRefetch={applyRefetchDim}
          syncing={sync.isPending || applying}
        />
        {selected.length >= 2 && (
          <button className="funnel-ovw-compare" onClick={() => setView({ ...view, compare: selected })}>
            Compare {selected.length} funnels →
          </button>
        )}
      </div>

      {/* A failed fetch keeps the PRIOR funnel data by design (sync's keep-prior
          contract), so without this banner the page silently answers for a
          window that is no longer the one the control shows. */}
      {cache?.error && (
        <div className="funnel-ovw-notices funnel-ovw-notices--error" role="alert">
          <div>
            <strong>Last fetch failed{cache.errorAt ? ` · ${new Date(cache.errorAt).toLocaleString()}` : ''}</strong>
            {' — '}{cache.error}
          </div>
          <div className="funnel-ovw-notices-sub">
            The table below is the last window that DID load ({entry.range.fromISO} → {entry.range.toISO}).
          </div>
        </div>
      )}
      {entry.notices.length > 0 && (
        <div className="funnel-ovw-notices" role="note">
          {entry.notices.map((n, i) => <div key={i}>⚠ {n}</div>)}
        </div>
      )}
      {filtersActive && (
        <div className="funnel-ovw-notices" role="note">
          Filters apply to step data (open a funnel to see filtered steps). Table metrics come from the
          payload and show <strong>unfiltered</strong> totals — dimmed below.
        </div>
      )}
      {prev?.source && (
        <div className="funnel-ovw-deltasrc">Δ vs {prev.source.range.fromISO} → {prev.source.range.toISO}</div>
      )}

      {rows.length === 0 ? (
        <div className="funnel-ovw-state">{set.funnels.length === 0 ? 'The funnel set is empty.' : 'No funnels match the search.'}</div>
      ) : (
        <FunnelSetTable
          set={set}
          prev={prev}
          rows={rows}
          cols={cols}
          sort={view.sort}
          onSort={toggleSort}
          onOpen={openDetail}
          copy={FUNNEL_TABLE_EN}
          unfiltered={filtersActive}
          select={{ selected, max: MAX_COMPARE, onToggle: toggleSelect }}
          rowMenu={(funnel) => (
            <>
              <button
                className="funnel-ovw-kebab"
                aria-haspopup="menu"
                aria-expanded={menuFor === funnel.id}
                aria-label={`Actions for ${funnel.name}`}
                onClick={() => setMenuFor(menuFor === funnel.id ? null : funnel.id)}
              >⋯</button>
              {menuFor === funnel.id && (
                <div className="funnel-ovw-menu" role="menu">
                  <button role="menuitem" onClick={() => copyRowLink(funnel.id)}>Copy deep link</button>
                  <button role="menuitem" onClick={() => copyRowMarkdown(funnel)}>Copy row as Markdown</button>
                </div>
              )}
            </>
          )}
        />
      )}
    </div>
  );
}

export function Breadcrumb({ onBack, title, crumb, onCrumbBack }: {
  onBack: () => void;
  title: string;
  crumb?: string;
  onCrumbBack?: () => void;
}) {
  return (
    <nav className="funnel-crumbs" aria-label="Breadcrumb">
      <button className="funnel-crumb-link" onClick={onBack}>Insights</button>
      <span className="funnel-crumb-sep" aria-hidden>/</span>
      {crumb && onCrumbBack ? (
        <>
          <button className="funnel-crumb-link" onClick={onCrumbBack}>{title}</button>
          <span className="funnel-crumb-sep" aria-hidden>/</span>
          <span className="funnel-crumb-here" aria-current="page">{crumb}</span>
        </>
      ) : (
        <span className="funnel-crumb-here" aria-current="page">{title}</span>
      )}
    </nav>
  );
}
