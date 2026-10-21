import { useEffect, useReducer } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { pollMs } from '../../../lib/windowActivity';
import type { SuperChild } from '../../../lib/superTypes';
import type { SessionStatusInfo, SessionStatusKind } from '../agentStatus';
import type { ChatSession } from '../chatSession';
import { useSpinSlot } from './spinSlots';
import { useLiveSession } from './liveSession';
import { backgroundOf, doingOf, elapsedLabel, lastLineOf, lastLinesOf, modelChip, toneOfStatus, type DoingLine } from './superHandover';

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
  // Its own lines follow the session (the frame around it follows only the status).
  useLiveSession(session, () => cardKeyOf(session, tall));

  const model = session?.getModel();
  const doing = session?.busy && model ? doingOf(model.items) : null;
  const line = doing ? doingText(t, doing) : (model ? lastLineOf(model.items) : '');
  const bg = model ? backgroundOf(model.subAgents) : { shells: 0, agents: 0 };
  const lines = tall && model ? lastLinesOf(model.items, 4).filter((l) => l !== line) : [];
  const since = session?.busy && model?.turnStartedAt ? model.turnStartedAt : child?.startedAt;
  const chip = childModelChip(session, child);
  return (
    <div className="super-card" data-kind={status.kind} data-super-tone={toneOfStatus(status.kind)}>
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
        {(asksOwner || child?.branch || chip) && (
          <div className="super-card-tags">
            {asksOwner && <span className="super-card-asks">{t('super.card.asksYou')}</span>}
            {chip && <span className="super-tile-model" data-testid="super-card-model">{chip}</span>}
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

/**
 * A child chat as a floating TILE (owner decision 2026-10-20, direction "Cam HUD"): a 1:1 glass
 * tile with its status ring and kind, the title (two lines), what it is doing (two lines) and, at
 * the foot, its state, how long, and a chip while something runs in the background. The corner
 * brackets light while it works or asks. Same live reads as the card above: 0 requests.
 */
export function ChatTile({ session, child, title, asksOwner, status }: {
  session: ChatSession | undefined;
  child: SuperChild | undefined;
  title: string;
  asksOwner: boolean;
  status: SessionStatusInfo;
}) {
  const { t } = useI18n();
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const timer = window.setInterval(force, pollMs(30_000));
    return () => window.clearInterval(timer);
  }, []);
  // Re-rendered only when what the tile shows from the session changed (liveSession.ts).
  useLiveSession(session, () => cardKeyOf(session, false));
  const model = session?.getModel();
  const doing = session?.busy && model ? doingOf(model.items) : null;
  const line = doing ? doingText(t, doing) : (model ? lastLineOf(model.items) : '');
  const bg = model ? backgroundOf(model.subAgents) : { shells: 0, agents: 0 };
  const since = session?.busy && model?.turnStartedAt ? model.turnStartedAt : child?.startedAt;
  const state = t(`super.card.state.${status.kind}`);
  const bgCount = bg.shells + bg.agents;
  // The model it really runs (owner 2026-10-21), where the kind word stood: a chat tile is a chat.
  const chip = childModelChip(session, child);
  // While it works, a thin ring turns on its border (motion carries "working", the colour the
  // state): one of at most MAX_SPINNING at a time, the rest drawn closed (spinSlots.ts).
  const working = status.kind === 'working';
  const spin = useSpinSlot(child?.sessionId ?? session?.claudeId ?? '', working);
  return (
    <div className="super-tile" data-tile="chat" data-kind={status.kind} data-super-tone={toneOfStatus(status.kind)} title={child?.branch ? `${title}\n${child.branch}` : title}>
      <span className="super-tile-corners" aria-hidden />
      {working && <span className="super-tile-spin" data-spin={spin ? 'on' : 'closed'} data-testid="super-tile-spin" aria-hidden />}
      <div className="super-tile-top">
        <StatusRing kind={status.kind} />
        {chip
          ? <span className="super-tile-model" data-testid="super-card-model" title={session?.model || undefined}>{chip}</span>
          : <span className="super-tile-kind">{t('super.tile.kind.chat')}</span>}
      </div>
      <div className="super-tile-title">{title}</div>
      <div className="super-tile-line" data-testid="super-card-doing">{line || state}</div>
      <div className="super-tile-foot">
        {/* What the owner must answer takes the state word's place: the same word, once. */}
        {asksOwner ? <span className="super-tile-asks">{t('super.card.asksYou')}</span> : <span className="super-tile-state">{state}</span>}
        {since ? <span>· {elapsedLabel(Date.now() - since)}</span> : null}
        {bgCount > 0 && (
          <span className="super-tile-chip" data-testid="super-card-bg" title={backgroundText(t, bg)} aria-label={backgroundText(t, bg)}>⧉ {bgCount}</span>
        )}
      </div>
    </div>
  );
}

/**
 * A chat's state as a ring: its colour is the state's tone (superTone.css: green working, pink
 * asking, purple idle, red ended, amber starting; a bare track saved), its mark says it again for
 * anyone who does not read colour (a dot, a "?", a check). Static: never spins.
 */
export function StatusRing({ kind, size = 18 }: { kind: SessionStatusKind; size?: number }) {
  const stroke = size >= 16 ? 2 : 1.6;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const mid = size / 2;
  const frac = kind === 'working' ? 0.75 : kind === 'starting' ? 0.25 : kind === 'saved' ? 0 : 1;
  return (
    <svg className="super-ring" data-kind={kind} data-super-tone={toneOfStatus(kind)} width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      <circle className="super-ring-track" cx={mid} cy={mid} r={r} fill="none" strokeWidth={stroke} />
      {frac > 0 && (
        <circle className="super-ring-arc" cx={mid} cy={mid} r={r} fill="none" strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={`${c * frac} ${c}`} transform={`rotate(-90 ${mid} ${mid})`} />
      )}
      {size >= 16 && kind === 'working' && <circle className="super-ring-mark" cx={mid} cy={mid} r={size * 0.12} />}
      {size >= 16 && kind === 'asking' && (
        <text className="super-ring-mark" x={mid} y={mid + size * 0.17} textAnchor="middle" fontSize={size * 0.5} fontWeight={800}>?</text>
      )}
      {size >= 16 && kind === 'ready' && (
        <path className="super-ring-check" d={`M${mid - size * 0.17} ${mid}l${size * 0.12} ${size * 0.12} ${size * 0.22}-${size * 0.24}`}
          fill="none" strokeWidth={stroke * 0.85} strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  );
}

/** What a chat's tile (or, `tall`, its large card) draws from the live session, as one string:
 *  a token that does not change the doing-line, the last lines, the background count, the clock
 *  start or the model re-renders nothing. */
export function cardKeyOf(session: ChatSession | undefined, tall: boolean): string {
  const model = session?.getModel();
  if (!model) return '';
  const doing = session?.busy ? doingOf(model.items) : null;
  const bg = backgroundOf(model.subAgents);
  return [
    doing ? `${doing.verb}\u0001${doing.subject}` : lastLineOf(model.items),
    tall ? lastLinesOf(model.items, 4).join('\u0001') : '',
    bg.shells, bg.agents, session?.busy ? model.turnStartedAt ?? 0 : 0, session?.model ?? '', session?.effort ?? '',
  ].join('\u0002');
}

/** A child's model chip: its live session's spawn values (what its composer shows), else what the
 *  record stored for it (`super delegate --model/--effort`, a field a newer record carries). */
export function childModelChip(session: ChatSession | undefined, child: SuperChild | undefined): string | null {
  const stored = child as (SuperChild & { model?: string; effort?: string }) | undefined;
  if (session?.model) return modelChip(session.model, session.effort || stored?.effort);
  return modelChip(stored?.model, stored?.effort);
}

function doingText(t: (k: string) => string, d: DoingLine): string {
  const subject = d.subject || '…';
  return t(`super.card.doing.${d.verb}`).replace('{x}', subject);
}

function backgroundText(t: (k: string) => string, bg: { shells: number; agents: number }): string {
  const parts: string[] = [];
  if (bg.shells) parts.push(t(bg.shells === 1 ? 'super.card.bg.shell' : 'super.card.bg.shells').replace('{n}', String(bg.shells)));
  if (bg.agents) parts.push(t(bg.agents === 1 ? 'super.card.bg.agent' : 'super.card.bg.agents').replace('{n}', String(bg.agents)));
  return parts.join(' · ');
}
