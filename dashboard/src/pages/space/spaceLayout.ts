import type { FederationEdge, VaultStatus } from '../../hooks/useLauncher';

/**
 * Layout maths for the Space launcher — pure, deterministic, and free of React
 * so it can be unit-tested and so a re-render never reshuffles the sky.
 *
 * Two independent axes carry meaning:
 *   • RADIUS = recency. The project you opened last sits on the innermost ring;
 *     projects go cold and drift outward. (A project that was never opened is
 *     the coldest thing in the sky, never the warmest — a missing timestamp must
 *     not read as "just now".)
 *   • ANGLE = kinship. Federated projects (any chain of read edges, direction
 *     ignored) share a contiguous arc, so a cloud can be drawn around them and
 *     reads as one body of related work rather than five scattered dots.
 *
 * Angles are assigned from a stable global ordering, then relaxed per ring so no
 * two neighbours on the same ring can overlap. That keeps kin together WITHOUT
 * ever letting chips collide, which a naive "even spacing" or a naive "kin
 * angle" alone cannot do.
 */

/** Distance of the innermost ring from the centre, in space units (≈ px at zoom 1). */
export const RING_BASE_RADIUS = 200;
/** Gap between consecutive rings. */
export const RING_STEP = 138;
/** Per-ring angular offset so rings never line up into radial spokes. */
const RING_PHASE = 0.55;
/** Half-width (plus breathing room) of a chip, per ring band — drives the minimum gap. */
const HALF_CHIP = [104, 96, 80, 68];
/** Cloud tints, cycled by cloud index. Violet leads: it is the federation colour. */
const CLOUD_HUES = [265, 190, 330, 152, 32, 212];

/** How many projects a ring holds before the next ring starts filling. */
export function ringCapacity(ring: number): number {
  return 5 + 5 * ring;
}

/** Distance of a ring from the centre. */
export function ringRadius(ring: number): number {
  return RING_BASE_RADIUS + RING_STEP * ring;
}

function halfChip(ring: number): number {
  return HALF_CHIP[Math.min(ring, HALF_CHIP.length - 1)];
}

/**
 * Smallest angle (radians) two chips on the same ring may be apart without
 * touching. Two bodies separated by θ on a circle of radius r are `2r·sin(θ/2)`
 * apart (the CHORD, not the arc), so clearing a chip of half-width h needs
 * `θ ≥ 2·asin(h/r)`. `atan` would look right and read close at large radii while
 * quietly under-separating the inner rings — at ring 0 it allows 55° where 63° is
 * needed, i.e. a real overlap. Clamped because the innermost ring can be narrower
 * than a chip, in which case only two chips fit and they belong opposite.
 */
export function ringMinGap(ring: number): number {
  return 2 * Math.asin(Math.min(1, halfChip(ring) / ringRadius(ring)));
}

/** One project placed in the sky. */
export interface SpaceBody {
  vault: VaultStatus;
  /** Base angle in DEGREES (live spin is added by CSS, never here). */
  angle: number;
  /** Distance from the centre in space units. */
  radius: number;
  ring: number;
  /** Index into `clouds`, or -1 when this project orbits alone. */
  cloud: number;
  /** 0 = most recently opened. */
  recencyRank: number;
}

/** A group of federated projects, drawn as a gas cloud behind its members. */
export interface SpaceCloud {
  index: number;
  /** Vault names, in the same order they were laid out. */
  members: string[];
  hue: number;
}

export interface SpaceLayout {
  bodies: SpaceBody[];
  clouds: SpaceCloud[];
  /** Radius of the outermost body — the caller sizes the canvas from this. */
  extent: number;
}

const TAU = Math.PI * 2;

/**
 * Nudge angles apart until every circular neighbour is at least `minGap` apart,
 * staying as close to the requested targets as possible. Falls back to perfectly
 * even spacing when the ring is too crowded to honour `minGap` at all — a packed
 * ring should look deliberate, not like a pile-up.
 *
 * Works on a MONOTONE unwrapped copy rather than nudging pairs in place: pushing
 * two coincident angles apart can swap their order, and a wrapped gap check then
 * reads that inversion as a nearly-full-circle gap and stops correcting. The
 * forward/backward sweep below cannot invert, so it always converges — in one
 * pass, since `n * minGap < TAU` guarantees a feasible arrangement exists.
 *
 * Returns radians in the caller's original index order.
 */
export function relaxAngles(targets: number[], minGap: number): number[] {
  const n = targets.length;
  if (n === 0) return [];
  if (n === 1) return [targets[0]];

  const order = targets.map((_, i) => i).sort((i, j) => targets[i] - targets[j]);
  const sorted = order.map((i) => targets[i]);
  const out = new Array<number>(n);

  if (n * minGap >= TAU) {
    // Over capacity: spread evenly from the first target, preserving kin order.
    order.forEach((idx, k) => {
      out[idx] = sorted[0] + (TAU * k) / n;
    });
    return out;
  }

  const base = sorted[0];
  const d = sorted.map((v) => v - base); // d[0] = 0, ascending, spans < TAU

  // Forward: nobody may crowd its predecessor.
  for (let k = 1; k < n; k++) {
    if (d[k] - d[k - 1] < minGap) d[k] = d[k - 1] + minGap;
  }
  // The wrap-around pair (last → first) needs the same clearance. Pull the tail
  // back under the ceiling and propagate backwards; re-anchor afterwards so the
  // ring keeps its orientation. d[0] stays positive here (it is at most
  // TAU - n*minGap below the ceiling), so re-anchoring only ever tightens.
  const ceiling = TAU - minGap;
  if (d[n - 1] > ceiling) {
    d[n - 1] = ceiling;
    for (let k = n - 2; k >= 0; k--) {
      if (d[k + 1] - d[k] < minGap) d[k] = d[k + 1] - minGap;
    }
    const shift = d[0];
    for (let k = 0; k < n; k++) d[k] -= shift;
  }

  order.forEach((idx, k) => {
    out[idx] = base + d[k];
  });
  return out;
}

/** Most-recently-opened first; never-opened last; ties broken by name so the sky is stable. */
function byRecency(a: VaultStatus, b: VaultStatus): number {
  const ta = a.lastOpenedAt ? Date.parse(a.lastOpenedAt) : NaN;
  const tb = b.lastOpenedAt ? Date.parse(b.lastOpenedAt) : NaN;
  const va = Number.isNaN(ta) ? -Infinity : ta;
  const vb = Number.isNaN(tb) ? -Infinity : tb;
  if (va !== vb) return vb - va;
  return a.name.localeCompare(b.name);
}

/** Connected components over the (undirected) read edges. */
function clusterVaults(names: string[], edges: FederationEdge[]): string[][] {
  const parent = new Map<string, string>(names.map((n) => [n, n]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    // Path compression keeps this linear on big meshes.
    let c = x;
    while (parent.get(c) !== r) {
      const next = parent.get(c)!;
      parent.set(c, r);
      c = next;
    }
    return r;
  };
  for (const e of edges) {
    if (!parent.has(e.source) || !parent.has(e.target)) continue;
    const ra = find(e.source);
    const rb = find(e.target);
    if (ra !== rb) parent.set(ra, rb);
  }
  const groups = new Map<string, string[]>();
  for (const n of names) {
    const root = find(n);
    const bucket = groups.get(root);
    if (bucket) bucket.push(n);
    else groups.set(root, [n]);
  }
  return [...groups.values()].map((g) => g.slice().sort((a, b) => a.localeCompare(b)));
}

/**
 * Place every project in the sky. Deterministic: same vaults + same edges in,
 * same coordinates out, regardless of array order from the API.
 */
export function layoutSpace(vaults: VaultStatus[], edges: FederationEdge[]): SpaceLayout {
  if (vaults.length === 0) return { bodies: [], clouds: [], extent: RING_BASE_RADIUS };

  const names = vaults.map((v) => v.name);
  const clusters = clusterVaults(names, edges);

  // Clouds (2+ members) claim their arcs first — biggest first, so the largest
  // body of related work gets the most coherent slice of sky.
  const clouds = clusters
    .filter((c) => c.length > 1)
    .sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
  const loners = clusters.filter((c) => c.length === 1).map((c) => c[0]);

  const angularOrder = new Map<string, number>();
  let cursor = 0;
  const cloudOf = new Map<string, number>();
  clouds.forEach((members, ci) => {
    members.forEach((n) => {
      angularOrder.set(n, cursor++);
      cloudOf.set(n, ci);
    });
  });
  loners.forEach((n) => angularOrder.set(n, cursor++));

  const total = names.length;
  const ranked = [...vaults].sort(byRecency);

  // Rank → ring, filling each ring to capacity before starting the next.
  const ringOf = new Map<string, number>();
  const rankOf = new Map<string, number>();
  let ring = 0;
  let left = ringCapacity(0);
  ranked.forEach((v, rank) => {
    if (left === 0) {
      ring += 1;
      left = ringCapacity(ring);
    }
    ringOf.set(v.name, ring);
    rankOf.set(v.name, rank);
    left -= 1;
  });

  const bodies: SpaceBody[] = [];
  for (let r = 0; r <= ring; r++) {
    const members = ranked.filter((v) => ringOf.get(v.name) === r);
    if (members.length === 0) continue;
    const radius = ringRadius(r);
    const targets = members.map(
      (v) => (TAU * (angularOrder.get(v.name) ?? 0)) / total + RING_PHASE * r,
    );
    const angles = relaxAngles(targets, ringMinGap(r));
    members.forEach((v, i) => {
      bodies.push({
        vault: v,
        angle: (angles[i] * 180) / Math.PI,
        radius,
        ring: r,
        cloud: cloudOf.get(v.name) ?? -1,
        recencyRank: rankOf.get(v.name) ?? 0,
      });
    });
  }

  return {
    bodies,
    clouds: clouds.map((members, index) => ({
      index,
      members,
      hue: CLOUD_HUES[index % CLOUD_HUES.length],
    })),
    extent: bodies.reduce((m, b) => Math.max(m, b.radius), RING_BASE_RADIUS),
  };
}

/** Cartesian position of a body at its base angle (spin excluded). */
export function bodyPoint(b: SpaceBody): { x: number; y: number } {
  const rad = (b.angle * Math.PI) / 180;
  return { x: Math.cos(rad) * b.radius, y: Math.sin(rad) * b.radius };
}
