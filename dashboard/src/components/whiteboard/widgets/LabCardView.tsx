import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../../../context/I18nContext';
import { useBoardCaches } from '../../../hooks/useBoards';
import type { InsightCache, InsightSummary } from '../../../hooks/useLab';
import { isTopOverlay, popOverlay, pushOverlay } from '../../../lib/overlayStack';
import { BoardCard } from '../../lab/board/BoardCard';
import { EMPTY_VIEW, type CardView } from '../../lab/board/cardViewState';
import type { BoardResponse, Card } from '../../lab/board/boardTypes';
import { renderBlock } from '../../lab/blocks/blockRegistry';
import '../../lab/board/board.css';
import '../../lab/board/lab-shell.css';
import './labCardWidget.css';

/**
 * ONE Lab board card drawn on a whiteboard, exactly as Lab draws it: the same `BoardCard`, the
 * same block registry, the same server-resolved frames. Used by the `lab-card` widget (a card of
 * a real board) and by a funnel `insight` widget at L/XL (the funnel-explorer card the server
 * builds for one insight).
 *
 * The card's view (breakdown selection, open tab, lanes, filters) lives HERE, so the widget and
 * its full-screen copy are one view: picking `kreatif=TSM1` on the board and opening full screen
 * keeps the pick. Nothing of it is saved, as in Lab. Full screen is a portal over the whole
 * app (the canvas would clip and zoom it); Esc or the card's × closes it, queued on the app's
 * overlay stack with menus and panels.
 */
export function LabCardView({ response, card, fullscreen, onExitFullscreen, initialView }: {
  response: Pick<BoardResponse, 'frames' | 'summaries'>;
  card: Card;
  fullscreen: boolean;
  onExitFullscreen: () => void;
  /** The view the card opens with (a funnel widget opens on its Steps tab). Read once. */
  initialView?: CardView;
}) {
  const { t } = useI18n();
  const [view, setView] = useState<CardView>(initialView ?? EMPTY_VIEW);
  const onView = useCallback((fn: (v: CardView) => CardView) => setView(fn), []);
  const cards = useMemo(() => [card], [card]);
  const caches = useBoardCaches(cards);
  const cacheMap = useMemo<Record<string, InsightCache | null>>(() => {
    const out: Record<string, InsightCache | null> = {};
    for (const [slug, entry] of Object.entries(caches.data ?? {})) out[slug] = entry.cache;
    return out;
  }, [caches.data]);
  const summaries: Record<string, InsightSummary> = response.summaries;
  const missing = !!card.insight && !summaries[card.insight];

  const node = (full: boolean) => (
    <BoardCard
      card={card}
      frames={response.frames}
      summaries={summaries}
      caches={cacheMap}
      renderBlock={renderBlock}
      missing={missing}
      view={view}
      onView={onView}
      fullscreen={full}
      onExitFullscreen={full ? onExitFullscreen : undefined}
    />
  );

  return (
    <div className="wb-labcard" data-wb-labcard={card.id}>
      {/* ONE live copy: while full screen, the widget keeps its place as an empty box (an app card never runs two iframes). */}
      {fullscreen ? <div className="wb-labcard-lifted" aria-hidden="true" /> : node(false)}
      {fullscreen && (
        <FullscreenLayer label={card.title ?? (card.insight ? summaries[card.insight]?.title : undefined) ?? t('lab.board.card.fullscreen')} onClose={onExitFullscreen}>
          {node(true)}
        </FullscreenLayer>
      )}
    </div>
  );
}

function FullscreenLayer({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const overlayId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    pushOverlay(overlayId);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !isTopOverlay(overlayId)) return;
      e.preventDefault();
      e.stopPropagation();
      closeRef.current();
    };
    document.addEventListener('keydown', onKey, true);
    ref.current?.querySelector<HTMLElement>('[data-lab-card-exit]')?.focus();
    return () => {
      popOverlay(overlayId);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [overlayId]);
  return createPortal(
    <div ref={ref} className="board-fullscreen wb-labcard-fullscreen" role="dialog" aria-modal="true" aria-label={label} data-wb-labcard-fullscreen="">
      {children}
    </div>,
    document.body,
  );
}
