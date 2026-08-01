/**
 * Unit tests for spaceLayout.ts — the pure maths behind the Space launcher.
 *
 * The two claims the UI rests on, and that a regression here would silently
 * break: RADIUS means recency (recent = inner ring, never-opened = outermost),
 * and ANGLE means kinship (federated projects share a contiguous arc). Plus the
 * invariant that makes it usable at scale: no two chips on the same ring may sit
 * closer than the ring's minimum gap, however many projects there are.
 */
import { describe, it, expect } from 'vitest';
import {
  layoutSpace,
  relaxAngles,
  ringCapacity,
  ringMinGap,
  ringRadius,
  type SpaceBody,
} from '../../dashboard/src/pages/space/spaceLayout.js';
import type { VaultStatus, FederationEdge } from '../../dashboard/src/hooks/useLauncher.js';

function vault(name: string, lastOpenedAt: string | null = null): VaultStatus {
  return {
    name,
    path: `/projects/${name}`,
    exists: true,
    setupVersion: '1.0.0',
    latestVersion: '1.0.0',
    needsUpdate: false,
    shareable: false,
    lastOpenedAt,
  };
}

function edge(source: string, target: string, active = true): FederationEdge {
  return { source, target, active };
}

function byName(bodies: SpaceBody[]): Map<string, SpaceBody> {
  return new Map(bodies.map((b) => [b.vault.name, b]));
}

/** Smallest circular distance between two angles, in degrees. */
function angularGap(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return Math.min(d, 360 - d);
}

/** Is `x` inside the SHORT arc between `a` and `b`? (The arc a cloud would span.) */
function insideArc(x: number, a: number, b: number): boolean {
  return angularGap(a, x) < angularGap(a, b) && angularGap(b, x) < angularGap(a, b);
}

// ─── relaxAngles ────────────────────────────────────────────────────────────────

describe('relaxAngles', () => {
  it('leaves already-spaced angles alone', () => {
    const targets = [0, 2, 4];
    expect(relaxAngles(targets, 1)).toEqual(targets);
  });

  it('pushes crowded angles apart to at least the minimum gap', () => {
    const out = relaxAngles([0, 0.05, 0.1], 0.6);
    const sorted = [...out].sort((a, b) => a - b);
    expect(sorted[1] - sorted[0]).toBeGreaterThanOrEqual(0.6 - 1e-6);
    expect(sorted[2] - sorted[1]).toBeGreaterThanOrEqual(0.6 - 1e-6);
  });

  it('falls back to even spacing when the ring cannot honour the gap', () => {
    // 8 items × 1.2rad = 9.6rad > 2π: impossible, so spread evenly instead of piling up.
    const out = relaxAngles([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7], 1.2);
    const sorted = [...out].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i] - sorted[i - 1]).toBeCloseTo((Math.PI * 2) / 8, 6);
    }
  });

  it('preserves each input its own output slot', () => {
    const out = relaxAngles([3, 1, 2], 0.5);
    expect(out).toHaveLength(3);
    // Ordering by value must still match ordering of the inputs.
    expect(out[1]).toBeLessThan(out[2]);
    expect(out[2]).toBeLessThan(out[0]);
  });

  it('handles the degenerate sizes', () => {
    expect(relaxAngles([], 1)).toEqual([]);
    expect(relaxAngles([1.5], 1)).toEqual([1.5]);
  });
});

// ─── Radius means recency ───────────────────────────────────────────────────────

describe('layoutSpace — radius is recency', () => {
  it('puts the most recently opened project on the innermost ring', () => {
    const vaults = [
      vault('cold', '2020-01-01T00:00:00.000Z'),
      vault('warm', '2026-07-31T00:00:00.000Z'),
      vault('hot', '2026-08-01T12:00:00.000Z'),
    ];
    const { bodies } = layoutSpace(vaults, []);
    const map = byName(bodies);
    expect(map.get('hot')!.recencyRank).toBe(0);
    expect(map.get('warm')!.recencyRank).toBe(1);
    expect(map.get('cold')!.recencyRank).toBe(2);
    // Only three projects: all fit ring 0, which is the point — recency orders
    // them, it does not scatter them across rings prematurely.
    expect(bodies.every((b) => b.ring === 0)).toBe(true);
  });

  it('treats a never-opened project as the coldest thing in the sky', () => {
    const vaults = [vault('never', null), vault('ancient', '2001-01-01T00:00:00.000Z')];
    const map = byName(layoutSpace(vaults, []).bodies);
    expect(map.get('ancient')!.recencyRank).toBeLessThan(map.get('never')!.recencyRank);
  });

  it('treats an unparseable timestamp as never-opened rather than as "now"', () => {
    const vaults = [vault('broken', 'not-a-date'), vault('real', '2001-01-01T00:00:00.000Z')];
    const map = byName(layoutSpace(vaults, []).bodies);
    expect(map.get('real')!.recencyRank).toBe(0);
    expect(map.get('broken')!.recencyRank).toBe(1);
  });

  it('fills each ring to capacity before starting the next, and pushes outward', () => {
    // 20 projects, newest first by name order (p00 newest).
    const vaults = Array.from({ length: 20 }, (_, i) =>
      vault(`p${String(i).padStart(2, '0')}`, new Date(Date.UTC(2026, 0, 1, 0, 20 - i)).toISOString()),
    );
    const { bodies } = layoutSpace(vaults, []);
    const map = byName(bodies);
    for (let i = 0; i < 20; i++) {
      const b = map.get(`p${String(i).padStart(2, '0')}`)!;
      const expectedRing = i < ringCapacity(0) ? 0 : i < ringCapacity(0) + ringCapacity(1) ? 1 : 2;
      expect(b.ring).toBe(expectedRing);
      expect(b.radius).toBe(ringRadius(expectedRing));
    }
  });
});

// ─── Angle means kinship ────────────────────────────────────────────────────────

describe('layoutSpace — angle is kinship', () => {
  it('groups federated projects into one cloud regardless of edge direction', () => {
    const vaults = [vault('a'), vault('b'), vault('c'), vault('lonely')];
    // a → b and c → b: one connected component {a,b,c}, plus a loner.
    const { clouds, bodies } = layoutSpace(vaults, [edge('a', 'b'), edge('c', 'b')]);
    expect(clouds).toHaveLength(1);
    expect(clouds[0].members).toEqual(['a', 'b', 'c']);
    const map = byName(bodies);
    expect(map.get('a')!.cloud).toBe(0);
    expect(map.get('b')!.cloud).toBe(0);
    expect(map.get('c')!.cloud).toBe(0);
    expect(map.get('lonely')!.cloud).toBe(-1);
  });

  it('keeps cloud members angularly adjacent — no outsider wedged between them', () => {
    // Five projects so every one lands on ring 0 (adjacency is a within-ring
    // claim: bodies on different rings are separated by radius, not angle).
    const vaults = ['a', 'b', 'x', 'y', 'z'].map((n) => vault(n));
    const { bodies } = layoutSpace(vaults, [edge('a', 'b')]);
    expect(bodies.every((b) => b.ring === 0)).toBe(true);
    const map = byName(bodies);
    const a = map.get('a')!.angle;
    const b = map.get('b')!.angle;
    for (const outsider of ['x', 'y', 'z']) {
      expect(insideArc(map.get(outsider)!.angle, a, b), `${outsider} split the cloud`).toBe(false);
    }
  });

  it('ignores edges pointing at projects that are no longer registered', () => {
    const vaults = [vault('a'), vault('b')];
    const { clouds } = layoutSpace(vaults, [edge('a', 'ghost'), edge('ghost', 'b')]);
    // A dangling peer must not silently fuse two unrelated projects into a cloud.
    expect(clouds).toHaveLength(0);
  });

  it('orders clouds biggest-first so the largest body of work owns the widest arc', () => {
    const vaults = ['a', 'b', 'c', 'd', 'e'].map((n) => vault(n));
    const { clouds } = layoutSpace(vaults, [edge('a', 'b'), edge('b', 'c'), edge('d', 'e')]);
    expect(clouds.map((c) => c.members.length)).toEqual([3, 2]);
    expect(clouds[0].hue).not.toBe(clouds[1].hue);
  });
});

// ─── Scale ──────────────────────────────────────────────────────────────────────

describe('layoutSpace — survives scale', () => {
  it('never lets two chips on the same ring overlap, at any project count', () => {
    for (const count of [7, 25, 60, 120]) {
      const vaults = Array.from({ length: count }, (_, i) =>
        vault(`p${String(i).padStart(3, '0')}`, new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()),
      );
      const { bodies } = layoutSpace(vaults, []);
      expect(bodies).toHaveLength(count);
      const rings = new Map<number, SpaceBody[]>();
      for (const b of bodies) {
        const list = rings.get(b.ring);
        if (list) list.push(b);
        else rings.set(b.ring, [b]);
      }
      for (const [ring, members] of rings) {
        if (members.length < 2) continue;
        // Every neighbour must clear a chip's own angular width — or, once the
        // ring is too full for that, an even split of the circle. Anything less
        // is two chips drawn on top of each other.
        const wanted = (ringMinGap(ring) * 180) / Math.PI;
        const minAllowed = Math.min(wanted, 360 / members.length) - 1e-6;
        const sorted = [...members].sort((a, b) => a.angle - b.angle);
        for (let i = 1; i < sorted.length; i++) {
          const gap = sorted[i].angle - sorted[i - 1].angle;
          expect(
            gap,
            `ring ${ring} at ${count} projects: ${sorted[i - 1].vault.name}→${sorted[i].vault.name}`,
          ).toBeGreaterThanOrEqual(minAllowed);
        }
        // …including the pair that straddles 0°, which a naive sweep forgets.
        const wrapGap = 360 - (sorted[sorted.length - 1].angle - sorted[0].angle);
        expect(wrapGap, `ring ${ring} wrap at ${count} projects`).toBeGreaterThanOrEqual(
          minAllowed,
        );
      }
    }
  });

  it('is deterministic — API order must not move a single body', () => {
    const vaults = ['zeta', 'alpha', 'mid'].map((n, i) =>
      vault(n, new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()),
    );
    const edges = [edge('alpha', 'mid')];
    const first = layoutSpace(vaults, edges);
    const second = layoutSpace([...vaults].reverse(), [...edges]);
    const a = byName(first.bodies);
    const b = byName(second.bodies);
    for (const name of ['zeta', 'alpha', 'mid']) {
      expect(b.get(name)!.angle).toBeCloseTo(a.get(name)!.angle, 9);
      expect(b.get(name)!.radius).toBe(a.get(name)!.radius);
      expect(b.get(name)!.cloud).toBe(a.get(name)!.cloud);
    }
  });

  it('returns an empty sky for no projects instead of throwing', () => {
    const out = layoutSpace([], []);
    expect(out.bodies).toEqual([]);
    expect(out.clouds).toEqual([]);
    expect(out.extent).toBeGreaterThan(0);
  });
});
