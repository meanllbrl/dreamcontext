import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useI18n } from '../../../context/I18nContext';
import type { InsightCache, InsightSummary } from '../../../hooks/useLab';
import { frameKey } from '../../../generated/frameOps';
import { blockRenderKey } from '../blocks/htmlBlockBridge';
import { headingText } from '../blocks/TextBlock';
import {
  activeFilterFor, filterTarget, setActiveFilter, shapeBlockFrame, type ActiveFilter,
} from '../blocks/frameShape';
import type { CardSyncState, FreshReason } from './boardSync';
import type { Block, BlockProps, BlockRenderer, Card, Frame } from './boardTypes';
import './board.css';

/**
 * ONE CARD ON A BOARD: a title, a freshness line, and its blocks.
 *
 * The card never knows what a block looks like. It draws each one through the
 * injected `renderBlock` (the block registry, handed in by the page), giving it
 * the block's frame already shaped by the shared `frameOps` (static where/sort/
 * limit/series, then this card's interactive filter).
 *
 * The freshness line says how old the data is and, when the last check did not
 * fetch, why: still inside its refresh window (`ttl`) or the upstream said
 * nothing changed. The source's own `freshnessNote` follows as plain text.
 * While a job covers the card it says "Syncing" or "Queued" instead.
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

/**
 * A section heading card: untitled, no freshness line, and ONE text block whose markdown is a
 * one-line heading (what TextBlock draws as a heading; a derived `h-*` group heading is one).
 * Keyed on the content, not the `h-` id, so a heading authored by hand gets the same chrome,
 * and any other untitled text card (a multi-paragraph note) keeps the card box and its
 * scrolling body.
 */
export function isHeadingCard(blocks: readonly Block[], title: string, hasStatusLine: boolean): boolean {
  if (title || hasStatusLine || blocks.length !== 1 || blocks[0].type !== 'text') return false;
  const md = blocks[0].options.markdown;
  return typeof md === 'string' && headingText(md) !== null;
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

export type FreshnessKey = 'never' | 'failed' | 'stale' | 'fresh';

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

/** The freshness line's words: live job state first, then age (+ the skip reason when known). */
export function freshnessText(
  t: (key: string) => string,
  locale: string,
  summary: InsightSummary | undefined,
  fresh: FreshnessKey | null,
  syncState: CardSyncState,
  reason: FreshReason | null,
): string {
  if (syncState) return t(`lab.board.fresh.${syncState}`);
  if (!summary || !fresh) return '';
  if (fresh === 'never' || fresh === 'failed') return t(`lab.board.fresh.${fresh}`);
  const updated = ago(summary.fetchedAt as string, locale);
  if (fresh === 'fresh' && reason === 'upstream-unchanged') {
    return t('lab.board.fresh.upstream')
      .replace('{ago}', updated)
      .replace('{checked}', summary.checkedAt ? ago(summary.checkedAt, locale) : updated);
  }
  if (fresh === 'fresh' && reason === 'ttl') return t('lab.board.fresh.ttl').replace('{ago}', updated);
  return t(`lab.board.fresh.${fresh}`).replace('{ago}', updated);
}

export interface BoardCardProps {
  card: Card;
  /** Frames for this board, keyed by `frameKey`. */
  frames: Record<string, Frame>;
  /** Summaries of every insight the board shows. */
  summaries: Record<string, InsightSummary>;
  /** Whole caches for legacy `insight` blocks (the bulk caches request). */
  caches?: Record<string, InsightCache | null>;
  /** The block renderer (the block registry). */
  renderBlock: BlockRenderer;
  /** The primary insight no longer exists. */
  missing?: boolean;
  /** Remove this card (offered on a missing-insight card). Absent = no Remove. */
  onRemove?: () => void;
  /** The card's ⋯ menu (the page builds it: it owns the board edits). */
  menu?: ReactNode;
  /** A running or queued sync job covers this card's insight. */
  syncState?: CardSyncState;
  /** Why the data is current without a fetch, when known. */
  freshReason?: FreshReason | null;
}

export function BoardCard({
  card, frames, summaries, caches, renderBlock, missing = false, onRemove, menu, syncState = null, freshReason = null,
}: BoardCardProps) {
  const { t, locale } = useI18n();
  const [filters, setFilters] = useState<ActiveFilter[]>([]);
  const primary = card.insight ? summaries[card.insight] : undefined;
  const title = card.title ?? primary?.title ?? card.insight ?? '';
  const fresh = freshnessOf(primary);
  const blocks = useMemo(() => cardBlocks(card), [card]);
  // A section heading card: no title row, no card box, just the heading; the menu floats at the end.
  const heading = isHeadingCard(blocks, title, !!fresh || !!syncState);

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
    const node = renderBlock(block, props);
    // A tabs child gets its own hook box (a top-level block's is the card's block row).
    return path.length > 1
      ? <div className="board-block-child" data-lab-block={block.type} data-lab-block-path={path.join('.')}>{node}</div>
      : node;
  }, [card.id, card.insight, frames, filters, summaries, caches, renderBlock]);

  if (missing) {
    return (
      <article className="board-card board-card--missing" data-card-id={card.id} data-lab-card-missing>
        <header className="board-card-head">
          <div className="board-card-head-row">
            <h3 className="board-card-title">{title}</h3>
          </div>
        </header>
        <div className="board-card-missing">
          <p>{t('lab.board.card.missing').replace('{slug}', card.insight ?? '')}</p>
          {onRemove && (
            <button type="button" className="board-btn" data-lab-card-remove onClick={onRemove}>{t('lab.board.card.remove')}</button>
          )}
        </div>
      </article>
    );
  }

  if (heading) {
    return (
      <article className="board-card board-card--heading" data-card-id={card.id} data-lab-card-heading>
        <div
          key={blockRenderKey(card.id, [0], blocks[0])}
          className="board-card-block"
          data-lab-block="text"
          data-lab-block-path="0"
        >
          {draw(blocks[0], [0])}
        </div>
        {menu && <div className="board-card-heading-menu">{menu}</div>}
      </article>
    );
  }

  return (
    <article className="board-card" data-card-id={card.id}>
      {(title || fresh || menu) && (
        <header className="board-card-head">
          <div className="board-card-head-row">
            <h3 className="board-card-title" title={title}>{title}</h3>
            {menu}
          </div>
          {(fresh || syncState) && (
            <p
              className={`board-card-fresh board-card-fresh--${syncState ?? fresh}`}
              data-lab-freshness
              data-lab-sync-queued={syncState === 'queued' ? true : undefined}
              title={fresh === 'failed' ? primary?.error ?? undefined : undefined}
            >
              {freshnessText(t, locale, primary, fresh, syncState, freshReason)}
              {primary?.freshnessNote && !syncState && (
                <span className="board-card-note">{primary.freshnessNote}</span>
              )}
            </p>
          )}
        </header>
      )}
      <div className="board-card-body">
        {/* Keyed by card id + path + (html) content hash: an edited html block remounts (D4). */}
        {blocks.map((block, i) => (
          <div
            key={blockRenderKey(card.id, [i], block)}
            className="board-card-block"
            data-lab-block={block.type}
            data-lab-block-path={String(i)}
          >
            {draw(block, [i])}
          </div>
        ))}
      </div>
    </article>
  );
}
