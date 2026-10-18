import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { useLabInsight } from '../../../hooks/useLab';
import { useLabPrefs } from '../../../hooks/useLabPrefs';
import { copyPreservingUnicode } from '../../../lib/clipboard';
import type { FunnelFrameDimension, Selection } from '../../../generated/frameOps';
import {
  defaultColumnKeys,
  overviewColumns,
  overviewTableMarkdown,
  resolveColumnKeys,
  selectionLabel,
  type FunnelViewState,
} from '../funnel/funnelModel';
import { ColumnPicker, FunnelSetTable, nextSort, sortFunnels, type FunnelTableCopy } from '../funnel/FunnelSetTable';
import { BlockEmpty } from './blockCommon';
import './dataBlocks.css';
import { fill } from '../../../lib/fill';

/**
 * A funnel block's `table` layout (the explorer's Table tab): every funnel of the set as one row,
 * the comparison table the detail page drew before the explorer. Column choice (saved per insight,
 * as on that page), search, sort and Copy MD; no date range, since the window is the snapshot's
 * and the card's header names it. A row click picks that funnel for the whole card, as the
 * picker does. The rows are whole-funnel totals, so a breakdown selection says it does not apply.
 *
 * The set comes from the insight itself (`GET /api/lab/:slug`, one request shared with every other
 * reader of that key), not the card's frame: the frame carries steps, the table needs each
 * funnel's payload metrics and their previous period.
 */
export function FunnelTableView({ insight, picked, onFunnel, selection, dims }: {
  insight: string;
  /** The funnel the card shows (its pick, else the frame's first): marked as the current row. */
  picked: string | null;
  onFunnel?: (id: string | null) => void;
  selection: Selection;
  dims: readonly FunnelFrameDimension[];
}) {
  const { t } = useI18n();
  const detail = useLabInsight(insight);
  const { prefs, setColumnKeys } = useLabPrefs();
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<FunnelViewState['sort']>(null);
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = useMemo<FunnelTableCopy>(() => ({
    funnel: t('lab.blocks.funnelTable.funnel'),
    selectForCompare: '',
    rowActions: '',
    open: (name) => fill(t('lab.blocks.funnelTable.open'), { name }),
    lowSample: t('lab.blocks.funnelTable.lowSample'),
    lowSampleTitle: (n) => fill(t('lab.blocks.funnelTable.lowSampleTitle'), { n: String(n) }),
    noiseTitle: (n) => fill(t('lab.blocks.funnelTable.noiseTitle'), { n: String(n) }),
    deltaTitle: (now, prev) => fill(t('lab.blocks.funnelTable.deltaTitle'), { now, prev }),
    columns: t('lab.blocks.funnelTable.columns'),
    columnsTitle: t('lab.blocks.funnelTable.columnsTitle'),
    reset: t('lab.blocks.funnelTable.reset'),
    groups: {
      metric: t('lab.blocks.funnelTable.group.metric'),
      conversion: t('lab.blocks.funnelTable.group.conversion'),
      of_top: t('lab.blocks.funnelTable.group.ofTop'),
    },
  }), [t]);

  if (detail.isLoading) return <div className="lab-block-empty" data-lab-funnel-table="loading">{t('lab.blocks.funnelTable.loading')}</div>;
  const entry = detail.data?.cache?.funnel;
  if (!entry) return <BlockEmpty reason="no-cache" />;
  const set = entry.set;
  const prev = detail.data?.funnelPrev ?? null;

  const available = overviewColumns(set);
  const defaultKeys = defaultColumnKeys(set);
  const visibleKeys = resolveColumnKeys(available, null, prefs.columns[insight], defaultKeys);
  const visible = new Set(visibleKeys);
  const cols = available.filter((c) => visible.has(c.key));
  const colByKey = new Map(available.map((c) => [c.key, c]));

  const q = search.trim().toLowerCase();
  const rows = sortFunnels(
    set.funnels.filter((f) => !q || f.id.toLowerCase().includes(q) || f.name.toLowerCase().includes(q)),
    sort,
    colByKey,
  );
  const sel = selectionLabel(selection, dims);

  const copyTable = () => {
    void copyPreservingUnicode(overviewTableMarkdown(rows, cols)).then((ok) => setCopied(ok ? 'ok' : 'failed'));
  };

  return (
    <div className="lab-block-funnel-table" data-lab-funnel-table="">
      <div className="funnel-ovw-toolbar">
        <input
          className="funnel-ovw-search"
          type="search"
          placeholder={t('lab.blocks.funnelTable.search')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label={t('lab.blocks.funnelTable.searchLabel')}
        />
        <div className="funnel-ovw-toolbar-spacer" />
        <ColumnPicker
          available={available}
          visibleKeys={visibleKeys}
          isDefault={visibleKeys.length === defaultKeys.length && visibleKeys.every((k) => defaultKeys.includes(k))}
          onToggle={(key) => setColumnKeys(insight, visible.has(key) ? visibleKeys.filter((k) => k !== key) : [...visibleKeys, key])}
          onReset={() => setColumnKeys(insight, defaultKeys)}
          copy={copy}
        />
        <button
          className="funnel-ovw-action"
          onClick={copyTable}
          title={t('lab.blocks.funnelTable.copyMdTitle')}
          data-lab-copy-md=""
        >
          {copied === 'ok' ? t('lab.blocks.funnelTable.copied') : copied === 'failed' ? t('lab.blocks.funnelTable.copyFailed') : t('lab.blocks.funnelTable.copyMd')}
        </button>
      </div>
      {sel && (
        <p className="board-block-note" data-lab-funnel-table-selection="" role="note">
          {fill(t('lab.blocks.funnelTable.selection'), { sel })}
        </p>
      )}
      {prev?.source && (
        <div className="funnel-ovw-deltasrc">
          {fill(t('lab.blocks.funnelTable.deltaSource'), { from: prev.source.range.fromISO, to: prev.source.range.toISO })}
        </div>
      )}
      {rows.length === 0 ? (
        <div className="funnel-ovw-state">{set.funnels.length === 0 ? t('lab.blocks.funnelTable.empty') : t('lab.blocks.funnelTable.noMatch')}</div>
      ) : (
        <FunnelSetTable
          set={set}
          prev={prev}
          rows={rows}
          cols={cols}
          sort={sort}
          onSort={(key) => setSort((cur) => nextSort(cur, key))}
          onOpen={(id) => onFunnel?.(id)}
          copy={copy}
          picked={picked}
        />
      )}
    </div>
  );
}
