/**
 * Plan super-v3 K4 (D16), criterion v3-13: the owner's doors from the Super screen. Stop (`end`),
 * Undo (`resume`) and the agenda mark (`pad`) work from the app's own window with the shell's
 * owner key; the same requests without it end nothing, relaunch nothing and leave a line's
 * status and `by` unchanged, and answer the refusal line the window shows. Undo only within
 * 15 s, under the live cap, and puts the agenda line back exactly as it stood (a Super line
 * stays the Super's). Fictional project "acme" (synthetic fixtures).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/owner-doors-home-`);
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { OWNER_KEY_HEADER, setOwnerKey } from '../../src/server/owner-key.js';
import { readSuperState, resetSuperIndex, SUPER_STATE_REL } from '../../src/lib/super/store.js';
import { _resetSuperInbox } from '../../src/lib/super/inbox.js';
import { _resetChatRegistry } from '../../src/lib/assistant/chat-registry.js';
import { OWNER_UNDO_MS, emptySuperState, type SuperPadItem } from '../../src/lib/super/types.js';
import { SUPER_OWNER_HANDLERS, setVaultLiveForTest } from '../../src/server/routes/super.js';
import { deliverSuperResult, mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';

const KEY = 'b2'.repeat(32);
const PAGE = { host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
const OWNER = { ...PAGE, [OWNER_KEY_HEADER]: KEY };
const SUPER = 'sup-doors';
const KID = '22345678-1234-4234-8234-123456789abc';
let dir: string;
let root: string;
const frames: Array<Record<string, unknown>> = [];

beforeEach(() => {
  _resetChatRegistry();
  resetSuperIndex();
  _resetSuperInbox();
  resetWindowControl();
  setOwnerKey(KEY);
  frames.length = 0;
  rmSync(join(homedir(), '.claude'), { recursive: true, force: true });
  dir = mkdtempSync(join(tmpdir(), 'owner-doors-'));
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  // The live Super's window: every command it is sent succeeds.
  const { token } = mintWindowToken({
    send: (frame) => { frames.push(frame); setImmediate(() => deliverSuperResult(token, frame.id as string, { ok: true, result: { sessionId: KID } })); return true; },
    vault: 'acme', contextRoot: root, sessionId: SUPER, mode: 'super',
  });
});
afterEach(() => { setOwnerKey(null); setVaultLiveForTest(null); _resetSuperInbox(); vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

const line = (over: Partial<SuperPadItem> = {}): SuperPadItem => ({ id: 'n1', section: 'now', text: 'Acme pricing page', at: Date.now() - 1000, for: KID, ...over });
function seed(child: Record<string, unknown> = {}, pad: SuperPadItem[] = [line()]): void {
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({
    ...emptySuperState(), session: SUPER, enabled: true, pad, padSeq: pad.length,
    children: { [KID]: { sessionId: KID, brief: 'Acme pricing page', adopted: false, startedAt: Date.now() - 60_000, row: 'working', ...child } },
    containers: [{ id: 'chat-kid', kind: 'chat', ref: KID, title: 'Acme pricing page', shape: 'chat' }],
  }));
}
function transcript(): void {
  const d = join(homedir(), '.claude', 'projects', 'acme');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${KID}.jsonl`), `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'Build the Acme pricing page.' } })}\n`);
}
function res(): ServerResponse & { status: number; json: Record<string, unknown> } {
  const out = { status: 0, json: {} as Record<string, unknown> } as ServerResponse & { status: number; json: Record<string, unknown> };
  (out as unknown as { writeHead: (s: number) => void }).writeHead = (s: number) => { out.status = s; };
  (out as unknown as { end: (b?: string) => void }).end = (b?: string) => { out.json = b ? JSON.parse(b) : {}; };
  (out as unknown as { setHeader: () => void }).setHeader = () => {};
  return out;
}
const reqOf = (headers: Record<string, string>) => ({ headers, url: '/', method: 'POST', socket: { remoteAddress: '127.0.0.1' } }) as unknown as IncomingMessage;
async function door(verb: 'end' | 'resume' | 'pad', body: Record<string, unknown>, headers: Record<string, string> = OWNER) {
  const r = res();
  await SUPER_OWNER_HANDLERS[verb](reqOf(headers), r, root, body, 'main');
  return r;
}
const kid = async () => (await readSuperState(root)).children[KID];
const padLine = async () => (await readSuperState(root)).pad?.find((p) => p.id === 'n1');

describe('without the owner key nothing changes', () => {
  it('end refuses with the window\'s line and the job keeps running, its line untouched', async () => {
    seed();
    const r = await door('end', { child: KID }, PAGE);
    expect(r.status).toBe(403);
    expect(r.json).toMatchObject({ error: 'owner_page_only' });
    expect(typeof r.json.message).toBe('string');
    expect((await kid()).endedAt).toBeUndefined();
    expect(await padLine()).toMatchObject({ section: 'now' });
    expect((await padLine())?.by).toBeUndefined();
  });

  it('pad refuses and the line keeps its status and by', async () => {
    seed({}, [line({ by: 'auto', why: 'done' as never, section: 'done' })]);
    const before = await padLine();
    const r = await door('pad', { id: 'n1', status: 'in-progress' }, PAGE);
    expect(r.status).toBe(403);
    expect(r.json.error).toBe('owner_page_only');
    const after = await padLine();
    expect(after?.section).toBe(before?.section);
    expect(after?.by).toBe(before?.by);
  });

  it('resume refuses and relaunches nothing', async () => {
    seed({ endedAt: Date.now() - 1000, endedLines: [{ id: 'n1', section: 'now' }] });
    const r = await door('resume', { child: KID }, PAGE);
    expect(r.status).toBe(403);
    expect(r.json.error).toBe('owner_page_only');
    expect((await kid()).endedAt).toBeDefined();
    expect(frames.some((f) => f.command === 'resume' || JSON.stringify(f).includes('"resume"'))).toBe(false);
  });
});

describe('with the owner key', () => {
  it('end records it ended, takes its card off and keeps its line as it stood', async () => {
    seed({ allows: [{ at: 1, summary: 'npm test' }] });
    const r = await door('end', { child: KID });
    expect(r.status).toBe(200);
    const k = await kid();
    expect(k.endedAt).toBeDefined();
    expect(k.endedLines).toEqual([{ id: 'n1', section: 'now' }]);
    // K5: its allow log goes with its end.
    expect(k.allows).toBeUndefined();
    expect((await readSuperState(root)).containers.some((c) => c.kind === 'chat' && c.ref === KID)).toBe(false);
  });

  it('Undo after the 15 s window is too late and relaunches nothing', async () => {
    seed({ endedAt: Date.now() - OWNER_UNDO_MS - 1000, endedLines: [{ id: 'n1', section: 'now' }] });
    const r = await door('resume', { child: KID });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('too_late');
    expect((await kid()).endedAt).toBeDefined();
  });

  it('Undo at the live cap says cap and relaunches nothing', async () => {
    transcript();
    setVaultLiveForTest(async () => 999);
    seed({ endedAt: Date.now() - 1000, endedLines: [{ id: 'n1', section: 'now' }] });
    const r = await door('resume', { child: KID });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('cap');
    expect((await kid()).endedAt).toBeDefined();
  });

  it('Undo with no saved conversation says no_transcript', async () => {
    seed({ endedAt: Date.now() - 1000 });
    const r = await door('resume', { child: KID });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('no_transcript');
  });

  it('Stop then Undo brings the job, its card and its line back exactly (a Super line stays the Super\'s)', async () => {
    transcript();
    setVaultLiveForTest(async () => 0);
    seed();
    expect((await door('end', { child: KID })).status).toBe(200);
    // The window's red light also marks the line Done in his name.
    expect((await door('pad', { id: 'n1', status: 'done' })).status).toBe(200);
    expect(await padLine()).toMatchObject({ section: 'done', by: 'owner' });
    const r = await door('resume', { child: KID });
    expect(r.status).toBe(200);
    const k = await kid();
    expect(k.endedAt).toBeUndefined();
    expect(k.endedLines).toBeUndefined();
    const back = await padLine();
    expect(back?.section).toBe('now');
    expect(back?.by).toBeUndefined();
    expect((await readSuperState(root)).containers.some((c) => c.kind === 'chat' && c.ref === KID)).toBe(true);
  });
});
