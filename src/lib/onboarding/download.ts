import { createHash, randomBytes } from 'node:crypto';
import { closeSync, lstatSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * Verified downloads for onboarding fixes (the GitHub command line tool archive, the
 * Claude installer script). Every hop is https (a validated 127.0.0.1 test seam aside),
 * the body is size-capped while it streams, the SHA-256 is checked when one is pinned,
 * and the file only appears at `dest` once it has passed: a temp file opened `wx` is
 * renamed into place, and removed on any failure.
 */

export type DownloadFailure = 'offline' | 'checksum' | 'refused' | 'failed';

export class DownloadError extends Error {
  constructor(readonly reason: DownloadFailure, message: string) {
    super(message);
    this.name = 'DownloadError';
  }
}

export interface DownloadOptions {
  /** Lowercase hex SHA-256 the body must match. Omit only for unpinned text (an installer script). */
  sha256?: string;
  /** Hard cap on the body size; a larger body is refused mid-stream. */
  maxBytes: number;
  /** Final path. Its folder must exist and must not be a symlink. */
  dest: string;
  onProgress?: (received: number, total: number | null) => void;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** Accept plain http on 127.0.0.1 (the verify seam). Only set for a URL that came from `resolveTestSeamUrl`. */
  allowLoopback?: boolean;
}

const MAX_REDIRECTS = 5;

/** https, or (seam only) plain http on 127.0.0.1 without credentials. Decided by `new URL()`. */
export function isAllowedDownloadUrl(raw: string, allowLoopback = false): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  return allowLoopback && url.protocol === 'http:' && url.hostname === '127.0.0.1';
}

/**
 * GET `url`, following at most {@link MAX_REDIRECTS} redirects by hand so every hop is
 * checked with {@link isAllowedDownloadUrl}: an https URL that redirects to http is refused.
 */
export async function fetchWithSafeRedirects(
  url: string,
  o: { fetchImpl?: typeof fetch; signal?: AbortSignal; allowLoopback?: boolean } = {},
): Promise<Response> {
  const fetchImpl = o.fetchImpl ?? globalThis.fetch;
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isAllowedDownloadUrl(current, o.allowLoopback)) {
      throw new DownloadError('refused', `Refused a download that is not https: ${current}`);
    }
    let res: Response;
    try {
      res = await fetchImpl(current, { redirect: 'manual', signal: o.signal });
    } catch (err) {
      if (o.signal?.aborted) throw new DownloadError('failed', 'Canceled.');
      throw new DownloadError('offline', `Could not reach ${new URL(current).host}: ${(err as Error).message}`);
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new DownloadError('failed', `Redirect without a location from ${current}`);
      current = new URL(location, current).toString();
      continue;
    }
    if (!res.ok) throw new DownloadError('failed', `Download failed (${res.status}) from ${current}`);
    return res;
  }
  throw new DownloadError('refused', 'Too many redirects.');
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function unlinkQuietly(path: string): void {
  try { unlinkSync(path); } catch { /* already gone */ }
}

/**
 * Download `url` to `dest`, streaming, capped at `maxBytes`, SHA-256 checked when
 * pinned. Throws {@link DownloadError}; on any failure no file is left at `dest` or in
 * its temp slot.
 */
export async function downloadVerified(
  url: string,
  o: DownloadOptions,
): Promise<{ bytes: number; sha256: string }> {
  const folder = dirname(o.dest);
  if (isSymlink(folder) || isSymlink(o.dest)) {
    throw new DownloadError('refused', `Refusing to write through a symlink: ${o.dest}`);
  }
  const res = await fetchWithSafeRedirects(url, o);
  const declared = Number(res.headers.get('content-length') ?? '');
  const total = Number.isFinite(declared) && declared > 0 ? declared : null;
  if (total !== null && total > o.maxBytes) {
    throw new DownloadError('refused', `The download is larger than expected (${total} bytes).`);
  }
  if (!res.body) throw new DownloadError('failed', 'The download had no body.');

  const temp = join(folder, `.${basename(o.dest)}.${process.pid}.${randomBytes(6).toString('hex')}.part`);
  const fd = openSync(temp, 'wx', 0o600);
  const hash = createHash('sha256');
  let received = 0;
  let closed = false;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > o.maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new DownloadError('refused', `The download is larger than expected (over ${o.maxBytes} bytes).`);
      }
      hash.update(value);
      writeSync(fd, value);
      o.onProgress?.(received, total);
    }
    closeSync(fd);
    closed = true;
    const digest = hash.digest('hex');
    if (o.sha256 && digest !== o.sha256.toLowerCase()) {
      throw new DownloadError('checksum', 'The download did not match its expected checksum.');
    }
    renameSync(temp, o.dest);
    return { bytes: received, sha256: digest };
  } catch (err) {
    if (!closed) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
    unlinkQuietly(temp);
    if (err instanceof DownloadError) throw err;
    if (o.signal?.aborted) throw new DownloadError('failed', 'Canceled.');
    throw new DownloadError('failed', `Download interrupted: ${(err as Error).message}`);
  }
}
