import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { getActiveVault } from '../../api/client';

/**
 * The imperative session engine behind {@link AgentSurface} — one `node-pty` ↔
 * WebSocket ↔ xterm per session, plus the theme/zoom helpers that keep Claude's TUI
 * matched to the app surface. Deliberately framework-free (no React): this is a
 * different cognitive layer from the React orchestration, kept in its own module so
 * the surface component stays focused on layout + lifecycle.
 */

export interface Capabilities {
  desktop: boolean;
  platform: string;
  embeddedTerminal: boolean;
  openTerminal: boolean;
  // Prerequisite breakdown (drives the in-app Setup panel).
  nodePty: boolean;
  claudeCli: boolean;
  npm: boolean;
}

export type TermStatus = 'connecting' | 'open' | 'closed';
export const ACCENT = '#8b7bff';

// Base xterm font size at 100% zoom. Multiplied by the app's `--zoom` so terminal
// text tracks the window zoom control (which otherwise only scales CSS font tokens).
const BASE_FONT = 13.5;
export function currentZoom(): number {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--zoom'));
  return Number.isFinite(v) && v > 0 ? v : 1;
}

// A destructive action that needs the user's explicit OK before it runs. Surfaced as
// a native-style confirmation sheet over the terminal; only raised for LIVE sessions
// (an already-ended session is closed instantly, never nags).
export type ConfirmTone = 'danger' | 'accent';
export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel: string;
  tone: ConfirmTone;
  onConfirm: () => void;
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

export interface Session {
  id: string;
  bypass: boolean;
  /** The Claude conversation UUID — passed as `--session-id` on a new session, persisted
   *  in the roster, and used to `--resume` this exact conversation after an app reopen. */
  claudeId: string;
  container: HTMLDivElement;
  term: Terminal;
  fit: FitAddon;
  ws: WebSocket;
  status: TermStatus;
  opened: boolean;
  // Activity, derived from the PTY stream (drives the minimized bubble's mood/badge).
  busy: boolean;        // output streamed within the last idle window → still working
  attention: boolean;   // finished / rang the bell since you last looked
  minimized: boolean;   // mirrored from layout state so the idle timer can read it
  ensureOpen: () => void;
  fitAndResize: () => void;
  applyZoom: (zoom: number) => void;
  /** Write arbitrary text to the PTY (used to inject a dropped image's path). */
  sendText: (data: string) => void;
  dispose: () => void;
}

let sessionSeq = 0;
// Output must go quiet for this long before we call a session "finished".
const IDLE_MS = 800;

export function createSession(bypass: boolean, notify: () => void, claudeId: string, resume = false): Session {
  const id = `agent-${++sessionSeq}`;
  const container = document.createElement('div');
  container.className = 'agent-pane-term';

  const fontFamily = getComputedStyle(document.body).getPropertyValue('--font-mono').trim()
    || "'Sometype Mono', 'JetBrains Mono', ui-monospace, Menlo, monospace";

  const term = new Terminal({
    fontFamily,
    fontSize: BASE_FONT * currentZoom(),
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
  // Pin a NEW conversation to claudeId (`--session-id`) so the next launch can resume it;
  // on restore, ask the server to `--resume` that exact conversation instead.
  const idParam = resume ? `&resume=${encodeURIComponent(claudeId)}` : `&sessionId=${encodeURIComponent(claudeId)}`;
  const url = `${proto}://${location.host}/api/agent/terminal?vault=${encodeURIComponent(vault ?? '')}&bypass=${bypass ? '1' : '0'}&theme=${theme}${idParam}`;
  const ws = new WebSocket(url);

  const session: Session = {
    id, bypass, claudeId, container, term, fit, ws,
    status: 'connecting', opened: false,
    busy: false, attention: false, minimized: false,
    ensureOpen, fitAndResize, applyZoom, sendText, dispose,
  };

  function setStatus(s: TermStatus) { session.status = s; notify(); }

  function fitAndResize() {
    if (!session.opened) return;
    try { fit.fit(); } catch { return; }
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    }
  }

  function applyZoom(zoom: number) {
    const next = BASE_FONT * (zoom > 0 ? zoom : 1);
    if (term.options.fontSize === next) return;
    term.options.fontSize = next;
    fitAndResize();
  }

  // Activity tracking — "working" while output streams, "finished" once it goes
  // quiet. Notifies React only on a busy/attention TRANSITION (never per byte), so
  // continuous streaming doesn't thrash re-renders.
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  function markActivity() {
    if (!session.busy) { session.busy = true; notify(); }
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      session.busy = false;
      // If the PTY closed in the meantime, don't raise the "finished, waiting for you"
      // badge — an ended session must read as plain "sleeping", not sleeping+chip.
      if (session.status === 'closed') { notify(); return; }
      // Finished while you weren't looking → flag the bubble's notification badge.
      if (session.minimized && !session.attention) session.attention = true;
      notify();
    }, IDLE_MS);
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

  // Claude Code rings the terminal bell when a turn finishes / it needs your input —
  // the strongest "done, look at me" signal we get from the stream.
  const bellSub = term.onBell(() => { if (!session.attention) { session.attention = true; notify(); } });

  // Stop any pending idle timer first, so it can't fire AFTER close and flag a
  // notification badge on an already-ended session.
  const stopOnClose = () => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined; }
    session.busy = false;
    setStatus('closed');
  };
  ws.onopen = () => { setStatus('open'); fitAndResize(); };
  ws.onmessage = (ev) => { const d = typeof ev.data === 'string' ? ev.data : ''; if (d) { term.write(d); markActivity(); } };
  ws.onclose = stopOnClose;
  ws.onerror = stopOnClose;

  // Write raw input bytes to the PTY — the same control frame xterm's keystrokes use.
  const sendInput = (data: string) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }));
  };

  // Public injection point (e.g. a dropped image's absolute path). A HOISTED function
  // declaration so the session object literal above can reference it before this line
  // without a TDZ; `sendInput` is only dereferenced at call time (long after init).
  function sendText(data: string) { sendInput(data); }

  const dataSub = term.onData(sendInput);

  // macOS line-editing gestures → the control bytes Claude Code's prompt already
  // honors. xterm doesn't emit these on its own (⌘ combos are swallowed, and a bare
  // ⇧↵ would just submit), so we intercept the keydown and write the equivalent
  // sequence ourselves. Everything else falls through to xterm unchanged.
  //   ⇧↵   newline without submitting → "\\\r": Claude's universal newline (the
  //          backslash+Enter continuation it consumes — works without relying on the
  //          terminal advertising the kitty/CSI-u keyboard protocol over xterm.js).
  //   ⌥⌫   delete the previous word    → \x17  (Ctrl+W)
  //   ⌘⌫   delete to the line start    → \x15  (Ctrl+U)
  // (Ctrl+A/E/K/W/U and the arrow/word-nav keys already work natively — no remap.)
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    if (e.key === 'Enter' && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault(); sendInput('\\\r'); return false;
    }
    if (e.key === 'Backspace' && e.altKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault(); sendInput('\x17'); return false;
    }
    if (e.key === 'Backspace' && e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault(); sendInput('\x15'); return false;
    }
    return true;
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
        fonts.load(`${BASE_FONT}px "Sometype Mono"`),
        fonts.load(`600 ${BASE_FONT}px "Sometype Mono"`),
      ]).then(() => fonts.ready).then(doOpen).catch(doOpen);
    } else doOpen();
  }

  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined; }
    // Each teardown step is isolated. Disposing a JUST-opened xterm — its WebGL glyph
    // atlas still initialising — can throw `_isDisposed` deep in addon teardown; an
    // un-caught throw here would abort the caller (closeSessionById) before it removes
    // the row, leaving a zombie "ended" tab. Swallow per-step so cleanup always finishes.
    try { themeObserver.disconnect(); } catch { /* gone */ }
    try { dataSub.dispose(); } catch { /* gone */ }
    try { bellSub.dispose(); } catch { /* gone */ }
    try { oscFg.dispose(); } catch { /* gone */ }
    try { oscBg.dispose(); } catch { /* gone */ }
    try { ws.close(); } catch { /* already closing */ }
    try { term.dispose(); } catch { /* webgl atlas mid-init */ }
    try { container.remove(); } catch { /* already detached */ }
  }

  return session;
}
