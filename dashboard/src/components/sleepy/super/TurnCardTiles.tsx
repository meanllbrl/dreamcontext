import { useEffect, useState } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { useVaultId } from '../../../context/VaultContext';
import { agentFileUrl } from '../../../api/client';
import { cardGlyph } from '../../../lib/cardMention';
import { cardName, isProjectFileCard, turnTiles, type KnownCard, type TurnCards, type TurnTile } from '../../../lib/turnCards';
import type { SuperContainer as Container } from '../../../lib/superTypes';
import { useIsMobile } from '../../../hooks/useIsMobile';
import { PictureChip } from '../chat/ComposerRefLayer';
import { GLYPH_IMAGE } from '../chat/composerRefs';
import { useSuperStage } from './superJobsStore';
import { CardFullscreenView } from './CardFullscreenView';
import { fullscreenOf, type CardFullscreen } from './SuperContainer';

/**
 * The cards a Super turn put on the stage, under its answer (owner 2026-11-08: "the presentation
 * gets lost; show it there and open it on click"). Each card (one per group) is the composer's own
 * chip, low, in a row: its picture or its kind's icon, its name, a group's count. Derived from the
 * turn's own record (turnCards.ts), so it stays after the card went to Others, a reload, a fresh
 * Super session, and after the owner closed it.
 *
 * A click brings the card to the front of the stage (a card side by side, a group presented), from
 * Others too; a card he closed is opened again the way he opens one himself. Where no stage is up
 * (the phone) it opens full screen. Only a card whose file is gone from disk is a quiet "closed"
 * line, never a click.
 */
export function TurnCardTiles({ turn, superSid, onOpenFile }: {
  turn: TurnCards;
  superSid: string | null | undefined;
  onOpenFile?: (path: string) => void;
}) {
  const { t } = useI18n();
  const { vault } = useVaultId();
  const stage = useSuperStage(superSid);
  const isPhone = useIsMobile();
  const [full, setFull] = useState<{ id: string; subject: CardFullscreen } | null>(null);
  const tiles = turnTiles(turn, stage?.now ?? null);
  const gone = useGoneFiles(tiles, vault);
  if (!tiles.length) return null;
  const onStage = !!stage && !isPhone;

  /** The full-screen subject of a card on a surface with no stage (a web page off this machine only). */
  const fullOf = (card: KnownCard): CardFullscreen | null => {
    const href = /^https:\/\//i.test(card.ref) ? card.ref : null;
    return fullscreenOf(asContainer(card), cardName(card), href);
  };
  const openFull = (card: KnownCard) => {
    const subject = fullOf(card);
    if (!subject) return;
    // A clip plays in the chat's own viewer: the stage's full screen asks a card's player.
    if (subject.kind === 'video') { onOpenFile?.(subject.path); return; }
    setFull({ id: card.id, subject });
  };
  const cardsOf = (tile: Exclude<TurnTile, { kind: 'card' }> | Extract<TurnTile, { kind: 'card' }>): KnownCard[] =>
    tile.kind === 'card' ? [tile.card] : tile.cards;
  const clickOf = (tile: TurnTile): (() => void) | null => {
    const first = cardsOf(tile)[0];
    if (onStage) {
      if (tile.kind === 'reopen') return () => { void stage!.reopen(tile.cards); };
      return () => stage!.bring(tile.kind === 'group' ? { group: tile.group.id } : { card: tile.card.id });
    }
    return fullOf(first) ? () => openFull(first) : null;
  };
  const thumbOf = (cards: readonly KnownCard[]): string | undefined => {
    const pic = cards.find((c) => c.kind === 'image' && isProjectFileCard(c));
    return pic ? agentFileUrl(vault, pic.ref, { raw: true }) : undefined;
  };

  return (
    <div className="super-turn-cards" role="group" aria-label={t('super.turnCards.label')} data-testid="super-turn-cards">
      {tiles.map((tile) => {
        const cards = cardsOf(tile);
        const first = cards[0];
        const count = tile.kind === 'card' ? 1 : cards.length;
        const name = tile.kind === 'group' ? tile.group.name : cardName(first);
        if (tile.kind === 'reopen' && cards.every((c) => gone.has(c.id))) {
          return (
            <span key={tile.key} className="super-turn-card-closed" data-testid="super-turn-card-closed" title={name}>
              <span className="super-turn-card-closed-name">{name}</span>
              <span className="super-turn-card-closed-note">{t('super.turnCards.closed')}</span>
            </span>
          );
        }
        const click = clickOf(tile);
        const hint = !click ? name
          : !onStage ? t('super.turnCards.full')
          : tile.kind === 'reopen' ? t('super.turnCards.reopen')
          : t(tile.kind === 'group' ? 'super.turnCards.present' : 'super.turnCards.bring');
        const img = thumbOf(cards);
        const kind = count > 1 ? 'group' : first.kind;
        return (
          <span key={tile.key} className="super-turn-chip" data-testid="super-turn-card"
            data-card={tile.kind === 'group' ? tile.group.id : tile.kind === 'card' ? tile.card.id : first.id}
            data-reopen={tile.kind === 'reopen' ? 'true' : undefined}>
            <PictureChip
              sent
              img={img}
              icon={img ? undefined : cardGlyph(kind)}
              lead={GLYPH_IMAGE}
              rest={` ${name}${count > 1 ? ` · ${count}` : ''}`}
              state={click ? 'ready' : 'gone'}
              title={`${name}. ${hint}`}
              onOpen={click ?? undefined}
              testId="super-turn-chip"
            />
          </span>
        );
      })}
      {full && <CardFullscreenView subject={full.subject} cardId={full.id} onClose={() => setFull(null)} />}
    </div>
  );
}

/**
 * Which closed cards' files are gone from disk: asked once per card of a `reopen` tile that stands
 * on a project file, never for a card still on the stage. Only a plain 404 counts as gone; any other
 * answer (offline, refused) keeps the card reopenable.
 */
function useGoneFiles(tiles: readonly TurnTile[], vault: string | null): ReadonlySet<string> {
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  const ask = tiles.flatMap((tile) => (tile.kind === 'reopen' ? tile.cards : [])).filter(isProjectFileCard);
  const key = ask.map((c) => `${c.id}=${c.ref}`).join('\u0001');
  useEffect(() => {
    if (!ask.length) return;
    const ctrl = new AbortController();
    void Promise.all(ask.map(async (c) => {
      try {
        const r = await fetch(agentFileUrl(vault, c.ref, { raw: true }), { signal: ctrl.signal, cache: 'no-store' });
        void r.body?.cancel().catch(() => {});
        return r.status === 404 ? c.id : null;
      } catch { return null; }
    })).then((ids) => {
      if (ctrl.signal.aborted) return;
      setGone(new Set(ids.filter((x): x is string => !!x)));
    });
    return () => ctrl.abort();
    // `key` stands for `ask`: the same cards ask once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, vault]);
  return gone;
}

/** A card the turn knows, in the shape the stage's full-screen view reads (kind, ref, title). */
function asContainer(card: KnownCard): Container {
  return { id: card.id, kind: card.kind as Container['kind'], ref: card.ref, shape: 'square', place: 'float', ...(card.title ? { title: card.title } : {}) } as Container;
}
