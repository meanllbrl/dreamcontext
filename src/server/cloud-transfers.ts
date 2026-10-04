import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync, createReadStream, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync,
  renameSync, rmSync, statSync, writeFileSync, writeSync,
} from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';

/**
 * Uploads and downloads of the transfer channel. GitHub's forwarder refuses request bodies of
 * 32 MB and more (W0), so every bundle, pack and tarball travels in chunks of at most 8 MiB:
 * `PUT upload/<id>/<n>` in order, then `POST upload/<id>/commit {size, sha256}`. A committed
 * upload is consumed by exactly ONE later call; anything older than 24 h is swept. Downloads
 * are files the cloud produced for a `snapshot`, read by offset/length and kept until `seal`.
 *
 * Everything lives in the 0700 dcserver dir: dcuser never sees an upload until dcserver pipes
 * it into a worker's stdin.
 */

export const CHUNK_MAX = 8 * 1024 * 1024;
export const UPLOAD_TTL_MS = 24 * 60 * 60_000;
export const TRANSFER_ID_RE = /^[a-z0-9-]{8,64}$/;
/** An upload may not grow past this (the trip estimate is the real bound; this stops a runaway). */
export const UPLOAD_MAX_BYTES = 64 * 1024 * 1024 * 1024;

export class TransferError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'TransferError';
  }
}

interface UploadMeta {
  chunks: number;
  size: number;
  createdAt: number;
  committed: boolean;
  sha256?: string;
  /** The last chunk appended, so a retried PUT of it (lost reply) is recognised. */
  lastChunk?: { size: number; sha256: string };
}

/** Read a raw request body into a buffer, refusing more than `max` bytes. */
export function readRawBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const parts: Buffer[] = [];
    let n = 0;
    let failed = false;
    req.on('data', (c: Buffer) => {
      if (failed) return;
      n += c.length;
      if (n > max) {
        failed = true;
        reject(new TransferError(413, 'too_large', `A chunk is at most ${max} bytes.`));
        req.resume();
        return;
      }
      parts.push(c);
    });
    req.on('end', () => { if (!failed) resolvePromise(Buffer.concat(parts)); });
    req.on('error', (e) => { if (!failed) { failed = true; reject(e); } });
  });
}

export class TransferStore {
  readonly uploadsDir: string;
  readonly downloadsDir: string;
  private readonly now: () => number;

  constructor(opts: { dir: string; now?: () => number }) {
    this.uploadsDir = join(opts.dir, 'uploads');
    this.downloadsDir = join(opts.dir, 'downloads');
    this.now = opts.now ?? Date.now;
    mkdirSync(this.uploadsDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.downloadsDir, { recursive: true, mode: 0o700 });
  }

  static assertId(id: unknown): string {
    if (typeof id !== 'string' || !TRANSFER_ID_RE.test(id)) throw new TransferError(400, 'bad_id', 'Transfer ids are [a-z0-9-]{8,64}.');
    return id;
  }

  private dataPath(id: string): string { return join(this.uploadsDir, `${id}.bin`); }
  private metaPath(id: string): string { return join(this.uploadsDir, `${id}.json`); }

  private readMeta(id: string): UploadMeta | null {
    try {
      const m = JSON.parse(readFileSync(this.metaPath(id), 'utf-8')) as UploadMeta;
      return typeof m.chunks === 'number' && typeof m.size === 'number' ? m : null;
    } catch {
      return null;
    }
  }

  private writeMeta(id: string, m: UploadMeta): void {
    const tmp = `${this.metaPath(id)}.tmp`;
    writeFileSync(tmp, JSON.stringify(m), { mode: 0o600 });
    renameSync(tmp, this.metaPath(id));
  }

  /**
   * Append chunk `n`. Chunks arrive strictly in order; a retried chunk (the reply was lost)
   * that equals the last one stored is accepted again without appending.
   */
  putChunk(idRaw: string, nRaw: string, body: Buffer): { chunks: number; size: number } {
    const id = TransferStore.assertId(idRaw);
    if (!/^\d{1,7}$/.test(nRaw)) throw new TransferError(400, 'bad_chunk', 'Chunk index must be a number.');
    const n = Number(nRaw);
    if (body.length > CHUNK_MAX) throw new TransferError(413, 'too_large', `A chunk is at most ${CHUNK_MAX} bytes.`);
    let meta = this.readMeta(id);
    if (meta?.committed) throw new TransferError(409, 'upload_committed', 'This upload was already committed.');
    if (!meta) {
      if (n !== 0) throw new TransferError(409, 'out_of_order', 'Upload chunks start at 0.');
      meta = { chunks: 0, size: 0, createdAt: this.now(), committed: false };
      writeFileSync(this.dataPath(id), Buffer.alloc(0), { mode: 0o600 });
    }
    const last = meta.lastChunk;
    if (n === meta.chunks - 1 && last && last.size === body.length && last.sha256 === sha256(body)) {
      return { chunks: meta.chunks, size: meta.size };
    }
    if (n !== meta.chunks) throw new TransferError(409, 'out_of_order', `Expected chunk ${meta.chunks}.`);
    if (meta.size + body.length > UPLOAD_MAX_BYTES) throw new TransferError(413, 'too_large', 'Upload too large.');
    const fd = openSync(this.dataPath(id), 'a', 0o600);
    try {
      let off = 0;
      while (off < body.length) off += writeSync(fd, body, off, body.length - off);
    } finally {
      closeSync(fd);
    }
    const next = { ...meta, chunks: meta.chunks + 1, size: meta.size + body.length, lastChunk: { size: body.length, sha256: sha256(body) } };
    this.writeMeta(id, next);
    return { chunks: next.chunks, size: next.size };
  }

  /** Verify the assembled file; a mismatch discards the upload (the laptop re-sends it). */
  async commit(idRaw: string, body: unknown): Promise<void> {
    const id = TransferStore.assertId(idRaw);
    const b = body as { size?: unknown; sha256?: unknown } | null;
    if (!b || !Number.isSafeInteger(b.size) || typeof b.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(b.sha256)) {
      throw new TransferError(400, 'bad_request', 'commit needs {size, sha256}.');
    }
    const meta = this.readMeta(id);
    if (!meta) throw new TransferError(404, 'no_upload', 'No such upload.');
    if (meta.committed) {
      if (meta.size === b.size && meta.sha256 === b.sha256) return;
      throw new TransferError(409, 'upload_mismatch', 'The upload does not match.');
    }
    const got = await sha256File(this.dataPath(id));
    if (meta.size !== b.size || got !== b.sha256) {
      this.discard(id);
      throw new TransferError(409, 'upload_mismatch', 'The assembled upload does not match its size and sha256.');
    }
    this.writeMeta(id, { ...meta, committed: true, sha256: got });
  }

  /**
   * Take a committed upload for exactly one consumer: returns its path (now owned by the
   * caller, who removes it) and forgets the upload.
   */
  consume(idRaw: unknown): { path: string; size: number; sha256: string } {
    const id = TransferStore.assertId(idRaw);
    const meta = this.readMeta(id);
    if (!meta || !meta.committed) throw new TransferError(409, 'upload_not_committed', 'That upload is missing or not committed.');
    const taken = join(this.uploadsDir, `${id}.taken-${randomBytes(4).toString('hex')}`);
    renameSync(this.dataPath(id), taken);
    rmSync(this.metaPath(id), { force: true });
    return { path: taken, size: meta.size, sha256: meta.sha256 ?? '' };
  }

  discard(id: string): void {
    rmSync(this.dataPath(id), { force: true });
    rmSync(this.metaPath(id), { force: true });
  }

  /** Remove uploads (and stray taken files) older than 24 h. */
  sweep(): number {
    let removed = 0;
    const cutoff = this.now() - UPLOAD_TTL_MS;
    for (const name of safeList(this.uploadsDir)) {
      const p = join(this.uploadsDir, name);
      try {
        if (statSync(p).mtimeMs < cutoff) { rmSync(p, { force: true }); removed++; }
      } catch { /* gone */ }
    }
    return removed;
  }

  // ── downloads ──

  newDownloadPath(): { id: string; path: string } {
    const id = `dl-${randomBytes(12).toString('hex')}`;
    return { id, path: join(this.downloadsDir, `${id}.bin`) };
  }

  describeDownload(id: string): { id: string; size: number; sha256: string } | null {
    const p = join(this.downloadsDir, `${id}.bin`);
    if (!existsSync(p)) return null;
    const meta = join(this.downloadsDir, `${id}.json`);
    try {
      const m = JSON.parse(readFileSync(meta, 'utf-8')) as { size: number; sha256: string };
      return { id, size: m.size, sha256: m.sha256 };
    } catch {
      return null;
    }
  }

  async finishDownload(id: string): Promise<{ id: string; size: number; sha256: string }> {
    const p = join(this.downloadsDir, `${id}.bin`);
    const size = statSync(p).size;
    const sha = await sha256File(p);
    writeFileSync(join(this.downloadsDir, `${id}.json`), JSON.stringify({ size, sha256: sha }), { mode: 0o600 });
    return { id, size, sha256: sha };
  }

  readDownload(idRaw: string, offsetRaw: string | null, lengthRaw: string | null): Buffer {
    const id = TransferStore.assertId(idRaw);
    const off = Number(offsetRaw ?? '0');
    const len = Number(lengthRaw ?? String(CHUNK_MAX));
    if (!Number.isSafeInteger(off) || off < 0 || !Number.isSafeInteger(len) || len < 1 || len > CHUNK_MAX) {
      throw new TransferError(400, 'bad_range', `offset >= 0 and 1 <= length <= ${CHUNK_MAX}.`);
    }
    const p = join(this.downloadsDir, `${id}.bin`);
    if (!existsSync(join(this.downloadsDir, `${id}.json`))) throw new TransferError(404, 'no_download', 'No such download.');
    const fd = openSync(p, 'r');
    try {
      const size = fstatSync(fd).size;
      if (off > size) throw new TransferError(416, 'bad_range', 'Offset past the end.');
      const want = Math.min(len, size - off);
      const buf = Buffer.alloc(want);
      let got = 0;
      while (got < want) {
        const r = readSync(fd, buf, got, want - got, off + got);
        if (r === 0) break;
        got += r;
      }
      return buf.subarray(0, got);
    } finally {
      closeSync(fd);
    }
  }

  /** Drop one download (a retried snapshot replaces its predecessor's). */
  deleteDownload(id: string): void {
    if (!TRANSFER_ID_RE.test(id)) return;
    rmSync(join(this.downloadsDir, `${id}.bin`), { force: true });
    rmSync(join(this.downloadsDir, `${id}.json`), { force: true });
  }

  /** Seal drops every download. */
  clearDownloads(): void {
    for (const name of safeList(this.downloadsDir)) rmSync(join(this.downloadsDir, name), { force: true });
  }
}

function safeList(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

function sha256(b: Buffer): string {
  return createHash('sha256').update(b).digest('hex');
}

export async function sha256File(p: string): Promise<string> {
  const h = createHash('sha256');
  for await (const c of createReadStream(p)) h.update(c as Buffer);
  return h.digest('hex');
}
