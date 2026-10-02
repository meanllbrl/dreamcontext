import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useI18n } from '../../../context/I18nContext';
import type { InsightCache, InsightSummary } from '../../../hooks/useLab';
import { frameKey } from '../../../generated/frameOps';
import { blockRenderKey } from '../blocks/htmlBlockBridge';
import { headingText } from '../blocks/TextBlock';
import {
  activeFilterFor, filterTarget, frameColorDomain, selectionIgnored, setActiveFilter, shapeBlockFrame,
} from '../blocks/frameShape';
import type { CardSyncState, FreshReason } from './boardSync';
import {
  EMPTY_VIEW, pathKey, setAppPage, setFilters, setLanes, setSelection, setTab, type CardView,
} from './cardViewState';
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
 * VIEW STATE (filters, the breakdown selection and lanes per insight, the open
 * tab, the open app page) is the card's `view`, held by the page per card id so
 * the grid card and its fullscreen twin are one view (`cardViewState.ts`).
 * Without `view` / `onView` (a test, a detail surface) the card keeps it itself.
 * A block's insight is its binding's slug (before any `/`), else the card's.
 * The selection narrows every same-insight TABLE frame by the dims it carries;
 * a table not split by a selected dim is left whole and says so.
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

/** The insight a block reads: its binding's slug (before any `/`), else the card's primary insight. */
export function blockInsight(block: Block, card: Pick<Card, 'insight'>): string | null {
  const binding = typeof block.data === 'string' ? block.data.split('/')[0].trim() : '';
  return binding || card.insight || null;
}

/** A tabs child's full block path: the tabs block's own path + TabsBlock's relative `[tab, child]`. */
export function tabChildPath(tabsPath: readonly number[], rel: readonly number[]): number[] {
  return [...tabsPath, ...rel];
}

/**
 * How much header a card can afford, by its grid height in rows. A 2-row card (a sparkline strip)
 * keeps only its title; a 3-4 row card sets the freshness beside the title instead of under it.
 */
export type CardDensity = 'short' | 'compact' | 'full';

export function cardDensity(rows: number | undefined): CardDensity {
  if (typeof rows !== 'number' || !Number.isFinite(rows)) return 'full';
  if (rows <= 2) return 'short';
  return rows <= 4 ? 'compact' : 'full';
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
  /** The card's view state, held by the page (absent = the card keeps its own). */
  view?: CardView;
  /** Apply one update to the card's view. */
  onView?: (update: (view: CardView) => CardView) => void;
  /** Drawn in the fullscreen overlay: full header, an exit button. */
  fullscreen?: boolean;
  /** Leave fullscreen (the exit button). */
  onExitFullscreen?: () => void;
}

export function BoardCard({
  card, frames, summaries, caches, renderBlock, missing = false, onRemove, menu, syncState = null, freshReason = null,
  view: heldView, onView, fullscreen = false, onExitFullscreen,
}: BoardCardProps) {
  const { t, locale } = useI18n();
  const [ownView, setOwnView] = useState<CardView>(EMPTY_VIEW);
  const view = heldView ?? ownView;
  const update = useCallback((fn: (v: CardView) => CardView) => {
    if (onView) onView(fn);
    else setOwnView(fn);
  }, [onView]);
  const primary = card.insight ? summaries[card.insight] : undefined;
  const title = card.title ?? primary?.title ?? card.insight ?? '';
  const fresh = freshnessOf(primary);
  const blocks = useMemo(() => cardBlocks(card), [card]);
  // A section heading card: no title row, no card box, just the heading; the menu floats at the end.
  const heading = !fullscreen && isHeadingCard(blocks, title, !!fresh || !!syncState);

  const draw = useCallback((block: Block, path: number[]): ReactNode => {
    const key = frameKey(card.id, path);
    const raw = frames[key] ?? null;
    const isFilter = block.type === 'filter';
    const slug = block.type === 'insight' ? block.data ?? card.insight : card.insight;
    const insight = blockInsight(block, card);
    const selection = insight ? view.selection[insight] : undefined;
    const lanes = insight ? view.lanes[insight] : undefined;
    // Only a table of THIS insight narrows by the selection (a same-insight table, however bound).
    const narrows = !isFilter && !!selection && !!raw && raw.kind === 'table' && raw.insight === insight;
    const at = pathKey(path);
    const props: BlockProps = {
      frame: shapeBlockFrame(block, raw, view.filters, narrows ? selection : null),
      // Colours are keyed on the RAW frame's entities: a pick or a filter never repaints a survivor.
      colorDomain: frameColorDomain(raw),
      options: block.options,
      summary: slug ? summaries[slug] : undefined,
      cache: block.type === 'insight' && slug ? caches?.[slug] ?? null : undefined,
      filter: isFilter ? activeFilterFor(view.filters, key) : null,
      onFilter: isFilter
        ? (next) => update((v) => setFilters(v, setActiveFilter(v.filters, key, filterTarget(raw), next)))
        : undefined,
      selection: selection ?? {},
      onSelection: insight ? (next) => update((v) => setSelection(v, insight, next)) : undefined,
      lanes: lanes ?? [],
      onLanes: insight ? (next) => update((v) => setLanes(v, insight, next)) : undefined,
      activeTab: block.type === 'tabs' ? view.tabs[at] ?? 0 : undefined,
      onTab: block.type === 'tabs' ? (i) => update((v) => setTab(v, at, i)) : undefined,
      appPage: block.type === 'insight' ? view.appPage[at] ?? null : undefined,
      onAppPage: block.type === 'insight' ? (id) => update((v) => setAppPage(v, at, id)) : undefined,
      fullscreen,
      inputs: block.type === 'html' ? htmlInputs(frames, card.id, path) : undefined,
      // TabsBlock hands a path RELATIVE to itself ([tab, child]); the engine keys frames by the
      // full path (index.tab.child), so the tabs block's own path is prefixed here.
      renderChild: block.type === 'tabs' ? (child, rel) => draw(child, tabChildPath(path, rel)) : undefined,
    };
    const ignored = narrows ? selectionIgnored(raw, selection) : [];
    const drawn = renderBlock(block, props);
    const node = ignored.length > 0 ? (
      <>
        <p className="board-block-note" data-lab-not-split={ignored.join(',')}>
          {t('lab.board.card.notSplit').replace('{dims}', ignored.join(', '))}
        </p>
        {drawn}
      </>
    ) : drawn;
    // A tabs child gets its own hook box (a top-level block's is the card's block row).
    return path.length > 1
      ? <div className="board-block-child" data-lab-block={block.type} data-lab-block-path={path.join('.')}>{node}</div>
      : node;
  }, [card.id, card.insight, frames, view, update, summaries, caches, renderBlock, fullscreen, t]);

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

  // An untitled card with no status line has no header row at all (an empty title row read as a
  // gap above the content): its menu floats over the top corner instead.
  const headed = fullscreen || !!title || !!fresh || !!syncState;
  const density = fullscreen ? 'full' : cardDensity(card.at?.h);
  const exit = fullscreen && onExitFullscreen ? (
    <button
      type="button"
      className="board-card-exit"
      data-lab-card-exit
      aria-label={t('lab.board.card.exitFullscreen')}
      title={t('lab.board.card.exitFullscreen')}
      onClick={onExitFullscreen}
    >
      <span aria-hidden="true">×</span>
    </button>
  ) : null;
  const freshLine = fresh || syncState ? freshnessText(t, locale, primary, fresh, syncState, freshReason) : '';
  const freshTip = [freshLine, !syncState ? primary?.freshnessNote : null, fresh === 'failed' ? primary?.error : null]
    .filter(Boolean).join('\n');
  // Full: the line under the title. Compact: beside the title, ellipsized. Short: folded into the
  // title's tooltip, the element kept (visually hidden) for screen readers and the verify hooks.
  const freshEl = (fresh || syncState) && (
    <p
      className={`board-card-fresh board-card-fresh--${syncState ?? fresh}${density === 'full' ? '' : ` board-card-fresh--${density}`}`}
      data-lab-freshness
      data-lab-sync-queued={syncState === 'queued' ? true : undefined}
      title={density === 'full' ? (fresh === 'failed' ? primary?.error ?? undefined : undefined) : freshTip || undefined}
    >
      {freshLine}
      {primary?.freshnessNote && !syncState && (
        <span className="board-card-note">{primary.freshnessNote}</span>
      )}
    </p>
  );
  const titleTip = density === 'short' && freshTip ? `${title}\n${freshTip}` : title;

  return (
    <article
      className={`board-card${headed ? '' : ' board-card--untitled'}${density === 'full' ? '' : ` board-card--${density}`}${fullscreen ? ' board-card--fullscreen' : ''}`}
      data-card-id={card.id}
      data-lab-card-fullscreen-view={fullscreen ? true : undefined}
    >
      {!headed && menu && <div className="board-card-float-menu">{menu}</div>}
      {headed && (
        <header className="board-card-head">
          <div className="board-card-head-row">
            <h3 className="board-card-title" title={titleTip}>{title}</h3>
            {density !== 'full' && freshEl}
            {menu}
            {exit}
          </div>
          {density === 'full' && freshEl}
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
