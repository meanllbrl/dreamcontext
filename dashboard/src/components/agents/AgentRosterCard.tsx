import { useI18n } from '../../context/I18nContext';
import { approvalState, type AgentApprovalState, type AgentSummary } from '../../hooks/useAgents';
import { AgentAvatar } from './AgentAvatar';
import './AgentRosterCard.css';

/** A translated string, or `fallback` when the key has no copy yet (the W4b rule: lanes add no keys). */
export function tx(t: (key: string) => string, key: string, fallback: string): string {
  const s = t(key);
  return s === key ? fallback : s;
}

/** How much of the project leans on this agent, per kind, plus the total. */
export function usageCounts(agent: Pick<AgentSummary, 'usedBy'>): {
  automations: number; boards: number; tasks: number; total: number;
} {
  const automations = agent.usedBy.automations.length;
  const boards = agent.usedBy.boards.length;
  const tasks = agent.usedBy.tasks.length;
  return { automations, boards, tasks, total: automations + boards + tasks };
}

/**
 * The two approval verdicts as two chips, in a fixed order: chat first, runs second. NEVER one
 * chip: a chat-approved agent that may not run must not read as "approved" (see `useAgents`).
 */
export function approvalChips(agent: Pick<AgentSummary, 'approvedForChat' | 'approvedToRun'>): {
  kind: 'chat' | 'run'; ok: boolean; labelKey: string;
}[] {
  return [
    { kind: 'chat', ok: agent.approvedForChat, labelKey: agent.approvedForChat ? 'agents.approval.chatOk' : 'agents.approval.chatNo' },
    { kind: 'run', ok: agent.approvedToRun, labelKey: agent.approvedToRun ? 'agents.approval.runOk' : 'agents.approval.runNo' },
  ];
}

/** The one quiet word each approval state reads as. */
export const APPROVAL_STATE_KEY: Record<AgentApprovalState, string> = {
  ready: 'agents.state.ready',
  'cant-run': 'agents.state.cantRun',
  'needs-approval': 'agents.state.needsApproval',
};

/** Only the two attention states get a dot. "Ready" is the same on every healthy card, so it is
 *  texture, not information (K26): a plain word, no mark. */
export function stateHasDot(state: AgentApprovalState): boolean {
  return state !== 'ready';
}

/** "Works on" as one line: each kind that has any, with its count. Empty when nothing uses it. */
export function worksOnLine(agent: Pick<AgentSummary, 'usedBy'>, t: (key: string) => string): string {
  const counts = usageCounts(agent);
  const parts: string[] = [];
  if (counts.automations) parts.push(`${t('agents.profile.usage.automations')} ${counts.automations}`);
  if (counts.boards) parts.push(`${t('agents.profile.usage.boards')} ${counts.boards}`);
  if (counts.tasks) parts.push(`${t('agents.profile.usage.tasks')} ${counts.tasks}`);
  return parts.join(' · ');
}

/**
 * One member of the team: a portrait card. Face, name, role line (the first line of its job),
 * its soul as a quiet quote, where it works, and the approval as one quiet word. The whole card
 * is one button that opens the profile; nothing on it acts on the agent, and it carries no chip:
 * the two verdicts read as three states (`approvalState`), never folded into one "approved".
 */
export function AgentRosterCard({
  agent, selected, onOpen,
}: {
  agent: AgentSummary;
  selected: boolean;
  onOpen: (slug: string) => void;
}) {
  const { t } = useI18n();
  const state = approvalState(agent);
  const works = worksOnLine(agent, t);
  const reason = state === 'ready'
    ? undefined
    : state === 'cant-run'
      ? tx(t, agent.approvalReason ? `agents.approval.reason.${agent.approvalReason}` : 'agents.approval.runNo', t('agents.approval.runNo'))
      : t('agents.approval.chatNo');

  return (
    <button
      type="button"
      className={`agr-card${selected ? ' agr-card--on' : ''}`}
      onClick={() => onOpen(agent.slug)}
      aria-pressed={selected}
      title={t('agents.roster.open').replace('{name}', agent.title)}
      data-agent={agent.slug}
      data-approval-state={state}
    >
      <span className="agr-top">
        <AgentAvatar of="agent" slug={agent.slug} title={agent.title} hasPhoto={agent.hasPhoto} size={96} />
        {(agent.shared || agent.implicit) && (
          <span className="agr-tags">
            {agent.shared && (
              <span className="agr-tag" title={t('agents.roster.sharedHint')}>{t('agents.roster.shared')}</span>
            )}
            {agent.implicit && (
              <span className="agr-tag" title={t('agents.roster.implicitHint')}>{t('agents.roster.implicit')}</span>
            )}
          </span>
        )}
      </span>
      <span className="agr-ident">
        <span className="agr-name">{agent.title}</span>
        {agent.roleLine && <span className="agr-role">{agent.roleLine}</span>}
      </span>
      {agent.soulExcerpt
        ? <span className="agr-soul">{agent.soulExcerpt}</span>
        : <span className="agr-soul agr-soul--empty">{t('agents.team.noSoul')}</span>}
      <span className="agr-works">
        {works
          ? <><span className="agr-works-label">{t('agents.team.worksOn')}</span>{works}</>
          : t('agents.team.worksNowhere')}
      </span>
      <span className="agr-foot">
        <span className={`agr-state agr-state--${state}`} title={reason}>
          {stateHasDot(state) && <span className="agr-dot" aria-hidden="true" />}
          {t(APPROVAL_STATE_KEY[state])}
        </span>
      </span>
    </button>
  );
}

/**
 * The empty seat at the end of the team: the main way to add an agent. Always the LAST item of
 * the grid, also when the team is empty.
 */
export function AgentTeamSeat({ onAdd }: { onAdd: () => void }) {
  const { t } = useI18n();
  return (
    <button type="button" className="agr-seat" onClick={onAdd} title={t('agents.team.addHint')} data-add-to-team>
      <span className="agr-seat-ring" aria-hidden="true">+</span>
      <span className="agr-seat-label">{t('agents.team.add')}</span>
    </button>
  );
}
