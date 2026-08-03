/**
 * Unit tests for the `?raw=1` arm of `GET /api/graph/content` — the vault-scoped byte reader
 * behind a PDF a knowledge note links to.
 *
 * The point of the arm is that the Knowledge page is NOT desktop-only: `/api/agent/file` is
 * gated on the desktop app, so routing a vault file through it would answer "desktop only" to
 * a browser dashboard reading its own vault. So these tests pin the two things that make the
 * arm safe rather than merely convenient — containment is unchanged, and the type the engine
 * is told is ours and non-sniffable — plus the range support the built-in PDF viewer needs to
 * page a large document in.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleGraphContentGet } from '../../src/server/routes/graph.js';

/** A ServerResponse on a real PassThrough — the raw arm STREAMS (`createReadStream().pipe`),
 *  which a plain object stub cannot stand in for. */
function makeRes(): {
  res: ServerResponse;
  status: () => number;
  header: (name: string) => string | number | undefined;
  raw: () => Buffer | undefined;
  body: () => any;
  done: () => Promise<void>;
} {
  let statusCode = 0;
  let headers: Record<string, string | number> = {};
  const chunks: Buffer[] = [];
  const sink = new PassThrough();
  sink.on('data', (c: Buffer) => { chunks.push(Buffer.from(c)); });
  const finished = new Promise<void>((resolve) => {
    sink.on('finish', () => resolve());
    sink.on('close', () => resolve());
  });
  const res = Object.assign(sink, {
    setHeader(name: string, value: string) { headers[name] = value; },
    writeHead(code: number, hdrs?: Record<string, string | number>) {
      statusCode = code;
      headers = { ...headers, ...(hdrs ?? {}) };
      return res;
    },
  }) as unknown as ServerResponse;
  const raw = (): Buffer | undefined => (chunks.length ? Buffer.concat(chunks) : undefined);
  return {
    res,
    status: () => statusCode,
    header: (name: string) => headers[name],
    raw,
    body: () => {
      const buf = raw();
      if (buf === undefined) return undefined;
      try { return JSON.parse(buf.toString('utf-8')); } catch { return buf; }
    },
    done: () => finished,
  };
}

function makeReq(url: string, headers: Record<string, string> = {}): IncomingMessage {
  return { url, headers } as unknown as IncomingMessage;
}

const PDF_BYTES = '%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n';

let contextRoot: string;

beforeEach(() => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  contextRoot = join(tmpdir(), `dc-graph-raw-${stamp}`, '_dream_context');
  mkdirSync(join(contextRoot, 'knowledge', 'legal', 'assets'), { recursive: true });
  writeFileSync(join(contextRoot, 'knowledge', 'legal', 'assets', 'msa.pdf'), PDF_BYTES, 'utf-8');
  writeFileSync(join(contextRoot, 'knowledge', 'legal', 'contracts.md'), '# Contracts\n', 'utf-8');
  writeFileSync(join(contextRoot, 'notes.txt'), 'plain\n', 'utf-8');
});

afterEach(() => {
  rmSync(join(contextRoot, '..'), { recursive: true, force: true });
});

describe('graph/content — raw PDF', () => {
  it('serves the bytes as application/pdf, seekable and inline', async () => {
    const { res, status, header, raw, done } = makeRes();
    await handleGraphContentGet(
      makeReq('/api/graph/content?path=knowledge/legal/assets/msa.pdf&raw=1'), res, {}, contextRoot,
    );
    await done();
    expect(status()).toBe(200);
    expect(header('Content-Type')).toBe('application/pdf');
    // Ranges are what let the engine's viewer page a large document in rather than stall.
    expect(header('Accept-Ranges')).toBe('bytes');
    // Displayed, never downloaded — an engine without a viewer would otherwise save it.
    expect(header('Content-Disposition')).toBe('inline');
    // The type is asserted by us from the extension; the engine may not second-guess it.
    expect(header('X-Content-Type-Options')).toBe('nosniff');
    expect(raw()?.toString('utf-8')).toBe(PDF_BYTES);
  });

  it('answers a byte range with 206 and only those bytes', async () => {
    const { res, status, header, raw, done } = makeRes();
    await handleGraphContentGet(
      makeReq('/api/graph/content?path=knowledge/legal/assets/msa.pdf&raw=1', { range: 'bytes=0-3' }),
      res, {}, contextRoot,
    );
    await done();
    expect(status()).toBe(206);
    expect(header('Content-Range')).toBe(`bytes 0-3/${PDF_BYTES.length}`);
    expect(raw()?.toString('utf-8')).toBe('%PDF');
  });

  it('still answers the JSON preview without raw=1, so no existing caller changes', async () => {
    const { res, status, body } = makeRes();
    await handleGraphContentGet(
      makeReq('/api/graph/content?path=knowledge/legal/contracts.md'), res, {}, contextRoot,
    );
    expect(status()).toBe(200);
    expect(body().type).toBe('markdown');
  });

  // raw=1 is an OPT-IN on an allowlisted type, not a mode switch: a type not in the map falls
  // through to exactly the answer it gave before, so nothing starts streaming by surprise.
  it('ignores raw=1 for a type not on the allowlist', async () => {
    const { res, status, body } = makeRes();
    await handleGraphContentGet(makeReq('/api/graph/content?path=notes.txt&raw=1'), res, {}, contextRoot);
    expect(status()).toBe(200);
    expect(body().type).toBe('text');
    expect(body().content).toBe('plain\n');
  });

  // The containment rule is the route's own and predates this arm — but a byte-serving arm is
  // exactly where a regression would be worth the most, so it is pinned here too.
  it('refuses a path that escapes the vault, raw or not', async () => {
    for (const url of [
      '/api/graph/content?path=' + encodeURIComponent('../../../etc/passwd') + '&raw=1',
      '/api/graph/content?path=' + encodeURIComponent('../secret.pdf') + '&raw=1',
    ]) {
      const { res, status, body } = makeRes();
      await handleGraphContentGet(makeReq(url), res, {}, contextRoot);
      expect(status()).toBe(400);
      expect(body().error).toBe('invalid_path');
    }
  });

  it('404s a PDF that is not there', async () => {
    const { res, status, body } = makeRes();
    await handleGraphContentGet(
      makeReq('/api/graph/content?path=knowledge/legal/assets/gone.pdf&raw=1'), res, {}, contextRoot,
    );
    expect(status()).toBe(404);
    expect(body().error).toBe('not_found');
  });
});
