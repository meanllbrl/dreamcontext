import { useState } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { cardName, turnTiles, type KnownCard, type TurnCards, type TurnTile } from '../../../lib/turnCards';
import type { SuperContainer as Container } from '../../../lib/superTypes';
import { useIsMobile } from '../../../hooks/useIsMobile';
import { useSuperStage } from './superJobsStore';
import { KindTile, TileSheets } from './SuperTiles';
import { CardFullscreenView } from './CardFullscreenView';
import { fullscreenOf, type CardFullscreen } from './SuperContainer';

/**
 * The cards a Super turn put on the stage, under its answer (owner 2026-11-08: "the presentation
 * gets lost; show it there visually and open it on click"). Each card is the stage's own tile
 * (KindTile, a group on its deck of sheets), its real face: the picture, the page, the PDF's first
 * page. Derived from the turn's own record (turnCards.ts), so it is still here after the card went
 * to Others, after a reload, after a fresh Super session.
 *
 * A click brings the card back to the front of the stage (a card side by side, a group presented
 * whole), from Others too. Where no stage is up (the phone, a surface without the record) it opens
 * the card full screen; a card the stage no longer holds is a quiet "closed" line, never a click.
 */
export function TurnCardTiles({ turn, superSid, onOpenFile }: {
  turn: TurnCards;
  superSid: string | null | undefined;
  onOpenFile?: (path: string) => void;
}) {
  const { t } = useI18n();
  const stage = useSuperStage(superSid);
  const isPhone = useIsMobile();
  const [full, setFull] = useState<{ id: string; subject: CardFullscreen } | null>(null);
  const tiles = turnTiles(turn, stage?.now ?? null);
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
  const clickOf = (tile: TurnTile): (() => void) | null => {
    if (tile.kind === 'closed') return null;
    const first = tile.kind === 'group' ? tile.cards[0] : tile.card;
    if (onStage) return () => stage!.bring(tile.kind === 'group' ? { group: tile.group.id } : { card: tile.card.id });
    return fullOf(first) ? () => openFull(first) : null;
  };

  return (
    <div className="super-turn-cards" role="group" aria-label={t('super.turnCards.label')} data-testid="super-turn-cards">
      {tiles.map((tile) => {
        if (tile.kind === 'closed') {
          return (
            <div key={tile.key} className="super-turn-card super-turn-card--closed" data-testid="super-turn-card-closed" title={tile.title}>
              <span className="super-turn-card-closed-name">{tile.title}</span>
              <span className="super-turn-card-closed-note">{t('super.turnCards.closed')}</span>
            </div>
          );
        }
        const click = clickOf(tile);
        const name = tile.kind === 'group' ? tile.group.name : cardName(tile.card);
        const hint = !click ? undefined : onStage ? t(tile.kind === 'group' ? 'super.turnCards.present' : 'super.turnCards.bring') : t('super.turnCards.full');
        const face = tile.kind === 'group' ? tile.cards[0] : tile.card;
        const body = (
          // The face is a picture of the card: inert, so nothing inside it (a file's own "Allow
          // access") is a second button inside this one; the button's label names the card.
          <div className={`super-panel-tile${tile.kind === 'group' ? ' super-panel-tile--group' : ''}`} aria-hidden inert>
            {tile.kind === 'group' && <TileSheets />}
            <div className="super-panel-clip">
              <KindTile container={asContainer(face)} title={tile.kind === 'group' ? `${name} · ${tile.cards.length}` : name} viewReady preview />
            </div>
          </div>
        );
        return click ? (
          <button
            key={tile.key}
            type="button"
            className={`super-turn-card${tile.kind === 'group' ? ' super-turn-card--group' : ''}`}
            data-testid="super-turn-card"
            data-card={tile.kind === 'group' ? tile.group.id : tile.card.id}
            aria-label={`${name}. ${hint}`}
            onClick={click}
          >
            {body}
          </button>
        ) : (
          <div key={tile.key} className={`super-turn-card${tile.kind === 'group' ? ' super-turn-card--group' : ''}`} data-testid="super-turn-card" data-card={tile.key} title={name}>
            {body}
          </div>
        );
      })}
      {full && <CardFullscreenView subject={full.subject} cardId={full.id} onClose={() => setFull(null)} />}
    </div>
  );
}

/** A card the turn knows, in the shape the stage's tile reads (a tile draws kind, ref and title). */
function asContainer(card: KnownCard): Container {
  return { id: card.id, kind: card.kind as Container['kind'], ref: card.ref, shape: 'square', place: 'float', ...(card.title ? { title: card.title } : {}) } as Container;
}
