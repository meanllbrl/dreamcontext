import {
  useState, useEffect, useRef, useMemo, useCallback,
  type ReactNode, type CSSProperties, type KeyboardEvent,
} from 'react';
import { useRecall, haikuRecallOnce, recallOnce, type RecallHit } from '../hooks/useRecall';
import {
  startChat, streamChat, getChatHistory, resetChat, type ChatTier,
} from '../hooks/useSleepyChat';
import { BrandMark } from '../components/brand/BrandMark';
import { DocContent } from '../components/sleepy/DocContent';
import { AgentSlot } from '../components/sleepy/AgentSurface';
import { MarkdownPreview } from '../components/core/MarkdownPreview';
import { TypeIcon, SearchIcon, SparkIcon } from '../components/sleepy/TypeIcons';
import type { Page } from '../components/layout/Sidebar';
import './SleepyPage.css';

/* ── Types & metadata ─────────────────────────────────────────────────────── */

type TypeLabel = 'Knowledge' | 'Features' | 'Tasks' | 'Core' | 'Memory';
const TYPES: TypeLabel[] = ['Knowledge', 'Features', 'Tasks', 'Core', 'Memory'];

interface TypeMeta { color: string; recall: RecallHit['type']; page: Page }
const TYPE_META: Record<TypeLabel, TypeMeta> = {
  Knowledge: { color: '#9d8cff', recall: 'knowledge', page: 'knowledge' },
  Features:  { color: '#4aa8ff', recall: 'feature',   page: 'features' },
  Tasks:     { color: '#56d364', recall: 'task',      page: 'tasks' },
  Core:      { color: '#e3b341', recall: 'changelog', page: 'core' },
  Memory:    { color: '#db61a2', recall: 'memory',    page: 'core' },
};
const RECALL_TO_LABEL: Record<RecallHit['type'], TypeLabel> = {
  knowledge: 'Knowledge', feature: 'Features', task: 'Tasks', changelog: 'Core', memory: 'Memory',
};

interface DecoratedHit extends RecallHit { typeLabel: TypeLabel }

/* ── Pure helpers ─────────────────────────────────────────────────────────── */

function softColor(hex: string, a = 0.13): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

function tokensOf(str: string): string[] {
  return (str || '').toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean);
}

function highlight(text: string, tokens: string[]): ReactNode {
  if (!tokens.length) return text;
  const esc = tokens.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).filter(Boolean);
  if (!esc.length) return text;
  const re = new RegExp('(' + esc.join('|') + ')', 'ig');
  const parts = text.split(re);
  const mark: CSSProperties = { color: '#bcacff', background: 'rgba(157,140,255,0.18)', borderRadius: '3px', padding: '0 2px', fontWeight: 600 };
  return <>{parts.map((p, i) => {
    if (!p) return null;
    const isHit = esc.some(e => p.toLowerCase() === e.toLowerCase());
    return isHit ? <mark key={i} style={mark}>{p}</mark> : <span key={i}>{p}</span>;
  })}</>;
}

function dots(n: number): ReactNode {
  return <>{[0, 1, 2].map(i => (
    <span key={i} style={{ width: '5px', height: '5px', borderRadius: '50%', background: i < n ? '#9d8cff' : 'var(--border-3)', boxShadow: i < n ? '0 0 5px rgba(157,140,255,0.6)' : 'none' }} />
  ))}</>;
}

function decorate(hit: RecallHit): DecoratedHit {
  return { ...hit, typeLabel: RECALL_TO_LABEL[hit.type] ?? 'Knowledge' };
}

/* ── Component ────────────────────────────────────────────────────────────── */

interface SleepyPageProps {
  /** Jump to a full page (used by the doc panel's "Open full document"). */
  onOpenDoc?: (page: Page, slug: string) => void;
}

/** One Ask exchange — a real Claude Code turn streamed in over SSE. */
interface Turn {
  id: string;
  question: string;
  answer: string;
  /** Sleepy's live reasoning trace (thinking deltas), if any. */
  thinking: string;
  /** Read-only tools Sleepy used while answering (e.g. Read, Grep). */
  tools: string[];
  done: boolean;
  streaming: boolean;
  error: string | null;
}

type IntelliState = 'idle' | 'thinking' | 'done';

/** Survives SleepyPage remounts (navigation) so the active tab is restored. */
let lastSleepyMode: 'search' | 'ask' | 'agent' = 'search';

export function SleepyPage({ onOpenDoc }: SleepyPageProps) {
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [types, setTypes] = useState<TypeLabel[]>([]);
  const [focused, setFocused] = useState(0);
  const [layout, setLayout] = useState<'flat' | 'grouped'>('flat');
  // Remember which Sleepy tab you were on (Search/Ask/Agent) so navigating away and
  // back returns you to it — App.tsx remounts SleepyPage on navigation, so a plain
  // useState would always reset to 'search'. `lastSleepyMode` is module-scoped and
  // survives the remount for the life of the app window.
  const [mode, setMode] = useState<'search' | 'ask' | 'agent'>(() => lastSleepyMode);
  useEffect(() => { lastSleepyMode = mode; }, [mode]);

  // Intelligent search — a dreamcontext-specific, default-OFF toggle that swaps
  // instant local BM25 for an intent-aware Haiku pass (submit-driven; tokens).
  const [intelligent, setIntelligent] = useState(false);
  const [intelliHits, setIntelliHits] = useState<DecoratedHit[]>([]);
  const [intelliState, setIntelliState] = useState<IntelliState>('idle');
  const [intelliQuery, setIntelliQuery] = useState('');

  // Ask — a real Claude Code conversation in the vault, streamed over SSE.
  const [thread, setThread] = useState<Turn[]>([]);
  const [chatModel, setChatModel] = useState<ChatTier>('normal');

  const [doc, setDoc] = useState<RecallHit | null>(null);
  const [docTokens, setDocTokens] = useState<string[]>([]);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const chatCleanupRef = useRef<(() => void) | null>(null);

  const searchMode = mode === 'search';
  const askMode = mode === 'ask';
  const agentMode = mode === 'agent';
  const trimmedQ = q.trim();
  const hasQuery = trimmedQ.length > 0;

  const recallTypes = useMemo(() => types.map(t => TYPE_META[t].recall), [types]);

  const bm25Mode = searchMode && !intelligent;
  const intelliMode = searchMode && intelligent;

  // Debounce the query that actually hits the server (typing stays instant).
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQ(trimmedQ), 110);
    return () => clearTimeout(id);
  }, [trimmedQ]);

  // BM25 live search — disabled in intelligent mode (which is submit-driven).
  const { data, isFetching } = useRecall(bm25Mode ? debouncedQ : '', recallTypes, 12);

  const flat: DecoratedHit[] = useMemo(() => (data?.hits ?? []).map(decorate), [data]);

  // The rows actually on screen come from whichever path is active.
  const rows = intelliMode ? intelliHits : flat;
  const maxScore = rows.length ? Math.max(...rows.map(f => f.rankScore || f.score || 1)) : 1;
  const activeQuery = intelliMode ? intelliQuery : trimmedQ;
  const queryTokens = useMemo(() => activeQuery.toLowerCase().split(/\s+/).filter(Boolean), [activeQuery]);

  const showConstellation = searchMode && !hasQuery;
  const showIntelliCTA = intelliMode && hasQuery && intelliState === 'idle';
  const showThinking = intelliMode && intelliState === 'thinking';
  const intelliReady = intelliMode && intelliState === 'done' && intelliQuery === trimmedQ;
  const hasResults = searchMode && rows.length > 0 && (intelliMode ? intelliReady : hasQuery);
  const showNoResults =
    (bm25Mode && hasQuery && !isFetching && flat.length === 0 && debouncedQ === trimmedQ) ||
    (intelliMode && intelliState === 'done' && intelliHits.length === 0);
  const showMeta = hasResults;
  const showFlat = hasResults && layout === 'flat';
  const showGrouped = hasResults && layout === 'grouped';
  const showAskFace = askMode && thread.length === 0;
  const showAskPanel = askMode && thread.length > 0;

  const focusInput = useCallback(() => { try { inputRef.current?.focus(); } catch { /* ignore */ } }, []);

  useEffect(() => { focusInput(); }, [mode, focusInput]);
  // Hydrate the Ask transcript (+ remembered tier) from the server once on mount.
  useEffect(() => {
    let cancelled = false;
    getChatHistory().then(h => {
      if (cancelled) return;
      setChatModel(h.tier);
      const turns: Turn[] = [];
      for (const m of h.messages) {
        if (m.role === 'user') {
          turns.push({ id: `h-${m.ts}`, question: m.content, answer: '', thinking: '', tools: [], done: true, streaming: false, error: null });
        } else {
          const last = turns[turns.length - 1];
          if (last && !last.answer) { last.answer = m.content; last.thinking = m.thinking ?? ''; last.tools = m.tools ?? []; }
          else turns.push({ id: `h-${m.ts}`, question: '', answer: m.content, thinking: m.thinking ?? '', tools: m.tools ?? [], done: true, streaming: false, error: null });
        }
      }
      if (turns.length) setThread(turns);
    }).catch(() => { /* no history / launcher mode */ });
    return () => { cancelled = true; if (chatCleanupRef.current) chatCleanupRef.current(); };
  }, []);

  useEffect(() => { if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight; }, [thread]);
  // Keep the focused row inside the result set as it shrinks/grows.
  useEffect(() => { setFocused(f => Math.min(f, Math.max(0, rows.length - 1))); }, [rows.length]);

  // ⌘K / Ctrl-K focuses the search box from anywhere on the page.
  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); focusInput(); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [focusInput]);

  /* ── Actions ───────────────────────────────────────────────────────────── */

  const openDoc = useCallback((hit: RecallHit) => {
    setDoc(hit);
    setDocTokens(tokensOf(activeQuery));
  }, [activeQuery]);
  const closeDoc = useCallback(() => setDoc(null), []);

  const setModeTo = (m: 'search' | 'ask' | 'agent') => { setMode(m); if (m !== 'agent') focusInput(); };

  const toggleType = (t: TypeLabel | 'All') => {
    setFocused(0);
    if (t === 'All') { setTypes([]); return; }
    setTypes(prev => (prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t]));
  };

  // The constellation and the filter chips share one source of truth (`types`).
  const selectConst = (t: TypeLabel) => toggleType(t);
  const constClear = () => { setTypes([]); setFocused(0); };

  const toggleIntelligent = () => {
    setIntelligent(v => {
      const next = !v;
      // Switching modes always returns to a clean, un-run state for the query.
      setIntelliState('idle'); setIntelliHits([]); setIntelliQuery('');
      setFocused(0);
      return next;
    });
    focusInput();
  };

  const runIntelliSearch = useCallback(async () => {
    const query = trimmedQ;
    if (!query) return;
    setIntelliState('thinking');
    setIntelliQuery(query);
    setFocused(0);
    let hits: DecoratedHit[] = [];
    try {
      hits = (await haikuRecallOnce(query, recallTypes)).hits.map(decorate);
    } catch {
      // Haiku failed outright — fall back to local BM25 so the search still answers.
      try { hits = (await recallOnce(query, recallTypes, 12)).map(decorate); } catch { hits = []; }
    }
    setIntelliHits(hits);
    setIntelliState('done');
  }, [trimmedQ, recallTypes]);

  const clearQuery = () => {
    setQ(''); setDebouncedQ(''); setFocused(0);
    setIntelliState('idle'); setIntelliHits([]); setIntelliQuery('');
    setDoc(null);
    focusInput();
  };

  const pickExample = (label: string) => { setQ(label); setFocused(0); setIntelliState('idle'); focusInput(); };

  const submitAsk = useCallback(async (override?: string) => {
    const question = (override ?? q).trim();
    if (!question) { setMode('ask'); focusInput(); return; }
    if (chatCleanupRef.current) { chatCleanupRef.current(); chatCleanupRef.current = null; }
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setMode('ask');
    setQ('');
    setThread(prev => [...prev, { id, question, answer: '', thinking: '', tools: [], done: false, streaming: true, error: null }]);
    focusInput();

    const patch = (fn: (t: Turn) => Turn) => setThread(prev => prev.map(t => (t.id === id ? fn(t) : t)));
    try {
      const runId = await startChat(question, chatModel, false);
      chatCleanupRef.current = streamChat(runId, {
        onThinking: (txt) => patch(t => ({ ...t, thinking: t.thinking + txt })),
        onText: (txt) => patch(t => ({ ...t, answer: t.answer + txt })),
        onTool: (name) => patch(t => (t.tools.includes(name) ? t : { ...t, tools: [...t.tools, name] })),
        onDone: (final) => { patch(t => ({ ...t, answer: final || t.answer, done: true, streaming: false })); chatCleanupRef.current = null; },
        onError: (msg) => { patch(t => ({ ...t, error: msg, streaming: false, done: true })); chatCleanupRef.current = null; },
      });
    } catch (err) {
      patch(t => ({ ...t, error: err instanceof Error ? err.message : 'Failed to reach Sleepy.', streaming: false, done: true }));
    }
  }, [q, chatModel, focusInput]);

  const resetConversation = useCallback(async () => {
    if (chatCleanupRef.current) { chatCleanupRef.current(); chatCleanupRef.current = null; }
    setThread([]); setQ('');
    try { await resetChat(); } catch { /* best-effort */ }
    focusInput();
  }, [focusInput]);

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (askMode) {
      if (e.key === 'Enter') { e.preventDefault(); void submitAsk(); }
      else if (e.key === 'Escape') setQ('');
      return;
    }
    if (e.key === 'Escape') { clearQuery(); return; }
    // Intelligent search is submit-driven: Enter runs the pass until results exist
    // for the current query, then Enter opens the focused row.
    if (e.key === 'Enter') {
      e.preventDefault();
      if (intelliMode && !intelliReady) { void runIntelliSearch(); return; }
      if (rows[focused]) openDoc(rows[focused]);
      return;
    }
    const n = rows.length;
    if (e.key === 'ArrowDown') { e.preventDefault(); setFocused(f => Math.min(n - 1, f + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setFocused(f => Math.max(0, f - 1)); }
  };

  const onChangeQuery = (value: string) => {
    setQ(value);
    setFocused(0);
    // A changed query invalidates a prior intelligent result — require a re-run.
    if (intelliMode && intelliState !== 'idle') setIntelliState('idle');
  };

  const openFullDoc = () => {
    if (doc && onOpenDoc) {
      const meta = TYPE_META[RECALL_TO_LABEL[doc.type] ?? 'Knowledge'];
      onOpenDoc(meta.page, doc.slug);
    }
    closeDoc();
  };

  /* ── Derived view data ─────────────────────────────────────────────────── */

  const groups = useMemo(() => TYPES.map(t => {
    const items = rows.filter(f => f.typeLabel === t);
    return { type: t, color: TYPE_META[t].color, recall: TYPE_META[t].recall, count: items.length, items };
  }).filter(g => g.items.length), [rows]);

  // Constellation node geometry (5 types in orbit).
  const constNodes = useMemo(() => {
    const ccx = 260, ccy = 206, Rx = 168, Ry = 150;
    const cAngles = [-90, -18, 54, 126, 198];
    return TYPES.map((t, i) => {
      const meta = TYPE_META[t];
      const a = (cAngles[i] * Math.PI) / 180;
      const x = Math.round(ccx + Rx * Math.cos(a));
      const y = Math.round(ccy + Ry * Math.sin(a));
      const selected = types.includes(t);
      const dim = types.length > 0 && !selected;
      return { t, meta, x, y, selected, dim, i, ccx, ccy };
    });
  }, [types]);

  const renderRow = (r: DecoratedHit, i: number, showTag: boolean) => {
    const meta = TYPE_META[r.typeLabel];
    const active = i === focused;
    const d = Math.max(1, Math.round(((r.rankScore || r.score) / maxScore) * 3));
    const rowStyle: CSSProperties = {
      display: 'flex', gap: '14px', padding: '13px 15px', borderRadius: '11px', cursor: 'pointer',
      border: '1px solid ' + (active ? 'var(--border-3)' : 'transparent'),
      background: active ? 'var(--bg-active)' : 'transparent',
      boxShadow: active ? 'inset 3px 0 0 #9d8cff' : 'none',
      transition: 'background .12s, border-color .12s',
    };
    const badgeStyle: CSSProperties = {
      flex: '0 0 auto', width: '34px', height: '34px', borderRadius: '10px',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: meta.color, backgroundColor: softColor(meta.color), border: '1px solid ' + softColor(meta.color, 0.25),
    };
    const tagStyle: CSSProperties = {
      fontFamily: 'var(--font-mono)', fontSize: '9.5px', textTransform: 'uppercase', letterSpacing: '0.06em',
      padding: '1px 6px', borderRadius: '5px', color: meta.color, background: softColor(meta.color), whiteSpace: 'nowrap',
    };
    return (
      <div
        key={`${r.type}/${r.slug}`} className="sleepy-res-row"
        onClick={() => openDoc(r)} onMouseEnter={() => setFocused(i)} style={rowStyle}
      >
        <div style={badgeStyle}><TypeIcon type={r.type} size={17} color={meta.color} /></div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '9px', marginBottom: '3px' }}>
            <span style={{ fontFamily: 'var(--font-family-display)', fontWeight: 600, fontSize: '15px', color: 'var(--text)', letterSpacing: '-0.01em' }}>{r.title}</span>
            {showTag && <span style={tagStyle}>{r.typeLabel}</span>}
          </div>
          <div style={{ fontSize: '13px', color: 'var(--text-3)', lineHeight: 1.5, marginBottom: '6px', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{highlight(r.snippet || r.description, queryTokens)}</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: '11.5px', color: 'var(--text-6)' }}>{r.path}</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '8px', flex: '0 0 auto', paddingTop: '2px' }}>
          <div style={{ display: 'flex', gap: '3px', alignItems: 'center' }}>{dots(d)}</div>
          {active && <span style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: '#9d8cff', display: 'flex', alignItems: 'center', gap: '3px' }}>open <span style={{ fontSize: '11px' }}>↵</span></span>}
        </div>
      </div>
    );
  };

  /* ── Composer pieces ───────────────────────────────────────────────────── */

  const chipDefs: Array<{ key: TypeLabel | 'All'; label: string; recall: RecallHit['type'] | null; color: string | null }> = [
    ...TYPES.map(t => ({ key: t, label: t, recall: TYPE_META[t].recall, color: TYPE_META[t].color })),
    { key: 'All', label: 'All', recall: null, color: null },
  ];
  const noFilter = types.length === 0;
  const tabBase: CSSProperties = { padding: '5px 14px', borderRadius: '7px', fontSize: '12px', fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--font-family-text)', transition: 'all .12s' };
  const modeTabBase: CSSProperties = { display: 'flex', alignItems: 'center', gap: '6px', padding: '7px 13px', borderRadius: '8px', fontSize: '12.5px', fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--font-family-text)', transition: 'all .12s', userSelect: 'none', whiteSpace: 'nowrap' };
  const activeTab: CSSProperties = { background: 'rgba(157,140,255,0.18)', color: '#bcacff' };
  const idleTab: CSSProperties = { color: 'var(--text-5)' };
  // BETA badge on the Agent tab — same family as Council's LAB / Settings' BETA.
  const agentBetaBadge: CSSProperties = {
    marginLeft: '1px', padding: '1px 5px', borderRadius: '5px',
    fontFamily: 'var(--font-mono)', fontSize: '8.5px', fontWeight: 700,
    letterSpacing: '0.06em', textTransform: 'uppercase', lineHeight: 1.4,
    color: 'var(--color-accent, #a78bfa)',
    background: 'color-mix(in srgb, var(--color-accent, #a78bfa) 16%, transparent)',
    border: '1px solid color-mix(in srgb, var(--color-accent, #a78bfa) 35%, transparent)',
  };

  const inputAccent = askMode || intelliMode;
  const inputBorder = (hasQuery || askMode) ? (intelliMode ? '#b98bff' : '#9d8cff') : 'var(--border-2)';
  const inputGlow = (hasQuery || askMode)
    ? '0 0 0 3px rgba(157,140,255,0.18), 0 8px 30px -12px rgba(123,104,238,0.5)'
    : '0 2px 12px -6px rgba(0,0,0,0.6)';

  /* ── Render ────────────────────────────────────────────────────────────── */

  return (
    <div className="sleepy-view" data-testid="sleepy-page">
      {/* Top bar: mode toggle + meta */}
      <div style={{ flex: '0 0 auto', height: '58px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 28px', borderBottom: '1px solid var(--border-soft)', background: 'linear-gradient(180deg, rgba(123,104,238,0.05), transparent)' }}>
        <div style={{ display: 'flex', padding: '3px', background: 'var(--bg-input)', border: '1px solid var(--border-2)', borderRadius: '11px' }}>
          <div onClick={() => setModeTo('search')} style={{ ...modeTabBase, ...(searchMode ? activeTab : idleTab) }}><SearchIcon size={13} /> Search</div>
          <div onClick={() => setModeTo('ask')} style={{ ...modeTabBase, ...(askMode ? activeTab : idleTab) }}><SparkIcon size={13} /> Ask</div>
          <div onClick={() => setModeTo('agent')} style={{ ...modeTabBase, ...(agentMode ? activeTab : idleTab) }}><span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', fontWeight: 700 }}>&gt;_</span> Agent<span style={agentBetaBadge}>BETA</span></div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {showMeta && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontFamily: 'var(--font-mono)', fontSize: '11.5px', color: 'var(--text-6)', whiteSpace: 'nowrap' }}>
              <span style={{ color: 'var(--text-3)' }}>{rows.length}</span><span>results</span>
              <span style={{ color: 'var(--border-3)' }}>·</span>
              {intelliMode ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: '#bcacff' }}><span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#b98bff' }} />intelligent</span>
              ) : (
                <>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: '#56d364' }}><span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#56d364', animation: 'sleepyLivePulse 1.4s ease-in-out infinite' }} />local</span>
                  <span style={{ color: 'var(--border-3)' }}>·</span>
                  <span>{data?.tookMs ?? 0}ms</span>
                </>
              )}
            </div>
          )}
          {(hasQuery && searchMode) && (
            <span onClick={clearQuery} title="Clear" style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: '5px 11px', borderRadius: '8px', cursor: 'pointer', color: 'var(--text-4)', fontSize: '12px', fontFamily: 'var(--font-mono)', border: '1px solid var(--border-2)' }}>✕ clear</span>
          )}
          {askMode && thread.length > 0 && (
            <span onClick={() => void resetConversation()} title="Start a fresh conversation" style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 11px', borderRadius: '8px', cursor: 'pointer', color: 'var(--text-4)', fontSize: '12px', fontFamily: 'var(--font-mono)', border: '1px solid var(--border-2)' }}>↺ reset</span>
          )}
        </div>
      </div>

      {/* Body */}
      <div ref={bodyRef} className="sleepy-body" style={{ flex: 1, minHeight: 0, overflowY: agentMode ? 'hidden' : 'auto', position: 'relative' }}>

        {/* AGENT — real interactive Claude Code (desktop-only). Only an anchor here;
            the live terminal is owned by the persistent AgentSurface (App.tsx) so the
            session survives navigating away and back. */}
        {agentMode && <AgentSlot />}

        {/* CONTEXT CONSTELLATION (idle) */}
        {showConstellation && (
          <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '6px 20px 14px' }}>
            <div style={{ position: 'relative', width: '520px', height: '412px', flex: '0 0 auto' }}>
              <svg width="520" height="412" style={{ position: 'absolute', inset: 0, overflow: 'visible', pointerEvents: 'none' }}>
                {constNodes.map(n => (
                  <line
                    key={n.t} x1={n.ccx} y1={n.ccy} x2={n.x} y2={n.y}
                    style={{
                      stroke: n.selected ? n.meta.color : 'var(--line)',
                      strokeWidth: n.selected ? 2.2 : 1.3,
                      strokeOpacity: n.dim ? 0 : (n.selected ? 0.95 : 0.5),
                      strokeDasharray: n.selected ? 'none' : '4 6',
                      strokeLinecap: 'round',
                      transition: 'stroke-opacity .45s ease, stroke .3s ease, stroke-width .3s ease',
                      animation: n.selected ? 'none' : `sleepyFlowDash ${1.1 + n.i * 0.12}s linear infinite`,
                    }}
                  />
                ))}
              </svg>
              {/* Center: the dream gem with a violet halo */}
              <div onClick={constClear} title="Sleepy" style={{ position: 'absolute', left: '260px', top: '206px', transform: 'translate(-50%,-50%)', cursor: 'pointer', zIndex: 4 }}>
                <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', animation: 'sleepyBob 4.6s ease-in-out infinite' }}>
                  <div style={{ position: 'absolute', width: '158px', height: '158px', borderRadius: '50%', background: 'radial-gradient(circle, rgba(123,104,238,0.32), transparent 66%)', animation: 'sleepyHaloPulse 5s ease-in-out infinite' }} />
                  <BrandMark size={108} glow title="Sleepy" />
                </div>
              </div>
              {/* Context nodes */}
              {constNodes.map(n => (
                <div
                  key={n.t} onClick={() => selectConst(n.t)}
                  style={{
                    position: 'absolute', left: n.x + 'px', top: n.y + 'px', display: 'flex', alignItems: 'center', gap: '9px',
                    transform: 'translate(-50%,-50%)', padding: '9px 15px', borderRadius: '12px',
                    background: n.selected ? softColor(n.meta.color, 0.16) : 'var(--bg-chip)',
                    border: '1px solid ' + (n.selected ? n.meta.color : (n.dim ? 'var(--border-soft)' : 'var(--border-2)')),
                    boxShadow: n.selected ? `0 0 0 1px ${n.meta.color}, 0 14px 34px -10px ${softColor(n.meta.color, 0.7)}` : '0 8px 22px -12px rgba(0,0,0,0.7)',
                    cursor: 'pointer', opacity: n.dim ? 0.32 : 1, whiteSpace: 'nowrap',
                    transition: 'opacity .4s ease, border-color .3s ease, box-shadow .3s ease, background .3s ease',
                    animation: n.selected ? 'sleepySelPop 2.4s ease-in-out infinite' : `sleepyNodeFloat ${4.2 + n.i * 0.5}s ease-in-out infinite ${n.i * 0.35}s`,
                    zIndex: n.selected ? 6 : 3,
                  }}
                >
                  {n.selected && <div style={{ position: 'absolute', inset: '-10px', borderRadius: '18px', background: `radial-gradient(circle, ${softColor(n.meta.color, 0.42)}, transparent 70%)`, animation: 'sleepyHaloPulse 1.8s ease-in-out infinite', pointerEvents: 'none', zIndex: -1 }} />}
                  <div style={{ flex: '0 0 auto', width: '24px', height: '24px', borderRadius: '7px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: n.meta.color, backgroundColor: softColor(n.meta.color), border: '1px solid ' + softColor(n.meta.color, 0.3) }}><TypeIcon type={n.meta.recall} size={13} color={n.meta.color} /></div>
                  <span style={{ fontFamily: 'var(--font-family-text)', fontSize: '13.5px', fontWeight: 600, color: n.dim ? 'var(--text-5)' : 'var(--text)' }}>{n.t}</span>
                </div>
              ))}
            </div>
            <div style={{ textAlign: 'center', maxWidth: '480px', marginTop: '2px' }}>
              <h1 style={{ fontFamily: 'var(--font-family-display)', fontWeight: 700, fontSize: '21px', color: 'var(--text)', margin: '0 0 6px', letterSpacing: '-0.015em' }}>Your context, in orbit</h1>
              <p style={{ fontSize: '13.5px', color: 'var(--text-4)', margin: 0, lineHeight: 1.5 }}>Pick a type to focus its orbit — Sleepy keeps the rest circling. Or just start typing below.</p>
            </div>
          </div>
        )}

        {/* INTELLIGENT SEARCH — call to action (typed, not yet run) */}
        {showIntelliCTA && (
          <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '40px', textAlign: 'center' }}>
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', width: '92px', height: '92px', marginBottom: '20px' }}>
              <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: 'radial-gradient(circle, rgba(123,104,238,0.34), transparent 66%)', animation: 'sleepyHaloPulse 3.4s ease-in-out infinite' }} />
              <div style={{ color: '#b98bff', filter: 'drop-shadow(0 0 10px rgba(157,140,255,0.7))' }}><SparkIcon size={42} /></div>
            </div>
            <h2 style={{ fontFamily: 'var(--font-family-display)', fontWeight: 700, fontSize: '20px', color: 'var(--text-1)', margin: '0 0 6px' }}>Intelligent search is on</h2>
            <p style={{ fontSize: '14px', color: 'var(--text-4)', margin: '0 0 22px', maxWidth: '440px', lineHeight: 1.5 }}>Sleepy will read your whole brain index and reason about <span style={{ color: '#bcacff', fontFamily: 'var(--font-mono)' }}>&ldquo;{trimmedQ}&rdquo;</span> to pick the docs that actually fit — beyond keyword overlap.</p>
            <span onClick={() => void runIntelliSearch()} style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '10px 18px', borderRadius: '11px', cursor: 'pointer', background: 'linear-gradient(150deg,#8b7bff,#6f5ce0)', color: '#fff', fontSize: '13.5px', fontWeight: 600, boxShadow: '0 6px 18px -6px rgba(123,104,238,0.85)' }}><SparkIcon size={15} color="#fff" /> Run intelligent search <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', opacity: 0.85 }}>↵</span></span>
          </div>
        )}

        {/* INTELLIGENT SEARCH — thinking */}
        {showThinking && (
          <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '40px', textAlign: 'center' }}>
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', width: '92px', height: '92px', marginBottom: '20px', animation: 'sleepyBob 3s ease-in-out infinite' }}>
              <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: 'radial-gradient(circle, rgba(123,104,238,0.4), transparent 66%)', animation: 'sleepyHaloPulse 1.6s ease-in-out infinite' }} />
              <div style={{ color: '#b98bff' }}><SparkIcon size={42} /></div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '9px', color: 'var(--text-3)', fontSize: '14px' }}>
              <span style={{ display: 'flex', gap: '4px' }}>
                {[0, 0.2, 0.4].map((d, i) => <span key={i} style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#9d8cff', animation: `sleepyLivePulse 1s ease-in-out infinite ${d}s` }} />)}
              </span>
              Reasoning over your brain with Haiku…
            </div>
          </div>
        )}

        {/* NO RESULTS */}
        {showNoResults && (
          <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '40px', textAlign: 'center' }}>
            <div style={{ width: '64px', height: '64px', borderRadius: '16px', background: 'var(--bg-elev)', border: '1px solid var(--border-panel)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-6)', marginBottom: '4px' }}><SearchIcon size={26} /></div>
            <h2 style={{ fontFamily: 'var(--font-family-display)', fontWeight: 700, fontSize: '20px', color: 'var(--text-1)', margin: '16px 0 6px' }}>Nothing yet — try broader terms</h2>
            <p style={{ fontSize: '14px', color: 'var(--text-5)', margin: '0 0 24px' }}>No hits for <span style={{ fontFamily: 'var(--font-mono)', color: '#9d8cff' }}>&ldquo;{trimmedQ}&rdquo;</span>. Try fewer words, or ask Sleepy instead.</p>
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', justifyContent: 'center', maxWidth: '540px' }}>
              {['how does sleep work', 'recent tasks', 'architecture', 'decisions'].map(label => (
                <div key={label} onClick={() => pickExample(label)} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 14px', borderRadius: '11px', border: '1px solid var(--border-2)', background: 'var(--bg-chip)', color: 'var(--text-3)', fontSize: '13px', cursor: 'pointer', transition: 'all .14s' }}>
                  <SearchIcon size={12} /> {label}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* FLAT RANKED */}
        {showFlat && (
          <div style={{ padding: '16px 28px 24px', display: 'flex', flexDirection: 'column', gap: '6px', maxWidth: '880px' }}>
            {rows.map((r, i) => renderRow(r, i, true))}
          </div>
        )}

        {/* GROUPED */}
        {showGrouped && (
          <div style={{ padding: '16px 28px 24px', display: 'flex', flexDirection: 'column', gap: '18px', maxWidth: '880px' }}>
            {groups.map(g => (
              <div key={g.type}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '9px', padding: '0 4px 9px' }}>
                  <span style={{ color: g.color, display: 'flex' }}><TypeIcon type={g.recall} size={14} color={g.color} /></span>
                  <span style={{ fontFamily: 'var(--font-family-display)', fontWeight: 600, fontSize: '13px', color: 'var(--text-2)', letterSpacing: '0.01em' }}>{g.type}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-6)' }}>{g.count}</span>
                  <div style={{ flex: 1, height: '1px', background: 'var(--border-soft)' }} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                  {g.items.map(r => renderRow(r, rows.indexOf(r), false))}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ASK · IDLE (Sleepy face) */}
        {showAskFace && (
          <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '30px 40px 60px', textAlign: 'center' }}>
            <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', width: '200px', height: '168px', marginBottom: '18px', animation: 'sleepyBob 4.6s ease-in-out infinite' }}>
              <div style={{ position: 'absolute', width: '200px', height: '200px', borderRadius: '50%', background: 'radial-gradient(circle, rgba(123,104,238,0.30), transparent 66%)', animation: 'sleepyHaloPulse 5s ease-in-out infinite' }} />
              <div style={{ position: 'relative', display: 'flex', gap: '30px', marginBottom: '18px' }}>
                <span style={{ width: '27px', height: '40px', borderRadius: '14px', background: 'linear-gradient(180deg,#c4b6ff,#8b7bff)', boxShadow: '0 0 18px rgba(157,140,255,0.7)', animation: 'sleepyBlink 4.4s ease-in-out infinite' }} />
                <span style={{ width: '27px', height: '40px', borderRadius: '14px', background: 'linear-gradient(180deg,#c4b6ff,#8b7bff)', boxShadow: '0 0 18px rgba(157,140,255,0.7)', animation: 'sleepyBlink 4.4s ease-in-out infinite' }} />
              </div>
              <svg width="96" height="34" viewBox="0 0 96 34" fill="none" style={{ position: 'relative' }}><path d="M12 8 Q48 42 84 8" stroke="#9d8cff" strokeWidth="5" strokeLinecap="round" /></svg>
            </div>
            <h1 style={{ fontFamily: 'var(--font-family-display)', fontWeight: 700, fontSize: '24px', color: 'var(--text)', margin: '0 0 6px', letterSpacing: '-0.02em' }}>Ask Sleepy anything</h1>
            <p style={{ fontSize: '14.5px', color: 'var(--text-4)', margin: 0, maxWidth: '470px', lineHeight: 1.5 }}>A real Claude Code conversation that runs right here in your project — Sleepy reads your code and brain to answer, and remembers the thread until you reset it. It&rsquo;s read-only: it explains and plans, never changes your files.</p>
          </div>
        )}

        {/* ASK · CONVERSATION */}
        {showAskPanel && (
          <div style={{ padding: '24px 36px 40px', maxWidth: '840px', width: '100%', margin: '0 auto', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: '28px' }}>
            {thread.map(turn => (
              <div key={turn.id} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                {turn.question && (
                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <div style={{ maxWidth: '80%', padding: '11px 16px', borderRadius: '15px 15px 4px 15px', background: 'rgba(157,140,255,0.13)', border: '1px solid rgba(157,140,255,0.3)', color: 'var(--text)', fontSize: '14.5px', lineHeight: 1.45 }}>{turn.question}</div>
                  </div>
                )}
                <div style={{ display: 'flex', gap: '14px', alignItems: 'flex-start' }}>
                  <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: '4px', padding: '6px 8px', borderRadius: '9px', background: 'var(--bg-chip)', boxShadow: '0 0 0 1px var(--border)' }}>
                    <span style={{ width: '7px', height: '11px', borderRadius: '4px', background: 'linear-gradient(180deg,#c4b6ff,#8b7bff)' }} />
                    <span style={{ width: '7px', height: '11px', borderRadius: '4px', background: 'linear-gradient(180deg,#c4b6ff,#8b7bff)' }} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '9px', marginBottom: '9px' }}>
                      <span style={{ fontFamily: 'var(--font-family-display)', fontWeight: 700, fontSize: '13.5px', color: 'var(--text-1)' }}>Sleepy</span>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '2px 8px', borderRadius: '6px', background: 'rgba(157,140,255,0.12)', color: '#bcacff', fontFamily: 'var(--font-mono)', fontSize: '10px' }}><span style={{ width: '5px', height: '5px', borderRadius: '50%', background: '#9d8cff' }} />Claude Code · read-only</span>
                      {turn.streaming && (
                        <span style={{ display: 'flex', gap: '3px', alignItems: 'center' }}>
                          {[0, 0.2, 0.4].map((d, i) => <span key={i} style={{ width: '5px', height: '5px', borderRadius: '50%', background: '#9d8cff', animation: `sleepyLivePulse 1s ease-in-out infinite ${d}s` }} />)}
                        </span>
                      )}
                    </div>

                    {/* Tools Sleepy reached for (read-only) */}
                    {turn.tools.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '10px' }}>
                        {turn.tools.map(name => <span key={name} className="sleepy-tool-chip">{name}</span>)}
                      </div>
                    )}

                    {/* Live thinking trace */}
                    {turn.thinking && (
                      <div className="sleepy-think">
                        <div style={{ textTransform: 'uppercase', letterSpacing: '0.08em', fontSize: '9.5px', color: '#9d8cff', marginBottom: '5px' }}>Thinking</div>
                        {turn.thinking}
                      </div>
                    )}

                    {/* Answer (Markdown) — or a reading state before the first token */}
                    {turn.answer ? (
                      <div className="sleepy-doc-render" style={{ fontSize: '14.5px', lineHeight: 1.7, color: 'var(--text-2b)' }}>
                        <MarkdownPreview content={turn.answer} />
                      </div>
                    ) : turn.streaming && !turn.thinking ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        <div style={{ color: 'var(--text-4)', fontSize: '13.5px', marginBottom: '2px' }}>Sleepy is reading your project…</div>
                        {['96%', '88%', '62%'].map((w, li) => <span key={li} className="sleepy-shimmer" style={{ display: 'block', height: '11px', width: w, borderRadius: '6px' }} />)}
                      </div>
                    ) : null}

                    {turn.error && (
                      <div style={{ marginTop: '6px', padding: '10px 13px', borderRadius: '9px', background: 'rgba(248,81,73,0.08)', border: '1px solid rgba(248,81,73,0.28)', color: '#f8a39d', fontSize: '13px', fontFamily: 'var(--font-mono)', whiteSpace: 'pre-wrap' }}>{turn.error}</div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Composer — hidden in Agent mode (the terminal owns its own input) */}
      {!agentMode && (
      <div style={{ flex: '0 0 auto', padding: '12px 28px 16px', borderTop: '1px solid var(--border-soft)', background: 'linear-gradient(0deg, var(--bg-input), var(--bg-rail))' }}>
        <div style={{ maxWidth: '820px', margin: '0 auto' }}>
          {searchMode && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '11px', flexWrap: 'wrap' }}>
              {chipDefs.map(c => {
                const active = c.key === 'All' ? noFilter : types.includes(c.key as TypeLabel);
                return (
                  <div
                    key={c.key} onClick={() => toggleType(c.key)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 12px', borderRadius: '9px', cursor: 'pointer',
                      fontSize: '12.5px', fontWeight: 500, fontFamily: 'var(--font-family-text)', userSelect: 'none', transition: 'all .12s',
                      border: '1px solid ' + (active ? (c.color || '#9d8cff') : 'var(--border-2)'),
                      background: active ? softColor(c.color || '#9d8cff') : 'var(--bg-chip)',
                      color: active ? 'var(--text)' : 'var(--text-3)',
                    }}
                  >
                    {c.recall && <span style={{ color: active ? (c.color || '#9d8cff') : 'var(--text-4)', display: 'flex' }}><TypeIcon type={c.recall} size={13} color={active ? (c.color || '#9d8cff') : 'currentColor'} /></span>}
                    <span>{c.label}</span>
                  </div>
                );
              })}
              <div style={{ flex: 1, minWidth: '12px' }} />
              {/* Intelligent toggle — glowing, default off */}
              <div
                className={'sleepy-intel' + (intelligent ? ' sleepy-intel-on' : '')}
                onClick={toggleIntelligent}
                title={intelligent ? 'Intelligent search is on — Sleepy reasons over your brain (uses tokens)' : 'Turn on intelligent search — intent-aware, beyond keywords'}
              >
                <span className="sleepy-intel-dot" />
                <SparkIcon size={13} color={intelligent ? '#d9cfff' : 'currentColor'} />
                Intelligent
              </div>
              {hasResults && (
                <div style={{ display: 'flex', padding: '2px', background: 'var(--bg-input)', border: '1px solid var(--border-2)', borderRadius: '9px' }}>
                  <div onClick={() => setLayout('flat')} style={{ ...tabBase, ...(layout === 'flat' ? activeTab : idleTab) }}>Flat</div>
                  <div onClick={() => setLayout('grouped')} style={{ ...tabBase, ...(layout === 'grouped' ? activeTab : idleTab) }}>Grouped</div>
                </div>
              )}
            </div>
          )}

          {askMode && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '11px' }}>
              {/* Model tier — normal / intelligent. The real model name stays hidden. */}
              <div style={{ display: 'flex', padding: '2px', background: 'var(--bg-input)', border: '1px solid var(--border-2)', borderRadius: '9px' }}>
                <div onClick={() => setChatModel('normal')} style={{ ...tabBase, padding: '5px 13px', ...(chatModel === 'normal' ? activeTab : idleTab) }}>Normal</div>
                <div onClick={() => setChatModel('intelligent')} style={{ ...tabBase, padding: '5px 13px', display: 'flex', alignItems: 'center', gap: '5px', ...(chatModel === 'intelligent' ? activeTab : idleTab) }}><SparkIcon size={12} color={chatModel === 'intelligent' ? '#bcacff' : 'currentColor'} /> Intelligent</div>
              </div>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-6)' }}>{chatModel === 'intelligent' ? 'deeper reasoning' : 'fast answers'}</span>
            </div>
          )}

          {/* input pill */}
          <div style={{ position: 'relative' }}>
            <span style={{ position: 'absolute', left: '18px', top: '50%', transform: 'translateY(-50%)', display: 'flex', color: inputAccent ? '#9d8cff' : 'var(--text-4)', pointerEvents: 'none' }}>{askMode ? <SparkIcon size={18} /> : <SearchIcon size={18} />}</span>
            <input
              className="sleepy-input" ref={inputRef} value={q}
              onChange={e => onChangeQuery(e.target.value)}
              onKeyDown={onKey}
              placeholder={askMode ? 'Ask Sleepy anything about this project…' : intelliMode ? "Describe what you're after — Sleepy reasons it out…" : "Search this project's brain…"}
              spellCheck={false}
              style={{ width: '100%', height: '52px', padding: '0 116px 0 50px', borderRadius: '14px', border: '1px solid ' + inputBorder, background: 'var(--bg-input)', color: 'var(--text)', fontSize: '16px', fontFamily: 'var(--font-family-text)', outline: 'none', boxShadow: inputGlow, transition: 'border-color .15s, box-shadow .15s' }}
            />
            <div style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', display: 'flex', gap: '7px', alignItems: 'center' }}>
              {askMode ? (
                <span onClick={() => void submitAsk()} title="Ask Sleepy" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px', height: '36px', padding: '0 15px', borderRadius: '10px', cursor: 'pointer', background: 'linear-gradient(150deg,#8b7bff,#6f5ce0)', color: '#fff', fontSize: '12.5px', fontWeight: 600, boxShadow: '0 4px 12px -4px rgba(123,104,238,0.85)' }}>Ask <span style={{ fontSize: '13px' }}>↵</span></span>
              ) : intelliMode && !intelliReady && hasQuery ? (
                <span onClick={() => void runIntelliSearch()} title="Run intelligent search" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px', height: '36px', padding: '0 14px', borderRadius: '10px', cursor: 'pointer', background: 'linear-gradient(150deg,#8b7bff,#6f5ce0)', color: '#fff', fontSize: '12.5px', fontWeight: 600, boxShadow: '0 4px 12px -4px rgba(123,104,238,0.85)' }}><SparkIcon size={13} color="#fff" /> <span style={{ fontSize: '13px' }}>↵</span></span>
              ) : (
                <span style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '4px 8px', borderRadius: '7px', background: 'var(--bg-chip)', border: '1px solid var(--border-2)', fontSize: '10px', color: 'var(--text-6)', fontFamily: 'var(--font-mono)' }}>⌘K</span>
              )}
            </div>
          </div>

          {/* hint */}
          <div style={{ marginTop: '9px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px', fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-7)' }}>
            {askMode ? (
              <>
                <span style={{ color: '#9d8cff' }}>real Claude Code</span>
                <span style={{ color: 'var(--text-5)' }}>in your project</span><span style={{ color: 'var(--border-3)' }}>·</span>
                <span style={{ color: '#56d364' }}>read-only · remembers the thread</span>
              </>
            ) : intelliMode ? (
              <>
                <span><span style={{ color: 'var(--text-5)' }}>↵</span> run</span><span style={{ color: 'var(--border-3)' }}>·</span>
                <span style={{ color: '#b98bff' }}>intelligent</span>
                <span style={{ color: 'var(--text-5)' }}>reasons over your brain</span><span style={{ color: 'var(--border-3)' }}>·</span>
                <span style={{ color: 'var(--text-5)' }}>uses tokens</span>
              </>
            ) : (
              <>
                <span><span style={{ color: 'var(--text-5)' }}>↑↓</span> move</span><span style={{ color: 'var(--border-3)' }}>·</span>
                <span><span style={{ color: 'var(--text-5)' }}>↵</span> open</span><span style={{ color: 'var(--border-3)' }}>·</span>
                <span style={{ color: '#56d364' }}>local · instant · no tokens</span>
              </>
            )}
          </div>
        </div>
      </div>
      )}

      {/* Doc side panel */}
      {doc && (
        <>
          <div onClick={closeDoc} style={{ position: 'absolute', inset: 0, background: 'rgba(8,10,14,0.55)', zIndex: 30 }} />
          <div style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: '472px', background: 'var(--bg-panel)', borderLeft: '1px solid var(--border-panel)', boxShadow: '-26px 0 64px -22px rgba(0,0,0,0.75)', zIndex: 31, display: 'flex', flexDirection: 'column', animation: 'sleepyPanelIn .22s cubic-bezier(.2,.8,.2,1)' }}>
            {(() => {
              const meta = TYPE_META[RECALL_TO_LABEL[doc.type] ?? 'Knowledge'];
              const label = RECALL_TO_LABEL[doc.type] ?? 'Knowledge';
              return (
                <>
                  <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'flex-start', gap: '13px', padding: '20px 20px 16px', borderBottom: '1px solid var(--border)' }}>
                    <div style={{ flex: '0 0 auto', width: '34px', height: '34px', borderRadius: '9px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: meta.color, backgroundColor: softColor(meta.color), border: '1px solid ' + softColor(meta.color, 0.25) }}><TypeIcon type={doc.type} size={16} color={meta.color} /></div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ marginBottom: '6px' }}><span style={{ fontFamily: 'var(--font-mono)', fontSize: '9.5px', textTransform: 'uppercase', letterSpacing: '0.06em', padding: '2px 7px', borderRadius: '5px', color: meta.color, background: softColor(meta.color) }}>{label}</span></div>
                      <div style={{ fontFamily: 'var(--font-family-display)', fontWeight: 700, fontSize: '16.5px', color: 'var(--text)', letterSpacing: '-0.01em', lineHeight: 1.3 }}>{doc.title}</div>
                      <div style={{ fontFamily: 'var(--font-mono)', fontSize: '11.5px', color: 'var(--text-6)', marginTop: '6px' }}>{doc.path}</div>
                    </div>
                    <span onClick={closeDoc} title="Close" style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', justifyContent: 'center', width: '28px', height: '28px', borderRadius: '8px', cursor: 'pointer', color: 'var(--text-4)', fontSize: '15px' }}>✕</span>
                  </div>
                  <div className="sleepy-doc-body" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '20px' }}>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.09em', color: '#9d8cff', marginBottom: '9px' }}>Relevant chunk</div>
                    <div style={{ padding: '13px 15px', borderRadius: '10px', background: 'rgba(157,140,255,0.07)', border: '1px solid rgba(157,140,255,0.2)', borderLeft: '3px solid #9d8cff', fontSize: '14px', lineHeight: 1.6, color: 'var(--text-1)', marginBottom: '26px' }}>{highlight(doc.snippet || doc.description, docTokens)}</div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.09em', color: 'var(--text-6)', marginBottom: '12px' }}>Document</div>
                    <div className="sleepy-doc-render">{<DocContent hit={doc} />}</div>
                  </div>
                  <div style={{ flex: '0 0 auto', padding: '13px 20px', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-6)' }}>local · grounded</span>
                    <span onClick={openFullDoc} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '7px 13px', borderRadius: '9px', background: 'rgba(157,140,255,0.12)', color: '#bcacff', fontSize: '12.5px', fontWeight: 600, cursor: 'pointer' }}>Open full document <span style={{ fontSize: '13px' }}>↗</span></span>
                  </div>
                </>
              );
            })()}
          </div>
        </>
      )}
    </div>
  );
}
