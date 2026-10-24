/**
 * Pictures opened together are ONE group on the stage (owner 2026-10-22: "image'ler neden
 * dağınık? bunlar gruplanmalı"). `super open image` without `--group`/`--no-group` decides here:
 *
 * - 2+ refs in one call: a NEW group of them (a set named in one call is its own set, even right
 *   after another picture).
 * - One picture per call, one call after another: a picture opened within IMAGE_CHAIN_MS of the
 *   super's previous image open joins the group that one went into (or, when that one stood alone,
 *   forms a new group with it).
 *   The chain holds only for pictures of the same job (`--for`, or none on both), and only while
 *   the owner left it as it was: the previous card still floats and is
 *   not shown side by side or presented, and the group it went into still holds it and floats.
 *   An owner who ungrouped, stacked or closed it broke the chain.
 * - A single image with no chain stays a single card.
 *
 * The name: the folder the pictures share (`mockups` for `tmp/mockups/a.png`), else "Images";
 * a name another group already has gets a number ("Images 2"). Pure: the route keeps the chain.
 */
import type { SuperContainer, SuperGroup, SuperState, SuperView } from './types.js';
import { MIN_GROUP_CARDS, cleanGroupName } from './types.js';
import { jobMovedOn } from './tidy.js';

/** What the plan reads of the record (the children: whose job moved on). */
type Stage = { containers: readonly SuperContainer[]; groups: readonly SuperGroup[]; view: SuperView; children?: SuperState['children'] };

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

/** `join`: put `cards` in that existing group. `make`: a new group of `cards`. null: stand alone. */
export type ImageGroupPlan =
  | { join: string; cards: string[] }
  | { make: { cards: string[]; name: string } }
  | null;

/**
 * Where `super open image` puts `ids` (refs `refs`) when the agent named no group. `prev` is the
 * chain the route kept; `now` the clock. null: the card(s) stand alone.
 *
 * A picture already in a group stays where it is: re-opening never breaks up a group the owner
 * (or an earlier open) made, unless that group holds another job's pictures or turned-down ones
 * (the route takes it out first: `picturesToPull`). Only the pictures in no group are placed:
 * with the group the other named pictures share (while it holds this job's pictures only, none
 * turned down: `joinable`), else as a new group of them (2+, of one job), else by the chain (one).
 */
export function planImageGroup(
  s: Stage,
  ids: readonly string[], refs: readonly string[], prev: ImageChain | undefined, now: number, forChild?: string,
): ImageGroupPlan {
  const groupOf = (id: string) => s.groups.find((g) => g.cards.includes(id));
  const free = ids.filter((id) => !groupOf(id));
  const freeRefs = refs.filter((_, i) => free.includes(ids[i]));
  if (!free.length) return null;
  if (ids.length >= 2) {
    const homes = new Set(ids.filter((id) => !free.includes(id)).map((id) => groupOf(id)!.id));
    const home = homes.size === 1 ? s.groups.find((g) => g.id === [...homes][0]) : undefined;
    if (home && joinable(s, home, ids, forChild)) return { join: home.id, cards: free };
    // A home of another job: the new pictures are a set of their own (pictures of one job only).
    const oneJob = free.every((id) => linkAfter(s, ids, forChild, id) === linkAfter(s, ids, forChild, free[0]));
    if ((homes.size === 0 || home) && free.length >= 2 && oneJob) return { make: { cards: free, name: freshGroupName(standing(s), imageGroupBase(freeRefs)) } };
    return null;
  }
  // The job the picture will be linked to: the one named now, else the one a re-opened card has.
  const link = forChild ?? s.containers.find((k) => k.id === ids[0])?.forChild;
  const chained = prev && now - prev.at >= 0 && now - prev.at <= IMAGE_CHAIN_MS ? chainTarget(s, prev, ids, link) : null;
  if (!chained) return null;
  if ('join' in chained) return { join: chained.join, cards: free };
  if (free.includes(chained.card)) return null;
  const card = s.containers.find((k) => k.id === chained.card);
  return { make: { cards: [chained.card, ...free], name: freshGroupName(standing(s), imageGroupBase([card?.ref ?? '', ...freeRefs].filter(Boolean))) } };
}

/** A picture shown for a job that has moved on since. */
const movedOn = (s: Stage, k: SuperContainer | undefined) => k?.kind === 'image' && jobMovedOn(k, s.children ?? {}) !== undefined;

const cardOf = (s: Stage, id: string) => s.containers.find((k) => k.id === id);

/** The groups that stay groups (a pull can leave one with a single card: it dissolves). */
const standing = (s: Stage) => s.groups.filter((g) => g.cards.length >= MIN_GROUP_CARDS);

/** The job a picture is shown for once this open is done ('' none): one named now (`ids`) takes
 *  the job named now, else keeps its own. */
const linkAfter = (s: Stage, ids: readonly string[], forChild: string | undefined, id: string) =>
  (ids.includes(id) ? forChild ?? cardOf(s, id)?.forChild : cardOf(s, id)?.forChild) ?? '';

/**
 * The named pictures that leave their group before they are placed (owner 2026-10-23: a picture
 * shown again for a job goes with that job's new set): those whose group holds a picture of
 * another job, or of the same job from before it moved on. A group of unlinked pictures (the
 * owner's, or opened for no job) is never touched, nor one the owner placed, nor a picture shown
 * for no job.
 */
export function picturesToPull(s: Stage, ids: readonly string[], forChild: string | undefined): string[] {
  return ids.filter((id) => {
    const g = s.groups.find((x) => x.cards.includes(id));
    const job = linkAfter(s, ids, forChild, id);
    if (!g || !job || g.pos) return false;
    return g.cards.some((o) => {
      const k = ids.includes(o) ? undefined : cardOf(s, o);
      return !!k?.forChild && (k.forChild !== job || movedOn(s, k));
    });
  });
}

/**
 * Whether the pictures named now (`ids`) may go into `g`: after this open every picture in it is
 * of one job (the same link, or none on all; a named one takes the job named now, else keeps its
 * own) and none is from before that job moved on (a named one is shown again).
 */
function joinable(s: Stage, g: SuperGroup, ids: readonly string[], forChild: string | undefined): boolean {
  const job = linkAfter(s, ids, forChild, ids[0]);
  return [...g.cards, ...ids].every((id) => linkAfter(s, ids, forChild, id) === job)
    && !g.cards.some((id) => !ids.includes(id) && movedOn(s, cardOf(s, id)));
}

/** The previous image's group to join, or its lone card to group with; null: the chain broke. */
function chainTarget(s: Stage, prev: ImageChain, ids: readonly string[], forChild: string | undefined): { join: string } | { card: string } | null {
  const card = s.containers.find((k) => k.id === prev.card);
  if (!card || card.kind !== 'image') return null;
  // Another job's picture (or one linked where this is not), or the same child's from before
  // its job moved on (a design it was sent to replace): never one group, they leave apart.
  if ((card.forChild ?? '') !== (forChild ?? '') || movedOn(s, card)) return null;
  if (prev.group) {
    const g = s.groups.find((x) => x.id === prev.group);
    if (!g || g.place !== 'float' || !g.cards.includes(prev.card)) return null;
    return joinable(s, g, ids, forChild) ? { join: g.id } : null;
  }
  const shown = s.view.mode === 'half' ? [s.view.card] : s.view.mode === 'present' ? s.view.cards ?? [] : [];
  if (card.place !== 'float' || shown.includes(card.id) || s.groups.some((g) => g.cards.includes(card.id))) return null;
  return { card: card.id };
}
