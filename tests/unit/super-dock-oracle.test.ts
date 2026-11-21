/**
 * The Dock equals the drawing (plan super-v3 K2-oracle, owner decision 2026-11-20): the approved
 * mockups' own drawn Dock (tests/unit/fixtures/super-v3/frames.json, read by
 * scripts/verify/super-v3-oracle.mjs) against `dockTiles` given the frame's drawn tile set at the
 * mockup stage. Per tile: kind order, width and height (±2 px); the Dock's height and bottom inset
 * (±2 px); absolute x only on review frame B-onbes (the one frame drawn with the separator rule).
 * Below what the frames cover, the K2 step order is pinned by rule.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { DOCK, dockDecision, dockTiles, type DockSet } from '../../dashboard/src/components/sleepy/super/superLayout.js';

interface Drawn { kind: string; x: number; y: number; width: number; height: number; text?: string }
interface Frame { stage: { width: number; height: number }; dock: { x: number; y: number; width: number; height: number; inset: number } | null; tiles: Drawn[] }
const FRAMES = JSON.parse(readFileSync(new URL('./fixtures/super-v3/frames.json', import.meta.url), 'utf-8')) as Record<string, Frame>;

/** The frame's drawn set, as the plan would hand it to `dockTiles`. */
function setOf(f: Frame, extra: Partial<DockSet> = {}): DockSet {
  const ids = (kind: string) => f.tiles.filter((t) => t.kind === kind).map((_, i) => `${kind}-${i}`);
  return { today: ids('today')[0] ?? null, needs: ids('needs'), members: ids('member'), jobs: ids('job'), minis: ids('mini'), ...extra };
}
const TIGHT: Record<string, boolean> = {
  '05-sekiz-oturum': false, '05-sekiz-oturum-3': true, '07a-sunum-dar': true, '07b-sunum-orta': true,
  '07c-sunum-genis': true, '09b-kucult-3': true, 'B-onbes': false, 'T6-sonra': false,
};
const near = (a: number, b: number, label: string) => expect(Math.abs(a - b), `${label}: ${a} vs ${b}`).toBeLessThanOrEqual(2);

describe('dockTiles equals the drawn Dock on every oracle frame', () => {
  for (const [name, f] of Object.entries(FRAMES)) {
    it(name, () => {
      const t6 = name === 'T6-sonra';
      const plan = dockTiles(setOf(f, t6 ? { pool: 3, cap: '15 of 15 running' } : {}), f.stage, { tight: TIGHT[name] });
      const drawn = f.tiles.filter((t) => t.kind !== 'sep' && t.kind !== 'foot');
      const ours = plan.tiles.filter((t) => t.kind !== 'pool');
      expect(ours.map((t) => t.kind), 'kind order').toEqual(drawn.map((t) => t.kind));
      drawn.forEach((d, i) => {
        near(ours[i].rect.width, d.width, `${name} tile ${i} width`);
        near(ours[i].rect.height, d.height, `${name} tile ${i} height`);
        if (name === 'B-onbes') near(ours[i].rect.x, d.x, `${name} tile ${i} x`);
      });
      near(plan.rect.height, f.dock!.height, `${name} dock height`);
      near(f.stage.height - (plan.rect.y + plan.rect.height), f.dock!.inset, `${name} dock inset`);
      expect(plan.scrollFrom).toBeNull();
      if (t6) expect(f.tiles.find((t) => t.kind === 'foot')?.text).toBe('15 of 15 running');
    });
  }
});

describe('below the frames, the K2 steps', () => {
  const B = FRAMES['B-onbes'];
  it('1180 window (stage 1096) with frame B\'s set: never wraps, drops nothing, needs-you visible at rest', () => {
    const set = setOf(B);
    const plan = dockTiles(set, { width: 1096, height: 760 }, { tight: false });
    const all = set.needs.length + set.jobs.length;
    expect(plan.tiles).toHaveLength(all);
    // One row: every tile on the same bottom line.
    expect(new Set(plan.tiles.map((t) => t.rect.y + t.rect.height)).size).toBe(1);
    // The needs-you tiles went compact first.
    for (const t of plan.tiles.filter((x) => x.kind === 'needs')) expect(t.rect.width).toBe(DOCK.W_COMPACT);
    expect(plan.rect.width).toBeLessThanOrEqual(1096 - 2 * DOCK.SIDE);
    const right = plan.rect.x + plan.rect.width;
    for (const t of plan.tiles.filter((x) => x.kind === 'needs')) expect(t.rect.x + t.rect.width).toBeLessThanOrEqual(right);
  });
  it('a stage too narrow even compact scrolls from the first tile that does not fit', () => {
    const plan = dockTiles(setOf(B), { width: 940, height: 700 }, { tight: false });
    expect(plan.scrollFrom).not.toBeNull();
    expect(plan.tiles.slice(0, plan.scrollFrom!).every((t) => t.rect.x + t.rect.width <= plan.rect.x + plan.rect.width)).toBe(true);
    expect(plan.tiles[0].kind).toBe('needs');
  });
  it('a wide set on a narrow stage compacts the jobs before anything else', () => {
    const set: DockSet = { needs: ['n'], members: [], jobs: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], minis: [] };
    const wide = dockTiles(set, { width: 1356, height: 828 }, { tight: false });
    expect(wide.tiles.every((t) => !t.compact)).toBe(true);
    const tight = dockTiles(set, { width: 1096, height: 760 }, { tight: false });
    expect(tight.tiles.filter((t) => t.kind === 'job').every((t) => t.compact)).toBe(true);
    expect(tight.tiles.find((t) => t.kind === 'needs')!.compact).toBe(false);
  });
  it('the Pool tile shows only with pool rows', () => {
    expect(dockTiles({ needs: [], members: [], jobs: ['a'], minis: [], pool: 0 }, { width: 1356, height: 828 }, { tight: false }).tiles.some((t) => t.kind === 'pool')).toBe(false);
    expect(dockTiles({ needs: [], members: [], jobs: ['a'], minis: [], pool: 2 }, { width: 1356, height: 828 }, { tight: false }).tiles.at(-1)!.kind).toBe('pool');
  });
});

describe('dockDecision (K1)', () => {
  it('docks the moment one does not fit, and floats back only with room for two more', () => {
    expect(dockDecision(false, { need: 5, room: 5, card: 1 })).toBe(false);
    expect(dockDecision(false, { need: 6, room: 5, card: 1 })).toBe(true);
    expect(dockDecision(true, { need: 5, room: 5, card: 1 })).toBe(true);
    expect(dockDecision(true, { need: 5, room: 6, card: 1 })).toBe(true);
    expect(dockDecision(true, { need: 5, room: 7, card: 1 })).toBe(false);
    expect(dockDecision(true, { need: 0, room: 0, card: 1 })).toBe(false);
  });
});
