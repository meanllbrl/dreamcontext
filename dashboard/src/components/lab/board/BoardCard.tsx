import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useI18n } from '../../../context/I18nContext';
import type { InsightCache, InsightSummary } from '../../../hooks/useLab';
import { frameKey } from '../../../generated/frameOps';
import { blockRenderKey } from '../blocks/htmlBlockBridge';
import {
  activeFilterFor, filterTarget, setActiveFilter, shapeBlockFrame, type ActiveFilter,
} from '../blocks/frameShape';
import type { Block, BlockProps, BlockRenderer, Card, Frame } from './boardTypes';
import './board.css';

/**
 * ONE CARD ON A BOARD: a title, a freshness line, and its blocks.
 *
 * The card never knows what a block looks like. It draws each one through the
 * injected `renderBlock` (the block registry, wired by the page), handing it
 * the block's frame already shaped by the shared `frameOps` (static where/sort/
 * limit/series, then this card's interactive filter). The default renderer is
 * a neutral placeholder so the grid and page can be built and seen without the
 * block library.
 *
 * FILTERS are card-local: a `filter` block publishes `{dim, value}` for the
 * insight + dataset its own frame reads (`frameShape`), and only siblings whose
 * frame reads the SAME dataset see it, however their bindings are spelled. The
 * filter block itself is shaped by its static options only, so its chips never
 * disappear under their own selection. Nothing is fetched: the server sent the
 * frames un-limited, so a filter narrows what is already here.
 *
 * A card with no blocks is one legacy `insight` block of its primary insight
 * (the v1 render). A card whose primary insight is gone says so and offers
 * Remove; it is never silently dropped.
 */

/** A card with no blocks draws its primary insight exactly as v1 did. */
export function cardBlocks(card: Card): Block[] {
  if (card.blocks && card.blocks.length > 0) return card.blocks;
  return card.insight ? [{ type: 'insight', data: card.insight, options: {} }] : [];
}

/** Frames of an html block's declared inputs, by input name. */
export function htmlInputs(frames: Record<string, Frame>, cardId: string, path: readonly number[]): Record<string, Frame> {
  const prefix = `${frameKey(cardId, path)}#`;
  const out: Record<string, Frame> = {};
  for (const [key, frame] of Object.entries(frames)) {
    if (key.startsWith(prefix)) out[key.slice(prefix.length)] = frame;
  }
  return out;
}

/** A tabs child's full block path: the tabs block's own path + TabsBlock's relative `[tab, child]`. */
export function tabChildPath(tabsPath: readonly number[], rel: readonly number[]): number[] {
  return [...tabsPath, ...rel];
}

/** The neutral stand-in until the block registry is wired: the block's type, nothing else. */
export const placeholderRenderBlock: BlockRenderer = (block) => (
  <div className="board-block-placeholder" data-block-type={block.type}>{block.type}</div>
);

type FreshnessKey = 'never' | 'failed' | 'stale' | 'fresh';

function freshnessOf(summary: InsightSummary | undefined): FreshnessKey | null {
  if (!summary) return null;
  if (summary.error) return 'failed';
  if (!summary.fetchedAt) return 'never';
  return summary.stale ? 'stale' : 'fresh';
}

/** "3 hours ago" in the reader's language. */
function ago(iso: string, locale: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const s = Math.round((ms - Date.now()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const abs = Math.abs(s);
  if (abs < 60) return rtf.format(s, 'second');
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  return rtf.format(Math.round(s / 86400), 'day');
}

export interface BoardCardProps {
  card: Card;
  /** Frames for this board, keyed by `frameKey`. */
  frames: Record<string, Frame>;
  /** Summaries of every insight the board shows. */
  summaries: Record<string, InsightSummary>;
  /** Whole caches for legacy `insight` blocks (the bulk caches request). */
  caches?: Record<string, InsightCache | null>;
  /** The block renderer (the registry); a neutral placeholder by default. */
  renderBlock?: BlockRenderer;
  /** The primary insight no longer exists. */
  missing?: boolean;
  /** Remove this card (offered on a missing-insight card). Absent = no Remove. */
  onRemove?: () => void;
}

export function BoardCard({
  card, frames, summaries, caches, renderBlock = placeholderRenderBlock, missing = false, onRemove,
}: BoardCardProps) {
  const { t, locale } = useI18n();
  const [filters, setFilters] = useState<ActiveFilter[]>([]);
  const primary = card.insight ? summaries[card.insight] : undefined;
  const title = card.title ?? primary?.title ?? card.insight ?? '';
  const fresh = freshnessOf(primary);
  const blocks = useMemo(() => cardBlocks(card), [card]);

  const draw = useCallback((block: Block, path: number[]): ReactNode => {
    const key = frameKey(card.id, path);
    const raw = frames[key] ?? null;
    const isFilter = block.type === 'filter';
    const slug = block.type === 'insight' ? block.data ?? card.insight : card.insight;
    const props: BlockProps = {
      frame: shapeBlockFrame(block, raw, filters),
      options: block.options,
      summary: slug ? summaries[slug] : undefined,
      cache: block.type === 'insight' && slug ? caches?.[slug] ?? null : undefined,
      filter: isFilter ? activeFilterFor(filters, key) : null,
      onFilter: isFilter
        ? (next) => setFilters((prev) => setActiveFilter(prev, key, filterTarget(raw), next))
        : undefined,
      inputs: block.type === 'html' ? htmlInputs(frames, card.id, path) : undefined,
      // TabsBlock hands a path RELATIVE to itself ([tab, child]); the engine keys frames by the
      // full path (index.tab.child), so the tabs block's own path is prefixed here.
      renderChild: block.type === 'tabs' ? (child, rel) => draw(child, tabChildPath(path, rel)) : undefined,
    };
    return renderBlock(block, props);
  }, [card.id, card.insight, frames, filters, summaries, caches, renderBlock]);

  if (missing) {
    return (
      <article className="board-card board-card--missing" data-card-id={card.id}>
        <header className="board-card-head">
          <h3 className="board-card-title">{title}</h3>
        </header>
        <div className="board-card-missing">
          <p>{t('lab.board.card.missing').replace('{slug}', card.insight ?? '')}</p>
          {onRemove && (
            <button type="button" className="board-btn" onClick={onRemove}>{t('lab.board.card.remove')}</button>
          )}
        </div>
      </article>
    );
  }

  return (
    <article className="board-card" data-card-id={card.id}>
      {(title || fresh) && (
        <header className="board-card-head">
          {title && <h3 className="board-card-title" title={title}>{title}</h3>}
          {fresh && (
            <p className={`board-card-fresh board-card-fresh--${fresh}`}>
              {fresh === 'fresh' || fresh === 'stale'
                ? t(`lab.board.fresh.${fresh}`).replace('{ago}', ago(primary!.fetchedAt as string, locale))
                : t(`lab.board.fresh.${fresh}`)}
            </p>
          )}
        </header>
      )}
      <div className="board-card-body">
        {/* Keyed by card id + path + (html) content hash: an edited html block remounts (D4). */}
        {blocks.map((block, i) => (
          <div key={blockRenderKey(card.id, [i], block)} className="board-card-block">{draw(block, [i])}</div>
        ))}
      </div>
    </article>
  );
}
