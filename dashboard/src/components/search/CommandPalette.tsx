import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useRecall, type RecallHit } from '../../hooks/useRecall';
import { TypeIcon, SearchIcon } from '../sleepy/TypeIcons';
import { DocContent } from '../sleepy/DocContent';
import { recallNavTarget } from '../../lib/recallNav';
import { useOverlayId } from '../../lib/useOverlayId';
import { CommandModal, useListKeyboardNav } from './CommandModal';
import type { Page } from '../layout/Sidebar';
import './CommandPalette.css';

/**
 * ⌘K command palette — a centered overlay that searches the WHOLE brain (all corpora)
 * and jumps to a hit's page. Opened from the header pill or ⌘K anywhere (including
 * over the expanded agent overlay).
 *
 * Search is live and debounced over `/api/recall`: hybrid (BM25 + local dense
 * embeddings) when the model and index are ready, plain BM25 otherwise. Local and free.
 *
 * Keyboard: ↑/↓ move and Enter opens the focused hit
 * (shared with the switcher via `useListKeyboardNav`); Esc close/focus/scrim behavior
 * is owned by the shared <CommandModal> shell (capture-phase, topmost-aware, so it
 * never leaks to the agent overlay's Esc-collapse handler when the palette is on top).
 */

/**
 * Tooltip per importance-dial position (indexed by minLevel; 1 is unreachable —
 * `--level 1` and no filter return the same set, so the dial skips it).
 */
const LEVEL_LABELS: Record<number, string> = {
  0: 'Searching everything — click to search only curated content (★★)',
  2: 'Curated only: skipping changelog pointers and automation run logs — click for ★★★ only',
  3: 'Marked-important only: pinned knowledge, ★★/★★★ decisions, high-priority tasks, settled hypotheses — click to clear',
};

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
  const overlayId = useOverlayId('command-palette');
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Minimum importance level (see DocLevel server-side): 0 = everything (the
  // default), 2 = curated content only (drops changelog pointers and automation
  // run logs), 3 = only what's explicitly marked important (pinned knowledge,
  // ★★/★★★ decisions, high-priority tasks, settled hypotheses). Cycles on click
  // rather than opening a menu — it's a 3-position dial, not a picker.
  const [minLevel, setMinLevel] = useState(0);

  const trimmed = q.trim();
  // Debounce the server-bound query (typing stays instant), matching the other surfaces.
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQ(trimmed), 110);
    return () => clearTimeout(id);
  }, [trimmed]);

  // Live recall — empty types = all corpora. Disabled while closed (stops polling).
  const { data, isFetching } = useRecall(open ? debouncedQ : '', [], 12, minLevel || undefined);

  const hits = useMemo<RecallHit[]>(() => data?.hits ?? [], [data]);

  const go = useCallback((hit: RecallHit) => {
    const target = recallNavTarget(hit);
    onNavigate(target.page, target.slug);
    onClose();
  }, [onNavigate, onClose]);

  // Shared ↑/↓/Enter list nav (+ length clamp): Enter opens the focused hit.
  const { focused, setFocused, onKeyDown } = useListKeyboardNav({
    length: hits.length,
    onEnter: (i) => { if (hits[i]) go(hits[i]); },
  });

  const queryTokens = useMemo(
    () => trimmed.toLowerCase().split(/\s+/).filter(Boolean),
    [trimmed],
  );

  // 0 → 2 → 3 → 0. A 3-position dial, so clicking cycles rather than opening a menu.
  const cycleLevel = useCallback(() => {
    setMinLevel((l) => (l === 0 ? 2 : l === 2 ? 3 : 0));
    setFocused(0);
  }, [setFocused]);

  // Reset transient state + focus on each open.
  useEffect(() => {
    if (!open) return;
    setQ('');
    setDebouncedQ('');
    setFocused(0);
    const raf = requestAnimationFrame(() => { try { inputRef.current?.focus(); } catch { /* ignore */ } });
    return () => cancelAnimationFrame(raf);
  }, [open, setFocused]);

  const focusedHit = hits[focused] ?? null;
  const showEmpty = !!trimmed && !isFetching && hits.length === 0 && debouncedQ === trimmed;
  const showIdleHint = !trimmed;

  return (
    <CommandModal
      id={overlayId}
      open={open}
      onClose={onClose}
      ariaLabel="Search the brain"
      className="command-palette"
    >
      <div className="cmdk-input-row">
        <div className="cmdk-field">
          <span className="cmdk-input-icon" aria-hidden="true"><SearchIcon size={17} /></span>
          <input
            ref={inputRef}
            className="cmdk-input"
            value={q}
            placeholder="Search the brain…"
            spellCheck={false}
            autoComplete="off"
            aria-label="Search the brain"
            onChange={(e) => {
              setQ(e.target.value);
              setFocused(0);
            }}
            onKeyDown={onKeyDown}
          />
          {isFetching && !!trimmed && <span className="cmdk-spin" aria-hidden="true" />}
          {/* Importance dial — narrows the corpus to what the brain already marks
              as important, rather than re-ranking. Off by default so the palette's
              behaviour is unchanged until asked. */}
          <button
            type="button"
            className={`cmdk-level${minLevel ? ' cmdk-level--on' : ''}`}
            onClick={cycleLevel}
            aria-label={LEVEL_LABELS[minLevel]}
            title={LEVEL_LABELS[minLevel]}
          >
            <span className="cmdk-level-stars" aria-hidden="true">
              {minLevel ? '★'.repeat(minLevel) : '★'}
            </span>
          </button>
        </div>
        <kbd className="cmdk-kbd">esc</kbd>
      </div>

      <div className="cmdk-body">
        <div className="cmdk-list" role="listbox" aria-label="Search results">
          {showIdleHint && (
            <div className="cmdk-empty">
              Search tasks, knowledge, core and memory.
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
        <span><kbd>↵</kbd> open</span>
        <span><kbd>esc</kbd> close</span>
        <span className={`cmdk-foot-mode${data?.mode === 'hybrid' ? ' cmdk-foot-mode--intel' : ''}`}>
          {`local · ${data?.mode === 'hybrid' ? 'hybrid' : 'bm25'}`}
        </span>
      </div>
    </CommandModal>
  );
}
