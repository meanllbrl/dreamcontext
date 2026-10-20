import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { AgentAvatar } from '../agents/AgentAvatar';
import { AgentFiles, AgentProse } from '../agents/AgentMessage';
import { AgentSummaryBlock } from '../agents/AgentSummaryBlock';
import { AgentQuestionBlock } from '../agents/AgentQuestionBlock';
import { FoldedReport } from '../agents/FoldedReport';
import { useAgentThreadHost } from '../agents/agentsChannelHost';
import { runDuration, useNow } from '../agents/agentRunState';
import { Composer } from '../sleepy/chat/Composer';
import { isAtBottom } from '../sleepy/chat/chatEntities';
import { useApi, useVault } from '../../context/VaultContext';
import { useI18n } from '../../context/I18nContext';
import { useAgentModelConfig } from '../../hooks/useAgentCapabilities';
import { FALLBACK_MODEL_CONFIG, type ModelConfig } from '../../lib/agentComposer';
import {
  useAnswerQuestion, useAutomationDispatcher, useInstallDispatcher, useMarkThreadRead, useProjectSlashCommands,
  useSayInChannel, type AgentActivity, type FeedMessage, type RunAnswer, type ThreadEntry,
} from '../../hooks/useAutomations';
import {
  buildConversation, dayRuleLabel, openQuestionOf, overrideFor, readTemporaryModels, routineCountLabel,
  writeTemporaryModel, type ConversationItem, type ConversationThread, type TeamAgent, type TeamRow,
  type TemporaryModel,
} from './teamModel';
import { TeamIcon } from './TeamIcons';
import '../sleepy/ChatPane.css';
import '../sleepy/chat/composer.css';
import '../sleepy/chat/cards.css';
import '../agents/AgentsFeed.css';

/** How many of the newest runs have their threads read: replies, "Routine created", reports. */
const THREADS_READ = 8;

/**
 * What each finished run looked like in the feed when its thread was last read, keyed by vault
 * and run. Module-level ON PURPOSE: the conversation remounts per teammate, and a map that died
 * with it would see every run as new on the way back, so a thread that changed while another
 * teammate was open would stay as it was cached (its reads never go stale on their own).
 */
const THREAD_READ_SIG = new Map<string, string>();

function hhmm(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** A model id as the menu names it: "Opus", or the id itself when the list does not know it. */
function modelName(config: ModelConfig, id: string): string {
  return config.models.find((m) => m.id === id)?.label ?? id;
}
function effortName(level: string): string {
  return level ? level.charAt(0).toUpperCase() + level.slice(1) : '';
}

type ThreadRead = { entries: ThreadEntry[]; answer?: RunAnswer | null; rootId?: string | null; working?: AgentActivity | null };

/**
 * ONE TEAMMATE, ONE CONVERSATION — the middle of the AI Team.
 *
 * Every run this agent made, scheduled or asked for, in one stream oldest to newest (see
 * `buildConversation`). The composer at the bottom is Chat's own: by default it talks to the
 * agent (`say`, a fresh turn that carries its recent history); while a question waits, it
 * ANSWERS that question instead and says so above the field.
 *
 * The model trigger shows the agent's own model and effort. Picking another is TEMPORARY:
 * remembered on this machine for this agent, sent with each message from here, and never
 * written to the agent or used by its routines.
 */
export function TeamConversation({
  row,
  agent,
  messages,
  panelOpen,
  onTogglePanel,
  onOpenRoutines,
  onReview,
  onOpenFile,
  onToast,
  onBack,
}: {
  row: TeamRow;
  agent: TeamAgent;
  /** This agent's feed messages, oldest first. */
  messages: FeedMessage[];
  panelOpen: boolean;
  onTogglePanel: () => void;
  onOpenRoutines: () => void;
  /** Open its profile, where the review is. */
  onReview: () => void;
  onOpenFile: (path: string) => void;
  onToast: (msg: string) => void;
  /** Phone width: back to the list. */
  onBack?: () => void;
}) {
  const { t } = useI18n();
  const api = useApi();
  const { vault } = useVault();
  const slug = agent.slug;

  // ── The threads of the newest runs ──
  const recent = useMemo(() => messages.slice(-THREADS_READ), [messages]);
  const threadReads = useQueries({
    queries: recent.map((m) => ({
      // The thread panel's own key, so a read here and a read there are one cache entry.
      queryKey: ['automations', m.slug, 'thread', m.runId],
      queryFn: () => api.get<ThreadRead>(`/automations/${m.slug}/thread?run=${encodeURIComponent(m.runId)}`),
      // Only a run in flight is polled. A finished run's thread changes only when the feed says
      // so (a new entry moves its `newestId`), and the effect below re-reads it then.
      refetchInterval: m.status === 'running' ? 2_000 : false,
      staleTime: m.status === 'running' ? 0 : Infinity,
      retry: 0,
    })),
  });
  const queryClient = useQueryClient();
  useEffect(() => {
    for (const m of recent) {
      const sig = `${m.status}|${m.newestId ?? ''}|${m.replyCount}`;
      const id = `${vault ?? ''}::${m.key}`;
      const prev = THREAD_READ_SIG.get(id);
      THREAD_READ_SIG.set(id, sig);
      if (prev !== undefined && prev !== sig) {
        void queryClient.invalidateQueries({ queryKey: ['automations', m.slug, 'thread', m.runId] });
      }
    }
  }, [recent, queryClient]);
  const threadKey = threadReads.map((q) => q.dataUpdatedAt).join(',');
  const threads = useMemo(() => {
    const out: Record<string, ConversationThread> = {};
    recent.forEach((m, i) => {
      const d = threadReads[i]?.data;
      if (d) out[m.key] = { entries: d.entries, answer: d.answer ?? null, rootId: d.rootId ?? null };
    });
    return out;
    // `threadKey` stands for the reads' data; the array itself is new every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recent, threadKey]);
  const items = useMemo(() => buildConversation(messages, threads), [messages, threads]);
  /** Questions answered from here, dropped at once rather than at the feed's next read. */
  const [answered, setAnswered] = useState<ReadonlySet<string>>(() => new Set());
  const question = useMemo(() => openQuestionOf(messages, answered), [messages, answered]);

  // ── Scroll: open at the newest end, follow it while the reader is there ──
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => { stick.current = true; }, [slug]);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items, slug]);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => { if (stick.current) el.scrollTop = el.scrollHeight; });
    for (const child of el.children) ro.observe(child);
    return () => ro.disconnect();
  }, [items]);
  const onScroll = () => {
    const el = scrollRef.current;
    if (el) stick.current = isAtBottom(el);
  };

  // ── Read marks: a message is read once it has been on screen ──
  const markRead = useMarkThreadRead();
  const marked = useRef(new Map<string, string>());
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const byKey = new Map(messages.map((m) => [m.key, m]));
    const observer = new IntersectionObserver((rows) => {
      const best = new Map<string, string>();
      for (const r of rows) {
        if (!r.isIntersecting) continue;
        const m = byKey.get((r.target as HTMLElement).dataset.msgKey ?? '');
        if (!m || !m.unread || !m.newestId) continue;
        const cur = best.get(m.slug);
        if (!cur || m.newestId > cur) best.set(m.slug, m.newestId);
      }
      for (const [s, upToId] of best) {
        // Once per mark: the observer is rebuilt on every thread read, and the feed takes a
        // poll to report the mark back.
        if (marked.current.get(s) === upToId) continue;
        marked.current.set(s, upToId);
        markRead.mutate({ slug: s, upToId });
      }
    }, { root: el, threshold: 0.5 });
    for (const node of el.querySelectorAll('[data-msg-key]')) observer.observe(node);
    return () => observer.disconnect();
    // `markRead` is a stable mutation object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  // ── The temporary model ──
  const modelConfig = useAgentModelConfig().data ?? FALLBACK_MODEL_CONFIG;
  const defaults = { model: agent.model ?? modelConfig.defaultModel, effort: agent.effort ?? modelConfig.defaultEffort };
  const [temps, setTemps] = useState<Record<string, TemporaryModel>>(() => readTemporaryModels(safeStorage()));
  const pick: TemporaryModel | null = temps[slug] ?? null;
  const model = pick?.model ?? defaults.model;
  const effort = pick?.effort ?? defaults.effort;
  const temporary = pick !== null && (pick.model !== defaults.model || pick.effort !== defaults.effort);
  const setPick = (next: TemporaryModel | null) => setTemps(writeTemporaryModel(safeStorage(), slug, next));
  const backToDefault = () => setPick(null);
  const defaultWords = agent.model || agent.effort
    ? `${modelName(modelConfig, defaults.model)} · ${effortName(defaults.effort)}`
    : t('aiteam.model.claudeDefault');

  // ── Sending ──
  const say = useSayInChannel();
  const answer = useAnswerQuestion();
  const noteRef = useRef<(n: { kind: 'error' | 'hint'; text: string } | null) => void>(() => {});
  const restoreRef = useRef<() => void>(() => {});
  const questionRef = useRef(question);
  questionRef.current = question;
  const overrideRef = useRef<{ model?: string; effort?: string }>({});
  overrideRef.current = temporary ? overrideFor(pick, defaults) : {};
  const onSend = useCallback((text: string, opts: { restore?: boolean } = {}) => {
    const fail = (err: unknown) => {
      noteRef.current({ kind: 'error', text: (err as Error).message });
      // A suggestion was never in the field, so there is nothing of the reader's to put back.
      if (opts.restore !== false) restoreRef.current();
    };
    stick.current = true;
    const q = questionRef.current;
    if (q?.question) {
      const id = q.question.id;
      answer.mutate({ id, kind: 'flow-hitl', answer: text }, {
        onSuccess: () => setAnswered((prev) => new Set(prev).add(id)),
        onError: fail,
      });
      return;
    }
    say.mutate({ slug, text, ...overrideRef.current }, { onError: fail });
  }, [answer, say, slug]);
  const slashCommands = useProjectSlashCommands().data?.commands;
  const { host, note, setNote, restoreLastSent } = useAgentThreadHost(
    { slug, title: agent.title, runId: '' },
    onSend,
    slashCommands,
  );
  noteRef.current = setNote;
  restoreRef.current = restoreLastSent;

  const { data: dispatcher } = useAutomationDispatcher();
  const install = useInstallDispatcher();
  const blocked = !agent.approvedForChat;
  const routineCount = row.routines.length;

  return (
    <section className="aiteam-convo chat-pane" aria-label={agent.title}>
      <header className="aiteam-convo-head">
        {onBack && (
          <button type="button" className="aiteam-iconbtn aiteam-back" onClick={onBack} aria-label={t('aiteam.back')}>
            <TeamIcon name="back" size={16} />
          </button>
        )}
        <AgentAvatar of="agent" slug={slug} title={agent.title} hasPhoto={agent.hasPhoto} size={36} />
        <div className="aiteam-convo-id">
          <span className="aiteam-convo-name">
            <span className="aiteam-convo-name-text">{agent.title}</span>
            {row.status === 'needs' && <span className="aiteam-tag aiteam-tag--warn">{t('aiteam.tag.needs')}</span>}
            {blocked && <span className="aiteam-tag"><TeamIcon name="lock" size={10} />{t('aiteam.tag.needsApproval')}</span>}
          </span>
          {row.role && <span className="aiteam-convo-role">{row.role}</span>}
        </div>
        <span className="aiteam-spacer" />
        <button
          type="button"
          className={`aiteam-pill${panelOpen ? ' aiteam-pill--on' : ''}`}
          onClick={onOpenRoutines}
          data-team-routines={routineCount}
        >
          <TeamIcon name="clock" size={14} />
          <span className="aiteam-pill-text">{routineCountLabel(routineCount, t)}</span>
        </button>
        <button
          type="button"
          className="aiteam-iconbtn"
          onClick={onTogglePanel}
          aria-pressed={panelOpen}
          aria-label={t('aiteam.details')}
          title={t('aiteam.details')}
        >
          <TeamIcon name="panel" size={16} />
        </button>
      </header>

      {blocked && (
        <div className="aiteam-banner">
          <span className="aiteam-event-mark"><TeamIcon name="lock" size={10} /></span>
          <span><b>{t('aiteam.review.lede').replace('{name}', agent.title)}</b> {t('aiteam.review.sub')}</span>
          <span className="aiteam-spacer" />
          <button type="button" className="agent-btn agent-btn--primary" onClick={onReview}>{t('aiteam.review.go')}</button>
        </div>
      )}
      {!blocked && messages.length === 0 && dispatcher && !dispatcher.installed && (
        <div className="aiteam-banner">
          <span className="auto-dispatch-pill"><span className="auto-dispatch-dot" aria-hidden="true" /><span className="auto-dispatch-pill-label">{t('aiteam.scheduler.off')}</span></span>
          <span><b>{t('aiteam.scheduler.lede')}</b> {t('aiteam.scheduler.sub')}</span>
          <span className="aiteam-spacer" />
          <button
            type="button"
            className="agent-btn"
            disabled={install.isPending}
            onClick={() => install.mutate({}, { onError: (err) => onToast((err as Error).message) })}
          >
            {t('aiteam.scheduler.turnOn')}
          </button>
        </div>
      )}

      <div className="aiteam-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="aiteam-col">
          {messages.length === 0 ? (
            <Hello agent={agent} role={row.role} onSuggest={blocked ? undefined : (text) => onSend(text, { restore: false })} />
          ) : (
            items.map((it) => <Item key={it.key} item={it} agent={agent} onOpenFile={onOpenFile} onToast={onToast} />)
          )}
        </div>
      </div>

      <div className="aiteam-composer">
        {question?.question && !blocked && (
          <div className="aiteam-replying">
            <TeamIcon name="clock" size={12} />
            <span>
              {t('aiteam.answering')} <b>{question.title}</b> · {dayRuleLabel(question.at, new Date(), t).toLowerCase()} {hhmm(question.at)}
            </span>
          </div>
        )}
        {temporary && (
          <div className="aiteam-temp">
            <span className="aiteam-temp-dot" aria-hidden="true" />
            <span>
              <b>{t('aiteam.model.temporary')}</b> · {t('aiteam.model.strip')
                .replace('{pick}', `${modelName(modelConfig, model)} · ${effortName(effort)}`)
                .replace('{default}', defaultWords)}
            </span>
            <button type="button" className="aiteam-linkbtn" onClick={backToDefault}>{t('aiteam.model.back')}</button>
          </div>
        )}
        <Composer
          session={host}
          model={model}
          effort={effort}
          modelConfig={modelConfig}
          onModelChange={(m) => setPick({ model: m, effort })}
          onEffortChange={(e) => setPick({ model, effort: e })}
          modelMenu={{
            temporary,
            defaultId: defaults.model,
            head: (
              <div className="aiteam-model-default">
                <span>{t('aiteam.model.defaultOf').replace('{name}', agent.title)}</span>
                <b>{defaultWords}</b>
              </div>
            ),
            foot: (
              <>
                <span className="aiteam-model-note">{t('aiteam.model.note').replace('{default}', defaultWords)}</span>
                <button type="button" className="chat-cmp-setdefault" onClick={backToDefault} disabled={!temporary}>
                  {t('aiteam.model.back')}
                </button>
              </>
            ),
          }}
          busy={false}
          connected
          idlePlaceholder={question?.question
            ? t('aiteam.composer.answer').replace('{name}', agent.title)
            : t('aiteam.composer.message').replace('{name}', agent.title)}
          unavailable={blocked ? { reason: t('aiteam.composer.blocked').replace('{name}', agent.title) } : undefined}
          quote={null}
          onClearQuote={() => {}}
          onSignIn={() => {}}
        />
        {note && (
          <p className={`agents-composer-note${note.kind === 'error' ? ' agents-composer-note--error' : ''}`}>{note.text}</p>
        )}
      </div>
    </section>
  );
}

function safeStorage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

/** A teammate nobody has talked to yet: who it is, and three ways to start. */
function Hello({ agent, role, onSuggest }: { agent: TeamAgent; role: string; onSuggest?: (text: string) => void }) {
  const { t } = useI18n();
  const suggestions: [string, string][] = [
    [t('aiteam.suggest.kind.ask'), t('aiteam.suggest.ask')],
    [t('aiteam.suggest.kind.routine'), t('aiteam.suggest.routine')],
    [t('aiteam.suggest.kind.ask'), t('aiteam.suggest.can')],
  ];
  return (
    <div className="aiteam-hello">
      <AgentAvatar of="agent" slug={agent.slug} title={agent.title} hasPhoto={agent.hasPhoto} size={72} />
      <h2 className="aiteam-hello-name">{agent.title}</h2>
      {role && <p className="aiteam-hello-role">{role}</p>}
      <p className="aiteam-hello-note">{t('aiteam.hello.note')}</p>
      {onSuggest && (
        <div className="aiteam-suggest">
          {suggestions.map(([kind, text]) => (
            <button key={text} type="button" className="aiteam-suggest-btn" onClick={() => onSuggest(text)}>
              <span className="aiteam-suggest-kind">{kind}</span>
              <span>{text}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Item({
  item, agent, onOpenFile, onToast,
}: {
  item: ConversationItem;
  agent: TeamAgent;
  onOpenFile: (path: string) => void;
  onToast: (msg: string) => void;
}) {
  const { t } = useI18n();
  switch (item.kind) {
    case 'day':
      return <div className="agents-feed-day"><span>{dayRuleLabel(item.at, new Date(), t)}</span></div>;
    case 'ran': {
      const took = runDuration(item.durationMs);
      return (
        <div className={`aiteam-event${item.failed ? ' aiteam-event--bad' : ''}`}>
          <span className="aiteam-event-mark"><TeamIcon name="clock" size={10} /></span>
          <span>{t('aiteam.event.ran').replace('{title}', item.title)} · {hhmm(item.at)}{took ? ` · ${took}` : ''}</span>
        </div>
      );
    }
    case 'event':
      return (
        <div className={`aiteam-event aiteam-event--${item.tone}`} data-team-event>
          <span className="aiteam-event-mark"><TeamIcon name="check" size={10} /></span>
          <span>{item.text}</span>
        </div>
      );
    case 'you':
      return (
        <div className="chat-msg-user-row">
          <div className="chat-msg-user-bubble aiteam-you">{item.text}</div>
        </div>
      );
    case 'live':
      return <LiveRow message={item.message} />;
    case 'agent':
      return (
        <article className="agent-msg" data-msg-key={item.message.key}>
          <div className="agent-msg-av">
            <AgentAvatar of="agent" slug={agent.slug} title={agent.title} hasPhoto={agent.hasPhoto} size={32} />
          </div>
          <div className="agent-msg-body">
            <div className="agent-msg-head">
              <span className="agent-msg-name">{agent.title}</span>
              <span className="agent-msg-time">{hhmm(item.at)}</span>
              {item.question && <span className="aiteam-msg-needs">{t('aiteam.msg.needs')}</span>}
              {item.failed && <span className="aiteam-msg-failed">{t('aiteam.msg.failed')}</span>}
            </div>
            {item.text && <AgentProse text={item.text} blocks />}
            {item.summary && item.summary.length > 0 && <AgentSummaryBlock rows={item.summary} />}
            {item.report?.text && <FoldedReport text={item.report.text} onOpenFile={onOpenFile} />}
            {item.files.length > 0 && (
              <AgentFiles files={item.files.map((f) => ({ path: f, name: f.split('/').pop() ?? f }))} onOpenFile={onOpenFile} />
            )}
            {item.question && (
              <AgentQuestionBlock slug={item.message.slug} title={item.message.title} question={item.question} onToast={onToast} />
            )}
          </div>
        </article>
      );
  }
}

function LiveRow({ message }: { message: FeedMessage }) {
  const { t } = useI18n();
  const now = useNow(true);
  const since = Date.parse(message.at);
  const time = Number.isNaN(since) ? '' : runDuration(now - since) ?? '';
  return (
    <div className="aiteam-live" role="status" aria-live="polite">
      <span className="agent-msg-live-dot" aria-hidden="true" />
      <span className="agent-msg-elapsed">{t('aiteam.working').replace('{time}', time)}</span>
    </div>
  );
}
