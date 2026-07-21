import { useEffect, useMemo, useRef, useState } from 'react';
import { useLabInsight, useSyncInsight, useUpdateTweaks } from '../../../hooks/useLab';
import { copyPreservingUnicode } from '../../../lib/clipboard';
import {
  benchmarkClass,
  clientFilters,
  formatDelta,
  formatMetricValue,
  hasActiveFilters,
  isLowSample,
  metricColumns,
  overviewRowMarkdown,
  overviewTableMarkdown,
  readViewState,
  writeViewState,
  type FunnelDef,
  type FunnelDimension,
  type FunnelViewState,
} from './funnelModel';
import { labPath, pushLabPath, useLabSearchParams } from './labRoute';
import { FunnelFilterBar } from './FunnelFilterBar';
import { FunnelCompareView } from './FunnelCompareView';
import './FunnelOverviewPage.css';

/**
 * Funnel insight page 1 — the all-funnels comparison table (A3/A4/A5): metric
 * columns from the payload, stable keyboard-accessible sort, id/name search,
 * date-range presets via the range tweak, Δ-vs-previous-period chips, low-sample
 * de-emphasis, row→detail, multi-select→compare, per-row kebab (deep link / MD).
 */

const MAX_COMPARE = 4;

export function FunnelOverviewPage({ slug, onBack, onToast }: {
  slug: string;
  onBack: () => void;
  onToast: (msg: string) => void;
}) {
  const detail = useLabInsight(slug);
  const sync = useSyncInsight();
  const updateTweaks = useUpdateTweaks();
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
  const hasCustomRange = tweaks.some((t) => t.key === 'from' && t.type === 'date')
    && tweaks.some((t) => t.key === 'to' && t.type === 'date');

  const setView = (next: FunnelViewState) => updateParams((p) => writeViewState(p, next));

  const applyTweaksAndSync = (values: Record<string, string>, label: string) => {
    updateTweaks.mutate({ slug, tweaks: values }, {
      onSuccess: () => {
        sync.mutate(slug, {
          onSuccess: () => onToast(`${label} applied.`),
          onError: (err) => onToast(`Re-fetch failed — ${(err as Error).message}`),
        });
      },
      onError: (err) => onToast(`${label} failed — ${(err as Error).message}`),
    });
  };

  // Deep-linked range (A13): a `range` URL param that differs from the stored
  // tweak is what the link author was looking at — apply it once.
  useEffect(() => {
    if (appliedUrlRange.current || !detail.data || !rangeTweak) return;
    appliedUrlRange.current = true;
    const urlRange = params.get('range');
    if (urlRange && urlRange !== currentRange && (rangeTweak.options ?? []).includes(urlRange)) {
      applyTweaksAndSync({ range: urlRange }, `Date range ${urlRange}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.data]);

  const applyRange = (value: string) => {
    updateParams((p) => { p.set('range', value); });
    applyTweaksAndSync({ range: value }, `Date range ${value}`);
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
  const cols = metricColumns(set);
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
  let rows = set.funnels.filter((f) => !q || f.id.toLowerCase().includes(q) || f.name.toLowerCase().includes(q));
  if (view.sort) {
    const { key, dir } = view.sort;
    const value = (f: FunnelDef): number | string | null => key === 'name' ? f.name : (f.metrics[key]?.v ?? null);
    rows = rows
      .map((f, i) => ({ f, i }))
      .sort((a, b) => {
        const va = value(a.f);
        const vb = value(b.f);
        let cmp = 0;
        if (va === null && vb === null) cmp = 0;
        else if (va === null) cmp = 1; // nulls last regardless of direction
        else if (vb === null) cmp = -1;
        else if (typeof va === 'string' || typeof vb === 'string') cmp = String(va).localeCompare(String(vb)) * (dir === 'desc' ? -1 : 1);
        else cmp = (va - vb) * (dir === 'desc' ? -1 : 1);
        return cmp !== 0 ? cmp : a.i - b.i; // stable
      })
      .map((e) => e.f);
  }

  const toggleSort = (key: string) => {
    const next: FunnelViewState = { ...view };
    if (view.sort?.key !== key) next.sort = { key, dir: 'desc' };
    else if (view.sort.dir === 'desc') next.sort = { key, dir: 'asc' };
    else next.sort = null;
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
        {rangeTweak && (
          <div className="funnel-ovw-ranges" role="group" aria-label="Date range">
            {(rangeTweak.options ?? []).map((opt) => (
              <button
                key={opt}
                className={`funnel-ovw-range${opt === currentRange ? ' funnel-ovw-range--on' : ''}`}
                onClick={() => applyRange(opt)}
                disabled={updateTweaks.isPending || sync.isPending}
                aria-pressed={opt === currentRange}
              >{opt.replace(/^last_/, '').replace(/_/g, ' ')}</button>
            ))}
            {hasCustomRange && (
              <CustomRange
                from={tweaks.find((t) => t.key === 'from')?.value ?? ''}
                to={tweaks.find((t) => t.key === 'to')?.value ?? ''}
                disabled={updateTweaks.isPending || sync.isPending}
                onApply={(from, to) => {
                  updateParams((p) => { p.set('from', from); p.set('to', to); p.delete('range'); });
                  applyTweaksAndSync({ from, to }, 'Custom range');
                }}
              />
            )}
          </div>
        )}
        <span className="funnel-ovw-window" title={`Data window ${entry.range.fromISO} → ${entry.range.toISO}`}>
          {entry.range.fromISO} → {entry.range.toISO}
        </span>
        {stale && <span className="lab-badge lab-badge--stale">stale</span>}
        <div className="funnel-ovw-toolbar-spacer" />
        <input
          className="funnel-ovw-search"
          type="search"
          placeholder="Search funnels…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search funnels by id or name"
        />
        <button className="funnel-ovw-action" onClick={copyTableMarkdown} title="Copy the visible table as Markdown">Copy MD</button>
        <button
          className="funnel-ovw-action"
          onClick={() => sync.mutate(slug, {
            onSuccess: () => onToast('Refreshed.'),
            onError: (e) => onToast(`Refresh failed — ${(e as Error).message}`),
          })}
          disabled={sync.isPending}
        >{sync.isPending ? 'Syncing…' : '↻ Refresh'}</button>
      </div>

      <div className="funnel-ovw-filterrow">
        <FunnelFilterBar
          set={set}
          filters={view.filters}
          refetchValues={refetchValues}
          onChange={(filters) => setView({ ...view, filters })}
          onApplyRefetch={applyRefetchDim}
          syncing={sync.isPending || updateTweaks.isPending}
        />
        {selected.length >= 2 && (
          <button className="funnel-ovw-compare" onClick={() => setView({ ...view, compare: selected })}>
            Compare {selected.length} funnels →
          </button>
        )}
      </div>

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
        <div className="funnel-ovw-tablewrap">
          <table className="funnel-ovw-table">
            <thead>
              <tr>
                <th className="funnel-ovw-th-check" scope="col"><span className="sr-only">Select for compare</span></th>
                <SortableTh label="Funnel" sortKey="name" sort={view.sort} onSort={toggleSort} />
                {cols.map((c) => <SortableTh key={c.key} label={c.label} sortKey={c.key} sort={view.sort} onSort={toggleSort} numeric />)}
                <th className="funnel-ovw-th-kebab" scope="col"><span className="sr-only">Row actions</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((funnel) => {
                const low = isLowSample(funnel, set);
                const prevMetrics = prev?.metrics[funnel.id] ?? {};
                return (
                  <tr
                    key={funnel.id}
                    className={`funnel-ovw-row${low ? ' funnel-ovw-row--low' : ''}`}
                    tabIndex={0}
                    onClick={() => openDetail(funnel.id)}
                    onKeyDown={(e) => { if (e.key === 'Enter') openDetail(funnel.id); }}
                    aria-label={`Open funnel ${funnel.name}`}
                  >
                    <td className="funnel-ovw-td-check" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selected.includes(funnel.id)}
                        disabled={!selected.includes(funnel.id) && selected.length >= MAX_COMPARE}
                        onChange={() => toggleSelect(funnel.id)}
                        onKeyDown={(e) => e.stopPropagation()}
                        aria-label={`Select ${funnel.name} for compare`}
                      />
                    </td>
                    <td className="funnel-ovw-td-name">
                      <span className="funnel-ovw-name">{funnel.name}</span>
                      <span className="funnel-ovw-id">#{funnel.id}</span>
                      {low && (
                        <span className="funnel-ovw-lowchip" title={`Below the low-sample threshold — rates on n=${funnel.steps[0]?.users ?? 0} are noise, not signal.`}>
                          low sample
                        </span>
                      )}
                    </td>
                    {cols.map((c) => {
                      const metric = funnel.metrics[c.key];
                      const v = metric?.v ?? null;
                      const p = prevMetrics[c.key] ?? null;
                      const bench = benchmarkClass(v, set.benchmarks?.[c.key]);
                      const deEmph = low && c.format === 'pct';
                      return (
                        <td
                          key={c.key}
                          className={[
                            'funnel-ovw-td-num',
                            filtersActive ? 'funnel-ovw-cell--unfiltered' : '',
                            deEmph ? 'funnel-ovw-cell--low' : '',
                            bench === 'below-floor' ? 'funnel-ovw-cell--floor' : '',
                            bench === 'at-target' ? 'funnel-ovw-cell--target' : '',
                          ].filter(Boolean).join(' ')}
                          title={deEmph ? `n=${funnel.steps[0]?.users ?? 0} — below the sample threshold; treat this rate as noise` : undefined}
                        >
                          {formatMetricValue(v, c.format)}
                          {v !== null && p !== null && (
                            <DeltaChip current={v} prev={p} format={c.format} />
                          )}
                        </td>
                      );
                    })}
                    <td className="funnel-ovw-td-kebab" onClick={(e) => e.stopPropagation()}>
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
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Breadcrumb({ onBack, title, crumb, onCrumbBack }: {
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

function SortableTh({ label, sortKey, sort, onSort, numeric = false }: {
  label: string;
  sortKey: string;
  sort: FunnelViewState['sort'];
  onSort: (key: string) => void;
  numeric?: boolean;
}) {
  const active = sort?.key === sortKey;
  const dir = active ? sort!.dir : null;
  return (
    <th
      scope="col"
      className={numeric ? 'funnel-ovw-th-num' : undefined}
      aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button className={`funnel-ovw-sort${active ? ' funnel-ovw-sort--on' : ''}`} onClick={() => onSort(sortKey)}>
        {label}
        <span className="funnel-ovw-sort-arrow" aria-hidden>{dir === 'asc' ? '↑' : dir === 'desc' ? '↓' : ''}</span>
      </button>
    </th>
  );
}

function DeltaChip({ current, prev, format }: { current: number; prev: number; format: Parameters<typeof formatDelta>[2] }) {
  const delta = formatDelta(current, prev, format);
  return (
    <span
      className={`funnel-delta funnel-delta--${delta.direction}`}
      title={`${formatMetricValue(current, format)} now vs ${formatMetricValue(prev, format)} previous period`}
    >{delta.text}</span>
  );
}

function CustomRange({ from, to, disabled, onApply }: {
  from: string;
  to: string;
  disabled: boolean;
  onApply: (from: string, to: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState(from);
  const [t, setT] = useState(to);
  return (
    <span className="funnel-ovw-custom">
      <button className="funnel-ovw-range" onClick={() => setOpen((v) => !v)} aria-expanded={open}>custom</button>
      {open && (
        <span className="funnel-ovw-custom-pop">
          <input type="date" value={f} onChange={(e) => setF(e.target.value)} aria-label="From date" />
          <input type="date" value={t} onChange={(e) => setT(e.target.value)} aria-label="To date" />
          <button disabled={disabled || !f || !t} onClick={() => { onApply(f, t); setOpen(false); }}>Apply</button>
        </span>
      )}
    </span>
  );
}
