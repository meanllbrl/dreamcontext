import { useEffect, useReducer, useRef, useState } from 'react';
import { MarkdownPreview } from '../core/MarkdownPreview';
import { GoalLivePanel } from './GoalLivePanel';
import { api } from '../../api/client';
import { pickFiles, pickFolders } from '../../lib/desktop';
import { useAgentSessionStats } from '../../hooks/useAgentCapabilities';
import {
  SKILL_GROUPS, effortLabel, fmtTokens, fmtCost, quotePath, type ModelConfig,
} from '../../lib/agentComposer';
import type {
  ChatSession, ChatItem, ChatUserItem, ChatTextItem, ChatThinkingItem, ChatToolItem,
  PendingPermission, PendingQuestion,
} from './chatSession';
import './ChatPane.css';

/**
 * The native conversation view for a Chat session (beta) — portaled into the session's
 * detached `container` by AgentSurface, exactly like a terminal's xterm container. Renders
 * from {@link ChatSession.getModel} (re-subscribing on every applied event — see
 * chatSession.ts's two-channel notification note) instead of scraping any screen buffer.
 *
 * NOTE on i18n: every sibling component in this directory (AgentTabs, AgentComposerBar,
 * PaneFragment, GoalLivePanel, AgentDock, AgentSetup) hardcodes its English copy — none use
 * `useI18n`/`t()`. `settings.agents.chat_view*` exist in I18nContext only because
 * SettingsPage.tsx (which DOES use i18n) needed them for its own checkbox row. This file
 * follows the established local convention of its own directory rather than introducing
 * i18n into a component family that has never used it.
 */

const WATCHDOG_MS = 4000;

function safeStringify(v: unknown): string {
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

// ─── Context strip (AC9) ────────────────────────────────────────────────────────────

interface TaskLinkInfo { name: string; objectiveLabels: string[] }

/** Linked-task chip + objectives data, fetched only when `taskSlug` is supplied. Beta ships
 *  no caller that ever sets `taskSlug` (Task Manager sessions stay `kind:'agent'` — see the
 *  plan's scope call D), so this hook is a built-but-dormant mechanism in this release. */
function useTaskLink(taskSlug?: string): TaskLinkInfo | null {
  const [info, setInfo] = useState<TaskLinkInfo | null>(null);
  useEffect(() => {
    if (!taskSlug) { setInfo(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const [taskRes, objRes] = await Promise.all([
          api.get<{ task: { name?: string; objectives?: string[] } }>(`/tasks/${encodeURIComponent(taskSlug)}`),
          api.get<{ objectives: Array<{ slug: string; title: string }> }>('/objectives'),
        ]);
        if (cancelled) return;
        const objMap = new Map((objRes.objectives ?? []).map((o) => [o.slug, o.title] as const));
        const slugs = taskRes.task?.objectives ?? [];
        setInfo({ name: taskRes.task?.name ?? taskSlug, objectiveLabels: slugs.map((s) => objMap.get(s) ?? s) });
      } catch {
        if (!cancelled) setInfo(null);
      }
    })();
    return () => { cancelled = true; };
  }, [taskSlug]);
  return info;
}

function ChatContextStrip({ session, taskSlug }: { session: ChatSession; taskSlug?: string }) {
  const link = useTaskLink(taskSlug);
  const stats = useAgentSessionStats(session.claudeId, session.status === 'open').data;
  const ctx = stats?.contextTokens != null && stats.contextLimit
    ? { used: stats.contextTokens, limit: stats.contextLimit, pct: Math.min(100, Math.round((stats.contextTokens / stats.contextLimit) * 100)) }
    : null;
  const showStats = !!ctx || (stats?.costUsd != null && stats.costUsd > 0);
  if (!link && !showStats) {
    // Still mount GoalLivePanel — it renders nothing unless a run is active for this
    // conversation, and must poll regardless of whether the rest of the strip has content.
    return <GoalLivePanel claudeId={session.claudeId} enabled={session.status === 'open'} />;
  }
  return (
    <div className="chat-context-strip">
      {link && (
        <div className="chat-context-task">
          <span className="chat-context-task-glyph" aria-hidden>📋</span>
          <span className="chat-context-task-name">{link.name}</span>
          {link.objectiveLabels.map((o) => (
            <span key={o} className="chat-context-objective">{o}</span>
          ))}
        </div>
      )}
      <GoalLivePanel claudeId={session.claudeId} enabled={session.status === 'open'} />
      {showStats && (
        <div
          className="chat-context-stats"
          title={
            `${ctx ? `Context window: ${fmtTokens(ctx.used)} of ${fmtTokens(ctx.limit)} used (${ctx.pct}%)\n` : ''}`
            + `${stats?.costUsd != null ? `Estimated cost at public API rates: ${fmtCost(stats.costUsd)} (a Max/Pro plan is flat-rate — this is a what-if)` : ''}`
          }
        >
          {ctx && (
            <span className="chat-context-stat" data-hot={ctx.pct >= 85}>
              <span aria-hidden>◔</span> {fmtTokens(ctx.used)}<span className="chat-context-stat-dim">/{fmtTokens(ctx.limit)}</span>
            </span>
          )}
          {stats?.costUsd != null && <span className="chat-context-stat">{fmtCost(stats.costUsd)}</span>}
        </div>
      )}
    </div>
  );
}

// ─── Transcript items ───────────────────────────────────────────────────────────────

function UserBubble({ item }: { item: ChatUserItem }) {
  return <div className="chat-bubble user">{item.text}</div>;
}

function AssistantBubble({ item }: { item: ChatTextItem }) {
  if (!item.text && item.done) return null; // an empty finished text block carries nothing to show
  return (
    <div className="chat-bubble assistant">
      <MarkdownPreview content={item.text || '…'} />
    </div>
  );
}

function ThinkingBlock({ item }: { item: ChatThinkingItem }) {
  const [open, setOpen] = useState(false);
  if (!item.text) return null;
  return (
    <div className="chat-thinking-block">
      <button type="button" className="chat-collapse-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span aria-hidden>💭</span> Thinking{!item.done ? '…' : ''}
        <span className="chat-collapse-caret" aria-hidden>{open ? '▾' : '▸'}</span>
      </button>
      {open && <div className="chat-thinking-body">{item.text}</div>}
    </div>
  );
}

function ToolCard({ item }: { item: ChatToolItem }) {
  const [open, setOpen] = useState(false);
  const duration = item.endedAt ? item.endedAt - item.startedAt : null;
  return (
    <div className="chat-tool-card" data-status={item.status}>
      <button type="button" className="chat-collapse-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="chat-tool-status" data-status={item.status} aria-hidden />
        <span className="chat-tool-name">{item.name || 'Tool'}</span>
        {duration != null && <span className="chat-tool-duration">{(duration / 1000).toFixed(1)}s</span>}
        <span className="chat-collapse-caret" aria-hidden>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="chat-tool-body">
          <div className="chat-tool-section">
            <span className="chat-tool-label">Input</span>
            <pre>{safeStringify(item.input)}</pre>
          </div>
          {item.result !== undefined && (
            <div className="chat-tool-section">
              <span className="chat-tool-label">Result</span>
              <pre>{safeStringify(item.result)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ItemView({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case 'user': return <UserBubble item={item} />;
    case 'text': return <AssistantBubble item={item} />;
    case 'thinking': return <ThinkingBlock item={item} />;
    case 'tool': return <ToolCard item={item} />;
    default: return null;
  }
}

// ─── Permission + question cards (AC4/AC5) ─────────────────────────────────────────

function PermissionCard({ item, session }: { item: PendingPermission; session: ChatSession }) {
  return (
    <div className="chat-permission-card">
      <div className="chat-card-head">
        <span className="chat-card-glyph" aria-hidden>🔐</span>
        <span className="chat-card-title">{item.displayName ?? item.toolName}</span>
      </div>
      {item.description && <p className="chat-card-desc">{item.description}</p>}
      {item.input !== undefined && <pre className="chat-card-input">{safeStringify(item.input)}</pre>}
      <div className="chat-card-actions">
        <button type="button" className="chat-btn" onClick={() => session.answer(item.requestId, { behavior: 'deny', message: 'Denied by user.' })}>Deny</button>
        <button type="button" className="chat-btn primary" onClick={() => session.answer(item.requestId, { behavior: 'allow', updatedInput: item.input })}>Allow</button>
      </div>
    </div>
  );
}

function QuestionCard({ item, session }: { item: PendingQuestion; session: ChatSession }) {
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const toggle = (q: PendingQuestion['questions'][number], label: string) => {
    setSelected((prev) => {
      const cur = prev[q.question] ?? [];
      const next = q.multiSelect
        ? (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label])
        : [label];
      return { ...prev, [q.question]: next };
    });
  };
  const answered = item.questions.every((q) => (selected[q.question] ?? []).length > 0);
  const submit = () => {
    const picked: Record<string, string> = {};
    for (const q of item.questions) {
      const chosen = selected[q.question] ?? [];
      if (chosen.length) picked[q.question] = chosen.join(', ');
    }
    session.answerQuestion(item.requestId, item.questions, picked);
  };
  return (
    <div className="chat-question-card">
      <div className="chat-card-head">
        <span className="chat-card-glyph" aria-hidden>❓</span>
        <span className="chat-card-title">{item.questions[0]?.header ?? 'Question'}</span>
      </div>
      {item.questions.map((q) => (
        <div key={q.question} className="chat-question-block">
          <p className="chat-question-text">{q.question}</p>
          <div className="chat-question-options">
            {q.options.map((o) => (
              <button
                key={o.label}
                type="button"
                className={'chat-question-opt' + ((selected[q.question] ?? []).includes(o.label) ? ' on' : '')}
                title={o.description}
                onClick={() => toggle(q, o.label)}
              >{o.label}</button>
            ))}
          </div>
        </div>
      ))}
      <div className="chat-card-actions">
        <button type="button" className="chat-btn primary" disabled={!answered} onClick={submit}>
          Submit answer{item.questions.length > 1 ? 's' : ''}
        </button>
      </div>
    </div>
  );
}

/**
 * Watches for an `AskUserQuestion` tool call that never surfaced a matching `question`
 * control_request within {@link WATCHDOG_MS} — the capability-detection degrade net for
 * AC5 (the spike PROVED headless routing works on 2.1.218; this is the safety fallback if
 * a future CLI ever regresses it). Cleared the moment a real pending question arrives, or
 * the tool card itself resolves (answered some other way, or errored).
 */
function useAskQuestionWatchdog(items: ChatItem[], hasPendingQuestion: boolean): ChatToolItem | null {
  const [stuck, setStuck] = useState<ChatToolItem | null>(null);
  useEffect(() => {
    const running = [...items].reverse().find(
      (it): it is ChatToolItem => it.kind === 'tool' && it.name === 'AskUserQuestion' && it.status === 'running',
    ) ?? null;
    if (!running || hasPendingQuestion) { setStuck(null); return; }
    const elapsed = Date.now() - running.startedAt;
    if (elapsed >= WATCHDOG_MS) { setStuck(running); return; }
    const t = setTimeout(() => setStuck(running), WATCHDOG_MS - elapsed);
    return () => clearTimeout(t);
  }, [items, hasPendingQuestion]);
  return stuck;
}

function DegradedQuestionCard({ item, onContinueInTerminal }: { item: ChatToolItem; onContinueInTerminal: () => void }) {
  return (
    <div className="chat-question-card chat-question-degraded">
      <div className="chat-card-head">
        <span className="chat-card-glyph" aria-hidden>❓</span>
        <span className="chat-card-title">Claude is asking a question</span>
      </div>
      <p className="chat-degrade-note">
        This session didn't route the question through Chat — here's the raw request. Continue in Terminal view to answer it.
      </p>
      <pre className="chat-degrade-copy">{safeStringify(item.input)}</pre>
      <div className="chat-card-actions">
        <button type="button" className="chat-btn primary" onClick={onContinueInTerminal}>Continue in Terminal view</button>
      </div>
    </div>
  );
}

// ─── Composer ───────────────────────────────────────────────────────────────────────

/**
 * The composer's draft textarea is LOCAL React state, not derived from
 * `session.getModel().draft` on every render. This is safe because `ChatPane` never
 * unmounts while its session is alive — AgentSurface portals every live chat session's
 * pane unconditionally (mirroring how a terminal's detached xterm container survives
 * minimize by moving to the garage, not unmounting) — so local state already survives
 * minimize/restore. `session.getModel().draft` is read once, on mount, purely as a safety
 * seed for the (rare, beta) case a prompt was parked server-side before this pane existed.
 * Skill-chip/file-path inserts route through BOTH local state (immediate UI) and
 * `session.sendText` (keeps the session's own model consistent, per its documented
 * contract); free typing is local-only — `session.send()` clears the session's own
 * `draft` field on submit regardless.
 */
function ChatComposer({
  session, model, effort, modelConfig, onModelChange, onEffortChange, busy, connected,
}: {
  session: ChatSession;
  model: string;
  effort: string;
  modelConfig: ModelConfig;
  onModelChange: (id: string) => void;
  onEffortChange: (level: string) => void;
  busy: boolean;
  connected: boolean;
}) {
  const [draft, setDraft] = useState(() => session.getModel().draft);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const [showFiles, setShowFiles] = useState(false);
  const [showSkills, setShowSkills] = useState(false);

  useEffect(() => {
    session.setFocusTarget(taRef.current);
    return () => session.setFocusTarget(null);
  }, [session]);

  const insert = (text: string) => {
    setDraft((d) => d + text);
    session.sendText(text);
    taRef.current?.focus();
  };

  const submit = () => {
    const text = draft.trim();
    if (!text || busy || !connected) return;
    session.send(text);
    setDraft('');
  };

  const pickPaths = async (kind: 'files' | 'folders') => {
    const paths = kind === 'folders' ? await pickFolders() : await pickFiles();
    if (paths.length) insert(`${paths.map(quotePath).join(' ')} `);
    setShowFiles(false);
  };

  const disabled = busy || !connected;

  return (
    <div className="chat-composer">
      <div className="chat-composer-toolbar">
        <div className="chat-composer-pop">
          <button type="button" className={`chat-composer-btn${showFiles ? ' open' : ''}`} onClick={() => { setShowFiles((v) => !v); setShowSkills(false); }}>
            <span aria-hidden>@</span> Files <span aria-hidden>▾</span>
          </button>
          {showFiles && (
            <div className="chat-composer-menu">
              <button type="button" onClick={() => void pickPaths('files')}>Attach files…</button>
              <button type="button" onClick={() => void pickPaths('folders')}>Attach folders…</button>
            </div>
          )}
        </div>
        <div className="chat-composer-pop">
          <button type="button" className={`chat-composer-btn${showSkills ? ' open' : ''}`} onClick={() => { setShowSkills((v) => !v); setShowFiles(false); }}>
            <span aria-hidden>✦</span> Skills <span aria-hidden>▾</span>
          </button>
          {showSkills && (
            <div className="chat-composer-menu chat-skill-menu">
              {SKILL_GROUPS.map((g) => (
                <div key={g.id} className="chat-skill-group">
                  <span className="chat-skill-group-label">{g.label}</span>
                  <div className="chat-skill-chips">
                    {g.triggers.map((t) => (
                      <button key={t.insert} type="button" title={t.hint} onClick={() => { insert(t.insert); setShowSkills(false); }}>{t.label}</button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="chat-composer-spacer" />
        <select
          className="chat-composer-select"
          value={model || modelConfig.defaultModel}
          title="Model — applies the next time this chat is resumed (Chat sets the model at spawn; there is no live /model switch yet)"
          onChange={(e) => onModelChange(e.target.value)}
        >
          {modelConfig.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
        <select
          className="chat-composer-select"
          value={effort || modelConfig.defaultEffort}
          title="Effort — applies the next time this chat is resumed"
          onChange={(e) => onEffortChange(e.target.value)}
        >
          {modelConfig.efforts.map((lvl) => <option key={lvl} value={lvl}>{effortLabel(lvl)}</option>)}
        </select>
      </div>
      <div className="chat-composer-row">
        <textarea
          ref={taRef}
          className="chat-composer-input"
          placeholder={!connected ? 'Connecting…' : busy ? 'Claude is working…' : 'Message Claude…'}
          value={draft}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
          }}
        />
        {busy ? (
          <button type="button" className="chat-btn chat-stop-btn" title="Interrupt the in-flight turn" onClick={() => session.interrupt()}>■ Stop</button>
        ) : (
          <button type="button" className="chat-btn primary chat-send-btn" disabled={!draft.trim() || !connected} onClick={submit}>Send</button>
        )}
      </div>
    </div>
  );
}

// ─── Top level ──────────────────────────────────────────────────────────────────────

export function ChatPane({
  session, modelConfig, model, effort, onModelChange, onEffortChange, taskSlug, onContinueInTerminal,
}: {
  session: ChatSession;
  modelConfig: ModelConfig;
  model: string;
  effort: string;
  onModelChange: (id: string) => void;
  onEffortChange: (level: string) => void;
  /** Task Manager sessions are `kind:'agent'` in beta (no caller ever sets this yet — the
   *  ChatContextStrip mechanism is built and dormant; see chatSession's ChatSession header
   *  and the plan's scope call D). */
  taskSlug?: string;
  onContinueInTerminal: () => void;
}) {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => session.subscribe(() => force()), [session]);

  const conv = session.getModel();
  const hasPendingQuestion = conv.pending.some((p) => p.kind === 'question');
  const stuckQuestion = useAskQuestionWatchdog(conv.items, hasPendingQuestion);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickBottomRef = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickBottomRef.current) el.scrollTop = el.scrollHeight;
  });

  return (
    <div className="chat-pane" data-status={session.status}>
      <ChatContextStrip session={session} taskSlug={taskSlug} />
      <div
        className="chat-scroll"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
      >
        {conv.items.length === 0 && !conv.pending.length && (
          <p className="chat-empty-hint">Say something to start this conversation.</p>
        )}
        {conv.items.map((item) => <ItemView key={item.id} item={item} />)}
        {conv.pending
          .filter((p): p is PendingPermission => p.kind === 'permission')
          .map((p) => <PermissionCard key={p.requestId} item={p} session={session} />)}
        {conv.pending
          .filter((p): p is PendingQuestion => p.kind === 'question')
          .map((p) => <QuestionCard key={p.requestId} item={p} session={session} />)}
        {stuckQuestion && <DegradedQuestionCard item={stuckQuestion} onContinueInTerminal={onContinueInTerminal} />}
        {conv.lastError && <div className="chat-error-banner">{conv.lastError}</div>}
        {session.status === 'closed' && <div className="chat-closed-banner">This chat session ended.</div>}
      </div>
      <ChatComposer
        session={session}
        model={model}
        effort={effort}
        modelConfig={modelConfig}
        onModelChange={onModelChange}
        onEffortChange={onEffortChange}
        busy={session.busy}
        connected={session.status === 'open'}
      />
    </div>
  );
}
