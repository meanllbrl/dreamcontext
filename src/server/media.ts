import { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';

/**
 * Media types this server will stream. Kept separate from the static server's
 * MIME table because these are the extensions that MUST be range-served: a
 * `<video>`/`<audio>` element seeks by issuing Range requests, so the answer to
 * "is this streamable media?" and "what byte-range behaviour does it need?" are
 * the same question.
 */
export const MEDIA_MIME_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
};

/** The content type for a streamable media extension, or null if it isn't one. */
export function mediaContentType(ext: string): string | null {
  return MEDIA_MIME_TYPES[ext.toLowerCase()] ?? null;
}

/**
 * Stream `abs` with byte-range support. `<video>`/`<audio>` seek by issuing Range
 * requests, and a server that answers 200-with-everything makes a clip unseekable
 * — Safari (and therefore the desktop app's WKWebView) refuses to play it at all
 * — so `Accept-Ranges` and a correct 206 are load-bearing here, not an
 * optimisation. Streaming also keeps a 40MB capture off the heap.
 *
 * `cacheControl` differs by caller: agent files are `no-store` (a user's working
 * tree changes under them), announcement clips are `no-cache` (authored between
 * releases, same URL, new bytes — see `cacheControlFor`).
 */
export function serveMedia(
  req: IncomingMessage,
  res: ServerResponse,
  abs: string,
  size: number,
  contentType: string,
  cacheControl = 'no-store',
): void {
  const common = { 'Content-Type': contentType, 'Accept-Ranges': 'bytes', 'Cache-Control': cacheControl };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');

  let start = 0;
  let end = size - 1;
  if (range) {
    const [, rawStart, rawEnd] = range;
    // `bytes=-` names neither a start nor an end: unsatisfiable by definition.
    if (rawStart === '' && rawEnd === '') {
      res.writeHead(416, { ...common, 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
    if (rawStart === '') {
      // `bytes=-N` — the trailing N bytes.
      start = Math.max(0, size - Number(rawEnd));
    } else {
      start = Number(rawStart);
      if (rawEnd !== '') end = Math.min(end, Number(rawEnd));
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
      res.writeHead(416, { ...common, 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
  }

  const length = end - start + 1;
  res.writeHead(range ? 206 : 200, {
    ...common,
    'Content-Length': length,
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
  });
  if (req.method === 'HEAD') { res.end(); return; }

  const stream = createReadStream(abs, { start, end });
  stream.on('error', () => { res.destroy(); });
  // A viewer that seeks away (or a closed pane) aborts the response — release the
  // fd rather than reading the rest of a large file into a socket nobody is
  // listening to.
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}
