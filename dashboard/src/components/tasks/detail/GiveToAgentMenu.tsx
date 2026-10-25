import { useEffect, useMemo, useState } from 'react';
import type { Task } from '../../../hooks/useTasks';
import { useUpdateTask } from '../../../hooks/useTasks';
import { useAgents, findAgent } from '../../../hooks/useAgents';
import { useAgentCapabilities, isSleepAgentReady } from '../../../hooks/useAgentCapabilities';
import { readAgentSettings, AGENT_SETTINGS_EVENT } from '../../../lib/agentSettings';
import { useI18n } from '../../../context/I18nContext';
import { offeredAgents, tr } from '../../../lib/assignToAgent';
import { AgentAvatar } from '../../agents/AgentAvatar';
import { SparkIcon } from '../../sleepy/TypeIcons';
import { AssignToAgentComposer, TaskAgentFace } from '../AssignToAgentComposer';
import { DelegateComposer } from '../DelegateComposer';
import { taskAgent } from '../boardModel';

/** The in-app agent runtime is ready (desktop, claude CLI, Agents enabled): "New Claude chat" is offered. */
function useAgentRuntimeReady(): boolean {
  const { data: caps } = useAgentCapabilities();
  const [settings, setSettings] = useState(() => readAgentSettings());
  useEffect(() => {
    const onChange = () => setSettings(readAgentSettings());
    window.addEventListener(AGENT_SETTINGS_EVENT, onChange);
    return () => window.removeEventListener(AGENT_SETTINGS_EVENT, onChange);
  }, []);
  return isSleepAgentReady(caps, settings.chatView) && settings.enabled;
}

/**
 * "Give to agent ▾" — the ONE way a task is handed over. The menu lists the project's AI Team
 * agents (picking one opens the existing assign composer on that agent: a persisted assignment
 * through POST assign-agent, its refusals answered in place) and "New Claude chat" (the existing
 * delegate flow, only when the agent runtime is ready). The current agent shows with "Clear",
 * which only takes the agent off the task (PATCH agent:null) and stops nothing.
 */
export function GiveToAgentMenu({ task, onError }: { task: Task; onError: (msg: string) => void }) {
  const { t } = useI18n();
  const { data: agents } = useAgents();
  const offered = useMemo(() => offeredAgents(agents), [agents]);
  const runtimeReady = useAgentRuntimeReady();
  const update = useUpdateTask();
  const [open, setOpen] = useState(false);
  const [assigning, setAssigning] = useState<string | null>(null);
  const [delegating, setDelegating] = useState(false);
  const current = taskAgent(task);
  const currentName = current ? findAgent(agents, current)?.title ?? current : '';
  // A teammate's agent holds the task: it is read-only here, so nothing hands the task on or clears it.
  const heldByTeammate = !!current && findAgent(agents, current)?.readOnly === true;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  const clearAgent = () => {
    setOpen(false);
    update.mutate(
      { slug: task.slug, updates: { agent: null } },
      { onError: () => onError(tr(t, 'tasks.unassignAgentFailed', "Couldn't remove the agent. Try again.")) },
    );
  };

  return (
    <div className="gta">
      {current && (
        <span className="task-agent-row gta-current" title={currentName}>
          <TaskAgentFace slug={current} size={22} />
        </span>
      )}
      {!heldByTeammate && <button
        type="button"
        className="gta-btn"
        data-testid="give-to-agent"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {t('tasks.assignToAgent')} <span aria-hidden>▾</span>
      </button>}
      {open && !heldByTeammate && (
        <>
          <div className="gta-scrim" onClick={() => setOpen(false)} />
          <div className="gta-menu" role="menu">
            {current && (
              <div className="gta-section gta-assigned">
                <TaskAgentFace slug={current} size={20} />
                <span className="gta-assigned-name">{currentName}</span>
                <button type="button" className="gta-clear" onClick={clearAgent} disabled={update.isPending} aria-label={`${t('tasks.unassignAgent')}: ${currentName}`}>
                  Clear
                </button>
              </div>
            )}
            <div className="gta-label">AI Team</div>
            {offered.length === 0 && <div className="gta-empty">No agents in this project yet.</div>}
            {offered.map((a) => (
              <button
                key={a.slug}
                type="button"
                role="menuitem"
                className="gta-item"
                data-testid={`give-agent-${a.slug}`}
                onClick={() => { setOpen(false); setAssigning(a.slug); }}
              >
                <AgentAvatar of="agent" slug={a.slug} title={a.title} hasPhoto={a.hasPhoto ?? false} size={20} />
                <span className="gta-item-name">{a.title}</span>
                {!a.approvedToRun && <span className="gta-item-hint">needs approval</span>}
              </button>
            ))}
            {runtimeReady && (
              <>
                <div className="gta-divider" />
                <button type="button" role="menuitem" className="gta-item gta-item--accent" data-testid="give-new-claude" onClick={() => { setOpen(false); setDelegating(true); }}>
                  <span className="gta-spark" aria-hidden><SparkIcon size={15} /></span>
                  <span className="gta-item-name">New Claude chat</span>
                </button>
              </>
            )}
          </div>
        </>
      )}
      {assigning && <AssignToAgentComposer task={task} initialAgent={assigning} onClose={() => setAssigning(null)} />}
      {delegating && <DelegateComposer task={task} onClose={() => setDelegating(false)} />}
    </div>
  );
}
