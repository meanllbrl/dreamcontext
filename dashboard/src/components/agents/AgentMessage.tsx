import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { AgentAvatar } from './AgentAvatar';
import { AgentQuestionBlock } from './AgentQuestionBlock';
import { AgentSummaryBlock } from './AgentSummaryBlock';
import { BoardEmbed } from '../sleepy/chat/BoardEmbed';
import { boardName } from '../sleepy/chat/BoardEmbed';
import { MediaEmbed } from '../sleepy/chat/MediaEmbed';
import { MarkdownPreview } from '../core/MarkdownPreview';
import { graphContentUrl } from '../../api/client';
import { useVault } from '../../context/VaultContext';
import { useI18n } from '../../context/I18nContext';
import { useAgentCapabilities } from '../../hooks/useAgentCapabilities';
import { markdownToText } from '../../lib/markdownToText';
import { middleTruncate } from '../../lib/fileLabel';
import { openAutomationRunChat, runChatUnavailableReason } from '../../lib/automationRunChat';
import { runDuration, useNow } from './agentRunState';
import {
  useAutomation, useAutomationSession, type FeedMessage, type FeedStatus,
} from '../../hooks/useAutomations';

/**
 * ONE RUN, AS ONE MESSAGE — the shape this whole step exists to get approved.
 *
 * Reading order is the design: who, when, how it went, then what it said. The
 * first three are one line of small type; the agent's own words get the room.
 *
 * A message is NOT a card. It has no border and no fill — it is a row in a
 * channel, the way Slack's is, because fifty bordered cards in a column read as
 * fifty things to deal with rather than a conversation to catch up on. The only
 * message that gets a surface of its own is an unread one, and that is an
 * accent BAR on the left edge, not a tint across the whole row (K8: the accent
 * budget is spent on pointing, never on decorating).
 */

/** The status WORD (K26/K40) — never a coloured pill. `needs-you` is the only
 *  one that is a call to action rather than a report, and it is the only one
 *  that earns a colour. */
const STATUS_WORD: Record<FeedStatus, string> = {
  running: 'running',
  done: 'done',
  failed: 'failed',
  timeout: 'timed out',
  'needs-you': 'needs you',
  skipped: "didn't run",
};

function hhmm(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * The image types the VAULT route will actually stream back.
 *
 * MIRRORS the raster half of `GRAPH_RAW_CONTENT_TYPE` (src/server/routes/graph.ts)
 * and must not drift from it: an extension listed here that the route does not
 * serve renders a broken image, and one the route serves but this omits shows a
 * chip for a picture we could have drawn.
 *
 * `.svg` IS DELIBERATELY ABSENT, on both sides. An SVG is a script-bearing
 * document, and `/api/graph/content` is generic — the Knowledge page hands its
 * URL to an iframe. It falls through to a chip here, which is the whole point.
 */
const RASTER_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
/** Media the same route streams with byte ranges — mirrors its `video/*` and `audio/*` rows. */
const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov'];
const AUDIO_EXTENSIONS = ['.mp3', '.m4a', '.wav'];

export type AgentFileKind = 'board' | 'image' | 'video' | 'audio' | 'pdf' | 'doc';

/**
 * What a posted path should be DRAWN as. Extension-only and total: an unknown
 * type is a `doc`, which is the card — the treatment that works for anything.
 */
export function agentFileKind(path: string): AgentFileKind {
  const lower = path.toLowerCase();
  const has = (list: string[]) => list.some((ext) => lower.endsWith(ext));
  if (lower.endsWith('.excalidraw.md')) return 'board';
  if (has(RASTER_EXTENSIONS)) return 'image';
  if (has(VIDEO_EXTENSIONS)) return 'video';
  if (has(AUDIO_EXTENSIONS)) return 'audio';
  if (lower.endsWith('.pdf')) return 'pdf';
  return 'doc';
}

/** The short type word a document card leads with: `PDF`, `MD`, `CSV`… */
function typeWord(name: string): string {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1) : '';
  return (ext || 'FILE').slice(0, 4).toUpperCase();
}

/**
 * THE FILES ON A POST — up to four, each drawn as what it is.
 *
 * Shared by the message and the thread panel so a document does not change
 * shape depending on which of the two you are reading it in. VISUALS FIRST (a
 * diagram, a screenshot, a clip is the thing to look at), then DOCUMENTS as a row
 * of cards (things to open). Every one opens through `onOpenFile`, and the page
 * routes that to the viewer the chat uses for the same type: a board fullscreen, a
 * picture in the lightbox, a PDF full window.
 *
 * `layout` is the surface. The THREAD draws every visual at the column's width;
 * the FEED draws the first one and folds the rest into cards, because a channel
 * row with four full-size visuals was taller than the window (1248px at 1000) and
 * pushed every other agent off screen. The thread is one click away and has room.
 *
 * PATHS: posts carry BRAIN-relative paths. The vault route (`graphContentUrl`)
 * takes them as they are; the board's pipeline is the chat's own and reads
 * PROJECT-relative paths, so a board gets the `_dream_context/` prefix — without
 * it, every board posted to a thread drew "couldn't be read".
 *
 * THE TWO ROUTES ARE NOT INTERCHANGEABLE, and picking the wrong one is how this
 * silently breaks outside the desktop app:
 *   • IMAGES and MEDIA go through `graphContentUrl` — `/api/graph/content`, which
 *     is vault-scoped and NOT desktop-gated, so a screenshot or a clip an agent
 *     posted plays in a browser tab and on a phone over the tailnet.
 *   • A BOARD goes through `BoardEmbed`, whose asset pipeline is `/api/agent/*`
 *     and IS desktop-gated. Whether it draws is therefore the SERVER's answer
 *     (`useAgentCapabilities`), not the client's own Tauri check: the two used to
 *     disagree, and a browser tab showed "boards open in the desktop app" on a card
 *     that then drew the board fullscreen when clicked. Where the server says no,
 *     the board is a plain card with that reason and nothing to click.
 */
export function AgentFiles({
  files,
  onOpenFile,
  layout = 'thread',
}: {
  files: { path: string; name: string }[];
  onOpenFile: (path: string) => void;
  layout?: 'feed' | 'thread';
}) {
  const { vault } = useVault();
  const { t } = useI18n();
  const desktop = useAgentCapabilities().data?.desktop === true;
  if (files.length === 0) return null;

  const visual = (k: AgentFileKind) => k === 'image' || k === 'video' || (k === 'board' && desktop);
  const typed = files.map((f) => ({ ...f, kind: agentFileKind(f.path) }));
  const allVisuals = typed.filter((f) => visual(f.kind));
  const shown = layout === 'feed' ? allVisuals.slice(0, 1) : allVisuals;
  const folded = layout === 'feed' ? allVisuals.slice(1) : [];
  const cards = typed.filter((f) => !visual(f.kind));

  return (
    <div className="agent-msg-files">
      {shown.map((f) => {
        if (f.kind === 'board') {
          return (
            <div key={f.path} className="agent-msg-board">
              <BoardEmbed path={`_dream_context/${f.path}`} onOpenBoard={() => onOpenFile(f.path)} />
            </div>
          );
        }
        if (f.kind === 'image') {
          return (
            <button
              key={f.path}
              type="button"
              className="agent-msg-img"
              onClick={() => onOpenFile(f.path)}
              title={f.path}
            >
              <img src={graphContentUrl(vault, f.path, { raw: true })} alt={f.name} loading="lazy" />
            </button>
          );
        }
        return <AgentClip key={f.path} path={f.path} name={f.name} onOpen={() => onOpenFile(f.path)} />;
      })}

      {folded.length + cards.length > 0 && (
        <div className="agent-msg-cards">
          {/* A visual the FEED folded: the same card a document gets, typed by what it is,
              opening the same viewer the full-size one would. */}
          {folded.map((f) => (
            <button
              key={f.path}
              type="button"
              className={`agent-msg-file agent-msg-file--folded agent-msg-file--${f.kind}`}
              onClick={() => onOpenFile(f.path)}
              title={f.path}
            >
              {f.kind === 'board'
                ? <span className="agent-msg-file-type agent-msg-file-type--glyph" aria-hidden="true">▦</span>
                : <span className="agent-msg-file-type" aria-hidden="true">{typeWord(f.name)}</span>}
              <span className="agent-msg-file-text">
                <span className="agent-msg-file-name">
                  {f.kind === 'board' ? boardName(f.path) : middleTruncate(f.name, 40)}
                </span>
              </span>
            </button>
          ))}
          {cards.map((f) => {
            if (f.kind === 'audio') {
              return (
                <div key={f.path} className="agent-msg-file agent-msg-file--audio" title={f.path}>
                  <span className="agent-msg-file-type agent-msg-file-type--glyph" aria-hidden="true">♪</span>
                  <span className="agent-msg-file-text">
                    {/* The name and Open share a line above the player: beside it, the
                        player's own width ran over the button. */}
                    <span className="agent-msg-audio-head">
                      <span className="agent-msg-file-name">{middleTruncate(f.name, 40)}</span>
                      <button type="button" className="agent-msg-media-open" onClick={() => onOpenFile(f.path)}>
                        {t('agents.file.open')}
                      </button>
                    </span>
                    <MediaEmbed kind="audio" src={graphContentUrl(vault, f.path, { raw: true })} />
                  </span>
                </div>
              );
            }
            if (f.kind === 'board') {
              // The server will not serve this board's canvas here, so there is nothing to
              // open either: a card that says where boards open, and no click that pretends.
              return (
                <div key={f.path} className="agent-msg-file agent-msg-file--board" title={f.path}>
                  <span className="agent-msg-file-type agent-msg-file-type--glyph" aria-hidden="true">▦</span>
                  <span className="agent-msg-file-text">
                    <span className="agent-msg-file-name">{boardName(f.path)}</span>
                    <span className="agent-msg-file-note">{t('agents.boardDesktopOnly')}</span>
                  </span>
                </div>
              );
            }
            // A document is led by its type word ("PDF", "MD") and named; a filler note
            // under the name ("Document") said nothing the type square had not.
            return (
              <button
                key={f.path}
                type="button"
                className={`agent-msg-file agent-msg-file--${f.kind}`}
                onClick={() => onOpenFile(f.path)}
                title={f.path}
              >
                <span className="agent-msg-file-type" aria-hidden="true">{typeWord(f.name)}</span>
                <span className="agent-msg-file-text">
                  <span className="agent-msg-file-name">{middleTruncate(f.name, 40)}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * A posted clip, PLAYING in the post.
 *
 * Its box is reserved before the file says anything: 16:9 until `loadedmetadata`,
 * then the clip's own ratio. Without the reservation every clip loaded at the
 * browser's default height and then jumped (a media post grew 910 → 1330px as its
 * clips arrived), and without the clip's own ratio a portrait reel played as a thin
 * strip between two slabs of black. The ratio drives the figure's width through
 * `--agent-clip-ratio` (AgentsFeed.css), within the chat's media caps.
 */
function AgentClip({ path, name, onOpen }: { path: string; name: string; onOpen: () => void }) {
  const { vault } = useVault();
  const { t } = useI18n();
  const [ratio, setRatio] = useState<number | null>(null);
  const style = ratio === null ? undefined : ({ '--agent-clip-ratio': String(ratio) } as CSSProperties);
  return (
    <figure className="agent-msg-video" style={style}>
      <MediaEmbed kind="video" src={graphContentUrl(vault, path, { raw: true })} onRatio={setRatio} />
      <figcaption className="agent-msg-media-cap">
        <span className="agent-msg-file-name" title={name}>{middleTruncate(name, 40)}</span>
        <button type="button" className="agent-msg-media-open" onClick={onOpen}>
          {t('agents.file.open')}
        </button>
      </figcaption>
    </figure>
  );
}

/** What each kind of file is called in the ask preview's "what came back" line. A PDF
 *  and a plain document used to share one glyph; they are different things to open. */
const KIND_GLYPH: Record<AgentFileKind, string> = {
  board: '▦', image: '▣', video: '▶', audio: '♪', pdf: '◧', doc: '▤',
};

/**
 * The thread's attachments as the ask preview names them — what came back, by kind,
 * so "it made a diagram and a PDF" reads without opening the thread. One PART per
 * file, each cut on its own (in the middle, so the distinguishing end survives) and
 * carrying its full name as a title: one ellipsis over the whole line used to hide
 * every file after a long first name.
 */
export function attachmentParts(
  files: { path: string; name: string }[],
): { key: string; glyph: string; label: string; title: string }[] {
  return files.map((f) => {
    const kind = agentFileKind(f.path);
    return {
      key: f.path,
      glyph: KIND_GLYPH[kind],
      label: kind === 'board' ? boardName(f.path) : middleTruncate(f.name, 24),
      title: f.name,
    };
  });
}

/**
 * OPEN SESSION — this run's own conversation, reopened as a chat tab.
 *
 * Through the EXISTING bridge (`openAutomationRunChat`), never a second one: its
 * ACK contract is what makes the button honest. `dispatchEvent` runs every
 * listener synchronously, so `accepted` is readable on the next line, and a
 * surface that is not mounted / not desktop / has Agents switched off answers
 * `false` — which is reported rather than swallowed. A button that silently
 * does nothing is the failure that contract exists to make impossible.
 *
 * WHY IT RESOLVES LAZILY. The bridge needs a `sessionId`, and the only route
 * that has one is keyed by RUN NUMBER (1-based, newest first) while a feed
 * message knows its `runId` (the fire time). The mapping lives in the run
 * history, so both reads are armed by the click rather than paid for by every
 * message in the channel on every poll.
 */
function OpenSessionButton({ message, onToast }: { message: FeedMessage; onToast: (m: string) => void }) {
  const { t } = useI18n();
  const { bus } = useVault();
  const [armed, setArmed] = useState(false);
  /** One dispatch per arming. The queries re-deliver cached data on every
   *  render, and a second dispatch would ask the surface to reopen a tab it
   *  just opened. */
  const sent = useRef(false);

  const { data: detail } = useAutomation(armed ? message.slug : null);
  // 1-based, newest-first — the same numbering `resolveRunSession` indexes by. Keyed by
  // `sessionRunId`, not `runId`: a resumed @mention turn has no history row of its own, and
  // the session it continued belongs to the run the server names there.
  const runNumber = useMemo(() => {
    const history = detail?.cache?.history ?? [];
    const idx = history.findIndex((e) => e.firedAt === message.sessionRunId);
    return idx >= 0 ? idx + 1 : null;
  }, [detail, message.sessionRunId]);
  const { data: session } = useAutomationSession(armed && runNumber !== null ? message.slug : null, runNumber);

  useEffect(() => {
    if (!armed || sent.current) return;
    // The history has loaded and this run is not in it: a run the cache never
    // recorded (an @mention turn) has no session row to open.
    if (detail && runNumber === null) {
      sent.current = true;
      setArmed(false);
      onToast(t('agents.openSessionFailed'));
      return;
    }
    if (!session) return;
    sent.current = true;
    setArmed(false);
    const reason = runChatUnavailableReason(session);
    if (reason) { onToast(reason); return; }
    const accepted = openAutomationRunChat(bus, {
      slug: message.slug,
      automationTitle: message.title,
      runNumber: session.runNumber,
      sessionId: session.sessionId as string,
      firedAt: session.firedAt,
      status: session.status,
      costUsd: session.costUsd,
      numTurns: session.numTurns,
      durationMs: message.durationMs,
      outputPath: session.outputPath,
    });
    if (!accepted) onToast(t('agents.openSessionFailed'));
  }, [armed, detail, runNumber, session, bus, message, onToast, t]);

  return (
    // `--quiet` for the same reason "Open thread" wears it: a way IN, not a
    // highlight, so it does not spend the accent (K8).
    <button
      type="button"
      className="agent-msg-replies agent-msg-replies--quiet"
      onClick={() => { sent.current = false; setArmed(true); }}
    >
      {t('agents.openSession')}
    </button>
  );
}

/** Cost is shown to the cent below a dollar and to the cent above it — an
 *  automation's run is a few cents and `$0.3100000004` is not a number a human
 *  reads. Null (a run that never reported one) shows nothing at all rather
 *  than `$0.00`, which would claim it was free. */
function cost(usd: number | null): string | null {
  return usd === null || !Number.isFinite(usd) ? null : `$${usd.toFixed(2)}`;
}

/**
 * An agent's words, set the way the chat sets them — markdown, the chat's reading size and
 * leading — rather than as a raw `pre-wrap` paragraph. A run writes markdown (bold, lists,
 * backticked paths), and printing its asterisks is what made the channel harder to read than
 * the chat it sits beside. No card here: a channel row is not a bubble (see the header note);
 * the thread panel is where an answer gets the chat's full card.
 */
export function AgentProse({ text, className = '' }: { text: string; className?: string }) {
  return (
    <div className={`agent-msg-md ${className}`.trim()}>
      <MarkdownPreview content={text} />
    </div>
  );
}

/**
 * THE SLACK THREAD LINE — faces, "N replies", when the last one landed, and a way in.
 *
 * The faces are who spoke in the thread. We know the agent did whenever it answered; a reply
 * of yours is counted but not attributed per author on the wire, so the stack stays honest
 * and shows only the face we are sure of.
 *
 * The count is the SERVER's (`replyCount`, `threadReplies` in feed.ts): the rows the thread
 * draws under its root, the report included. The feed used to add the answer here while the
 * panel added it there, and the same ask read "1 reply" in one and "2 replies" in the other.
 */
function ThreadBar({
  message,
  replies,
  lastAt,
  open,
  panelId,
  onOpen,
}: {
  message: FeedMessage;
  replies: number;
  lastAt: string | null;
  open: boolean;
  panelId?: string;
  onOpen: (opener: HTMLElement) => void;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className="agent-thread-bar"
      onClick={(e) => onOpen(e.currentTarget)}
      aria-expanded={open}
      aria-controls={open ? panelId : undefined}
    >
      {replies > 0 && (
        <span className="agent-thread-bar-faces" aria-hidden="true">
          <AgentAvatar slug={message.slug} title={message.title} hasPhoto={message.hasPhoto} size={20} version={message.runId} />
        </span>
      )}
      {replies > 0 ? (
        <>
          <strong className="agent-thread-bar-count">
            {replies} {replies === 1 ? 'reply' : 'replies'}
          </strong>
          {/* "Last reply" stays where it is and "View thread ›" is APPENDED after it, shown
              on hover. The two used to share one grid cell and crossfade, and two strings of
              different length fading through each other were legible at no point of the fade.
              The hover label is hidden from the accessible name: it is the same action the
              button already is, and reading both said it twice. */}
          {lastAt && (
            <span className="agent-thread-bar-last">{t('agents.thread.lastReply').replace('{time}', hhmm(lastAt))}</span>
          )}
          <span className="agent-thread-bar-go" aria-hidden="true">
            {t('agents.thread.view')}
            <span className="agent-thread-bar-chev">›</span>
          </span>
        </>
      ) : (
        <span className="agent-thread-bar-quiet">{t('agents.thread.reply')}</span>
      )}
    </button>
  );
}

export function AgentMessage({
  message,
  onOpenThread,
  onOpenFile,
  onOpenAgent,
  onToast,
  variant = 'feed',
  threadOpen = false,
  panelId,
  runStartedAt,
}: {
  message: FeedMessage;
  /** `opener` is the control that was used, so closing the thread can give it focus back. */
  onOpenThread: (m: FeedMessage, opener: HTMLElement) => void;
  onOpenFile: (path: string) => void;
  onOpenAgent: (slug: string) => void;
  /** Where an answer that could not be recorded is reported. Optional so the
   *  thread panel, which mounts this as its read-only root, need not pass one. */
  onToast?: (msg: string) => void;
  /** `root` inside the thread panel, where the message is the thread's first row: it is
   *  named and timed like every other row there, and carries none of the feed's chrome
   *  (no unread bar, no question, no thread line). */
  variant?: 'feed' | 'root';
  /** This message's thread is the one open in the panel (the thread line's `aria-expanded`). */
  threadOpen?: boolean;
  /** The open panel's id, for the thread line's `aria-controls`. */
  panelId?: string;
  /** When this agent's run slot was taken (epoch ms, `runSlots[slug].startedAt`), so a running
   *  row can show how long it has been going. Absent, the run's own fire time stands in. */
  runStartedAt?: number | null;
}) {
  const { t } = useI18n();
  const running = message.status === 'running';
  // Called on every render, before the ask row's early return: a hook's order cannot depend on
  // which kind of row this is.
  const now = useNow(running);
  const startedAt = runStartedAt ?? Date.parse(message.ask?.at ?? message.at);
  const elapsed = running && Number.isFinite(startedAt) ? runDuration(now - startedAt) : null;
  const meta = running
    ? null
    : [runDuration(message.durationMs), cost(message.costUsd)].filter(Boolean).join(' · ');
  const root = variant === 'root';
  const open = !root && threadOpen;

  /**
   * A run's status word, and while it runs, the thing that says it is ALIVE: a dot that
   * breathes (motion carries "in progress", the word keeps carrying the status, per
   * `orthogonal-encoding-channels`) and the time since it started, climbing each second. A
   * hung run is then visible as a timer nobody stopped, where it used to look exactly like a
   * dead one.
   */
  const statusWord = (
    <span className={`agent-msg-status agent-msg-status--${message.status}`}>
      {running && <span className="agent-msg-live-dot" aria-hidden="true" />}
      {STATUS_WORD[message.status]}
    </span>
  );
  const metaLine = running
    ? elapsed && <span className="agent-msg-meta agent-msg-elapsed">{elapsed}</span>
    : meta && <span className="agent-msg-meta">{meta}</span>;
  /** The row whose thread is open keeps a "you are here" mark until the panel closes. */
  const openProps = open ? { 'aria-current': 'true' as const } : {};

  // ── AN ASK IS A THREAD ON YOUR MESSAGE ─────────────────────────────────────
  //
  // The owner's words, Slack's shape: when you ask an agent something, the channel shows
  // YOUR message, and the answer lives in its thread — its opening line previewed inside
  // your message so the exchange reads at a glance, and the whole answer one click away.
  // The agent's reply used to be a second top-level row under yours, which made every
  // question two messages to scroll past and put the detail nowhere.
  if (!root && message.ask) {
    const parts = attachmentParts(message.files);
    return (
      <article
        className={`agent-msg agent-msg--you${message.unread ? ' agent-msg--unread' : ''}${open ? ' agent-msg--open' : ''}`}
        {...openProps}
      >
        <div className="agent-msg-av">
          <span className="agent-you-av" aria-hidden="true">You</span>
        </div>
        <div className="agent-msg-body">
          <div className="agent-msg-head">
            <span className="agent-msg-name agent-msg-name--plain">You</span>
            <span className="agent-msg-time">{hhmm(message.ask.at)}</span>
            <span className="agent-msg-meta">
              to{' '}
              <button type="button" className="agent-msg-to" onClick={() => onOpenAgent(message.slug)}>
                {message.title}
              </button>
            </span>
          </div>
          <AgentProse text={message.ask.text} />

          {/* THE ANSWER'S OPENING, inside your message. A preview, not the answer: it is
              clamped, and clicking it opens the thread where the whole thing is. It is
              PROSE — the answer's markdown with its syntax taken out — because a clamp of
              three lines cannot hold a list or a table, and printing `**31%**` with its
              asterisks (and a blank line eating one of the three) was the complaint. Its
              name is the action, not the whole card read aloud. */}
          <button
            type="button"
            className={`agent-reply-preview${message.status === 'running' ? ' agent-reply-preview--running' : ''}`}
            onClick={(e) => onOpenThread(message, e.currentTarget)}
            aria-label={t('agents.preview.open').replace('{name}', message.title)}
          >
            <span className="agent-reply-preview-head">
              <AgentAvatar slug={message.slug} title={message.title} hasPhoto={message.hasPhoto} size={20} version={message.runId} />
              <span className="agent-reply-preview-name">{message.title}</span>
              {statusWord}
              {metaLine}
            </span>
            {/* A failed run's text is its REASON, not an answer, so it wears the reason's
                ink rather than the answer's. */}
            <span
              className={`agent-reply-preview-text${message.textFrom === 'error' ? ' agent-reply-preview-text--error' : ''}`}
            >
              {running && !message.text
                // When it started, not only that it is working: with the timer in the head, a
                // run that has been "working" since this morning says so.
                ? (Number.isFinite(startedAt)
                  ? t('agents.run.startedAt').replace('{time}', hhmm(new Date(startedAt).toISOString()))
                  : t('agents.thread.working'))
                : message.text ? markdownToText(message.text) : t('agents.nothingToReport')}
            </span>
            {parts.length > 0 && (
              <span className="agent-reply-preview-files">
                {parts.map((p, i) => (
                  <Fragment key={p.key}>
                    {i > 0 && <span className="agent-reply-preview-sep" aria-hidden="true"> · </span>}
                    <span className="agent-reply-preview-file" title={p.title}>{p.glyph} {p.label}</span>
                  </Fragment>
                ))}
              </span>
            )}
          </button>

          {message.question && onToast && (
            <AgentQuestionBlock
              slug={message.slug}
              title={message.title}
              question={message.question}
              onToast={onToast}
            />
          )}

          <div className="agent-msg-actions">
            <ThreadBar
              message={message}
              replies={message.replyCount}
              lastAt={message.lastReplyAt}
              open={threadOpen}
              panelId={panelId}
              onOpen={(opener) => onOpenThread(message, opener)}
            />
            {/* Only a run the cache recorded, and that actually ran, has a session to
                reopen. Offering it on a running or skipped run only ever toasted
                "Couldn't open the session". */}
            {onToast && message.sessionOpenable && <OpenSessionButton message={message} onToast={onToast} />}
          </div>
        </div>
      </article>
    );
  }

  return (
    <article
      className={`agent-msg${root ? ' agent-msg--root' : ''}${!root && message.unread ? ' agent-msg--unread' : ''}${open ? ' agent-msg--open' : ''}`}
      {...openProps}
    >
      <div className="agent-msg-av">
        <AgentAvatar
          slug={message.slug}
          title={message.title}
          hasPhoto={message.hasPhoto}
          size={32}
          version={message.runId}
        />
      </div>

      <div className="agent-msg-body">
        {root ? (
          // THE THREAD'S ROOT is named and timed like every row under it. The name is
          // plain text here: the panel is already about this agent, so it opens nothing.
          <div className="agent-msg-head">
            <span className="agent-msg-name agent-msg-name--plain">{message.title}</span>
            <span className="agent-msg-time">{hhmm(message.at)}</span>
            {statusWord}
            {metaLine}
          </div>
        ) : (
          <div className="agent-msg-head">
            {/* The name opens the agent — the prototype's "click an agent's
                name" affordance. A button, not a link: it changes what this
                page shows, it does not navigate anywhere. */}
            <button type="button" className="agent-msg-name" onClick={() => onOpenAgent(message.slug)}>
              {message.title}
            </button>
            <span className="agent-msg-time">{hhmm(message.at)}</span>
            {statusWord}
            {/* A run can be FINISHED and still be waiting on you: it asked, the
                answer resumed it, it ran on and completed — and a second
                question is open, or the first never got answered. The status
                word describes the run; this says the reader still owes it
                something. Only when the two differ, or it would say it twice.
                Its OWN class, not a second `.agent-msg-status`: the feed's
                verify script reads that class with innerText(), and the word
                is not the run's status anyway. */}
            {message.needsYou && message.status !== 'needs-you' && (
              <span className="agent-msg-needs">{t('agents.needsYou')}</span>
            )}
            {metaLine}
          </div>
        )}

        {message.text ? (
          message.textFrom === 'error' || message.textFrom === 'skipped'
            ? <p className="agent-msg-text agent-msg-text--error">{message.text}</p>
            : <AgentProse text={message.text} />
        ) : message.status === 'running' ? (
          // A run in flight has nothing to say YET. Saying so is the honest
          // state; an empty row reads as a message that failed to load.
          <p className="agent-msg-text agent-msg-text--quiet">{t('agents.thread.working')}</p>
        ) : (
          <p className="agent-msg-text agent-msg-text--quiet">{t('agents.nothingToReport')}</p>
        )}

        {/* WHERE THE WORDS CAME FROM. An agent that chose to post and an agent
            that said nothing (so we are showing its document's opening line)
            are different claims, and a reader deciding whether to open the
            thread is entitled to know which one they are looking at. A
            caption, kept on purpose (the owner's call). */}
        {message.textFrom === 'result' && message.text && (
          <p className="agent-msg-from">{t('agents.from.result')}</p>
        )}
        {message.textFrom === 'error' && message.text && (
          <p className="agent-msg-from">{t('agents.from.error')}</p>
        )}

        {/* THE FIGURES, between the words and the files. They belong to the
            post's prose — "WAU is down 4%" and the rows that show it are one
            statement — so they sit under it, above the attachments. */}
        {message.summary && message.summary.length > 0 && (
          <AgentSummaryBlock rows={message.summary} />
        )}

        {root
          ? <AgentFiles files={message.files} onOpenFile={onOpenFile} layout="thread" />
          : <AgentFiles files={message.files} onOpenFile={onOpenFile} layout="feed" />}

        {/* THE QUESTION LAST, closest to the reply affordance. Only in the feed —
            the thread panel mounts this component as its root, and answering the
            same question twice on one screen is not an affordance. */}
        {!root && message.question && onToast && (
          <AgentQuestionBlock
            slug={message.slug}
            title={message.title}
            question={message.question}
            onToast={onToast}
          />
        )}

        {!root && (
          <div className="agent-msg-actions">
            <ThreadBar
              message={message}
              replies={message.replyCount}
              lastAt={message.lastReplyAt}
              open={threadOpen}
              panelId={panelId}
              onOpen={(opener) => onOpenThread(message, opener)}
            />
            {/* Only where a toast can be reported: the ACK is the whole point of
                this button, and a surface with nowhere to say "couldn't open it"
                would swallow exactly the outcome the bridge exists to surface. And
                only on a run that has a session to open. */}
            {onToast && message.sessionOpenable && <OpenSessionButton message={message} onToast={onToast} />}
          </div>
        )}
      </div>
    </article>
  );
}
