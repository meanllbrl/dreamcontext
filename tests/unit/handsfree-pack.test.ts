// Hands-free pack framing: stream round trip through a FILE, ordering, and every format
// refusal (header cap, decompressed cap, truncation, bad paths, tampered counts).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, createReadStream, createWriteStream, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { buildManifest, walk } from '../../src/lib/handsfree/manifest.js';
import {
  PACK_MAGIC, PackFormatError, PackSourceChangedError, readPack, writePack, type PackRecord,
} from '../../src/lib/handsfree/pack.js';

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'hf-pack-')); });
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

async function collect(input: NodeJS.ReadableStream, o?: { maxBytes?: number }) {
  const recs: Array<{ kind: string; path: string; bytes?: Buffer }> = [];
  await readPack(input, async (r: PackRecord) => {
    if (r.kind === 'delete') { recs.push({ kind: 'delete', path: r.path }); return; }
    const parts: Buffer[] = [];
    for await (const c of r.body) parts.push(c);
    recs.push({ kind: r.kind, path: r.entry.path, bytes: Buffer.concat(parts) });
  }, { maxBytes: 1 << 30, ...o });
  return recs;
}

function frame(h: object): Buffer {
  const j = Buffer.from(JSON.stringify(h));
  const l = Buffer.alloc(4);
  l.writeUInt32BE(j.length);
  return Buffer.concat([l, j]);
}
const raw = (...parts: Buffer[]) => Readable.from([gzipSync(Buffer.concat([PACK_MAGIC, ...parts]))]);
const SHA0 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'; // sha256('')

describe('writePack → file → readPack', () => {
  it('round-trips files, an exec bit, an empty file, a binary blob, a symlink and deletions, in order', async () => {
    const root = join(tmp, 'src');
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(join(root, 'a.txt'), 'hello');
    writeFileSync(join(root, 'empty'), '');
    writeFileSync(join(root, 'bin', 'run.sh'), '#!/bin/sh\n');
    chmodSync(join(root, 'bin', 'run.sh'), 0o755);
    const blob = randomBytes(3 * 1024 * 1024 + 7);
    writeFileSync(join(root, 'big.bin'), blob);
    symlinkSync('a.txt', join(root, 'link'));
    const m = await buildManifest(root, walk(root, [''], { side: 'laptop' }).entries);
    const packPath = join(tmp, 'p.pack');
    const res = await writePack(createWriteStream(packPath), { root, entries: m.values(), deletions: ['gone.txt', 'old/Dir.md'] });
    expect(res.files).toBe(5);
    const recs = await collect(createReadStream(packPath));
    expect(recs.map((r) => `${r.kind}:${r.path}`)).toEqual([
      'delete:gone.txt', 'delete:old/Dir.md',
      'file:a.txt', 'file:big.bin', 'file:bin/run.sh', 'file:empty',
      'symlink:link',
    ]);
    expect(recs.find((r) => r.path === 'big.bin')!.bytes!.equals(blob)).toBe(true);
    expect(recs.find((r) => r.path === 'empty')!.bytes!.length).toBe(0);
  });

  it('a consumer that skips a body still gets every later record (drain)', async () => {
    const root = join(tmp, 'src');
    mkdirSync(root);
    writeFileSync(join(root, 'a'), 'x'.repeat(200_000));
    writeFileSync(join(root, 'b'), 'y');
    const m = await buildManifest(root, walk(root, [''], { side: 'laptop' }).entries);
    const packPath = join(tmp, 'p.pack');
    await writePack(createWriteStream(packPath), { root, entries: m.values() });
    const seen: string[] = [];
    await readPack(createReadStream(packPath), async (r) => {
      if (r.kind === 'delete') return;
      seen.push(r.entry.path);
      if (r.entry.path === 'a') for await (const _ of r.body) break; // read one chunk, stop
    }, { maxBytes: 1 << 30 });
    expect(seen).toEqual(['a', 'b']);
  });

  it('a file that changes while packing aborts with PackSourceChangedError', async () => {
    const root = join(tmp, 'src');
    mkdirSync(root);
    writeFileSync(join(root, 'a'), 'one');
    const m = await buildManifest(root, walk(root, [''], { side: 'laptop' }).entries);
    writeFileSync(join(root, 'a'), 'two');
    await expect(writePack(createWriteStream(join(tmp, 'p.pack')), { root, entries: m.values() })).rejects.toBeInstanceOf(PackSourceChangedError);
  });
});

describe('readPack refusals', () => {
  it('bad magic', async () => {
    await expect(collect(Readable.from([gzipSync(Buffer.from('NOTAPACK'))]))).rejects.toThrow(/magic/);
  });

  it('header over 64 KiB', async () => {
    const l = Buffer.alloc(4);
    l.writeUInt32BE(64 * 1024 + 1);
    await expect(collect(raw(l))).rejects.toBeInstanceOf(PackFormatError);
  });

  it('decompressed size over the cap (gzip bomb)', async () => {
    // Each entry is under the cap; together they exceed it.
    const part = Buffer.alloc(512 * 1024);
    const recs: Buffer[] = [];
    for (let i = 0; i < 3; i++) recs.push(frame({ path: `z${i}`, type: 'file', size: part.length, mode: 0o644, mtimeMs: 0, sha256: SHA0 }), part);
    await expect(collect(raw(...recs), { maxBytes: 1024 * 1024 })).rejects.toThrow(/cap/);
    // A single header claiming more than the cap is refused before any body is read.
    const h = frame({ path: 'z', type: 'file', size: 5 * 1024 * 1024, mode: 0o644, mtimeMs: 0, sha256: SHA0 });
    await expect(collect(raw(h), { maxBytes: 1024 * 1024 })).rejects.toThrow(/size/);
  });

  it('truncated stream / missing end record', async () => {
    const h = frame({ path: 'a', type: 'file', size: 10, mode: 0o644, mtimeMs: 0, sha256: SHA0 });
    await expect(collect(raw(h, Buffer.from('abc')))).rejects.toThrow(/truncated/);
    await expect(collect(raw(frame({ type: 'delete', path: 'a' })))).rejects.toThrow(/truncated/);
  });

  it('guard-refused header paths', async () => {
    for (const p of ['../x', '/abs', 'a/.git/config', '.GIT/HEAD', 'a\\b']) {
      const h = frame({ path: p, type: 'file', size: 0, mode: 0o644, mtimeMs: 0, sha256: SHA0 });
      await expect(collect(raw(h, frame({ type: 'end', count: 1 })))).rejects.toThrow(/refused/);
      await expect(collect(raw(frame({ type: 'delete', path: p }), frame({ type: 'end', count: 0 })))).rejects.toThrow(/refused/);
    }
  });

  it('a deletion after a file record, a bad count and trailing bytes', async () => {
    const f = frame({ path: 'a', type: 'file', size: 0, mode: 0o644, mtimeMs: 0, sha256: SHA0 });
    await expect(collect(raw(f, frame({ type: 'delete', path: 'b' }), frame({ type: 'end', count: 1 })))).rejects.toThrow(/deletion after/);
    await expect(collect(raw(f, frame({ type: 'end', count: 2 })))).rejects.toThrow(/count/);
    await expect(collect(raw(f, frame({ type: 'end', count: 1 }), Buffer.from('junk')))).rejects.toThrow(/trailing/);
  });

  it('a symlink header whose hash does not match its target', async () => {
    const h = frame({ path: 'l', type: 'symlink', size: 1, mode: 0o120777, mtimeMs: 0, sha256: SHA0, linkTarget: 'x' });
    await expect(collect(raw(h, frame({ type: 'end', count: 1 })))).rejects.toThrow(/hash/);
  });
});
