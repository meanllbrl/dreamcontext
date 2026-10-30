import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_READ, READ_MARKS_REL, applyReadMarks, capReadMarks, clearReadMarks, mergeReadMarks, parseReadPatch, readReadMarks, sanitizeReadMarks,
} from '../../src/lib/super/read-marks.js';
import { _superUnreadSize, dropSuperUnread, publishSuperUnread } from '../../dashboard/src/components/sleepy/super/superUnreadStore';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'super-read-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('the read record', () => {
  it('reading writes nothing; the first write births it, and it survives as written (a restart, a rotated session)', async () => {
    expect(await readReadMarks(root)).toBeNull();
    expect(existsSync(join(root, READ_MARKS_REL))).toBe(false);
    expect((await applyReadMarks(root, {}, 100)).since).toBe(100);
    await applyReadMarks(root, { read: [{ key: 't:abc', ts: 200 }] }, 300);
    expect(await readReadMarks(root)).toEqual({ since: 100, read: [{ key: 't:abc', ts: 200 }] });
    expect(JSON.parse(readFileSync(join(root, READ_MARKS_REL), 'utf8')).read).toHaveLength(1);
  });

  it('dies with the hand-over, and the next one starts new', async () => {
    await applyReadMarks(root, {}, 100);
    await clearReadMarks(root);
    expect(existsSync(join(root, READ_MARKS_REL))).toBe(false);
    expect((await applyReadMarks(root, {}, 500)).since).toBe(500);
  });

  it('a broken file is a new record, never a flood of old messages', async () => {
    mkdirSync(join(root, 'state', '.super'), { recursive: true });
    writeFileSync(join(root, READ_MARKS_REL), '{ broken');
    expect(await readReadMarks(root)).toBeNull();
    expect(await applyReadMarks(root, {}, 700)).toEqual({ since: 700, read: [] });
  });

  it('refuses a symlinked file', async () => {
    mkdirSync(join(root, 'state', '.super'), { recursive: true });
    writeFileSync(join(root, 'other.json'), '{}');
    symlinkSync(join(root, 'other.json'), join(root, READ_MARKS_REL));
    await expect(readReadMarks(root)).rejects.toThrow(/symlink/);
  });

  it('refuses a symlinked state/.super', async () => {
    mkdirSync(join(root, 'state'), { recursive: true });
    mkdirSync(join(root, 'elsewhere'));
    symlinkSync(join(root, 'elsewhere'), join(root, 'state', '.super'));
    await expect(applyReadMarks(root, {}, 1)).rejects.toThrow(/not a directory/);
  });

  it('concurrent writes all land', async () => {
    await applyReadMarks(root, {}, 1);
    await Promise.all(['a', 'b', 'c', 'd'].map((k, i) => applyReadMarks(root, { read: [{ key: `t:${k}`, ts: 10 + i }] }, 100)));
    expect((await readReadMarks(root))!.read.map((m) => m.key).sort()).toEqual(['t:a', 't:b', 't:c', 't:d']);
  });
});

describe('merging', () => {
  it('only adds, and mark-all folds what it covers', () => {
    const m = mergeReadMarks({ since: 10, read: [{ key: 'a', ts: 20 }] }, { read: [{ key: 'b', ts: 30 }] }, 100);
    expect(m.read.map((x) => x.key)).toEqual(['a', 'b']);
    expect(mergeReadMarks(m, { allBefore: 25 }, 100)).toEqual({ since: 25, read: [{ key: 'b', ts: 30 }] });
    expect(mergeReadMarks(m, { allBefore: 5 }, 100).since).toBe(10);
  });

  it('a wrong clock cannot mark the future read', () => {
    expect(mergeReadMarks({ since: 0, read: [] }, { allBefore: 9e12 }, 100).since).toBe(100);
  });

  it('stays bounded: the oldest marks fold into since', () => {
    const read = Array.from({ length: MAX_READ + 5 }, (_, i) => ({ key: `k${i}`, ts: i + 1 }));
    const capped = capReadMarks({ since: 0, read });
    expect(capped.read).toHaveLength(MAX_READ);
    expect(capped.since).toBe(5);
  });
});

describe('the wire', () => {
  it('refuses a body that is not a patch', () => {
    expect(parseReadPatch({ read: [{ key: '../x', ts: 1 }] })).toBeNull();
    expect(parseReadPatch({ read: 'x' })).toBeNull();
    expect(parseReadPatch({ allBefore: 'now' })).toBeNull();
    expect(parseReadPatch({ read: [{ key: 'q:a-1', ts: 1 }], allBefore: 2 })).toEqual({ read: [{ key: 'q:a-1', ts: 1 }], allBefore: 2 });
  });

  it('reads no record out of junk', () => {
    expect(sanitizeReadMarks([])).toBeNull();
    expect(sanitizeReadMarks({ since: 'x', read: [] })).toBeNull();
    expect(sanitizeReadMarks({ since: 1, read: [{ key: 'bad key', ts: 2 }, { key: 'ok', ts: 2 }] })).toEqual({ since: 1, read: [{ key: 'ok', ts: 2 }] });
  });
});

describe('the rail\'s count', () => {
  it('a key is born with a count and dies with the pane or at zero', () => {
    const before = _superUnreadSize();
    const pane = {};
    publishSuperUnread('v1', 3, pane);
    expect(_superUnreadSize()).toBe(before + 1);
    publishSuperUnread('v1', 0, pane);
    expect(_superUnreadSize()).toBe(before);
    publishSuperUnread('v1', 2, pane);
    dropSuperUnread('v1', pane);
    expect(_superUnreadSize()).toBe(before);
  });

  it('an old pane leaving does not wipe the new pane\'s count', () => {
    const before = _superUnreadSize();
    const old = {};
    const fresh = {};
    publishSuperUnread('v2', 3, old);
    publishSuperUnread('v2', 3, fresh);
    dropSuperUnread('v2', old);
    expect(_superUnreadSize()).toBe(before + 1);
    dropSuperUnread('v2', fresh);
  });
});
