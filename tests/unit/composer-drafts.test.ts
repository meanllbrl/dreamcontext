/**
 * The composer's unsent content, kept per conversation across restarts (Slack's draft
 * behaviour: what you typed stays in the box) — chat/composerDrafts.ts, plus the roster's
 * server-side coercion that carries it (agent-sessions.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  __resetDraftsForTests, allDrafts, clearDraft, persistDraft, readDraft, seedAllDrafts, subscribeAnyDrafts, subscribeDraft,
  MAX_DRAFT_TEXT, MAX_DRAFT_QUOTE, MAX_DRAFT_CHIPS, MAX_DRAFT_CONVERSATIONS, DRAFTS_BUDGET_BYTES,
} from '../../dashboard/src/components/sleepy/chat/composerDrafts.js';
import type { Attachment } from '../../dashboard/src/components/sleepy/chat/composerScratch.js';
import * as server from '../../src/server/routes/agent-sessions.js';

const V = 'proj-a';
const U1 = '0b8f6a2e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const U2 = '1b8f6a2e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const box = (text: string, attachments: Attachment[] = [], quote: string | null = null) => ({ text, attachments, quote });

beforeEach(() => __resetDraftsForTests());

describe('persistDraft — one slot per conversation, mirroring the box', () => {
  it('keeps text, sendable chips and the quote, never an object URL', () => {
    const chips: Attachment[] = [
      { id: 'a1', kind: 'image', name: 'shot.png', url: 'blob:x', path: '/tmp/shot.png' },
      { id: 'a2', kind: 'file', name: 'a.ts', path: '/p/a.ts' },
      { id: 'a3', kind: 'image', name: 'up.png', uploading: true },
      { id: 'a4', kind: 'image', name: 'bad.png', failed: true },
    ];
    expect(persistDraft(V, U1, box('when it finishes: rerun the tests', chips, 'earlier answer'), 7)).toBe('kept');
    expect(readDraft(V, U1)).toEqual({
      text: 'when it finishes: rerun the tests',
      chips: [{ kind: 'image', name: 'shot.png', path: '/tmp/shot.png' }, { kind: 'file', name: 'a.ts', path: '/p/a.ts' }],
      quote: 'earlier answer',
      savedAt: 7,
    });
  });

  it('every change replaces the slot; an emptied box (a send) clears it', () => {
    persistDraft(V, U1, box('a'));
    persistDraft(V, U1, box('ab'));
    expect(readDraft(V, U1)?.text).toBe('ab');
    expect(persistDraft(V, U1, box('ab'))).toBe('unchanged');
    expect(persistDraft(V, U1, box('   '))).toBe('cleared');
    expect(readDraft(V, U1)).toBeNull();
  });

  it('over a cap the LAST version that fit stays — never a truncated one', () => {
    persistDraft(V, U1, box('fits'));
    expect(persistDraft(V, U1, box('a'.repeat(MAX_DRAFT_TEXT + 1)))).toBe('over-limit');
    expect(persistDraft(V, U1, box('q', [], 'z'.repeat(MAX_DRAFT_QUOTE + 1)))).toBe('over-limit');
    const many = Array.from({ length: MAX_DRAFT_CHIPS + 1 }, (_, i): Attachment => ({ id: `a${i}`, kind: 'file', name: `f${i}`, path: `/f${i}` }));
    expect(persistDraft(V, U1, box('x', many))).toBe('over-limit');
    expect(readDraft(V, U1)?.text).toBe('fits');
  });

  it('refuses a new conversation past the conversation cap and past the UTF-8 budget', () => {
    for (let i = 0; i < MAX_DRAFT_CONVERSATIONS; i++) expect(persistDraft(V, `c${i}`, box('x'))).toBe('kept');
    expect(persistDraft(V, 'one-too-many', box('x'))).toBe('over-limit');
    expect(persistDraft(V, 'c0', box('an existing one still updates'))).toBe('kept');
    __resetDraftsForTests();
    const big = 'ş'.repeat(MAX_DRAFT_TEXT); // 2 bytes each
    let kept = 0;
    for (let i = 0; i < 40; i++) if (persistDraft(V, `b${i}`, box(big)) === 'kept') kept++;
    expect(kept * MAX_DRAFT_TEXT * 2).toBeLessThanOrEqual(DRAFTS_BUDGET_BYTES);
    expect(kept).toBeLessThan(40);
  });

  it('notifies the conversation and the any-listener', () => {
    const seen: Array<string | null> = [];
    let any = 0;
    subscribeDraft(V, U1, (d) => seen.push(d?.text ?? null));
    subscribeAnyDrafts(() => { any++; });
    persistDraft(V, U1, box('one'));
    persistDraft(V, U2, box('two'));
    persistDraft(V, U1, box(''));
    expect(seen).toEqual(['one', null]);
    expect(any).toBe(3);
  });
});

describe('allDrafts / seedAllDrafts (the roster map)', () => {
  it('sends only real conversation ids and seeds them back', () => {
    persistDraft(V, U1, box('keep'));
    persistDraft(V, 'agents-channel', box('in memory only'));
    const map = JSON.parse(JSON.stringify(allDrafts(V)));
    expect(Object.keys(map)).toEqual([U1]);
    __resetDraftsForTests();
    seedAllDrafts(V, map);
    expect(readDraft(V, U1)?.text).toBe('keep');
  });

  it('a seed never overwrites what this app run already holds, and drops hostile input', () => {
    persistDraft(V, U1, box('live'));
    seedAllDrafts(V, {
      [U1]: { text: 'from file' },
      [U2]: { text: 'ok', chips: [{ kind: 'file', name: 'a', path: '/a' }, { kind: 'evil', name: 'x' }] },
      bad: 'junk',
    });
    expect(readDraft(V, U1)?.text).toBe('live');
    expect(readDraft(V, U2)?.chips).toEqual([{ kind: 'file', name: 'a', path: '/a' }]);
    expect(readDraft(V, 'bad')).toBeNull();
  });
});

describe('a seed never undoes this run; projects never share drafts', () => {
  it('a draft cleared by a send is NOT brought back by a stale seed (a 409 re-hydrate)', () => {
    persistDraft(V, U1, box('sent already'));
    const staleFile = JSON.parse(JSON.stringify(allDrafts(V)));
    persistDraft(V, U1, box(''));            // the send
    seedAllDrafts(V, staleFile);              // the re-hydrate reads the file before the clearing PUT landed
    expect(readDraft(V, U1)).toBeNull();
  });

  it('each project writes and seeds only its own drafts', () => {
    persistDraft('proj-b', U1, box('in B'));
    expect(allDrafts(V)).toEqual({});
    expect(Object.keys(allDrafts('proj-b'))).toEqual([U1]);
    seedAllDrafts(V, { [U2]: { text: 'only A' } });
    expect(readDraft('proj-b', U2)).toBeNull();
    expect(readDraft(V, U2)?.text).toBe('only A');
  });

  it('clearDraft forgets a conversation whose box moved to a new id, and a seed cannot revive it', () => {
    persistDraft(V, U1, box('moving'));
    clearDraft(V, U1);
    expect(readDraft(V, U1)).toBeNull();
    seedAllDrafts(V, { [U1]: { text: 'moving' } });
    expect(readDraft(V, U1)).toBeNull();
  });
});

describe('server roster (agent-sessions.ts): drafts are a map by conversation', () => {
  let scratch: string;
  let contextRoot: string;
  const realDesktop = process.env.DREAMCONTEXT_DESKTOP;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'drafts-roster-'));
    contextRoot = join(scratch, 'proj', '_dream_context');
    mkdirSync(join(contextRoot, 'state'), { recursive: true });
    process.env.DREAMCONTEXT_DESKTOP = '1';
  });
  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
    if (realDesktop === undefined) delete process.env.DREAMCONTEXT_DESKTOP;
    else process.env.DREAMCONTEXT_DESKTOP = realDesktop;
  });
  const res = () => {
    let code = 0; let body: Record<string, unknown> = {};
    const r = { writeHead(c: number) { code = c; }, setHeader() {}, end(d: string) { body = JSON.parse(d); } } as unknown as ServerResponse;
    return { r, status: () => code, body: () => body };
  };
  const put = async (body: unknown) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
    Object.assign(req, { method: 'PUT', headers: { 'content-type': 'application/json' } });
    const o = res();
    await server.handleAgentSessionsPut(req, o.r, {}, contextRoot, scratch);
    return o.status();
  };
  const get = async () => {
    const o = res();
    await server.handleAgentSessionsGet({} as IncomingMessage, o.r, {}, contextRoot, scratch);
    return o.body();
  };
  const d = (text: string) => ({ text, chips: [], quote: null, savedAt: 1 });

  it('round-trips the draft of a conversation with NO open tab (closed tab, Super Agent)', async () => {
    expect(await put({ sessions: [], chatPermissionMode: 'auto', drafts: { [U1]: d('note') } })).toBe(200);
    expect((await get()).drafts).toEqual({ [U1]: d('note') });
  });

  it('a PUT that does not mention drafts keeps the stored ones; `{}` clears them', async () => {
    await put({ sessions: [], drafts: { [U1]: d('note') } });
    await put({ sessions: [] });
    expect((await get()).drafts).toEqual({ [U1]: d('note') });
    await put({ sessions: [], drafts: {} });
    expect((await get()).drafts).toBeUndefined();
  });

  it('coerces: non-UUID keys and malformed drafts are dropped, over-long text is dropped not cut', () => {
    const map = server.coerceDraftMap({
      [U1]: d('fine'),
      'not-a-uuid': d('y'),
      [U2]: { text: 'y'.repeat(MAX_DRAFT_TEXT + 1) },
    })!;
    expect(Object.keys(map)).toEqual([U1]);
    expect(server.coerceDraftMap({ [U1]: { text: ' ' } })).toBeUndefined();
  });

  it('mirrors the client caps (drift test)', () => {
    expect(server.MAX_DRAFT_TEXT).toBe(MAX_DRAFT_TEXT);
    expect(server.MAX_DRAFT_QUOTE).toBe(MAX_DRAFT_QUOTE);
    expect(server.MAX_DRAFT_CHIPS).toBe(MAX_DRAFT_CHIPS);
    expect(server.MAX_DRAFT_CONVERSATIONS).toBe(MAX_DRAFT_CONVERSATIONS);
    const src = readFileSync(join(__dirname, '../../src/server/routes/agent-sessions.ts'), 'utf-8');
    const m = /const MAX_BYTES = (\d+) \* (\d+);/.exec(src);
    expect(m).not.toBeNull();
    expect(Number(m![1]) * Number(m![2])).toBeGreaterThanOrEqual(DRAFTS_BUDGET_BYTES + 64 * 1024);
  });
});
