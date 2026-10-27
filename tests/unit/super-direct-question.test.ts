/**
 * A child's question reaches the OWNER at once (owner 2026-10-27: "the question lands in front of
 * me much too late"). Measured before: a child's AskUserQuestion reached him only after the Super
 * ran an event turn and escalated it (`super queue ask`), about 40 s at the median, and minutes
 * when the Super was busy or another question was open with him.
 *
 * Now the item is `direct`: his bar shows it from birth, named by its job, one click from the
 * child's chat (where the child's own card answers it), and the server's banner opens that chat.
 * The Super still hears it and may answer it first. Whoever answers, the child leaves `asking` and
 * the item closes for both; a second answer is refused as stale.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-direct-q-home-`);
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { _resetChatRegistry, registerChat, type ChatHandle } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { emptySuperState } from '../../src/lib/super/types.js';
import {
  _resetSuperInbox, _superInboxDrained, attachSuperInbox, ownerQuestionOpen, startSuperInbox, superQueueHead, superTurnEnded,
  type SuperEventFrame, type SuperInbox,
} from '../../src/lib/super/inbox.js';
import { _resetOwnerQuestions, setOwnerQuestionSinks } from '../../src/lib/super/owner-question.js';
import { handleSuperVerb } from '../../src/server/routes/super.js';
import { deliverSuperResult, mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';
import { needsOwner, queueHead, superNotepad } from '../../dashboard/src/components/sleepy/super/superHandover.js';

const SUPER = 'sup-direct-1';
const C1 = 'child-0001-aaaa';
const C2 = 'child-0002-bbbb';
const W = { timeout: 10_000 };
let dir: string;
let root: string;
let token = '';
let banners: Array<{ title: string; body: string; link: string | null }>;
const handles = new Map<string, ChatHandle>();

const reg = (sid: string, mode = 'basic'): ChatHandle => {
  const h = registerChat({ sessionId: sid, conversationId: null, vault: 'acme', mode });
  handles.set(sid, h);
  return h;
};
const askQuestion = (h: ChatHandle, requestId: string, question = 'Postgres or sqlite?') => h.observe({
  type: 'control_request', request_id: requestId,
  request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question, options: [{ label: 'postgres' }, { label: 'sqlite' }] }] } },
});

function fakeInbox(busy: { on: boolean }) {
  const delivered: Array<{ text: string; event: SuperEventFrame }> = [];
  const inbox: SuperInbox = {
    id: `inbox-${Math.random()}`, sessionId: SUPER, attached: () => true, idle: () => !busy.on,
    deliver: async (text, event) => { delivered.push({ text, event }); return true; },
  };
  return { inbox, delivered };
}

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
async function superAnswer(child: string, requestId: string) {
  const r = res();
  await handleSuperVerb(req({ child, requestId, choices: ['postgres'] }), r, { verb: 'answer' });
  return r;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'super-direct-q-'));
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  _resetChatRegistry();
  resetSuperIndex();
  _resetSuperInbox();
  resetWindowControl();
  _resetOwnerQuestions();
  handles.clear();
  banners = [];
  setOwnerQuestionSinks({
    presence: () => ({ vault: null, session: null }),
    banner: (title, body, link) => { banners.push({ title, body, link }); return true; },
    push: () => 0,
  });
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({
    ...emptySuperState(), session: SUPER, enabled: true,
    children: { [C1]: { sessionId: C1, brief: 'Pick the database', adopted: true, startedAt: 1 } },
  }));
  // The window: a `super answer` it carries out answers the child through its own session.
  token = mintWindowToken({
    vault: 'acme', contextRoot: root, sessionId: SUPER, mode: 'super',
    send: (frame) => {
      if (frame.subtype === 'super_command' && frame.verb === 'answer') {
        const a = frame.args as { child: string; requestId: string };
        setImmediate(() => { handles.get(a.child)?.answered(a.requestId); deliverSuperResult(token, frame.id, { ok: true, result: {} }); });
      }
      return true;
    },
  }).token;
  const sup = reg(SUPER, 'super');
  sup.userSent('');
  sup.observe({ type: 'result' });
  await startSuperInbox([root]);
});
afterEach(async () => {
  await _superInboxDrained();
  _resetSuperInbox();
  _resetOwnerQuestions();
  rmSync(dir, { recursive: true, force: true });
});

const itemOf = async (requestId: string) => (await readSuperState(root)).queue.find((q) => q.requestId === requestId);

describe('a child\'s question is the owner\'s from birth', { timeout: 30_000 }, () => {
  it('his bar leads with it before the Super takes any turn, named by its job, and the banner opens the child', async () => {
    const busy = { on: true };
    const { inbox, delivered } = fakeInbox(busy);
    attachSuperInbox(inbox);
    askQuestion(reg(C1), 'req-1');
    await vi.waitFor(async () => expect(await itemOf('req-1')).toBeDefined(), W);
    const s = await readSuperState(root);
    // The Super is mid-turn: nothing delivered to it yet, and the owner already has it.
    expect(delivered).toHaveLength(0);
    expect(superQueueHead(s)).toMatchObject({ kind: 'question', state: 'pending', direct: true, sessionId: C1 });
    expect(superQueueHead(s)?.ownerText).toContain('Postgres or sqlite?');
    // The window draws the same head (dashboard mirror), and the agenda row opens the child.
    expect(queueHead(s)?.requestId).toBe('req-1');
    expect(needsOwner(superQueueHead(s)!)).toBe(true);
    const rows = superNotepad(s, { superTitle: 'Super', titleFor: () => 'Pick the database' } as never).waiting;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sid: C1, direct: true, chip: 'question' });
    // The server's banner: which job asks, and its link opens THAT child's chat.
    expect(banners).toEqual([{ title: 'Pick the database asks · acme', body: expect.stringContaining('Postgres or sqlite?'), link: `dreamcontext://project/acme/session/${C1}` }]);
    // It never holds the single-question rule.
    expect(ownerQuestionOpen(s)).toBe(false);
    // The Super still hears it when its turn ends, marked as already in front of him.
    busy.on = false;
    superTurnEnded(SUPER);
    await vi.waitFor(() => expect(delivered).toHaveLength(1), W);
    expect(delivered[0].text).toMatch(/event=question status=asking question=req-1 shown=owner/);
  });

  it('the Super answers first: the owner\'s card closes, and his late pick finds nothing to answer', async () => {
    const { inbox, delivered } = fakeInbox({ on: false });
    attachSuperInbox(inbox);
    askQuestion(reg(C1), 'req-2');
    await vi.waitFor(() => expect(delivered).toHaveLength(1), W);
    const r = await superAnswer(C1, 'req-2');
    expect(r.status).toBe(200);
    await vi.waitFor(async () => expect((await itemOf('req-2'))?.state).toBe('done'), W);
    const s = await readSuperState(root);
    expect(superQueueHead(s)).toBeNull();
    expect(queueHead(s)).toBeNull();
  });

  it('the owner answers first: the Super\'s item closes, its answer is refused as stale, and it is never asked again', async () => {
    const busy = { on: true };
    const { inbox, delivered } = fakeInbox(busy);
    attachSuperInbox(inbox);
    const c1 = reg(C1);
    askQuestion(c1, 'req-3');
    await vi.waitFor(async () => expect((await itemOf('req-3'))?.state).toBe('pending'), W);
    // His pick, from the child's own card (the child's session answers it).
    c1.answered('req-3');
    await vi.waitFor(async () => expect((await itemOf('req-3'))?.state).toBe('done'), W);
    expect(superQueueHead(await readSuperState(root))).toBeNull();
    // The Super, still holding the event text from an earlier read, tries anyway: refused.
    const r = await superAnswer(C1, 'req-3');
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ error: 'stale_request' });
    // Its turn ends: the answered question is never delivered.
    busy.on = false;
    superTurnEnded(SUPER);
    await _superInboxDrained();
    expect(delivered.some((d) => d.text.includes('req-3'))).toBe(false);
  });

  it('a question already open with him is never buried: an older one stays at the head', async () => {
    const { inbox } = fakeInbox({ on: true });
    attachSuperInbox(inbox);
    const c1 = reg(C1);
    askQuestion(c1, 'req-old');
    await vi.waitFor(async () => expect(await itemOf('req-old')).toBeDefined(), W);
    const c2 = reg(C2);
    const { writeSuper } = await import('../../src/lib/super/inbox.js');
    await writeSuper(root, (s) => { s.children[C2] = { sessionId: C2, brief: 'Other job', adopted: true, startedAt: 1 }; });
    askQuestion(c2, 'req-new', 'Ship now?');
    await vi.waitFor(async () => expect(await itemOf('req-new')).toBeDefined(), W);
    expect(superQueueHead(await readSuperState(root))?.requestId).toBe('req-old');
    // Announced once each, oldest first: the second rang only when it reached the head.
    expect(banners.map((b) => b.title)).toEqual(['Pick the database asks · acme']);
    c1.answered('req-old');
    await vi.waitFor(async () => expect(superQueueHead(await readSuperState(root))?.requestId).toBe('req-new'), W);
    expect(banners.map((b) => b.title)).toEqual(['Pick the database asks · acme', 'Other job asks · acme']);
  });

  it('a permission stays the owner\'s alone: never direct, never delivered to the Super', async () => {
    const { inbox, delivered } = fakeInbox({ on: false });
    attachSuperInbox(inbox);
    reg(C1).observe({
      type: 'control_request', request_id: 'perm-1',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf build' } },
    });
    await vi.waitFor(async () => expect(await itemOf('perm-1')).toBeDefined(), W);
    await _superInboxDrained();
    expect(await itemOf('perm-1')).toMatchObject({ kind: 'permission' });
    expect((await itemOf('perm-1'))?.direct).toBeUndefined();
    expect(delivered).toHaveLength(0);
  });
});
