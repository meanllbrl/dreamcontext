import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useRecall, haikuRecallOnce, recallOnce, type RecallHit } from '../../hooks/useRecall';
import { TypeIcon, SearchIcon, SparkIcon } from '../sleepy/TypeIcons';
import { DocContent } from '../sleepy/DocContent';
import { recallNavTarget } from '../../lib/recallNav';
import type { Page } from '../layout/Sidebar';
import './CommandPalette.css';

/**
 * ⌘K command palette — a centered overlay that searches the WHOLE brain (all corpora)
 * and jumps to a hit's page. Opened from the header pill or ⌘K anywhere (including
 * over the expanded agent overlay).
 *
 * Two recall modes share the surface:
 *   - Normal (default) — live, debounced BM25 over `/api/recall`. Instant, free.
 *   - Intelligent — a submit-driven Haiku pass (`/api/recall/haiku`) that reasons
 *     over the brain index for intent-aware hits; spends tokens, so it runs on ↵,
 *     not per keystroke, and falls back to BM25 if the claude CLI is unavailable.
 * The toggle preference persists across opens (localStorage).
 *
 * Keyboard: ↑/↓ move, Enter runs Intelligent (when armed) or opens the focused hit,
 * Esc closes (capture-phase + stopImmediatePropagation so it never leaks to the
 * agent overlay's Esc-collapse handler when the palette is open on top of it).
 */

const INTELLIGENT_PREF_KEY = 'dreamcontext.cmdk.intelligent';

function readIntelligentPref(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(INTELLIGENT_PREF_KEY) === '1';
  } catch {
    return false;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Light up the matched query terms inside a title/snippet. */
function Highlight({ text, tokens }: { text: string; tokens: string[] }) {
  if (!tokens.length || !text) return <>{text}</>;
  const re = new RegExp(`(${tokens.map(escapeRegExp).join('|')})`, 'gi');
  const lower = new Set(tokens.map((t) => t.toLowerCase()));
  return (
    <>
      {text.split(re).map((p, i) =>
        lower.has(p.toLowerCase())
          ? <mark className="cmdk-hl" key={i}>{p}</mark>
          : <span key={i}>{p}</span>,
      )}
    </>
  );
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  /** Navigate to a hit's page; signature matches the Shell's `navigate`. */
  onNavigate: (page: Page, focusId: string | null) => void;
}

export function CommandPalette({ open, onClose, onNavigate }: CommandPaletteProps) {
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [focused, setFocused] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Intelligent (Haiku) mode — preference persists; results are submit-driven.
  const [intelligent, setIntelligent] = useState(readIntelligentPref);
  const [intelliHits, setIntelliHits] = useState<RecallHit[]>([]);
  const [intelliState, setIntelliState] = useState<'idle' | 'thinking' | 'done'>('idle');
  const [intelliQuery, setIntelliQuery] = useState('');
  const [intelliMode, setIntelliMode] = useState<'haiku' | 'bm25'>('haiku');

  // Reset transient state + focus on each open (the `intelligent` preference persists).
  useEffect(() => {
    if (!open) return;
    setQ('');
    setDebouncedQ('');
    setFocused(0);
    setIntelliHits([]);
    setIntelliState('idle');
    setIntelliQuery('');
    const raf = requestAnimationFrame(() => { try { inputRef.current?.focus(); } catch { /* ignore */ } });
    return () => cancelAnimationFrame(raf);
  }, [open]);

  const trimmed = q.trim();
  // Debounce the server-bound query (typing stays instant), matching the other surfaces.
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQ(trimmed), 110);
    return () => clearTimeout(id);
  }, [trimmed]);

  // Live BM25 — empty types = all corpora. Disabled while closed (stops polling)
  // and while Intelligent is armed (that path is submit-driven, not per-keystroke).
  const { data, isFetching } = useRecall(open && !intelligent ? debouncedQ : '', [], 12);
  const bmHits = useMemo(() => data?.hits ?? [], [data]);

  // The non-empty `intelliQuery` guard matters for the close→reopen race: a Haiku
  // request can resolve AFTER reset cleared `intelliQuery` to '' — without the guard,
  // `'' === trimmed('')` would flip intelliReady true and flash stale hits over the
  // idle hint. Requiring a non-empty query keeps the reset state clean.
  const intelliReady = intelligent && intelliState === 'done' && intelliQuery !== '' && intelliQuery === trimmed;
  const hits: RecallHit[] = intelligent ? (intelliReady ? intelliHits : []) : bmHits;

  const queryTokens = useMemo(
    () => (intelligent ? intelliQuery : trimmed).toLowerCase().split(/\s+/).filter(Boolean),
    [intelligent, intelliQuery, trimmed],
  );

  useEffect(() => { setFocused((f) => Math.min(f, Math.max(0, hits.length - 1))); }, [hits.length]);

  const go = useCallback((hit: RecallHit) => {
    const target = recallNavTarget(hit);
    onNavigate(target.page, target.slug);
    onClose();
  }, [onNavigate, onClose]);

  const focusInput = useCallback(() => { try { inputRef.current?.focus(); } catch { /* ignore */ } }, []);

  // Run the Haiku pass over all corpora. Falls back to local BM25 if claude is
  // unreachable so the palette always answers.
  const runIntelli = useCallback(async () => {
    const query = trimmed;
    if (!query) return;
    setIntelliState('thinking');
    setIntelliQuery(query);
    setFocused(0);
    try {
      const res = await haikuRecallOnce(query, []);
      setIntelliHits(res.hits);
      setIntelliMode(res.mode);
    } catch {
      try { setIntelliHits(await recallOnce(query, [], 12)); } catch { setIntelliHits([]); }
      setIntelliMode('bm25');
    }
    setIntelliState('done');
  }, [trimmed]);

  const toggleIntelligent = useCallback(() => {
    setIntelligent((v) => {
      const next = !v;
      try { window.localStorage.setItem(INTELLIGENT_PREF_KEY, next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
    setIntelliState('idle');
    setIntelliHits([]);
    setIntelliQuery('');
    setFocused(0);
    focusInput();
  }, [focusInput]);

  // Esc closes — capture-phase so it pre-empts the agent overlay's window Esc handler
  // (which bails when focus is inside `.command-palette`, but stopImmediatePropagation
  // makes the contract explicit regardless of listener order).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); onClose(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setFocused((f) => Math.min(hits.length - 1, f + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setFocused((f) => Math.max(0, f - 1)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      // Intelligent + not-yet-run → run the Haiku pass; otherwise open the focused hit.
      if (intelligent && !intelliReady && trimmed) { void runIntelli(); return; }
      if (hits[focused]) go(hits[focused]);
    }
  };

  const focusedHit = hits[focused] ?? null;
  const showIntelliCTA = intelligent && !!trimmed && intelliState !== 'thinking' && !intelliReady;
  const showThinking = intelligent && intelliState === 'thinking';
  const showEmpty =
    !!trimmed &&
    ((!intelligent && !isFetching && bmHits.length === 0 && debouncedQ === trimmed) ||
      (intelligent && intelliReady && intelliHits.length === 0));
  const showIdleHint = !trimmed;

  return (
    <div className="cmdk-scrim" onMouseDown={onClose}>
      <div
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Search the brain"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="cmdk-input-row">
          <div className={`cmdk-field${intelligent ? ' cmdk-field--intel' : ''}`}>
            <span className="cmdk-input-icon" aria-hidden="true"><SearchIcon size={17} /></span>
            <input
              ref={inputRef}
              className="cmdk-input"
              value={q}
              placeholder={intelligent ? 'Ask the brain — press ↵ to reason…' : 'Search the brain…'}
              spellCheck={false}
              autoComplete="off"
              aria-label="Search the brain"
              onChange={(e) => {
                setQ(e.target.value);
                setFocused(0);
                if (intelligent) setIntelliState('idle');
              }}
              onKeyDown={onInputKey}
            />
            {!intelligent && isFetching && !!trimmed && <span className="cmdk-spin" aria-hidden="true" />}
            <button
              type="button"
              className={`cmdk-intel${intelligent ? ' cmdk-intel--on' : ''}`}
              onClick={toggleIntelligent}
              aria-pressed={intelligent}
              title={intelligent
                ? 'Intelligent search is on — reasons over your brain with Haiku (uses tokens)'
                : 'Turn on intelligent search — intent-aware, beyond keywords'}
            >
              <span className="cmdk-intel-dot" aria-hidden="true" />
              <SparkIcon size={13} color={intelligent ? '#fff' : 'currentColor'} />
              <span className="cmdk-intel-label">Intelligent</span>
            </button>
          </div>
          <kbd className="cmdk-kbd">esc</kbd>
        </div>

        <div className="cmdk-body">
          <div className="cmdk-list" role="listbox" aria-label="Search results">
            {showIdleHint && (
              <div className="cmdk-empty">
                {intelligent
                  ? 'Ask anything — Intelligent search reasons over your whole brain.'
                  : 'Search tasks, knowledge, features, core and memory.'}
              </div>
            )}

            {showIntelliCTA && (
              <button className="cmdk-cta" onClick={() => void runIntelli()}>
                <SparkIcon size={15} color="#fff" />
                Run intelligent search
                <kbd className="cmdk-cta-kbd">↵</kbd>
              </button>
            )}

            {showThinking && (
              <div className="cmdk-thinking">
                <span className="cmdk-thinking-spark"><SparkIcon size={14} color="currentColor" /></span>
                Reasoning over your brain…
                <div className="cmdk-skel"><i /><i /><i /></div>
              </div>
            )}

            {showEmpty && (
              <div className="cmdk-empty">No matches for “{trimmed}”.</div>
            )}

            {hits.map((hit, i) => (
              <button
                key={`${hit.type}/${hit.slug}/${i}`}
                type="button"
                role="option"
                aria-selected={i === focused}
                className={`cmdk-row${i === focused ? ' cmdk-row--focused' : ''}`}
                onClick={() => go(hit)}
                onMouseEnter={() => setFocused(i)}
              >
                <span className="cmdk-row-icon" aria-hidden="true"><TypeIcon type={hit.type} size={15} /></span>
                <span className="cmdk-row-main">
                  <span className="cmdk-row-title"><Highlight text={hit.title} tokens={queryTokens} /></span>
                  <span className="cmdk-row-snippet"><Highlight text={hit.snippet || hit.description} tokens={queryTokens} /></span>
                </span>
                <span className="cmdk-row-type">{hit.type}</span>
              </button>
            ))}
          </div>

          {focusedHit && (
            <div className="cmdk-preview">
              <div className="cmdk-preview-head">
                <span className="cmdk-preview-icon" aria-hidden="true"><TypeIcon type={focusedHit.type} size={15} /></span>
                <span className="cmdk-preview-title">{focusedHit.title}</span>
              </div>
              <div className="cmdk-preview-path">{focusedHit.path}</div>
              <div className="cmdk-preview-body"><DocContent hit={focusedHit} /></div>
            </div>
          )}
        </div>

        <div className="cmdk-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span><kbd>↵</kbd> {intelligent && !intelliReady ? 'reason' : 'open'}</span>
          <span><kbd>esc</kbd> close</span>
          <span className={`cmdk-foot-mode${intelligent ? ' cmdk-foot-mode--intel' : ''}`}>
            {intelligent
              ? (intelliReady && intelliMode === 'bm25' ? 'bm25 · fallback' : 'intelligent · haiku')
              : 'local · bm25'}
          </span>
        </div>
      </div>
    </div>
  );
}
