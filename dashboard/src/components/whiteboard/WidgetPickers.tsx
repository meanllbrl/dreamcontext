import { useMemo, useState } from 'react';
import { useLabInsights } from '../../hooks/useLab';
import { useKnowledgeList } from '../../hooks/useKnowledge';
import { useTasks } from '../../hooks/useTasks';
import type { WidgetPayload } from '../../lib/whiteboardWidgets';
import { WEB_URL_REASON_TEXT, validateWebUrl } from './webUrl';
import { isValidWidgetRef } from './widgetModel';
import { useWbText } from './whiteboardHost';

/** One pickable row: a slug and what to show for it. */
interface PickRow { slug: string; title: string; meta?: string }

const MAX_ROWS = 60;

/**
 * The shared list for the Insight, Knowledge and Task pickers: a filter box over rows the
 * existing list hooks already cache. Rows whose slug the server would refuse as a widget ref
 * are left out, so a pick can never produce a widget the save then rejects.
 */
function PickList({ rows, loading, failed, onPick, emptyText }: {
  rows: PickRow[] | undefined;
  loading: boolean;
  failed: boolean;
  onPick: (row: PickRow) => void;
  emptyText: string;
}) {
  const tx = useWbText();
  const [q, setQ] = useState('');
  const shown = useMemo(() => {
    const needle = q.trim().toLocaleLowerCase();
    const valid = (rows ?? []).filter((r) => isValidWidgetRef(r.slug));
    const hits = needle
      ? valid.filter((r) => r.title.toLocaleLowerCase().includes(needle) || r.slug.includes(needle))
      : valid;
    return hits.slice(0, MAX_ROWS);
  }, [rows, q]);

  return (
    <div className="wb-picker">
      <input
        className="wb-picker-search"
        autoFocus
        value={q}
        placeholder={tx('whiteboard.palette.search', 'Search…')}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && shown[0]) { e.preventDefault(); onPick(shown[0]); } }}
      />
      <div className="wb-picker-list" role="listbox">
        {loading && <p className="wb-picker-empty">{tx('whiteboard.widget.loading', 'Loading…')}</p>}
        {failed && <p className="wb-picker-empty">{tx('whiteboard.widget.loadFailed', 'Could not load this.')}</p>}
        {!loading && !failed && shown.length === 0 && <p className="wb-picker-empty">{emptyText}</p>}
        {shown.map((row) => (
          <button key={row.slug} type="button" role="option" aria-selected={false} className="wb-picker-row" onClick={() => onPick(row)}>
            <span className="wb-picker-row-title">{row.title}</span>
            {row.meta && <span className="wb-picker-row-meta">{row.meta}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

type Pick = (payload: WidgetPayload) => void;

export function InsightPicker({ onPick }: { onPick: Pick }) {
  const tx = useWbText();
  const { data, isLoading, isError } = useLabInsights();
  const rows = useMemo(() => data?.map((i) => ({ slug: i.slug, title: i.title, meta: i.category ?? i.slug })), [data]);
  return (
    <PickList
      rows={rows}
      loading={isLoading}
      failed={isError}
      emptyText={tx('whiteboard.palette.noInsights', 'No insights.')}
      onPick={(r) => onPick({ v: 1, kind: 'insight', ref: r.slug, title: r.title })}
    />
  );
}

export function KnowledgePicker({ onPick }: { onPick: Pick }) {
  const tx = useWbText();
  const { data, isLoading, isError } = useKnowledgeList();
  const rows = useMemo(() => data?.map((k) => ({ slug: k.slug, title: k.name || k.slug, meta: k.slug })), [data]);
  return (
    <PickList
      rows={rows}
      loading={isLoading}
      failed={isError}
      emptyText={tx('whiteboard.palette.noKnowledge', 'No knowledge files.')}
      onPick={(r) => onPick({ v: 1, kind: 'knowledge', ref: r.slug, title: r.title })}
    />
  );
}

export function TaskPicker({ onPick }: { onPick: Pick }) {
  const tx = useWbText();
  const { data, isLoading, isError } = useTasks();
  const rows = useMemo(() => data?.map((t) => ({ slug: t.slug, title: t.name, meta: t.status })), [data]);
  return (
    <PickList
      rows={rows}
      loading={isLoading}
      failed={isError}
      emptyText={tx('whiteboard.palette.noTasks', 'No tasks.')}
      onPick={(r) => onPick({ v: 1, kind: 'task', ref: r.slug, title: r.title })}
    />
  );
}

export function WebPicker({ onPick }: { onPick: Pick }) {
  const tx = useWbText();
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    const check = validateWebUrl(url, window.location.origin);
    if (!check.ok) {
      setError(tx(`whiteboard.web.reason.${check.reason}`, WEB_URL_REASON_TEXT[check.reason]));
      return;
    }
    onPick({ v: 1, kind: 'web', url: check.href, title: check.unicodeHost });
  };
  return (
    <div className="wb-picker">
      <input
        className="wb-picker-search"
        autoFocus
        value={url}
        placeholder="https://"
        onChange={(e) => { setUrl(e.target.value); setError(null); }}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
      />
      {error && <p className="wb-picker-error" role="alert">{error}</p>}
      <div className="wb-picker-actions">
        <button type="button" className="wb-palette-btn" onClick={submit}>{tx('whiteboard.palette.addWeb', 'Add embed')}</button>
      </div>
    </div>
  );
}
