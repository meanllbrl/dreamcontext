import { useEffect, useRef, useState } from 'react';
import type { Task } from '../../../hooks/useTasks';
import { useAgentCapabilities } from '../../../hooks/useAgentCapabilities';
import { SparkIcon } from '../../sleepy/TypeIcons';
import type { SessionStatusKind } from '../../sleepy/agentStatus';
import {
  TASK_MANAGER_ACTIONS, TASK_MANAGER_STATUS_EVENT,
  buildTaskManagerPrompt, openTaskManager, detachTaskManager, sendToTaskManager,
  type TaskManagerStatusDetail,
} from '../../../lib/taskManagerAgent';
import './TaskManagerPane.css';

interface TaskManagerPaneProps {
  task: Task;
  title: string;
}

/**
 * The task-detail Task Manager pane — a REAL Claude Code session, pinned to this task.
 *
 * Why a terminal and not a bespoke chat UI. The obvious design is a styled message stream with
 * anchored-comment cards and an Apply-all button. It looks better in a mockup and is worse in
 * practice: a Claude Code session asks *interactive* questions — permission prompts, plan
 * approvals, "which of these did you mean?" — and a custom stream has to reimplement every one
 * of those interactions or silently drop them, leaving the user with an agent that has stopped
 * for a reason they can't see or answer. The terminal handles all of it for free, and it is the
 * runtime the project already ships. So the design's header and quick actions survive; its chat
 * transcript is the terminal.
 *
 * This component owns NO session. `AgentSurface` is mounted once above the router and globally
 * owns the session-id counter, the roster file, and the live-conversation set — a second
 * instance here would race the roster and could double-attach a conversation. So the pane
 * renders an empty slot and asks the surface, by event, to move the session's DOM into it. The
 * terminal is re-parented, never remounted: navigate away and back mid-edit and the same live
 * agent is still there.
 */
export function TaskManagerPane({ task, title }: TaskManagerPaneProps) {
  const { data: caps } = useAgentCapabilities();
  const available = !!(caps?.desktop && caps.embeddedTerminal && caps.claudeCli);

  const [status, setStatus] = useState<{ kind: SessionStatusKind; label: string } | null>(null);
  const [error, setError] = useState('');
  // Bypass is OFF by default here, unlike Delegate. Delegate runs unattended overnight, so
  // approval prompts would just stall it. Task Manager runs with you watching, editing the document
  // you are reading — seeing what it is about to do is the point, not an obstacle.
  const [bypass, setBypass] = useState(false);
  // The session is requested ONCE per mounted pane. A re-request is harmless (the surface
  // re-homes the existing session) but it would re-park the deferred pin context and
  // re-dispatch for nothing, so guard it. The pin context itself is NOT auto-sent: the
  // session boots idle and the context joins the user's first message (deferPrompt).
  const requested = useRef(false);

  useEffect(() => {
    const onStatus = (e: Event) => {
      const d = (e as CustomEvent<TaskManagerStatusDetail>).detail;
      if (d?.slug === task.slug) setStatus({ kind: d.kind, label: d.label });
    };
    window.addEventListener(TASK_MANAGER_STATUS_EVENT, onStatus);
    return () => window.removeEventListener(TASK_MANAGER_STATUS_EVENT, onStatus);
  }, [task.slug]);

  useEffect(() => {
    if (!available || requested.current) return;
    requested.current = true;
    void openTaskManager({ slug: task.slug, title, prompt: buildTaskManagerPrompt(task, title), bypass })
      .then((ok) => { if (!ok) setError("The in-app agent isn't available right now."); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    // Detach on unmount — the slot is going away, but the agent may be mid-edit and closing a
    // task must not kill work you asked for. The surface parks it; reopening the task re-homes
    // the same live session.
    return () => detachTaskManager(task.slug);
    // `bypass`/`title` are read at request time only; re-running on their change would re-prompt
    // an already-live session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available, task.slug]);

  if (!available) {
    return (
      <aside className="tm-pane tm-pane--unavailable">
        <TaskManagerHeader status={null} bypass={bypass} onBypass={setBypass} disabled />
        <div className="tm-fallback">
          <p>
            Task Manager runs a real Claude Code session inside the app, so it needs the desktop app
            with the Claude CLI installed.
          </p>
          <p className="tm-fallback-hint">
            You can still manage this task from a terminal — point Claude at{' '}
            <code>_dream_context/state/{task.slug}.md</code> and ask it to load the{' '}
            <code>task-manager</code> skill.
          </p>
        </div>
      </aside>
    );
  }

  return (
    <aside className="tm-pane">
      <TaskManagerHeader status={status} bypass={bypass} onBypass={setBypass} />
      <div className="tm-actions">
        {TASK_MANAGER_ACTIONS.map((a) => (
          <button
            key={a.id}
            type="button"
            className="tm-action"
            onClick={() => sendToTaskManager({ slug: task.slug, text: a.prompt })}
            title={a.prompt}
          >
            {a.label}
          </button>
        ))}
      </div>
      {error && <div className="tm-error" role="alert">{error}</div>}
      {/*
        The slot. Empty by design: `AgentSurface` appends the live terminal's container here
        (`.agent-task-manager-slot[data-task="<slug>"]`). React must never render children into it —
        the container is raw DOM the surface owns, and React reconciling this subtree would rip
        a live xterm out from under a running PTY.
      */}
      <div className="agent-task-manager-slot tm-slot" data-task={task.slug} />
    </aside>
  );
}

function TaskManagerHeader(
  { status, bypass, onBypass, disabled }:
  { status: { kind: SessionStatusKind; label: string } | null; bypass: boolean; onBypass: (v: boolean) => void; disabled?: boolean },
) {
  return (
    <header className="tm-head">
      <span className="tm-mark" aria-hidden><SparkIcon size={15} /></span>
      <span className="tm-titles">
        <span className="tm-title">Task Manager</span>
        <span className="tm-sub">Maintains this task — it doesn’t build it</span>
      </span>
      {status && (
        // `asking` is the state worth designing for: the agent has stopped and needs an answer,
        // and you are looking at the document, not the terminal. It gets its own colour and
        // stays legible rather than reading as just another "busy".
        <span className="tm-status" data-kind={status.kind}>
          <span className="tm-dot" aria-hidden />
          {status.kind === 'asking' ? 'Needs you' : status.label}
        </span>
      )}
      <label className="tm-bypass" title="Let the agent act without asking for approval each step">
        <input
          type="checkbox"
          checked={bypass}
          disabled={disabled}
          onChange={(e) => onBypass(e.target.checked)}
        />
        Auto
      </label>
    </header>
  );
}
