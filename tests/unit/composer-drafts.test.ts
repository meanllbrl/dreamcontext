/**
 * Saved composer drafts (Slack-style "keep this for later") — chat/composerDrafts.ts, plus the
 * roster's server-side coercion that carries them across a restart (agent-sessions.ts).
 *
 * What matters most is the REFUSAL contract: the composer clears the box only when the draft
 * was kept, so every way a save can fail must fail here, before anything is taken.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  __resetDraftsForTests, allDrafts, seedAllDrafts, deleteDraft, draftLabel, readDrafts, saveDraft, seedDrafts, subscribeAnyDrafts,
  subscribeDrafts, takeDraft, MAX_DRAFTS, MAX_DRAFT_TEXT, MAX_DRAFT_QUOTE, MAX_DRAFT_CHIPS, MAX_DRAFT_CONVERSATIONS, DRAFTS_BUDGET_BYTES,
} from '../../dashboard/src/components/sleepy/chat/composerDrafts.js';
import type { Attachment } from '../../dashboard/src/components/sleepy/chat/composerScratch.js';
import * as server from '../../src/server/routes/agent-sessions.js';

const CONV = 'conv-a';
const OTHER = 'conv-b';
const box = (text: string, attachments: Attachment[] = [], quote: string | null = null) => ({ text, attachments, quote });

beforeEach(() => __resetDraftsForTests());

describe('saveDraft', () => {
  it('keeps text, sendable chips and the quote, never an object URL', () => {
    const chips: Attachment[] = [
      { id: 'att-1', kind: 'image', name: 'shot.png', url: 'blob:x', path: '/tmp/shot.png' },
      { id: 'att-2', kind: 'file', name: 'a.ts', path: '/p/a.ts' },
    ];
    const r = saveDraft(CONV, box('tell it to rerun the tests\n', chips, 'earlier answer'), 1000);
    expect(r.ok).toBe(true);
    const [d] = readDrafts(CONV);
    expect(d.text).toBe('tell it to rerun the tests');
    expect(d.quote).toBe('earlier answer');
    expect(d.chips).toEqual([
      { kind: 'image', name: 'shot.png', path: '/tmp/shot.png' },
      { kind: 'file', name: 'a.ts', path: '/p/a.ts' },
    ]);
    expect(JSON.stringify(d)).not.toContain('blob:');
  });

  it('refuses while a chip is still uploading (it has no path yet)', () => {
    const r = saveDraft(CONV, box('x', [{ id: 'att-1', kind: 'image', name: 'p.png', uploading: true }]));
    expect(r.ok).toBe(false);
    expect(readDrafts(CONV)).toHaveLength(0);
  });

  it('refuses an empty box, an oversize text, too many chips, a long quote and a full shelf', () => {
    expect(saveDraft(CONV, box('   ')).ok).toBe(false);
    expect(saveDraft(CONV, box('a'.repeat(MAX_DRAFT_TEXT + 1))).ok).toBe(false);
    expect(saveDraft(CONV, box('q', [], 'z'.repeat(MAX_DRAFT_QUOTE + 1))).ok).toBe(false);
    const many = Array.from({ length: MAX_DRAFT_CHIPS + 1 }, (_, i): Attachment => ({ id: `a${i}`, kind: 'file', name: `f${i}`, path: `/f${i}` }));
    expect(saveDraft(CONV, box('x', many)).ok).toBe(false);
    for (let i = 0; i < MAX_DRAFTS; i++) expect(saveDraft(CONV, box(`n${i}`)).ok).toBe(true);
    const full = saveDraft(CONV, box('one more'));
    expect(full.ok).toBe(false);
    expect(readDrafts(CONV)).toHaveLength(MAX_DRAFTS);
  });

  it('refuses past the cross-chat byte budget, counted in UTF-8', () => {
    const big = 'ş'.repeat(MAX_DRAFT_TEXT);  // 2 bytes each
    let kept = 0;
    for (let c = 0; c < 100 && kept * MAX_DRAFT_TEXT * 2 < DRAFTS_BUDGET_BYTES + MAX_DRAFT_TEXT * 4; c++) {
      for (let i = 0; i < MAX_DRAFTS; i++) if (saveDraft(`c${c}`, box(big)).ok) kept++;
    }
    expect(kept * MAX_DRAFT_TEXT * 2).toBeLessThanOrEqual(DRAFTS_BUDGET_BYTES);
    expect(saveDraft('fresh', box(big)).ok).toBe(false);
  });

  it('refuses a NEW conversation past the server\'s conversation cap; existing ones still save', () => {
    for (let i = 0; i < MAX_DRAFT_CONVERSATIONS; i++) expect(saveDraft(`c${i}`, box('x')).ok).toBe(true);
    expect(saveDraft('one-too-many', box('x')).ok).toBe(false);
    expect(saveDraft('c0', box('second in an existing chat')).ok).toBe(true);
  });

  it('a failed chip is not part of the draft', () => {
    saveDraft(CONV, box('x', [{ id: 'a', kind: 'image', name: 'bad.png', failed: true }]));
    expect(readDrafts(CONV)[0].chips).toEqual([]);
  });

  it('keys by conversation and notifies both kinds of listener', () => {
    const seen: number[] = [];
    let any = 0;
    subscribeDrafts(CONV, (d) => seen.push(d.length));
    subscribeAnyDrafts(() => { any++; });
    saveDraft(CONV, box('one'));
    saveDraft(OTHER, box('two'));
    expect(readDrafts(CONV)).toHaveLength(1);
    expect(readDrafts(OTHER)).toHaveLength(1);
    expect(seen).toEqual([1]);
    expect(any).toBe(2);
  });
});

describe('takeDraft', () => {
  it('an empty box takes the draft out', () => {
    saveDraft(CONV, box('note'));
    const id = readDrafts(CONV)[0].id;
    const r = takeDraft(CONV, id, box(''));
    expect(r.ok && r.draft.text).toBe('note');
    expect(readDrafts(CONV)).toHaveLength(0);
  });

  it('a non-empty box is SWAPPED into the opened draft\'s slot — nothing lost', () => {
    saveDraft(CONV, box('first'));
    saveDraft(CONV, box('second'));
    saveDraft(CONV, box('third'));
    const second = readDrafts(CONV)[1].id;
    const r = takeDraft(CONV, second, box('typing now'));
    expect(r.ok && r.draft.text).toBe('second');
    expect(readDrafts(CONV).map((d) => d.text)).toEqual(['first', 'typing now', 'third']);
  });

  it('a full shelf can still swap', () => {
    for (let i = 0; i < MAX_DRAFTS; i++) saveDraft(CONV, box(`n${i}`));
    const r = takeDraft(CONV, readDrafts(CONV)[0].id, box('box'));
    expect(r.ok).toBe(true);
    expect(readDrafts(CONV)).toHaveLength(MAX_DRAFTS);
    expect(readDrafts(CONV)[0].text).toBe('box');
  });

  it('when the box cannot be kept, nothing is taken', () => {
    saveDraft(CONV, box('keep me'));
    const id = readDrafts(CONV)[0].id;
    const r = takeDraft(CONV, id, box('x', [{ id: 'u', kind: 'image', name: 'p', uploading: true }]));
    expect(r.ok).toBe(false);
    expect(readDrafts(CONV).map((d) => d.text)).toEqual(['keep me']);
  });

  it('deleteDraft drops one', () => {
    saveDraft(CONV, box('a'));
    saveDraft(CONV, box('b'));
    deleteDraft(CONV, readDrafts(CONV)[0].id);
    expect(readDrafts(CONV).map((d) => d.text)).toEqual(['b']);
  });
});

describe('seedDrafts (from the roster on load)', () => {
  it('seeds a conversation once, coercing hostile input', () => {
    seedDrafts(CONV, [
      { id: 'd1', text: 'hello', chips: [{ kind: 'file', name: 'a', path: '/a' }, { kind: 'evil', name: 'x' }], quote: null, savedAt: 5 },
      { id: 'd1', text: 'duplicate id' },
      { id: 'd2', text: '   ' },
      'junk',
    ]);
    expect(readDrafts(CONV)).toEqual([{ id: 'd1', text: 'hello', chips: [{ kind: 'file', name: 'a', path: '/a' }], quote: null, savedAt: 5 }]);
  });

  it('never overwrites drafts this app run already holds', () => {
    saveDraft(CONV, box('live'));
    seedDrafts(CONV, [{ id: 'old', text: 'from file' }]);
    expect(readDrafts(CONV).map((d) => d.text)).toEqual(['live']);
  });

  it('labels a draft by its first line', () => {
    saveDraft(CONV, box('\n  first line\nsecond'));
    expect(draftLabel(readDrafts(CONV)[0])).toBe('first line');
  });
});

describe('allDrafts / seedAllDrafts (the roster map)', () => {
  const U1 = '0b8f6a2e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
  it('sends only real conversation ids and seeds them back', () => {
    saveDraft(U1, box('keep'));
    saveDraft('agents-channel', box('in memory only'));
    const map = allDrafts();
    expect(Object.keys(map)).toEqual([U1]);
    __resetDraftsForTests();
    seedAllDrafts(JSON.parse(JSON.stringify(map)));
    expect(readDrafts(U1).map((d) => d.text)).toEqual(['keep']);
  });
});

describe('server roster (agent-sessions.ts): drafts are a map by conversation, not per tab', () => {
  const U1 = '0b8f6a2e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
  const U2 = '1b8f6a2e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
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
  const d = (id: string, text: string) => ({ id, text, chips: [], quote: null, savedAt: 1 });

  it('round-trips drafts for a conversation with NO open tab (closed tab, Super Agent)', async () => {
    expect(await put({ sessions: [], chatPermissionMode: 'auto', drafts: { [U1]: [d('a', 'note')] } })).toBe(200);
    const body = await get();
    expect(body.drafts).toEqual({ [U1]: [d('a', 'note')] });
  });

  it('a PUT that does not mention drafts keeps the stored ones; `{}` clears them', async () => {
    await put({ sessions: [], drafts: { [U1]: [d('a', 'note')] } });
    await put({ sessions: [] });
    expect((await get()).drafts).toEqual({ [U1]: [d('a', 'note')] });
    await put({ sessions: [], drafts: {} });
    expect((await get()).drafts).toBeUndefined();
  });

  it('coerces: non-UUID keys, malformed drafts and over-cap lists', () => {
    const many = Array.from({ length: MAX_DRAFTS + 3 }, (_, i) => d(`d${i}`, `t${i}`));
    const map = server.coerceDraftMap({
      [U1]: many,
      'not-a-uuid': [d('x', 'y')],
      [U2]: [{ id: 1, text: 'x' }, { id: 'ok', text: 'y'.repeat(MAX_DRAFT_TEXT + 50), quote: 7 }],
    })!;
    expect(Object.keys(map).sort()).toEqual([U1, U2].sort());
    expect(map[U1]).toHaveLength(MAX_DRAFTS);
    expect(map[U2]).toHaveLength(1);
    expect(map[U2][0].text).toHaveLength(MAX_DRAFT_TEXT);
    expect(map[U2][0].quote).toBeNull();
    expect(server.coerceDraftMap({ [U1]: [] })).toBeUndefined();
  });

  it('mirrors the client caps (drift test)', () => {
    expect(server.MAX_DRAFTS).toBe(MAX_DRAFTS);
    expect(server.MAX_DRAFT_TEXT).toBe(MAX_DRAFT_TEXT);
    expect(server.MAX_DRAFT_QUOTE).toBe(MAX_DRAFT_QUOTE);
    expect(server.MAX_DRAFT_CHIPS).toBe(MAX_DRAFT_CHIPS);
    expect(server.MAX_DRAFT_CONVERSATIONS).toBe(MAX_DRAFT_CONVERSATIONS);
    // The server's byte cap must leave the client's whole budget room on top of tab metadata.
    const src = readFileSync(join(__dirname, '../../src/server/routes/agent-sessions.ts'), 'utf-8');
    const m = /const MAX_BYTES = (\d+) \* (\d+);/.exec(src);
    expect(m).not.toBeNull();
    expect(Number(m![1]) * Number(m![2])).toBeGreaterThanOrEqual(DRAFTS_BUDGET_BYTES + 64 * 1024);
  });
});
