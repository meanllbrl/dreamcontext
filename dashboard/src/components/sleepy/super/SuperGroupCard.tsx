import { useEffect, useReducer, type KeyboardEvent, type PointerEvent } from 'react';
import { useI18n } from '../../../context/I18nContext';
import type { SuperGroup } from '../../../lib/superTypes';
import type { ChatSession } from '../chatSession';
import { IconButton } from './SuperContainer';
import { GroupTile, TileSheets, groupStatus, type GroupMember } from './SuperTiles';
import type { CardPlan } from './superLayout';

/**
 * Re-render when any member chat's session changes, at most once a frame (the group tile shows
 * each member's state). 0 requests: the sessions are the children's live ones in this window.
 */
function useLiveSessions(sessions: readonly (ChatSession | undefined)[]): void {
  const [, force] = useReducer((n: number) => n + 1, 0);
  const key = sessions.map((s) => s?.claudeId ?? '').join('|');
  useEffect(() => {
    let raf = 0;
    const offs = sessions.filter((s): s is ChatSession => !!s).map((s) => s.subscribe(() => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; force(); });
    }));
    return () => { for (const off of offs) off(); if (raf) cancelAnimationFrame(raf); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

/**
 * A group on the stage (owner decision 2026-10-20): ONE tile standing on a deck of sheets, placed
 * and moved like a card (same frame, same drag, same layout motion), glowing as its loudest member
 * (asking, else working). A click or Enter opens it (GroupPanel); its hover buttons put it in
 * Others, ask the Super Agent about it, or dissolve it.
 */
export function SuperGroupCard({ group, plan, members, sessions, pending, dropTarget, onPress, onOpen, onToOthers, onAskAbout, onUngroup }: {
  group: SuperGroup;
  plan: CardPlan;
  members: readonly GroupMember[];
  /** The member chats' live sessions (for the re-render; `members` already carries their state). */
  sessions: readonly (ChatSession | undefined)[];
  pending: boolean;
  /** A card held over the group: releasing adds it. */
  dropTarget: boolean;
  onPress: (e: PointerEvent<HTMLDivElement>, id: string) => void;
  onOpen: (id: string) => void;
  onToOthers: (id: string) => void;
  onAskAbout: (id: string) => void;
  onUngroup: (id: string) => void;
}) {
  const { t } = useI18n();
  useLiveSessions(sessions);
  const status = groupStatus(members);
  const glow = status === 'asking' ? 'asking' : status === 'working' ? 'working' : 'idle';
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(group.id); }
  };
  const label = t('super.group.label').replace('{name}', group.name).replace('{n}', String(members.length));
  return (
    <div
      className={`super-card-frame super-card-frame--group${pending ? ' super-card-frame--pending' : ''}`}
      data-testid="super-group"
      data-stage-key={group.id}
      data-group-id={group.id}
      data-where={plan.where}
      data-shape="square"
      data-owner={plan.owner ? 'true' : undefined}
      data-status={glow}
      data-drop-target={dropTarget ? 'group' : undefined}
      role="button"
      aria-haspopup="dialog"
      aria-label={label}
      tabIndex={0}
      style={{ left: plan.rect.x, top: plan.rect.y, width: plan.rect.width, height: plan.rect.height, zIndex: 10 + plan.z }}
      onPointerDown={(e) => onPress(e, group.id)}
      onClick={(e) => { if (!(e.target as HTMLElement).closest('button')) onOpen(group.id); }}
      onKeyDown={onKeyDown}
    >
      <div className="super-card-lift" aria-hidden />
      <TileSheets />
      <div className="super-card-clip">
        <div className="super-card-body" data-inert="true">
          <GroupTile group={group} members={members} />
        </div>
      </div>
      <span className="super-drop-ring" aria-hidden />
      <div className="super-card-actions">
        <IconButton icon="others" label={t('super.card.toOthers')} onClick={() => onToOthers(group.id)} />
        <IconButton icon="ask" label={t('super.card.askAbout')} onClick={() => onAskAbout(group.id)} />
        <IconButton icon="ungroup" label={t('super.group.ungroup')} onClick={() => onUngroup(group.id)} testId="super-group-ungroup" />
      </div>
    </div>
  );
}
