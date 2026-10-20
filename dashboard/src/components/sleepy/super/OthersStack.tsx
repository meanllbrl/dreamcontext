import type { RefObject } from 'react';
import { useI18n } from '../../../context/I18nContext';
import type { ContainerKind } from '../../../lib/superTypes';
import type { Rect } from './superLayout';

export interface OthersItem {
  id: string;
  title: string;
  kind: ContainerKind | 'group';
  /** A chat's (or a group's) glow state, so an asking card in Others is still obvious at a glance. */
  status?: 'working' | 'asking' | 'idle';
}

/**
 * "Others" in the bottom-right corner: the stage's OWN group (owner decision 2026-10-20). It
 * holds every card (and group) the owner or the agent put aside, and every one the stage could not
 * fit; it is never renamed or dissolved and it never leaves the corner. Clicking it (or Enter)
 * opens the same panel a group opens (GroupPanel, drawn by the surface); the dots are the first
 * few cards' states, the count how many it holds.
 */
export function OthersStack({ items, rect, open, onToggle, stackRef }: {
  items: readonly OthersItem[];
  rect: Rect;
  open: boolean;
  onToggle: () => void;
  stackRef: RefObject<HTMLButtonElement | null>;
}) {
  const { t } = useI18n();
  if (!items.length) return null;
  const asking = items.some((i) => i.status === 'asking');
  return (
    <div
      className="super-others"
      data-testid="super-others"
      data-open={open ? 'true' : undefined}
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
    >
      <button
        ref={stackRef}
        type="button"
        className="super-others-stack"
        data-testid="super-others-stack"
        data-asking={asking ? 'true' : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('super.others.label').replace('{n}', String(items.length))}
        onClick={onToggle}
      >
        <span className="super-others-sheets" aria-hidden>
          <span /><span /><span />
        </span>
        <span className="super-others-name">{t('super.others.name')}</span>
        <span className="super-others-dots" aria-hidden>
          {items.slice(0, 4).map((it) => <span key={it.id} className="super-others-dot" data-status={it.status} />)}
        </span>
        <span className="super-others-count">{items.length}</span>
      </button>
    </div>
  );
}
