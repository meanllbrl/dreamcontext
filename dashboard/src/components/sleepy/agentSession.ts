import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { getActiveVault } from '../../api/client';
import { copyPreservingUnicode } from '../../lib/clipboard';

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
/** What a session runs: the real Claude Code agent, or a plain vault-scoped login shell. */
export type SessionKind = 'agent' | 'shell';
export const ACCENT = '#8b7bff';

// Base xterm font size at 100% zoom. Multiplied by the app's `--zoom` so terminal
// text tracks the window zoom control (which otherwise only scales CSS font tokens).
const BASE_FONT = 14.5;
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
  // Deliberately SOFTER than --color-text: pure #f5f6fa on #14171f is ~17:1, which is
  // harsh/eye-tiring for long sessions. A calm off-white (dark) / lifted ink (light)
  // keeps text clearly present while dropping the glare. Dim text stays dim because
  // minimumContrastRatio is only 3 (not 4.5), so the hierarchy isn't flattened bright.
  const softFg = isLight ? '#33383f' : '#cdd3de';
  return {
    background: bg,
    foreground: softFg,
    cursor: accent,
    cursorAccent: bg,
    // Selection must be UNMISTAKABLE in both themes AND whether or not the terminal is the
    // focused element. A pale semi-transparent violet was invisible on the white light-mode
    // background; worse, while the selection is drawn UNFOCUSED xterm uses its faint default
    // `selectionInactiveBackground` (a light gray — visible on dark, invisible on white),
    // which is exactly what the light-mode bug was. So pin a SOLID deep brand-violet with
    // white text for BOTH the active and inactive selection: ~5.3:1 white-on-violet, clearly
    // visible on white AND on the dark canvas, regardless of focus.
    selectionBackground: '#6a57d6',
    selectionInactiveBackground: '#6a57d6',
    selectionForeground: '#ffffff',
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
  /** Claude agent, or a plain vault-scoped login shell. */
  kind: SessionKind;
  /** The Claude conversation UUID — passed as `--session-id` on a new session, persisted
   *  in the roster, and used to `--resume` this exact conversation after an app reopen.
   *  Unused for shell sessions (a shell has no conversation to resume). */
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

export function createSession(bypass: boolean, notify: () => void, claudeId: string, resume = false, kind: SessionKind = 'agent', initialPrompt = '', model = '', submitInitial = true): Session {
  const id = `agent-${++sessionSeq}`;
  const container = document.createElement('div');
  container.className = 'agent-pane-term';

  const fontFamily = getComputedStyle(document.body).getPropertyValue('--font-mono').trim()
    || "'JetBrains Mono', ui-monospace, Menlo, monospace";
  // The first family in the stack — the actual webfont we must wait for (both weights)
  // before xterm measures the cell width, or glyphs render thin inside an over-wide cell.
  const primaryMono = (fontFamily.split(',')[0] || 'JetBrains Mono').replace(/['"]/g, '').trim();

  const term = new Terminal({
    fontFamily,
    fontSize: BASE_FONT * currentZoom(),
    lineHeight: 1.65,
    letterSpacing: 0,
    cursorBlink: true,
    cursorStyle: 'bar',
    fontWeightBold: '700',
    theme: readXtermTheme(),
    allowProposedApi: true,
    scrollback: 5000,
    // AA contrast floor: xterm auto-lifts any foreground that falls too close to its
    // actual cell background — the safety net for Claude's TUI blocks that pair a default
    // foreground with an ANSI 7/8 background fill (else unreadable same-on-same text).
    // Kept at 3 (not the old 4.5): high enough to rescue those block fills, low enough
    // that genuinely dim/secondary text STAYS dim instead of being force-brightened —
    // preserving visual hierarchy and the calmer, less-harsh feel.
    minimumContrastRatio: 3,
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
  // A shell has no conversation and no permission model, so it carries neither the
  // resume/session-id continuity params nor bypass — just `&kind=shell`. An agent pins a
  // NEW conversation to claudeId (`--session-id`) so the next launch can resume it; on
  // restore, it asks the server to `--resume` that exact conversation instead.
  const isShell = kind === 'shell';
  const idParam = isShell ? '' : (resume ? `&resume=${encodeURIComponent(claudeId)}` : `&sessionId=${encodeURIComponent(claudeId)}`);
  const kindParam = isShell ? '&kind=shell' : '';
  // The model applies ONLY to a Claude agent (`claude --model <id>`); a shell has none, and
  // an empty id means "let Claude Code use its configured default" (no flag). The server
  // re-validates the token before it ever reaches the shell command, so this is a hint.
  const modelParam = !isShell && model ? `&model=${encodeURIComponent(model)}` : '';
  const bypassParam = isShell ? '0' : (bypass ? '1' : '0');
  // An AUTO-SUBMIT initial prompt (the Sleep consolidation) is handed to the SERVER, which
  // passes it to `claude` as a positional arg so the TUI boots with it already submitted —
  // race-free. The old path typed it into the readline after a boot-settle heuristic, which
  // dropped the message when a slow boot (e.g. "MCP servers need authentication") opened a
  // quiet gap before the prompt was ready. The type-WITHOUT-submit case (a composer skill/file
  // insert, `submitInitial=false`) still injects client-side below — the server can't leave a
  // line unsubmitted.
  const serverSubmitsPrompt = !isShell && submitInitial && !!initialPrompt;
  const promptParam = serverSubmitsPrompt ? `&prompt=${encodeURIComponent(initialPrompt)}` : '';
  const url = `${proto}://${location.host}/api/agent/terminal?vault=${encodeURIComponent(vault ?? '')}&bypass=${bypassParam}&theme=${theme}${idParam}${kindParam}${modelParam}${promptParam}`;
  const ws = new WebSocket(url);

  const session: Session = {
    id, bypass, kind, claudeId, container, term, fit, ws,
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
  ws.onmessage = (ev) => { const d = typeof ev.data === 'string' ? ev.data : ''; if (d) { term.write(d); markActivity(); armInitialPrompt(); } };
  ws.onclose = stopOnClose;
  ws.onerror = stopOnClose;

  // Write raw input bytes to the PTY — the same control frame xterm's keystrokes use.
  const sendInput = (data: string) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }));
  };

  // ── Type an initial prompt WITHOUT submitting (composer skill/file insert) ─────────
  // Only the type-without-submit case runs here now: a spawned session pre-typed with a
  // composer skill trigger (e.g. `/council `) that the USER finishes. The AUTO-SUBMIT case
  // (the Sleep consolidation) is handled server-side — `claude` gets the prompt as a
  // positional arg (see `serverSubmitsPrompt` above), which boots the TUI with it already
  // submitted, so it never depends on this boot-settle heuristic (which dropped the message
  // when a slow boot opened a quiet gap before the readline was ready). We still wait for the
  // boot output to SETTLE — every chunk resets a short timer — then drop the text in as one
  // line the moment the stream pauses. Fires at most once (`promptSent`).
  let promptSent = false;
  let bootTimer: ReturnType<typeof setTimeout> | undefined;
  function armInitialPrompt() {
    if (!initialPrompt || promptSent || serverSubmitsPrompt) return;
    if (bootTimer) clearTimeout(bootTimer);
    bootTimer = setTimeout(() => {
      bootTimer = undefined;
      if (promptSent || ws.readyState !== WebSocket.OPEN) return;
      promptSent = true;
      // Type the text but leave the line UNSUBMITTED so the user finishes it (the only case
      // that reaches here — the auto-submit path is served server-side; see the comment above).
      sendInput(initialPrompt);
    }, 1600);
  }

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
    // ⌘C / ⌘X — copy the selection OURSELVES (encoding-safe, see copyPreservingUnicode)
    // and swallow the event so WKWebView doesn't ring the macOS system beep (the "tık"
    // sound) on an otherwise-unhandled ⌘-key. A terminal's on-screen text is read-only,
    // so ⌘X can't truly "cut" — it copies, same as ⌘C. ⌘V is deliberately NOT intercepted:
    // xterm's native paste keeps bracketed-paste mode intact (else a multi-line paste would
    // auto-submit each line). Ctrl+C (SIGINT) has ctrlKey set, so it falls through to xterm.
    if (e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'c' || e.key === 'x')) {
      e.preventDefault();
      const sel = term.getSelection();
      if (sel) { copyPreservingUnicode(sel); term.focus(); }
      return false;
    }
    // ⌘A — select the whole buffer (swallow so it doesn't beep either).
    if (e.metaKey && !e.ctrlKey && !e.altKey && e.key === 'a') {
      e.preventDefault(); term.selectAll(); return false;
    }
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
  // webfont is ready, so xterm's DOM renderer measures the real glyph width. We use
  // the DOM renderer (NOT WebGL) on purpose: it renders real text nodes that get
  // macOS-native anti-aliasing, so glyph edges are soft — not the WebGL atlas's hard,
  // "sharp" rasterisation the user found eye-tiring.
  function ensureOpen() {
    if (session.opened || !container.isConnected) return;
    const doOpen = () => {
      // Must be connected AND visible (offsetParent is null while parked in the
      // hidden garage) — opening on a 0-size node would mis-measure the grid. If
      // hidden now, a later ensureOpen (when the pane is shown) will open it.
      if (session.opened || !container.isConnected || container.offsetParent === null) return;
      term.open(container);
      session.opened = true;
      fitAndResize();
      // One more recompute next frame: the first paint can latch a stale (fallback-font)
      // cell width, making text look thin/stretched. Re-applying the font + refit forces
      // a rebuild with the real metrics.
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
        fonts.load(`${BASE_FONT}px "${primaryMono}"`),
        fonts.load(`700 ${BASE_FONT}px "${primaryMono}"`),
      ]).then(() => fonts.ready).then(doOpen).catch(doOpen);
    } else doOpen();
  }

  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined; }
    if (bootTimer) { clearTimeout(bootTimer); bootTimer = undefined; }
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
