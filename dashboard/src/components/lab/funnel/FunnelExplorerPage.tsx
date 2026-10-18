import { useCallback, useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { useVault } from '../../../context/VaultContext';
import { useBoardCaches, useLabExplorer } from '../../../hooks/useBoards';
import { useSyncInsight, type InsightCache } from '../../../hooks/useLab';
import { renderBlock } from '../blocks/blockRegistry';
import { BoardCard } from '../board/BoardCard';
import { readViewParams, viewParamsMatch, writeViewParams } from '../board/cardViewUrl';
import { EMPTY_VIEW, setFunnel, type CardView } from '../board/cardViewState';
import { Breadcrumb } from './FunnelOverviewPage';
import { replaceLabPath, useLabSearchParams } from './labRoute';
import '../board/board.css';
import '../board/lab-shell.css';
import './FunnelOverviewPage.css';

/**
 * `/lab/<slug>` and `/lab/<slug>/f/<funnelId>` for a `preset: funnel-explorer` insight: the
 * explorer card its board draws, full page. The card is the server's
 * (`GET /api/lab/explorer/:slug`, built from the same `funnelExplorerBlocks` the board derives
 * from, in the insight's own language), so the page and the card cannot drift apart.
 *
 * No range control: the window is the snapshot's, and the card's header names it.
 *
 * The view (funnel, breakdown selection, lanes, open tab) rides `v.<cardId>` exactly as on the
 * board, so a link copied from either opens the other the same way. `/f/<funnelId>` is the pick:
 * read when the page opens (the URL's own view wins), and kept in step with the picker after.
 */
export function FunnelExplorerPage({ slug, funnelId, title, onBack, onToast }: {
  slug: string;
  funnelId: string | null;
  title: string;
  onBack: () => void;
  onToast: (msg: string) => void;
}) {
  const { bus } = useVault();
  const { t } = useI18n();
  const explorer = useLabExplorer(slug, null);
  const sync = useSyncInsight();
  const [search, updateSearch] = useLabSearchParams();
  const card = explorer.data?.board.cards[0] ?? null;
  const cardId = card?.id ?? null;
  // The reader's edits; null until the first one, the URL's view until then.
  const [edited, setEdited] = useState<CardView | null>(null);

  // URL -> view, read once per card: `v.<cardId>` first, the path's funnel when it names none.
  const opened = useMemo<CardView | null>(() => {
    if (!cardId) return null;
    const fromUrl = readViewParams(search, [cardId])[cardId] ?? EMPTY_VIEW;
    return funnelId && !fromUrl.funnel[slug] ? setFunnel(fromUrl, slug, funnelId) : fromUrl;
  }, [cardId]); // eslint-disable-line react-hooks/exhaustive-deps
  const view = edited ?? opened;

  // View -> URL (replace, never a history step): the view param, then the path's funnel.
  const searchKey = search.toString();
  const picked = view?.funnel[slug] ?? null;
  useEffect(() => {
    if (!cardId || !view) return;
    const views = { [cardId]: view };
    if (!viewParamsMatch(new URLSearchParams(searchKey), views, [cardId])) {
      updateSearch((p) => { writeViewParams(p, views, [cardId]); });
    }
  }, [cardId, view, searchKey, updateSearch]);
  useEffect(() => {
    if (!view || picked === funnelId) return;
    replaceLabPath(slug, picked, bus);
  }, [view, picked, funnelId, slug, bus]);

  const onView = useCallback((fn: (v: CardView) => CardView) => {
    setEdited((v) => fn(v ?? opened ?? EMPTY_VIEW));
  }, [opened]);
  const cards = useMemo(() => (card ? [card] : []), [card]);
  const caches = useBoardCaches(cards);
  const cacheMap = useMemo<Record<string, InsightCache | null>>(() => {
    const out: Record<string, InsightCache | null> = {};
    for (const [key, entry] of Object.entries(caches.data ?? {})) out[key] = entry.cache;
    return out;
  }, [caches.data]);

  let body;
  if (explorer.isLoading) {
    body = <div className="funnel-ovw-state">{t('lab.explorerPage.loading')}</div>;
  } else if (explorer.isError || !explorer.data || !card || !view) {
    const message = (explorer.error as Error | null)?.message;
    body = (
      <div className="funnel-ovw-state" data-lab-explorer-page-empty="">
        {t('lab.explorerPage.noData')}
        {message ? ` (${message})` : ''}
        <button
          className="funnel-ovw-syncbtn"
          onClick={() => sync.mutate(slug, { onError: (e) => onToast(t('lab.explorerPage.syncFailed').replace('{error}', (e as Error).message)) })}
          disabled={sync.isPending}
        >
          {sync.isPending ? t('lab.explorerPage.syncing') : t('lab.explorerPage.sync')}
        </button>
      </div>
    );
  } else {
    body = (
      <BoardCard
        card={card}
        frames={explorer.data.frames}
        summaries={explorer.data.summaries}
        caches={cacheMap}
        renderBlock={renderBlock}
        view={view}
        onView={onView}
        fullscreen
      />
    );
  }

  return (
    <div className="lab-explorer-page" data-lab-explorer-page={slug}>
      <Breadcrumb onBack={onBack} title={title} />
      {body}
    </div>
  );
}
