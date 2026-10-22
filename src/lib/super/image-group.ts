/**
 * Pictures opened together are ONE group on the stage (owner 2026-10-22: "image'ler neden
 * dağınık? bunlar gruplanmalı"). `super open image` without `--group`/`--no-group` decides here:
 *
 * - 2+ refs in one call: a NEW group of them (a set named in one call is its own set, even right
 *   after another picture).
 * - One picture per call, one call after another: a picture opened within IMAGE_CHAIN_MS of the
 *   super's previous image open joins the group that one went into (or, when that one stood alone,
 *   forms a new group with it).
 *   The chain holds only while the owner left it as it was: the previous card still floats and is
 *   not shown side by side or presented, and the group it went into still holds it and floats.
 *   An owner who ungrouped, stacked or closed it broke the chain.
 * - A single image with no chain stays a single card.
 *
 * The name: the folder the pictures share (`mockups` for `tmp/mockups/a.png`), else "Images";
 * a name another group already has gets a number ("Images 2"). Pure: the route keeps the chain.
 */
import type { SuperContainer, SuperGroup, SuperView } from './types.js';
import { cleanGroupName } from './types.js';

/** How long after one image open the next one still joins its group. */
export const IMAGE_CHAIN_MS = 2 * 60_000;

/** The super's last image open: the card it named first and the group it went into (null: it stood alone). */
export interface ImageChain { at: number; card: string; group: string | null }

/** Folders that say nothing about the pictures in them. */
const GENERIC_DIRS = new Set(['', '.', 'tmp', 'temp', 'agent-drops', 'images', 'img', 'screenshots', 'assets']);

/** The group's name from the pictures' shared folder, else "Images". */
export function imageGroupBase(refs: readonly string[]): string {
  const dirs = new Set(refs.map((r) => r.replace(/\\/g, '/').split('/').slice(0, -1).join('/')));
  if (dirs.size !== 1) return 'Images';
  const dir = [...dirs][0];
  const base = dir.split('/').pop() ?? '';
  return GENERIC_DIRS.has(base.toLowerCase()) ? 'Images' : (cleanGroupName(base) || 'Images');
}

/** `base`, or `base N` with the smallest N no group is named. */
export function freshGroupName(groups: readonly Pick<SuperGroup, 'name'>[], base: string): string {
  const used = new Set(groups.map((g) => g.name));
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base} ${n}`)) return `${base} ${n}`;
}

export type ImageGroupPlan =
  | { join: string }
  | { make: { cards: string[]; name: string } }
  | null;

/**
 * Where `super open image` puts `ids` (refs `refs`) when the agent named no group. `prev` is the
 * chain the route kept; `now` the clock. null: the card(s) stand alone.
 */
export function planImageGroup(
  s: { containers: readonly SuperContainer[]; groups: readonly SuperGroup[]; view: SuperView },
  ids: readonly string[], refs: readonly string[], prev: ImageChain | undefined, now: number,
): ImageGroupPlan {
  if (ids.length >= 2) return { make: { cards: [...ids], name: freshGroupName(s.groups, imageGroupBase(refs)) } };
  const chained = prev && now - prev.at >= 0 && now - prev.at <= IMAGE_CHAIN_MS ? chainTarget(s, prev) : null;
  if (!chained) return null;
  if ('join' in chained) return chained;
  if (ids.includes(chained.card)) return null;
  const card = s.containers.find((k) => k.id === chained.card);
  return { make: { cards: [chained.card, ...ids], name: freshGroupName(s.groups, imageGroupBase([card?.ref ?? '', ...refs].filter(Boolean))) } };
}

/** The previous image's group to join, or its lone card to group with; null: the chain broke. */
function chainTarget(
  s: { containers: readonly SuperContainer[]; groups: readonly SuperGroup[]; view: SuperView },
  prev: ImageChain,
): { join: string } | { card: string } | null {
  const card = s.containers.find((k) => k.id === prev.card);
  if (!card || card.kind !== 'image') return null;
  if (prev.group) {
    const g = s.groups.find((x) => x.id === prev.group);
    return g && g.place === 'float' && g.cards.includes(prev.card) ? { join: g.id } : null;
  }
  const shown = s.view.mode === 'half' ? [s.view.card] : s.view.mode === 'present' ? s.view.cards ?? [] : [];
  if (card.place !== 'float' || shown.includes(card.id) || s.groups.some((g) => g.cards.includes(card.id))) return null;
  return { card: card.id };
}
