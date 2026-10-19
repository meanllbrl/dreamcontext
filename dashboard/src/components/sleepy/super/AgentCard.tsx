import { useEffect, useReducer } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { pollMs } from '../../../lib/windowActivity';
import { fill } from '../../../lib/fill';
import type { SuperChild } from '../../../lib/superTypes';
import type { SessionStatusInfo } from '../agentStatus';
import type { ChatSession } from '../chatSession';
import { backgroundOf, doingOf, elapsedLabel, lastLineOf, lastLinesOf, type DoingLine } from './superHandover';

/**
 * A child chat's card (plan-r8 F11, owner decision O10): its TITLE, ONE line of what it is
 * doing now (the tool in flight while busy, else the last thing it wrote), its live state with
 * how long it has been at it, a chip while it runs a shell or an agent in the background, its
 * worktree branch and an "asks you" badge. A tall card adds the last few lines it wrote. The
 * title and the line sit at the top, the state at the foot, so a quiet card still reads whole.
 *
 * Everything comes from the child's LIVE `ChatSession` in this window: 0 network requests per
 * card. The card frame (SuperContainer) re-renders it at most once a frame on a token; the
 * elapsed label ticks on a slow clock that follows `pollMs`.
 */
export function AgentCard({ session, child, title, asksOwner, status, tall }: {
  session: ChatSession | undefined;
  child: SuperChild | undefined;
  title: string;
  /** The queue holds an item about this child that the OWNER must answer. */
  asksOwner: boolean;
  status: SessionStatusInfo;
  /** Drawn taller than wide: room for the last few lines under the doing-line. */
  tall: boolean;
}) {
  const { t } = useI18n();
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const timer = window.setInterval(force, pollMs(30_000));
    return () => window.clearInterval(timer);
  }, []);

  const model = session?.getModel();
  const doing = session?.busy && model ? doingOf(model.items) : null;
  const line = doing ? doingText(t, doing) : (model ? lastLineOf(model.items) : '');
  const bg = model ? backgroundOf(model.subAgents) : { shells: 0, agents: 0 };
  const lines = tall && model ? lastLinesOf(model.items, 4).filter((l) => l !== line) : [];
  const since = session?.busy && model?.turnStartedAt ? model.turnStartedAt : child?.startedAt;
  return (
    <div className="super-card" data-kind={status.kind}>
      <div className="super-card-top">
        <span className="super-card-dot" data-kind={status.kind} aria-hidden />
        <span className="super-card-brief" title={title}>{title}</span>
      </div>
      <div className="super-card-line" data-testid="super-card-doing">{line || t(`super.card.state.${status.kind}`)}</div>
      {lines.length > 0 && (
        <div className="super-card-lines" aria-hidden>
          {lines.map((l, i) => <div key={i} className="super-card-lines-row">{l}</div>)}
        </div>
      )}
      {/* Anchored to the card's foot, like a widget: what state it is in, for how long, what it holds. */}
      <div className="super-card-foot">
        {(asksOwner || child?.branch) && (
          <div className="super-card-tags">
            {asksOwner && <span className="super-card-asks">{t('super.card.asksYou')}</span>}
            {child?.branch && <span className="super-card-branch" title={child.worktree}>{child.branch}</span>}
          </div>
        )}
        <div className="super-card-meta">
          <span className="super-card-state">{t(`super.card.state.${status.kind}`)}</span>
          {since ? <span>· {elapsedLabel(Date.now() - since)}</span> : null}
          {(bg.shells > 0 || bg.agents > 0) && (
            <span className="super-card-bg" data-testid="super-card-bg">{backgroundText(t, bg)}</span>
          )}
        </div>
      </div>
    </div>
  );
}

function doingText(t: (k: string) => string, d: DoingLine): string {
  const subject = d.subject || '…';
  return fill(t(`super.card.doing.${d.verb}`), { x: subject });
}

function backgroundText(t: (k: string) => string, bg: { shells: number; agents: number }): string {
  const parts: string[] = [];
  if (bg.shells) parts.push(fill(t(bg.shells === 1 ? 'super.card.bg.shell' : 'super.card.bg.shells'), { n: String(bg.shells) }));
  if (bg.agents) parts.push(fill(t(bg.agents === 1 ? 'super.card.bg.agent' : 'super.card.bg.agents'), { n: String(bg.agents) }));
  return parts.join(' · ');
}
