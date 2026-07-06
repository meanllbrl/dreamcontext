import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useRecall, haikuRecallOnce, recallOnce, type RecallHit } from '../../hooks/useRecall';
import { TypeIcon, SearchIcon, SparkIcon } from '../sleepy/TypeIcons';
import { tagHue } from '../../lib/tagColor';
import './BrainSearch.css';

/**
 * BrainSearch — an atomic, scope-locked recall widget.
 *
 * Unlike the old per-page text filter (a dumb substring match over the already
 * loaded list), this runs the real recall engine the CLI uses:
 *   - empty query   → the page's own browse surface (folder tree / list)
 *   - typing        → live, debounced BM25 recall scoped to one corpus type
 *   - Intelligent   → a submit-driven Haiku pass (intent-aware, spends tokens),
 *                     falling back to BM25 if the claude CLI is unavailable
 *
 * The widget owns the search bar + the result/browse column; the host page
 * supplies the `browse` tree (shown when idle) and the `detail` pane (right
 * column), and reacts to `onOpen`. Drop it on any page by changing `scope`.
 */

export type SearchScope = 'knowledge';

/**
 * Recall corpus types behind each scope. Feature PRDs are typed knowledge on the
 * page (knowledge/features/**) but their OWN corpus type in the recall engine,
 * so the knowledge scope queries both.
 */
const SCOPE_TYPES: Record<SearchScope, RecallHit['type'][]> = {
  knowledge: ['knowledge', 'feature'],
};

export interface BrainSearchHit {
  slug: string;
  title: string;
  type: RecallHit['type'];
}

interface BrainSearchProps {
  scope: SearchScope;
  placeholder: string;
  selectedSlug: string | null;
  onOpen: (hit: BrainSearchHit) => void;
  /** Left-column content shown when the query is empty (the page's browse tree). */
  browse: React.ReactNode;
  /** Right-column content — the detail pane (always rendered). */
  detail: React.ReactNode;
  /** Optional formatter for a hit's display title (e.g. strip a folder prefix). */
  formatTitle?: (hit: RecallHit) => string;
}

type IntelliState = 'idle' | 'thinking' | 'done';

/**
 * The slug a detail page expects is NOT always `hit.slug`. The recall corpus
 * stores the basename only (`decision-foo`), while the Knowledge page keys on
 * the folder-qualified slug (`decisions/decision-foo` — or `features/<slug>`
 * for feature PRDs, which live at knowledge/features/). Derive that from
 * `hit.path` exactly like the Sleepy `DocContent` does, so a subfoldered hit
 * opens instead of 404-ing to a blank pane.
 */
function openSlugFor(hit: RecallHit): string {
  return hit.path.replace(/^.*?knowledge\//, '').replace(/\.md$/, '');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Light up the matched query terms inside a title/snippet. */
function Highlight({ text, tokens }: { text: string; tokens: string[] }) {
  if (!tokens.length || !text) return <>{text}</>;
  const re = new RegExp(`(${tokens.map(escapeRegExp).join('|')})`, 'gi');
  const lower = new Set(tokens.map(t => t.toLowerCase()));
  const parts = text.split(re);
  return (
    <>
      {parts.map((p, i) =>
        lower.has(p.toLowerCase())
          ? <mark className="bsearch-hl" key={i}>{p}</mark>
          : <span key={i}>{p}</span>,
      )}
    </>
  );
}

export function BrainSearch({
  scope, placeholder, selectedSlug, onOpen, browse, detail, formatTitle,
}: BrainSearchProps) {
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [intelligent, setIntelligent] = useState(false);
  const [intelliHits, setIntelliHits] = useState<RecallHit[]>([]);
  const [intelliState, setIntelliState] = useState<IntelliState>('idle');
  const [intelliQuery, setIntelliQuery] = useState('');
  const [intelliMode, setIntelliMode] = useState<'haiku' | 'bm25'>('haiku');
  const [focused, setFocused] = useState(0);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const types = useMemo(() => SCOPE_TYPES[scope], [scope]);

  const trimmedQ = q.trim();
  const hasQuery = trimmedQ.length > 0;
  const bm25Mode = !intelligent;

  // Debounce only the server-bound query — typing stays instant.
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQ(trimmedQ), 110);
    return () => clearTimeout(id);
  }, [trimmedQ]);

  // Live BM25 — disabled while Intelligent is on (that path is submit-driven).
  const { data, isFetching } = useRecall(bm25Mode ? debouncedQ : '', types, 14);
  const bmHits = useMemo(() => data?.hits ?? [], [data]);

  const intelliReady = intelligent && intelliState === 'done' && intelliQuery === trimmedQ;
  const rows: RecallHit[] = intelligent ? (intelliReady ? intelliHits : []) : bmHits;

  const maxScore = useMemo(
    () => (rows.length ? Math.max(...rows.map(h => h.rankScore || h.score || 1)) : 1),
    [rows],
  );
  const queryTokens = useMemo(
    () => (intelligent ? intelliQuery : trimmedQ).toLowerCase().split(/\s+/).filter(Boolean),
    [intelligent, intelliQuery, trimmedQ],
  );

  const showBrowse = !hasQuery;
  const showIntelliCTA = intelligent && hasQuery && intelliState !== 'thinking' && !intelliReady;
  const showThinking = intelligent && intelliState === 'thinking';
  const showResults = hasQuery && (intelligent ? intelliReady : true) && rows.length > 0;
  const showEmpty =
    hasQuery &&
    ((bm25Mode && !isFetching && bmHits.length === 0 && debouncedQ === trimmedQ) ||
      (intelligent && intelliReady && intelliHits.length === 0));

  const focusInput = useCallback(() => { try { inputRef.current?.focus(); } catch { /* noop */ } }, []);
  useEffect(() => { setFocused(f => Math.min(f, Math.max(0, rows.length - 1))); }, [rows.length]);

  const runIntelli = useCallback(async () => {
    const query = trimmedQ;
    if (!query) return;
    setIntelliState('thinking');
    setIntelliQuery(query);
    setFocused(0);
    try {
      const res = await haikuRecallOnce(query, types);
      setIntelliHits(res.hits);
      setIntelliMode(res.mode);
    } catch {
      // Haiku unreachable — degrade to local BM25 so search still answers.
      try { setIntelliHits(await recallOnce(query, types, 14)); } catch { setIntelliHits([]); }
      setIntelliMode('bm25');
    }
    setIntelliState('done');
  }, [trimmedQ, types]);

  const toggleIntelligent = () => {
    setIntelligent(v => {
      setIntelliState('idle'); setIntelliHits([]); setIntelliQuery(''); setFocused(0);
      return !v;
    });
    focusInput();
  };

  const clear = () => { setQ(''); setDebouncedQ(''); setIntelliState('idle'); setIntelliHits([]); setIntelliQuery(''); setFocused(0); focusInput(); };

  const open = (hit: RecallHit) => onOpen({ slug: openSlugFor(hit), title: hit.title, type: hit.type });

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') { clear(); return; }
    if (e.key === 'Enter') {
      if (intelligent && !intelliReady) { e.preventDefault(); void runIntelli(); return; }
      if (rows[focused]) { e.preventDefault(); open(rows[focused]); }
      return;
    }
    if (!rows.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setFocused(f => Math.min(f + 1, rows.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setFocused(f => Math.max(f - 1, 0)); }
  };

  const titleOf = (hit: RecallHit) => (formatTitle ? formatTitle(hit) : hit.title);

  return (
    <div className="bsearch">
      {/* ── Search bar ─────────────────────────────────────────────── */}
      <div className={`bsearch-bar ${hasQuery ? 'bsearch-bar--active' : ''}`}>
        <span className="bsearch-bar-icon"><SearchIcon size={16} /></span>
        <input
          ref={inputRef}
          className="bsearch-input"
          placeholder={placeholder}
          value={q}
          onChange={e => { setQ(e.target.value); if (intelligent) setIntelliState('idle'); }}
          onKeyDown={onKeyDown}
          spellCheck={false}
          autoComplete="off"
        />
        {(bm25Mode && isFetching && hasQuery) && <span className="bsearch-spin" aria-hidden="true" />}
        {hasQuery && (
          <button className="bsearch-clear" onClick={clear} title="Clear" aria-label="Clear search">×</button>
        )}
        <button
          className={`bsearch-intel ${intelligent ? 'bsearch-intel--on' : ''}`}
          onClick={toggleIntelligent}
          title={intelligent
            ? 'Intelligent search is on — reasons over your brain (uses tokens)'
            : 'Turn on intelligent search — intent-aware, beyond keywords'}
        >
          <span className="bsearch-intel-dot" />
          <SparkIcon size={13} color={intelligent ? '#fff' : 'currentColor'} />
          Intelligent
        </button>
      </div>

      {/* ── Two-column body: results/browse · detail ───────────────── */}
      <div className="bsearch-layout">
        <div className="bsearch-list">
          {showBrowse && browse}

          {showIntelliCTA && (
            <button className="bsearch-cta" onClick={() => void runIntelli()}>
              <SparkIcon size={15} color="#fff" />
              Run intelligent search
              <kbd className="bsearch-kbd">↵</kbd>
            </button>
          )}

          {showThinking && (
            <div className="bsearch-thinking">
              <span className="bsearch-thinking-spark"><SparkIcon size={14} color="currentColor" /></span>
              Reasoning over your {scope}…
              <div className="bsearch-skel"><i /><i /><i /></div>
            </div>
          )}

          {showResults && (
            <>
              <div className="bsearch-meta">
                <span className="bsearch-count">{rows.length} {rows.length === 1 ? 'match' : 'matches'}</span>
                <span className={`bsearch-mode ${intelligent ? 'bsearch-mode--intel' : ''}`}>
                  {intelligent ? (intelliMode === 'haiku' ? 'intelligent' : 'bm25 fallback') : 'keyword'}
                </span>
              </div>
              {rows.map((hit, i) => {
                const pct = Math.round(((hit.rankScore || hit.score || 0) / maxScore) * 100);
                const snippet = (intelligent ? hit.snippet : hit.snippet || hit.description) ?? '';
                const openSlug = openSlugFor(hit);
                return (
                  <button
                    key={hit.slug}
                    className={`bsearch-row ${selectedSlug === openSlug ? 'bsearch-row--active' : ''} ${focused === i ? 'bsearch-row--focused' : ''}`}
                    onClick={() => open(hit)}
                    onMouseEnter={() => setFocused(i)}
                  >
                    <span className="bsearch-row-icon"><TypeIcon type={hit.type} size={15} /></span>
                    <span className="bsearch-row-main">
                      <span className="bsearch-row-title"><Highlight text={titleOf(hit)} tokens={queryTokens} /></span>
                      {snippet && (
                        <span className="bsearch-row-snippet"><Highlight text={snippet} tokens={queryTokens} /></span>
                      )}
                      {hit.tags.length > 0 && (
                        <span className="bsearch-row-tags">
                          {hit.tags.slice(0, 4).map(tag => (
                            <span key={tag} className="task-tag" data-hue={tagHue(tag)}>{tag}</span>
                          ))}
                        </span>
                      )}
                    </span>
                    <span className="bsearch-row-score" title={`relevance ${pct}%`}>
                      <span className="bsearch-score-track"><i style={{ width: `${Math.max(pct, 6)}%` }} /></span>
                    </span>
                  </button>
                );
              })}
            </>
          )}

          {showEmpty && (
            <div className="bsearch-empty">
              <SearchIcon size={22} />
              <p>No {scope} match “{trimmedQ}”.</p>
              {!intelligent && <span>Try <button className="bsearch-empty-link" onClick={toggleIntelligent}>Intelligent search</button> for intent-aware matches.</span>}
            </div>
          )}
        </div>

        <div className="bsearch-detail">{detail}</div>
      </div>
    </div>
  );
}
