import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useRecall, haikuRecallOnce, recallOnce, type RecallHit } from '../../hooks/useRecall';
import { useRecallMode } from '../../hooks/useSleep';
import { TypeIcon, SearchIcon, SparkIcon } from '../sleepy/TypeIcons';
import { DocContent } from '../sleepy/DocContent';
import { recallNavTarget } from '../../lib/recallNav';
import { CommandModal, useListKeyboardNav } from './CommandModal';
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
 * Keyboard: ↑/↓ move and Enter runs Intelligent (when armed) or opens the focused hit
 * (shared with the switcher via `useListKeyboardNav`); Esc close/focus/scrim behavior
 * is owned by the shared <CommandModal> shell (capture-phase, topmost-aware, so it
 * never leaks to the agent overlay's Esc-collapse handler when the palette is on top).
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
  const inputRef = useRef<HTMLInputElement | null>(null);

  // When the vault's recall mode is 'hybrid', the Normal (live) search already
  // runs BM25 + local dense embeddings server-side — so the Haiku "Intelligent"
  // escalation is redundant. We hide the toggle and force it off in that mode.
  const hybridActive = useRecallMode() === 'hybrid';

  // Intelligent (Haiku) mode — preference persists; results are submit-driven.
  const [intelligentPref, setIntelligentPref] = useState(readIntelligentPref);
  const intelligent = intelligentPref && !hybridActive;
  const [intelliHits, setIntelliHits] = useState<RecallHit[]>([]);
  const [intelliState, setIntelliState] = useState<'idle' | 'thinking' | 'done'>('idle');
  const [intelliQuery, setIntelliQuery] = useState('');
  const [intelliMode, setIntelliMode] = useState<'haiku' | 'bm25'>('haiku');

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

  const go = useCallback((hit: RecallHit) => {
    const target = recallNavTarget(hit);
    onNavigate(target.page, target.slug);
    onClose();
  }, [onNavigate, onClose]);

  const focusInput = useCallback(() => { try { inputRef.current?.focus(); } catch { /* ignore */ } }, []);

  // Shared ↑/↓/Enter list nav (+ length clamp). Enter runs the Haiku pass when armed
  // and not yet run; otherwise it opens the focused hit — identical to the prior inline
  // handler. (`onEnter` closes over `runIntelli`/`go`, declared just below; it's only
  // invoked on keydown, well after those initialize.)
  const { focused, setFocused, onKeyDown } = useListKeyboardNav({
    length: hits.length,
    onEnter: (i) => {
      if (intelligent && !intelliReady && trimmed) { void runIntelli(); return; }
      if (hits[i]) go(hits[i]);
    },
  });

  const queryTokens = useMemo(
    () => (intelligent ? intelliQuery : trimmed).toLowerCase().split(/\s+/).filter(Boolean),
    [intelligent, intelliQuery, trimmed],
  );

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
  }, [trimmed, setFocused]);

  const toggleIntelligent = useCallback(() => {
    setIntelligentPref((v) => {
      const next = !v;
      try { window.localStorage.setItem(INTELLIGENT_PREF_KEY, next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
    setIntelliState('idle');
    setIntelliHits([]);
    setIntelliQuery('');
    setFocused(0);
    focusInput();
  }, [focusInput, setFocused]);

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
  }, [open, setFocused]);

  const focusedHit = hits[focused] ?? null;
  const showIntelliCTA = intelligent && !!trimmed && intelliState !== 'thinking' && !intelliReady;
  const showThinking = intelligent && intelliState === 'thinking';
  const showEmpty =
    !!trimmed &&
    ((!intelligent && !isFetching && bmHits.length === 0 && debouncedQ === trimmed) ||
      (intelligent && intelliReady && intelliHits.length === 0));
  const showIdleHint = !trimmed;

  return (
    <CommandModal
      id="command-palette"
      open={open}
      onClose={onClose}
      ariaLabel="Search the brain"
      className="command-palette"
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
            onKeyDown={onKeyDown}
          />
          {!intelligent && isFetching && !!trimmed && <span className="cmdk-spin" aria-hidden="true" />}
          {/* Hybrid mode already does semantic recall locally — the Haiku toggle
              is redundant there, so it's hidden (per the recall-mode setting). */}
          {!hybridActive && (
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
          )}
        </div>
        <kbd className="cmdk-kbd">esc</kbd>
      </div>

      <div className="cmdk-body">
        <div className="cmdk-list" role="listbox" aria-label="Search results">
          {showIdleHint && (
            <div className="cmdk-empty">
              {intelligent
                ? 'Ask anything — Intelligent search reasons over your whole brain.'
                : 'Search tasks, knowledge, core and memory.'}
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
        <span className={`cmdk-foot-mode${intelligent || hybridActive ? ' cmdk-foot-mode--intel' : ''}`}>
          {intelligent
            ? (intelliReady && intelliMode === 'bm25' ? 'bm25 · fallback' : 'intelligent · haiku')
            : hybridActive
              ? `local · ${data?.mode ?? 'hybrid'}`
              : 'local · bm25'}
        </span>
      </div>
    </CommandModal>
  );
}
