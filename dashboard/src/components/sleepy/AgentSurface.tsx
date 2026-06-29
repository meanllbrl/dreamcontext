import {
  useEffect, useRef, useState, useReducer, useCallback, useLayoutEffect,
  useSyncExternalStore, type CSSProperties,
} from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import './AgentTerminal.css';
import { api, getActiveVault } from '../../api/client';

/**
 * Agent — the REAL interactive Claude Code, in-app, now MULTI-SESSION. Each session
 * is a server-side `node-pty` running `claude` in the active vault, bridged to a
 * GPU-rendered xterm. Sessions are organised as TABS, and any tab can be SPLIT into
 * side-by-side panes (Cmd+D, or drag one tab onto another / onto the terminal area).
 *
 * ── Why an imperative session manager ────────────────────────────────────────
 * A pane's xterm + WebSocket + running `claude` must survive (a) switching tabs,
 * (b) being dragged into a split, and (c) navigating to another page and back. If
 * panes were plain React children, any of those would reparent the node and remount
 * — destroying scrollback and the live session. So each session owns a DETACHED DOM
 * container (created with `document.createElement`, never React-rendered); the
 * layout effect just `appendChild`s that container into whichever pane slot is
 * active and parks the rest in a hidden garage. Moving a raw DOM node never remounts
 * xterm. The whole surface is mounted ONCE (App.tsx), outside the page router, so
 * nothing tears down on navigation — only on explicit close or app quit.
 *
 * Desktop-only and capability-gated. Bypass-permissions is OFF by default (armed
 * explicitly); a standing banner shows while any visible pane is armed.
 */

interface Capabilities {
  desktop: boolean;
  platform: string;
  embeddedTerminal: boolean;
  openTerminal: boolean;
  // Prerequisite breakdown (drives the in-app Setup panel).
  nodePty: boolean;
  claudeCli: boolean;
  npm: boolean;
}

type TermStatus = 'connecting' | 'open' | 'closed';
const ACCENT = '#8b7bff';

// A destructive action that needs the user's explicit OK before it runs. Surfaced as
// a native-style confirmation sheet over the terminal; only raised for LIVE sessions
// (an already-ended session is closed instantly, never nags).
type ConfirmTone = 'danger' | 'accent';
interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel: string;
  tone: ConfirmTone;
  onConfirm: () => void;
}

// ── Slot registry ─────────────────────────────────────────────────────────────
// SleepyPage's Agent tab publishes its anchor here; the persistent surface snaps
// itself over the anchor's rect. Decouples the two without prop-drilling.

let slotEl: HTMLElement | null = null;
const slotListeners = new Set<() => void>();
function emitSlot() { for (const fn of slotListeners) fn(); }
function setAgentSlot(el: HTMLElement | null) {
  if (slotEl === el) return;
  slotEl = el;
  emitSlot();
}
function subscribeSlot(fn: () => void): () => void {
  slotListeners.add(fn);
  return () => { slotListeners.delete(fn); };
}

export function AgentSlot() {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    setAgentSlot(ref.current);
    return () => setAgentSlot(null);
  }, []);
  return <div ref={ref} className="agent-slot" aria-hidden />;
}

// ── Theme ──────────────────────────────────────────────────────────────────────

function readXtermTheme(): ITheme {
  const cs = getComputedStyle(document.body);
  const g = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  const bg = g('--color-bg', '#14171f');
  const text = g('--color-text', '#f5f6fa');
  const accent = g('--color-accent', '#9d8cff');
  // The 16 ANSI slots must keep conventional luminance ordering (0 = darkest →
  // 15 = lightest) REGARDLESS of theme. The old mapping wired black/white/brightBlack
  // straight to design tokens, which inverted them in light mode (black→#e9ebf0,
  // white→#646464) and made the dim grays too light in dark mode — so when Claude's
  // TUI fills a region with ANSI 7/8 as a background, the foreground collapsed to
  // same-luminance-on-same-luminance (the unreadable pale blocks). The grayscale ramp
  // is tuned per-theme so background fills BLEND with the surface; foreground
  // readability on any pairing is then guaranteed by `minimumContrastRatio` below.
  const isLight = currentTermTheme() === 'light';
  const ramp = isLight
    ? { black: '#292d34', brightBlack: '#646464', white: '#e9ebf0', brightWhite: '#ffffff' }
    : { black: '#20242e', brightBlack: '#3b4151', white: '#c8ccd9', brightWhite: '#f5f6fa' };
  return {
    background: bg,
    foreground: text,
    cursor: accent,
    cursorAccent: bg,
    selectionBackground: g('--color-accent-soft', 'rgba(157,140,255,0.30)'),
    selectionForeground: text,
    black: ramp.black,
    red: g('--color-error', '#ff5a5f'),
    green: g('--color-success', '#4ade80'),
    yellow: g('--color-warning', '#ffae3b'),
    blue: '#5b9dff',
    magenta: accent,
    cyan: '#3bd6c6',
    white: ramp.white,
    brightBlack: ramp.brightBlack,
    brightRed: '#ff7a7f',
    brightGreen: '#6ee7a0',
    brightYellow: '#ffc46b',
    brightBlue: '#8bbcff',
    brightMagenta: accent,
    brightCyan: '#6fe3d6',
    brightWhite: ramp.brightWhite,
  };
}

// ── Theme detection / colour reporting (so Claude themes to our surface) ────────

function resolveRgb(cssColor: string): [number, number, number] | null {
  if (!cssColor) return null;
  const probe = document.createElement('span');
  probe.style.color = cssColor;
  probe.style.display = 'none';
  document.body.appendChild(probe);
  const c = getComputedStyle(probe).color;
  document.body.removeChild(probe);
  const m = /rgba?\(([0-9.]+),\s*([0-9.]+),\s*([0-9.]+)/.exec(c);
  return m ? [Math.round(+m[1]), Math.round(+m[2]), Math.round(+m[3])] : null;
}
function toXtermRgb([r, g, b]: [number, number, number]): string {
  const h = (v: number) => ((v * 257) & 0xffff).toString(16).padStart(4, '0');
  return `rgb:${h(r)}/${h(g)}/${h(b)}`;
}
function tokenRgb(varName: string, fallback: string): [number, number, number] | null {
  const v = getComputedStyle(document.body).getPropertyValue(varName).trim() || fallback;
  return resolveRgb(v);
}
function currentTermTheme(): 'light' | 'dark' {
  const bg = tokenRgb('--color-bg', '#14171f');
  if (!bg) return 'dark';
  const lum = 0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2];
  return lum > 140 ? 'light' : 'dark';
}

// ── Session manager (imperative; one PTY ↔ ws ↔ xterm per session) ──────────────

interface Session {
  id: string;
  bypass: boolean;
  container: HTMLDivElement;
  term: Terminal;
  fit: FitAddon;
  ws: WebSocket;
  status: TermStatus;
  opened: boolean;
  ensureOpen: () => void;
  fitAndResize: () => void;
  dispose: () => void;
}

let sessionSeq = 0;

function createSession(bypass: boolean, onStatus: () => void): Session {
  const id = `agent-${++sessionSeq}`;
  const container = document.createElement('div');
  container.className = 'agent-pane-term';

  const fontFamily = getComputedStyle(document.body).getPropertyValue('--font-mono').trim()
    || "'Sometype Mono', 'JetBrains Mono', ui-monospace, Menlo, monospace";

  const term = new Terminal({
    fontFamily,
    fontSize: 13.5,
    lineHeight: 1.4,
    letterSpacing: 0,
    cursorBlink: true,
    cursorStyle: 'bar',
    fontWeightBold: '600',
    theme: readXtermTheme(),
    allowProposedApi: true,
    scrollback: 5000,
    // AA contrast floor: xterm auto-lifts any foreground that falls too close to its
    // actual cell background. Without this (was 1 = off), Claude's TUI blocks that pair
    // a default foreground with an ANSI 7/8 background fill rendered as unreadable
    // same-on-same text in BOTH themes. Readability beats exact brand-colour fidelity.
    minimumContrastRatio: 4.5,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());

  const themeObserver = new MutationObserver(() => { term.options.theme = readXtermTheme(); });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
  themeObserver.observe(document.body, { attributes: true, attributeFilter: ['data-theme', 'class'] });

  const vault = getActiveVault();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const theme = currentTermTheme();
  const url = `${proto}://${location.host}/api/agent/terminal?vault=${encodeURIComponent(vault ?? '')}&bypass=${bypass ? '1' : '0'}&theme=${theme}`;
  const ws = new WebSocket(url);

  const session: Session = {
    id, bypass, container, term, fit, ws,
    status: 'connecting', opened: false,
    ensureOpen, fitAndResize, dispose,
  };

  function setStatus(s: TermStatus) { session.status = s; onStatus(); }

  function fitAndResize() {
    if (!session.opened) return;
    try { fit.fit(); } catch { return; }
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    }
  }

  // Answer the TUI's foreground/background colour queries (OSC 10/11) with our live
  // tokens so Claude themes itself to our surface. SET requests fall through.
  const replyColor = (osc: number, varName: string, fallback: string) =>
    term.parser.registerOscHandler(osc, (data) => {
      if (data !== '?') return false;
      const rgb = tokenRgb(varName, fallback);
      if (rgb && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data: `\x1b]${osc};${toXtermRgb(rgb)}\x07` }));
      }
      return true;
    });
  const oscFg = replyColor(10, '--color-text', '#f5f6fa');
  const oscBg = replyColor(11, '--color-bg', '#14171f');

  ws.onopen = () => { setStatus('open'); fitAndResize(); };
  ws.onmessage = (ev) => { term.write(typeof ev.data === 'string' ? ev.data : ''); };
  ws.onclose = () => setStatus('closed');
  ws.onerror = () => setStatus('closed');

  const dataSub = term.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }));
  });

  // Open only once the container is in the DOM (it starts detached) AND the mono
  // webfont is ready, so the GPU canvas measures the real glyph width. WebGL is
  // attached after open; on context loss we revert to xterm's DOM renderer.
  function ensureOpen() {
    if (session.opened || !container.isConnected) return;
    const doOpen = () => {
      // Must be connected AND visible (offsetParent is null while parked in the
      // hidden garage) — opening on a 0-size node would mis-measure the grid. If
      // hidden now, a later ensureOpen (when the pane is shown) will open it.
      if (session.opened || !container.isConnected || container.offsetParent === null) return;
      term.open(container);
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => { try { webgl.dispose(); } catch { /* gone */ } });
        term.loadAddon(webgl);
      } catch { /* WebGL unavailable — keep DOM renderer */ }
      session.opened = true;
      fitAndResize();
      // One more recompute next frame: the WebGL glyph atlas can latch a stale
      // (fallback-font) cell width on first paint, making text look thin/stretched.
      // Re-applying the font + refit forces it to rebuild with the real metrics.
      requestAnimationFrame(() => {
        if (session.opened) {
          term.options.fontFamily = fontFamily;
          fitAndResize();
        }
      });
      term.focus();
    };
    // Measure with the EXACT mono font (both weights) actually loaded — otherwise
    // xterm builds its cell metrics from a wider fallback advance and every glyph
    // renders thin inside an over-wide cell.
    const fonts = document.fonts;
    if (fonts?.load) {
      Promise.all([
        fonts.load('13.5px "Sometype Mono"'),
        fonts.load('600 13.5px "Sometype Mono"'),
      ]).then(() => fonts.ready).then(doOpen).catch(doOpen);
    } else doOpen();
  }

  function dispose() {
    themeObserver.disconnect();
    dataSub.dispose();
    oscFg.dispose();
    oscBg.dispose();
    try { ws.close(); } catch { /* already closing */ }
    term.dispose();
    container.remove();
  }

  return session;
}

// ── Layout model ────────────────────────────────────────────────────────────────

interface Tab {
  id: string;
  title: string;
  panes: string[];   // session ids, shown left→right
  sizes: number[];   // flex-grow weights, one per pane
}

let tabSeq = 0;
const newTabId = () => `tab-${++tabSeq}`;
const DRAG_MIME = 'application/x-agent-tab';

// ── The persistent surface ─────────────────────────────────────────────────────

export function AgentSurface() {
  const slot = useSyncExternalStore(subscribeSlot, () => slotEl, () => null);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [capsError, setCapsError] = useState(false);
  const [bypass, setBypass] = useState(false); // default for NEW sessions
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState('');
  const [focusedSid, setFocusedSid] = useState('');
  const [dragTabId, setDragTabId] = useState('');
  const [dropTarget, setDropTarget] = useState(''); // tab id or '__panes__'
  const [, bumpStatus] = useReducer((x: number) => x + 1, 0);
  // A pending destructive confirmation (close/restart a live session), or null.
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  // The tab whose title is being edited inline (double-click to rename), or ''.
  const [renamingId, setRenamingId] = useState('');

  const sessions = useRef<Map<string, Session>>(new Map());
  const slotRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const garageRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);

  const started = tabs.length > 0;
  const activeTab = tabs.find(t => t.id === activeTabId) ?? null;

  // ── Capabilities (fetched on mount; re-fetched after an in-app install so a
  //    freshly-installed prerequisite flips to ready without an app relaunch) ────
  const refreshCaps = useCallback(async (): Promise<Capabilities | null> => {
    try { const c = await api.get<Capabilities>('/agent/capabilities'); setCaps(c); return c; }
    catch { setCapsError(true); return null; }
  }, []);
  useEffect(() => { void refreshCaps(); }, [refreshCaps]);

  // ── Session/tab actions ──────────────────────────────────────────────────────
  const spawn = useCallback(() => {
    const s = createSession(bypass, bumpStatus);
    sessions.current.set(s.id, s);
    return s;
  }, [bypass]);

  const startFirst = useCallback(() => {
    const s = spawn();
    const id = newTabId();
    setTabs([{ id, title: `Agent ${tabSeq}`, panes: [s.id], sizes: [1] }]);
    setActiveTabId(id);
    setFocusedSid(s.id);
  }, [spawn]);

  const openTab = useCallback(() => {
    const s = spawn();
    const id = newTabId();
    setTabs(prev => [...prev, { id, title: `Agent ${tabSeq}`, panes: [s.id], sizes: [1] }]);
    setActiveTabId(id);
    setFocusedSid(s.id);
  }, [spawn]);

  const splitActive = useCallback(() => {
    if (!activeTab) return;
    const s = spawn();
    setTabs(prev => prev.map(t => t.id === activeTab.id
      ? { ...t, panes: [...t.panes, s.id], sizes: [...t.sizes, 1] }
      : t));
    setFocusedSid(s.id);
  }, [activeTab, spawn]);

  const closePane = useCallback((tabId: string, sid: string) => {
    sessions.current.get(sid)?.dispose();
    sessions.current.delete(sid);
    const next: Tab[] = [];
    for (const t of tabs) {
      if (t.id !== tabId) { next.push(t); continue; }
      const i = t.panes.indexOf(sid);
      if (i === -1) { next.push(t); continue; }
      const panes = t.panes.filter(p => p !== sid);
      const sizes = t.sizes.filter((_, k) => k !== i);
      if (panes.length) next.push({ ...t, panes, sizes }); // empty tab → dropped
    }
    setTabs(next);
    if (!next.some(t => t.id === activeTabId)) setActiveTabId(next[next.length - 1]?.id ?? '');
  }, [tabs, activeTabId]);

  const closeTab = useCallback((tabId: string) => {
    tabs.find(x => x.id === tabId)?.panes.forEach(sid => {
      sessions.current.get(sid)?.dispose();
      sessions.current.delete(sid);
    });
    const next = tabs.filter(x => x.id !== tabId);
    setTabs(next);
    if (activeTabId === tabId) setActiveTabId(next[next.length - 1]?.id ?? '');
  }, [tabs, activeTabId]);

  const restartPane = useCallback((tabId: string, sid: string) => {
    const old = sessions.current.get(sid);
    const s = spawn();
    setTabs(prev => prev.map(t => t.id === tabId
      ? { ...t, panes: t.panes.map(p => p === sid ? s.id : p) }
      : t));
    setFocusedSid(s.id);
    old?.dispose();
    sessions.current.delete(sid);
  }, [spawn]);

  // ── Guarded (confirmed) destructive actions ───────────────────────────────────
  // A session is "live" while its PTY is open (claude still running). Closing or
  // restarting a live session would kill an in-flight task, so we ask first. An
  // already-ended session ('closed') is torn down instantly — no nag.
  const isLive = useCallback((sid: string) => sessions.current.get(sid)?.status === 'open', []);
  const liveCount = useCallback((sids: string[]) => sids.filter(isLive).length, [isLive]);

  const commitRename = useCallback((id: string, raw: string) => {
    const title = raw.trim();
    setRenamingId('');
    if (title) setTabs(prev => prev.map(t => (t.id === id ? { ...t, title } : t)));
  }, []);

  const askClosePane = useCallback((tabId: string, sid: string) => {
    if (!isLive(sid)) { closePane(tabId, sid); return; }
    const multi = (tabs.find(t => t.id === tabId)?.panes.length ?? 1) > 1;
    setConfirm({
      title: multi ? 'End this pane’s session?' : 'End this session?',
      message: 'Claude is still working here. Ending it stops the current task — anything mid-flight won’t be finished.',
      confirmLabel: 'End session',
      tone: 'danger',
      onConfirm: () => closePane(tabId, sid),
    });
  }, [tabs, isLive, closePane]);

  const askCloseTab = useCallback((tabId: string) => {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;
    const live = liveCount(tab.panes);
    if (live === 0) { closeTab(tabId); return; }
    setConfirm({
      title: live > 1 ? `End this tab’s ${live} sessions?` : 'End this session?',
      message: live > 1
        ? `${live} Claude sessions are still running in this tab. Closing it stops all of them.`
        : 'Claude is still working in this tab. Closing it stops the current task.',
      confirmLabel: live > 1 ? 'End tab' : 'End session',
      tone: 'danger',
      onConfirm: () => closeTab(tabId),
    });
  }, [tabs, liveCount, closeTab]);

  const askRestart = useCallback((tabId: string, sid: string) => {
    if (!isLive(sid)) { restartPane(tabId, sid); return; }
    setConfirm({
      title: 'Restart this session?',
      message: 'The current Claude session will be stopped and a fresh one started in its place.',
      confirmLabel: 'Restart',
      tone: 'accent',
      onConfirm: () => restartPane(tabId, sid),
    });
  }, [isLive, restartPane]);

  // Merge one tab's panes into another (the drag-to-split / drag-to-combine path).
  const mergeTab = useCallback((sourceId: string, targetId: string) => {
    if (sourceId === targetId) return;
    const src = tabs.find(t => t.id === sourceId);
    const tgt = tabs.find(t => t.id === targetId);
    if (!src || !tgt) return;
    setTabs(tabs
      .filter(t => t.id !== sourceId)
      .map(t => t.id === targetId
        ? { ...t, panes: [...t.panes, ...src.panes], sizes: [...t.sizes, ...src.sizes] }
        : t));
    setActiveTabId(targetId);
  }, [tabs]);

  // ── Place detached session containers into the active layout ──────────────────
  // Also (re)tries ensureOpen for visible panes: the layout effect may call
  // ensureOpen while the surface is still display:none (offsetParent null) — e.g.
  // when document.fonts.ready is already settled, doOpen runs as a microtask before
  // the positioning effect reveals the surface, so term.open() is skipped. This runs
  // from the positioning effect's sync() right AFTER display:flex is set, so the
  // container is visible and the open succeeds. Idempotent once opened.
  const fitVisible = useCallback(() => {
    activeTab?.panes.forEach(sid => {
      const s = sessions.current.get(sid);
      if (!s) return;
      s.ensureOpen();
      s.fitAndResize();
    });
  }, [activeTab]);

  useLayoutEffect(() => {
    const activeSet = new Set(activeTab?.panes ?? []);
    activeTab?.panes.forEach(sid => {
      const s = sessions.current.get(sid);
      const host = slotRefs.current.get(sid);
      if (s && host) {
        if (s.container.parentElement !== host) host.appendChild(s.container);
        s.ensureOpen();
      }
    });
    // Park everything not currently visible in the hidden garage (keeps it alive).
    sessions.current.forEach(s => {
      if (!activeSet.has(s.id) && garageRef.current && s.container.parentElement !== garageRef.current) {
        garageRef.current.appendChild(s.container);
      }
    });
    const raf = requestAnimationFrame(fitVisible);
    return () => cancelAnimationFrame(raf);
  }, [tabs, activeTabId, activeTab, fitVisible]);

  // ── Position the fixed surface over the active slot (persistence) ─────────────
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (!slot) { host.style.display = 'none'; return; }

    const sync = () => {
      const r = slot.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) { host.style.display = 'none'; return; }
      host.style.display = 'flex';
      host.style.top = `${r.top}px`;
      host.style.left = `${r.left}px`;
      host.style.width = `${r.width}px`;
      host.style.height = `${r.height}px`;
      fitVisible();
    };
    sync();
    const raf = requestAnimationFrame(sync);
    const ro = new ResizeObserver(sync);
    ro.observe(slot);
    ro.observe(document.documentElement);
    window.addEventListener('resize', sync);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('resize', sync);
    };
  }, [slot, fitVisible]);

  // ── Keyboard: Cmd/Ctrl+D split · Cmd/Ctrl+T new tab · Cmd/Ctrl+W close ────────
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !started) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'd') { e.preventDefault(); e.stopPropagation(); splitActive(); }
      else if (k === 't') { e.preventDefault(); e.stopPropagation(); openTab(); }
      else if (k === 'w') {
        e.preventDefault(); e.stopPropagation();
        if (focusedSid && activeTab?.panes.includes(focusedSid)) askClosePane(activeTab.id, focusedSid);
        else if (activeTab) askCloseTab(activeTab.id);
      }
    };
    host.addEventListener('keydown', onKey, true);
    return () => host.removeEventListener('keydown', onKey, true);
  }, [started, splitActive, openTab, askClosePane, askCloseTab, focusedSid, activeTab]);

  // ── Divider drag (resize split panes) ─────────────────────────────────────────
  const startResize = (tabId: string, index: number, ev: React.PointerEvent) => {
    ev.preventDefault();
    const tab = tabs.find(t => t.id === tabId);
    const row = (ev.currentTarget as HTMLElement).parentElement;
    if (!tab || !row) return;
    const total = row.getBoundingClientRect().width;
    const startX = ev.clientX;
    const a = tab.sizes[index], b = tab.sizes[index + 1];
    const sum = a + b;
    const onMove = (m: PointerEvent) => {
      const dx = m.clientX - startX;
      const ratio = Math.max(0.12, Math.min(0.88, (a + (dx / total) * sum) / sum));
      setTabs(prev => prev.map(t => {
        if (t.id !== tabId) return t;
        const sizes = [...t.sizes];
        sizes[index] = ratio * sum;
        sizes[index + 1] = (1 - ratio) * sum;
        return { ...t, sizes };
      }));
      fitVisible();
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      fitVisible();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const openExternal = async () => {
    try { await api.post('/agent/open-terminal', { bypass }); }
    catch (e) { alert(e instanceof Error ? e.message : 'Could not open Terminal.'); }
  };

  // ── Body ──────────────────────────────────────────────────────────────────────
  let body: React.ReactNode;
  if (capsError) {
    body = <Centered>
      <h2 style={titleStyle}>Agent unavailable</h2>
      <p style={subStyle}>Couldn't reach the agent service. Try reloading the app.</p>
    </Centered>;
  } else if (!caps) {
    body = <Centered><p style={{ ...subStyle, color: 'var(--color-text-tertiary)' }}>Checking agent capabilities…</p></Centered>;
  } else if (!caps.desktop) {
    body = <Centered>
      <BotMark />
      <h2 style={titleStyle}>Agent runs in the desktop app</h2>
      <p style={subStyle}>The in-app Claude Code agent is a desktop-only feature — it runs a real, interactive Claude Code session scoped to this project. Use <strong>Ask</strong> here for read-only questions.</p>
    </Centered>;
  } else if (started && caps.embeddedTerminal) {
    body = (
      <div className="agent-term">
        {/* Tab strip — drag a tab onto another (or the terminal) to split. */}
        <div className="agent-tabbar">
          {tabs.map(tab => {
            const active = tab.id === activeTabId;
            const renaming = renamingId === tab.id;
            return (
              <div
                key={tab.id}
                ref={(el) => { if (active && el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }}
                className={'agent-tab' + (active ? ' active' : '') + (dropTarget === tab.id ? ' drop' : '') + (dragTabId === tab.id ? ' dragging' : '')}
                draggable={!renaming}
                onClick={() => { setActiveTabId(tab.id); }}
                onDoubleClick={(e) => { e.stopPropagation(); setRenamingId(tab.id); }}
                // Middle-click closes the tab — native browser/terminal-tab muscle memory.
                onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); askCloseTab(tab.id); } }}
                onDragStart={(e) => { e.dataTransfer.setData(DRAG_MIME, tab.id); e.dataTransfer.effectAllowed = 'move'; setDragTabId(tab.id); }}
                onDragEnd={() => { setDragTabId(''); setDropTarget(''); }}
                // Gate on the drag payload type (available during dragover), NOT React
                // state — else preventDefault can miss on the first hover and the drop
                // never fires. preventDefault here is what makes the tab a drop zone.
                onDragOver={(e) => { if (e.dataTransfer.types.includes(DRAG_MIME)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dragTabId !== tab.id && dropTarget !== tab.id) setDropTarget(tab.id); } }}
                onDragLeave={() => setDropTarget(t => t === tab.id ? '' : t)}
                onDrop={(e) => { e.preventDefault(); const src = e.dataTransfer.getData(DRAG_MIME); setDropTarget(''); setDragTabId(''); if (src) mergeTab(src, tab.id); }}
                title={renaming ? undefined : `${tab.panes.length > 1 ? `${tab.title} · ${tab.panes.length} panes` : tab.title} — double-click to rename`}
              >
                <span className="agent-tab-dot" data-status={tabStatus(tab, sessions.current)} />
                {renaming ? (
                  <input
                    className="agent-tab-rename"
                    autoFocus
                    defaultValue={tab.title}
                    spellCheck={false}
                    onFocus={(e) => e.currentTarget.select()}
                    onClick={(e) => e.stopPropagation()}
                    onMouseDown={(e) => e.stopPropagation()}
                    onBlur={(e) => commitRename(tab.id, e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); commitRename(tab.id, e.currentTarget.value); }
                      else if (e.key === 'Escape') { e.preventDefault(); setRenamingId(''); }
                    }}
                  />
                ) : (
                  <span className="agent-tab-label">{tab.title}{tab.panes.length > 1 ? ` ·${tab.panes.length}` : ''}</span>
                )}
                <span
                  className="agent-tab-x"
                  title="Close tab (⌘W)"
                  role="button"
                  aria-label={`Close ${tab.title}`}
                  onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
                  onClick={(e) => { e.stopPropagation(); askCloseTab(tab.id); }}
                >✕</span>
              </div>
            );
          })}
          <button className="agent-tab-add" title="New session (⌘T)" onClick={openTab}>+</button>
          <div style={{ flex: 1 }} />
          <button className="agent-icon-btn" title="Split (⌘D)" onClick={splitActive}>⊟</button>
          <BypassPill bypass={bypass} setBypass={setBypass} />
        </div>

        {/* Active tab's panes (split row). Drop a dragged tab here to merge it in. */}
        <div
          className={'agent-panes' + (dropTarget === '__panes__' ? ' drop' : '')}
          onDragOver={(e) => { if (e.dataTransfer.types.includes(DRAG_MIME)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dropTarget !== '__panes__') setDropTarget('__panes__'); } }}
          onDragLeave={() => setDropTarget(t => t === '__panes__' ? '' : t)}
          onDrop={(e) => { e.preventDefault(); const src = e.dataTransfer.getData(DRAG_MIME); setDropTarget(''); setDragTabId(''); if (src && activeTabId) mergeTab(src, activeTabId); }}
        >
          {activeTab?.panes.map((sid, i) => {
            const s = sessions.current.get(sid);
            const multi = (activeTab.panes.length ?? 1) > 1;
            return (
              <PaneFragment
                key={sid}
                sid={sid}
                grow={activeTab.sizes[i] ?? 1}
                multi={multi}
                last={i === activeTab.panes.length - 1}
                label={`Claude ·${i + 1}`}
                status={s?.status ?? 'connecting'}
                bypassOn={!!s?.bypass}
                focused={focusedSid === sid}
                slotRefs={slotRefs}
                onFocusPane={() => { setFocusedSid(sid); s?.term.focus(); }}
                onClose={() => askClosePane(activeTab.id, sid)}
                onRestart={() => askRestart(activeTab.id, sid)}
                onResizeStart={(e) => startResize(activeTab.id, i, e)}
              />
            );
          })}
        </div>

        {/* Garage — keeps backgrounded sessions mounted & alive (never visible). */}
        <div ref={garageRef} className="agent-garage" aria-hidden />
      </div>
    );
  } else {
    body = (
      <Centered>
        <BotMark />
        <h2 style={titleStyle}>Agent — real Claude Code</h2>
        <p style={subStyle}>
          A full interactive Claude Code session running right here, scoped to this project.
          Open as many as you need — <strong>tabs</strong> and side-by-side <strong>splits</strong>
          (⌘D, or drag one tab onto another).
        </p>
        <BypassToggle bypass={bypass} setBypass={setBypass} />
        {(() => {
          // The embedded terminal is usable only when BOTH its renderer (node-pty)
          // and the `claude` binary it spawns are present. Missing either → show the
          // in-app Setup panel rather than silently spawning a shell that 404s claude.
          const ready = caps.embeddedTerminal && caps.claudeCli;
          return (
            <>
              <div style={{ display: 'flex', gap: '12px', marginTop: '22px', flexWrap: 'wrap', justifyContent: 'center' }}>
                {ready && (
                  <button onClick={startFirst} style={primaryBtn}>▸ Start agent in app</button>
                )}
                {caps.openTerminal && (
                  <button onClick={openExternal} style={ready ? secondaryBtn : primaryBtn}>↗ Open in Terminal</button>
                )}
              </div>
              {!ready && <Prereqs caps={caps} onRefresh={refreshCaps} />}
            </>
          );
        })()}
      </Centered>
    );
  }

  return (
    <div ref={hostRef} className="agent-surface">
      {body}
      {confirm && (
        <ConfirmDialog
          req={confirm}
          onCancel={() => setConfirm(null)}
          onConfirm={() => { const fn = confirm.onConfirm; setConfirm(null); fn(); }}
        />
      )}
    </div>
  );
}

// ── Native-style confirmation sheet (guards destructive session actions) ─────────

function ConfirmDialog({ req, onConfirm, onCancel }: {
  req: ConfirmRequest;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const btnRef = useRef<HTMLButtonElement | null>(null);
  // Land focus on the confirm button so ↵ confirms and the sheet reads to AT.
  useEffect(() => { btnRef.current?.focus(); }, []);
  // ↵ confirms · esc cancels — captured at the window so the keystrokes never leak
  // into the (now-backgrounded) terminal underneath.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); onConfirm(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onConfirm, onCancel]);

  return (
    <div className="agent-confirm-scrim" onMouseDown={onCancel}>
      <div
        className="agent-confirm"
        role="alertdialog"
        aria-modal="true"
        aria-label={req.title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className={'agent-confirm-icon ' + req.tone} aria-hidden>{req.tone === 'danger' ? '!' : '↻'}</div>
        <div className="agent-confirm-title">{req.title}</div>
        <div className="agent-confirm-msg">{req.message}</div>
        <div className="agent-confirm-actions">
          <button
            className="agent-confirm-btn ghost"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onCancel}
          >Cancel</button>
          <button
            ref={btnRef}
            className={'agent-confirm-btn ' + req.tone}
            onClick={onConfirm}
          >{req.confirmLabel}</button>
        </div>
        <div className="agent-confirm-hint"><kbd>↵</kbd> confirm<span>·</span><kbd>esc</kbd> cancel</div>
      </div>
    </div>
  );
}

// ── A single split pane (chrome around a session's detached terminal slot) ──────

function PaneFragment({
  sid, grow, multi, last, label, status, bypassOn, focused,
  slotRefs, onFocusPane, onClose, onRestart, onResizeStart,
}: {
  sid: string;
  grow: number;
  multi: boolean;
  last: boolean;
  label: string;
  status: TermStatus;
  bypassOn: boolean;
  focused: boolean;
  slotRefs: React.MutableRefObject<Map<string, HTMLDivElement>>;
  onFocusPane: () => void;
  onClose: () => void;
  onRestart: () => void;
  onResizeStart: (e: React.PointerEvent) => void;
}) {
  const ended = status === 'closed';
  const stateText = status === 'open' ? (bypassOn ? 'live · bypass' : 'live') : ended ? 'ended' : 'connecting…';
  // Controls: a stop-propagation mousedown keeps a click from re-focusing/dragging
  // the pane, so the action fires on the FIRST click every time.
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  const restartBtn = (
    <button className="agent-pane-btn" title="Restart session" aria-label="Restart session" onMouseDown={stop} onClick={(e) => { e.stopPropagation(); onRestart(); }}>↻</button>
  );
  const closeBtn = (
    <button className="agent-pane-btn close" title="Close pane (⌘W)" aria-label="Close pane" onMouseDown={stop} onClick={(e) => { e.stopPropagation(); onClose(); }}>✕</button>
  );
  return (
    <>
      <div
        className={'agent-pane' + (focused && multi ? ' focused' : '') + (ended ? ' ended' : '')}
        style={{ flexGrow: grow, flexBasis: 0 }}
        onMouseDown={onFocusPane}
      >
        {/* Split panes carry a persistent header (you always know which pane you're
            acting on); a lone pane keeps a clean, hover-revealed control cluster. */}
        {multi ? (
          <div className="agent-pane-head">
            <span className="agent-pane-status" data-status={status}><span className="dot" /><span className="agent-pane-name">{label}</span></span>
            <span className="agent-pane-state">{stateText}</span>
            <div style={{ flex: 1 }} />
            {restartBtn}
            {closeBtn}
          </div>
        ) : (
          <div className="agent-pane-tools">
            <span className="agent-pane-status" data-status={status}><span className="dot" />{stateText}</span>
            {restartBtn}
            {closeBtn}
          </div>
        )}
        <div
          className="agent-pane-slot"
          ref={(el) => { if (el) slotRefs.current.set(sid, el); else slotRefs.current.delete(sid); }}
        />
        {/* Ended session → an unmissable Reconnect target, not a 12px hover icon. */}
        {ended && (
          <div className="agent-pane-ended" onMouseDown={stop}>
            <div className="agent-pane-ended-card">
              <div className="agent-pane-ended-glyph" aria-hidden>&gt;_</div>
              <div className="agent-pane-ended-title">Session ended</div>
              <div className="agent-pane-ended-sub">Claude exited this session. Start a fresh one right here.</div>
              <div className="agent-pane-ended-actions">
                <button className="agent-pane-reconnect" onClick={(e) => { e.stopPropagation(); onRestart(); }}>↻ Reconnect</button>
                <button className="agent-pane-ended-close" onClick={(e) => { e.stopPropagation(); onClose(); }}>Close pane</button>
              </div>
            </div>
          </div>
        )}
      </div>
      {!last && <div className="agent-pane-divider" onPointerDown={onResizeStart} />}
    </>
  );
}

/** Tab dot status: connecting if any pane is connecting, else open if any is live,
    else closed. */
function tabStatus(tab: Tab, sessions: Map<string, Session>): TermStatus {
  const states = tab.panes.map(sid => sessions.get(sid)?.status ?? 'connecting');
  if (states.some(s => s === 'connecting')) return 'connecting';
  if (states.some(s => s === 'open')) return 'open';
  return 'closed';
}

// ── Bypass UI ─────────────────────────────────────────────────────────────────

function BypassToggle({ bypass, setBypass }: { bypass: boolean; setBypass: (b: boolean) => void }) {
  return (
    <div style={{ marginTop: '24px', width: '100%', maxWidth: '440px' }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', userSelect: 'none' }}>
        <input type="checkbox" checked={bypass} onChange={e => setBypass(e.target.checked)} style={{ accentColor: '#f87171', width: '16px', height: '16px' }} />
        <span style={{ fontSize: '13.5px', color: 'var(--color-text-secondary)' }}>Bypass permissions <span style={{ color: 'var(--color-text-tertiary)' }}>— skip per-action approval prompts</span></span>
      </label>
      {bypass && (
        <div style={bannerStyle}>
          ⚠ Bypass is ON — new sessions can edit files and run commands in this project <strong>without asking</strong>. Only use it when you trust the task.
        </div>
      )}
    </div>
  );
}

// ── Setup panel: one-click install of the embedded terminal's prerequisites ──────
// Shown when `claude` and/or `node-pty` are missing. Each install runs server-side
// in the user's login shell (so a Finder-launched app sees their real PATH) and is
// polled to completion; a success re-checks capabilities so the row flips to ready.

type InstallTarget = 'claude' | 'pty';

function Prereqs({ caps, onRefresh }: { caps: Capabilities; onRefresh: () => Promise<Capabilities | null> }) {
  const [busy, setBusy] = useState<InstallTarget | null>(null);
  const [log, setLog] = useState('');
  const [err, setErr] = useState('');

  const runInstall = useCallback(async (target: InstallTarget) => {
    setBusy(target); setErr(''); setLog('');
    try {
      const { runId } = await api.post<{ ok: boolean; runId: string }>('/agent/install', { target });
      // Poll until the background install ends (the server watchdog caps it ~5 min).
      for (let i = 0; i < 260; i++) {
        await new Promise(r => setTimeout(r, 1300));
        const s = await api.get<{ state: string; output: string }>(`/agent/install/status?id=${encodeURIComponent(runId)}`);
        if (s.output) setLog(s.output);
        if (s.state === 'done') { await onRefresh(); return; }
        if (s.state === 'error') { setErr(s.output || 'Install failed.'); return; }
        if (s.state === 'unknown') { setErr('The install run expired before it finished.'); return; }
      }
      setErr('Install is taking unusually long — check a real terminal.');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not start the install.');
    } finally {
      setBusy(null);
    }
  }, [onRefresh]);

  const rows: { target: InstallTarget; label: string; ok: boolean; desc: string }[] = [
    { target: 'claude', label: 'Claude CLI', ok: caps.claudeCli, desc: 'Anthropic’s claude command — the agent that runs in the terminal.' },
    { target: 'pty', label: 'Embedded terminal engine', ok: caps.nodePty, desc: 'The native node-pty module that renders Claude Code in-app.' },
  ];
  const canInstall = caps.npm;
  const blocked = !canInstall || busy !== null;

  return (
    <div style={{ marginTop: '22px', width: '100%', maxWidth: '440px', textAlign: 'left' }}>
      <p style={{ ...subStyle, fontSize: '13px', marginBottom: '12px', color: 'var(--color-text-tertiary)' }}>
        Set up what the in-app terminal needs:
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {rows.map(row => (
          <div key={row.target} style={prereqRow}>
            <span style={{ fontSize: '15px', width: '18px', flexShrink: 0, textAlign: 'center' }}>{row.ok ? '✅' : '⬜'}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '13.5px', fontWeight: 600, color: 'var(--color-text)' }}>{row.label}</div>
              <div style={{ fontSize: '12px', color: 'var(--color-text-tertiary)', lineHeight: 1.4 }}>{row.desc}</div>
            </div>
            {row.ok
              ? <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--color-success)', flexShrink: 0 }}>Ready</span>
              : (
                <button
                  onClick={() => runInstall(row.target)}
                  disabled={blocked}
                  style={{ ...secondaryBtn, padding: '7px 14px', fontSize: '13px', flexShrink: 0, opacity: blocked ? 0.55 : 1, cursor: blocked ? 'not-allowed' : 'pointer' }}
                >
                  {busy === row.target ? '⏳ Installing…' : 'Install'}
                </button>
              )}
          </div>
        ))}
      </div>

      {!canInstall && (
        <div style={{ ...bannerStyle, marginTop: '12px', background: 'rgba(255,174,59,0.1)', border: '1px solid rgba(255,174,59,0.32)', color: 'var(--color-text-secondary)' }}>
          npm wasn’t found on your PATH, so these can’t be auto-installed. Install Node.js from <code>nodejs.org</code> (or via Homebrew), then reopen this screen.
        </div>
      )}
      {busy && log && (
        <pre style={installLog}>{log.split('\n').slice(-6).join('\n')}</pre>
      )}
      {err && <div style={{ ...bannerStyle, marginTop: '10px' }}>{err}</div>}
    </div>
  );
}

const prereqRow: CSSProperties = { display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', borderRadius: '10px', background: 'var(--color-bg-secondary)', border: '1px solid var(--color-border)' };
const installLog: CSSProperties = { padding: '10px 12px', borderRadius: '8px', background: 'var(--color-bg-tertiary)', color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)', fontSize: '11px', lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '120px', overflow: 'auto', margin: '10px 0 0' };

function BypassPill({ bypass, setBypass }: { bypass: boolean; setBypass: (b: boolean) => void }) {
  return (
    <label title="Applies to new sessions (↻ restart a pane to apply)" className={'agent-term-pill' + (bypass ? ' on' : '')}>
      <input type="checkbox" checked={bypass} onChange={e => setBypass(e.target.checked)} />
      bypass
    </label>
  );
}

// ── Small presentational helpers ────────────────────────────────────────────────

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ height: '100%', width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '40px' }}>
      <div style={{ maxWidth: '560px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>{children}</div>
    </div>
  );
}

function BotMark() {
  return (
    <div style={{ width: '76px', height: '76px', borderRadius: '20px', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '18px', background: 'linear-gradient(150deg, rgba(139,123,255,0.18), rgba(111,92,224,0.08))', border: '1px solid rgba(139,123,255,0.3)', color: ACCENT, fontFamily: 'var(--font-mono)', fontSize: '30px' }}>
      &gt;_
    </div>
  );
}

const titleStyle: CSSProperties = { fontFamily: 'var(--font-family-display)', fontWeight: 700, fontSize: '23px', color: 'var(--color-text)', margin: '0 0 8px', letterSpacing: '-0.02em' };
const subStyle: CSSProperties = { fontSize: '14px', color: 'var(--color-text-secondary)', margin: 0, lineHeight: 1.55 };
const bannerStyle: CSSProperties = { marginTop: '12px', padding: '10px 14px', borderRadius: '10px', background: 'rgba(248,81,73,0.1)', border: '1px solid rgba(248,81,73,0.32)', color: '#f8a39d', fontSize: '12.5px', lineHeight: 1.5, textAlign: 'left' };
const primaryBtn: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: '7px', padding: '11px 20px', borderRadius: '11px', border: 'none', cursor: 'pointer', background: 'linear-gradient(150deg,#8b7bff,#6f5ce0)', color: '#fff', fontSize: '14px', fontWeight: 600, fontFamily: 'var(--font-family-text)', boxShadow: '0 6px 18px -6px rgba(123,104,238,0.85)' };
const secondaryBtn: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: '7px', padding: '11px 20px', borderRadius: '11px', cursor: 'pointer', background: 'var(--color-bg-secondary)', color: 'var(--color-text-secondary)', border: '1px solid var(--color-border)', fontSize: '14px', fontWeight: 600, fontFamily: 'var(--font-family-text)' };
