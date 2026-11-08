/**
 * A card's own menus belong to the card where it stood when they opened (owner 2026-11-07: the
 * close menu "This chat?" stayed open after the card was minimised, floating over a small tile).
 * The key names what a menu was opened against: where the card is drawn, its size, and whether
 * it is on the stage at all. When the key changes the menu closes. A move alone keeps it: the
 * menu is drawn inside the card, so it follows the card.
 */
export interface CardPlaceLike {
  where: string;
  rect: { width: number; height: number };
  hidden?: boolean;
}

export function cardPlaceKey(plan: CardPlaceLike, parked: boolean | undefined): string {
  if (parked || plan.hidden) return 'off';
  return `${plan.where}:${Math.round(plan.rect.width)}x${Math.round(plan.rect.height)}`;
}
