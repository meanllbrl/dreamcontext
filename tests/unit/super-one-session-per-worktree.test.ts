/**
 * One worktree, one live session (21 Kas, telegram-sade: a restart resume and a brief-directed new
 * child both worked in one worktree). `super delegate --worktree/--slug` and `super resume`
 * refuse when a live child already holds that worktree and name it; `super end` that did not end
 * a child says so in an explicit `refused` field (and `warning` for several).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-one-wt-home-`);
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { linkedReposFilePath } from '../../src/lib/linked-repos.js';
import { canonicalRemote } from '../../src/lib/git-sync/origin-setup.js';
import { _resetChatRegistry, registerChat } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { emptySuperState, type SuperState } from '../../src/lib/super/types.js';
import { _resetSuperInbox } from '../../src/lib/super/inbox.js';
import { handleSuperVerb } from '../../src/server/routes/super.js';
import { deliverSuperResult, deliverWindowResult, mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';
import { _resetChatParkForTests, registerParkable, type ParkOutcome } from '../../src/server/chat-park.js';

let dir: string;
let root: string;
const SUPER = 'sup-1';
const frames: Array<Record<string, unknown>> = [];
let token = '';
const savedDesktop = process.env.DREAMCONTEXT_DESKTOP;
const URL_ = 'https://github.com/acme/product.git';
const HOME = () => process.env.HOME as string;

const card = (sid: string) => ({ id: `chat-${sid}`, kind: 'chat' as const, ref: sid, shape: 'tall' as const, place: 'float' as const });
const wtPath = (slug: string) => join(HOME(), '.claude-worktrees', `product-super-${slug}`);
const child = (sid: string, o: Record<string, unknown> = {}) => ({ sessionId: sid, brief: `job ${sid}`, adopted: false, startedAt: 1, ...o });

function makeVault(state: Partial<SuperState> = {}): void {
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: SUPER, enabled: true, ...state }));
  token = mintWindowToken({
    send: (frame) => {
      frames.push(frame);
      if (typeof frame.id !== 'string') return true;
      if (frame.subtype === 'window_command') setImmediate(() => deliverWindowResult(token, frame.id, { ok: true, result: {} }));
      else setImmediate(() => deliverSuperResult(token, frame.id, { ok: true, result: { sessionId: 'c9' } }));
      return true;
    },
    vault: 'acme', contextRoot: root, sessionId: SUPER, mode: 'super',
  }).token;
}

/** A linked repo `product` on this machine, so `delegate --worktree product` resolves. */
function linkRepo(): void {
  const repo = join(HOME(), 'code', 'product');
  mkdirSync(repo, { recursive: true });
  mkdirSync(join(HOME(), '.dreamcontext'), { recursive: true });
  writeFileSync(linkedReposFilePath(HOME()), JSON.stringify({ repos: { [canonicalRemote(URL_) ?? URL_]: repo } }));
  writeFileSync(join(root, 'state', '.config.json'), JSON.stringify({
    platforms: [], packs: [], setupVersion: '1', linkedRepos: [{ name: 'product', gitRemoteUrl: URL_ }],
  }));
}

function transcript(sid: string): void {
  const proj = join(HOME(), '.claude', 'projects', 'acme');
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, `${sid}.jsonl`), '{}\n');
}

/** A running child: in the chat registry and as a parkable. */
function live(sid: string, o: { busy?: boolean; answer?: ParkOutcome } = {}): void {
  registerChat({ sessionId: sid, conversationId: null, vault: 'acme', mode: 'basic' });
  registerParkable({
    id: sid, kind: 'chat', projectRoot: dir,
    exempt: () => null, busy: () => !!o.busy, asking: () => false,
    backgroundTasks: () => 0, idleSince: () => 0, focusedAt: () => 0,
    park: async () => o.answer ?? 'parked',
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'super-one-wt-'));
  frames.length = 0;
  _resetChatRegistry();
  resetSuperIndex();
  _resetSuperInbox();
  resetWindowControl();
  _resetChatParkForTests();
  process.env.DREAMCONTEXT_DESKTOP = '1';
});
afterEach(() => {
  if (savedDesktop === undefined) delete process.env.DREAMCONTEXT_DESKTOP; else process.env.DREAMCONTEXT_DESKTOP = savedDesktop;
  _resetChatParkForTests();
  rmSync(dir, { recursive: true, force: true });
});

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

describe('one live session per worktree', () => {
  it('delegate --worktree/--slug is refused while a live child holds that worktree, and names it', async () => {
    makeVault({ children: { c1: child('c1', { worktree: wtPath('cift'), branch: 'super/cift' }) }, containers: [card('c1')] });
    linkRepo();
    live('c1');
    const r = await verb('delegate', { prompt: 'again', worktree: 'product', slug: 'cift', base: 'dev' });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ error: 'worktree_busy', worktreeBusy: true, child: 'c1', branch: 'super/cift' });
    expect(String(r.json.message)).toMatch(/c1/);
    expect(frames.filter((f) => f.subtype === 'super_command')).toEqual([]);
    expect((await readSuperState(root)).pool).toEqual([]);
  });

  it('a hand-over (--succeeds) from the holder is not a second session', async () => {
    makeVault({ children: { c1: child('c1', { worktree: wtPath('cift'), branch: 'super/cift' }) }, containers: [card('c1')] });
    linkRepo();
    live('c1');
    const r = await verb('delegate', { prompt: 'again', worktree: 'product', slug: 'cift', succeeds: 'c1' });
    expect(r.json.error).not.toBe('worktree_busy');
  });

  it('an ended child with no process does not hold its worktree', async () => {
    makeVault({ children: { c1: child('c1', { endedAt: 5, worktree: wtPath('cift'), branch: 'super/cift' }) }, containers: [] });
    linkRepo();
    const r = await verb('delegate', { prompt: 'again', worktree: 'product', slug: 'cift' });
    expect(r.json.error).not.toBe('worktree_busy');
  });

  it('resume of a parked child is refused while another live child works in its worktree', async () => {
    const w = wtPath('cift');
    makeVault({
      children: { c1: child('c1', { worktree: w, branch: 'super/cift' }), c2: child('c2', { endedAt: 3, worktree: w, branch: 'super/cift' }) },
      containers: [card('c1')],
    });
    live('c1');
    transcript('c2');
    const r = await verb('resume', { child: 'c2' });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ error: 'worktree_busy', child: 'c1', worktree: w });
    expect(frames.filter((f) => f.subtype === 'window_command')).toEqual([]);
    expect((await readSuperState(root)).children.c2.endedAt).toBe(3);
  });

  it('resume goes through when the other child in the worktree is not live', async () => {
    const w = wtPath('cift');
    makeVault({
      children: { c1: child('c1', { endedAt: 2, worktree: w, branch: 'super/cift' }), c2: child('c2', { endedAt: 3, worktree: w, branch: 'super/cift' }) },
      containers: [],
    });
    transcript('c2');
    expect((await verb('resume', { child: 'c2' })).status).toBe(200);
  });
});

describe('super end says plainly when it ended nothing', () => {
  it('one busy child: a 409 carrying refused:true and ended:false', async () => {
    makeVault({ children: { c1: child('c1') }, containers: [card('c1')] });
    live('c1', { busy: true });
    const r = await verb('end', { children: ['c1'] });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ error: 'busy', refused: true, ended: false, child: 'c1' });
    expect(String(r.json.message)).toMatch(/still working/);
  });

  it('several children: the refused list stays, with notEnded and a warning', async () => {
    makeVault({ children: { c1: child('c1'), c2: child('c2') }, containers: [card('c1'), card('c2')] });
    live('c1', { busy: true });
    const r = await verb('end', { children: ['c1', 'c2'] });
    expect(r.status).toBe(200);
    const out = r.json.result as Record<string, unknown>;
    expect(out).toMatchObject({ ended: ['c2'], notEnded: true });
    expect((out.refused as Array<{ child: string }>).map((x) => x.child)).toEqual(['c1']);
    expect(String(out.warning)).toMatch(/c1: busy/);
  });

  it('all ended: no warning', async () => {
    makeVault({ children: { c2: child('c2') }, containers: [card('c2')] });
    const out = (await verb('end', { children: ['c2'] })).json.result as Record<string, unknown>;
    expect(out.notEnded).toBeUndefined();
    expect(out.warning).toBeUndefined();
  });
});
