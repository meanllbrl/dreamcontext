import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { getActiveVault } from '../../api/client';
import { copyPreservingUnicode } from '../../lib/clipboard';
import { nextLineShadow } from '../../lib/lineShadow';
import { playAskChime } from '../../lib/chime';
import {
  readAgentSettings, AGENT_SETTINGS_EVENT, type AgentSettings, type AgentRenderer,
} from '../../lib/agentSettings';

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
  // Prerequisite breakdown (drives the in-app Setup panel + the System dependencies doctor).
  nodePty: boolean;
  claudeCli: boolean;
  /**
   * `claude` exists on disk but the user's shell can't see it — the install's
   * `export PATH="$HOME/.local/bin:$PATH"` line never reached their rc. Our own
   * spawns inject the real directory (so `claudeCli` stays true and nothing is
   * blocked), but the user's own terminal still can't run it: the System doctor
   * offers a one-click fix that writes the missing export.
   */
  claudePathBroken?: boolean;
  /**
   * Whether the installed `claude` is actually SIGNED IN (`claude auth status
   * --json`, probed server-side — see src/lib/claude-auth.ts). Absent when the CLI
   * isn't present or this isn't the desktop app.
   *
   * `loggedIn: null` means "couldn't tell" (an old CLI without the `auth`
   * subcommand, a Bedrock/Vertex setup, a failed probe) — treat it as unknown, never
   * as signed out. Advisory only: it drives what the UI SAYS, never whether a spawn
   * is allowed; the authoritative signal is still the CLI's own runtime frame
   * (chatProtocol's `auth-required`).
   */
  claudeAuth?: {
    loggedIn: boolean | null;
    supported: boolean;
    method?: string;
    email?: string;
    subscription?: string;
    /** The sign-in command for THIS CLI — what a terminal pane is handed, and what
     *  the manual fallback prints. */
    loginCommand: string;
    error?: string;
  };
  npm: boolean;
  /** git presence probed with the server's own env — exactly how cloud sync invokes it. */
  git: boolean;
}

export type TermStatus = 'connecting' | 'open' | 'closed';
/** What a session runs: the real Claude Code agent (terminal), a plain vault-scoped login
 *  shell, or a headless stream-json Chat session (beta — see chatSession.ts). */
export type SessionKind = 'agent' | 'shell' | 'chat';
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
  // Activity, derived from the PTY stream + the visible screen (drives the dock chips).
  busy: boolean;        // mid-turn: output streaming, or a quiet screen still mid-run
  asking: boolean;      // a question is on screen — Claude is blocked on YOUR answer
  attention: boolean;   // finished / rang the bell since you last looked
  minimized: boolean;   // mirrored from layout state so the idle timer can read it
  ensureOpen: () => void;
  fitAndResize: () => void;
  applyZoom: (zoom: number) => void;
  /** Write arbitrary text to the PTY (used to inject a dropped image's path). */
  sendText: (data: string) => void;
  /** Run a slash command (e.g. `/model opus`) WITHOUT clobbering what the user has
   *  half-typed into Claude's readline: clears the line, submits the command, then
   *  replays the user's draft back into the fresh prompt. Pass the command WITHOUT a
   *  trailing `\r` — submission is this method's job. */
  runCommand: (command: string) => void;
  /** Move keyboard focus to this session's input surface (the xterm here; a chat
   *  session's composer for the ChatSession peer) — the kind-agnostic call sites in
   *  AgentSurface use this instead of reaching into `.term` directly. */
  focus: () => void;
  dispose: () => void;
}

let sessionSeq = 0;
// Output must go quiet for this long before we reclassify what the screen shows.
const IDLE_MS = 800;
// While the quiet screen still shows a live turn, re-check on this cadence — a long
// tool call can stream nothing for seconds without being "done".
const RECHECK_MS = 1200;

// ── Quiet-screen classification ──────────────────────────────────────────────────
// The byte stream alone can't tell "done" from "waiting for your answer" from "silent
// mid-turn tool call" — all three just stop streaming. The visible buffer tail can:
// Claude Code renders a ❯-cursor numbered option list whenever it's blocked on input
// (permission prompts, AskUserQuestion, plan approval, trust dialog), and keeps
// "esc to interrupt" on screen for the whole life of a turn.
const ASKING_RE = /❯\s{0,2}\d+\.|\(y\/n\)|\[y\/n\]/i;
const WORKING_RE = /esc to interrupt|ctrl\+b to run in background/i;

/**
 * `promptToken` is the large-prompt transport: a token minted by `preparePrompt`
 * (lib/agentPrompt.ts) that the server redeems back into the full text, so a prompt too big
 * for the upgrade URL never has to be truncated. When set it REPLACES `initialPrompt` on the
 * wire — pass one or the other, never both.
 */
export function createSession(bypass: boolean, notify: () => void, claudeId: string, resume = false, kind: SessionKind = 'agent', initialPrompt = '', model = '', submitInitial = true, promptToken = '', deferPrompt = false): Session {
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

  // ── Renderer (GPU vs native text) ────────────────────────────────────────────
  // Default is the WebGL addon: Claude's Ink TUI redraws most of the viewport every
  // frame while streaming, which the DOM renderer (real text nodes, layout + GC per
  // frame) cannot hold at frame rate in WKWebView — the residual stutter after the
  // transport fixes. 'dom' remains the opt-in comfort path (native macOS font
  // smoothing; the 2026-07-01 preference). Swappable LIVE via Settings → Agents:
  // loading the addon upgrades an open terminal in place, disposing it drops xterm
  // back to the DOM renderer. On WebGL context loss (WKWebView reclaims contexts
  // under pressure) we dispose and fall back to DOM instead of showing a dead canvas.
  let webgl: WebglAddon | null = null;
  function applyRenderer(mode: AgentRenderer) {
    if (!session.opened) return; // ensureOpen applies the current setting on open
    if (mode === 'webgl' && !webgl) {
      try {
        const addon = new WebglAddon();
        addon.onContextLoss(() => {
          try { addon.dispose(); } catch { /* already down */ }
          if (webgl === addon) webgl = null;
        });
        term.loadAddon(addon);
        webgl = addon;
      } catch { webgl = null; /* GPU unavailable → DOM renderer stays */ }
    } else if (mode === 'dom' && webgl) {
      try { webgl.dispose(); } catch { /* mid-init */ }
      webgl = null;
    }
  }
  const onSettingsChange = (e: Event) => {
    const cfg = (e as CustomEvent<AgentSettings>).detail;
    if (cfg?.renderer) applyRenderer(cfg.renderer);
  };
  window.addEventListener(AGENT_SETTINGS_EVENT, onSettingsChange);

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
  // An AUTO-SUBMIT initial prompt (the Sleep consolidation, a delegated task, a curate
  // session) is handed to the SERVER, which passes it to `claude` as a positional arg so the
  // TUI boots with it already submitted — race-free. The old path typed it into the readline
  // after a boot-settle heuristic, which dropped the message when a slow boot (e.g. "MCP
  // servers need authentication") opened a quiet gap before the prompt was ready. The
  // type-WITHOUT-submit case (a composer skill/file insert, `submitInitial=false`) still
  // injects client-side below — the server can't leave a line unsubmitted.
  //
  // A pre-minted `promptToken` wins over an inline prompt: it means the caller already found
  // the text too big for the URL and POSTed it (see lib/agentPrompt.ts). Sending both would
  // put the oversized text back in the request line — the exact overflow the token avoids.
  const serverSubmitsPrompt = !isShell && submitInitial && (!!initialPrompt || !!promptToken);
  const promptParam = !serverSubmitsPrompt
    ? ''
    : promptToken
      ? `&promptToken=${encodeURIComponent(promptToken)}`
      : `&prompt=${encodeURIComponent(initialPrompt)}`;
  // `deferPrompt` flips the prompt's DELIVERY, not its transport: the server parks it for the
  // UserPromptSubmit hook instead of auto-submitting, so it joins the USER's first message as
  // context rather than opening the conversation itself.
  // Meaningful only when a server-submitted prompt exists at all.
  const deferParam = serverSubmitsPrompt && deferPrompt ? '&deferPrompt=1' : '';
  const url = `${proto}://${location.host}/api/agent/terminal?vault=${encodeURIComponent(vault ?? '')}&bypass=${bypassParam}&theme=${theme}${idParam}${kindParam}${modelParam}${promptParam}${deferParam}`;
  const ws = new WebSocket(url);
  // Binary frames are the server's control channel (hook-reported turn state);
  // arraybuffer (not the default Blob) so they can be decoded synchronously in
  // onmessage. Terminal output always arrives as text frames.
  ws.binaryType = 'arraybuffer';

  const session: Session = {
    id, bypass, kind, claudeId, container, term, fit, ws,
    status: 'connecting', opened: false,
    busy: false, asking: false, attention: false, minimized: false,
    ensureOpen, fitAndResize, applyZoom, sendText, runCommand, focus: () => term.focus(), dispose,
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

  // Activity tracking — "working" while output streams; once it goes quiet, the
  // SCREEN decides what the quiet means (still mid-turn / a question / done). Notifies
  // React only on a state TRANSITION (never per byte), so continuous streaming doesn't
  // thrash re-renders.
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  function armSettle(ms: number) {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(onSettle, ms);
  }
  function markActivity() {
    if (session.asking) {
      // Bytes during a question are usually dialog redraws / keystroke echo — but
      // they're also how the turn RESUMES once the user answers. Re-classify on a
      // short NON-SLIDING fuse: a sliding one would never fire under the heavy
      // streaming that follows an answer, leaving the chip stuck on "needs you".
      if (!idleTimer) armSettle(350);
      return;
    }
    if (!session.busy) { session.busy = true; notify(); }
    armSettle(IDLE_MS);
  }
  // Read the bottom viewport as plain text (baseY-anchored, so the user scrolling the
  // scrollback never changes what we classify).
  function readTail(): string {
    try {
      const buf = term.buffer.active;
      const lines: string[] = [];
      for (let y = buf.baseY; y < buf.baseY + term.rows; y++) {
        const line = buf.getLine(y);
        if (line) lines.push(line.translateToString(true));
      }
      return lines.join('\n');
    } catch { return ''; }
  }
  // ── Hook-reported turn state ────────────────────────────────────────────────
  // The dreamcontext hooks inside the session report the turn lifecycle itself
  // (UserPromptSubmit → working, Stop → ready), relayed by the server as binary WS
  // frames. That is ground truth the screen heuristic can only approximate — the
  // heuristic read every quiet gap whose tail missed WORKING_RE as "ready" while
  // Claude was still mid-turn. Once a frame has arrived the hook signal owns the
  // busy/ready split; the screen heuristic still owns `asking` (permission prompts
  // fire no hook) and takes back over after a user interrupt (Esc/Ctrl+C — Claude
  // Code fires no Stop for an interrupted turn) or in hook-less vaults.
  let hookState: '' | 'working' | 'ready' = '';
  let hookSuspended = false;
  function onHookState(state: 'working' | 'ready') {
    hookState = state;
    hookSuspended = false;
    if (state === 'working') {
      if (!session.busy || session.asking) { session.busy = true; session.asking = false; notify(); }
      armSettle(IDLE_MS);
    } else {
      // Don't flip busy here — arm a short fuse and let onSettle classify the quiet
      // screen (asking? attention badge?) through the one transition bookkeeper.
      armSettle(200);
    }
  }
  // Output went quiet → decide what the quiet MEANS from what's actually on screen.
  function onSettle() {
    idleTimer = undefined;
    // If the PTY closed in the meantime, don't raise the "finished, waiting for you"
    // badge — an ended session must read as plain "sleeping", not sleeping+chip.
    if (session.status === 'closed') { session.busy = false; session.asking = false; notify(); return; }
    const tail = readTail();
    if (ASKING_RE.test(tail)) {
      const fresh = !session.asking;
      session.busy = false;
      session.asking = true;
      if (fresh) {
        // A question is the strongest "needs you" there is: badge it and chime ONCE
        // per question — redraws can't re-trigger, asking only rises on a fresh edge.
        session.attention = true;
        playAskChime();
      }
      notify();
      return;
    }
    // A live hook `ready` overrides leftover spinner text (the Stop already fired —
    // the turn IS over, whatever the last redraw still shows).
    if (WORKING_RE.test(tail) && hookState !== 'ready') {
      // Still mid-turn, just streaming nothing (a silent tool call) — hold "working"
      // and re-check, so the chip never flaps to "ready" while Claude is busy.
      if (!session.busy || session.asking) { session.busy = true; session.asking = false; notify(); }
      armSettle(RECHECK_MS);
      return;
    }
    if (hookState === 'working' && !hookSuspended) {
      // The hooks say the turn is still LIVE — a quiet, spinner-less screen here is a
      // redraw gap or a WORKING_RE miss, not "done". Hold working and re-check; only
      // the Stop hook (or an interrupt suspension above) ends the turn.
      if (!session.busy || session.asking) { session.busy = true; session.asking = false; notify(); }
      armSettle(RECHECK_MS);
      return;
    }
    session.busy = false;
    session.asking = false;
    // Finished while you weren't looking → flag the bubble's notification badge.
    if (session.minimized && !session.attention) session.attention = true;
    notify();
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
  // the strongest "done, look at me" signal we get from the stream. Badge immediately,
  // and classify the screen on a short fuse so a question flips the chip to "needs you"
  // fast instead of waiting out the full idle window.
  const bellSub = term.onBell(() => {
    if (!session.attention) { session.attention = true; notify(); }
    armSettle(200);
  });

  // Stop any pending idle timer first, so it can't fire AFTER close and flag a
  // notification badge on an already-ended session.
  const stopOnClose = () => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined; }
    hookState = '';
    hookSuspended = false;
    session.busy = false;
    session.asking = false;
    setStatus('closed');
  };
  // ── Flow-control acks ────────────────────────────────────────────────────────
  // The server coalesces PTY chunks and PAUSES the PTY above a high-water mark of
  // un-acked output (agent-terminal.ts createOutputPump) — the guard that keeps a huge
  // burst from ballooning xterm's write buffer into a multi-second freeze. Confirm
  // processed chars back on a coarse cadence via xterm's write callback (fires after
  // the chunk is parsed, even for a hidden/parked pane). The n=0 ack on open declares
  // the capability — the server never pauses for a client that has not acked. Both
  // sides count JS string length, so the metric can never drift.
  const ACK_EVERY_CHARS = 32 * 1024;
  let unackedChars = 0;
  const sendAck = (n: number) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ack', n }));
  };
  ws.onopen = () => { setStatus('open'); fitAndResize(); sendAck(0); };
  ws.onmessage = (ev) => {
    // Binary frame = server control channel (hook-reported turn state). Never
    // terminal output, which always arrives as text frames.
    if (ev.data instanceof ArrayBuffer) {
      try {
        const msg = JSON.parse(new TextDecoder().decode(ev.data)) as { type?: string; state?: string };
        if (msg.type === 'status' && (msg.state === 'working' || msg.state === 'ready')) onHookState(msg.state);
      } catch { /* malformed control frame — ignore */ }
      return;
    }
    const d = typeof ev.data === 'string' ? ev.data : '';
    if (!d) return;
    term.write(d, () => {
      unackedChars += d.length;
      if (unackedChars >= ACK_EVERY_CHARS) { const n = unackedChars; unackedChars = 0; sendAck(n); }
    });
    markActivity();
    armInitialPrompt();
  };
  ws.onclose = stopOnClose;
  ws.onerror = stopOnClose;

  // Write raw input bytes to the PTY — the same control frame xterm's keystrokes use.
  // `rawSend` is the untracked wire write; `sendInput` additionally maintains the
  // line shadow below, and is the path EVERY user-originated byte takes (xterm onData,
  // the ⇧↵/⌥⌫/⌘⌫ remaps, composer inserts, drop-path injection, the initial prompt).
  const rawSend = (data: string) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }));
  };

  // ── Readline line-shadow (what `runCommand` restores) ────────────────────────────
  // The raw byte log of everything sent into Claude's readline since the line last
  // emptied (rules: `nextLineShadow`, exported pure below). Deliberately UNPARSED:
  // Claude's readline is deterministic, so replaying the exact bytes from an empty line
  // reproduces the user's draft — backspaces, ⌥⌫ word deletes, mid-line cursor moves and
  // all — without this code understanding any of them.
  let lineShadow = '';
  const sendInput = (data: string) => { lineShadow = nextLineShadow(lineShadow, data); rawSend(data); };

  /** How long after submitting a `runCommand` slash command before the saved draft is
   *  replayed — long enough for the command's transient rerender (e.g. `/model`'s
   *  confirmation) to settle so the typed-ahead bytes land in the fresh prompt. */
  const RUN_COMMAND_RESTORE_MS = 350;

  // Run a slash command without clobbering the user's half-typed line (hoisted — the
  // session object literal above references it): Ctrl+E jumps to line end, Ctrl+U kills
  // to line start (both honored natively by Claude's prompt — see the keymap note below),
  // so the line is empty wherever the cursor sat; then the command submits, and the saved
  // draft replays into the fresh prompt. The command's own bytes go through `rawSend`, so
  // the shadow still equals the draft — which is exactly what the readline holds again
  // after the replay.
  function runCommand(command: string) {
    const saved = lineShadow;
    rawSend(`\x05\x15${command}\r`);
    if (saved) setTimeout(() => rawSend(saved), RUN_COMMAND_RESTORE_MS);
  }

  // ── Type an initial prompt (composer skill/file insert; a shell's opening command) ────
  // Two cases reach here. (a) Type WITHOUT submitting: a session pre-typed with a composer
  // skill trigger (e.g. `/council `) that the USER finishes. (b) A SHELL's opening command
  // (`submitInitial` + `kind:'shell'` — the Chat sign-in flow's `claude auth login` tab):
  // a shell's command can't take the server-side route, because the server only ever passes a
  // prompt to `claude` as a positional argument and a shell has no such argument — so it is
  // typed here and submitted with a CR.
  //
  // The AUTO-SUBMIT case for a CLAUDE session (the Sleep consolidation) is still handled
  // server-side — `claude` gets the prompt as a positional arg (see `serverSubmitsPrompt`
  // above), which boots the TUI with it already
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
      // A shell's opening command is SUBMITTED (case b); everything else is typed and left for
      // the user to finish (case a). The CR goes through `sendInput` too, so the line shadow
      // empties with the line — a shadow still holding a submitted command would replay it
      // into the next prompt on the first `runCommand`.
      sendInput(isShell && submitInitial ? `${initialPrompt}\r` : initialPrompt);
    }, 1600);
  }

  // Public injection point (e.g. a dropped image's absolute path). A HOISTED function
  // declaration so the session object literal above can reference it before this line
  // without a TDZ; `sendInput` is only dereferenced at call time (long after init).
  function sendText(data: string) { sendInput(data); }

  const dataSub = term.onData((d) => {
    // Esc/Ctrl+C while the hooks say "working" is the one turn-ending path that
    // fires NO Stop hook (Claude Code skips it on user interrupts) — hand the
    // busy/ready split back to the screen heuristic until the next hook event.
    // A lone Esc arrives as exactly '\x1b' (arrow keys etc. are longer sequences).
    if (hookState === 'working' && (d === '\x1b' || d === '\x03')) {
      hookSuspended = true;
      armSettle(IDLE_MS);
    }
    sendInput(d);
  });

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
      // The renderer preference applies only to an OPENED terminal (the WebGL addon
      // needs the DOM/canvas in place), so this is its single entry point.
      applyRenderer(readAgentSettings().renderer);
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
    try { window.removeEventListener(AGENT_SETTINGS_EVENT, onSettingsChange); } catch { /* gone */ }
    try { webgl?.dispose(); } catch { /* atlas mid-init */ }
    webgl = null;
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
