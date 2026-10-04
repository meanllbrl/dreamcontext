import { useMemo, useState } from 'react';
import { useLabInsights } from '../../hooks/useLab';
import { useBoards } from '../../hooks/useBoards';
import { useKnowledgeList } from '../../hooks/useKnowledge';
import { useTasks } from '../../hooks/useTasks';
import { useWhiteboardPages, type WhiteboardPageHit } from '../../hooks/useWhiteboardPages';
import { isLabCardRef, type WidgetPayload } from '../../lib/whiteboardWidgets';
import { WEB_URL_REASON_TEXT, validateWebUrl } from './webUrl';
import {
  humanizeFileName, isValidRefFor, isValidWidgetRef, knowledgeTitle, pageKindLabel, pageTypeLabel, taskTitle,
} from './widgetModel';
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

/**
 * Every card of every readable Lab board, as `<board>/<card-id>` rows: picking one puts that card
 * on the board as a `lab-card` widget, drawn exactly as Lab draws it.
 */
export function LabCardPicker({ onPick }: { onPick: Pick }) {
  const tx = useWbText();
  const { data, isLoading, isError } = useBoards();
  const insights = useLabInsights();
  const titles = useMemo(() => new Map((insights.data ?? []).map((i) => [i.slug, i.title])), [insights.data]);
  const rows = useMemo(() => (data?.boards ?? [])
    .filter((b) => !b.error)
    .flatMap((b) => b.cards.map((c) => ({
      slug: `${b.slug}/${c.id}`,
      title: c.title ?? (c.insight ? titles.get(c.insight) ?? c.insight : c.id),
      meta: b.title,
    })))
    .filter((r) => isLabCardRef(r.slug)), [data, titles]);
  return (
    <PickList
      rows={rows}
      loading={isLoading}
      failed={isError}
      emptyText={tx('whiteboard.palette.noLabCards', 'No Lab board cards.')}
      onPick={(r) => onPick({ v: 1, kind: 'lab-card', ref: r.slug, title: r.title })}
    />
  );
}

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

/** What the page picker hands back: the ref a page widget or a wiki row stores, and its title. */
export interface PickedPage { ref: string; title: string }

/**
 * The page picker: knowledge pages AND project .md / .pdf / .html files, searched on the server
 * (`/whiteboards/pages`), each row showing its type in the cards' vocabulary (Knowledge / MD /
 * PDF / HTML). A knowledge page comes back with its real title (A19); a file with its name. The
 * ref is whatever the server says the page is (slug or path), re-checked against the page-ref
 * rule so a pick never makes a widget or a wiki row the save refuses. The palette's "Knowledge
 * or file…" and the wiki card's "Add page" both use it.
 */
export function PagePicker({ onPick, isDisabled }: {
  onPick: (page: PickedPage) => void;
  /** A ref that may not be picked here (the wiki section already lists it): drawn, but inert. */
  isDisabled?: (ref: string) => boolean;
}) {
  const tx = useWbText();
  const [q, setQ] = useState('');
  const { data, isLoading, isError } = useWhiteboardPages(q, { limit: MAX_ROWS });
  const knowledge = useKnowledgeList();
  const titles = useMemo(
    () => new Map((knowledge.data ?? []).map((k) => [k.slug, knowledgeTitle(k)])),
    [knowledge.data],
  );
  const rows = useMemo(
    () => (data?.pages ?? []).filter((p) => isValidRefFor('knowledge', p.ref)),
    [data],
  );
  // A file reads as its name humanised, the way its card will: never the raw file name.
  const titleOf = (p: WhiteboardPageHit) => (p.source === 'knowledge' ? titles.get(p.ref) ?? p.title : humanizeFileName(p.path || p.ref));
  const pick = (p: WhiteboardPageHit) => onPick({ ref: p.ref, title: titleOf(p) });
  const firstPickable = rows.find((p) => !isDisabled?.(p.ref));

  return (
    <div className="wb-picker">
      <input
        className="wb-picker-search"
        autoFocus
        value={q}
        placeholder={tx('whiteboard.palette.searchPages', 'Search pages and files…')}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && firstPickable) { e.preventDefault(); pick(firstPickable); } }}
      />
      <div className="wb-picker-list" role="listbox">
        {isLoading && <p className="wb-picker-empty">{tx('whiteboard.widget.loading', 'Loading…')}</p>}
        {isError && <p className="wb-picker-empty">{tx('whiteboard.widget.loadFailed', 'Could not load this.')}</p>}
        {!isLoading && !isError && rows.length === 0 && (
          <p className="wb-picker-empty">{tx('whiteboard.palette.noPages', 'No pages found.')}</p>
        )}
        {rows.map((p) => {
          const type = pageTypeLabel(p.ref) ?? pageKindLabel(p.kind);
          const taken = isDisabled?.(p.ref) ?? false;
          return (
            <button
              key={`${p.source}:${p.ref}`}
              type="button"
              role="option"
              aria-selected={false}
              aria-disabled={taken || undefined}
              disabled={taken}
              className="wb-picker-row"
              data-page-ref={p.ref}
              onClick={() => pick(p)}
            >
              <span className="wb-picker-row-title">
                <span className="wb-picker-type" data-page-type={type}>
                  {type === 'Knowledge' ? tx('whiteboard.kind.knowledge', 'Knowledge') : type}
                </span>
                {titleOf(p)}
              </span>
              <span className="wb-picker-row-meta">
                {taken ? tx('whiteboard.wiki.alreadyListed', 'Already in this section') : p.source === 'knowledge' ? p.ref : p.path}
              </span>
            </button>
          );
        })}
        {data?.truncated && rows.length > 0 && (
          <p className="wb-picker-empty">{tx('whiteboard.palette.morePages', 'More match: keep typing to narrow.')}</p>
        )}
      </div>
    </div>
  );
}

/** The palette's page picker: a picked page becomes a page card. */
export function KnowledgePicker({ onPick }: { onPick: Pick }) {
  return <PagePicker onPick={(p) => onPick({ v: 1, kind: 'knowledge', ref: p.ref, title: p.title })} />;
}

export function TaskPicker({ onPick }: { onPick: Pick }) {
  const tx = useWbText();
  const { data, isLoading, isError } = useTasks();
  const rows = useMemo(() => data?.map((t) => ({ slug: t.slug, title: taskTitle(t), meta: t.status })), [data]);
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
