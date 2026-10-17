/**
 * src/lib/jsonl-fold.ts — the incremental fold under session-stats / session-model (task: the
 * desktop app stays light on an 8GB MacBook Air, plan S1).
 *
 * The contract: the folded state always equals a from-scratch fold of the file's complete
 * lines, while bytes already folded are never read again. Each case below is a way a
 * transcript file can change between two polls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, renameSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Bytes handed out by every `read` (counted), and an optional cap to force short reads. */
const io = vi.hoisted(() => ({ bytes: 0, reads: 0, shortReadCap: 0 }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      const fh = await real.open(...args);
      const read = fh.read.bind(fh) as (b: Buffer, o: number, l: number, p: number) => Promise<{ bytesRead: number; buffer: Buffer }>;
      (fh as unknown as { read: typeof read }).read = async (b, o, l, p) => {
        const len = io.shortReadCap > 0 && l > 1 ? Math.min(l, io.shortReadCap) : l;
        const r = await read(b, o, len, p);
        io.reads += 1;
        io.bytes += r.bytesRead;
        return r;
      };
      return fh;
    },
  };
});

const { foldJsonl, resetJsonlFoldsForTests } = await import('../../src/lib/jsonl-fold.js');

interface Seen { rows: unknown[] }
const init = (): Seen => ({ rows: [] });
const step = (s: Seen, row: unknown) => { s.rows.push(row); };
const fold = (p: string) => foldJsonl(p, 'test', init, step);

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dc-jsonl-fold-'));
  file = join(dir, 't.jsonl');
  resetJsonlFoldsForTests();
  io.bytes = 0; io.reads = 0; io.shortReadCap = 0;
});

afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const line = (o: unknown) => `${JSON.stringify(o)}\n`;

describe('foldJsonl', () => {
  it('folds every complete line and skips bad JSON and blank lines', async () => {
    writeFileSync(file, `${line({ a: 1 })}not json\n\n${line({ a: 2 })}`);
    expect((await fold(file)).rows).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('an appended line is folded alone: the old bytes are not read again', async () => {
    writeFileSync(file, line({ a: 1 }).repeat(1000));
    await fold(file);
    const before = io.bytes;
    const extra = line({ a: 2 });
    appendFileSync(file, extra);
    const s = await fold(file);
    expect(s.rows.length).toBe(1001);
    // The new line, plus the 1-byte "still a newline before the offset" check.
    expect(io.bytes - before).toBe(Buffer.byteLength(extra) + 1);
  });

  it('an unchanged file reads only the 1-byte resume check', async () => {
    writeFileSync(file, line({ a: 1 }).repeat(100));
    await fold(file);
    const before = io.bytes;
    await fold(file);
    expect(io.bytes - before).toBe(1);
  });

  it('a truncated file folds again from zero', async () => {
    writeFileSync(file, line({ a: 1 }) + line({ a: 2 }));
    await fold(file);
    truncateSync(file, 0);
    appendFileSync(file, line({ b: 1 }));
    expect((await fold(file)).rows).toEqual([{ b: 1 }]);
  });

  it('a rotation (a new file under the same path) folds the new file from zero', async () => {
    writeFileSync(file, line({ a: 1 }));
    await fold(file);
    const next = join(dir, 'next.jsonl');
    writeFileSync(next, line({ c: 1 }) + line({ c: 2 }) + line({ c: 3 }));
    renameSync(next, file);
    expect((await fold(file)).rows).toEqual([{ c: 1 }, { c: 2 }, { c: 3 }]);
  });

  it('an in-place rewrite that also grew is caught by the newline check and re-folded', async () => {
    writeFileSync(file, line({ a: 1 }));
    await fold(file);
    // Same inode, larger, and the byte before the old offset is no longer a newline.
    writeFileSync(file, line({ zzzzzzzzzz: 'rewritten' }) + line({ a: 3 }));
    expect((await fold(file)).rows).toEqual([{ zzzzzzzzzz: 'rewritten' }, { a: 3 }]);
  });

  it('a partial last line is held back and folded once its newline lands', async () => {
    writeFileSync(file, line({ a: 1 }) + '{"a":');
    expect((await fold(file)).rows).toEqual([{ a: 1 }]);
    appendFileSync(file, '2}\n');
    expect((await fold(file)).rows).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('a multibyte character split across a 1 MB chunk boundary decodes whole', async () => {
    // `{"s":"` is 6 bytes, so the second ğ (2 bytes) starts at byte 1 MB − 1 and straddles it.
    const pad = 'x'.repeat(1024 * 1024 - 9);
    writeFileSync(file, `{"s":"${pad}ğğ"}\n` + line({ after: 'ç' }));
    const s = await fold(file);
    expect(s.rows).toEqual([{ s: `${pad}ğğ` }, { after: 'ç' }]);
  });

  it('short reads still fold every line', async () => {
    io.shortReadCap = 7; // shorter than one line: every line spans two reads
    writeFileSync(file, line({ a: 1 }) + line({ a: 2 }) + line({ a: 3 }));
    expect((await fold(file)).rows).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
  });

  it('concurrent calls share one fold (one read of the file)', async () => {
    writeFileSync(file, line({ a: 1 }).repeat(10));
    const size = Buffer.byteLength(line({ a: 1 })) * 10;
    const [a, b, c] = await Promise.all([fold(file), fold(file), fold(file)]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(io.bytes).toBe(size);
  });

  it('a missing file rejects and a later call works once it exists', async () => {
    await expect(fold(join(dir, 'nope.jsonl'))).rejects.toBeTruthy();
    writeFileSync(file, line({ a: 1 }));
    expect((await fold(file)).rows).toEqual([{ a: 1 }]);
  });

  it('separate keys fold the same file independently', async () => {
    writeFileSync(file, line({ a: 1 }));
    const count = await foldJsonl(file, 'count', () => ({ n: 0 }), (s) => { s.n += 1; });
    const rows = await fold(file);
    expect(count.n).toBe(1);
    expect(rows.rows).toEqual([{ a: 1 }]);
  });
});
