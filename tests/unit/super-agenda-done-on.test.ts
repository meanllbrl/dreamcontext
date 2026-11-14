/**
 * Task ajanda-gunluk C4, criterion 11: `agendaDoneOn` is the one rule for "Done on day D": the
 * live pad's Done lines finished on D plus D's file, one copy per id (the live pad wins). With no
 * write since midnight, or with the archive failing, yesterday's Done lines still show under
 * yesterday and never under today, and never twice. Fictional project (synthetic fixtures).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetSuperIndex, superAgendaDaysDir, withSuperState, SUPER_STATE_REL } from '../../src/lib/super/store.js';
import { agendaDoneOn, archiveDoneLines, localDay, mergeDayDone, okDay } from '../../src/lib/super/pad-archive.js';
import { emptySuperState, type SuperPadItem } from '../../src/lib/super/types.js';

let dir: string;
let root: string;
const TODAY = new Date(2026, 10, 14, 10, 0).getTime();
const YESTERDAY = new Date(2026, 10, 13, 15, 0).getTime();
const done = (id: string, at: number): SuperPadItem => ({ id, section: 'done', text: `Acme ${id}`, at });

beforeEach(() => {
  resetSuperIndex();
  dir = mkdtempSync(join(tmpdir(), 'agenda-done-on-'));
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });
function seed(pad: SuperPadItem[]): void {
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: 'sess-day', enabled: true, pad }));
}

describe('days', () => {
  it('okDay takes a strict real day only', () => {
    expect(okDay('2026-11-14')).toBe(true);
    for (const bad of ['2026-02-30', '2026-11-14T00', '../x', '2026-1-4', '', null]) expect(okDay(bad)).toBe(false);
  });

  it('with no write since midnight, yesterday\'s Done line shows under yesterday, never today', async () => {
    seed([done('n1', YESTERDAY), done('n2', TODAY)]);
    expect((await agendaDoneOn(root, 'main', localDay(YESTERDAY))).map((p) => p.id)).toEqual(['n1']);
    expect((await agendaDoneOn(root, 'main', localDay(TODAY))).map((p) => p.id)).toEqual(['n2']);
  });

  it('a line in both the file and the live pad shows once, as its live copy', async () => {
    seed([done('n1', YESTERDAY)]);
    await archiveDoneLines(root, 'main', [{ ...done('n1', YESTERDAY), text: 'older copy' }]);
    const got = await agendaDoneOn(root, 'main', localDay(YESTERDAY));
    expect(got).toHaveLength(1);
    expect(got[0].text).toBe('Acme n1');
  });

  it('a file copy whose id is live in ANY section is dropped (the line was reopened)', () => {
    const live: SuperPadItem[] = [{ id: 'n1', section: 'now', text: 'reopened', at: TODAY }];
    expect(mergeDayDone(live, [done('n1', YESTERDAY)], localDay(YESTERDAY))).toEqual([]);
  });

  it('between two file copies the newest finish wins', () => {
    const a = done('n1', YESTERDAY);
    const b = { ...done('n1', YESTERDAY + 1000), text: 'finished again' };
    expect(mergeDayDone([], [a, b], localDay(YESTERDAY))).toEqual([b]);
  });

  it('a line evicted today is still Done today, from its file', async () => {
    seed([done('n1', TODAY - 100)]);
    await withSuperState(root, 'main', (s) => { s.pad = []; });
    expect((await agendaDoneOn(root, 'main', localDay(TODAY))).map((p) => p.id)).toEqual(['n1']);
  });

  it('while the archive is failing, yesterday\'s lines stay on the record and still show under yesterday once', async () => {
    seed([done('n1', YESTERDAY)]);
    mkdirSync(join(root, 'state', '.super'), { recursive: true });
    mkdirSync(join(dir, 'away'));
    symlinkSync(join(dir, 'away'), superAgendaDaysDir(root));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await withSuperState(root, 'main', (s) => { s.pad = []; });
    expect((await agendaDoneOn(root, 'main', localDay(YESTERDAY))).map((p) => p.id)).toEqual(['n1']);
    expect(await agendaDoneOn(root, 'main', localDay(TODAY))).toEqual([]);
  });
});
