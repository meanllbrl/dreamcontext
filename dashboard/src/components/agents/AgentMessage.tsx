import { useEffect, useMemo, useRef, useState } from 'react';
import { AgentAvatar } from './AgentAvatar';
import { AgentQuestionBlock } from './AgentQuestionBlock';
import { AgentSummaryBlock } from './AgentSummaryBlock';
import { BoardEmbed } from '../sleepy/chat/BoardEmbed';
import { graphContentUrl } from '../../api/client';
import { useVault } from '../../context/VaultContext';
import { useI18n } from '../../context/I18nContext';
import { isDesktop } from '../../lib/desktop';
import { openAutomationRunChat, runChatUnavailableReason } from '../../lib/automationRunChat';
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

export type AgentFileKind = 'board' | 'image' | 'doc';

/**
 * What a posted path should be DRAWN as. Extension-only and total: an unknown
 * type is a `doc`, which is the chip — the treatment that works for anything.
 */
export function agentFileKind(path: string): AgentFileKind {
  const lower = path.toLowerCase();
  if (lower.endsWith('.excalidraw.md')) return 'board';
  return RASTER_EXTENSIONS.some((ext) => lower.endsWith(ext)) ? 'image' : 'doc';
}

/**
 * THE FILES ON A POST — up to four, each drawn as what it is.
 *
 * Shared by the message and the thread panel so a document does not change
 * shape depending on which of the two you are reading it in.
 *
 * THE TWO ROUTES ARE NOT INTERCHANGEABLE, and picking the wrong one is how this
 * silently breaks outside the desktop app:
 *   • An IMAGE goes through `graphContentUrl` — `/api/graph/content`, which is
 *     vault-scoped and NOT desktop-gated, so a screenshot an agent posted is
 *     visible in a browser tab and on a phone over the tailnet.
 *   • A BOARD goes through `BoardEmbed`, whose asset pipeline is `/api/agent/*`
 *     and IS desktop-gated. Off-desktop it would render an empty canvas, so it
 *     degrades to a chip that says where boards open instead of drawing a lie.
 *   • Everything else is a chip that opens the existing file viewer.
 */
export function AgentFiles({
  files,
  onOpenFile,
}: {
  files: { path: string; name: string }[];
  onOpenFile: (path: string) => void;
}) {
  const { vault } = useVault();
  const { t } = useI18n();
  if (files.length === 0) return null;

  return (
    <div className="agent-msg-files">
      {files.map((f) => {
        const kind = agentFileKind(f.path);

        if (kind === 'board') {
          // `isDesktop()` rather than a capability probe: the board's assets are
          // fetched from a route that answers 403 off-desktop, and an empty
          // canvas reads as a broken board rather than an unavailable one.
          return isDesktop() ? (
            <BoardEmbed key={f.path} path={f.path} onOpenBoard={onOpenFile} />
          ) : (
            <button
              key={f.path}
              type="button"
              className="agent-msg-file"
              onClick={() => onOpenFile(f.path)}
              title={f.path}
            >
              <span className="agent-msg-file-glyph" aria-hidden="true">▦</span>
              <span className="agent-msg-file-name">{f.name}</span>
              <span className="agent-msg-file-note">{t('agents.boardDesktopOnly')}</span>
            </button>
          );
        }

        if (kind === 'image') {
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

        return (
          <button
            key={f.path}
            type="button"
            className="agent-msg-file"
            onClick={() => onOpenFile(f.path)}
            title={f.path}
          >
            <span className="agent-msg-file-glyph" aria-hidden="true">◧</span>
            <span className="agent-msg-file-name">{f.name}</span>
          </button>
        );
      })}
    </div>
  );
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
  // 1-based, newest-first — the same numbering `resolveRunSession` indexes by.
  const runNumber = useMemo(() => {
    const history = detail?.cache?.history ?? [];
    const idx = history.findIndex((e) => e.firedAt === message.runId);
    return idx >= 0 ? idx + 1 : null;
  }, [detail, message.runId]);
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

/** "4m 12s" / "41s". Matches the runner's own wording in the thread's system
 *  rows, so the same run never reports its length two different ways. */
function duration(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

/** Cost is shown to the cent below a dollar and to the cent above it — an
 *  automation's run is a few cents and `$0.3100000004` is not a number a human
 *  reads. Null (a run that never reported one) shows nothing at all rather
 *  than `$0.00`, which would claim it was free. */
function cost(usd: number | null): string | null {
  return usd === null || !Number.isFinite(usd) ? null : `$${usd.toFixed(2)}`;
}

export function AgentMessage({
  message,
  onOpenThread,
  onOpenFile,
  onOpenAgent,
  onToast,
  showHead = true,
}: {
  message: FeedMessage;
  onOpenThread: (m: FeedMessage) => void;
  onOpenFile: (path: string) => void;
  onOpenAgent: (slug: string) => void;
  /** Where an answer that could not be recorded is reported. Optional so the
   *  thread panel, which mounts this as its read-only root, need not pass one. */
  onToast?: (msg: string) => void;
  /** False inside the thread panel, where the message is the root and its
   *  header is already the panel's own. */
  showHead?: boolean;
}) {
  const { t } = useI18n();
  const meta = [duration(message.durationMs), cost(message.costUsd)].filter(Boolean).join(' · ');

  return (
    <>
      {/* THE ASK. A run the owner started by typing opens with their own words,
          as their own row — the exchange reads the way it happened, question
          then answer, rather than burying the question in a thread nobody
          opens. Not repeated inside the thread panel (`showHead === false`):
          the panel lists every entry already, this one included. */}
      {showHead && message.ask && (
        <article className="agent-msg agent-msg--you">
          <div className="agent-msg-av">
            <span className="agent-you-av" aria-hidden="true">You</span>
          </div>
          <div className="agent-msg-body">
            <div className="agent-msg-head">
              <span className="agent-msg-name agent-msg-name--plain">You</span>
              <span className="agent-msg-time">{hhmm(message.ask.at)}</span>
              <span className="agent-msg-meta">asked {message.title}</span>
            </div>
            <p className="agent-msg-text">{message.ask.text}</p>
          </div>
        </article>
      )}
    <article className={`agent-msg${message.unread ? ' agent-msg--unread' : ''}`}>
      <div className="agent-msg-av">
        <AgentAvatar
          slug={message.slug}
          title={message.title}
          hasPhoto={message.hasPhoto}
          size={36}
          version={message.runId}
        />
      </div>

      <div className="agent-msg-body">
        {showHead && (
          <div className="agent-msg-head">
            {/* The name opens the agent — the prototype's "click an agent's
                name" affordance. A button, not a link: it changes what this
                page shows, it does not navigate anywhere. */}
            <button type="button" className="agent-msg-name" onClick={() => onOpenAgent(message.slug)}>
              {message.title}
            </button>
            <span className="agent-msg-time">{hhmm(message.at)}</span>
            <span className={`agent-msg-status agent-msg-status--${message.status}`}>
              {STATUS_WORD[message.status]}
            </span>
            {/* A run can be FINISHED and still be waiting on you: it asked, the
                answer resumed it, it ran on and completed — and a second
                question is open, or the first never got answered. The status
                word describes the run; this says the reader still owes it
                something. Only when the two differ, or it would say it twice. */}
            {/* Its OWN class, not a second `.agent-msg-status`. Two elements
                sharing that class would make `.agent-msg-status` a multi-match
                locator, and the feed's verify script reads it with innerText() —
                a strict-mode violation the moment a run is both finished and
                still asking. The word is also not the run's status, so sharing
                the class was wrong twice over. */}
            {message.needsYou && message.status !== 'needs-you' && (
              <span className="agent-msg-needs">{t('agents.needsYou')}</span>
            )}
            {meta && <span className="agent-msg-meta">{meta}</span>}
          </div>
        )}

        {message.text ? (
          <p className={`agent-msg-text${message.textFrom === 'error' ? ' agent-msg-text--error' : ''}`}>
            {message.text}
          </p>
        ) : message.status === 'running' ? (
          // A run in flight has nothing to say YET. Saying so is the honest
          // state; an empty row reads as a message that failed to load.
          <p className="agent-msg-text agent-msg-text--quiet">Working…</p>
        ) : (
          <p className="agent-msg-text agent-msg-text--quiet">Nothing to report.</p>
        )}

        {/* WHERE THE WORDS CAME FROM. An agent that chose to post and an agent
            that said nothing (so we are showing its document's opening line)
            are different claims, and a reader deciding whether to open the
            thread is entitled to know which one they are looking at. */}
        {message.textFrom === 'result' && message.text && (
          <p className="agent-msg-from">from its document — it posted nothing</p>
        )}
        {message.textFrom === 'error' && message.text && (
          <p className="agent-msg-from">the run's own error — it never published</p>
        )}

        {/* THE FIGURES, between the words and the files. They belong to the
            post's prose — "WAU is down 4%" and the rows that show it are one
            statement — so they sit under it, above the attachments, which are
            things to go and open rather than things to read here. */}
        {message.summary && message.summary.length > 0 && (
          <AgentSummaryBlock rows={message.summary} />
        )}

        <AgentFiles files={message.files} onOpenFile={onOpenFile} />

        {/* THE QUESTION LAST, closest to the reply affordance. It is the reason
            to stop scrolling: everything above is a report, and this is the one
            thing the run cannot finish without. Only in the feed — the thread
            panel mounts this component headless as its root, and answering the
            same question twice on one screen is not an affordance. */}
        {showHead && message.question && onToast && (
          <AgentQuestionBlock
            slug={message.slug}
            title={message.title}
            question={message.question}
            onToast={onToast}
          />
        )}

        {/* The two controls are adjacent `.agent-msg-replies` buttons — both are
            inline-flex, so they sit on one line with the explicit space below
            and wrap together. No wrapper element, and so no new rule: this lane
            does not own the channel's stylesheet. */}
        {showHead && (
          <>
            {message.replyCount > 0 ? (
              <button type="button" className="agent-msg-replies" onClick={() => onOpenThread(message)}>
                <strong>
                  {message.replyCount} {message.replyCount === 1 ? 'reply' : 'replies'}
                </strong>
                {message.lastReplyAt && <span>last {hhmm(message.lastReplyAt)}</span>}
              </button>
            ) : (
              // "Reply in thread" now, not "Open thread": the step-2 wording was
              // deliberate — a control must not name an action it cannot perform —
              // and the reason it could not is gone. The panel this opens carries
              // a real composer.
              <button
                type="button"
                className="agent-msg-replies agent-msg-replies--quiet"
                onClick={() => onOpenThread(message)}
              >
                {t('agents.thread.reply')}
              </button>
            )}
            {' '}
            {/* Only where a toast can be reported: the ACK is the whole point of
                this button, and a surface with nowhere to say "couldn't open it"
                would swallow exactly the outcome the bridge exists to surface. */}
            {onToast && <OpenSessionButton message={message} onToast={onToast} />}
          </>
        )}
      </div>
    </article>
    </>
  );
}
