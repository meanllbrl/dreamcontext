/**
 * Unit tests for `handleAgentFile` (`GET /api/agent/file`) — the Agent Chat redesign's
 * project-root-scoped file reader backing state 3's slide-over and state 4's lightbox
 * (task_nQb0y85X follow-up, T3). Exercises the desktop gate, the `safeChildPath`
 * traversal guard, text vs. image dispatch, the SVG-stays-text hardening, the size cap,
 * and that `X-Content-Type-Options: nosniff` rides every response.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleAgentFile } from '../../src/server/routes/agent-chat.js';

/**
 * A stand-in ServerResponse built on a real PassThrough, because media responses are now
 * STREAMED (`createReadStream(...).pipe(res)`) rather than buffered — a plain object stub
 * has no `pipe` target, no `on('close')` and no `destroy()`, so it can't stand in for the
 * raw-bytes path at all. `done()` awaits the stream finishing before the bytes are read.
 */
function makeRes(): {
  res: ServerResponse;
  status: () => number;
  header: (name: string) => string | number | undefined;
  raw: () => Buffer | string | undefined;
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

function makeReq(path: string): IncomingMessage {
  return { url: path, headers: {} } as unknown as IncomingMessage;
}

let projectRoot: string;
let contextRoot: string;

beforeEach(() => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  projectRoot = join(tmpdir(), `dc-agent-file-${stamp}`);
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(projectRoot, 'src'), { recursive: true });
  writeFileSync(join(projectRoot, 'src', 'hello.ts'), 'export const x = 1;\n', 'utf-8');
  writeFileSync(join(projectRoot, 'notes.md'), '# Notes\n\nSome text.\n', 'utf-8');
  writeFileSync(join(projectRoot, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'binary');
  writeFileSync(join(projectRoot, 'icon.svg'), '<svg><script>alert(1)</script></svg>', 'utf-8');
  writeFileSync(join(projectRoot, 'huge.txt'), 'x'.repeat(600 * 1024), 'utf-8');
  process.env.DREAMCONTEXT_DESKTOP = '1';
});

afterEach(() => {
  delete process.env.DREAMCONTEXT_DESKTOP;
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('handleAgentFile — desktop gate', () => {
  it('403s when not in the desktop app', async () => {
    delete process.env.DREAMCONTEXT_DESKTOP;
    const { res, status } = makeRes();
    await handleAgentFile(makeReq('/api/agent/file?path=src/hello.ts'), res, {}, contextRoot);
    expect(status()).toBe(403);
  });
});

describe('handleAgentFile — path handling', () => {
  it('400s missing_path when no path query param is given', async () => {
    const { res, status, body } = makeRes();
    await handleAgentFile(makeReq('/api/agent/file'), res, {}, contextRoot);
    expect(status()).toBe(400);
    expect(body().error).toBe('missing_path');
  });

  it('400s invalid_path on a traversal attempt that escapes the project root', async () => {
    const { res, status, body } = makeRes();
    await handleAgentFile(makeReq('/api/agent/file?path=' + encodeURIComponent('../../etc/passwd')), res, {}, contextRoot);
    expect(status()).toBe(400);
    expect(body().error).toBe('invalid_path');
  });

  // An absolute path outside the project is no longer a flat refusal: it is the prompt the
  // UI turns into an "Allow access" card. It is still NOT served — 403 with `needs_grant`,
  // never the file — and only an explicit `POST /agent/grant` on that exact path changes it.
  it('403s needs_grant on an ungranted absolute path — and serves nothing', async () => {
    const { res, status, body } = makeRes();
    await handleAgentFile(makeReq('/api/agent/file?path=' + encodeURIComponent('/etc/passwd')), res, {}, contextRoot);
    expect(status()).toBe(403);
    expect(body().error).toBe('needs_grant');
    expect(body().content).toBeUndefined();
  });

  it('400s invalid_path on an absolute path carrying traversal — never grantable', async () => {
    const { res, status, body } = makeRes();
    await handleAgentFile(makeReq('/api/agent/file?path=' + encodeURIComponent('/tmp/../etc/passwd')), res, {}, contextRoot);
    expect(status()).toBe(400);
    expect(body().error).toBe('invalid_path');
  });

  it('404s not_found for a path that does not exist under the project root', async () => {
    const { res, status, body } = makeRes();
    await handleAgentFile(makeReq('/api/agent/file?path=src/ghost.ts'), res, {}, contextRoot);
    expect(status()).toBe(404);
    expect(body().error).toBe('not_found');
  });

  it('413s too_large for a file over the 512KB cap', async () => {
    const { res, status, body } = makeRes();
    await handleAgentFile(makeReq('/api/agent/file?path=huge.txt'), res, {}, contextRoot);
    expect(status()).toBe(413);
    expect(body().error).toBe('too_large');
  });
});

describe('handleAgentFile — text dispatch', () => {
  it('returns a plain file as type:text with its content', async () => {
    const { res, status, body } = makeRes();
    await handleAgentFile(makeReq('/api/agent/file?path=' + encodeURIComponent('src/hello.ts')), res, {}, contextRoot);
    expect(status()).toBe(200);
    expect(body()).toEqual({ path: 'src/hello.ts', type: 'text', content: 'export const x = 1;\n' });
  });

  it('returns a .md file as type:markdown', async () => {
    const { res, status, body } = makeRes();
    await handleAgentFile(makeReq('/api/agent/file?path=notes.md'), res, {}, contextRoot);
    expect(status()).toBe(200);
    expect(body().type).toBe('markdown');
    expect(body().content).toContain('# Notes');
  });
});

describe('handleAgentFile — image bytes', () => {
  it('returns raw PNG bytes with an image/png content-type when raw=1', async () => {
    const { res, status, header, raw, done } = makeRes();
    await handleAgentFile(makeReq('/api/agent/file?path=image.png&raw=1'), res, {}, contextRoot);
    await done();
    expect(status()).toBe(200);
    expect(header('Content-Type')).toBe('image/png');
    expect(header('Accept-Ranges')).toBe('bytes'); // seekable — load-bearing for <video>
    expect(Buffer.isBuffer(raw())).toBe(true);
    expect((raw() as Buffer)[0]).toBe(0x89); // PNG magic byte, round-tripped verbatim
  });

  it('does NOT return an image content-type for a .png without raw=1 (falls through to text)', async () => {
    const { res, status, header } = makeRes();
    await handleAgentFile(makeReq('/api/agent/file?path=image.png'), res, {}, contextRoot);
    expect(status()).toBe(200);
    expect(header('Content-Type')).toBe('application/json');
  });
});

describe('handleAgentFile — SVG is served as text only, never as an executable image type', () => {
  it('SVG with raw=1 still returns type:text JSON, never image/svg+xml', async () => {
    const { res, status, header, body } = makeRes();
    await handleAgentFile(makeReq('/api/agent/file?path=icon.svg&raw=1'), res, {}, contextRoot);
    expect(status()).toBe(200);
    expect(header('Content-Type')).toBe('application/json');
    expect(header('Content-Type')).not.toBe('image/svg+xml');
    expect(body().type).toBe('text');
    expect(body().content).toContain('<svg>');
  });
});

// Byte ranges are not an optimisation here: `<video>` seeks by issuing them, and a server
// that always answers 200-with-everything leaves a clip unseekable (Safari refuses to play
// it at all). These lock the contract the inline player depends on.
describe('handleAgentFile — media byte ranges', () => {
  it('answers a range with 206 + Content-Range, and only those bytes', async () => {
    const { res, status, header, raw, done } = makeRes();
    const req = { url: '/api/agent/file?path=image.png&raw=1', headers: { range: 'bytes=1-3' } } as unknown as IncomingMessage;
    await handleAgentFile(req, res, {}, contextRoot);
    await done();
    expect(status()).toBe(206);
    expect(header('Content-Range')).toBe('bytes 1-3/8');
    expect(header('Content-Length')).toBe(3);
    expect([...(raw() as Buffer)]).toEqual([0x50, 0x4e, 0x47]); // "PNG", the bytes after the magic
  });

  it('supports a suffix range (bytes=-2) — the trailing bytes', async () => {
    const { res, status, header, done } = makeRes();
    const req = { url: '/api/agent/file?path=image.png&raw=1', headers: { range: 'bytes=-2' } } as unknown as IncomingMessage;
    await handleAgentFile(req, res, {}, contextRoot);
    await done();
    expect(status()).toBe(206);
    expect(header('Content-Range')).toBe('bytes 6-7/8');
  });

  it('416s a range that starts past the end, reporting the real size', async () => {
    const { res, status, header, done } = makeRes();
    const req = { url: '/api/agent/file?path=image.png&raw=1', headers: { range: 'bytes=99-200' } } as unknown as IncomingMessage;
    await handleAgentFile(req, res, {}, contextRoot);
    await done();
    expect(status()).toBe(416);
    expect(header('Content-Range')).toBe('bytes */8');
  });
});

// A folder named in an answer is something to look inside, not an error.
describe('handleAgentFile — directory listing', () => {
  it('lists a directory, folders first', async () => {
    const { res, status, body } = makeRes();
    await handleAgentFile(makeReq('/api/agent/file?path=src'), res, {}, contextRoot);
    expect(status()).toBe(200);
    expect(body().type).toBe('dir');
    expect(body().entries).toEqual([{ name: 'hello.ts', kind: 'file', size: 20 }]);
  });
});

describe('handleAgentFile — X-Content-Type-Options: nosniff on every response', () => {
  it('is present on a 400 (traversal)', async () => {
    const { res, header } = makeRes();
    await handleAgentFile(makeReq('/api/agent/file?path=' + encodeURIComponent('../escape')), res, {}, contextRoot);
    expect(header('X-Content-Type-Options')).toBe('nosniff');
  });

  it('is present on a 404 (missing)', async () => {
    const { res, header } = makeRes();
    await handleAgentFile(makeReq('/api/agent/file?path=nope.ts'), res, {}, contextRoot);
    expect(header('X-Content-Type-Options')).toBe('nosniff');
  });

  it('is present on a 200 text response', async () => {
    const { res, header } = makeRes();
    await handleAgentFile(makeReq('/api/agent/file?path=src/hello.ts'), res, {}, contextRoot);
    expect(header('X-Content-Type-Options')).toBe('nosniff');
  });

  it('is present on a 200 raw image response', async () => {
    const { res, header, done } = makeRes();
    await handleAgentFile(makeReq('/api/agent/file?path=image.png&raw=1'), res, {}, contextRoot);
    await done();
    expect(header('X-Content-Type-Options')).toBe('nosniff');
  });
});
