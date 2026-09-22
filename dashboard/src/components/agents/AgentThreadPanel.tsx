import { useCallback, useMemo, useRef, useState } from 'react';
import {
  useAgentThread, useAutomations, useReplyDelivery, useReplyToAgentThread,
  type FeedMessage, type ThreadEntry,
} from '../../hooks/useAutomations';
import { AgentFiles, AgentMessage } from './AgentMessage';
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
 *  two vocabularies, one of which would go stale. */
function SystemRow({ entry }: { entry: ThreadEntry }) {
  return (
    <div className="agent-thread-sys">
      <span className="agent-thread-sys-time">{hhmm(entry.at)}</span>
      <span className="agent-thread-sys-text">{entry.text}</span>
    </div>
  );
}

function AuthoredRow({
  entry,
  title,
  onOpenFile,
}: {
  entry: ThreadEntry;
  title: string;
  onOpenFile: (path: string) => void;
}) {
  return (
    <div className={`agent-thread-post agent-thread-post--${entry.kind}`}>
      <div className="agent-thread-post-head">
        <span className="agent-thread-post-who">{entry.kind === 'user' ? 'You' : title}</span>
        <span className="agent-thread-post-time">{hhmm(entry.at)}</span>
      </div>
      <p className="agent-thread-post-text">{entry.text}</p>
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

export function AgentThreadPanel({
  message,
  onClose,
  onOpenFile,
  onOpenAgent,
  onToast,
}: {
  message: FeedMessage;
  onClose: () => void;
  onOpenFile: (path: string) => void;
  onOpenAgent: (slug: string) => void;
  /** Where an answer that could not be recorded is reported — the inline
   *  question block needs one, and the panel has no toast surface of its own. */
  onToast?: (msg: string) => void;
}) {
  const { t } = useI18n();
  const { data, isLoading } = useAgentThread(message.slug, message.runId);
  const entries = data?.entries ?? [];

  // ── Replying ──────────────────────────────────────────────────────────────
  //
  // The agent's own state decides whether a field is drawn at all. `enabled` and
  // `approved` are the first two rungs of the server's refusal ladder, so a
  // composer on an agent failing either is a control that can only ever be told
  // no — and the reader learns why from the note instead of from a 409.
  const { data: automations } = useAutomations();
  const agent = useMemo(
    () => (automations ?? []).find((a) => a.slug === message.slug) ?? null,
    [automations, message.slug],
  );
  const blocked = agent
    ? (!agent.enabled
      ? `${message.title} is turned off. Turn it on to reply.`
      : !agent.approved
        ? `${message.title} is not approved on this machine yet — approve it and reply again.`
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
      },
    });
  }, [reply, message.slug, message.runId, t]);

  const { host, note, setNote } = useAgentThreadHost(
    { slug: message.slug, title: message.title, runId: message.runId },
    onSend,
  );
  noteRef.current = setNote;

  const modelConfig = useAgentModelConfig().data ?? FALLBACK_MODEL_CONFIG;
  const [model] = useState(() => readAgentSettings().chatDefaultModel);
  const [effort] = useState(() => readAgentSettings().chatDefaultEffort);

  // One sentence, one owner (K5): a server refusal outranks the delivery note,
  // and the host's own note (an empty reply) outranks both because it is the
  // thing the user did last.
  const footNote = note ?? (refusal ? { kind: 'error' as const, text: refusal } : deliveryNote(delivery, t));

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
       every click aimed at the channel behind it. The equivalent rule belongs beside the
       other two in `AgentsFeed.css`; it is inline here only because this lane does not own
       that stylesheet, and it is two declarations rather than a layout of its own. */
    <aside
      className="agent-thread chat-pane"
      style={{ position: 'relative', inset: 'auto' }}
      aria-label={`Thread — ${message.title}`}
    >
      <header className="agent-thread-head">
        <span className="agent-thread-title">Thread</span>
        <span className="agent-thread-sub">{message.title}</span>
        <button type="button" className="agent-thread-close" onClick={onClose} aria-label="Close thread">
          ✕
        </button>
      </header>

      <div className="agent-thread-body">
        {/* The root: the same message, rendered by the same component, without
            its header — the panel's own header already says whose it is. */}
        <AgentMessage
          message={message}
          showHead={false}
          onOpenThread={() => {}}
          onOpenFile={onOpenFile}
          onOpenAgent={onOpenAgent}
        />

        <div className="agent-thread-divider">
          <span>{entries.length} {entries.length === 1 ? 'entry' : 'entries'} in this run</span>
        </div>

        {isLoading && entries.length === 0 && <p className="agent-thread-empty">Reading the thread…</p>}
        {!isLoading && entries.length === 0 && (
          <p className="agent-thread-empty">This run left nothing in its thread.</p>
        )}

        {entries.map((e) =>
          e.kind === 'system'
            ? <SystemRow key={e.id} entry={e} />
            : <AuthoredRow key={e.id} entry={e} title={message.title} onOpenFile={onOpenFile} />,
        )}
      </div>

      <footer className="agent-thread-foot">
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
          // told no — and a control whose every use is already decided against
          // is worse than its absence plus the reason.
          // `.agents-composer-note--error` is the channel's existing error ink,
          // reused rather than re-declared: this lane does not own that
          // stylesheet, and a second red for the same meaning is a second thing
          // to keep in step.
          <p className="agent-thread-note agents-composer-note--error">{blocked}</p>
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
                idlePlaceholder={`Reply to ${message.title}…`}
                quote={null}
                onClearQuote={() => {}}
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
