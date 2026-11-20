import { Fragment, useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useRecall, haikuRecallOnce, recallOnce, type RecallHit } from '../../hooks/useRecall';
import { useRecallMode } from '../../hooks/useSleep';
import { useApi, useVault } from '../../context/VaultContext';
import { useI18n } from '../../context/I18nContext';
import { ApiClient } from '../../api/client';
import { fanOutRecall, RECALL_DEBOUNCE_MS, RECALL_PER_VAULT } from '../../lib/recallFanout';
import { readDeviceShell, useIsNewShell } from '../../lib/uxMode';
import { useChrome } from '../layout/WindowChrome';
import { TypeIcon, SearchIcon, SparkIcon } from '../sleepy/TypeIcons';
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

/**
 * Tooltip per importance-dial position (indexed by minLevel; 1 is unreachable —
 * `--level 1` and no filter return the same set, so the dial skips it).
 */
const LEVEL_LABELS: Record<number, string> = {
  0: 'Searching everything — click to search only curated content (★★)',
  2: 'Curated only: skipping changelog pointers and automation run logs — click for ★★★ only',
  3: 'Marked-important only: pinned knowledge, ★★/★★★ decisions, high-priority tasks, settled hypotheses — click to clear',
};

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

/** One row of the list: the open project's hit (`vault: null`) or another project's. */
interface PaletteRow { hit: RecallHit; vault: string | null }

export function CommandPalette({ open, onClose, onNavigate }: CommandPaletteProps) {
  const api = useApi();
  const { t } = useI18n();
  const { vault: openVault } = useVault();
  const chrome = useChrome();
  // ⌘K across projects (navigation B, C7): the new shell on this Mac, Normal mode only.
  const acrossProjects = useIsNewShell() && !readDeviceShell();
  const overlayId = useOverlayId('command-palette');
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

  // Live BM25 — empty types = all corpora. Disabled while closed (stops polling)
  // and while Intelligent is armed (that path is submit-driven, not per-keystroke).
  const { data, isFetching } = useRecall(open && !intelligent ? debouncedQ : '', [], 12, minLevel || undefined);
  const bmHits = useMemo(() => data?.hits ?? [], [data]);

  // The non-empty `intelliQuery` guard matters for the close→reopen race: a Haiku
  // request can resolve AFTER reset cleared `intelliQuery` to '' — without the guard,
  // `'' === trimmed('')` would flip intelliReady true and flash stale hits over the
  // idle hint. Requiring a non-empty query keeps the reset state clean.
  const intelliReady = intelligent && intelliState === 'done' && intelliQuery !== '' && intelliQuery === trimmed;
  const hits: RecallHit[] = intelligent ? (intelliReady ? intelliHits : []) : bmHits;

  // Every other registered project's hits, one group per project as each lands, below the open
  // project's (C7). A newer query (or closing) bumps the sequence: older answers are dropped.
  const [groups, setGroups] = useState<Array<{ vault: string; hits: RecallHit[] }>>([]);
  const [failed, setFailed] = useState<string[]>([]);
  const fanSeq = useRef(0);
  const others = useMemo(() => chrome.registered.filter((v) => v !== openVault), [chrome.registered, openVault]);
  const othersKey = others.join('\u0000');
  const fanOn = acrossProjects && open && !intelligent && !!trimmed && others.length > 0;
  useEffect(() => {
    fanSeq.current += 1;
    const seq = fanSeq.current;
    setGroups([]);
    setFailed([]);
    if (!fanOn) return undefined;
    const query = trimmed;
    const level = minLevel || undefined;
    const timer = setTimeout(() => {
      void fanOutRecall<RecallHit>({
        vaults: othersKey.split('\u0000'),
        read: (v) => recallOnce(new ApiClient(v), query, [], RECALL_PER_VAULT, level),
        current: () => fanSeq.current === seq,
        onGroup: (v, got) => { if (got.length) setGroups((g) => [...g, { vault: v, hits: got }]); },
        onFailed: (v) => setFailed((f) => [...f, v]),
      });
    }, RECALL_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [fanOn, trimmed, minLevel, othersKey]);
  const rows = useMemo<PaletteRow[]>(() => [
    ...hits.map((hit) => ({ hit, vault: null })),
    ...(intelligent ? [] : groups.flatMap((g) => g.hits.map((hit) => ({ hit, vault: g.vault })))),
  ], [hits, groups, intelligent]);

  const go = useCallback((row: PaletteRow) => {
    const target = recallNavTarget(row.hit);
    if (row.vault === null) onNavigate(target.page, target.slug);
    // Another project's hit lands in THAT project, at that item (navigation B).
    else chrome.goToPlace({ vault: row.vault, kind: 'page', page: target.page, id: target.slug || null, label: row.hit.title || null });
    onClose();
  }, [onNavigate, onClose, chrome]);

  const focusInput = useCallback(() => { try { inputRef.current?.focus(); } catch { /* ignore */ } }, []);

  // Shared ↑/↓/Enter list nav (+ length clamp). Enter runs the Haiku pass when armed
  // and not yet run; otherwise it opens the focused hit — identical to the prior inline
  // handler. (`onEnter` closes over `runIntelli`/`go`, declared just below; it's only
  // invoked on keydown, well after those initialize.)
  const { focused, setFocused, onKeyDown } = useListKeyboardNav({
    length: rows.length,
    onEnter: (i) => {
      if (intelligent && !intelliReady && trimmed) { void runIntelli(); return; }
      if (rows[i]) go(rows[i]);
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
    const level = minLevel || undefined;
    try {
      const res = await haikuRecallOnce(api, query, [], level);
      setIntelliHits(res.hits);
      setIntelliMode(res.mode);
    } catch {
      try { setIntelliHits(await recallOnce(api, query, [], 12, level)); } catch { setIntelliHits([]); }
      setIntelliMode('bm25');
    }
    setIntelliState('done');
  }, [api, trimmed, setFocused, minLevel]);

  // 0 → 2 → 3 → 0. A 3-position dial, so clicking cycles rather than opening a menu.
  const cycleLevel = useCallback(() => {
    setMinLevel((l) => (l === 0 ? 2 : l === 2 ? 3 : 0));
    setFocused(0);
    if (intelligent) setIntelliState('idle');
  }, [setFocused, intelligent]);

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

  const focusedRow = rows[focused] ?? null;
  const focusedHit = focusedRow?.hit ?? null;
  const showIntelliCTA = intelligent && !!trimmed && intelliState !== 'thinking' && !intelliReady;
  const showThinking = intelligent && intelliState === 'thinking';
  const showEmpty =
    !!trimmed &&
    ((!intelligent && !isFetching && bmHits.length === 0 && debouncedQ === trimmed) ||
      (intelligent && intelliReady && intelliHits.length === 0)) && groups.length === 0;
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

          {rows.map(({ hit, vault }, i) => (
            <Fragment key={`${vault ?? ''}/${hit.type}/${hit.slug}/${i}`}>
            {vault !== null && rows[i - 1]?.vault !== vault && (
              <div className="cmdk-group" aria-hidden="true"><span className="cmdk-vault-badge">{vault.slice(0, 1).toUpperCase()}</span>{vault}</div>
            )}
            <button
              type="button"
              role="option"
              aria-selected={i === focused}
              className={`cmdk-row${i === focused ? ' cmdk-row--focused' : ''}`}
              onClick={() => go(rows[i])}
              onMouseEnter={() => setFocused(i)}
            >
              <span className="cmdk-row-icon" aria-hidden="true"><TypeIcon type={hit.type} size={15} /></span>
              <span className="cmdk-row-main">
                <span className="cmdk-row-title"><Highlight text={hit.title} tokens={queryTokens} /></span>
                <span className="cmdk-row-snippet"><Highlight text={hit.snippet || hit.description} tokens={queryTokens} /></span>
              </span>
              {vault !== null && <span className="cmdk-vault-badge" title={vault} data-testid="cmdk-row-vault">{vault.slice(0, 1).toUpperCase()}</span>}
              <span className="cmdk-row-type">{hit.type}</span>
            </button>
            </Fragment>
          ))}
        </div>

        {focusedHit && (
          <div className="cmdk-preview">
            <div className="cmdk-preview-head">
              <span className="cmdk-preview-icon" aria-hidden="true"><TypeIcon type={focusedHit.type} size={15} /></span>
              <span className="cmdk-preview-title">{focusedHit.title}</span>
            </div>
            <div className="cmdk-preview-path">{focusedHit.path}</div>
            {/* Another project's doc is read through ITS server path, not this one's: its snippet. */}
            <div className="cmdk-preview-body">{focusedRow?.vault ? <p className="cmdk-preview-snippet">{focusedHit.snippet || focusedHit.description}</p> : <DocContent hit={focusedHit} />}</div>
          </div>
        )}
      </div>

      <div className="cmdk-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
        <span><kbd>↵</kbd> {intelligent && !intelliReady ? 'reason' : 'open'}</span>
        <span><kbd>esc</kbd> close</span>
        {failed.length > 0 && <span className="cmdk-foot-failed" role="status">{t('shell.nav.searchFailed').replace('{names}', () => failed.join(', '))}</span>}
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
