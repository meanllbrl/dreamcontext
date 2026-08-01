/**
 * Unit tests for the auto-title route's message plumbing — the three pure pieces
 * (`sanitizeTitle`, `sanitizeClientTitleMessage`, `firstUserMessage`) plus the
 * `handleAgentTitle` fallback chain itself: transcript → hook session-map entry →
 * client-supplied message. The client-message leg is the "title on the FIRST
 * attempt" fix — a fresh chat tab has no flushed transcript and may beat its own
 * UserPromptSubmit hook, but the surface already holds the text it sent.
 *
 * The `claude` CLI is never really spawned: node:child_process.spawn is mocked to
 * a fake child that answers the login-shell PATH probe and the Haiku titling call.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Every spawned "title" child replies with this; the PATH probe replies empty (no bin),
// which pushes generateTitle onto its shell-fallback arm — also mocked, same fake child.
const FAKE_TITLE = 'Login Sayfası Düzeltmesi';
const spawnedArgs: string[][] = [];

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const fakeSpawn = (_cmd: string, args: string[] = []) => {
    spawnedArgs.push(args);
    const listeners = new Map<string, (...a: unknown[]) => void>();
    const stdoutCbs: Array<(c: Buffer) => void> = [];
    const isProbe = args.some((a) => typeof a === 'string' && a.startsWith('command -v claude'));
    queueMicrotask(() => {
      stdoutCbs.forEach((cb) => cb(Buffer.from(isProbe ? '' : FAKE_TITLE)));
      listeners.get('close')?.(0);
    });
    return {
      stdout: { on: (ev: string, cb: (c: Buffer) => void) => { if (ev === 'data') stdoutCbs.push(cb); } },
      on: (ev: string, cb: (...a: unknown[]) => void) => { listeners.set(ev, cb); },
      kill: () => { /* fake child has nothing to kill */ },
    };
  };
  return { ...actual, spawn: fakeSpawn as unknown as typeof actual.spawn };
});

const {
  sanitizeTitle, sanitizeClientTitleMessage, firstUserMessage, handleAgentTitle,
} = await import('../../src/server/routes/agent-terminal.js');

function makeReq(body?: unknown): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  return {
    method: 'POST',
    headers: {},
    async *[Symbol.asyncIterator]() { yield* chunks; },
  } as unknown as IncomingMessage;
}

function makeRes(): { res: ServerResponse; status: () => number; body: () => Record<string, unknown> } {
  let code = 0;
  let payload = '';
  const res = {
    writeHead: (c: number) => { code = c; },
    end: (b?: string) => { payload = b ?? ''; },
  } as unknown as ServerResponse;
  return { res, status: () => code, body: () => JSON.parse(payload) as Record<string, unknown> };
}

// A valid, unused conversation UUID — no transcript, no session-map entry anywhere.
const CLAUDE_ID = '6f9619ff-8b86-4d01-b42d-00cf4fc964ff';

let vault: string;
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'dc-title-'));
  process.env.DREAMCONTEXT_DESKTOP = '1';
  spawnedArgs.length = 0;
});
afterEach(() => {
  delete process.env.DREAMCONTEXT_DESKTOP;
  rmSync(vault, { recursive: true, force: true });
});

describe('sanitizeTitle', () => {
  it('strips wrapping quotes/markdown, newlines and trailing punctuation', () => {
    expect(sanitizeTitle('"Fix login bug."\n')).toBe('Fix login bug');
    expect(sanitizeTitle('**Rate limiter design**')).toBe('Rate limiter design');
    expect(sanitizeTitle('Bir başlık\nikinci satır')).toBe('Bir başlık ikinci satır');
  });

  it('caps at 7 words and 52 characters', () => {
    expect(sanitizeTitle('one two three four five six seven eight nine')).toBe('one two three four five six seven');
    expect(sanitizeTitle('x'.repeat(80))!.length).toBeLessThanOrEqual(52);
  });

  it('rejects unusable output', () => {
    expect(sanitizeTitle('')).toBeNull();
    expect(sanitizeTitle('"a"')).toBeNull(); // single char after unwrapping
  });
});

describe('sanitizeClientTitleMessage', () => {
  it('accepts a genuine message, trimmed and capped at 800 chars', () => {
    expect(sanitizeClientTitleMessage('  fix the login page  ')).toBe('fix the login page');
    expect(sanitizeClientTitleMessage('m'.repeat(1000))).toHaveLength(800);
  });

  it('rejects non-strings, empties and <...> wrappers', () => {
    expect(sanitizeClientTitleMessage(undefined)).toBeNull();
    expect(sanitizeClientTitleMessage(42)).toBeNull();
    expect(sanitizeClientTitleMessage('   ')).toBeNull();
    expect(sanitizeClientTitleMessage('<system-reminder>noise</system-reminder>')).toBeNull();
  });
});

describe('firstUserMessage', () => {
  it('returns the first genuine user message, skipping wrappers and joining array content', () => {
    const p = join(vault, 'transcript.jsonl');
    writeFileSync(p, [
      JSON.stringify({ type: 'system', content: 'boot' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: '<command-stub>/model</command-stub>' } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'fix' }, { type: 'text', text: 'the bug' }] } }),
    ].join('\n'));
    expect(firstUserMessage(p)).toBe('fix the bug');
  });

  it('returns null for a missing or user-message-less file', () => {
    expect(firstUserMessage(join(vault, 'nope.jsonl'))).toBeNull();
    const p = join(vault, 'empty.jsonl');
    writeFileSync(p, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'hi' } }));
    expect(firstUserMessage(p)).toBeNull();
  });
});

describe('handleAgentTitle', () => {
  it('403s outside the desktop shell', async () => {
    delete process.env.DREAMCONTEXT_DESKTOP;
    const { res, status } = makeRes();
    await handleAgentTitle(makeReq({ claudeId: CLAUDE_ID }), res, {}, vault);
    expect(status()).toBe(403);
  });

  it('400s without a valid claudeId', async () => {
    const { res, status } = makeRes();
    await handleAgentTitle(makeReq({ claudeId: 'not-a-uuid' }), res, {}, vault);
    expect(status()).toBe(400);
  });

  it('titles from the client message when no transcript or hook entry exists', async () => {
    const { res, status, body } = makeRes();
    await handleAgentTitle(makeReq({ claudeId: CLAUDE_ID, message: 'login sayfasındaki bug\'ı düzelt' }), res, {}, vault);
    expect(status()).toBe(200);
    expect(body().title).toBe(FAKE_TITLE);
    // The Haiku call really carried the client's message in its prompt.
    const titleCall = spawnedArgs.find((a) => a.includes('-p'));
    expect(titleCall?.some((a) => a.includes('login sayfasındaki bug'))).toBe(true);
  });

  it('still reports no_transcript when neither source nor client message exists', async () => {
    const { res, status, body } = makeRes();
    await handleAgentTitle(makeReq({ claudeId: CLAUDE_ID }), res, {}, vault);
    expect(status()).toBe(200);
    expect(body()).toEqual({ title: null, reason: 'no_transcript' });
    expect(spawnedArgs.find((a) => a.includes('-p'))).toBeUndefined();
  });

  it('drops a <...>-wrapped client message instead of titling from it', async () => {
    const { res, body } = makeRes();
    await handleAgentTitle(makeReq({ claudeId: CLAUDE_ID, message: '<local-command-stdout>x</local-command-stdout>' }), res, {}, vault);
    expect(body()).toEqual({ title: null, reason: 'no_transcript' });
  });
});
