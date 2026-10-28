import type { ReactNode, RefObject } from 'react';
import { useI18n } from '../../../context/I18nContext';
import type { ContainerKind } from '../../../lib/superTypes';
import type { Rect } from './superLayout';

export interface OthersItem {
  id: string;
  title: string;
  kind: ContainerKind | 'group';
  /** A chat's (or a group's) glow state, so an asking card in Others is still obvious at a glance. */
  status?: 'working' | 'asking' | 'idle' | 'ended';
}

/**
 * "Others" in the bottom-right corner: the stage's OWN group (owner decision 2026-10-20). It
 * holds every card (and group) the owner or the agent put aside, and every one the stage could not
 * fit; it is never renamed or dissolved and it never leaves the corner. Clicking it (or Enter)
 * opens the same panel a group opens (GroupPanel, drawn by the surface); the dots are the first
 * few cards' states, the count how many it holds.
 */
export function OthersStack({ items, rect, open, onToggle, stackRef, more = false }: {
  items: readonly OthersItem[];
  rect: Rect;
  open: boolean;
  onToggle: () => void;
  stackRef?: RefObject<HTMLButtonElement | null>;
  /** The rail's temporary "more" tile beside a page or a presentation (owner 2026-10-28): the same
   *  pill, its own name, its live jobs' dots; it lives only as long as that view. */
  more?: boolean;
}) {
  const { t } = useI18n();
  if (!items.length) return null;
  const asking = items.some((i) => i.status === 'asking');
  return (
    <div
      className={more ? 'super-others super-others--more' : 'super-others'}
      data-testid={more ? 'super-more' : 'super-others'}
      data-open={open ? 'true' : undefined}
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
    >
      <StagePill
        buttonRef={stackRef}
        testId={more ? 'super-more-stack' : 'super-others-stack'}
        lead={<span className="super-others-sheets" aria-hidden><span /><span /><span /></span>}
        name={t(more ? 'super.more.name' : 'super.others.name')}
        dots={items.slice(0, 4).map((it) => ({ id: it.id, status: it.status }))}
        count={items.length}
        asking={asking}
        expanded={open}
        label={t(more ? 'super.more.label' : 'super.others.label').replace('{n}', String(items.length))}
        onClick={onToggle}
      />
    </div>
  );
}

/**
 * The Others pill's button body, shared with the Super dock's pill (owner 2026-10-25: reuse the
 * stage's own pill, no new one): a lead, the name, up to four status dots and the count. A zero
 * count draws no count chip; `badge` is anything the caller pins on it (the dock's "?").
 */
export function StagePill({ buttonRef, testId, lead, name, dots, count, asking, news, expanded, label, onClick, badge }: {
  buttonRef?: RefObject<HTMLButtonElement | null>;
  testId: string;
  lead: ReactNode;
  name: string;
  dots: readonly { id: string; status?: OthersItem['status'] }[];
  count: number;
  asking: boolean;
  news?: boolean;
  expanded: boolean;
  label: string;
  onClick: () => void;
  badge?: ReactNode;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className="super-others-stack"
      data-testid={testId}
      data-asking={asking ? 'true' : undefined}
      data-news={news ? 'true' : undefined}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      aria-label={label}
      onClick={onClick}
    >
      {lead}
      <span className="super-others-name">{name}</span>
      {dots.length > 0 && (
        <span className="super-others-dots" aria-hidden>
          {dots.map((it) => <span key={it.id} className="super-others-dot" data-status={it.status} data-super-tone={it.status} />)}
        </span>
      )}
      {count > 0 && <span className="super-others-count">{count}</span>}
      {badge}
    </button>
  );
}
