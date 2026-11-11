import { useEffect, useRef, useState } from 'react';
import { createStyledTerm, currentTermTheme, currentZoom, BASE_FONT, openWhenFontsReady } from '../termCore';
import { appendTail, finishTail } from './runReport';
import { OWNER_ONLY_LINE, cardTerminalUrl, type CardActionResult, type CardTarget } from '../../../lib/cardRecords';

/**
 * A REAL PTY inside the transcript — one command, bounded height, and an exit code that
 * goes back into the conversation.
 *
 * Not a log view and not a picture of a terminal: keystrokes reach the process, so the sudo
 * password, the `y/n`, the OTP and the arrow-key menu all work. That is the entire reason
 * this exists — the commands worth putting a ▶ next to are exactly the ones that ask you
 * something, and those are the ones a headless `Bash` tool call hangs on.
 *
 * It is DELIBERATELY not a `Session` from `agentSession.ts`. A session is a roster entry
 * with a tab, a dock chip, attention state, a conversation to resume, and a life longer
 * than the pane it is drawn in; this is a process that lives and dies inside one card in one
 * message. What the two share is the terminal itself (`termCore.ts`), which is the part that
 * would otherwise drift.
 *
 * Flow control: this never acks. The server's pump arms its high-water pause only after the
 * client's first ack (see `createOutputPump`), so not acking keeps the simple
 * fire-and-forget path — right here, where the output is one human-scale command's, and the
 * alternative would be a second copy of the ack bookkeeping for no benefit.
 */

export type InlineTermStatus = 'connecting' | 'running' | 'exited' | 'failed';

export type { CardTarget };

export function InlineTerminal({
  vault, command, cwd, card, mintTicket, rows = 14, onExit, onStatus,
}: {
  vault: string;
  command: string;
  cwd?: string;
  /** Chat host: the server record to start or attach to. No `cmd=` is ever sent then. */
  card?: CardTarget;
  /** The Mac's card press (K4): mints the single-use ticket for `card` right before the socket
   *  opens. Absent: no ticket is sent (the phone's path, an agent thread's own command). */
  mintTicket?: (target: CardTarget) => Promise<CardActionResult<string>>;
  rows?: number;
  /** Fires ONCE, when the socket ends. `code` is null when it died without one. `exited`: the
   *  server's exit frame arrived (the process really ended). `opened`: the socket ever opened;
   *  a refused start (busy, no PTY, a closed card) never does. */
  onExit: (result: { code: number | null; tail: string; exited: boolean; opened: boolean }) => void;
  onStatus?: (status: InlineTermStatus) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  // Everything below is per-MOUNT and must not re-run: a reconnect would run the command a
  // SECOND time. The effect has an empty dependency list on purpose and reads its inputs
  // from a ref — a card's command never changes under it (a different command is a
  // different card with a different key), and if it ever could, silently re-running a
  // deploy would be the wrong answer to it.
  const argsRef = useRef({ vault, command, cwd, rows, card, mintTicket });
  const onExitRef = useRef(onExit);
  const onStatusRef = useRef(onStatus);
  onExitRef.current = onExit;
  onStatusRef.current = onStatus;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const { vault: v, command: cmd, cwd: dir, rows: wantRows, card: target, mintTicket } = argsRef.current;

    const { term, fit, fontFamily, primaryMono, stopThemeSync } = createStyledTerm({ scrollback: 2000 });

    let tail = '';
    let settled = false;
    let disposed = false;
    let opened = false;
    let revealTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = (code: number | null, exited = false) => {
      if (settled) return;
      settled = true;
      onStatusRef.current?.(code === null ? 'failed' : 'exited');
      onExitRef.current({ code, tail: finishTail(tail), exited, opened });
    };
    // Only a terminal the user opened with ▶ (or a thread card's own) scrolls into view and takes
    // the keyboard. One that mounts by itself to watch a run started on the phone or Telegram
    // stays passive until clicked: keys typed in the composer must never reach a running prompt.
    const userOpened = !target || target.start;

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const params = new URLSearchParams({ vault: v, kind: 'exec', cmd, theme: currentTermTheme(), bypass: '0' });
    if (dir) params.set('cwd', dir);
    let ws: WebSocket | null = null;

    const sendResize = () => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      try { fit.fit(); } catch { return; }
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };

    const connect = (ticket?: string) => {
      if (disposed) return;
      const sock = new WebSocket(target
        ? `${proto}://${location.host}${cardTerminalUrl(target, currentTermTheme(), ticket)}`
        : `${proto}://${location.host}/api/agent/terminal?${params.toString()}`);
      ws = sock;
      // Binary frames are the server's control channel (`{type:'exit', code}`); output is
      // always text. arraybuffer so the exit can be decoded synchronously in onmessage.
      sock.binaryType = 'arraybuffer';
      sock.onopen = () => { opened = true; onStatusRef.current?.('running'); sendResize(); };
      sock.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          tail = appendTail(tail, ev.data);
          term.write(ev.data);
          return;
        }
        try {
          const msg = JSON.parse(new TextDecoder().decode(ev.data as ArrayBuffer)) as { type?: string; code?: number };
          if (msg.type === 'exit') settle(typeof msg.code === 'number' ? msg.code : null, true);
        } catch { /* an unrecognized control frame is not ours to interpret */ }
      };
      // A socket that closes with no exit frame is a process whose fate we do not know — the
      // server went away, the upgrade was refused, node-pty is missing. That is `code: null`,
      // and the card says so rather than inventing a zero for the agent to act on.
      sock.onclose = () => settle(null);
      sock.onerror = () => {
        if (settled) return;
        setError(target
          ? 'Could not open this command\'s terminal. It may have finished, or it is no longer waiting.'
          : 'Could not reach the terminal bridge — the in-app terminal needs the desktop app.');
        settle(null);
      };
    };

    // GATE G1 (K4): every card-mode upgrade on the Mac carries a single-use ticket minted for THIS
    // press, right before the socket opens, bound to the command this card drew (`shown`). The
    // phone's own path carries its device session instead. No ticket, no socket: the refusal
    // reads the one line ("Open dreamcontext to run it"), never a silent no-op.
    if (target && !target.phone && mintTicket) {
      void mintTicket(target).then((r) => {
        if (disposed || settled) return;
        if (r.ok) { connect(r.value); return; }
        setError(r.message || OWNER_ONLY_LINE);
        settle(null);
      });
    } else {
      connect();
    }

    const dataSub = term.onData((data) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }));
    });

    openWhenFontsReady(primaryMono, () => {
      if (disposed || !host.isConnected) return;
      term.open(host);
      term.options.fontFamily = fontFamily;
      term.options.fontSize = BASE_FONT * currentZoom();
      term.resize(term.cols, wantRows);
      sendResize();
      // BRING IT INTO VIEW, and not as a courtesy. xterm suspends its write buffer AND its
      // keyboard handling while its element is outside the viewport — measured here, not
      // assumed: a card opened from the middle of a long conversation received `READY` on
      // the socket, never rendered it, and swallowed every keystroke, until the element was
      // scrolled into view; at that instant the buffered output painted and typing worked.
      // The card grows 300px when this mounts, which on its own pushes it off-screen, so
      // without this the FIRST click on ▶ would look like a dead button. `nearest` is a
      // no-op when it is already fully visible, so a card the user is looking at does not
      // jump. (The report handed to the agent is built from the SOCKET, never from what
      // xterm painted, so scrolling away mid-run costs the display, never the record.)
      // Twice, a beat apart, and `center` rather than `nearest`. The card growing by ~300px
      // is itself a content-height change, and the transcript answers those by re-pinning to
      // the bottom — so a single scroll issued in the same frame is undone before it has
      // had any effect. The second pass lands after that settles. `center` because
      // `nearest` is satisfied by the sliver of terminal that is already showing, which is
      // exactly the state where nothing renders.
      if (!userOpened) return;
      const reveal = () => { if (!disposed && host.isConnected) host.scrollIntoView({ block: 'center' }); };
      reveal();
      revealTimer = setTimeout(reveal, 250);
      term.focus();
    });

    const ro = new ResizeObserver(() => sendResize());
    ro.observe(host);

    return () => {
      disposed = true;
      if (revealTimer) clearTimeout(revealTimer);
      ro.disconnect();
      stopThemeSync();
      try { dataSub.dispose(); } catch { /* gone */ }
      // Closing the socket kills the PTY server-side (`ws.on('close')` → `term.kill()`), so
      // unmounting a running card stops its process instead of orphaning it. Staying mounted
      // is what keeps it alive — which is why a RUNNING card is never collapsed for the user.
      try { ws?.close(); } catch { /* already closing */ }
      try { term.dispose(); } catch { /* mid-init */ }
    };
  }, []);

  return (
    <div className="chat-runterm">
      <div className="chat-runterm-screen" ref={hostRef} />
      {error && <p className="chat-runterm-error">{error}</p>}
    </div>
  );
}
