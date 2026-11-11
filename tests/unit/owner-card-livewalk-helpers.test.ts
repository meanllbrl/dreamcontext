/**
 * The live walk of sahip-karti-yerinde (scripts/verify/verify-owner-card.mjs, plan-r7 criteria 11
 * and 12) cannot run here: it needs the built app, a browser and real processes. What CAN be
 * pinned is the half it decides with: its argv, the one line that tells the lead to build first,
 * how it counts the Super's event lines for ONE child (a `parked` never mistaken for a `gone`), and
 * the hand-written receipt it plants (it must sit where the server reads it, 0600 in a 0700 dir,
 * and must NOT carry a valid MAC), and the geometry that proves a screenshot is of a CLEAN state
 * (the points a "nothing covers it" check probes, and the overlap it records as a fact). Each test
 * names the failure it prevents.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The walk is plain ESM; vitest imports it straight from scripts/verify (as jev-verify-lib does).
const dir = '../../scripts/verify';
const walk = await import(`${dir}/verify-owner-card.mjs`);
const { parseArgs, missingBuildLine, childEvents, receiptFileOf, writeHandEntry, receiptIds, probePoints, overlapOf, visiblePart, probeInset, gridPoints, chromeBand, clipChrome } = walk;

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'owner-card-livewalk-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe('argv', () => {
  it('--out is required: a run without it says how to call it, never writes into the repo', () => {
    expect(parseArgs([]).error).toMatch(/--out <dir>/);
    expect(parseArgs(['--out']).error).toBeTruthy();
    expect(parseArgs(['--out', '--x']).error).toBeTruthy();
  });
  it('--out resolves to an absolute folder', () => {
    const r = parseArgs(['--out', 'tmp/kanit']);
    expect(r.error).toBeUndefined();
    expect(r.out.startsWith('/')).toBe(true);
    expect(r.out.endsWith('tmp/kanit')).toBe(true);
  });
});

describe('the build line', () => {
  it('no dist: ONE line naming the build command, so the lead knows what to run first', () => {
    const line = missingBuildLine('/repo', () => false);
    expect(line).toMatch(/^FAIL build missing/);
    expect(line).toContain('npm run build');
    expect(line).toContain('dist/index.js');
    expect(line).toContain('dist/dashboard/index.html');
    expect(line.split('\n')).toHaveLength(1);
  });
  it('a built tree: no line', () => {
    expect(missingBuildLine('/repo', () => true)).toBeNull();
  });
});

describe('the Super\'s event lines for one child', () => {
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';
  it('counts parked, gone and owner-result per child, never another child\'s', () => {
    const texts = [
      `[super events]\n- item=q1 child=${A} event=parked wait=run\nIt wakes by itself when the owner acts; do not resume it for this.`,
      `[super events]\n- item=q2 child=${B} event=gone`,
      `[super events]\n- item=q3 child=${A} event=owner-result card=run exit=0`,
    ];
    expect(childEvents(texts, A)).toMatchObject({ parked: 1, gone: 0, ownerResult: 1 });
    expect(childEvents(texts, B)).toMatchObject({ parked: 0, gone: 1, ownerResult: 0 });
  });
  it('a child id that is a prefix of another is not counted for it', () => {
    expect(childEvents([`- item=q child=${A}x event=gone`], A).gone).toBe(0);
  });
  it('`event=parked` is never read as a gone, nor `owner` as `owner-result`', () => {
    const e = childEvents([`- item=q child=${A} event=parked wait=run`, `- item=r child=${A} event=owner wait=run`], A);
    expect(e).toMatchObject({ parked: 1, gone: 0, ownerResult: 0 });
  });
});

describe('the hand-written receipt', () => {
  const target = { childRecordId: 'main', childId: '33333333-3333-4333-8333-333333333333' };
  it('sits where the server reads it (main__<child>.json under cards/receipts), 0600 in a 0700 dir', () => {
    const file = writeHandEntry(home, target, { id: 'hand-1', cardRef: 'a'.repeat(32), kind: 'secret', text: 'x', at: 1 });
    expect(file).toBe(join(home, '.dreamcontext', 'cards', 'receipts', `main__${target.childId}.json`));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, '.dreamcontext', 'cards', 'receipts')).mode & 0o777).toBe(0o700);
    expect(receiptIds(home, target)).toEqual(['hand-1']);
  });
  it('a member Super\'s target names its file with ~, not a colon', () => {
    expect(receiptFileOf(home, 'm:rota', 'c1')).toMatch(/m~rota__c1\.json$/);
  });
  it('carries no valid MAC: a planted file must never be able to prove the owner acted', () => {
    const file = writeHandEntry(home, target, { id: 'hand-2', cardRef: 'b'.repeat(32), kind: 'run', text: 'y', at: 2 });
    const entry = JSON.parse(readFileSync(file, 'utf-8')).entries[0];
    expect(entry.mac).toBe('0'.repeat(64));
    expect(entry.pending).toBeUndefined();
  });
  it('adds to what is there, never replaces it', () => {
    writeHandEntry(home, target, { id: 'h-a', cardRef: 'c'.repeat(32), kind: 'secret', text: 'a', at: 1 });
    writeHandEntry(home, target, { id: 'h-b', cardRef: 'c'.repeat(32), kind: 'secret', text: 'b', at: 2 });
    expect(receiptIds(home, target)).toEqual(['h-a', 'h-b']);
  });
  it('no file: no ids', () => {
    expect(receiptIds(home, { childRecordId: 'main', childId: 'none' })).toEqual([]);
  });
});

describe('the clean-shot probe points', () => {
  const vp = { width: 390, height: 844 };
  it('centre and four corners, inset, for an element fully on screen', () => {
    const pts = probePoints({ x: 10, y: 20, width: 100, height: 40 }, vp, 3);
    expect(pts.map((p: { at: string }) => p.at)).toEqual(['centre', 'top-left', 'top-right', 'bottom-left', 'bottom-right']);
    expect(pts[0]).toMatchObject({ x: 60, y: 40 });
    expect(pts[1]).toMatchObject({ x: 13, y: 23 });
    expect(pts[4]).toMatchObject({ x: 107, y: 57 });
  });
  it('an element partly off screen is probed on its ON-SCREEN part only (a point off screen hits nothing and would read as covered)', () => {
    const pts = probePoints({ x: -50, y: 800, width: 200, height: 100 }, vp, 3);
    for (const p of pts) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(vp.width);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(vp.height);
    }
  });
  it('an element wholly off screen gives no points: the step fails as "not on screen", never passes empty', () => {
    expect(probePoints({ x: 0, y: 900, width: 100, height: 40 }, vp)).toEqual([]);
    expect(probePoints({ x: 400, y: 10, width: 100, height: 40 }, vp)).toEqual([]);
  });
  it('a sliver thinner than the inset is probed inside it, never past its middle', () => {
    const pts = probePoints({ x: 10, y: 10, width: 2, height: 2 }, vp, 3);
    for (const p of pts) { expect(p.x).toBe(11); expect(p.y).toBe(11); }
  });
});

describe('the overlap fact', () => {
  it('two rects that share area: where, how big', () => {
    expect(overlapOf({ x: 0, y: 500, width: 390, height: 300 }, { x: 0, y: 700, width: 390, height: 60 }))
      .toEqual({ x: 0, y: 700, width: 390, height: 60, area: 23400 });
  });
  it('touching edges or apart: no overlap', () => {
    expect(overlapOf({ x: 0, y: 0, width: 100, height: 100 }, { x: 100, y: 0, width: 50, height: 50 })).toBeNull();
    expect(overlapOf({ x: 0, y: 0, width: 100, height: 100 }, { x: 0, y: 300, width: 50, height: 50 })).toBeNull();
  });
  it('a missing rect (no agenda, no bar row on screen) is no overlap, never a crash', () => {
    expect(overlapOf(null, { x: 0, y: 0, width: 1, height: 1 })).toBeNull();
    expect(overlapOf({ x: 0, y: 0, width: 1, height: 1 }, null)).toBeNull();
  });
});

describe('a TRUE cover check (neither blind nor falsely red)', () => {
  const vp = { width: 390, height: 844 };
  it('probes sit inside a rounded corner: radius + 2 px, never under 8 px (a corner 3 px in hits the parent)', () => {
    expect(probeInset([])).toBe(8);
    expect(probeInset([4, 4, 4, 4])).toBe(8);
    expect(probeInset([12, 12, 0, 0])).toBe(14);
    expect(probeInset([Number.NaN, 20])).toBe(22);
  });
  it('the part under the fixed titlebar is not "visible": probes start below it', () => {
    const top = 40;
    expect(visiblePart({ x: 24, y: -33, width: 342, height: 631 }, vp, top)).toEqual({ x: 24, y: 40, width: 342, height: 558 });
    for (const p of probePoints({ x: 24, y: -33, width: 342, height: 631 }, vp, 8, top)) expect(p.y).toBeGreaterThanOrEqual(top + 8);
  });
  it('an element wholly under the titlebar has no visible part and no points', () => {
    expect(visiblePart({ x: 0, y: 0, width: 100, height: 30 }, vp, 40)).toBeNull();
    expect(probePoints({ x: 0, y: 0, width: 100, height: 30 }, vp, 8, 40)).toEqual([]);
  });
  it('a 12 px corner radius moves the corner probes 14 px in', () => {
    const pts = probePoints({ x: 100, y: 100, width: 200, height: 100 }, vp, probeInset([12]));
    expect(pts[1]).toMatchObject({ at: 'top-left', x: 114, y: 114 });
    expect(pts[4]).toMatchObject({ at: 'bottom-right', x: 286, y: 186 });
  });
});

describe('the overlap grid', () => {
  it('samples every 8 px over the overlap (a 292 x 33 strip is 36 x 4 points), all inside it', () => {
    const r = { x: 49, y: 131, width: 292, height: 33 };
    const g = gridPoints(r, 8);
    expect(g).toHaveLength(36 * 4);
    for (const p of g) {
      expect(p.x).toBeGreaterThan(r.x); expect(p.x).toBeLessThan(r.x + r.width);
      expect(p.y).toBeGreaterThan(r.y); expect(p.y).toBeLessThan(r.y + r.height);
    }
  });
  it('a sliver thinner than a step still gets one point (an overlap is never sampled as empty)', () => {
    expect(gridPoints({ x: 0, y: 0, width: 5, height: 3 }, 8)).toEqual([{ x: 2.5, y: 1.5 }]);
  });
  it('no overlap: no points', () => {
    expect(gridPoints(null, 8)).toEqual([]);
  });
});

describe('the band between the top and bottom chrome', () => {
  const vp = { width: 390, height: 844 };
  const slot = { x: 24, y: 81.75, width: 342, height: 631 };
  it('the composer is bottom chrome like the titlebar is top chrome: the slot is probed only above it', () => {
    const band = chromeBand(slot, vp, [{ x: 0, y: 0, width: 390, height: 42 }], [{ x: 12, y: 690, width: 366, height: 140 }]);
    expect(band).toEqual({ top: 42, bottom: 690 });
    for (const p of probePoints(slot, vp, 8, band.top, band.bottom)) expect(p.y).toBeLessThanOrEqual(690 - 8);
    expect(visiblePart(slot, vp, band.top, band.bottom)).toEqual({ x: 24, y: 81.75, width: 342, height: 690 - 81.75 });
  });
  it('the lowest top chrome wins (the Super bar under the titlebar), and the highest bottom chrome (the unread pill over the composer)', () => {
    const band = chromeBand(slot, vp,
      [{ x: 0, y: 0, width: 390, height: 42 }, { x: 0, y: 42, width: 390, height: 120 }],
      [{ x: 12, y: 690, width: 366, height: 140 }, { x: 100, y: 640, width: 190, height: 32 }]);
    expect(band).toEqual({ top: 162, bottom: 640 });
  });
  it('chrome in another column (no shared x) is not counted', () => {
    const left = { x: 0, y: 100, width: 300, height: 400 };
    expect(chromeBand(left, { width: 1440, height: 900 }, [{ x: 400, y: 0, width: 600, height: 300 }], [{ x: 400, y: 700, width: 600, height: 150 }]))
      .toEqual({ top: 0, bottom: 900 });
  });
  it('no chrome: the whole viewport', () => {
    expect(chromeBand(slot, vp)).toEqual({ top: 0, bottom: 844 });
  });
  it('an element taller than the band is not "whole": its lower part needs the second scroll', () => {
    const part = visiblePart(slot, vp, 42, 690);
    expect(part.height).toBeLessThan(slot.height);
  });
});

describe('what a clipping scroll container hides is chrome', () => {
  const vp = { width: 390, height: 844 };
  it('the chat list clipped below its own head: everything above the clip is top chrome, below it bottom chrome', () => {
    const clip = { x: 12, y: 190, width: 366, height: 415 };
    expect(clipChrome(clip, vp)).toEqual({
      tops: [{ x: 12, y: 0, width: 366, height: 190 }],
      bottoms: [{ x: 12, y: 605, width: 366, height: 239 }],
    });
  });
  it('the lower-part shot of a tall slot starts under the chat head (the r1d miss: probes at y 165 hit the head)', () => {
    const slot = { x: 24, y: 109, width: 342, height: 488 };
    const { tops, bottoms } = clipChrome({ x: 12, y: 190, width: 366, height: 415 }, vp);
    const band = chromeBand(slot, vp, [{ x: 0, y: 0, width: 390, height: 151 }, ...tops], bottoms);
    expect(band.top).toBe(190);
    for (const p of probePoints(slot, vp, 8, band.top, band.bottom)) expect(p.y).toBeGreaterThanOrEqual(190 + 8);
  });
  it('a clip that is the whole viewport adds nothing; no clip adds nothing', () => {
    expect(clipChrome({ x: 0, y: 0, width: 390, height: 844 }, vp)).toEqual({ tops: [], bottoms: [] });
    expect(clipChrome(null, vp)).toEqual({ tops: [], bottoms: [] });
  });
});
