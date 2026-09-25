import {
  Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  useAgentThread, useAutomations, useProjectSlashCommands, useReplyDelivery, useReplyToAgentThread,
  useSetAutomationEnabled,
  type FeedMessage, type RunAnswer, type ThreadEntry,
} from '../../hooks/useAutomations';
import { AgentAvatar } from './AgentAvatar';
import { AgentFiles, AgentMessage, AgentProse } from './AgentMessage';
import { trimFailureEcho } from './agentRunState';
import { ProseSegment } from '../sleepy/chat/TranscriptItem';
// The answer is drawn with the chat's own card (`.chat-msg-assistant-body`), whose rules
// live here — imported by the panel that uses them rather than borrowed from whichever
// surface happened to load first, as the meeting room does.
import '../sleepy/chat/cards.css';
// The close button is the chat's own SlideOver close atom (`.chat-slideover-close`), from here.
import '../sleepy/chat/overlays.css';
import { AgentQuestionBlock } from './AgentQuestionBlock';
import { AgentSummaryBlock } from './AgentSummaryBlock';
import { useAgentThreadHost } from './agentsChannelHost';
import { Composer } from '../sleepy/chat/Composer';
import { useAgentModelConfig } from '../../hooks/useAgentCapabilities';
import { FALLBACK_MODEL_CONFIG } from '../../lib/agentComposer';
import { readAgentSettings } from '../../lib/agentSettings';
import { useI18n } from '../../context/I18nContext';

/**
 * ONE RUN'S THREAD, on the right — and where a reply is written.
 *
 * The panel shows what the feed deliberately leaves out: the run's own
 * bookkeeping. `started`, `ok`, `failed`, `asked` are grey one-line rows here
 * and appear nowhere else — in the feed they would be four rows of noise per
 * run, and the feed's job is to be readable at a glance.
 *
 * Entries are listed in ID order, never by `at`: two machines' clocks disagree
 * and the id is what survives that.
 *
 * THE COMPOSER IS THE CHAT'S OWN, mounted through `useAgentThreadHost` — the
 * same adapter the channel uses, with the address gate removed because a thread
 * has one recipient. It is NOT drawn at all when the agent is turned off or
 * unapproved: the server refuses those before it looks at anything else
 * (`reply_disabled` / `reply_unapproved`), so a field there would be a control
 * whose every use is already decided against.
 *
 * REFUSALS SPEAK THE SERVER'S OWN SENTENCE. Every rung of that ladder is written
 * for a human already (`not_bound`, `question_pending`, `busy`, `stale_run`),
 * and re-authoring them here would put one refusal in two vocabularies. The one
 * exception is `stale_run`, which is translated — it is the only rung a user
 * reaches by ordinary use rather than by a state they can see.
 */

function hhmm(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** A system row's own words, already written by the runner. The panel adds the
 *  time and nothing else — re-phrasing them here would put the same event in
 *  two vocabularies, one of which would go stale. The one liberty: a failure row
 *  whose reason the root already shows is cut to its new fact, "Failed after 3s"
 *  (`trimFailureEcho`), so the thread does not say one sentence twice. */
function SystemRow({ entry, rootText }: { entry: ThreadEntry; rootText: string | null }) {
  const text = entry.event === 'failed' || entry.event === 'timeout'
    ? trimFailureEcho(entry.text, rootText)
    : entry.text;
  return (
    <div className="agent-thread-sys">
      <span className="agent-thread-sys-time">{hhmm(entry.at)}</span>
      <span className="agent-thread-sys-text">{text}</span>
    </div>
  );
}

/** Who wrote a thread row: your placeholder face, or the agent's photo. One size for both. */
function RowFace({ who, message }: { who: 'user' | 'agent'; message: FeedMessage }) {
  return who === 'user'
    ? <span className="agent-you-av" aria-hidden="true">You</span>
    : <AgentAvatar slug={message.slug} title={message.title} hasPhoto={message.hasPhoto} size={32} version={message.runId} />;
}

function AuthoredRow({
  entry,
  message,
  onOpenFile,
}: {
  entry: ThreadEntry;
  message: FeedMessage;
  onOpenFile: (path: string) => void;
}) {
  return (
    <div className={`agent-thread-post agent-thread-post--${entry.kind}`}>
      <RowFace who={entry.kind === 'user' ? 'user' : 'agent'} message={message} />
      <div className="agent-thread-post-main">
      <div className="agent-thread-post-head">
        <span className="agent-thread-post-who">{entry.kind === 'user' ? 'You' : message.title}</span>
        <span className="agent-thread-post-time">{hhmm(entry.at)}</span>
      </div>
      <AgentProse text={entry.text} className="agent-thread-post-text" />
      {entry.summary && entry.summary.length > 0 && <AgentSummaryBlock rows={entry.summary} />}
      {/* The SAME renderer the feed uses, on purpose: a board that draws itself
          in the message and turns into a dead filename in the thread would make
          the panel look like a downgrade of the row that opened it. The files
          here are the entry's own brain-relative paths, which is exactly what
          `AgentFiles` takes. */}
      {entry.files && entry.files.length > 0 && (
        <AgentFiles
          files={entry.files.map((f) => ({ path: f, name: f.split('/').pop() ?? f }))}
          onOpenFile={onOpenFile}
        />
      )}
      </div>
    </div>
  );
}

/**
 * THE WHOLE ANSWER — the run's published document, as a reply from the agent.
 *
 * This is the detail the feed's one line stands for. It is drawn with the chat's own answer
 * card (`ProseSegment`: markdown, the chat's reading size and leading, clickable paths, code
 * blocks with Copy), so reading an agent's report here is the same experience as reading an
 * answer in Chat — which is what the owner asked for, and what a plain paragraph was not.
 */
function AnswerRow({
  answer,
  message,
  onOpenFile,
}: {
  answer: RunAnswer;
  message: FeedMessage;
  onOpenFile: (path: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="agent-thread-post agent-thread-post--agent agent-thread-answer">
      <RowFace who="agent" message={message} />
      <div className="agent-thread-post-main">
        <div className="agent-thread-post-head">
          <span className="agent-thread-post-who">{message.title}</span>
          <button
            type="button"
            className="agent-thread-answer-file"
            onClick={() => onOpenFile(answer.path)}
            title={answer.path}
          >
            {answer.path.split('/').pop()}
          </button>
        </div>
        {answer.text
          ? <ProseSegment text={answer.text} onOpenFile={onOpenFile} />
          // A document that is only frontmatter is still the run's document: the pill above
          // opens it, and this says why there is nothing to read here.
          : <p className="agent-thread-note">{t('agents.thread.answerEmpty')}</p>}
        {answer.truncated && (
          <p className="agent-thread-note">{t('agents.thread.more')}</p>
        )}
      </div>
    </div>
  );
}

/**
 * The one line under the field: what this machine's last reply turn did.
 *
 * `unknown` is the server-restart case and is the only status whose copy is
 * OURS — the job that owned the sentence died with the process, so there is no
 * server wording to quote and `t()` is the honest source. Every other non-ok
 * status carries `reason`, which is the server's own.
 */
function deliveryNote(
  delivery: { status: string; reason: string | null } | undefined,
  t: (key: string) => string,
): { kind: 'error' | 'hint'; text: string } | null {
  if (!delivery) return null;
  switch (delivery.status) {
    case 'running': return { kind: 'hint', text: `${t('agents.thread.resumed')} · ${t('agents.thread.working')}` };
    case 'ok': return { kind: 'hint', text: t('agents.thread.finished') };
    case 'unknown': return { kind: 'error', text: t('agents.thread.unknown') };
    default: return { kind: 'error', text: delivery.reason ?? t('agents.thread.unknown') };
  }
}

/**
 * THE PANEL'S WIDTH — the reader's, remembered.
 *
 * A fixed 560px (at most half the row) squeezed the feed and the report alike at narrow widths,
 * and suited nobody at wide ones. So the left edge is a handle: drag it, or focus it and use the
 * arrow keys, and the width is kept on this machine for the next thread. The default is two
 * fifths of the row the panel shares with the feed; the floor keeps a report readable and the
 * ceiling keeps the channel beside it.
 */
const THREAD_WIDTH_KEY = 'dreamcontext.agents.threadWidth';
const THREAD_MIN_WIDTH = 360;
const THREAD_MAX_SHARE = 0.6;
const THREAD_DEFAULT_SHARE = 0.4;
/** One arrow-key press, in px. */
const THREAD_WIDTH_STEP = 16;

function readThreadWidth(): number | null {
  try {
    const n = Number.parseFloat(localStorage.getItem(THREAD_WIDTH_KEY) ?? '');
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function writeThreadWidth(px: number): void {
  try { localStorage.setItem(THREAD_WIDTH_KEY, String(Math.round(px))); } catch { /* private mode: not remembered */ }
}

export function AgentThreadPanel({
  message,
  onClose,
  onOpenFile,
  onOpenAgent,
  onToast,
  busyWith,
  closeOnEscape,
  autoFocus,
  footRef,
  panelId,
  overlay,
}: {
  message: FeedMessage;
  onClose: () => void;
  onOpenFile: (path: string) => void;
  onOpenAgent: (slug: string) => void;
  /** Where an answer that could not be recorded is reported — the inline
   *  question block needs one, and the panel has no toast surface of its own. */
  onToast?: (msg: string) => void;
  /** This thread's agent, by title, while it holds its own run slot; null otherwise. The
   *  server refuses a reply (`busy`) to an agent that is mid-run, so the field goes down and
   *  says so. Another agent's run never holds this one down. */
  busyWith: string | null;
  /** False while a file viewer is open over the page: Esc there closes the viewer, and
   *  must not close the thread under it in the same keystroke. */
  closeOnEscape: boolean;
  /** Move focus to the close button on open — a keyboard user who opened the thread lands
   *  in it rather than having to Tab through the whole channel to reach it. */
  autoFocus: boolean;
  /** The footer, measured by the page so the floating Agent button steps over it. */
  footRef: (el: HTMLElement | null) => void;
  /** The panel's id, which the thread line's `aria-controls` points at. */
  panelId: string;
  /** The channel is too narrow to split: the panel is drawn as Chat's SlideOver, over the
   *  channel inside its scrim, at the SlideOver's own width. No handle, no remembered width. */
  overlay: boolean;
}) {
  const { t } = useI18n();
  const { data, isLoading } = useAgentThread(message.slug, message.runId);
  const answer = data?.answer ?? null;
  // The thread's ROOT is drawn above the divider — your question for an ask, the agent's
  // post for a scheduled run — so its entry is not repeated as a reply under itself. The
  // server names it (`rootId`, the same rule its reply count uses); the ask rule is the
  // fallback for a response without it.
  const entries = useMemo(() => {
    const all = data?.entries ?? [];
    const rootId = data?.rootId ?? (message.ask ? all.find((e) => e.kind === 'user')?.id : undefined);
    return rootId ? all.filter((e) => e.id !== rootId) : all;
  }, [data, message.ask]);
  /** Where the whole answer goes: just before the row that ended the run, so it reads in
   *  the order it happened — the agent's posts while working, then its report, then
   *  "Finished" (or "Failed": a failed run's report is its reason, and it belongs before
   *  the row that announces the failure). A run with no terminal row yet puts it last. */
  const answerAt = useMemo(() => {
    if (!answer) return -1;
    const i = entries.findIndex((e) => e.kind === 'system'
      && (e.event === 'ok' || e.event === 'replied' || e.event === 'failed' || e.event === 'timeout'));
    return i >= 0 ? i : entries.length;
  }, [answer, entries]);
  // The server's count, the one the feed row prints too.
  const replyCount = data?.replyCount ?? message.replyCount;

  // ── Replying ──────────────────────────────────────────────────────────────
  //
  // The agent's own state decides whether a field is drawn at all. `enabled` and
  // `approved` are the first two rungs of the server's refusal ladder, so a
  // composer on an agent failing either is a control that can only ever be told
  // no — and the reader learns why from the note, next to the one thing that fixes it.
  const { data: automations } = useAutomations();
  const agent = useMemo(
    () => (automations ?? []).find((a) => a.slug === message.slug) ?? null,
    [automations, message.slug],
  );
  const setEnabled = useSetAutomationEnabled();
  const blocked: { text: string; action: string; run: () => void } | null = agent
    ? (!agent.enabled
      ? {
        text: t('agents.thread.off').replace('{name}', message.title),
        action: t('agents.thread.turnOn'),
        run: () => setEnabled.mutate({ slug: message.slug, enabled: true }),
      }
      : !agent.approved
        ? {
          text: t('agents.thread.unapproved').replace('{name}', message.title),
          action: t('agents.thread.review').replace('{name}', message.title),
          run: () => onOpenAgent(message.slug),
        }
        : null)
    : null;

  const reply = useReplyToAgentThread();
  const { data: delivery } = useReplyDelivery(message.slug, message.runId);
  /** A refusal the SERVER returned, which outranks the delivery note until the
   *  next send — it is the more specific thing that just happened. */
  const [refusal, setRefusal] = useState<string | null>(null);
  /** The question a `question_pending` refusal pointed at, rendered inline so
   *  answering happens where the refusal was read rather than back in the feed. */
  const [askInline, setAskInline] = useState(false);

  const noteRef = useRef<(n: { kind: 'error' | 'hint'; text: string } | null) => void>(() => {});
  const restoreRef = useRef<() => void>(() => {});
  const onSend = useCallback((text: string) => {
    setRefusal(null);
    setAskInline(false);
    reply.mutate({ slug: message.slug, runId: message.runId, text }, {
      onError: (err) => {
        const code = (err as { code?: string }).code ?? '';
        // `stale_run` is the one rung a user reaches by ordinary use — a
        // scheduled fire or someone's @mention opened a newer run while this
        // panel sat open — so it is the one with translated copy. Everything
        // else quotes the server, which wrote those sentences for a human.
        const text2 = code === 'stale_run' ? t('agents.thread.stale') : (err as Error).message;
        setRefusal(text2);
        noteRef.current({ kind: 'error', text: text2 });
        if (code === 'question_pending') setAskInline(true);
        // The composer emptied the field when the host accepted the send, before the
        // server answered. A refusal puts the words back, so a 409 costs a retry, never
        // the reply itself.
        restoreRef.current();
      },
    });
  }, [reply, message.slug, message.runId, t]);

  const slashCommands = useProjectSlashCommands().data?.commands;
  const { host, note, setNote, restoreLastSent } = useAgentThreadHost(
    { slug: message.slug, title: message.title, runId: message.runId },
    onSend,
    slashCommands,
  );
  noteRef.current = setNote;
  restoreRef.current = restoreLastSent;

  const modelConfig = useAgentModelConfig().data ?? FALLBACK_MODEL_CONFIG;
  const [model] = useState(() => readAgentSettings().chatDefaultModel);
  const [effort] = useState(() => readAgentSettings().chatDefaultEffort);

  // One sentence, one owner (K5): a server refusal outranks the delivery note,
  // and the host's own note (an empty reply) outranks both because it is the
  // thing the user did last.
  const footNote = note ?? (refusal ? { kind: 'error' as const, text: refusal } : deliveryNote(delivery, t));

  // ── Keyboard and focus ────────────────────────────────────────────────────
  const closeBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (autoFocus) closeBtn.current?.focus();
    // Once, on open: the panel remounts per thread, so "open" is "mount".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /** Esc closes the thread from anywhere inside it. A composer menu that is open consumes
   *  its own Esc first (it prevents default and stops the event), so Esc there closes the
   *  menu and only the next one closes the panel. */
  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Escape' || !closeOnEscape || e.defaultPrevented) return;
    e.preventDefault();
    onClose();
  };

  // ── Width ─────────────────────────────────────────────────────────────────
  const asideRef = useRef<HTMLElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  const clampWidth = useCallback((px: number) => {
    const row = asideRef.current?.parentElement?.getBoundingClientRect().width ?? 0;
    const max = row > 0 ? row * THREAD_MAX_SHARE : px;
    return Math.round(Math.max(THREAD_MIN_WIDTH, Math.min(px, Math.max(THREAD_MIN_WIDTH, max))));
  }, []);
  // Before paint, so the panel never draws at one width and jumps to another.
  useLayoutEffect(() => {
    if (overlay) return;
    const row = asideRef.current?.parentElement?.getBoundingClientRect().width ?? 0;
    setWidth(clampWidth(readThreadWidth() ?? row * THREAD_DEFAULT_SHARE));
  }, [clampWidth, overlay]);
  const drag = useRef<{ x: number; w: number } | null>(null);
  const onHandleDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, w: asideRef.current?.getBoundingClientRect().width ?? width ?? 0 };
  };
  const onHandleMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    // The handle is the LEFT edge: moving it left widens the panel, one pixel for one.
    setWidth(clampWidth(drag.current.w + (drag.current.x - e.clientX)));
  };
  const onHandleUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    const w = asideRef.current?.getBoundingClientRect().width;
    if (w) writeThreadWidth(w);
  };
  const onHandleKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const current = asideRef.current?.getBoundingClientRect().width ?? width ?? 0;
    const next = clampWidth(current + (e.key === 'ArrowLeft' ? THREAD_WIDTH_STEP : -THREAD_WIDTH_STEP));
    setWidth(next);
    writeThreadWidth(next);
  };
  const rowWidth = asideRef.current?.parentElement?.getBoundingClientRect().width ?? 0;

  return (
    /* `chat-pane` on the PANEL, not on the composer wrapper, and the one rule it carries that
       does not transfer is neutralised inline.

       WHY THE CLASS AT ALL: the composer's own rules read the chat's reading tokens
       (`--chat-text`, `--chat-lh`, `--chat-card-width`) which are declared on `.chat-pane`,
       and `composerHeight.ts` resolves the field's auto-grow ceiling with
       `closest('.chat-pane')` — on the panel that means half of THIS panel rather than half
       the viewport. The feed's column wears it for exactly these two reasons; this aside is
       its SIBLING, not its child, so it inherits none of it.

       WHY THE INLINE OVERRIDE: `.chat-pane` is `position: absolute; inset: 0` — written for a
       pane that fills its window. `AgentsFeed.css` already overrides that for the feed column
       (`.agents-feed-main.chat-pane { position: relative; inset: auto }`) with a note that the
       rule does not transfer, and the meeting room does the same. Putting the class on the
       FOOTER without the override is what shipped a composer stretched over the entire panel:
       it covered the close button, so the panel could not be dismissed and then intercepted
       every click aimed at the channel behind it. */
    <aside
      ref={asideRef}
      id={panelId}
      className={`agent-thread chat-pane${overlay ? ' chat-slideover-panel agent-thread--overlay' : ''}`}
      style={{ position: 'relative', inset: 'auto', ...(overlay || width === null ? {} : { width }) }}
      // Inside the scrim, a click on the panel must not reach the scrim, which closes it.
      onClick={overlay ? (e) => e.stopPropagation() : undefined}
      aria-label={t('agents.thread.aria').replace('{name}', message.title)}
      onKeyDown={onKeyDown}
    >
      {!overlay && (
      <div
        className="agent-thread-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label={t('agents.thread.resize')}
        aria-valuemin={THREAD_MIN_WIDTH}
        aria-valuemax={Math.round(Math.max(THREAD_MIN_WIDTH, rowWidth * THREAD_MAX_SHARE))}
        aria-valuenow={width ?? undefined}
        tabIndex={0}
        onPointerDown={onHandleDown}
        onPointerMove={onHandleMove}
        onPointerUp={onHandleUp}
        onPointerCancel={onHandleUp}
        onKeyDown={onHandleKey}
      />
      )}
      <header className="agent-thread-head">
        <span className="agent-thread-title">Thread</span>
        <span className="agent-thread-sub">{message.title}</span>
        <button
          ref={closeBtn}
          type="button"
          className="agent-thread-close chat-slideover-close"
          onClick={onClose}
          aria-label="Close thread"
        >
          ✕
        </button>
      </header>

      <div className="agent-thread-body">
        {/* THE ROOT. Your question when this run was an ask — the thread hangs off
            your message, as in Slack — otherwise the agent's own post, rendered by
            the same component as the feed, as the thread's root. */}
        {message.ask ? (
          <div className="agent-thread-post agent-thread-post--user agent-thread-root">
            <RowFace who="user" message={message} />
            <div className="agent-thread-post-main">
              <div className="agent-thread-post-head">
                <span className="agent-thread-post-who">You</span>
                <span className="agent-thread-post-time">{hhmm(message.ask.at)}</span>
              </div>
              <AgentProse text={message.ask.text} className="agent-thread-post-text" />
            </div>
          </div>
        ) : (
          <AgentMessage
            message={message}
            variant="root"
            onOpenThread={() => {}}
            onOpenFile={onOpenFile}
            onOpenAgent={onOpenAgent}
          />
        )}

        <div className="agent-thread-divider">
          <span>{replyCount} {replyCount === 1 ? 'reply' : 'replies'}</span>
        </div>

        {isLoading && entries.length === 0 && <p className="agent-thread-empty">Reading the thread…</p>}
        {!isLoading && entries.length === 0 && !answer && (
          <p className="agent-thread-empty">This run left nothing in its thread.</p>
        )}

        {entries.map((e, i) => (
          <Fragment key={e.id}>
            {i === answerAt && answer && <AnswerRow answer={answer} message={message} onOpenFile={onOpenFile} />}
            {e.kind === 'system'
              // An ask's root is the reader's question, not the reason, so nothing is trimmed.
              ? <SystemRow entry={e} rootText={message.ask ? null : message.text} />
              : <AuthoredRow entry={e} message={message} onOpenFile={onOpenFile} />}
          </Fragment>
        ))}
        {answer && answerAt === entries.length && (
          <AnswerRow answer={answer} message={message} onOpenFile={onOpenFile} />
        )}
      </div>

      <footer className="agent-thread-foot" ref={footRef}>
        {/* THE QUESTION THE SERVER POINTED AT. A `question_pending` refusal is
            not a dead end — it names the one thing that has to happen before a
            reply can land, so the block that does it is rendered right where
            the refusal was read rather than sending the reader back to the feed
            to find it. */}
        {askInline && message.question && onToast && (
          <AgentQuestionBlock
            slug={message.slug}
            title={message.title}
            question={message.question}
            onToast={onToast}
          />
        )}

        {blocked ? (
          // NO FIELD AT ALL. The server refuses a disabled or unapproved agent
          // before it reads the body, so a composer here could only ever be
          // told no. The reason, and next to it the one control that fixes it:
          // turning the agent on, or opening it to review and approve.
          // `.agents-composer-note--error` is the channel's existing error ink.
          <p className="agent-thread-note agents-composer-note--error agent-thread-blocked">
            <span>{blocked.text}</span>
            <button
              type="button"
              className="agent-thread-blocked-action"
              onClick={blocked.run}
              disabled={setEnabled.isPending}
            >
              {blocked.action}
            </button>
          </p>
        ) : (
          <>
            {/* `chat-pane` carries the composer's reading tokens (`--chat-text`,
                `--chat-lh`) and is what `composerHeight.ts` measures with
                `closest('.chat-pane')` — so the field grows to half the PANEL
                rather than half the viewport. One class instead of a second
                sizing rule, exactly as the channel does it. */}
            <div className="agent-thread-composer">
              <Composer
                session={host}
                model={model}
                effort={effort}
                modelConfig={modelConfig}
                onModelChange={() => {}}
                onEffortChange={() => {}}
                // An automation replies on the model IT is configured with — a
                // picker here would change nothing, so it is not drawn.
                showModel={false}
                // There is no turn to steer into: the reply is a JOB, polled.
                busy={false}
                connected
                // The run slot, exactly as the channel reports it: the server refuses a
                // reply (`busy`) while another agent holds it, so the field says so first.
                unavailable={busyWith ? { reason: t('agents.busy').replace('{name}', busyWith) } : undefined}
                idlePlaceholder={`Reply to ${message.title}…`}
                quote={null}
                onClearQuote={() => {}}
                // No `@` here: a thread has one recipient. Without this empty list the
                // composer would fetch and offer this machine's CONNECTED PROJECTS.
                mentions={[]}
                onSignIn={() => {}}
              />
            </div>
            {/* K5: one sentence, 14px, under the field — and only ever one. */}
            {footNote && (
              <p className={`agent-thread-note${footNote.kind === 'error' ? ' agents-composer-note--error' : ''}`}>
                {footNote.text}
              </p>
            )}
          </>
        )}
      </footer>
    </aside>
  );
}
