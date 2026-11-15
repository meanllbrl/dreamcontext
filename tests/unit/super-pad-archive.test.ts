/**
 * Task ajanda-gunluk C4, criterion 11: one archive hook in the store. Every Done line the loaded
 * pad held that the new one does not (roll-off, drop, clear, a full pad's eviction) lands in the
 * file of the day it finished; idempotent, atomic, inside the lock, links refused. A failure
 * never cuts a line and never fails the write: the lines stay on the record and, on a full pad,
 * only the line added in that write is refused. Main and every member keep their own folders.
 * Fictional project (synthetic fixtures).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSuperState, resetSuperIndex, superAgendaDaysDir, superRecordPath, withSuperState, SUPER_STATE_REL } from '../../src/lib/super/store.js';
import { archiveDoneLines, localDay } from '../../src/lib/super/pad-archive.js';
import { MAX_PAD, emptySuperState, type SuperPadItem } from '../../src/lib/super/types.js';

let dir: string;
let root: string;
const TODAY = new Date(2026, 10, 14, 10, 0).getTime();
const YESTERDAY = new Date(2026, 10, 13, 15, 0).getTime();

beforeEach(() => {
  resetSuperIndex();
  dir = mkdtempSync(join(tmpdir(), 'pad-archive-'));
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

const done = (id: string, at: number, extra: Partial<SuperPadItem> = {}): SuperPadItem => ({ id, section: 'done', text: `Acme step ${id}`, at, ...extra });
const open = (id: string, at: number = TODAY): SuperPadItem => ({ id, section: 'now', text: `Acme open ${id}`, at });
function seed(pad: SuperPadItem[], id: 'main' | `m:${string}` = 'main'): void {
  const path = superRecordPath(root, id);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify({ ...emptySuperState(), session: 'sess-arc', enabled: true, pad, padSeq: pad.length, ...(id !== 'main' ? { member: id.slice(2) } : {}) }));
}
const dayFile = (day: number, id: 'main' | `m:${string}` = 'main') => join(superAgendaDaysDir(root, id), `${localDay(day)}.json`);
const dayLines = (day: number, id: 'main' | `m:${string}` = 'main'): SuperPadItem[] => JSON.parse(readFileSync(dayFile(day, id), 'utf-8')).lines;

describe('the diff hook archives every Done line that leaves the record', () => {
  it('a drop, a clear and an eviction all land in the finish day\'s file; an open line removed does not', async () => {
    seed([done('n1', YESTERDAY), done('n2', TODAY - 1000), open('n3'), done('n4', TODAY - 500)]);
    await withSuperState(root, 'main', (s) => { s.pad = s.pad!.filter((p) => p.id !== 'n2' && p.id !== 'n3'); });
    expect(dayLines(TODAY).map((p) => p.id)).toEqual(['n2']);
    await withSuperState(root, 'main', (s) => { s.pad = []; });
    expect(dayLines(TODAY).map((p) => p.id)).toEqual(['n2', 'n4']);
    expect(dayLines(YESTERDAY).map((p) => p.id)).toEqual(['n1']);
    expect(JSON.stringify(dayLines(TODAY))).not.toContain('n3');
    // Atomic: no temp file is left beside it.
    expect(readdirSync(superAgendaDaysDir(root)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('is idempotent by id and finish time', async () => {
    await archiveDoneLines(root, 'main', [done('n1', TODAY)]).catch(() => {});
    seed([]);
    await archiveDoneLines(root, 'main', [done('n1', TODAY)]);
    await archiveDoneLines(root, 'main', [done('n1', TODAY), done('n2', TODAY)]);
    expect(dayLines(TODAY).map((p) => p.id)).toEqual(['n1', 'n2']);
  });

  it('a corrupt day file is set aside and the day starts fresh', async () => {
    seed([]);
    mkdirSync(superAgendaDaysDir(root), { recursive: true });
    writeFileSync(dayFile(TODAY), '{not json');
    await archiveDoneLines(root, 'main', [done('n5', TODAY)]);
    expect(dayLines(TODAY).map((p) => p.id)).toEqual(['n5']);
    expect(readdirSync(superAgendaDaysDir(root)).some((f) => f.includes('.corrupt-'))).toBe(true);
  });
});

describe('a failing archive never cuts a line', () => {
  function breakArchive(): void {
    // A link where the days folder belongs: refused, so every archive fails.
    mkdirSync(join(root, 'state', '.super'), { recursive: true });
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, superAgendaDaysDir(root));
  }

  it('a symlinked folder is refused; the lines stay on the record and the write lands', async () => {
    seed([done('n1', TODAY), open('n2')]);
    breakArchive();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const next = await withSuperState(root, 'main', (s) => { s.pad = s.pad!.filter((p) => p.id !== 'n1'); s.padSeq = 7; });
    expect(next.pad!.map((p) => p.id)).toEqual(['n1', 'n2']);
    const back = await readSuperState(root);
    expect(back.padSeq).toBe(7);
    expect(back.pad!.map((p) => p.id)).toEqual(['n1', 'n2']);
    expect(readdirSync(join(dir, 'elsewhere'))).toEqual([]);
  });

  it('a full pad + a failing archive + an add keeps 40 lines and the old Done line, refuses the new one and drops its mark', async () => {
    const pad = [done('n1', TODAY - 5000), ...Array.from({ length: MAX_PAD - 1 }, (_, i) => open(`n${i + 2}`))];
    seed(pad);
    breakArchive();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const refused: string[][] = [];
    const next = await withSuperState(root, 'main', (s) => {
      // What a full pad's add does: evict the oldest Done line, add the new one, mark it.
      s.pad = [...s.pad!.filter((p) => p.id !== 'n1'), open('n41')];
      s.ownerMarks = [{ key: 'pad:n41', kind: 'pad-add', text: 'Acme open n41', at: TODAY, seq: 1 }];
    }, { onPadRefused: (ids) => refused.push(ids) });
    expect(refused).toEqual([['n41']]);
    expect(next.pad).toHaveLength(MAX_PAD);
    expect(next.pad!.some((p) => p.id === 'n1')).toBe(true);
    expect(next.pad!.some((p) => p.id === 'n41')).toBe(false);
    expect(next.ownerMarks).toBeUndefined();
  });

  it('logs once per path and error, not once per write', async () => {
    seed([done('n1', TODAY), done('n2', TODAY)]);
    breakArchive();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await withSuperState(root, 'main', (s) => { s.pad = []; });
    await withSuperState(root, 'main', (s) => { s.pad = []; });
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('not archived')).length).toBeLessThanOrEqual(1);
  });
});

describe('every Super has its own days', () => {
  it('a member named main writes to its own folder, never main\'s', async () => {
    expect(superAgendaDaysDir(root, 'm:main')).not.toBe(superAgendaDaysDir(root, 'main'));
    seed([done('n1', TODAY)], 'm:main');
    await withSuperState(root, 'm:main', (s) => { s.pad = []; });
    expect(dayLines(TODAY, 'm:main').map((p) => p.id)).toEqual(['n1']);
    expect(existsSync(superAgendaDaysDir(root, 'main'))).toBe(false);
  });

  it('no days folder is made for a record that is gone', async () => {
    await expect(archiveDoneLines(root, 'm:ghost', [done('n1', TODAY)])).rejects.toThrow();
    expect(existsSync(superAgendaDaysDir(root, 'm:ghost'))).toBe(false);
  });

  it('main\'s record path is unchanged on disk', () => {
    expect(superRecordPath(root, 'main')).toBe(join(root, SUPER_STATE_REL));
  });
});
