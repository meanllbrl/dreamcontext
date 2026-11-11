/**
 * The live walk of sahip-karti-yerinde (scripts/verify/verify-owner-card.mjs, plan-r7 criteria 11
 * and 12) cannot run here: it needs the built app, a browser and real processes. What CAN be
 * pinned is the half it decides with: its argv, the one line that tells the lead to build first,
 * how it counts the Super's event lines for ONE child (a `parked` never mistaken for a `gone`), and
 * the hand-written receipt it plants (it must sit where the server reads it, 0600 in a 0700 dir,
 * and must NOT carry a valid MAC). Each test names the failure it prevents.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The walk is plain ESM; vitest imports it straight from scripts/verify (as jev-verify-lib does).
const dir = '../../scripts/verify';
const walk = await import(`${dir}/verify-owner-card.mjs`);
const { parseArgs, missingBuildLine, childEvents, receiptFileOf, writeHandEntry, receiptIds } = walk;

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
