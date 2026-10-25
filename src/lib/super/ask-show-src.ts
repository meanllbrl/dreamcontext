/**
 * Which cards a picture question shows (task a-picture-question…, D1, D6): its option previews'
 * `<img src>` checked against the project, and the pictures opened for it inside the locked
 * write. Kept out of the route so both `super ask` and `super queue ask` share it and the tests
 * reach it without a server.
 */
import { promises as fsp } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  MAX_FILMSTRIP, MAX_FLOAT, applyGroupOp, defaultShape, floatCount, leaveGroups,
  type PreviewImage, type SuperState,
} from './types.js';
import { planImageGroup, picturesToPull, type ImageChain } from './image-group.js';
import { makeRoom, roomPossible } from './room.js';
import { containerIdFor } from './inbox.js';

/** An image card's ref: project-relative, no `..` or empty steps, a picture's extension
 *  (the `open image` rule, routes/super.ts `refFor`). */
export const IMAGE_REF_RE = /\.(png|jpe?g|gif|webp|svg)$/i;
export function isImageRef(ref: string): boolean {
  return ref.length <= 1024 && !ref.startsWith('/') && !ref.includes('\\')
    && !ref.split('/').some((s) => s === '..' || s === '' || s === '.') && IMAGE_REF_RE.test(ref);
}

/** The file-system calls the check makes (a seam for the tests). */
export interface SrcFs {
  realpath(p: string): Promise<string>;
  isFile(p: string): Promise<boolean>;
}
export const NODE_SRC_FS: SrcFs = {
  realpath: (p) => fsp.realpath(p),
  isFile: async (p) => (await fsp.stat(p)).isFile(),
};

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
/** HTML entities in an attribute value (named, decimal, hex). */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/**
 * The previews' pictures that are project files (D1.2): a src is decoded, refused when it names a
 * scheme (`data:`, `file:`, `http(s):`, any other) or starts `//`, resolved against `base` (the
 * project root, or a child's worktree), and kept only when its real path is a regular file inside
 * the project's real path and its project-relative path is an image ref. The rest is `skipped`.
 */
export async function resolvePreviewImages(
  projectRoot: string, base: string, images: readonly PreviewImage[], fs: SrcFs = NODE_SRC_FS,
): Promise<{ found: { ref: string; label: string }[]; skipped: string[] }> {
  const found: { ref: string; label: string }[] = [];
  const skipped: string[] = [];
  let realRoot: string;
  try { realRoot = await fs.realpath(projectRoot); } catch { return { found, skipped: images.map((i) => i.src) }; }
  for (const img of images.slice(0, MAX_FILMSTRIP)) {
    let src = decodeEntities(img.src).trim();
    if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//') || src.includes('\\') || /[\u0000-\u001f]/.test(src)) { skipped.push(img.src); continue; }
    while (src.startsWith('./')) src = src.slice(2);
    try {
      const real = await fs.realpath(isAbsolute(src) ? src : resolve(base, src));
      if (!real.startsWith(realRoot + sep) || !(await fs.isFile(real))) { skipped.push(img.src); continue; }
      const ref = relative(realRoot, real).split(sep).join('/');
      if (!isImageRef(ref)) { skipped.push(img.src); continue; }
      if (!found.some((f) => f.ref === ref)) found.push({ ref, label: img.label });
    } catch {
      skipped.push(img.src);
    }
  }
  return { found, skipped };
}

export interface OpenedImages {
  /** The cards shown, in order (refs past `cut` dropped). */
  ids: string[];
  /** Cards this call created or brought back from Others. */
  made: string[];
  /** Refs dropped from the end for lack of room. */
  cut: number;
  groupId: string | null;
  /** The picture chain after this open (the route keeps it, in memory). */
  chain: ImageChain | null;
}

/**
 * Open these pictures as cards on the draft (D6), inside the locked write: a card already on the
 * record is reused (brought back from Others), a new one is made; `forChild` links them to that
 * child's job; 2+ pictures (or one within the picture chain) form one group (image-group.ts).
 * Refs that do not fit (the record's room, MAX_FLOAT) are dropped from the END (`cut`); `super
 * open` keeps its all-or-nothing rule by refusing any cut itself. Mutates `s`.
 */
export function openImageCards(
  s: SuperState, refs: readonly { ref: string; title?: string; aspect?: number }[],
  opts: { forChild?: string; now: number; chain?: ImageChain },
): OpenedImages {
  const forChild = opts.forChild && s.children[opts.forChild] ? opts.forChild : undefined;
  const all = refs.slice(0, MAX_FILMSTRIP);
  const idsOf = (k: number) => all.slice(0, k).map((r) => containerIdFor('image', r.ref));
  const pull = (d: SuperState, ids: readonly string[]) => { const out = picturesToPull(d, ids, forChild); if (out.length) leaveGroups(d, out); return d; };
  const fits = (k: number): boolean => {
    const ids = idsOf(k);
    const d = pull(structuredClone(s), ids);
    const fresh = ids.filter((id) => !d.containers.some((c) => c.id === id)).length;
    const a = planImageGroup(d, ids, all.slice(0, k).map((r) => r.ref), opts.chain, opts.now, forChild);
    // The `open` route's count (routes/super.ts `plan`): new cards, or a group net of the loose
    // pictures it takes in.
    let addFloat = fresh;
    if (a) {
      const grouped = new Set(s.groups.flatMap((g) => g.cards));
      const loose = ('join' in a ? a.cards : a.make.cards).filter((id) => !grouped.has(id) && s.containers.some((c) => c.id === id && c.place === 'float')).length;
      const target = 'join' in a ? d.groups.find((g) => g.id === a.join) : undefined;
      addFloat = ('join' in a && target?.place === 'float' ? 0 : 1) - loose;
    }
    return roomPossible(d, fresh, ids) && (addFloat <= 0 || floatCount(s) + addFloat <= MAX_FLOAT);
  };
  let k = all.length;
  while (k > 0 && !fits(k)) k -= 1;
  const ids = idsOf(k);
  if (!k) return { ids: [], made: [], cut: all.length, groupId: null, chain: null };
  pull(s, ids);
  const fresh = ids.filter((id) => !s.containers.some((c) => c.id === id)).length;
  makeRoom(s, fresh, ids);
  const plan = planImageGroup(s, ids, all.slice(0, k).map((r) => r.ref), opts.chain, opts.now, forChild);
  const made: string[] = [];
  all.slice(0, k).forEach((r, i) => {
    const id = ids[i];
    const have = s.containers.find((c) => c.id === id);
    if (have) {
      const inOthers = have.place === 'others' || s.groups.some((g) => g.cards.includes(id) && g.place === 'others');
      if (inOthers) made.push(id);
      have.place = 'float';
      if (r.title) have.title = r.title;
      if (forChild) { have.forChild = forChild; have.forAt = opts.now; } else if (have.forChild) have.forAt = opts.now;
      if (r.aspect !== undefined) have.aspect = r.aspect; else delete have.aspect;
      return;
    }
    s.containers.push({
      id, kind: 'image', ref: r.ref, shape: defaultShape('image'), place: 'float',
      ...(r.title ? { title: r.title } : {}),
      ...(forChild ? { forChild, forAt: opts.now } : {}),
      ...(r.aspect !== undefined ? { aspect: r.aspect } : {}),
    });
    made.push(id);
  });
  let groupId: string | null = null;
  if (plan) {
    groupId = 'join' in plan ? plan.join : `grp-${opts.now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    applyGroupOp(s, { id: groupId, cards: 'join' in plan ? plan.cards : plan.make.cards, name: 'join' in plan ? '' : plan.make.name });
    const g = s.groups.find((x) => x.id === groupId);
    if (g) g.place = 'float'; else groupId = null;
  }
  const chain: ImageChain = { at: opts.now, card: ids[0], group: s.groups.find((g) => g.cards.includes(ids[0]))?.id ?? null };
  return { ids, made, cut: all.length - k, groupId, chain };
}
