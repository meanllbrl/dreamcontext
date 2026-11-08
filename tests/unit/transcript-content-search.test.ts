/**
 * Content search for the history picker: a past session is findable by what was SAID in it (the
 * owner's messages and the agent's replies), not only by its title — `transcript-content-index.ts`
 * feeding `listPastSessions`, through the route's `computeChatSessions`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFileSync, mkdirSync, rmSync, writeFileSync, utimesSync, openSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  clearTranscriptSessionCaches, contentSnippet, listTranscriptFiles, resolveProjectDirs,
} from '../../src/lib/transcript-sessions.js';
import {
  clearContentIndex, contentCharsHeld, contentOf, contentReadsForTest, ensureContentIndex, messageTextOf, setContentBudgetForTest,
} from '../../src/lib/transcript-content-index.js';
import { renameSync, rmdirSync } from 'node:fs';
import { computeChatSessions } from '../../src/server/routes/agent-chat-sessions.js';

const PROJECT = '/Users/tester/projects/demo';
const SLUG = '-Users-tester-projects-demo';
const CONTEXT = `${PROJECT}/_dream_context`;

const A = 'aaaaaaaa-1111-4111-8111-111111111111';
const B = 'bbbbbbbb-2222-4222-8222-222222222222';
const C = 'cccccccc-3333-4333-8333-333333333333';

const user = (text: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  type: 'user', isSidechain: false, cwd: PROJECT, gitBranch: 'main', timestamp: '2026-10-01T10:00:00.000Z',
  message: { role: 'user', content: [{ type: 'text', text }] }, ...extra,
});
const reply = (text: string) => JSON.stringify({
  type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const toolUse = () => JSON.stringify({
  type: 'assistant', isSidechain: false,
  message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] },
});
const toolResult = (out: string) => JSON.stringify({
  type: 'user', isSidechain: false,
  message: { role: 'user', content: [{ tool_use_id: 't1', type: 'tool_result', content: out }] },
  toolUseResult: { stdout: out },
});
const file = (lines: string[]) => `${lines.join('\n')}\n`;

let home = '';
let dir = '';

function write(id: string, raw: string, mtimeSec?: number): string {
  const p = join(dir, `${id}.jsonl`);
  writeFileSync(p, raw);
  if (mtimeSec !== undefined) utimesSync(p, mtimeSec, mtimeSec);
  return p;
}

async function search(q: string, extra: Record<string, string> = {}) {
  return await computeChatSessions(CONTEXT, { q, ...extra }, { home, waitMs: 60_000 }) as {
    sessions: Array<{ id: string; title: string; match?: string; matchIn?: string }>;
    total: number;
    indexing?: { done: number; total: number };
  };
}

beforeEach(() => {
  clearTranscriptSessionCaches();
  clearContentIndex();
  home = join(tmpdir(), `dc-content-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  dir = join(home, '.claude', 'projects', SLUG);
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  clearTranscriptSessionCaches();
  clearContentIndex();
  rmSync(home, { recursive: true, force: true });
});

describe('messageTextOf', () => {
  it('keeps your messages and the agent text, drops tool traffic, stubs, meta and sidechains', () => {
    expect(messageTextOf(user('hello  there'))).toBe('hello there');
    expect(messageTextOf(reply('a reply'))).toBe('a reply');
    expect(messageTextOf(toolUse())).toBe('');
    expect(messageTextOf(toolResult('zebra output'))).toBe('');
    expect(messageTextOf(user('<system-reminder>x</system-reminder>'))).toBe('');
    expect(messageTextOf(user('meta', { isMeta: true }))).toBe('');
    expect(messageTextOf(user('sub agent', { isSidechain: true }))).toBe('');
    expect(messageTextOf('{"type":"user", broken')).toBe('');
    expect(messageTextOf(JSON.stringify({ type: 'attachment', content: 'zebra' }))).toBe('');
  });

  it('a person typing a tool marker is still a message (the marker arrives escaped)', () => {
    expect(messageTextOf(user('why does "type":"tool_result" show up?'))).toContain('tool_result');
  });
});

describe('content search', () => {
  it('title hit: a session named by the query ranks first, matched on its title', async () => {
    write(A, file([user('first prompt'), reply('we talked about the kangaroo budget')]), 1_700_000_900);
    write(B, file([user('kangaroo budget plan'), reply('ok')]), 1_700_000_100);
    const r = await search('kangaroo');
    expect(r.sessions.map((s) => s.id)).toEqual([B, A]);
    expect(r.sessions[0]).toMatchObject({ matchIn: 'title', match: 'kangaroo budget plan' });
    expect(r.sessions[1].matchIn).toBe('content');
  });

  it('content-only hit: a word said only by the agent, deep in a session, finds it', async () => {
    const filler = Array.from({ length: 400 }, (_, i) => [user(`step ${i} of the routine`), reply(`done ${i}`)]).flat();
    write(A, file([user('refactor the dashboard'), ...filler.slice(0, 400),
      reply('The root cause was the Pelikan cache eviction in the session store.'), ...filler.slice(400)]));
    write(B, file([user('something unrelated'), reply('nothing to see')]));
    const r = await search('pelikan');
    expect(r.sessions.map((s) => s.id)).toEqual([A]);
    expect(r.sessions[0].title).toBe('refactor the dashboard');
    expect(r.sessions[0].matchIn).toBe('content');
    expect(r.total).toBe(1);
  });

  it('snippet: the matched message, clipped around the term, original case kept', async () => {
    const long = `${'lead-in words '.repeat(20)}the İstanbul gateway timed out ${'trailing words '.repeat(20)}`;
    write(A, file([user('deploy notes'), reply(long)]));
    const [row] = (await search('istanbul gateway')).sessions;
    expect(row.match).toMatch(/^….*İstanbul gateway.*…$/);
    expect(row.match!.length).toBeLessThan(160);
    expect(contentSnippet('a\nfoo Bar baz\nc', 'a\nfoo bar baz\nc', 'bar', 3)).toBe('…oo Bar ba…');
  });

  it('phrase beats scattered words, then more hits beat fewer, all words required', async () => {
    write(A, file([user('one'), reply('green apple'), reply('apple again apple')]), 1_700_000_100);
    write(B, file([user('two'), reply('the apple is green')]), 1_700_000_900);
    write(C, file([user('three'), reply('only green here')]), 1_700_000_500);
    const r = await search('green apple');
    expect(r.sessions.map((s) => s.id)).toEqual([A, B]);
  });

  it('large transcript: tens of MB of tool output are skipped, the event loop keeps turning', async () => {
    const p = join(dir, `${A}.jsonl`);
    const fd = openSync(p, 'w');
    writeSync(fd, `${user('big session')}\n`);
    const blob = 'x'.repeat(2 * 1024 * 1024);
    for (let i = 0; i < 15; i++) {
      writeSync(fd, `${toolUse()}\n${toolResult(blob)}\n${reply(`checkpoint ${i}`)}\n`);
      if (i === 9) writeSync(fd, `${reply('found the wombat regression')}\n`);
    }
    closeSync(fd);
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 1);
    const t0 = performance.now();
    const r = await search('wombat');
    const ms = performance.now() - t0;
    clearInterval(timer);
    expect(r.sessions.map((s) => s.id)).toEqual([A]);
    expect(r.sessions[0].match).toContain('wombat');
    expect(ticks).toBeGreaterThan(0);
    // ~30 MB, nothing kept but a few lines.
    expect(contentOf(p)!.text.length).toBeLessThan(1000);
    expect(ms).toBeLessThan(5000);
  });

  it('incremental: an appended reply is found after the next search, the rest is not re-read', async () => {
    const p = write(A, file([user('ongoing'), reply('first')]));
    expect((await search('quokka')).total).toBe(0);
    appendFileSync(p, `${reply('now the quokka shows up')}\n`);
    expect((await search('quokka')).sessions.map((s) => s.id)).toEqual([A]);
    expect(contentOf(p)!.text).toBe('ongoing\nfirst\nnow the quokka shows up');
  });

  it('a half-written last line is read on the next pass, not lost', async () => {
    const p = write(A, `${user('ongoing')}\n${reply('the narwhal').slice(0, 30)}`);
    await ensureContentIndex(listTranscriptFiles(PROJECT, home).files).promise;
    expect(contentOf(p)!.text).toBe('ongoing');
    writeFileSync(p, file([user('ongoing'), reply('the narwhal')]));
    expect((await search('narwhal')).total).toBe(1);
  });

  it('a search during a build answers partially and says so', async () => {
    // Enough transcripts that the build cannot finish before a zero wait expires.
    for (let i = 0; i < 200; i++) write(`${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`, file([user(`chat ${i}`), reply('ibis '.repeat(2000))]));
    const r = await computeChatSessions(CONTEXT, { q: 'ibis' }, { home, waitMs: 0 }) as { indexing?: unknown };
    expect(r.indexing).toBeDefined();
    expect(await search('ibis')).not.toHaveProperty('indexing');
  });

  it('an unqueried listing does not wait and carries no match', async () => {
    write(A, file([user('hello'), reply('world')]));
    const r = await computeChatSessions(CONTEXT, {}, { home }) as { sessions: Array<{ match?: string }>; indexing?: unknown };
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0].match).toBeUndefined();
    expect(r.indexing).toBeUndefined();
  });
});

describe('index bookkeeping (end-review fixes)', () => {
  const statOf = (p: string) => listTranscriptFiles(PROJECT, home).files.find((f) => f.path === p)!;

  it('two overlapping builds never read one transcript twice', async () => {
    const big = write(A, file([user('start'), ...Array.from({ length: 3000 }, (_, i) => reply(`marker ${i} ${'pad '.repeat(50)}`))]));
    const b1 = ensureContentIndex([statOf(big)]);
    appendFileSync(big, `${reply('appended line')}\n`);
    const other = write(B, file([user('other'), reply('x')]));
    const b2 = ensureContentIndex([statOf(big), statOf(other)]);
    await Promise.all([b1.promise, b2.promise]);
    const text = contentOf(big)!.text;
    expect(text.split('\n').filter((l) => l === 'appended line')).toHaveLength(1);
    expect(text.split('\n').filter((l) => l.startsWith('marker 7 '))).toHaveLength(1);
    expect(contentCharsHeld()).toBe((contentOf(big)!.text.length + contentOf(other)!.text.length) * 2);
  });

  it('a spent budget evicts the OLDEST sessions for newer ones, never the reverse', async () => {
    setContentBudgetForTest(400 * 1024);
    const body = (w: string) => file([user(w), ...Array.from({ length: 40 }, () => reply(`${w} ${'z'.repeat(2000)}`))]);
    write(A, body('oldest'), 1_700_000_000);
    write(B, body('middle'), 1_700_000_500);
    expect((await search('oldest')).total).toBe(1);
    // A new session arrives: room is made by evicting the oldest, not by skipping the newest.
    write(C, body('newest'), 1_700_001_000);
    const newest = await search('zzzz newest');
    expect(newest.sessions.map((s) => s.id)).toEqual([C]);
    expect(contentCharsHeld()).toBeLessThanOrEqual(400 * 1024);
    expect(contentOf(join(dir, `${A}.jsonl`))).toBeUndefined();
  });

  it('per-session text is bounded: the head is kept, the newest survives, the middle goes', async () => {
    const p = write(A, file([user('first words'), ...Array.from({ length: 200 }, (_, i) => reply(`m${i} ${'w'.repeat(3000)}`)), reply('the very last reply')]));
    await search('anything');
    const text = contentOf(p)!.text;
    expect(text.length).toBeLessThanOrEqual(256 * 1024 * 1.5);
    expect(text.startsWith('first words')).toBe(true);
    expect(text.endsWith('the very last reply')).toBe(true);
    expect(text).not.toContain('m60 ');
  });

  it('a transcript that could not be read is retried, not remembered as empty', async () => {
    const p = write(A, file([user('locked'), reply('the heron')]));
    const f = statOf(p);
    // A folder where the file was: unreadable for root and on Windows too (chmod 000 is neither).
    renameSync(p, `${p}.away`);
    mkdirSync(p);
    await ensureContentIndex([f]).promise;
    expect(contentOf(p)).toBeUndefined();
    rmdirSync(p);
    renameSync(`${p}.away`, p);
    // Same mtime and size as the failed attempt: only an unstamped entry is read again.
    await ensureContentIndex([f]).promise;
    expect(contentOf(p)!.text).toBe('locked\nthe heron');
  });

  it('a full index does not re-read the sessions that did not fit, until they change', async () => {
    setContentBudgetForTest(300 * 1024);
    const body = (w: string) => file([user(w), ...Array.from({ length: 40 }, () => reply(`${w} ${'z'.repeat(2000)}`))]);
    write(A, body('newest'), 1_700_001_000);
    const old = write(B, body('oldest'), 1_700_000_000);
    const files = () => listTranscriptFiles(PROJECT, home).files;
    await ensureContentIndex(files()).promise;
    expect(contentOf(old)).toBeUndefined();
    const before = contentReadsForTest();
    await ensureContentIndex(files()).promise;
    await ensureContentIndex(files()).promise;
    expect(contentReadsForTest()).toBe(before);
    expect(contentOf(old)).toBeUndefined();
    // Once it changes, it is tried again.
    appendFileSync(old, `${reply('more')}\n`);
    utimesSync(old, 1_700_000_100, 1_700_000_100); // still the older one
    await ensureContentIndex(files()).promise;
    expect(contentReadsForTest()).toBe(before + 1);
    expect(contentCharsHeld()).toBeLessThanOrEqual(300 * 1024);
  });

  it('a long session of many short turns stays cheap once it is full', async () => {
    const p = write(A, file([user('chatty'), ...Array.from({ length: 30_000 }, (_, i) => reply(`short reply number ${i} with a few words`))]));
    const t0 = performance.now();
    await ensureContentIndex(listTranscriptFiles(PROJECT, home).files).promise;
    expect(performance.now() - t0).toBeLessThan(1500);
    const text = contentOf(p)!.text;
    expect(text.length).toBeLessThanOrEqual(256 * 1024 * 1.5);
    expect(text.endsWith('short reply number 29999 with a few words')).toBe(true);
  });

  it('a pasted paragraph is cut to a few distinct words', async () => {
    write(A, file([user('alpha'), reply('alpha beta')]));
    expect((await search(`${'alpha '.repeat(80)}beta`)).total).toBe(1);
  });
});

describe('every Claude account', () => {
  it('lists sessions from an account sandbox with its own projects dir', async () => {
    write(A, file([user('home account chat'), reply('ok')]));
    const sandbox = join(home, '.dreamcontext', 'claude-accounts', 'work');
    const other = join(sandbox, 'projects', SLUG);
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, `${B}.jsonl`), file([user('work account chat'), reply('the platypus plan')]));
    writeFileSync(join(home, '.dreamcontext', 'claude-accounts.json'), JSON.stringify({
      accounts: [
        { id: 'me', accountUuid: 'u0', email: 'a@example.com', organizationUuid: 'o', organizationName: '', tier: 'max', configDir: null, preferred: true },
        { id: 'work', accountUuid: 'u1', email: 'b@example.com', organizationUuid: 'o', organizationName: '', tier: 'max', configDir: sandbox, preferred: false },
      ],
    }));
    expect(resolveProjectDirs(PROJECT, home)).toHaveLength(2);
    expect((await search('platypus')).sessions.map((s) => s.id)).toEqual([B]);
    expect((await computeChatSessions(CONTEXT, {}, { home }) as { total: number }).total).toBe(2);
  });
});
