/**
 * Unit tests for the Chat view's "draw the board, don't link to it" server half:
 *
 *   • `GET /api/agent/board-assets` — the images an Excalidraw board embeds by wikilink.
 *     Without it a board drawn in the transcript renders with every screenshot blank, so the
 *     load-bearing behaviors are that it RESOLVES the board's own links and that it does not
 *     become a second, wider file reader (the containment + images-only rules).
 *   • `isShellSafePath` — the guard on the one argv element of the chat spawn that isn't a
 *     fixed literal or a whitelist-sanitized token (the briefing file's tmpdir path).
 *   • `CHAT_SURFACE_BRIEFING` — the briefing is what makes the agent USE any of this, and it
 *     is only correct while it names the shapes the client actually parses.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { handleAgentBoardAssets, isShellSafePath } from '../../src/server/routes/agent-chat.js';
import { CHAT_SURFACE_BRIEFING } from '../../src/server/chat-surface.js';

/** A 1×1 PNG — real bytes, so `sharp` (when present) has something valid to re-encode. */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function board(fileId: string, link: string): string {
  return [
    '# Board', '', '## Embedded Files', `${fileId}: [[${link}]]`, '', '%%', '## Drawing',
    '```json', '{"type":"excalidraw","version":2,"elements":[],"appState":{},"files":{}}', '```',
  ].join('\n');
}

function makeRes(): { res: ServerResponse; status: () => number; body: () => any } {
  let statusCode = 0;
  const chunks: Buffer[] = [];
  const res = {
    setHeader() { /* not asserted here */ },
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

function makeGet(path: string): IncomingMessage {
  return { url: `/api/agent/board-assets?path=${encodeURIComponent(path)}`, headers: {} } as unknown as IncomingMessage;
}

const noParams: Record<string, string> = {};

let projectRoot: string;
let contextRoot: string;
let outsideRoot: string;

beforeEach(() => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  projectRoot = join(tmpdir(), `dc-board-assets-${stamp}`);
  outsideRoot = join(tmpdir(), `dc-board-outside-${stamp}`);
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  mkdirSync(join(projectRoot, 'boards', 'assets'), { recursive: true });
  mkdirSync(outsideRoot, { recursive: true });
  writeFileSync(join(projectRoot, 'boards', 'assets', 'shot.png'), PNG_1PX);
  writeFileSync(join(projectRoot, 'boards', 'notes.txt'), 'not an image\n', 'utf-8');
  writeFileSync(join(outsideRoot, 'secret.png'), PNG_1PX);
  process.env.DREAMCONTEXT_DESKTOP = '1';
});

afterEach(() => {
  delete process.env.DREAMCONTEXT_DESKTOP;
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(outsideRoot, { recursive: true, force: true });
});

describe('handleAgentBoardAssets — gates', () => {
  it('403s when not in the desktop app', async () => {
    delete process.env.DREAMCONTEXT_DESKTOP;
    const { res, status } = makeRes();
    await handleAgentBoardAssets(makeGet('boards/b.excalidraw.md'), res, noParams, contextRoot);
    expect(status()).toBe(403);
  });

  it('400s with no path', async () => {
    const { res, status } = makeRes();
    const req = { url: '/api/agent/board-assets', headers: {} } as unknown as IncomingMessage;
    await handleAgentBoardAssets(req, res, noParams, contextRoot);
    expect(status()).toBe(400);
  });

  // The FILE decides, not the notation: a traversal reference names the same thing as its
  // absolute twin, so it gets the same answer as the test below — asked for, never read.
  it('never reads outside the project on a traversal attempt — it asks for consent instead', async () => {
    const { res, status, body } = makeRes();
    await handleAgentBoardAssets(makeGet('../../../etc/passwd'), res, noParams, contextRoot);
    expect(status()).toBe(403);
    expect(body()?.error).toBe('needs_grant');
    expect(body()?.files).toBeUndefined();
  });

  it('asks for consent (403 needs_grant) for a board outside the project', async () => {
    writeFileSync(join(outsideRoot, 'b.excalidraw.md'), board('aaaaaaaa11', 'secret.png'), 'utf-8');
    const { res, status, body } = makeRes();
    await handleAgentBoardAssets(makeGet(join(outsideRoot, 'b.excalidraw.md')), res, noParams, contextRoot);
    expect(status()).toBe(403);
    expect(body()?.error).toBe('needs_grant');
  });

  it('404s a board that is not there', async () => {
    const { res, status } = makeRes();
    await handleAgentBoardAssets(makeGet('boards/missing.excalidraw.md'), res, noParams, contextRoot);
    expect(status()).toBe(404);
  });

  it('404s a directory rather than trying to read it as a board', async () => {
    const { res, status } = makeRes();
    await handleAgentBoardAssets(makeGet('boards'), res, noParams, contextRoot);
    expect(status()).toBe(404);
  });
});

describe('handleAgentBoardAssets — resolution', () => {
  it('resolves a bare wikilink against the board folder’s assets/ subfolder', async () => {
    writeFileSync(join(projectRoot, 'boards', 'b.excalidraw.md'), board('abc123def456', 'shot.png'), 'utf-8');
    const { res, status, body } = makeRes();
    await handleAgentBoardAssets(makeGet('boards/b.excalidraw.md'), res, noParams, contextRoot);
    expect(status()).toBe(200);
    const files = body().files;
    expect(Object.keys(files)).toEqual(['abc123def456']);
    expect(files.abc123def456.dataURL).toMatch(/^data:image\/(webp|png);base64,/);
  });

  it('resolves a project-root-relative wikilink', async () => {
    writeFileSync(
      join(projectRoot, 'boards', 'b.excalidraw.md'),
      board('abc123def456', 'boards/assets/shot.png'),
      'utf-8',
    );
    const { res, body } = makeRes();
    await handleAgentBoardAssets(makeGet('boards/b.excalidraw.md'), res, noParams, contextRoot);
    expect(Object.keys(body().files)).toEqual(['abc123def456']);
  });

  it('returns an empty map for a board that embeds nothing — not an error', async () => {
    writeFileSync(join(projectRoot, 'boards', 'b.excalidraw.md'), '# Board\n\n## Embedded Files\n', 'utf-8');
    const { res, status, body } = makeRes();
    await handleAgentBoardAssets(makeGet('boards/b.excalidraw.md'), res, noParams, contextRoot);
    expect(status()).toBe(200);
    expect(body().files).toEqual({});
  });

  it('serves images ONLY — a non-image wikilink is skipped, not read', async () => {
    writeFileSync(join(projectRoot, 'boards', 'b.excalidraw.md'), board('abc123def456', 'notes.txt'), 'utf-8');
    const { res, body } = makeRes();
    await handleAgentBoardAssets(makeGet('boards/b.excalidraw.md'), res, noParams, contextRoot);
    expect(body().files).toEqual({});
  });

  it('will not follow a wikilink out of the project, even from a board inside it', async () => {
    writeFileSync(
      join(projectRoot, 'boards', 'b.excalidraw.md'),
      board('abc123def456', '../../../../../../etc/hosts'),
      'utf-8',
    );
    const { res, status, body } = makeRes();
    await handleAgentBoardAssets(makeGet('boards/b.excalidraw.md'), res, noParams, contextRoot);
    expect(status()).toBe(200);
    expect(body().files).toEqual({});
  });
});

describe('isShellSafePath', () => {
  it('accepts a real temp path', () => {
    expect(isShellSafePath('/var/folders/ab/T/dreamcontext-chat-surface-1234.md')).toBe(true);
    expect(isShellSafePath('/tmp/dc_x-1.md')).toBe(true);
  });

  it('rejects anything a shell would interpret', () => {
    for (const bad of [
      '/tmp/a b.md', '/tmp/a"b.md', "/tmp/a'b.md", '/tmp/$(id).md', '/tmp/a`id`.md',
      '/tmp/a;id.md', '/tmp/a|id.md', '/tmp/a\\b.md', '/tmp/a\nb.md', '',
    ]) {
      expect(isShellSafePath(bad), bad).toBe(false);
    }
  });
});

describe('CHAT_SURFACE_BRIEFING', () => {
  it('names every render shape the client actually parses', () => {
    // A capability named here but not rendered is a promise the UI breaks; one rendered but
    // not named is unreachable. Both directions are the point of this marker test.
    expect(CHAT_SURFACE_BRIEFING).toContain('dream-actions');
    expect(CHAT_SURFACE_BRIEFING).toContain('.excalidraw.md');
    for (const kind of ['task', 'knowledge', 'core', 'file', 'board', 'reveal', 'ask']) {
      expect(CHAT_SURFACE_BRIEFING, kind).toContain(`\`${kind}\``);
    }
  });

  /**
   * A BUDGET, not a technical limit — the briefing is appended to the system prompt of every
   * chat turn, so every character is paid for on every turn. Raised 3000 → 3400 on 2026-08-02
   * when the highlighter (`==phrase==`, plus the `!`/`+` pens) was added: the ceiling had been
   * sitting at 2992/3000, so the next capability was always going to move it. Moving it is
   * allowed; moving it SILENTLY is what this test exists to prevent. Spend the headroom on a
   * capability, not on prose — and compress the prose before raising the number again.
   */
  it('stays small enough to ride in every chat turn', () => {
    expect(CHAT_SURFACE_BRIEFING.length).toBeLessThan(3400);
  });
});
