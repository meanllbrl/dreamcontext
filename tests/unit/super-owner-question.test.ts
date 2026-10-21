/**
 * A question the Super Agent puts to the owner REACHES him, and the agent is told whether it did
 * (Tilki, 2026-10-21: three `super queue ask`s sat as a job-bar line while the agent said "I
 * asked you"; the one visible path, AskUserQuestion, locked its turn for 82 minutes).
 *
 * Reproduced on main 3da65546: the escalation rang only from the job bar (a component that is
 * mounted only on the Super stage), the escalating turn's notch row and banner were suppressed,
 * nothing pushed to the phone, and the reply was `escalated: true` whatever happened. What
 * already worked stays pinned where it is: the job bar's once-per-item alarm
 * (super-handover-model.test.ts `headAlarmOnce`) and the glance's head row (super-inbox.test.ts
 * `superAttentionRows`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-owner-q-home-`);
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { _resetChatRegistry } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { readSuperStateView } from '../../dashboard/src/lib/superTypes.js';
import { SUPER_BRIEF_REV, SUPER_SHOW_SECTION, emptySuperState } from '../../src/lib/super/types.js';
import { BATCH_LAST_LINE, _resetSuperInbox, superView, takeSuperEscalation } from '../../src/lib/super/inbox.js';
import {
  _resetOwnerQuestions, announceOwnerHead, noteNotchPoll, ownerQuestionReach, seedOwnerHead, setOwnerQuestionSinks,
} from '../../src/lib/super/owner-question.js';
import { PushNotifier } from '../../src/lib/handsfree/mac/push-notifier.js';
import { handleSuperVerb } from '../../src/server/routes/super.js';
import { superBriefing } from '../../src/server/chat-modes.js';
import { mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';

const SUPER = 'super-0001-aaaa';
let dir: string;
let root: string;
let token = '';
let banners: Array<{ title: string; body: string; link: string | null }>;
let pushes: Array<{ vault: string; sessionId: string; key: string; body: string }>;
let lookingAt: string | null;
let lookingSession: string | null;
let phones: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'super-owner-q-'));
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  _resetChatRegistry();
  resetSuperIndex();
  _resetSuperInbox();
  resetWindowControl();
  _resetOwnerQuestions();
  banners = [];
  pushes = [];
  lookingAt = null;
  lookingSession = null;
  phones = 0;
  setOwnerQuestionSinks({
    presence: () => ({ vault: lookingAt, session: lookingSession }),
    banner: (title, body, link) => { banners.push({ title, body, link }); return true; },
    push: (q) => { if (phones) pushes.push(q); return phones; },
  });
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({
    ...emptySuperState(), session: SUPER, enabled: true,
    children: { c1: { sessionId: 'c1', brief: '', adopted: true, startedAt: 1 }, c2: { sessionId: 'c2', brief: '', adopted: true, startedAt: 1 } },
    queue: [
      { id: 'q-ask1', sessionId: 'c1', kind: 'question', requestId: 'r-1', state: 'delivered', createdAt: 2 },
      { id: 'q-ask2', sessionId: 'c2', kind: 'question', requestId: 'r-2', state: 'delivered', createdAt: 3 },
    ],
  }));
  token = mintWindowToken({ send: () => true, vault: 'acme', contextRoot: root, sessionId: SUPER, mode: 'super' }).token;
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); _resetOwnerQuestions(); });

function req(body: unknown): IncomingMessage {
  const r = new PassThrough() as unknown as IncomingMessage & PassThrough;
  Object.assign(r, { headers: { host: '127.0.0.1:4173', 'x-dreamcontext-window-token': token }, socket: { remoteAddress: '127.0.0.1' }, method: 'POST', url: '/' });
  setImmediate(() => { (r as unknown as PassThrough).end(JSON.stringify(body)); });
  return r;
}
function res(): ServerResponse & { status: number; json: Record<string, unknown> } {
  const out = { status: 0, json: {} as Record<string, unknown> } as ServerResponse & { status: number; json: Record<string, unknown> };
  (out as unknown as { writeHead: (s: number) => void }).writeHead = (s: number) => { out.status = s; };
  (out as unknown as { end: (b?: string) => void }).end = (b?: string) => { out.json = b ? JSON.parse(b) : {}; };
  return out;
}
async function verb(name: string, body: Record<string, unknown>) {
  const r = res();
  await handleSuperVerb(req(body), r, { verb: name });
  return r;
}
const result = (r: { json: Record<string, unknown> }) => (r.json.result ?? r.json) as Record<string, unknown>;

describe('super queue ask reaches the owner off the Super stage', () => {
  it('away from the project: a routable banner to the super stage, and the reply says it reached him', async () => {
    const r = await verb('queue-ask', { item: 'q-ask1', text: 'Postgres or sqlite?' });
    expect(r.status).toBe(200);
    expect(banners).toEqual([{ title: 'Super Agent asks · acme', body: 'Postgres or sqlite?', link: `dreamcontext://project/acme/session/${SUPER}` }]);
    expect(result(r)).toMatchObject({ escalated: true, waiting: false, shown: true, reached: true, via: ['banner'] });
    // He has it: the escalating turn's end is no second ping.
    expect(takeSuperEscalation(SUPER)).toBe(true);
  });

  it('nobody saw it: reached false, the note says so, and the turn keeps its own notch row', async () => {
    setOwnerQuestionSinks({ banner: () => false });
    const r = await verb('queue-ask', { item: 'q-ask1', text: 'Postgres or sqlite?' });
    expect(result(r)).toMatchObject({ escalated: true, shown: true, reached: false, via: [] });
    expect(String(result(r).note)).toMatch(/NOT seen/);
    expect(String(result(r).note)).toMatch(/do not tell him you asked/);
    expect(takeSuperEscalation(SUPER)).toBe(false);
  });

  it('on the Super stage: no banner (he is on it), the screen carries it; a polled notch is listed', async () => {
    lookingAt = 'acme';
    lookingSession = SUPER;
    noteNotchPoll();
    const r = await verb('queue-ask', { item: 'q-ask1', text: 'Postgres or sqlite?' });
    expect(banners).toEqual([]);
    expect(result(r)).toMatchObject({ reached: true, via: ['screen', 'notch'] });
  });

  it('in the project on another page: no banner over his window, and a notch alone is NOT reached', async () => {
    lookingAt = 'acme';
    noteNotchPoll();
    const r = await verb('queue-ask', { item: 'q-ask1', text: 'Postgres or sqlite?' });
    expect(banners).toEqual([]);
    expect(result(r)).toMatchObject({ reached: false, via: ['notch'] });
    expect(String(result(r).note)).toMatch(/only the notch lists it/);
    expect(takeSuperEscalation(SUPER)).toBe(false);
  });

  it('the state view names the items the server bannered, and the window reads it back', async () => {
    await verb('queue-ask', { item: 'q-ask1', text: 'Postgres or sqlite?' });
    const view = superView(root, await readSuperState(root));
    expect(view.bannered).toEqual(['q-ask1']);
    expect(readSuperStateView(JSON.parse(JSON.stringify(view)))?.bannered).toEqual(['q-ask1']);
    // No banner posted (a Mac without the notifier bundle): nothing named, the window posts its own.
    _resetOwnerQuestions();
    setOwnerQuestionSinks({ banner: () => false });
    await verb('queue-ask', { item: 'q-ask2', text: 'Which region?' });
    expect(superView(root, await readSuperState(root)).bannered).toBeUndefined();
  });

  it('hands-free on: a question push into the super chat', async () => {
    phones = 1;
    const r = await verb('queue-ask', { item: 'q-ask1', text: 'Postgres or sqlite?' });
    expect(pushes).toEqual([{ vault: 'acme', sessionId: SUPER, key: 'super-ask:q-ask1', title: 'Super Agent asks · acme', body: 'Postgres or sqlite?' }]);
    expect(result(r).via).toEqual(['banner', 'phone']);
  });

  it('a second question waits unseen behind the first, and is announced when it comes up', async () => {
    await verb('queue-ask', { item: 'q-ask1', text: 'Postgres or sqlite?' });
    const two = await verb('queue-ask', { item: 'q-ask2', text: 'Which region?' });
    expect(result(two)).toMatchObject({ waiting: true, shown: false, ahead: 1, reached: false });
    expect(String(result(two).note)).toMatch(/waits behind 1/);
    expect(banners).toHaveLength(1);
    await verb('queue-done', { item: 'q-ask1' });
    expect(banners.map((b) => b.body)).toEqual(['Postgres or sqlite?', 'Which region?']);
  });

  it('once per item: a re-caption does not ring again', async () => {
    await verb('queue-ask', { item: 'q-ask1', text: 'Postgres or sqlite?' });
    await verb('queue-ask', { item: 'q-ask1', text: 'Postgres or sqlite, really?' });
    expect(banners).toHaveLength(1);
  });
});

describe('super ask (the agent\'s own question)', () => {
  it('announces, answers honestly, and its answer is the owner\'s next message', async () => {
    const r = await verb('ask', { text: 'Ship the video today?', options: ['Yes', 'Tomorrow'] });
    expect(r.status).toBe(200);
    expect(banners.map((b) => [b.title, b.body])).toEqual([['Super Agent asks · acme', 'Ship the video today?']]);
    expect(result(r)).toMatchObject({ asked: true, shown: true, reached: true, via: ['banner'] });
    expect(String(result(r).note)).toMatch(/next message to you/);
  });
});

describe('the announcement edge', () => {
  const base = { enabled: true, session: SUPER };
  const q = (id: string, at: number) => ({ id, sessionId: 'c1', kind: 'question' as const, state: 'escalated' as const, ownerText: id, createdAt: at });

  it('a head already open at boot is seeded silently', () => {
    const head = q('q-old', 1);
    seedOwnerHead(head);
    announceOwnerHead(() => 'acme', { ...base, queue: [head] }, head);
    expect(banners).toEqual([]);
  });

  it('a permission is never announced here (the window rings it from the child\'s own request)', () => {
    const perm = { id: 'q-p', sessionId: 'c1', kind: 'permission' as const, requestId: 'p', state: 'pending' as const, createdAt: 1 };
    announceOwnerHead(() => 'acme', { ...base, queue: [perm] }, perm);
    expect(banners).toEqual([]);
    expect(ownerQuestionReach({ queue: [perm, q('q-x', 2)] }, 'q-x')).toMatchObject({ shown: false, ahead: 1 });
  });

  it('nothing while not handed over', () => {
    const head = q('q-off', 1);
    announceOwnerHead(() => 'acme', { ...base, enabled: false, queue: [head] }, head);
    expect(banners).toEqual([]);
  });
});

describe('the phone push (hands-free)', () => {
  function notifier(exposed: string[]) {
    const sent: Array<{ kind: string; url: string; body: string }> = [];
    const n = new PushNotifier({
      exposed: () => exposed,
      store: () => ({ entries: () => [['dev1', { endpoint: 'https://push.example/x', keys: { p256dh: 'a', auth: 'b' } }]], remove: () => true }) as never,
      deviceValid: () => true,
      showingDevice: () => null,
      send: async (_s, p) => { sent.push(p); return { ok: true, status: 201, gone: false }; },
    });
    return { n, sent };
  }

  it('pushes one question into the super chat, once per key', async () => {
    const { n, sent } = notifier(['acme']);
    const one = n.pushOwnerQuestion({ vault: 'acme', sessionId: SUPER, key: 'super-ask:q1', title: 'Super Agent asks · acme', body: 'Ship it?' });
    expect(one.targeted).toBe(1);
    expect(await one.done).toBe(1);
    expect(n.pushOwnerQuestion({ vault: 'acme', sessionId: SUPER, key: 'super-ask:q1', title: 't', body: 'b' }).targeted).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'question', body: 'Ship it?' });
    expect(decodeURIComponent(sent[0].url)).toContain(`dreamcontext://project/acme/session/${SUPER}`);
  });

  it('a project Mac mode does not expose gets nothing', () => {
    const { n } = notifier(['other']);
    expect(n.pushOwnerQuestion({ vault: 'acme', sessionId: SUPER, key: 'k', title: 't', body: 'b' }).targeted).toBe(0);
  });
});

describe('the briefing sends every owner question down the non-blocking path', () => {
  it('names super ask / queue ask, and says AskUserQuestion locks the turn', () => {
    const brief = superBriefing(null);
    expect(brief).toMatch(/super ask/);
    expect(brief).toMatch(/AskUserQuestion[^\n]*(locks|holds)[^\n]*turn|(locks|holds) your turn[^\n]*AskUserQuestion/i);
    expect(brief).toMatch(/reached/);
    expect(SUPER_SHOW_SECTION).not.toMatch(/ask with AskUserQuestion/);
    expect(SUPER_SHOW_SECTION).toMatch(/super ask/);
    expect(BATCH_LAST_LINE).toMatch(/never AskUserQuestion/);
    expect(BATCH_LAST_LINE).toMatch(/write him that question in this turn/);
  });

  it('a running super session is re-briefed (the revision moved)', () => {
    expect(SUPER_BRIEF_REV).toBeGreaterThanOrEqual(3);
  });
});
