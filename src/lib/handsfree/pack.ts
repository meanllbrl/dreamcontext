/**
 * Transport 2 pack: our own framing, STREAM in and STREAM out (never one buffer: the
 * forwarder caps request bodies below 32 MB, so wave 2 chunks the stream for upload).
 *
 *   gzip( MAGIC
 *         { [u32 BE headerLen ≤ 64 KiB][header JSON][size bytes] }*   (delete, file, symlink)
 *         [u32][{"type":"end","count":n}] )
 *
 * header = {path,type,size,mode,mtimeMs,linkTarget?,sha256}; a `delete` record carries
 * only {type,path}. Deletions come first (case-only renames), symlinks last. The
 * decompressed size is capped while reading, so a gzip bomb dies at the cap.
 *
 * Pure fs + stream: no server imports, no module state, no uid assumption.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { once } from 'node:events';
import { join } from 'node:path';
import { createGunzip, createGzip } from 'node:zlib';
import { finished } from 'node:stream/promises';
import { checkRelPath } from './paths.js';
import { validateEntry, type ManifestEntry } from './manifest.js';

export const PACK_MAGIC = Buffer.from('DCHFPK1\n');
export const MAX_HEADER_BYTES = 64 * 1024;

export class PackFormatError extends Error {
  constructor(message: string) {
    super(`pack: ${message}`);
    this.name = 'PackFormatError';
  }
}

export class PackSourceChangedError extends Error {
  constructor(readonly path: string) {
    super(`pack: ${path} changed while it was being packed; re-run the manifest`);
    this.name = 'PackSourceChangedError';
  }
}

export type PackRecord =
  | { kind: 'delete'; path: string }
  | { kind: 'file' | 'symlink'; entry: ManifestEntry; body: AsyncIterable<Buffer> };

async function writeChunk(w: NodeJS.WritableStream, buf: Buffer): Promise<void> {
  if (!w.write(buf)) await once(w as unknown as NodeJS.EventEmitter, 'drain');
}

function frame(header: object): Buffer {
  const json = Buffer.from(JSON.stringify(header));
  if (json.length > MAX_HEADER_BYTES) throw new PackFormatError('header too large');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(json.length);
  return Buffer.concat([len, json]);
}

/**
 * Write a pack of `entries` (read from `root`, verified against their manifest size and
 * sha256 while streaming) plus `deletions` to `out`. `end: false` leaves `out` open (a
 * worker's stdout). Resolves once every byte has been flushed into `out`.
 */
export async function writePack(
  out: NodeJS.WritableStream,
  o: { root: string; entries: Iterable<ManifestEntry>; deletions?: Iterable<string>; end?: boolean },
): Promise<{ files: number; bytes: number }> {
  const gz = createGzip();
  gz.pipe(out as NodeJS.WritableStream, { end: o.end !== false });
  gz.on('error', () => { /* surfaced through `flushed` or the thrown error */ });
  const flushed = o.end === false ? finished(gz) : finished(out as unknown as NodeJS.WritableStream);
  flushed.catch(() => { /* awaited below on success */ });
  let files = 0;
  let bytes = 0;
  try {
    await writeChunk(gz, PACK_MAGIC);
    for (const p of o.deletions ?? []) {
      const c = checkRelPath(p);
      if (!c.ok) throw new PackFormatError(`refused deletion path ${JSON.stringify(p)} (${c.reason})`);
      await writeChunk(gz, frame({ type: 'delete', path: p }));
    }
    const ordered = [...o.entries].sort((a, b) => (a.type === b.type ? 0 : a.type === 'file' ? -1 : 1));
    for (const e of ordered) {
      validateEntry(e);
      await writeChunk(gz, frame({
        path: e.path, type: e.type, size: e.size, mode: e.mode, mtimeMs: e.mtimeMs, sha256: e.sha256,
        ...(e.type === 'symlink' ? { linkTarget: e.linkTarget } : {}),
      }));
      files++;
      if (e.type === 'symlink') continue;
      const h = createHash('sha256');
      let n = 0;
      if (e.size > 0) {
        const rs = createReadStream(join(o.root, ...e.path.split('/')), { start: 0, end: e.size - 1 });
        for await (const chunk of rs) {
          const b = chunk as Buffer;
          n += b.length;
          h.update(b);
          await writeChunk(gz, b);
        }
      }
      if (n !== e.size || h.digest('hex') !== e.sha256) throw new PackSourceChangedError(e.path);
      bytes += n;
    }
    await writeChunk(gz, frame({ type: 'end', count: files }));
    gz.end();
    await flushed;
  } catch (err) {
    gz.unpipe();
    gz.destroy();
    if (o.end !== false) (out as NodeJS.WritableStream & { destroy?: () => void }).destroy?.();
    throw err;
  }
  return { files, bytes };
}

interface PackBody extends AsyncIterable<Buffer> { drain(): Promise<void> }

class ByteReader {
  private buf: Buffer = Buffer.alloc(0);
  private total = 0;
  constructor(private readonly it: AsyncIterator<Buffer>, private readonly max: number) {}

  private async fill(): Promise<boolean> {
    const r = await this.it.next();
    if (r.done) return false;
    const chunk = r.value as Buffer;
    this.total += chunk.length;
    if (this.total > this.max) throw new PackFormatError(`decompressed size exceeds the cap of ${this.max} bytes`);
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    return true;
  }

  async readExact(n: number): Promise<Buffer> {
    while (this.buf.length < n) if (!(await this.fill())) throw new PackFormatError('truncated');
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  /**
   * A body of exactly `n` bytes. The remaining count lives outside any one iterator, so a
   * consumer that stops early (break, throw) leaves the rest for {@link PackBody.drain}.
   */
  body(n: number): PackBody {
    let left = n;
    const next = async (): Promise<IteratorResult<Buffer>> => {
      if (left === 0) return { done: true, value: undefined };
      if (this.buf.length === 0 && !(await this.fill())) throw new PackFormatError('truncated body');
      const take = Math.min(left, this.buf.length);
      const out = this.buf.subarray(0, take);
      this.buf = this.buf.subarray(take);
      left -= take;
      return { done: false, value: out };
    };
    return {
      [Symbol.asyncIterator]: () => ({ next, return: async () => ({ done: true, value: undefined }) }),
      drain: async () => { while (!(await next()).done) { /* skip */ } },
    };
  }

  async atEnd(): Promise<boolean> {
    while (this.buf.length === 0) if (!(await this.fill())) return true;
    return false;
  }
}

/**
 * Read a pack from `input`, calling `onRecord` for each record IN ORDER. A file record's
 * `body` streams exactly `size` bytes; whatever the callback leaves unread is drained.
 * Headers are validated (shared path guard, sizes, sha256 shape); deletions after a
 * file/symlink, a missing `end`, a bad count or trailing bytes are format errors.
 */
export async function readPack(
  input: NodeJS.ReadableStream,
  onRecord: (rec: PackRecord) => Promise<void>,
  /** `maxBytes` (decompressed cap, the trip estimate) is REQUIRED: there is no default. */
  o: { maxBytes: number; maxEntries?: number },
): Promise<{ files: number; deletions: number }> {
  if (!Number.isSafeInteger(o.maxBytes) || o.maxBytes <= 0) throw new PackFormatError('maxBytes (the trip estimate) is required');
  const max = o.maxBytes;
  const maxEntries = o.maxEntries ?? 1_000_000;
  const gunzip = createGunzip();
  input.on('error', (e: Error) => gunzip.destroy(e));
  input.pipe(gunzip);
  const r = new ByteReader(gunzip[Symbol.asyncIterator]() as AsyncIterator<Buffer>, max);
  let files = 0;
  let deletions = 0;
  let seenEntry = false;
  try {
    const magic = await r.readExact(PACK_MAGIC.length);
    if (!magic.equals(PACK_MAGIC)) throw new PackFormatError('bad magic');
    for (;;) {
      const len = (await r.readExact(4)).readUInt32BE(0);
      if (len === 0 || len > MAX_HEADER_BYTES) throw new PackFormatError(`header length ${len} out of range`);
      let h: Record<string, unknown>;
      try {
        h = JSON.parse((await r.readExact(len)).toString('utf8'));
      } catch {
        throw new PackFormatError('header is not JSON');
      }
      if (!h || typeof h !== 'object') throw new PackFormatError('header is not an object');
      if (h.type === 'end') {
        if (h.count !== files) throw new PackFormatError(`count mismatch (${String(h.count)} vs ${files})`);
        if (!(await r.atEnd())) throw new PackFormatError('trailing bytes after end');
        return { files, deletions };
      }
      if (files + deletions >= maxEntries) throw new PackFormatError('too many entries');
      if (h.type === 'delete') {
        if (seenEntry) throw new PackFormatError('deletion after a file record');
        const c = checkRelPath(h.path);
        if (!c.ok) throw new PackFormatError(`refused path ${JSON.stringify(h.path)} (${c.reason})`);
        deletions++;
        await onRecord({ kind: 'delete', path: c.path });
        continue;
      }
      let entry: ManifestEntry;
      try {
        entry = validateEntry(h, max);
      } catch (err) {
        throw new PackFormatError((err as Error).message);
      }
      seenEntry = true;
      files++;
      const bodyLen = entry.type === 'file' ? entry.size : 0;
      const body = r.body(bodyLen);
      await onRecord({ kind: entry.type, entry, body });
      await body.drain(); // whatever the consumer did not read
    }
  } finally {
    gunzip.destroy();
    (input as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
  }
}
