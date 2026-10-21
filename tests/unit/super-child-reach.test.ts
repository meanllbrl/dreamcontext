/**
 * The Super Agent and its children reach each other reliably (task bir-isin-tek-sahibi-olur-…,
 * field Tilki 2026-10-21):
 *
 *  - `super send` to a PARKED child wakes it and delivers in one command (it used to answer
 *    "the message did not reach the child" and make the Super Agent resume, sleep, send again);
 *  - every verb that takes a <child> takes the first 8+ characters of its id, and an ambiguous
 *    prefix is an error that names the candidates;
 *  - a last reply cut in an event line points at `super read`, so the Super Agent stops
 *    reading the child's transcript with a script;
 *  - a delegated child is told how to reach its Super Agent (AskUserQuestion), and told never
 *    to look for it with ListAgents / SendMessage.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-end-home-`);
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Command } from 'commander';
import { _resetChatRegistry, registerChat } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { emptySuperState, type SuperQueueItem, type SuperState } from '../../src/lib/super/types.js';
import { _resetSuperInbox, superEventText } from '../../src/lib/super/inbox.js';
import { MIN_CHILD_PREFIX, expandChildRefs, resolveChildRef } from '../../src/lib/super/child-ref.js';
import { _setSendWakePollForTests, handleSuperVerb } from '../../src/server/routes/super.js';
import { registerSuperCommand } from '../../src/cli/commands/super.js';
import { CHAT_SURFACE_BRIEFING, SUPER_CHILD_BRIEFING } from '../../src/server/chat-surface.js';
import { deliverSuperResult, deliverWindowResult, mintWindowToken, resetWindowControl, type WindowResult } from '../../src/lib/window-control.js';
import { _resetChatParkForTests } from '../../src/server/chat-park.js';

const SUPER = 'sup-1';
const A = 'a0a190b2-3a92-4530-aa23-ec2fc43214cb';
const B = '5e536d3c-0000-4000-8000-000000000001';
// Shares its first 8 characters with A, not its whole id.
const A2 = 'a0a190b2-ffff-4fff-8fff-ffffffffffff';

const child = (sid: string, extra: Record<string, unknown> = {}) => ({ sessionId: sid, brief: `${sid.slice(0, 4)} work`, adopted: false, startedAt: 1, ...extra });
const card = (sid: string) => ({ id: `chat-${sid}`, kind: 'chat' as const, ref: sid, shape: 'tall' as const, place: 'float' as const });

describe('resolveChildRef / expandChildRefs (pure)', () => {
  const state = { session: SUPER, children: { [A]: child(A), [B]: child(B), [A2]: child(A2) } } as unknown as SuperState;

  it('a whole id, or a unique prefix of at least 8 characters, names one child', () => {
    expect(resolveChildRef(state, B)).toEqual({ id: B });
    expect(resolveChildRef(state, '5e536d3c')).toEqual({ id: B });
    expect(resolveChildRef(state, '5e536d3c-0000-4000')).toEqual({ id: B });
    expect(MIN_CHILD_PREFIX).toBe(8);
  });

  it('shorter than 8 characters, or matching nothing, is unknown_child', () => {
    expect(resolveChildRef(state, '5e536d3')).toMatchObject({ error: 'unknown_child' });
    expect(resolveChildRef(state, 'deadbeef')).toMatchObject({ error: 'unknown_child' });
  });

  it('a prefix of several children is an error that names them, never a pick', () => {
    const r = resolveChildRef(state, 'a0a190b2');
    expect(r).toMatchObject({ error: 'ambiguous_child', matches: [A, A2] });
    expect((r as { message: string }).message).toContain(A);
    // The full id still wins over the shared prefix.
    expect(resolveChildRef(state, A)).toEqual({ id: A });
  });

  it('the Super Agent itself and Object.prototype keys are never matched', () => {
    expect(resolveChildRef(state, 'sup-1')).toMatchObject({ error: 'unknown_child' });
    expect(resolveChildRef(state, '__proto__')).toMatchObject({ error: 'unknown_child' });
    expect(resolveChildRef(state, 'constructor')).toMatchObject({ error: 'unknown_child' });
  });

  it('rewrites the child fields of a verb and leaves every other field alone', () => {
    expect(expandChildRefs(state, 'send', { child: '5e536d3c', text: '5e536d3c is also text' })).toEqual({ body: { child: B, text: '5e536d3c is also text' } });
    expect(expandChildRefs(state, 'end', { children: ['5e536d3c', 'unknown-one'], force: false })).toEqual({ body: { children: [B, 'unknown-one'], force: false } });
    expect(expandChildRefs(state, 'delegate', { prompt: 'x', succeeds: '5e536d3c' })).toEqual({ body: { prompt: 'x', succeeds: B } });
    expect(expandChildRefs(state, 'open', { kind: 'chat', ref: '5e536d3c' })).toEqual({ body: { kind: 'chat', ref: B } });
    expect(expandChildRefs(state, 'open', { kind: 'chat', refs: ['5e536d3c', B] })).toEqual({ body: { kind: 'chat', refs: [B, B] } });
    // A web URL or a slug is not a child.
    expect(expandChildRefs(state, 'open', { kind: 'task', ref: '5e536d3c' })).toEqual({ body: { kind: 'task', ref: '5e536d3c' } });
    expect(expandChildRefs(state, 'queue-list', { child: '5e536d3c' })).toEqual({ body: { child: '5e536d3c' } });
  });

  it('an ambiguous prefix anywhere in the body is the one thing decided here', () => {
    expect(expandChildRefs(state, 'end', { children: [B, 'a0a190b2'] })).toMatchObject({ error: { error: 'ambiguous_child' } });
    // An id that matches nothing is passed on: the verb's own refusal answers.
    expect(expandChildRefs(state, 'read', { child: 'nothing-here' })).toEqual({ body: { child: 'nothing-here' } });
  });

  it('DRIFT: every `dreamcontext super` verb that takes a child is covered', () => {
    const program = new Command();
    registerSuperCommand(program);
    const sup = program.commands.find((c) => c.name() === 'super') as Command;
    const verbs: string[] = [];
    const walk = (cmd: Command, prefix: string): void => {
      for (const sub of cmd.commands) {
        const name = prefix ? `${prefix}-${sub.name()}` : sub.name();
        if (sub.commands.length) { walk(sub, name); continue; }
        const names = sub.registeredArguments.map((a) => a.name());
        if (names.includes('child') || names.includes('children')) { verbs.push(name); fields.set(name, names.includes('child') ? 'child' : 'children'); }
      }
    };
    const fields = new Map<string, 'child' | 'children'>();
    walk(sup, '');
    expect(verbs.sort()).toEqual(['answer', 'brief', 'end', 'merge', 'read', 'resume', 'send', 'update', 'worktree-remove']);
    for (const v of verbs) {
      const field = fields.get(v) as 'child' | 'children';
      const out = expandChildRefs(state, v, { [field]: field === 'child' ? '5e536d3c' : ['5e536d3c'] });
      expect(out, v).toEqual({ body: { [field]: field === 'child' ? B : [B] } });
    }
    // `delegate --succeeds <child>` is an option, not an argument.
    expect(sup.commands.find((c) => c.name() === 'delegate')?.options.some((o) => o.long === '--succeeds')).toBe(true);
  });
});

// ── Through the real route ──────────────────────────────────────────────────────────

let dir: string;
let root: string;
let token = '';
const frames: Array<Record<string, unknown>> = [];
/** How the mock window answers a `window_command` (`super send` travels as the window's `send`). */
let windowAnswer: (frame: Record<string, unknown>) => WindowResult = () => ({ ok: true, result: { delivered: 'sent' } });
const savedDesktop = process.env.DREAMCONTEXT_DESKTOP;

function transcript(sid: string): void {
  const proj = join(process.env.HOME as string, '.claude', 'projects', 'acme');
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, `${sid}.jsonl`), '{}\n');
}

function makeVault(children: Record<string, ReturnType<typeof child>>): void {
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({
    ...emptySuperState(), session: SUPER, enabled: true, children, containers: Object.keys(children).map(card),
  }));
  token = mintWindowToken({
    send: (frame) => {
      frames.push(frame);
      if (typeof frame.id !== 'string') return true;
      if (frame.subtype === 'window_command') setImmediate(() => deliverWindowResult(token, frame.id, windowAnswer(frame)));
      else setImmediate(() => deliverSuperResult(token, frame.id, { ok: true, result: { sessionId: B, mode: 'basic', model: '', effort: '' } }));
      return true;
    },
    vault: 'acme', contextRoot: root, sessionId: SUPER, mode: 'super',
  }).token;
}

function req(body: unknown, headers: Record<string, string> = {}): IncomingMessage {
  const r = new PassThrough() as unknown as IncomingMessage & PassThrough;
  Object.assign(r, { headers: { host: '127.0.0.1:4173', ...headers }, socket: { remoteAddress: '127.0.0.1' }, method: 'POST', url: '/' });
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
  await handleSuperVerb(req(body, { 'x-dreamcontext-window-token': token }), r, { verb: name });
  return r;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'super-end-'));
  frames.length = 0;
  rmSync(join(process.env.HOME as string, '.claude', 'projects'), { recursive: true, force: true });
  windowAnswer = () => ({ ok: true, result: { delivered: 'sent' } });
  _resetChatRegistry(); resetSuperIndex(); _resetSuperInbox(); resetWindowControl(); _resetChatParkForTests();
  _setSendWakePollForTests(5);
  process.env.DREAMCONTEXT_DESKTOP = '1';
});
afterEach(() => {
  _setSendWakePollForTests(null);
  if (savedDesktop === undefined) delete process.env.DREAMCONTEXT_DESKTOP; else process.env.DREAMCONTEXT_DESKTOP = savedDesktop;
  _resetChatParkForTests();
  rmSync(dir, { recursive: true, force: true });
});

describe('super send to a parked child', () => {
  const NOT_RUNNING = 'that chat is not running; the owner resumes it first';

  it('wakes it and delivers in ONE command', async () => {
    makeVault({ [B]: child(B) });
    transcript(B);
    // Parked: the window has the tab dormant until the resume lands, and the process needs a few asks.
    let asks = 0;
    windowAnswer = () => (frames.some((f) => f.subtype === 'super_command' && f.verb === 'resume') && ++asks > 2
      ? { ok: true, result: { delivered: 'sent' } }
      : { ok: false, error: NOT_RUNNING });
    const r = await verb('send', { child: B, text: 'pick up where you stopped' });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.result).toMatchObject({ child: B, delivered: 'sent', woke: true });
    const resumes = frames.filter((f) => f.subtype === 'super_command' && f.verb === 'resume');
    expect(resumes).toHaveLength(1);
    expect(resumes[0].args).toMatchObject({ child: B });
    // The message went in AFTER the resume, as the window's own `send` into the child's tab.
    const sends = frames.filter((f) => f.verb === 'send');
    expect(sends.length).toBeGreaterThanOrEqual(3);
    expect(frames.indexOf(resumes[0])).toBeLessThan(frames.indexOf(sends[0]));
    expect(sends.at(-1)?.args).toEqual({ tab: B, text: 'pick up where you stopped' });
  });

  it('a child that is already running is not resumed: steered, as before', async () => {
    makeVault({ [B]: child(B) });
    registerChat({ sessionId: B, conversationId: null, vault: 'acme', mode: 'basic' });
    windowAnswer = () => ({ ok: true, result: { delivered: 'steered' } });
    const r = await verb('send', { child: B, text: 'stop' });
    expect(r.json.result).toEqual({ child: B, delivered: 'steered' });
    expect(frames.filter((f) => f.subtype === 'super_command')).toHaveLength(0);
  });

  it('a wake that is refused says why, and sends nothing', async () => {
    makeVault({ [B]: child(B) }); // no transcript to resume
    const r = await verb('send', { child: B, text: 'hi' });
    expect(r.status).toBe(404);
    expect(r.json.error).toBe('no_transcript');
    expect(String(r.json.message)).toMatch(/parked and could not be woken/);
    expect(frames.filter((f) => f.verb === 'send')).toHaveLength(0);
  });

  it('a child that never comes up is a plain failure, not a hang', async () => {
    makeVault({ [B]: child(B) });
    transcript(B);
    windowAnswer = () => ({ ok: false, error: NOT_RUNNING });
    const r = await verb('send', { child: B, text: 'hi' });
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toBe(NOT_RUNNING);
  });

  it('an ENDED child is still refused with the way back (the owner closed it on purpose)', async () => {
    makeVault({ [B]: child(B, { endedAt: 5 }) });
    transcript(B);
    const r = await verb('send', { child: B, text: 'hi' });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('ended');
    expect(frames).toHaveLength(0);
  });

  it('works with the short id the Super Agent copied', async () => {
    makeVault({ [B]: child(B) });
    transcript(B);
    windowAnswer = () => (frames.some((f) => f.subtype === 'super_command') ? { ok: true, result: { delivered: 'sent' } } : { ok: false, error: NOT_RUNNING });
    const r = await verb('send', { child: B.slice(0, 8), text: 'hi' });
    expect(r.json.result).toMatchObject({ child: B, delivered: 'sent', woke: true });
  });
});

describe('every verb takes the short id', () => {
  it('brief, with 8 characters: the full id is recorded and answered', async () => {
    makeVault({ [A]: child(A), [B]: child(B) });
    const r = await verb('brief', { child: A.slice(0, 8), line: 'doing the db' });
    expect(r.status).toBe(200);
    expect(r.json.result).toMatchObject({ child: A, brief: 'doing the db' });
    expect((await readSuperState(root)).children[A].brief).toBe('doing the db');
  });

  it('read, with 8 characters, reaches the child (no transcript yet is ITS answer, not unknown_child)', async () => {
    makeVault({ [A]: child(A) });
    const r = await verb('read', { child: A.slice(0, 8) });
    expect(r.json.error).toBe('no_transcript');
  });

  it('end and resume, with 8 characters', async () => {
    makeVault({ [A]: child(A), [B]: child(B) });
    transcript(B);
    const e = await verb('end', { children: [B.slice(0, 8)] });
    expect(e.status).toBe(200);
    expect(typeof (await readSuperState(root)).children[B].endedAt).toBe('number');
    const r = await verb('resume', { child: B.slice(0, 8) });
    expect(r.status).toBe(200);
    expect((await readSuperState(root)).children[B].endedAt).toBeUndefined();
  });

  it('open chat, with 8 characters, opens that child\'s card', async () => {
    makeVault({ [A]: child(A), [B]: child(B) });
    const r = await verb('open', { kind: 'chat', ref: B.slice(0, 8) });
    expect(r.status).toBe(200);
    expect((await readSuperState(root)).containers.some((k) => k.kind === 'chat' && k.ref === B)).toBe(true);
  });

  it('several children with that prefix: an error naming them, and nothing changed', async () => {
    makeVault({ [A]: child(A), [A2]: child(A2) });
    const r = await verb('brief', { child: 'a0a190b2', line: 'x' });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('ambiguous_child');
    expect(r.json.matches).toEqual([A, A2]);
    expect(String(r.json.message)).toContain(A2);
    expect((await readSuperState(root)).children[A].brief).toBe('a0a1 work');
  });

  it('seven characters is unknown_child, with the verb\'s own wording', async () => {
    makeVault({ [A]: child(A) });
    const r = await verb('read', { child: A.slice(0, 7) });
    expect(r.status).toBe(404);
    expect(r.json.error).toBe('unknown_child');
  });
});

describe('a cut last reply points at `super read`', () => {
  const state = (): SuperState => ({ ...emptySuperState(), session: SUPER, children: { [A]: child(A) } }) as SuperState;
  const handover = { id: 'q-h', sessionId: SUPER, kind: 'handover', state: 'pending', createdAt: 1 } as SuperQueueItem;
  const batchItem = { id: 'q-1', sessionId: A, kind: 'done', state: 'pending', createdAt: 1, batch: 'b-1' } as SuperQueueItem;
  const say = (text: string) => {
    const c = registerChat({ sessionId: A, conversationId: null, vault: 'acme', mode: 'basic' });
    c.observe({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  };
  beforeEach(() => { _resetChatRegistry(); });

  it('an event line cut at 600 characters says how much was cut and which verb prints the rest', () => {
    say('x'.repeat(900));
    const text = superEventText('/v/acme/_dream_context', state(), batchItem, Date.now(), 'b-1');
    expect(text).toContain(`${'x'.repeat(600)}…`);
    expect(text).toContain(`(cut at 600 of 900 characters; the whole reply: \`dreamcontext super read ${A}\`)`);
    // The server's pointer sits OUTSIDE the child's fence.
    expect(text.indexOf('(cut at 600')).toBeGreaterThan(text.indexOf('</untrusted-project-output>', text.indexOf('Last reply')));
  });

  it('the hand-over line says it too', () => {
    say('y'.repeat(700));
    expect(superEventText('/v/acme/_dream_context', state(), handover, Date.now())).toContain(`dreamcontext super read ${A}`);
  });

  it('a reply that fits is whole and carries no pointer', () => {
    say('Migrated the schema.');
    const text = superEventText('/v/acme/_dream_context', state(), batchItem, Date.now(), 'b-1');
    expect(text).toContain('Last reply: Migrated the schema.</untrusted-project-output>');
    expect(text).not.toContain('(cut at');
  });
});

describe('the delegated child\'s briefing', () => {
  it('says AskUserQuestion reaches the Super Agent\'s queue, and forbids looking for it among peers', () => {
    expect(SUPER_CHILD_BRIEFING).toContain('AskUserQuestion');
    expect(SUPER_CHILD_BRIEFING).toMatch(/queue/);
    expect(SUPER_CHILD_BRIEFING).toMatch(/Never look for it among peers/);
    expect(SUPER_CHILD_BRIEFING).toContain('`ListAgents`');
    expect(SUPER_CHILD_BRIEFING).toContain('`SendMessage`');
  });

  it('is kept apart from the surface briefing every chat gets', () => {
    expect(CHAT_SURFACE_BRIEFING).not.toContain('Reaching the Super Agent');
    expect(SUPER_CHILD_BRIEFING.startsWith('## Reaching the Super Agent')).toBe(true);
  });
});
