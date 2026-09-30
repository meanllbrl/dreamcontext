import { useRef, useState } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { useApplyTweaks, useSyncInsight, type InsightSummary, type LabSyncForce } from '../../../hooks/useLab';
import { RangeControl, nonWindowTweaks } from '../RangeControl';
import { TweakEditor } from '../TweakEditor';
import { chartEntry } from '../chartRegistry';
import { BoardPopover, MenuItem } from './BoardPopover';

/**
 * A card's ⋯ menu: Edit blocks, Open detail, Refresh, Force full refresh,
 * Range ▸, Tweaks, Duplicate card, Move to board ▸, Remove.
 *
 * What touches the card's DATA runs here (a sync, a tweak save), through the
 * same hooks the detail panel uses: Refresh is `'user'` (the TTL is skipped,
 * the upstream probe still decides), Force full refresh is `'hard'` (the probe
 * is skipped too), and a range or tweak change saves and re-fetches as one
 * mutation (`useApplyTweaks`). What touches the BOARD (duplicate, move,
 * remove, open the inspector) is handed to the page, which owns the save
 * queue and the undo stack.
 *
 * Items that need a primary insight are disabled on a card without one;
 * board edits are disabled on a board that cannot be written.
 */

type Level = 'root' | 'range' | 'tweaks' | 'move';

export interface CardMenuProps {
  /** The card's primary insight, when it has one that exists. */
  summary?: InsightSummary;
  /** The board can be written (not an error board). */
  editable: boolean;
  /** Boards a card can move to (every board but this one). */
  targets: { slug: string; title: string }[];
  onEditBlocks: () => void;
  onOpenDetail: () => void;
  onDuplicate: () => void;
  onMoveTo: (slug: string) => void;
  onRemove: () => void;
  onToast: (text: string) => void;
}

export function CardMenu({
  summary, editable, targets, onEditBlocks, onOpenDetail, onDuplicate, onMoveTo, onRemove, onToast,
}: CardMenuProps) {
  const { t } = useI18n();
  const [level, setLevel] = useState<Level | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const sync = useSyncInsight();
  const applyTweaks = useApplyTweaks();

  const close = () => {
    const inside = level !== null;
    setLevel(null);
    if (inside) triggerRef.current?.focus();
  };
  const run = (fn: () => void) => () => { setLevel(null); fn(); };

  const title = summary?.title ?? '';
  const refresh = (force: LabSyncForce) => {
    if (!summary) return;
    setLevel(null);
    sync.mutate({ slug: summary.slug, force }, {
      onSuccess: (data) => {
        const result = data.results[0];
        if (result?.status === 'failed') {
          onToast(t('lab.board.toast.refreshFailed').replace('{title}', title).replace('{error}', result.error ?? ''));
        } else if (result?.status === 'fresh' && result.reason === 'upstream-unchanged') {
          onToast(t('lab.board.toast.upstreamUnchanged').replace('{title}', title));
        } else {
          onToast(t('lab.board.toast.refreshed').replace('{title}', title));
        }
      },
      onError: (err) => onToast(t('lab.board.toast.refreshFailed').replace('{title}', title).replace('{error}', (err as Error).message)),
    });
  };

  const apply = (values: Record<string, string>) => {
    if (!summary) return;
    setLevel(null);
    applyTweaks.mutate({ slug: summary.slug, tweaks: values }, {
      onSuccess: ({ synced, error }) => onToast(synced
        ? t('lab.board.toast.tweaksApplied').replace('{title}', title)
        : t('lab.board.toast.tweaksSyncFailed').replace('{title}', title).replace('{error}', error ?? '')),
      onError: (err) => onToast(t('lab.board.toast.tweaksFailed').replace('{title}', title).replace('{error}', (err as Error).message)),
    });
  };

  const windowed = !!summary && chartEntry(summary.render).supportsWindow;
  const tweaks = summary ? nonWindowTweaks(summary.tweaks) : [];
  const busy = sync.isPending || applyTweaks.isPending;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="board-card-menu"
        data-lab-card-menu
        aria-haspopup="menu"
        aria-expanded={level !== null}
        aria-label={t('lab.board.card.menu')}
        title={t('lab.board.card.menu')}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); setLevel((v) => (v === null ? 'root' : null)); }}
      >
        <span aria-hidden="true">{busy ? '…' : '⋯'}</span>
      </button>
      {level === 'root' && (
        <BoardPopover key="root" anchor={triggerRef} onClose={close} label={t('lab.board.card.menu')}>
          <MenuItem hook="edit-blocks" disabled={!editable} onSelect={run(onEditBlocks)}>{t('lab.board.card.editBlocks')}</MenuItem>
          <MenuItem hook="open-detail" disabled={!summary} onSelect={run(onOpenDetail)}>{t('lab.board.card.openDetail')}</MenuItem>
          <MenuItem hook="refresh" disabled={!summary || busy} onSelect={() => refresh('user')}>{t('lab.board.card.refresh')}</MenuItem>
          <MenuItem hook="force-refresh" disabled={!summary || busy} onSelect={() => refresh('hard')}>{t('lab.board.card.forceRefresh')}</MenuItem>
          <MenuItem hook="range" submenu disabled={!windowed || busy} onSelect={() => setLevel('range')}>{t('lab.board.card.range')}</MenuItem>
          <MenuItem hook="tweaks" submenu disabled={tweaks.length === 0 || busy} onSelect={() => setLevel('tweaks')}>{t('lab.board.card.tweaks')}</MenuItem>
          <div className="board-menu-sep" role="separator" />
          <MenuItem hook="duplicate" disabled={!editable} onSelect={run(onDuplicate)}>{t('lab.board.card.duplicate')}</MenuItem>
          <MenuItem hook="move" submenu disabled={!editable || targets.length === 0} onSelect={() => setLevel('move')}>{t('lab.board.card.moveTo')}</MenuItem>
          <MenuItem hook="remove" danger disabled={!editable} onSelect={run(onRemove)}>{t('lab.board.card.remove')}</MenuItem>
        </BoardPopover>
      )}
      {level === 'move' && (
        <BoardPopover key="move" anchor={triggerRef} onClose={close} label={t('lab.board.card.moveTo')}>
          <MenuItem onSelect={() => setLevel('root')}>{t('lab.board.menu.back')}</MenuItem>
          <div className="board-menu-sep" role="separator" />
          {targets.map((b) => (
            <MenuItem key={b.slug} hook={`move:${b.slug}`} onSelect={run(() => onMoveTo(b.slug))}>{b.title}</MenuItem>
          ))}
        </BoardPopover>
      )}
      {level === 'range' && summary && (
        <BoardPopover key="range" anchor={triggerRef} onClose={close} label={t('lab.board.card.range')} role="dialog" className="board-popover--wide">
          <button type="button" className="board-btn board-btn--quiet" onClick={() => setLevel('root')}>{t('lab.board.menu.back')}</button>
          <RangeControl tweaks={summary.tweaks} disabled={busy} onApply={apply} />
        </BoardPopover>
      )}
      {level === 'tweaks' && summary && (
        <BoardPopover key="tweaks" anchor={triggerRef} onClose={close} label={t('lab.board.card.tweaks')} role="dialog" className="board-popover--wide">
          <button type="button" className="board-btn board-btn--quiet" onClick={() => setLevel('root')}>{t('lab.board.menu.back')}</button>
          <TweakEditor tweaks={tweaks} saving={applyTweaks.isPending} onSave={apply} />
        </BoardPopover>
      )}
    </>
  );
}
