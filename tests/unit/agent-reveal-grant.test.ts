/**
 * Unit tests for the two consent/escape-hatch routes the Agent Chat surface added around
 * `GET /api/agent/file`:
 *
 *   • `POST /api/agent/reveal` — hands a path to the OS. The load-bearing behavior is the
 *     OPEN-vs-REVEAL split: a folder, a media file, or an inert document opens in the
 *     default app, and anything else (a `.sh`, `.command`, `.pkg`, `.app`) is only ever
 *     REVEALED in the file manager, so a click in a chat bubble can never launch it.
 *   • `POST /api/agent/grant` — the user allowing ONE named file outside the project root,
 *     which is what turns `/agent/file`'s `needs_grant` into a served read.
 *
 * `spawn` is mocked, so no real opener ever runs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

const spawnMock = vi.fn(() => ({ unref() { /* detached */ } }));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: spawnMock,
}));

const { handleAgentReveal, handleAgentGrant, handleAgentFile } =
  await import('../../src/server/routes/agent-chat.js');

function makeRes(): {
  res: ServerResponse;
  status: () => number;
  body: () => any;
} {
  let statusCode = 0;
  const chunks: Buffer[] = [];
  const res = {
    setHeader() { /* headers are asserted elsewhere */ },
    writeHead(code: number) { statusCode = code; return res; },
    end(chunk?: Buffer | string) { if (chunk) chunks.push(Buffer.from(chunk)); },
    on() { return res; },
    destroy() { /* noop */ },
  } as unknown as ServerResponse;
  return {
    res,
    status: () => statusCode,
    body: () => {
      if (!chunks.length) return undefined;
      const text = Buffer.concat(chunks).toString('utf-8');
      try { return JSON.parse(text); } catch { return text; }
    },
  };
}

/** A POST request whose body is the given object (the handlers `for await` over `req`). */
function makePost(body: unknown): IncomingMessage {
  const req = Readable.from([Buffer.from(JSON.stringify(body), 'utf-8')]) as unknown as IncomingMessage;
  (req as any).url = '/api/agent/reveal';
  (req as any).method = 'POST';
  (req as any).headers = {};
  return req;
}

function makeGet(path: string): IncomingMessage {
  return { url: path, headers: {} } as unknown as IncomingMessage;
}

/** The args `spawn` was last called with — `[cmd, args]`. */
function lastSpawn(): { cmd: string; args: string[] } {
  const call = spawnMock.mock.calls.at(-1) as unknown as [string, string[]];
  return { cmd: call[0], args: call[1] };
}

let projectRoot: string;
let contextRoot: string;
let outsideRoot: string;

beforeEach(() => {
  spawnMock.mockClear();
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  projectRoot = join(tmpdir(), `dc-agent-reveal-${stamp}`);
  outsideRoot = join(tmpdir(), `dc-agent-outside-${stamp}`);
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  mkdirSync(join(projectRoot, 'folder'), { recursive: true });
  mkdirSync(outsideRoot, { recursive: true });
  writeFileSync(join(projectRoot, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'binary');
  writeFileSync(join(projectRoot, 'notes.md'), '# Notes\n', 'utf-8');
  writeFileSync(join(projectRoot, 'install.sh'), '#!/bin/sh\necho hi\n', 'utf-8');
  writeFileSync(join(outsideRoot, 'recording.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'binary');
  writeFileSync(join(outsideRoot, 'secret.txt'), 'outside the project\n', 'utf-8');
  process.env.DREAMCONTEXT_DESKTOP = '1';
});

afterEach(() => {
  delete process.env.DREAMCONTEXT_DESKTOP;
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(outsideRoot, { recursive: true, force: true });
});

describe('handleAgentReveal — gates', () => {
  it('403s when not in the desktop app, and never spawns an opener', async () => {
    delete process.env.DREAMCONTEXT_DESKTOP;
    const { res, status } = makeRes();
    await handleAgentReveal(makePost({ path: join(projectRoot, 'shot.png') }), res);
    expect(status()).toBe(403);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('400s a body with no path', async () => {
    const { res, status } = makeRes();
    await handleAgentReveal(makePost({}), res);
    expect(status()).toBe(400);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('400s an unparseable body rather than treating it as an empty open', async () => {
    const req = Readable.from([Buffer.from('not json', 'utf-8')]) as unknown as IncomingMessage;
    (req as any).headers = {};
    const { res, status } = makeRes();
    await handleAgentReveal(req, res);
    expect(status()).toBe(400);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('404s a path that does not exist', async () => {
    const { res, status } = makeRes();
    await handleAgentReveal(makePost({ path: join(projectRoot, 'nope.png') }), res);
    expect(status()).toBe(404);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('handleAgentReveal — open directly vs. reveal in the file manager', () => {
  it('opens an image with the default app (the target itself is the argument)', async () => {
    const target = join(projectRoot, 'shot.png');
    const { res, status, body } = makeRes();
    await handleAgentReveal(makePost({ path: target }), res);
    expect(status()).toBe(200);
    // The answer names which of the two actually happened, so a caller whose button said
    // "Open on computer" can tell an open from the executable downgrade to a reveal.
    expect(body()).toEqual({ opened: true, mode: 'open' });
    expect(lastSpawn().args).toContain(target);
    expect(lastSpawn().args).not.toContain('-R');
  });

  it('opens an inert document (.md) with the default app', async () => {
    const target = join(projectRoot, 'notes.md');
    const { res, status } = makeRes();
    await handleAgentReveal(makePost({ path: target }), res);
    expect(status()).toBe(200);
    expect(lastSpawn().args).not.toContain('-R');
  });

  it('opens a folder with the default app', async () => {
    const target = join(projectRoot, 'folder');
    const { res, status } = makeRes();
    await handleAgentReveal(makePost({ path: target }), res);
    expect(status()).toBe(200);
    expect(lastSpawn().args).not.toContain('-R');
  });

  it('NEVER launches a script — a .sh is revealed in the file manager instead', async () => {
    const target = join(projectRoot, 'install.sh');
    const { res, status } = makeRes();
    await handleAgentReveal(makePost({ path: target }), res);
    expect(status()).toBe(200);
    // Whatever the platform, the executable path is not handed to the opener bare:
    // macOS reveals with `-R <path>`, Windows with `/select,<path>`, Linux opens the dir.
    expect(lastSpawn().args).not.toEqual([target]);
    if (process.platform === 'darwin') expect(lastSpawn().args).toEqual(['-R', target]);
  });

  it('reveals rather than opens a file with no extension at all', async () => {
    const target = join(projectRoot, 'runme');
    writeFileSync(target, '#!/bin/sh\n', 'utf-8');
    const { res, status } = makeRes();
    await handleAgentReveal(makePost({ path: target }), res);
    expect(status()).toBe(200);
    expect(lastSpawn().args).not.toEqual([target]);
  });

  it('opens a PDF with the default app — it is on the inert-document allowlist', async () => {
    const target = join(projectRoot, 'handbook.pdf');
    writeFileSync(target, '%PDF-1.4\n', 'utf-8');
    const { res, status, body } = makeRes();
    await handleAgentReveal(makePost({ path: target }), res);
    expect(status()).toBe(200);
    expect(body()).toEqual({ opened: true, mode: 'open' });
    expect(lastSpawn().args).toEqual([target]);
  });

  it('reaches a file OUTSIDE the project root — that is the whole point of the route', async () => {
    const target = join(outsideRoot, 'recording.png');
    const { res, status } = makeRes();
    await handleAgentReveal(makePost({ path: target }), res);
    expect(status()).toBe(200);
    expect(lastSpawn().args).toContain(target);
  });
});

// ─── `mode` — "show me where this is" as its own request ────────────────────────
//
// The surfaces that show a file now offer BOTH doors as separate buttons, because "open it"
// and "where is it?" are different things to want and the route used to answer only the first
// (deciding for itself, from the extension). `mode` may only ever NARROW: it can turn an open
// into a reveal, never a reveal into an open, so the never-launch-an-executable rule cannot be
// unlocked by a client asking nicely.

describe('handleAgentReveal — an explicit reveal', () => {
  it('reveals a file it would otherwise have opened', async () => {
    const target = join(projectRoot, 'shot.png');
    const { res, status, body } = makeRes();
    await handleAgentReveal(makePost({ path: target, mode: 'reveal' }), res);
    expect(status()).toBe(200);
    expect(body()).toEqual({ opened: true, mode: 'reveal' });
    expect(lastSpawn().args).not.toEqual([target]);
    if (process.platform === 'darwin') expect(lastSpawn().args).toEqual(['-R', target]);
  });

  it('reveals a FOLDER rather than opening it, when asked to', async () => {
    const target = join(projectRoot, 'folder');
    const { res, status, body } = makeRes();
    await handleAgentReveal(makePost({ path: target, mode: 'reveal' }), res);
    expect(status()).toBe(200);
    expect(body()).toEqual({ opened: true, mode: 'reveal' });
    if (process.platform === 'darwin') expect(lastSpawn().args).toEqual(['-R', target]);
  });

  it('an unknown mode means "decide for me" — it can never widen the route', async () => {
    const script = join(projectRoot, 'install.sh');
    const { res: r1 } = makeRes();
    await handleAgentReveal(makePost({ path: script, mode: 'open' }), r1);
    if (process.platform === 'darwin') expect(lastSpawn().args).toEqual(['-R', script]);

    const { res: r2 } = makeRes();
    await handleAgentReveal(makePost({ path: script, mode: 'launch-it-anyway' }), r2);
    expect(lastSpawn().args).not.toEqual([script]);

    // …and it must not turn an ordinary open into a reveal either — an absent/odd mode is
    // exactly the behaviour every pre-existing caller already had.
    const image = join(projectRoot, 'shot.png');
    const { res: r3, body } = makeRes();
    await handleAgentReveal(makePost({ path: image, mode: 42 }), r3);
    expect(body()).toEqual({ opened: true, mode: 'open' });
    expect(lastSpawn().args).toEqual([image]);
  });
});

// ─── relative paths ─────────────────────────────────────────────────────────────
//
// A transcript names files the way the AGENT writes them: project-relative. Handing that
// straight to `statSync` resolved it against the SERVER process's cwd — which for a
// desktop-spawned server is not the project — so every relative path 404'd and the
// last-resort "Open ↗" on a can't-be-shown file opened nothing at all.

describe('handleAgentReveal — project-relative paths', () => {
  it('resolves a project-relative path under the project root', async () => {
    const { res, status } = makeRes();
    await handleAgentReveal(makePost({ path: 'shot.png' }), res, {}, contextRoot);
    expect(status()).toBe(200);
    expect(lastSpawn().args).toContain(join(projectRoot, 'shot.png'));
  });

  it('resolves a nested project-relative path — the shape an answer actually writes', async () => {
    mkdirSync(join(projectRoot, '_dream_context', 'social'), { recursive: true });
    const rel = '_dream_context/social/reel-sfx.mp4';
    writeFileSync(join(projectRoot, rel), 'not really a video', 'utf-8');
    const { res, status } = makeRes();
    await handleAgentReveal(makePost({ path: rel }), res, {}, contextRoot);
    expect(status()).toBe(200);
    // Media opens in the default app rather than being revealed.
    expect(lastSpawn().args).toEqual([join(projectRoot, rel)]);
  });

  it('404s a reference that names nothing anywhere, and never spawns an opener', async () => {
    const { res, status } = makeRes();
    await handleAgentReveal(makePost({ path: '../dc-agent-nowhere-x/secret.txt' }), res, {}, contextRoot);
    expect(status()).toBe(404);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('404s a project-relative path that does not exist', async () => {
    const { res, status } = makeRes();
    await handleAgentReveal(makePost({ path: 'nope.png' }), res, {}, contextRoot);
    expect(status()).toBe(404);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

// ─── references whose `..` counting is wrong ────────────────────────────────────
//
// The owner's 07-28 report. An answer wrote `../../tmp/dc-verify-auto/automations-light.png`
// for a screenshot at `/tmp/dc-verify-auto/automations-light.png`; the climb lands nowhere,
// so "Open ↗" — the card's only affordance — opened nothing. The route now resolves a
// transcript path by what it NAMES (see `resolveChatReference`), which is what makes the
// button open the picture instead of reporting at the user.

describe('handleAgentReveal — a reference whose climb lands nowhere', () => {
  it('opens the file the reference actually names', async () => {
    const shotDir = join(tmpdir(), `dc-agent-shots-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(shotDir, { recursive: true });
    const shot = join(shotDir, 'automations-light.png');
    writeFileSync(shot, Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'binary');
    try {
      const { res, status } = makeRes();
      await handleAgentReveal(makePost({ path: `../../${shotDir.split('/').pop()}/automations-light.png` }), res, {}, contextRoot);
      expect(status()).toBe(200);
      expect(lastSpawn().args).toEqual([shot]); // an image opens; no `-R`
    } finally {
      rmSync(shotDir, { recursive: true, force: true });
    }
  });

  it('a RECOVERED executable is still only revealed, never launched', async () => {
    // Resolving more references must not widen what may be RUN: the open-vs-reveal split is
    // decided after the file is known, so a recovered `.sh` gets the same treatment as one
    // named outright.
    const dir = join(tmpdir(), `dc-agent-sh-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    const script = join(dir, 'setup.sh');
    writeFileSync(script, '#!/bin/sh\necho hi\n', 'utf-8');
    try {
      const { res, status } = makeRes();
      await handleAgentReveal(makePost({ path: `../../../${dir.split('/').pop()}/setup.sh` }), res, {}, contextRoot);
      expect(status()).toBe(200);
      expect(lastSpawn().args).not.toEqual([script]);
      if (process.platform === 'darwin') expect(lastSpawn().args).toEqual(['-R', script]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('handleAgentGrant — consent for one file outside the project root', () => {
  it('403s when not in the desktop app', async () => {
    delete process.env.DREAMCONTEXT_DESKTOP;
    const { res, status } = makeRes();
    await handleAgentGrant(makePost({ path: join(outsideRoot, 'secret.txt') }), res, {}, contextRoot);
    expect(status()).toBe(403);
    expect(existsSync(join(contextRoot, 'state', '.file-grants.json'))).toBe(false);
  });

  it('400s a relative path — a grant is always one absolute, literal path', async () => {
    const { res, status } = makeRes();
    await handleAgentGrant(makePost({ path: 'src/hello.ts' }), res, {}, contextRoot);
    expect(status()).toBe(400);
  });

  it('400s a path carrying traversal', async () => {
    const { res, status } = makeRes();
    await handleAgentGrant(makePost({ path: `${outsideRoot}/../etc/passwd` }), res, {}, contextRoot);
    expect(status()).toBe(400);
  });

  it('404s a file that does not exist', async () => {
    const { res, status } = makeRes();
    await handleAgentGrant(makePost({ path: join(outsideRoot, 'ghost.txt') }), res, {}, contextRoot);
    expect(status()).toBe(404);
  });

  it('400s a DIRECTORY — a granted folder would quietly widen to everything beneath it', async () => {
    const { res, status } = makeRes();
    await handleAgentGrant(makePost({ path: outsideRoot }), res, {}, contextRoot);
    expect(status()).toBe(400);
    expect(existsSync(join(contextRoot, 'state', '.file-grants.json'))).toBe(false);
  });

  it('records exactly the granted path, and that grant makes /agent/file serve it', async () => {
    const target = join(outsideRoot, 'secret.txt');

    // Before the grant: refused, with the "ask the user" code, and no content.
    const before = makeRes();
    await handleAgentFile(makeGet(`/api/agent/file?path=${encodeURIComponent(target)}`), before.res, {}, contextRoot);
    expect(before.status()).toBe(403);
    expect(before.body()?.error).toBe('needs_grant');

    const granted = makeRes();
    await handleAgentGrant(makePost({ path: target }), granted.res, {}, contextRoot);
    expect(granted.status()).toBe(200);
    expect(granted.body()).toEqual({ granted: true, path: target });

    const stored = JSON.parse(readFileSync(join(contextRoot, 'state', '.file-grants.json'), 'utf-8'));
    expect(stored.paths).toEqual([target]);

    // After the grant: served. The sibling file next to it is still refused — one grant is
    // one file, never its directory.
    const after = makeRes();
    await handleAgentFile(makeGet(`/api/agent/file?path=${encodeURIComponent(target)}`), after.res, {}, contextRoot);
    expect(after.status()).toBe(200);
    expect(after.body()?.content).toContain('outside the project');

    const sibling = join(outsideRoot, 'recording.png');
    const other = makeRes();
    await handleAgentFile(makeGet(`/api/agent/file?path=${encodeURIComponent(sibling)}`), other.res, {}, contextRoot);
    expect(other.status()).toBe(403);
    expect(other.body()?.error).toBe('needs_grant');
  });

  it('is idempotent — granting the same path twice stores one entry', async () => {
    const target = join(outsideRoot, 'secret.txt');
    for (const _ of [0, 1]) {
      const { res } = makeRes();
      await handleAgentGrant(makePost({ path: target }), res, {}, contextRoot);
    }
    const stored = JSON.parse(readFileSync(join(contextRoot, 'state', '.file-grants.json'), 'utf-8'));
    expect(stored.paths).toEqual([target]);
  });
});
