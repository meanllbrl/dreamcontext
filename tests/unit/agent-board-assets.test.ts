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
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
   *
   * Raised 3400 → 4300 on 2026-08-23 for the shelf's two `dream-view` types (`pin` +
   * `progress`), which cost 695 characters INCLUDING both fenced examples — the
   * chat-surface-lockstep test requires one worked example per `VIEW_TYPES` member, so an
   * example is not prose and cannot be cut. The prose around them was compressed from 963 to
   * 695 before this number moved, per the rule above.
   *
   * AND a correction the raise turned up: the briefing had ALREADY drifted to 3491 — over the
   * 3400 ceiling — before this change, so this assertion was red on `main` and the drift that
   * put it there went in without moving the number. That is exactly the silent creep this
   * test exists to catch, which means it was not being run (or not being read) at the moment
   * it fired. The 4300 below covers 4186 actual; the next capability should compress before
   * it spends the remaining ~114.
   *
   * Raised 4300 → 4600 on 2026-08-25 for the pin DROP — the shelf's only retirement path, and
   * the fix for a tag line that filled up with conditions the session had long since resolved
   * (owner report, same day). It cost 313 characters: 57 for the fenced example, which the
   * chat-surface-lockstep test now requires and which is therefore not prose, and 256 for the
   * rule that stops a stale pin being created in the first place. Compression came first, per
   * the rule above: the shelf paragraph was rewritten from 1020 characters to 734 in the same
   * edit — the update sentence and "pin what only you know" were folded into the new one
   * rather than left to say the same thing twice. The 4600 covers 4499 actual.
   *
   * Raised 4600 → 8000 on 2026-08-26, and this one is a STEP CHANGE rather than another
   * capability's rent, so it deserves more than a line. The typed `chart` and `page` payloads
   * retired that day and `dream-html` replaced them: the agent now AUTHORS the presentation
   * instead of naming a widget the app validates. That moved two things into this file that
   * had lived in code. The `dc-` CLASS VOCABULARY (~1.2KB) is one — it is the schema now, and
   * an agent that has to guess class names emits unstyled markup, which is precisely the
   * broken promise the lockstep rule forbids; it is no more prose than a fenced example is.
   * The STEERING (~0.9KB: draw complex structure, render a decision's options rather than
   * describing them) is the other, and it is the owner's actual ask — "düz ve uzun yazıları
   * okumak yoruyor", "iki tasarım arasında seçim yaptıracaksa iki html göstersin" — which no
   * validator can enforce from the client side. Retiring chart/page paid back ~700 characters
   * and two trim passes took the draft from 8035 to 7512 before this number moved. The 8000
   * covers 7512 actual. The rule above is unchanged and now matters more: compress prose
   * before raising this again, and if the class list is what grows, ask first whether the KIT
   * should shrink.
   *
   * Raised 8000 → 8200 on 2026-08-26 (same day, second pass) for two owner rules the first
   * draft left unsaid, both traced to one real block: a 15KB static wall the owner opened and
   * said "interactive değil" to. (1) INTERACTION IS THE DEFAULT WHEN THERE ARE TWO VIEWS —
   * the old line ("use them when interaction helps, not for decoration") read as a hedge and
   * the agent stacked every cut down one page instead of letting the reader switch. (2) "IN A
   * NUTSHELL, NOT A REPORT" — there was no length ceiling at all, so a 15KB block was within
   * spec. They are one rule from two sides: switching is what makes a block short. The prose
   * was compressed FIRST, per the rule above — six passes (the intro, the decision bullet,
   * the copy/click bullet, the kit paragraph, the sandbox paragraph, the closing line) paid
   * back ~250 characters before this number moved. The 8200 covers 7960 actual.
   */
  it('stays small enough to ride in every chat turn', () => {
    expect(CHAT_SURFACE_BRIEFING.length).toBeLessThan(8200);
  });

  /**
   * The class list in the briefing IS the schema an agent writes against, so a name that the
   * kit doesn't define is a promise the render breaks — the agent writes `dc-timeline`,
   * the iframe draws an unstyled div, and nothing anywhere fails. Pinned by parsing both
   * sides: every `dc-` token the briefing names must appear as a selector in the kit CSS.
   */
  it('names no dc- class the kit does not define', () => {
    const kit = readFileSync(
      join(new URL('../../', import.meta.url).pathname,
        'dashboard/src/components/sleepy/chat/chat-html-kit.css'), 'utf-8');
    // `dc-f1..8` in the briefing is shorthand for the eight numbered classes; expand it the
    // same way a reader would before checking each one exists.
    const expanded = CHAT_SURFACE_BRIEFING.replace(
      /dc-([fs]|bg)1\.\.8/g,
      (_m, p: string) => Array.from({ length: 8 }, (_x, i) => `dc-${p}${i + 1}`).join(' '),
    );
    const named = new Set(expanded.match(/dc-[a-z0-9]+(?:-[a-z0-9]+)*(?:--[a-z]+)?/g) ?? []);
    // `dc-mode` is the host's data attribute, not a class the agent writes.
    named.delete('dc-mode');
    const missing = [...named].filter((cls) => !kit.includes(`.${cls}`));
    expect(missing, `briefing names dc- classes the kit does not define: ${missing.join(', ')}`).toEqual([]);
  });
});
