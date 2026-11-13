/**
 * The Super hands a plan approval off instead of talking to the owner (owner 2026-11-13, a real
 * project: "planı bana özetlemiyor ekranda açmıyor, karar orada seni bekliyor"). Before: a Plan
 * child's question was `direct`, so it sat on his bar, oldest first, BEHIND another job's question
 * ("1 more waiting"), never as a card in the Super chat; the Super's event turn was told "it is
 * already in front of him, no text", so it wrote three sentences that pointed at a stage holding
 * only the child's chat ("the summary is open on the stage").
 *
 * Now a Plan child's question waits on the Super; only its `queue ask` puts it in front of him,
 * as a card in its own chat; without a report card that ask is refused, and a text that gave no
 * summary gets a warning.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-plan-q-home-`);
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { _resetChatRegistry, getChat, pendingRequestIds, registerChat, type ChatHandle } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { emptySuperState } from '../../src/lib/super/types.js';
import {
  _resetSuperInbox, _superInboxDrained, attachSuperInbox, ownerQuestionOpen, startSuperInbox, superQueueHead, superTurnEnded,
  type SuperEventFrame, type SuperInbox,
} from '../../src/lib/super/inbox.js';
import { _resetOwnerQuestions, setOwnerQuestionSinks } from '../../src/lib/super/owner-question.js';
import { handleSuperVerb } from '../../src/server/routes/super.js';
import { deliverSuperResult, mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';
import { queueHead } from '../../dashboard/src/components/sleepy/super/superHandover.js';
import { openOwnerQuestions } from '../../dashboard/src/components/sleepy/super/superQuestions.js';
import { PLAN_QUESTION_LINE } from '../../src/lib/super/inbox.js';
import { PLAN_REPORT_REFUSAL, PLAN_TEXT_WARNING, planReportRefusal, planTextWarning } from '../../src/lib/super/ask-summary.js';

const SUPER = 'sup-plan-1';
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
  dir = mkdtempSync(join(tmpdir(), 'super-plan-q-'));
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
    children: { [C1]: { sessionId: C1, brief: 'Plan the Pix twin', adopted: false, startedAt: 1, mode: 'plan' }, [C2]: { sessionId: C2, brief: 'Who buys the MX test', adopted: true, startedAt: 1 } },
    containers: [{ id: 'web-plan', kind: 'web', ref: '_dream_context/tmp/super/pix-plan.html', shape: 'square', place: 'float', title: 'Pix plan' }],
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
const planAsk = (h: ChatHandle, requestId: string) => h.observe({
  type: 'control_request', request_id: requestId,
  request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Start the plan?', description: 'Problem: no Pix twin.\n- a\n- b\n- c', options: [{ label: 'Start' }, { label: 'Not yet' }] }] } },
});
async function queueAsk(item: string, show?: string[]) {
  const r = res();
  await handleSuperVerb(req({ item, text: 'Start the Pix twin plan?', ...(show ? { show } : {}) }), r, { verb: 'queue-ask' });
  return r;
}
/** What the Super wrote, in the shape it wrote it: three sentences, no summary. */
const POINTER = 'The Pix twin plan is ready. The summary is open on the stage. A question card waits for your start.';
const SUMMARY = 'The Pix twin plan is ready.\n- copy the 8315 prices\n- keep the coach box on 3 months\n- double upsell\nYour decision: the coach box.';
const out = (r: { json: Record<string, unknown> }) => (r.json.result ?? r.json) as Record<string, unknown>;
const superSays = (text: string) => handles.get(SUPER)!.observe({ type: 'assistant', message: { content: [{ type: 'text', text }] } } as never);

describe("a Plan child's question reaches the owner through the Super", { timeout: 30_000 }, () => {
  it('waits on the Super, never on his bar behind another job, and its event says so', async () => {
    const busy = { on: true };
    const { inbox, delivered } = fakeInbox(busy);
    attachSuperInbox(inbox);
    // Another job's question came first and holds the bar.
    askQuestion(reg(C2), 'req-mx');
    await vi.waitFor(async () => expect(await itemOf('req-mx')).toBeDefined(), W);
    planAsk(reg(C1, 'plan'), 'req-plan');
    await vi.waitFor(async () => expect(await itemOf('req-plan')).toBeDefined(), W);
    const item = (await itemOf('req-plan'))!;
    expect(item.direct).toBeUndefined();
    expect(item.state).toBe('pending');
    const s = await readSuperState(root);
    expect(superQueueHead(s)?.requestId).toBe('req-mx');
    expect(queueHead(s)?.requestId).toBe('req-mx');
    busy.on = false;
    superTurnEnded(SUPER);
    await vi.waitFor(() => expect(delivered.some((d) => d.text.includes(`item=${item.id}`))).toBe(true), W);
    const text = delivered.map((d) => d.text).join('\n');
    expect(text).toContain(PLAN_QUESTION_LINE);
    const line = text.split('\n').find((l) => l.includes(`item=${item.id}`)) ?? '';
    expect(line).not.toContain('shown=owner');
  });

  it('a `queue ask` with no report card is refused; with one it becomes a card in the Super chat', async () => {
    planAsk(reg(C1, 'plan'), 'req-plan');
    await vi.waitFor(async () => expect(await itemOf('req-plan')).toBeDefined(), W);
    const id = (await itemOf('req-plan'))!.id;
    const bare = await queueAsk(id);
    expect(bare.status).toBe(400);
    expect(JSON.stringify(bare.json)).toContain('plan_report_missing');
    expect((await itemOf('req-plan'))?.state).toBe('pending');
    // The Super wrote only a pointer before asking: the card goes, it is told to write the summary.
    superSays(POINTER);
    const ok = await queueAsk(id, ['web-plan']);
    expect(ok.status).toBe(200);
    expect(out(ok).warning).toBe(PLAN_TEXT_WARNING);
    const s = await readSuperState(root);
    expect(openOwnerQuestions(s.queue).map((q) => q.id)).toContain(id);
  });

  it('a Super text that carries the summary draws no warning', async () => {
    planAsk(reg(C1, 'plan'), 'req-plan');
    await vi.waitFor(async () => expect(await itemOf('req-plan')).toBeDefined(), W);
    const id = (await itemOf('req-plan'))!.id;
    superSays(SUMMARY);
    const ok = await queueAsk(id, ['web-plan']);
    expect(ok.status).toBe(200);
    expect(out(ok).warning).toBeUndefined();
  });

  it('a chat he put in Plan himself (no plan in its record) goes through the Super too', async () => {
    planAsk(reg(C2, 'plan'), 'req-adopted');
    await vi.waitFor(async () => expect(await itemOf('req-adopted')).toBeDefined(), W);
    expect((await itemOf('req-adopted'))?.direct).toBeUndefined();
  });

  it('a non-plan child keeps its direct path', async () => {
    askQuestion(reg(C2), 'req-mx');
    await vi.waitFor(async () => expect(await itemOf('req-mx')).toBeDefined(), W);
    expect((await itemOf('req-mx'))?.direct).toBe(true);
  });
});

describe('the pure checks', () => {
  it('refuses a plan question with no report card only', () => {
    expect(planReportRefusal('plan', 0)).toBe(PLAN_REPORT_REFUSAL);
    expect(planReportRefusal('plan', 1)).toBeNull();
    expect(planReportRefusal('develop', 0)).toBeNull();
    expect(planReportRefusal(undefined, 0)).toBeNull();
  });
  it('a pointer is no summary; bullets or a long paragraph are', () => {
    expect(planTextWarning('plan', POINTER)).toBe(PLAN_TEXT_WARNING);
    expect(planTextWarning('plan', undefined)).toBe(PLAN_TEXT_WARNING);
    expect(planTextWarning('plan', SUMMARY)).toBeNull();
    expect(planTextWarning('plan', 'x'.repeat(400))).toBeNull();
    expect(planTextWarning('develop', POINTER)).toBeNull();
  });
});
