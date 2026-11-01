/**
 * `super team ask --model --effort --light`, through the real route and the real say path; only
 * the two spawns are doubled (no test here starts a claude):
 *
 *  - the settings are that job's: the member's file does not move, its approval stands, its next
 *    job runs on what it had, and a job beside a busy member keeps its own;
 *  - a bad name is refused before anything starts or reaches the thread, with the choices;
 *  - no flag at all is today's call, byte for byte; global agents take the same flags;
 *  - the record and the card carry what the job ran on.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-team-settings-home-`);
});

type Spawned = { slug: string; override: unknown };
const spawns = vi.hoisted(() => ({
  runs: [] as Spawned[], replies: [] as Spawned[], holdRun: null as null | Promise<void>,
}));
vi.mock('../../src/lib/automations/runner.js', async (orig) => {
  const real = await orig<typeof import('../../src/lib/automations/runner.js')>();
  return {
    ...real,
    runAutomation: async (_root: string, slug: string, opts: { override?: unknown }) => {
      spawns.runs.push({ slug, override: opts.override ?? null });
      if (spawns.holdRun) await spawns.holdRun;
      return { slug, status: 'ok', outputPath: null, error: null, durationMs: 1, event: null, cache: null, denials: 0, costUsd: null, reviewCardId: null };
    },
  };
});
vi.mock('../../src/lib/automations/verdict.js', async (orig) => {
  const real = await orig<typeof import('../../src/lib/automations/verdict.js')>();
  return {
    ...real,
    resumeWithMessage: async (_root: string, slug: string, _text: string, opts: { override?: unknown }) => {
      spawns.replies.push({ slug, override: opts.override ?? null });
      return { status: 'ok', error: null, result: 'ok', costUsd: null };
    },
  };
});

import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { _resetChatRegistry } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { emptySuperState } from '../../src/lib/super/types.js';
import { _resetSuperInbox } from '../../src/lib/super/inbox.js';
import { handleSuperVerb } from '../../src/server/routes/super.js';
import { mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';
import { createAgent, getAgent } from '../../src/lib/agents/store.js';
import { approveAutomation, canonicalApprovalPayload, checkApproval } from '../../src/lib/automations/registry.js';
import { getAutomation } from '../../src/lib/automations/store.js';
import { memberCallState, renderSuperTeamBlock } from '../../src/lib/agents/team-roster.js';
import { SUPER_BRIEF_TEXT } from '../../src/server/chat-modes.js';
import { LIGHT_DEFAULT_EFFORT, LIGHT_DEFAULT_MODEL } from '../../src/lib/automations/light-run.js';
import { handleAutomationsSay } from '../../src/server/routes/automations.js';

let dir: string;
let root: string;
let token = '';
const SUPER = 'sup-1';

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'super-team-settings-')));
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: SUPER, enabled: true }));
  _resetChatRegistry(); resetSuperIndex(); _resetSuperInbox(); resetWindowControl();
  token = mintWindowToken({ send: () => true, vault: 'acme', contextRoot: root, sessionId: SUPER, mode: 'super' }).token;
  spawns.runs.length = 0; spawns.replies.length = 0; spawns.holdRun = null;
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

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
async function ask(body: Record<string, unknown>) {
  const r = res();
  await handleSuperVerb(req(body, { 'x-dreamcontext-window-token': token }), r, { verb: 'team-ask' });
  return r;
}
const until = async (ok: () => boolean) => { for (let i = 0; i < 200 && !ok(); i++) await new Promise((d) => setTimeout(d, 5)); expect(ok()).toBe(true); };
const settle = () => new Promise((d) => setTimeout(d, 20));

/** An approved call member on opus at medium effort. */
function desk(slug = 'desk'): string {
  createAgent(root, { slug, title: 'Desk', prompt: 'Read first: every skill.', soul: 'Never send without his word.', model: 'opus', effort: 'medium' } as Parameters<typeof createAgent>[1], { approve: { now: new Date() } });
  return getAgent(root, slug)!.path;
}

describe('--model / --effort belong to one job', () => {
  it('runs that job on them; the member\'s file, approval and next job do not move', async () => {
    const path = desk();
    const before = readFileSync(path);
    const hash = canonicalApprovalPayload(getAutomation(root, 'desk')!);
    const r = await ask({ member: 'desk', text: 'look at one thing', model: 'haiku', effort: 'low' });
    expect(r.status).toBe(200);
    expect(r.json.result ?? r.json).toMatchObject({ model: 'haiku', effort: 'low' });
    await until(() => spawns.runs.length === 1);
    expect(spawns.runs[0].override).toEqual({ model: 'haiku', effort: 'low', oneJob: true });
    await settle();

    expect(readFileSync(path).equals(before)).toBe(true);
    expect(canonicalApprovalPayload(getAutomation(root, 'desk')!)).toBe(hash);
    expect(memberCallState(root, 'desk').state).toBe('ready');
    expect(getAgent(root, 'desk')).toMatchObject({ model: 'opus', effort: 'medium' });

    await ask({ member: 'desk', text: 'the next one' });
    await until(() => spawns.runs.length === 2);
    expect(spawns.runs[1].override).toBeNull();
    const jobs = (await readSuperState(root)).team;
    expect(jobs.map((j) => [j.model, j.effort, j.light])).toEqual([['opus', 'medium', undefined], ['haiku', 'low', undefined]]);
  });

  it('one field alone leaves the other to the member', async () => {
    desk();
    await ask({ member: 'desk', text: 'x', effort: 'high' });
    await until(() => spawns.runs.length === 1);
    expect(spawns.runs[0].override).toEqual({ model: null, effort: 'high', oneJob: true });
    expect((await readSuperState(root)).team[0]).toMatchObject({ model: 'opus', effort: 'high' });
  });

  it('a job beside a busy member keeps its own settings, and the run ahead keeps its', async () => {
    desk();
    let release = () => {};
    spawns.holdRun = new Promise<void>((d) => { release = d; });
    await ask({ member: 'desk', text: 'the long one' });
    await until(() => spawns.runs.length === 1);
    const q = await ask({ member: 'desk', text: 'the second one', model: 'sonnet', effort: 'low' });
    expect(q.status).toBe(200);
    await until(() => spawns.runs.length === 2);
    expect(spawns.runs[1].override).toEqual({ model: 'sonnet', effort: 'low', oneJob: true });
    expect(spawns.runs[0].override).toBeNull();
    const l = await ask({ member: 'desk', text: 'a light one', light: true });
    expect(l.status).toBe(200);
    await until(() => spawns.runs.length === 3);
    expect(spawns.runs[2].override).toMatchObject({ light: true });
    expect(spawns.replies).toEqual([]);
    release();
    await settle();
  });

  it('a run that leaves no session holds nothing up: the next jobs start beside it', async () => {
    desk();
    let release = () => {};
    spawns.holdRun = new Promise<void>((d) => { release = d; });
    await ask({ member: 'desk', text: 'one read', light: true });
    await until(() => spawns.runs.length === 1);
    for (const next of [{ text: 'a full one' }, { text: 'another read', light: true }]) {
      expect((await ask({ member: 'desk', ...next })).status).toBe(200);
    }
    await until(() => spawns.runs.length === 3);
    expect((await readSuperState(root)).team).toHaveLength(3);
    expect(spawns.replies).toEqual([]);
    release();
    await settle();
  });

  it('on a member with no model, a job with its own model is a fresh run, never a live session', async () => {
    createAgent(root, { slug: 'bare', title: 'Bare', prompt: 'go' } as Parameters<typeof createAgent>[1], { approve: { now: new Date() } });
    let release = () => {};
    spawns.holdRun = new Promise<void>((d) => { release = d; });
    await ask({ member: 'bare', text: 'the long one' });
    await until(() => spawns.runs.length === 1);
    for (const next of [{ model: 'haiku' }, { light: true }]) {
      expect((await ask({ member: 'bare', text: 'x', ...next })).status).toBe(200);
    }
    expect((await ask({ member: 'bare', text: 'plain' })).status).toBe(200);
    await until(() => spawns.runs.length === 4);
    expect(spawns.replies).toEqual([]);
    release();
    await settle();
  });

  it('with no flag the say path gets no override at all', async () => {
    desk();
    await ask({ member: 'desk', text: 'plain' });
    await until(() => spawns.runs.length === 1);
    expect(spawns.runs[0].override).toBeNull();
  });
});

describe('a bad name never starts or queues anything', () => {
  it.each([
    [{ model: 'gpt-9' }, /Unknown model\. Pick one of: .*haiku/],
    [{ model: 'opus; rm -rf /' }, /Unknown model/],
    [{ effort: 'huge' }, /Unknown effort\. Pick one of: low, medium, high, xhigh, max/],
    [{ light: true, model: 'gpt-9' }, /Unknown model/],
  ])('%j', async (flags, message) => {
    desk();
    const r = await ask({ member: 'desk', text: 'x', ...flags });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('invalid_args');
    expect(String(r.json.message)).toMatch(message);
    await settle();
    expect(spawns.runs).toEqual([]);
    expect((await readSuperState(root)).team).toEqual([]);
  });
});

describe('--light', () => {
  it('defaults to the cheap model, marks the record, and a named model wins', async () => {
    desk();
    const r = await ask({ member: 'desk', text: 'one chat', light: true });
    expect(r.status).toBe(200);
    await until(() => spawns.runs.length === 1);
    expect(spawns.runs[0].override).toEqual({ model: LIGHT_DEFAULT_MODEL, effort: LIGHT_DEFAULT_EFFORT, light: true });
    expect((await readSuperState(root)).team[0]).toMatchObject({ model: LIGHT_DEFAULT_MODEL, effort: LIGHT_DEFAULT_EFFORT, light: true });
    await settle();
    await ask({ member: 'desk', text: 'another', light: true, model: 'sonnet' });
    await until(() => spawns.runs.length === 2);
    expect(spawns.runs[1].override).toEqual({ model: 'sonnet', effort: LIGHT_DEFAULT_EFFORT, light: true });
  });

  it('no other door opens it: the AI Team\'s own say route drops the field', async () => {
    desk();
    const r = res();
    await handleAutomationsSay(req({ slug: 'desk', text: 'hi', light: true }), r, {}, root);
    expect(r.status).toBe(200);
    await until(() => spawns.runs.length === 1);
    expect(spawns.runs[0].override).toBeNull();
  });

  it('keeps every refusal: an unapproved or a turned-off member gets no light way in', async () => {
    createAgent(root, { slug: 'fresh', title: 'Fresh', prompt: 'go' } as Parameters<typeof createAgent>[1]);
    const r = await ask({ member: 'fresh', text: 'x', light: true });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('say_unapproved');
    expect((await ask({ member: 'nobody', text: 'x', light: true })).json.error).toBe('unknown_member');
    expect(spawns.runs).toEqual([]);
  });

  it('read_tools on an agent reach its target; naming them takes a new approval', () => {
    const path = desk();
    expect(checkApproval(dirname(root), getAutomation(root, 'desk')!, undefined, 'run').approved).toBe(true);
    writeFileSync(path, readFileSync(path, 'utf-8').replace('title: Desk', 'title: Desk\nread_tools:\n  - mcp__wa__list_messages\n  - mcp__wa__send_message'));
    const m = getAutomation(root, 'desk')!;
    expect(m.readTools).toEqual(['mcp__wa__list_messages']);
    expect(checkApproval(dirname(root), m, undefined, 'run').approved).toBe(false);
  });
});

describe('global agents take the same flags', () => {
  it('runs on the job\'s model; the global file stays as it was', async () => {
    const path = join(homedir(), '.dreamcontext', 'agents', 'keeper.md');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '---\nid: agt_keeper\ntitle: Keeper\nmodel: opus\neffort: high\n---\n## Prompt\n\ngo\n');
    const target = getAutomation(root, 'keeper')!;
    expect(target.agentScope).toBe('global');
    approveAutomation(dirname(root), target, new Date());
    const before = readFileSync(path);
    const r = await ask({ member: 'keeper', text: 'one job', light: true, model: 'sonnet' });
    expect(r.status).toBe(200);
    await until(() => spawns.runs.length === 1);
    expect(spawns.runs[0]).toEqual({ slug: 'keeper', override: { model: 'sonnet', effort: LIGHT_DEFAULT_EFFORT, light: true } });
    expect(readFileSync(path).equals(before)).toBe(true);
    rmSync(path);
  });
});

describe('the rule, said the same way in every place', () => {
  it('the brief, the team block, the hook and the delegate hint name both sides', () => {
    expect(SUPER_BRIEF_TEXT).toContain('A small read of ONE source');
    expect(SUPER_BRIEF_TEXT).toMatch(/A diagnosis, draft, send/);
    expect(SUPER_BRIEF_TEXT).toContain('--light');
    const block = renderSuperTeamBlock([{ slug: 'desk', title: 'Desk', role: 'r', state: 'ready', watches: [] }], 'acme');
    expect(block).toContain('A small read of ONE source');
    expect(block).toMatch(/a diagnosis, a draft, a send/);
    expect(block).toContain('--light');
    expect(block).toContain('`dreamcontext super team ask <slug>');
  });
});
