import { useEffect, useMemo, useReducer } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { pollMs } from '../../../lib/windowActivity';
import type { SuperChild } from '../../../lib/superTypes';
import type { SessionStatusInfo, SessionStatusKind } from '../agentStatus';
import type { ChatSession } from '../chatSession';
import { useSpinSlot } from './spinSlots';
import { useLiveSession } from './liveSession';
import { AccountLimitRing } from '../chat/UsageRings';
import { FALLBACK_MODEL_CONFIG, chatAccountOf } from '../../../lib/agentComposer';
import { useAgentModelConfig, useAgentTools } from '../../../hooks/useAgentCapabilities';
import { ToolMark } from '../chat/model-picker/ModelPicker';
import { activeRow, claudeState, codexState, type PickerToolState } from '../chat/model-picker/pickerModel';
import { backgroundOf, doingOf, elapsedLabel, lastLineOf, lastLinesOf, chipFromPickerLabel, modelChip, toneOfStatus, type DoingLine } from './superHandover';

/** What a child's card says it waits on the owner for: a question it asks (`ask`), or something
 *  only he can do (`owner`: a command to run himself, a key, a checklist, a sign-in). */
export type AsksOwner = false | 'ask' | 'owner';
const asksKey = (a: AsksOwner) => (a === 'owner' ? 'super.card.needsYou' : 'super.card.asksYou');

/**
 * A child chat's card (plan-r8 F11, owner decision O10): its TITLE, ONE line of what it is
 * doing now (the tool in flight while busy, else the last thing it wrote), its live state with
 * how long it has been at it, a chip while it runs a shell or an agent in the background, its
 * worktree branch and an "asks you" badge. A tall card adds the last few lines it wrote. The
 * title and the line sit at the top, the state at the foot, so a quiet card still reads whole.
 *
 * Everything comes from the child's LIVE `ChatSession` in this window: 0 network requests per
 * card (the rate-limit ring rides the per-account usage poll the composers already share). The card frame (SuperContainer) re-renders it at most once a frame on a token; the
 * elapsed label ticks on a slow clock that follows `pollMs`.
 */
export function AgentCard({ session, child, title, asksOwner, status, tall }: {
  session: ChatSession | undefined;
  child: SuperChild | undefined;
  title: string;
  /** The queue holds an item about this child that the OWNER must answer. */
  asksOwner: AsksOwner;
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
  const line = child?.startError ?? (doing ? doingText(t, doing) : (model ? lastLineOf(model.items) : ''));
  const bg = model ? backgroundOf(model.subAgents) : { shells: 0, agents: 0 };
  const lines = tall && model ? lastLinesOf(model.items, 4).filter((l) => l !== line) : [];
  const since = session?.busy && model?.turnStartedAt ? model.turnStartedAt : child?.startedAt;
  const chip = childModelChip(session, child);
  const tool = childTool(session, child);
  return (
    <div className="super-card" data-kind={status.kind} data-super-tone={toneOfStatus(status.kind)}>
      <div className="super-card-top">
        <span className="super-card-dot" data-kind={status.kind} aria-hidden />
        <span className="super-card-brief" title={title}>{title}</span>
        <AccountLimitRing accountId={chatAccountOf(session)} />
      </div>
      <div className="super-card-line" data-testid="super-card-doing">{line || t(`super.card.state.${status.kind}`)}</div>
      {lines.length > 0 && (
        <div className="super-card-lines" aria-hidden>
          {lines.map((l, i) => <div key={i} className="super-card-lines-row">{l}</div>)}
        </div>
      )}
      {/* Anchored to the card's foot, like a widget: what state it is in, for how long, what it holds. */}
      <div className="super-card-foot">
        {(asksOwner || child?.branch || chip || tool !== 'claude') && (
          <div className="super-card-tags">
            {asksOwner && <span className="super-card-asks" data-asks={asksOwner}>{t(asksKey(asksOwner))}</span>}
            <ChildModelChip session={session} child={child} />
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
 * tile with its account's rate-limit ring and model, the title (two lines), what it is doing (two lines) and, at
 * the foot, its state (dot + word), how long, and a chip while something runs in the background.
 * The corner brackets light while it works or asks. Same live reads as the card above; the ring
 * shares the composer's per-account usage poll, so a tile adds no request of its own.
 */
export function ChatTile({ session, child, title, asksOwner, status }: {
  session: ChatSession | undefined;
  child: SuperChild | undefined;
  title: string;
  asksOwner: AsksOwner;
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
  const line = child?.startError ?? (doing ? doingText(t, doing) : (model ? lastLineOf(model.items) : ''));
  const bg = model ? backgroundOf(model.subAgents) : { shells: 0, agents: 0 };
  const since = session?.busy && model?.turnStartedAt ? model.turnStartedAt : child?.startedAt;
  const state = t(`super.card.state.${status.kind}`);
  const bgCount = bg.shells + bg.agents;
  // The model it really runs (owner 2026-10-21), where the kind word stood: a chat tile is a chat.
  const chip = childModelChip(session, child);
  const tool = childTool(session, child);
  // While it works, a thin ring turns on its border (motion carries "working", the colour the
  // state): one of at most MAX_SPINNING at a time, the rest drawn closed (spinSlots.ts).
  const working = status.kind === 'working';
  const spin = useSpinSlot(child?.sessionId ?? session?.claudeId ?? '', working);
  return (
    <div className="super-tile" data-tile="chat" data-kind={status.kind} data-super-tone={toneOfStatus(status.kind)} title={[title, child?.branch, child?.startError].filter(Boolean).join('\n')}>
      <span className="super-tile-corners" aria-hidden />
      {working && <span className="super-tile-spin" data-spin={spin ? 'on' : 'closed'} data-testid="super-tile-spin" aria-hidden />}
      <div className="super-tile-top">
        {/* The REAL rate limit of the account this chat runs on (owner 2026-10-28), drawn like
            the composer's ring. The chat's state, which this ring used to draw, is the dot and
            the toned state word at the foot. */}
        <AccountLimitRing accountId={chatAccountOf(session)} />
        {chip || tool !== 'claude'
          ? <ChildModelChip session={session} child={child} />
          : <span className="super-tile-kind">{t('super.tile.kind.chat')}</span>}
      </div>
      <div className="super-tile-title">{title}</div>
      <div className="super-tile-line" data-testid="super-card-doing">{line || state}</div>
      <div className="super-tile-foot">
        <span className="super-card-dot" data-kind={status.kind} data-testid="super-tile-status" aria-hidden />
        {/* What the owner must answer takes the state word's place: the same word, once. */}
        {asksOwner ? <span className="super-tile-asks" data-asks={asksOwner} data-testid="super-tile-asks">{t(asksKey(asksOwner))}</span> : <span className="super-tile-state">{state}</span>}
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
    // The rate-limit ring follows the account: a move to another account redraws at once.
    model.activeAccountId ?? '',
  ].join('\u0002');
}

/** A child's model chip: its live session's spawn values (what its composer shows), else what the
 *  record stored for it (`super delegate --model/--effort`, a field a newer record carries). */
export function childModelChip(session: ChatSession | undefined, child: SuperChild | undefined): string | null {
  const tool = childTool(session, child);
  if (session?.model) return modelChip(session.model, session.effort || child?.effort, tool);
  return modelChip(child?.model, child?.effort, tool);
}

const TOOL_LABEL = { codex: 'Codex', antigravity: 'Antigravity' } as const;

/** Every tool's models as the chat's model picker lists them (ChatPaneHost reads them the same
 *  way), so a card names a model with the picker's own words. */
function usePickerCatalog(): PickerToolState[] {
  const modelConfig = useAgentModelConfig().data ?? FALLBACK_MODEL_CONFIG;
  const tools = useAgentTools().data;
  const codexInfo = tools?.find((x) => x.tool === 'codex');
  const antigravityInfo = tools?.find((x) => x.tool === 'antigravity');
  return useMemo(
    () => [claudeState(modelConfig), ...(codexInfo ? [codexState(codexInfo)] : []), ...(antigravityInfo ? [codexState(antigravityInfo)] : [])],
    [modelConfig, codexInfo, antigravityInfo],
  );
}

/** A child's model as the picker names it, with its level: the live session's spawn values, else
 *  what the record holds (its `system/init` or `delegate --model`). Null when no model is known. */
export function childChipParts(catalog: PickerToolState[], session: ChatSession | undefined, child: SuperChild | undefined): { name: string; level: string } | null {
  const tool = childTool(session, child);
  const model = (session?.model || child?.model || '').trim();
  if (!model) return null;
  const effort = session?.model ? session.effort || child?.effort : child?.effort;
  const own = catalog.find((x) => x.tool === tool);
  const row = own ? activeRow(own, model) : null;
  return chipFromPickerLabel(row?.label, model, effort, tool);
}

/**
 * A child's model chip: a Codex or Antigravity child's tool mark (an icon, no tool word) and the
 * model's full name as the picker shows it, then its level. The name is never cut: in a narrow
 * card the chip takes its own line and the level drops under the name. Its title and label say
 * the tool and the model in words. Null for a Claude child whose model is not known yet.
 */
function ChildModelChip({ session, child }: { session: ChatSession | undefined; child: SuperChild | undefined }) {
  const catalog = usePickerCatalog();
  const tool = childTool(session, child);
  const parts = childChipParts(catalog, session, child);
  if (!parts && tool === 'claude') return null;
  const label = tool === 'claude' ? '' : TOOL_LABEL[tool];
  const words = [label, parts ? (parts.level ? `${parts.name} · ${parts.level}` : parts.name) : ''].filter(Boolean).join(' ');
  return (
    <span className="super-tile-model" data-testid="super-card-model" data-tool={tool} title={words} aria-label={words}>
      {tool !== 'claude' && <ToolMark tool={tool} />}
      <span className="super-tile-model-name" data-testid="super-card-model-name">{parts ? parts.name : label}</span>
      {parts?.level ? <span className="super-tile-model-level">{`· ${parts.level}`}</span> : null}
    </span>
  );
}

/** The tool a child runs on: its live session's binding, else the record's (`delegate --tool`). */
export function childTool(session: ChatSession | undefined, child: SuperChild | undefined): 'claude' | 'codex' | 'antigravity' {
  return session?.tool || child?.tool || 'claude';
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
